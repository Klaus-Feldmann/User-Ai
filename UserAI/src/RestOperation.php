<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use AEWI\SWS\SWSExtension;
use AEWI\SWS\EntryPoints\REST\ReplaceSubjectApi;
use MediaWiki\Context\RequestContext;
use MediaWiki\Registration\ExtensionRegistry;
use MediaWiki\Rest\Handler;
use MediaWiki\Rest\HttpException;

final class RestOperation {

	public const OPERATIONS = [
		'subject-rest' => [ 'sws-get-subject', true, 'newGetSubjectApi' ],
		'search-subjects' => [ 'sws-search-subjects', true, 'newGetSubjectLabelsApi' ],
		'create-main-subject' => [ 'sws-create-subject', false, 'newCreateMainSubjectApi' ],
		'create-subject' => [ 'sws-create-subject', false, 'newCreateOtherSubjectApi' ],
		'update-subject' => [ 'sws-update-subject', false, 'newReplaceSubjectApi' ],
		'delete-subject' => [ 'sws-delete-subject', false, 'newDeleteSubjectApi' ],
		'set-main-subject' => [ 'sws-set-main-subject', false, 'newSetMainSubjectApi' ],
		'mint-subject-ids' => [ 'sws-mint-subject-ids', false, 'newMintSubjectIdsApi' ],
		'validate-subject' => [ 'sws-validate-subject', true, 'newValidateSubjectApi' ],
		'validate-subject-update' => [ 'sws-validate-subject', true, 'newValidateSubjectUpdateApi' ],
		'sparql-query' => [ 'sws-sparql-query', true, 'newSparqlQueryApi' ],
		'cypher-query' => [ 'sws-cypher-query', true, 'newCypherQueryApi' ],
	];

	/** MediaWiki initializes, validates and executes the original SWS handler under the caller's authority. */
	public static function newHandler( string $operation ): Handler {
		$context = RequestContext::getMain();
		$config = $context->getConfig();
		$authority = $context->getAuthority();
		if ( !ApiUserAI::isAuthorized( $config, $authority ) ) {
			throw new HttpException( 'User AI access denied.', 403 );
		}
		if ( !ConnectionGate::permits( $config, $authority, $context->getRequest() ) ) {
			throw new HttpException( 'User AI connection approval required.', 403 );
		}
		if ( !ExtensionRegistry::getInstance()->isLoaded( 'SemanticWikiSchema' ) ) {
			throw new HttpException( 'Semantic WikiSchema is unavailable.', 503 );
		}
		if ( $operation === 'update-subject' && !defined( ReplaceSubjectApi::class . '::SUPPORTS_BASE_REVISION' ) ) {
			throw new HttpException( 'The compatible SWS revision guard is unavailable.', 503 );
		}
		if ( $operation === 'sparql-query' || $operation === 'cypher-query' ) {
			$sws = SWSExtension::getInstance();
			$configured = $operation === 'sparql-query'
				? $sws->getFirstSparqlPlugin() !== null
				: $sws->getNeo4jPlugin() !== null;
			if ( !$configured ) {
				throw new HttpException( 'The requested SWS graph backend is not configured.', 503 );
			}
		}

		[ , , $factory ] = self::OPERATIONS[$operation];
		return SWSExtension::$factory();
	}
}
