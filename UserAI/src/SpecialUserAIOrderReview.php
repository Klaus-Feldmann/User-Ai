<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use MediaWiki\Html\Html;
use MediaWiki\Session\CookieSessionProvider;
use MediaWiki\SpecialPage\UnlistedSpecialPage;

final class SpecialUserAIOrderReview extends UnlistedSpecialPage {
	public function __construct() {
		parent::__construct( 'UserAIOrderReview' );
	}

	public function execute( $subPage ): void {
		$this->setHeaders();
		$out = $this->getOutput();
		$out->setPageTitle( $this->msg( 'userai-order-review-title' )->text() );
		$out->disableClientCache();
		$out->setCdnMaxage( 0 );
		$out->setPreventClickjacking( true );
		$out->setRobotPolicy( 'noindex,nofollow' );
		$this->requireLogin();

		$request = $this->getRequest();
		$config = $this->getConfig();
		$id = (string)$subPage;
		if ( !$config->get( 'UserAIEnabled' ) || !$config->get( 'UserAIRequireConnectionApproval' ) ||
			$request->getHeader( 'Authorization' ) ||
			$request->getHeader( ConnectionGate::HEADER ) ||
			!( $request->getSession()->getProvider() instanceof CookieSessionProvider ) ||
			!$this->getContext()->getAuthority()->isAllowed( 'read' )
		) {
			$out->addWikiMsg( 'userai-order-review-unavailable' );
			return;
		}

		$store = ConnectionGate::reviews();
		$row = $store->find( $id );
		if ( !$row || (int)$row->uaior_owner !== $this->getUser()->getId() ||
			ConnectionGate::owner( $config, (int)$row->uaior_actor ) !== (int)$row->uaior_owner
		) {
			$out->addWikiMsg( 'userai-order-review-unavailable' );
			return;
		}
		$canRevoke = $row->uaior_status === 'approved' && $row->uaior_phase !== 'report';
		if ( $row->uaior_status !== 'pending' && !$canRevoke ) {
			$out->addWikiMsg( 'userai-order-review-saved' );
			return;
		}
		if ( $request->wasPosted() ) {
			if ( !$this->getUser()->matchEditToken( $request->getVal( 'token' ) ?? '', $id ) ) {
				$out->addWikiMsg( 'sessionfailure' );
				return;
			}
			$feedback = $row->uaior_phase === 'report' ? '' : trim( $request->getText( 'feedback' ) );
			if ( strlen( $feedback ) > 4000 ) {
				$out->addWikiMsg( 'userai-order-review-feedback-length' );
				$this->showForm( $row, $feedback );
				return;
			}
			$decision = $request->getVal( 'decision' ) ?? '';
			$saved = $canRevoke ? $decision === 'stopped' && $store->stop( $row ) :
				$store->decide( $row, $decision, $feedback );
			if ( !$saved ) {
				$out->addWikiMsg( 'userai-order-review-unavailable' );
				return;
			}
			$out->redirect( $this->getPageTitle( $id )->getLocalURL(), '303' );
			return;
		}
		$this->showForm( $row, '', $canRevoke );
	}

	private function showForm( object $row, string $feedback = '', bool $canRevoke = false ): void {
		$out = $this->getOutput();
		$out->addModuleStyles( 'ext.userai.orderReview.styles' );
		$out->addHTML( Html::element( 'h2', [ 'id' => 'userai-review-heading' ], $row->uaior_task ) );
		$out->addHTML( Html::element( 'div', [
			'class' => 'userai-review-text', 'tabindex' => '0', 'role' => 'region',
			'aria-labelledby' => 'userai-review-heading',
		], $row->uaior_text ) );

		$isReport = $row->uaior_phase === 'report';
		$fields = Html::hidden( 'token', $this->getUser()->getEditToken( $row->uaior_id ) );
		if ( !$isReport && !$canRevoke ) {
			$fields .= Html::element( 'label', [ 'for' => 'userai-review-feedback' ],
				$this->msg( 'userai-order-review-feedback' )->text() );
			$fields .= Html::element( 'textarea', [
				'id' => 'userai-review-feedback', 'name' => 'feedback', 'rows' => 2, 'maxlength' => 1000,
			], $feedback );
		}
		$buttons = $this->button( 'stopped', $isReport ? 'later' : 'stop' );
		if ( !$canRevoke ) {
			$buttons .= $this->button( 'approved', $isReport ? 'confirm' : 'approve' );
		}
		$fields .= Html::rawElement( 'div', [ 'class' => 'userai-review-actions' ], $buttons );
		$out->addHTML( Html::rawElement( 'form', [
			'class' => 'userai-review-form', 'method' => 'post',
			'action' => $this->getPageTitle( $row->uaior_id )->getLocalURL(),
		], $fields ) );
	}

	private function button( string $value, string $label ): string {
		return Html::element( 'button', [ 'type' => 'submit', 'name' => 'decision', 'value' => $value ],
			$this->msg( 'userai-order-review-' . $label )->text() );
	}
}
