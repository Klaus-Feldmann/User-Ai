<?php
declare( strict_types = 1 );

namespace MediaWiki\Html {
	class Html {
		public static function element( $tag, $attrs, $text = '' ) {
			$attributes = '';
			foreach ( $attrs as $name => $value ) {
				$attributes .= " $name=\"" . htmlspecialchars( (string)$value ) . '"';
			}
			return "<$tag$attributes>" . htmlspecialchars( $text ) . "</$tag>";
		}
		public static function hidden( $name, $value ) { return ''; }
		public static function rawElement( $tag, $attrs, $text ) { return "<$tag>$text</$tag>"; }
	}
}
namespace MediaWiki\Session { class CookieSessionProvider {} }
namespace MediaWiki\SpecialPage {
	class UnlistedSpecialPage {
		public static $fixture;
		public function __construct( $name ) {}
		public function setHeaders() {}
		public function requireLogin() {}
		public function getOutput() { return self::$fixture; }
		public function getRequest() { return self::$fixture; }
		public function getContext() { return self::$fixture; }
		public function getConfig() { return self::$fixture; }
		public function getUser() { return self::$fixture; }
		public function msg( $key ) { return new class( $key ) {
			public function __construct( private string $key ) {}
			public function text() { return $this->key; }
		}; }
		public function getPageTitle( $id ) { return self::$fixture; }
	}
}
namespace AEWI\UserAI {
	class ConnectionGate {
		public const HEADER = 'X-UAI-Connection';
		public static function reviews() { return \MediaWiki\SpecialPage\UnlistedSpecialPage::$fixture; }
		public static function owner( $config, $actor ) { return 1; }
	}
}
namespace {
	require __DIR__ . '/../src/SpecialUserAIOrderReview.php';
	use AEWI\UserAI\SpecialUserAIOrderReview;
	use MediaWiki\Session\CookieSessionProvider;

	class ReviewFixture {
		public array $messages = [], $headers = [], $form = [], $decisions = [];
		public string $html = '';
		public int $viewer = 1;
		public bool $posted = false;
		public $row;
		public function __construct() {
			$this->row = (object)[ 'uaior_id' => 'review-id', 'uaior_owner' => 1, 'uaior_actor' => 7,
				'uaior_task' => 'Sophos · Auftrag 9', 'uaior_status' => 'pending', 'uaior_phase' => 'fields',
				'uaior_text' => str_repeat( "Langer Auftrag\n", 250 ) . '<script>Text</script>' ];
		}
		public function __call( $name, $args ) {}
		public function get( $key ) { return true; }
		public function getAuthority() { return $this; }
		public function isAllowed( $right ) { return true; }
		public function getHeader( $name ) { return $this->headers[$name] ?? false; }
		public function getSession() { return $this; }
		public function getProvider() { return new CookieSessionProvider(); }
		public function getId() { return $this->viewer; }
		public function find( $id ) { return $this->row; }
		public function addWikiMsg( $msg ) { $this->messages[] = $msg; }
		public function addHTML( $html ) { $this->html .= $html; }
		public function wasPosted() { return $this->posted; }
		public function getVal( $key ) { return $this->form[$key] ?? null; }
		public function getText( $key ) { return $this->form[$key] ?? ''; }
		public function getEditToken( $salt ) { return 'token-' . $salt; }
		public function matchEditToken( $token, $salt ) { return $token === $this->getEditToken( $salt ); }
		public function getLocalURL() { return '/review'; }
		public function stop( $row ) { $row->uaior_status = 'stopped'; return true; }
		public function decide( $row, $decision, $feedback ) {
			$this->decisions[] = [ $decision, $feedback ];
			return true;
		}
	}

	function check( bool $ok, string $message ): void {
		if ( !$ok ) { throw new RuntimeException( $message ); }
	}

	$page = new SpecialUserAIOrderReview();
	$fixture = SpecialUserAIOrderReview::$fixture = new ReviewFixture();
	$page->execute( 'review-id' );
	check( substr_count( $fixture->html, 'Langer Auftrag' ) === 250, 'Full draft must render.' );
	check( str_contains( $fixture->html, '&lt;script&gt;Text&lt;/script&gt;' ), 'Draft has to be escaped.' );
	check( strpos( $fixture->html, 'userai-review-text' ) < strpos( $fixture->html, '<form>' ), 'Decisions must be outside the scrolling region.' );
	$fixture->posted = true;
	$fixture->form = [ 'token' => 'wrong', 'decision' => 'approved' ];
	$page->execute( 'review-id' );
	check( $fixture->decisions === [] && end( $fixture->messages ) === 'sessionfailure', 'Invalid CSRF token accepted.' );
	$fixture->form = [ 'token' => 'token-review-id', 'decision' => 'approved', 'feedback' => 'Bitte ändern' ];
	$page->execute( 'review-id' );
	check( $fixture->decisions === [ [ 'approved', 'Bitte ändern' ] ], 'Supervisor decision was not sent to storage.' );
	$fixture = SpecialUserAIOrderReview::$fixture = new ReviewFixture();
	$fixture->viewer = 7;
	$page->execute( 'review-id' );
	check( $fixture->html === '' && end( $fixture->messages ) === 'userai-order-review-unavailable', 'Assistant can read the review page.' );
	$fixture->viewer = 1;
	$fixture->headers['Authorization'] = 'Bearer fixture';
	$page->execute( 'review-id' );
	check( $fixture->html === '', 'An OAuth request can read the review page.' );
	$fixture = SpecialUserAIOrderReview::$fixture = new ReviewFixture();
	$fixture->row->uaior_status = 'approved';
	$page->execute( 'review-id' );
	check( str_contains( $fixture->html, 'userai-order-review-stop' ) &&
		!str_contains( $fixture->html, 'userai-order-review-approve' ), 'Approved changes need a stop action.' );
	$fixture->posted = true;
	$fixture->form = [ 'token' => 'token-review-id', 'decision' => 'stopped' ];
	$page->execute( 'review-id' );
	check( $fixture->row->uaior_status === 'stopped', 'The owner could not stop an approved order.' );
	echo "9 order review page checks passed.\n";
}
