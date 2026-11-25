<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use MediaWiki\Extension\OAuth\SessionProvider;
use MediaWiki\Html\Html;
use MediaWiki\SpecialPage\UnlistedSpecialPage;
use MediaWiki\User\User;

final class SpecialUserAIConnection extends UnlistedSpecialPage {
	public function __construct() {
		parent::__construct( 'UserAIConnection' );
	}

	public function execute( $subPage ): void {
		$this->setHeaders();
		$out = $this->getOutput();
		$out->setPageTitle( $this->msg( 'userai-connection-title' )->text() );
		$out->disableClientCache();
		$out->setPreventClickjacking( true );
		$out->setRobotPolicy( 'noindex,nofollow' );
		$this->requireLogin();
		$request = $this->getRequest();
		$id = (string)$subPage;
		if ( !$this->getConfig()->get( 'UserAIEnabled' ) ||
			!$this->getConfig()->get( 'UserAIRequireConnectionApproval' ) ||
			$request->getHeader( 'Authorization' ) ||
			$request->getSession()->getProvider() instanceof SessionProvider
		) {
			$out->addWikiMsg( 'userai-connection-unavailable' );
			return;
		}
		if ( $id === 'banner' && $request->getMethod() === 'GET' ) {
			// Return only the current viewer's banner, with the same checks as the skin hook.
			$out->setArticleBodyOnly( true );
			$out->setCdnMaxage( 0 );
			$html = '';
			ConnectionHooks::onSiteNoticeAfter( $html, $this->getContext()->getSkin() );
			$out->addHTML( $html );
			return;
		}
		$store = ConnectionGate::store();
		$row = $store->get( $id );
		$viewer = $this->getUser()->getId();
		$assigned = $row && ConnectionGate::owner( $this->getConfig(), (int)$row->uaic_actor ) === (int)$row->uaic_owner;
		if ( $assigned && $viewer === (int)$row->uaic_actor && $viewer !== (int)$row->uaic_owner &&
			(int)$row->uaic_state === ConnectionStore::PENDING && !$request->wasPosted()
		) {
			$out->addHTML( Html::element( 'div', [ 'class' => 'mw-message-box mw-message-box-notice' ],
				$this->msg( 'userai-connection-awaiting-supervisor' )->text() ) );
			return;
		}
		if ( !$assigned || $viewer !== (int)$row->uaic_owner ) {
			$out->addWikiMsg( 'userai-connection-unavailable' );
			return;
		}
		$state = (int)$row->uaic_state;
		if ( $request->wasPosted() ) {
			if ( !$this->getUser()->matchEditToken( $request->getVal( 'token' ) ?? '', $id ) ) {
				$out->addWikiMsg( 'sessionfailure' );
				return;
			}
			$decision = $request->getVal( 'decision' );
			$target = match ( $decision ) {
				'approve' => $state === ConnectionStore::PENDING ? ConnectionStore::APPROVED : null,
				'close' => in_array( $state, [ ConnectionStore::PENDING, ConnectionStore::APPROVED, ConnectionStore::ACTIVE ], true )
					? ConnectionStore::CLOSED : null,
				default => null,
			};
			if ( $target === null || !$store->change( $row, $target ) ) {
				$out->addWikiMsg( 'userai-connection-unavailable' );
				return;
			}
			$state = $target;
		}
		$actor = User::newFromId( (int)$row->uaic_actor )->getName();
		$out->addHTML( Html::element( 'p', [], $this->msg( 'userai-connection-details' )
			->params( $actor, $row->uaic_application, substr( $row->uaic_consumer, -8 ), substr( $id, -8 ) )->text() ) );
		$out->addWikiMsg( match ( $state ) {
			ConnectionStore::PENDING => 'userai-connection-pending',
			ConnectionStore::APPROVED, ConnectionStore::ACTIVE => 'userai-connection-approved',
			default => 'userai-connection-closed',
		} );
		if ( $state === ConnectionStore::CLOSED ) {
			return;
		}
		$form = Html::hidden( 'token', $this->getUser()->getEditToken( $id ) );
		if ( $state === ConnectionStore::PENDING ) {
			$form .= $this->button( 'approve', 'userai-connection-approve' );
		}
		$form .= $this->button( 'close', 'userai-connection-revoke' );
		$out->addHTML( Html::rawElement( 'form', [
			'method' => 'post',
			'action' => $this->getPageTitle( $id )->getLocalURL(),
		], $form ) );
	}

	private function button( string $value, string $message ): string {
		return Html::element( 'button', [ 'type' => 'submit', 'name' => 'decision', 'value' => $value ],
			$this->msg( $message )->text() );
	}
}
