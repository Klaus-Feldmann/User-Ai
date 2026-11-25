<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use MediaWiki\Config\Config;
use MediaWiki\Extension\OAuth\OAuthServices;
use MediaWiki\Extension\OAuth\SessionProvider;
use MediaWiki\MediaWikiServices;
use MediaWiki\Permissions\Authority;
use MediaWiki\Request\WebRequest;

final class ConnectionGate {
	public const HEADER = 'X-UAI-Connection';

	public static function store(): ConnectionStore {
		return new ConnectionStore( MediaWikiServices::getInstance()->getConnectionProvider()->getPrimaryDatabase() );
	}

	public static function reviews(): OrderReviewStore {
		return new OrderReviewStore( MediaWikiServices::getInstance()->getConnectionProvider()->getPrimaryDatabase() );
	}

	public static function owner( Config $config, int $actor ): ?int {
		$assignments = $config->get( 'UserAIAssistants' );
		if ( !ApiUserAI::isAssignedAssistant( $actor, $assignments ) ) {
			return null;
		}
		$owner = array_search( $actor, $assignments, true );
		return is_int( $owner ) ? $owner : null;
	}

	public static function oauthIdentity( WebRequest $request ): ?array {
		$header = $request->getHeader( 'Authorization' );
		$session = $request->getSession();
		if ( !is_string( $header ) || !preg_match( '/\ABearer ([^\s]+)\z/i', $header, $match )
			|| !( $session->getProvider() instanceof SessionProvider ) ) {
			return null;
		}
		$key = $session->getProviderMetadata()['consumerKey'] ?? null;
		if ( !is_string( $key ) || !preg_match( '/\A[a-f0-9]{32}\z/i', $key ) ) {
			return null;
		}
		return [ 'consumer' => $key, 'bearer' => hash( 'sha256', $match[1] ) ];
	}

	public static function applicationName( string $consumer ): string {
		$services = OAuthServices::wrap( MediaWikiServices::getInstance() );
		return mb_strcut( $services->getConsumerRepository()->getByKey( $consumer )?->getName() ?? $consumer, 0, 255, 'UTF-8' );
	}

	public static function fromRequest( Config $config, Authority $authority, WebRequest $request ): ?object {
		$actor = $authority->getUser()->getId();
		$owner = self::owner( $config, $actor );
		$identity = self::oauthIdentity( $request );
		$proof = $request->getHeader( self::HEADER );
		if ( $owner === null || $identity === null || !is_string( $proof ) ) {
			return null;
		}
		return self::store()->authenticatedRequest( $proof, $owner, $actor, $identity );
	}

	public static function permits( Config $config, Authority $authority, WebRequest $request ): bool {
		if ( !$config->get( 'UserAIRequireConnectionApproval' ) ) {
			return true;
		}
		$connection = self::fromRequest( $config, $authority, $request );
		return $connection !== null && (int)$connection->uaic_state === ConnectionStore::ACTIVE;
	}
}
