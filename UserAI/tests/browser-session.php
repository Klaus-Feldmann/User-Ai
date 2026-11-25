<?php
declare( strict_types = 1 );

namespace MediaWiki\Config { interface Config {} }
namespace MediaWiki\Request { class WebRequest {} }
namespace MediaWiki\Session {
	class CookieSessionProvider {}
	class BotProvider extends CookieSessionProvider {}
}
namespace MediaWiki\Rest {
	class Handler { public function getAuthority() { return \MediaWiki\Context\RequestContext::$ctx; } }
	interface RequestInterface {}
	class HttpException extends \Exception {}
}
namespace MediaWiki\Rest\Module { class Module {} }
namespace MediaWiki\Context {
	class RequestContext {
		public static $ctx;
		public static function getMain() { return self::$ctx; }
	}
}
namespace AEWI\UserAI {
	class ConnectionGate {
		public const HEADER = 'X-UAI-Connection';
		public static function permits( ...$args ): bool { return false; }
		public static function fromRequest( ...$args ) { return null; }
	}
}
namespace {
	use AEWI\UserAI\ConnectionHooks;
	use MediaWiki\Context\RequestContext;
	use MediaWiki\Session\CookieSessionProvider;
	use MediaWiki\Session\BotProvider;
	require_once __DIR__ . '/../src/ConnectionHooks.php';

	class Context extends \MediaWiki\Request\WebRequest implements \MediaWiki\Config\Config, \MediaWiki\Rest\RequestInterface {
		public function __construct( public object $provider, public array $headers, public string $method ) {}
		public function getSession() { return $this; }
		public function getProvider() { return $this->provider; }
		public function getHeader( $name ) { return $this->headers[$name] ?? false; }
		public function getMethod() { return $this->method; }
		public function getRequest() { return $this; }
		public function getContext() { return $this; }
		public function getConfig() { return $this; }
		public function getMain() { return $this; }
		public function getAuthority() { return $this; }
		public function getUser() { return $this; }
		public function getId() { return 7; }
		public function get( $key ) { return $key === 'UserAIAssistants' ? [ 1 => 7 ] : true; }
		public function setCacheMode( $mode ) {}
	}
	foreach ( [
		[ new CookieSessionProvider(), [], true ],
		[ new CookieSessionProvider(), [ 'Authorization' => 'Bearer fixture' ], false ],
		[ new CookieSessionProvider(), [ 'X-UAI-Connection' => 'fixture' ], false ],
		[ new BotProvider(), [], false ],
		[ new stdClass(), [], false ],
	] as [ $provider, $headers, $expected ] ) {
		foreach ( [ 'GET', 'POST' ] as $method ) {
			$ctx = RequestContext::$ctx = new Context( $provider, $headers, $method );
			$message = null;
			if ( ConnectionHooks::onApiCheckCanExecute( $ctx, $ctx, $message ) !== $expected ||
				$message !== ( $expected ? null : 'userai-connection-required' ) ) {
				throw new RuntimeException( "Unexpected Action API decision for $method" );
			}
			$error = null;
			$allowed = ConnectionHooks::onRestCheckCanExecute( new \MediaWiki\Rest\Module\Module(),
				new \MediaWiki\Rest\Handler(), '/sws/v0/page/44830/subjects', $ctx, $error );
			if ( $allowed !== $expected || ( $error?->getCode() ) !== ( $expected ? null : 403 ) ) {
				throw new RuntimeException( "Unexpected REST decision for $method" );
			}
		}
	}
	echo "20 browser and connector hook checks passed.\n";
}
