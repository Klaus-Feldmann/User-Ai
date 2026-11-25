<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use ApiBase;
use MediaWiki\Config\Config;
use MediaWiki\Permissions\Authority;
use MediaWiki\SpecialPage\SpecialPage;
use InvalidArgumentException;
use JsonException;
use OverflowException;
use AEWI\SWS\Application\SubjectSummaries\InvalidSubjectSummaryCursorException;
use AEWI\SWS\Domain\Schema\SchemaName;
use AEWI\SWS\Presentation\RestGetSchemaPresenter;
use MediaWiki\Title\TitleValue;
use MediaWiki\Content\TextContent;
use MediaWiki\MediaWikiServices;
use MediaWiki\Revision\RevisionRecord;
use MediaWiki\Title\Title;
use MediaWiki\Registration\ExtensionRegistry;
use AEWI\SWS\Presentation\RestGetSubjectPresenter;
use AEWI\SWS\Presentation\RestGetPageSubjectsPresenter;
use AEWI\SWS\SWSExtension;

final class ApiUserAI extends ApiBase {
	private const SCHEMA_OPERATIONS = [ 'schemas', 'schema', 'query-entities', 'backend-capabilities' ];
	public const HANDSHAKE = [ 'connection-identity', 'connection-request', 'connection-claim' ];
	private const REVIEW_OPERATIONS = [ 'order-review-create', 'order-review-status' ];
	private const VERSION = 1;
	private const TOPICS = [ 'overview', 'sws', 'query', 'editing', 'authentication', 'backends' ];

	public function execute(): void {
		$this->getMain()->setCacheMode( 'private' );
		$config = $this->getConfig();
		$authority = $this->getAuthority();
		$id = $authority->getUser()->getId();
		if ( !self::isAuthorized( $config, $authority ) ) {
			$this->dieWithError( 'userai-denied', 'userai-denied' );
		}

		$params = $this->extractRequestParams();
		if ( in_array( $params['operation'], self::HANDSHAKE, true ) ) {
			$reply = $this->handshake( $params['operation'] );
			$this->getResult()->addValue( null, $this->getModuleName(), $reply );
			return;
		}
		if ( !ConnectionGate::permits( $config, $authority, $this->getRequest() ) ) {
			$this->dieWithError( 'userai-connection-required', 'userai-connection-required' );
		}
		$hasSws = ExtensionRegistry::getInstance()->isLoaded( 'SemanticWikiSchema' );
		switch ( $params['operation'] ) {
			case 'order-review-create':
			case 'order-review-status':
				$reply = $this->orderReview( $params );
				break;
			case 'next-order-number':
			case 'clear-reviewed-report':
			case 'save-progress':
				$connection = ConnectionGate::fromRequest( $config, $authority, $this->getRequest() );
				if ( !$this->getRequest()->wasPosted() || !$connection ||
					(int)$connection->uaic_state !== ConnectionStore::ACTIVE
				) {
					$this->dieWithError( 'userai-connection-required', 'userai-connection-required' );
				}
				if ( $params['operation'] === 'next-order-number' ) {
					$reply = [ 'version' => self::VERSION, 'number' => ConnectionGate::store()->nextOrderNumber( $id ),
						'user' => $authority->getUser()->getName() ];
					break;
				}
				$task = trim( $params['task'] ?? '' );
				$token = $params['reporttoken'] ?? null;
				if ( $token !== null && !preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $token ) ) {
					$this->dieWithError( 'userai-progress-invalid', 'userai-progress-invalid' );
				}
				if ( $params['operation'] === 'clear-reviewed-report' ) {
					if ( $task === '' || $token === null ) {
						$this->dieWithError( 'userai-progress-invalid', 'userai-progress-invalid' );
					}
					$reply = [ 'version' => self::VERSION, 'cleared' => ConnectionGate::store()->clearReviewedReport(
						(int)$connection->uaic_owner, $id, $task, $token, $params['summary'] ?? null
					) ];
					break;
				}
				$summary = trim( $params['summary'] ?? '' );
				$status = $params['status'] ?? '';
				if ( $task === '' || strlen( $task ) > 120 || strlen( $summary ) > 480 || $status === '' ) {
					$this->dieWithError( 'userai-progress-invalid', 'userai-progress-invalid' );
				}
				$updated = ConnectionGate::store()->saveProgress(
					(int)$connection->uaic_owner, $id, $task, $status, $summary, $connection->uaic_id, $token
				);
				$reply = [ 'version' => self::VERSION, 'updatedAt' => $updated ];
				break;
			case 'context':
				$reply = [
					'version' => self::VERSION,
					'actorId' => $id,
					'progressEnabled' => $config->get( 'UserAIRequireConnectionApproval' ),
					'wikiOrderReview' => $config->get( 'UserAIRequireConnectionApproval' ),
					'catalogVersion' => 1,
					'helpTopics' => self::TOPICS,
					'profile' => $this->readProfile( $hasSws ),
					'tools' => [
						[ 'name' => 'get-agent-context', 'operation' => 'context', 'readOnly' => true ],
						[ 'name' => 'get-skill-topic', 'operation' => 'help', 'readOnly' => true, 'topics' => self::TOPICS ],
						...( $hasSws ? [
							[ 'name' => 'sws-get-subject', 'operation' => 'subject', 'readOnly' => true,
								'requiredArguments' => [ 'id' ], 'revision' => 'published' ],
							[ 'name' => 'sws-get-page-subjects', 'operation' => 'page-subjects', 'readOnly' => true,
								'requiredArguments' => [ 'pageid' ] ],
							[ 'name' => 'sws-list-schemas', 'operation' => 'schemas', 'readOnly' => true ],
							[ 'name' => 'sws-get-schema', 'operation' => 'schema', 'readOnly' => true,
								'requiredArguments' => [ 'name' ] ],
							[ 'name' => 'sws-query-entities', 'operation' => 'query-entities', 'readOnly' => true,
								'requiredArguments' => [ 'schema' ] ],
							[ 'name' => 'sws-get-query-capabilities', 'operation' => 'backend-capabilities', 'readOnly' => true ],
							...self::restTools(),
						] : [] ),
					],
					'accessPolicy' => 'Access this wiki exclusively through UAI. Other access paths or external sources require separate, explicit supervisor approval for the specific access. Stop the task and report the tool, affected step and observed failure if a required UAI tool is missing or fails technically.',
					'sourcePolicy' => $config->get( 'UserAISourcePolicy' ) ??
						'Combine wiki full-text search, categories and structured data as appropriate. Cite the wiki pages or entities used. Verify known candidates directly when indexes may lag.',
					'operations' => $hasSws ? [ 'context', 'help', 'catalog', 'profile-template', 'subject', 'page-subjects', ...self::SCHEMA_OPERATIONS ] : [ 'context', 'help', 'catalog', 'profile-template' ],
				];
				break;
			case 'catalog':
				$reply = [ 'version' => self::VERSION, 'data' => ToolCatalog::read( $hasSws ) ];
				break;
			case 'profile-template':
				$text = file_get_contents( dirname( __DIR__ ) . '/help/profile.wikitext' );
				if ( $text === false ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$reply = [ 'version' => self::VERSION, 'text' => $text ];
				break;
			case 'help':
				$topic = $params['topic'];
				$text = file_get_contents( dirname( __DIR__ ) . '/help/' . $topic . '.md' );
				if ( $text === false ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$reply = [ 'topic' => $topic, 'text' => $text, 'version' => self::VERSION ];
				break;
			case 'page-subjects':
				if ( !$hasSws || !isset( $params['pageid'] ) ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$presenter = new RestGetPageSubjectsPresenter();
				SWSExtension::getInstance()->newGetPageSubjectsQuery( $presenter, $authority )->execute( $params['pageid'] );
				$reply = [ 'version' => self::VERSION, 'data' => json_encode( $presenter->getJsonArray(), JSON_THROW_ON_ERROR ) ];
				break;
			case 'schemas':
			case 'schema':
				if ( !$hasSws ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$data = $params['operation'] === 'schemas'
					? $this->listSchemas( $params['cursor'] ?? '' )
					: $this->readSchema( $params['name'] ?? '' );
				$reply = [ 'version' => self::VERSION, 'data' => $data ];
				break;
			case 'backend-capabilities':
				if ( !$hasSws ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$sws = SWSExtension::getInstance();
				$reply = [
					'version' => self::VERSION,
					'cypher' => $sws->getNeo4jPlugin() === null ? 'not-configured' : 'configured',
					'sparql' => $sws->getFirstSparqlPlugin() === null ? 'not-configured' : 'configured',
				];
				break;
			case 'query-entities':
				if ( !$hasSws ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$reply = [
					'version' => self::VERSION,
					'data' => json_encode( $this->queryEntities( $params['entityquery'] ?? '' ), JSON_THROW_ON_ERROR ),
				];
				break;
			case 'subject':
				if ( !$hasSws ) {
					$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
				}
				$reply = $this->readSubject( $params['id'] ?? '' );
				break;
		}

		if ( !$this->getResult()->addValue( null, $this->getModuleName(), $reply ) ) {
			$this->dieWithError( 'userai-unavailable', 'userai-unavailable' );
		}
	}

	private function orderReview( array $params ): array {
		$request = $this->getRequest();
		$connection = ConnectionGate::fromRequest( $this->getConfig(), $this->getAuthority(), $request );
		if ( !$request->wasPosted() || !$connection || (int)$connection->uaic_state !== ConnectionStore::ACTIVE ) {
			$this->dieWithError( 'userai-connection-required', 'userai-connection-required' );
		}
		$id = $params['id'] ?? '';
		$owner = (int)$connection->uaic_owner;
		$actor = (int)$connection->uaic_actor;
		$store = ConnectionGate::reviews();
		if ( $params['operation'] === 'order-review-create' ) {
			$task = trim( $params['task'] ?? '' );
			$text = $params['reviewtext'] ?? '';
			$phase = $params['reviewphase'] ?? '';
			if ( !OrderReviewStore::validId( $id ) || $task === '' || strlen( $task ) > 120 ||
				trim( $text ) === '' || strlen( $text ) > 262144 || !in_array( $phase, OrderReviewStore::PHASES, true ) ) {
				$this->dieWithError( 'userai-progress-invalid', 'userai-progress-invalid' );
			}
			$row = $store->create( $id, $owner, $actor, $task, $phase, $text );
			if ( !$row ) {
				$this->dieWithError( 'userai-order-review-unavailable', 'userai-order-review-unavailable' );
			}
		} else {
			$row = $store->find( $id );
		}
		if ( !$row || (int)$row->uaior_owner !== $owner || (int)$row->uaior_actor !== $actor ) {
			return [ 'version' => self::VERSION, 'status' => 'expired' ];
		}
		return [
			'version' => self::VERSION,
			'status' => $row->uaior_status,
			'feedback' => $row->uaior_feedback,
			'expiresAt' => (int)$row->uaior_expires,
			'approvalUrl' => SpecialPage::getTitleFor( 'UserAIOrderReview', $id )->getCanonicalURL(),
		];
	}

	private function handshake( string $operation ): array {
		$config = $this->getConfig();
		$request = $this->getRequest();
		$actor = $this->getUser()->getId();
		$owner = ConnectionGate::owner( $config, $actor );
		$identity = ConnectionGate::oauthIdentity( $request );
		if ( !$request->wasPosted() || !$config->get( 'UserAIRequireConnectionApproval' ) || $owner === null || $identity === null ) {
			$this->dieWithError( 'userai-denied', 'userai-denied' );
		}
		if ( $operation === 'connection-identity' ) {
			return [ 'version' => self::VERSION, 'actorId' => $actor ];
		}
		$store = ConnectionGate::store();
		if ( $operation === 'connection-request' ) {
			if ( $this->getUser()->pingLimiter( 'userai-connection' ) ) {
				$this->dieWithError( 'apierror-ratelimited', 'ratelimited' );
			}
			$store->removeExpired();
			$identity['name'] = ConnectionGate::applicationName( $identity['consumer'] );
			$row = $store->create( $owner, $actor, $identity );
			return [
				'version' => self::VERSION,
				'expiresAt' => $row['expiresAt'],
					'code' => substr( $row['id'], -8 ),
				'connectionProof' => $row['secret'],
				'approvalUrl' => SpecialPage::getTitleFor( 'UserAIConnection', $row['id'] )->getCanonicalURL(),
			];
		}

		$connection = ConnectionGate::fromRequest( $config, $this->getAuthority(), $request );
		if ( $connection === null || (int)$connection->uaic_state === ConnectionStore::CLOSED ) {
			return [ 'version' => self::VERSION, 'status' => 'closed' ];
		}
		$state = (int)$connection->uaic_state;
		if ( $state === ConnectionStore::APPROVED ) {
			$expires = time() + ConnectionStore::SESSION_SECONDS;
			if ( $store->change( $connection, ConnectionStore::ACTIVE, $expires ) ) {
				return [ 'version' => self::VERSION, 'status' => 'active', 'expiresAt' => $expires ];
			}
			$connection = $store->get( $connection->uaic_id );
			$state = (int)( $connection->uaic_state ?? ConnectionStore::CLOSED );
		}
		return match ( $state ) {
			ConnectionStore::ACTIVE => [ 'version' => self::VERSION, 'status' => 'active', 'expiresAt' => (int)$connection->uaic_expires ],
			ConnectionStore::PENDING => [ 'version' => self::VERSION, 'status' => 'pending' ],
			default => [ 'version' => self::VERSION, 'status' => 'closed' ],
		};
	}

	private static function restTools(): array {
		$tools = [];
		foreach ( RestOperation::OPERATIONS as $operation => [ $name, $readOnly ] ) {
			$tools[] = [ 'name' => $name, 'operation' => $operation, 'readOnly' => $readOnly, 'transport' => 'rest' ];
		}
		return $tools;
	}

	public static function isAuthorized( Config $config, Authority $authority ): bool {
		return $authority->getUser()->isRegistered()
			&& $config->get( 'UserAIEnabled' )
			&& self::isAssignedAssistant( $authority->getUser()->getId(), $config->get( 'UserAIAssistants' ) )
			&& $authority->isAllowed( 'read' );
	}

	public static function isAssignedAssistant( int $userId, array $assignments ): bool {
		$seen = [];
		foreach ( $assignments as $owner => $assistant ) {
			if ( !is_int( $owner ) || $owner < 1 || !is_int( $assistant ) ||
				$assistant < 1 || $assistant === $owner || isset( $seen[$assistant] ) ||
				array_key_exists( $assistant, $assignments )
			) {
				return false;
			}
			$seen[$assistant] = true;
		}
		return isset( $seen[$userId] );
	}

	private function readProfile( bool $hasSws ): array {
		$authority = $this->getAuthority();
		$title = Title::makeTitleSafe( NS_USER, $authority->getUser()->getName() . '/profil' );
		if ( !$title || !$authority->authorizeRead( 'read', $title ) ) {
			return [ 'status' => 'unavailable' ];
		}
		$result = [ 'status' => 'unavailable', 'title' => $title->getPrefixedText() ];
		$revision = MediaWikiServices::getInstance()->getRevisionLookup()->getRevisionByTitle( $title );
		if ( !$revision ) {
			return $result + [ 'reason' => 'Profile revision is missing.' ];
		}
		if ( $hasSws && !SWSExtension::getInstance()->getRevisionPolicy()->revisionIsReadableBy( $revision, $authority ) ) {
			return $result;
		}
		$content = $revision->getContent( 'main', RevisionRecord::FOR_THIS_USER, $authority );
		if ( !$content instanceof TextContent || $content->isRedirect() ) {
			return $result;
		}
		$text = $content->getText();
		return [
			'status' => 'loaded',
			'title' => $title->getPrefixedText(),
			'revisionId' => $revision->getId(),
			'text' => mb_substr( $text, 0, 16000 ),
			'truncated' => mb_strlen( $text ) > 16000,
		];
	}

	private function listSchemas( string $cursor ): string {
		if ( $cursor !== '' && !ctype_digit( $cursor ) ) {
			$this->dieWithError( 'userai-invalid-cursor', 'userai-invalid-cursor' );
		}

		$sws = SWSExtension::getInstance();
		$lookup = $sws->getSchemaLookup();
		$page = ( new SchemaPagination() )->buildPage(
			$sws->getSchemaNameLookup()->getReadableSchemaNames( (int)$cursor ),
			50,
			static function ( TitleValue $title ) use ( $lookup ): ?array {
				try {
					$name = new SchemaName( $title->getText() );
				} catch ( InvalidArgumentException ) {
					return null;
				}
				$schema = $lookup->getSchema( $name );
				if ( $schema === null ) {
					return null;
				}
				$id = $schema->getId();
				return [
					'name' => $schema->getName()->getText(),
					...( $id === null ? [] : [ 'id' => $id->text ] + $schema->getIdentity()->toJson() ),
					'description' => $schema->getDescription(),
					'propertyCount' => count( $schema->getAllProperties()->asMap() ),
					'subjectsAreDependent' => $schema->subjectsAreDependent(),
				];
			}
		);
		return json_encode( [ 'schemas' => $page['items'], 'nextCursor' => $page['nextCursor'] ], JSON_THROW_ON_ERROR );
	}

	private function readSchema( string $name ): string {
		try {
			$presenter = new RestGetSchemaPresenter();
			SWSExtension::getInstance()->newGetSchemaQuery( $presenter )->execute( $name );
			return $presenter->getJson();
		} catch ( InvalidArgumentException ) {
			return '{"schema":null}';
		}
	}

	private function queryEntities( string $payload ): array {
		try {
			if ( strlen( $payload ) > 32000 ) {
				throw new InvalidArgumentException();
			}
			$query = json_decode( $payload, true, 32, JSON_THROW_ON_ERROR );
			if ( !is_array( $query ) ) {
				throw new InvalidArgumentException();
			}
			EntitySearch::validate( $query );
			$schema = json_decode( $this->readSchema( $query['schema'] ), false, 512, JSON_THROW_ON_ERROR )->schema;
			if ( $schema === null ) {
				return [ 'error' => 'schema-not-found' ];
			}
			$fields = (array)( $schema->propertyDefinitions ?? [] );
			foreach ( [ ...$query['fields'], ...array_column( $query['filters'], 'field' ) ] as $key ) {
				if ( !array_key_exists( $key, $fields ) ) {
					return [ 'error' => 'unknown-field', 'field' => $key ];
				}
			}
			return ( new EntitySearch() )->execute( $schema, $query, $this->getAuthority() );
		} catch ( InvalidSubjectSummaryCursorException ) {
			return [ 'error' => 'invalid-cursor' ];
		} catch ( InvalidArgumentException | JsonException ) {
			return [ 'error' => 'invalid-query' ];
		} catch ( OverflowException ) {
			return [ 'error' => 'response-too-large' ];
		}
	}

	private function readSubject( string $id ): array {
		$sws = SWSExtension::getInstance();
		$parsed = strlen( $id ) <= 255 ? $sws->getSubjectIdParser( true )->parse( $id ) : null;
		if ( $parsed === null ) {
			$this->dieWithError( 'userai-invalid-id', 'userai-invalid-id' );
		}
		$presenter = new RestGetSubjectPresenter();
		$sws->newGetSubjectQuery( $presenter, $this->getAuthority() )->execute(
			subjectId: $parsed->text,
			includePageIdentifiers: true,
			includeReferencedSubjects: false
		);
		$data = $presenter->getJsonArray();
		if ( !isset( $data['subjects'][$parsed->text] ) ) {
			$this->dieWithError( 'userai-not-found', 'userai-not-found' );
		}
		// Use an opaque JSON field so Action API array metadata cannot alter SWS's REST shape.
		return [ 'version' => self::VERSION, 'data' => json_encode( $data, JSON_THROW_ON_ERROR ) ];
	}

	public function getAllowedParams(): array {
		return [
			'operation' => [ self::PARAM_TYPE => [ ...self::HANDSHAKE, ...self::REVIEW_OPERATIONS, 'next-order-number', 'clear-reviewed-report', 'save-progress', 'context', 'help', 'catalog', 'profile-template', 'subject', 'page-subjects', ...self::SCHEMA_OPERATIONS ], self::PARAM_REQUIRED => true ],
			'reviewtext' => [ self::PARAM_TYPE => 'string' ],
			'reviewphase' => [ self::PARAM_TYPE => OrderReviewStore::PHASES ],
			'reporttoken' => [ self::PARAM_TYPE => 'string' ],
			'task' => [ self::PARAM_TYPE => 'string' ],
			'summary' => [ self::PARAM_TYPE => 'string' ],
			'status' => [ self::PARAM_TYPE => [ 'running', 'paused', 'completed', 'decision', 'approved', 'stopped' ] ],
			'topic' => [ self::PARAM_TYPE => self::TOPICS, self::PARAM_DFLT => 'overview' ],
			'id' => [ self::PARAM_TYPE => 'string' ],
			'name' => [ self::PARAM_TYPE => 'string' ],
			'cursor' => [ self::PARAM_TYPE => 'string' ],
			'entityquery' => [ self::PARAM_TYPE => 'string' ],
			'pageid' => [ self::PARAM_TYPE => 'integer', self::PARAM_MIN => 1 ],
		];
	}

	public function isReadMode(): bool { return true; }

	public function isWriteMode(): bool {
		return in_array( $this->getRequest()->getVal( 'operation' ), [ 'next-order-number', 'clear-reviewed-report', 'save-progress', 'order-review-create' ], true );
	}
}
