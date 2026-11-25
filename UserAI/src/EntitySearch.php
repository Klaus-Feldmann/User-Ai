<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use AEWI\SWS\Application\SubjectSummaries\SortDirection;
use AEWI\SWS\Application\SubjectSummaries\SubjectSummaryCursor;
use AEWI\SWS\Application\SubjectSummaries\SubjectSummaryQuery;
use AEWI\SWS\Application\SubjectSummaries\SubjectSummarySort;
use AEWI\SWS\Domain\Schema\SchemaName;
use AEWI\SWS\Presentation\RestGetSubjectPresenter;
use AEWI\SWS\SWSExtension;
use InvalidArgumentException;
use MediaWiki\Permissions\Authority;
use MediaWiki\Title\Title;
use OverflowException;

final class EntitySearch {

	public function execute( object $schema, array $query, Authority $authority ): array {
		$sws = SWSExtension::getInstance();
		$sort = SubjectSummarySort::Page;
		$direction = SortDirection::Ascending;
		$cursor = $query['cursor'] === ''
			? null
			: SubjectSummaryCursor::decode( $query['cursor'], $sort, $direction );
		$listing = $sws->newSubjectSummaryLookup()->getSubjectSummaries( new SubjectSummaryQuery(
			schemaName: new SchemaName( $schema->id ?? $query['schema'] ),
			search: '',
			sort: $sort,
			direction: $direction,
			after: $cursor,
			limit: $query['limit']
		) );

		$matches = [];
		$unverified = [];
		$bytes = 0;
		foreach ( $listing->summaries as $summary ) {
			$id = $summary->subjectId;
			$presenter = new RestGetSubjectPresenter();
			$sws->newGetSubjectQuery( $presenter, $authority )->execute( $id, true, false );
			$subject = $presenter->getJsonArray()['subjects'][$id] ?? null;
			if ( $subject === null ) {
				$unverified[] = [ 'id' => $id, 'reason' => 'No readable entity returned.' ];
				continue;
			}
			$subjectSchema = $subject['schema'];
			$subjectSchemaId = is_array( $subjectSchema ) ? ( $subjectSchema['id'] ?? null ) : $subjectSchema;
			if ( $subjectSchemaId !== ( $schema->id ?? $query['schema'] ) ) {
				$unverified[] = [ 'id' => $id, 'reason' => 'Entity schema changed or could not be verified.' ];
				continue;
			}

			// The REST presenter may use objects for JSON maps.
			$statements = json_decode( json_encode( $subject['statements'], JSON_THROW_ON_ERROR ), true, 512, JSON_THROW_ON_ERROR );
			if ( !self::matches( (array)( $subject['descriptions'] ?? [] ), $statements, $query ) ) {
				continue;
			}
			$subject['statements'] = (object)array_intersect_key( $statements, array_flip( $query['fields'] ) );
			unset( $subject['fieldNotes'] );
			$subject['pageUrl'] = Title::newFromText( $subject['pageTitle'] ?? '' )?->getCanonicalURL();
			$bytes += strlen( json_encode( $subject, JSON_THROW_ON_ERROR ) );
			if ( $bytes > 75000 ) {
				throw new OverflowException();
			}
			$matches[] = $subject;
		}

		return [
			'matches' => $matches,
			'unverified' => $unverified,
			'inspected' => count( $listing->summaries ),
			'nextCursor' => $listing->nextCursor?->encode(),
		];
	}

	public static function matches( array $descriptions, array $statements, array $query ): bool {
		if ( $query['descriptionContains'] !== '' ) {
			$found = false;
			foreach ( $descriptions as $description ) {
				if ( is_string( $description ) && mb_stripos( $description, $query['descriptionContains'], 0, 'UTF-8' ) !== false ) {
					$found = true;
					break;
				}
			}
			if ( !$found ) {
				return false;
			}
		}
		foreach ( $query['filters'] as $filter ) {
			if ( !self::valueMatches( $statements[$filter['field']]['value'] ?? null, $filter ) ) {
				return false;
			}
		}
		return true;
	}

	private static function valueMatches( mixed $value, array $filter ): bool {
		if ( is_array( $value ) ) {
			$parts = array_is_list( $value ) ? $value : array_intersect_key( $value, [ 'text' => true, 'url' => true, 'label' => true ] );
			foreach ( $parts as $part ) {
				if ( self::valueMatches( $part, $filter ) ) {
					return true;
				}
			}
			return false;
		}

		$needle = $filter['value'];
		if ( $filter['operator'] === 'contains' ) {
			return is_string( $value ) && mb_stripos( $value, $needle, 0, 'UTF-8' ) !== false;
		}
		return $value === $needle || (
			( is_int( $value ) || is_float( $value ) ) &&
			( is_int( $needle ) || is_float( $needle ) ) && $value == $needle
		);
	}

	public static function validate( array $query ): void {
		if (
			!is_string( $query['schema'] ?? null ) || $query['schema'] === '' ||
			!is_int( $query['limit'] ?? null ) || $query['limit'] < 1 || $query['limit'] > 25 ||
			!is_string( $query['cursor'] ?? null ) || strlen( $query['cursor'] ) > 4096 ||
			!is_string( $query['descriptionContains'] ?? null ) || mb_strlen( $query['descriptionContains'] ) > 255 ||
			!is_array( $query['fields'] ?? null ) || !array_is_list( $query['fields'] ) || count( $query['fields'] ) > 12 ||
			!is_array( $query['filters'] ?? null ) || !array_is_list( $query['filters'] ) || count( $query['filters'] ) > 8
		) {
			throw new InvalidArgumentException();
		}
		foreach ( $query['fields'] as $field ) {
			if ( !is_string( $field ) || $field === '' ) {
				throw new InvalidArgumentException();
			}
		}
		foreach ( $query['filters'] as $filter ) {
			if (
				!is_array( $filter ) || !is_string( $filter['field'] ?? null ) || $filter['field'] === '' ||
				!in_array( $filter['operator'] ?? null, [ 'equals', 'contains' ], true ) ||
				!is_scalar( $filter['value'] ?? null ) ||
				( $filter['operator'] === 'contains' && !is_string( $filter['value'] ) )
			) {
				throw new InvalidArgumentException();
			}
		}
	}
}
