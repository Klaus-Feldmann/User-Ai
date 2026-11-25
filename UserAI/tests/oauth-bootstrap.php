<?php

declare( strict_types = 1 );

namespace MediaWiki\Rest {
	class Handler {}
}
namespace MediaWiki\Extension\OAuth\Rest\Handler {
	class Authorize extends \MediaWiki\Rest\Handler {}
	class AccessToken extends \MediaWiki\Rest\Handler {}
}

namespace {
	use AEWI\UserAI\ConnectionHooks;
	use MediaWiki\Extension\OAuth\Rest\Handler\AccessToken;
	use MediaWiki\Extension\OAuth\Rest\Handler\Authorize;
	use MediaWiki\Rest\Handler;

	require_once __DIR__ . '/../src/ConnectionHooks.php';
	$cases = [
		[ new Authorize(), '/oauth2/authorize', 'GET', true ],
		[ new AccessToken(), '/oauth2/access_token', 'POST', true ],
		[ new Handler(), '/oauth2/authorize', 'GET', false ],
		[ new Authorize(), '/uai/v0/subject/E4607', 'GET', false ],
		[ new AccessToken(), '/oauth2/access_token', 'GET', false ],
		[ new Handler(), '/sws/v0/query/sparql', 'POST', false ],
	];
	foreach ( $cases as [ $handler, $path, $method, $expected ] ) {
		if ( ConnectionHooks::isOAuthBootstrap( $handler, $path, $method ) !== $expected ) {
			throw new RuntimeException( "Unexpected bootstrap verdict for $method $path" );
		}
	}
	echo "6 OAuth bootstrap checks passed.\n";
}
