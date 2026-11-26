<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use MediaWiki\Context\RequestContext;
use MediaWiki\Session\CookieSessionProvider;
use MediaWiki\Extension\OAuth\Rest\Handler\AccessToken;
use MediaWiki\Extension\OAuth\Rest\Handler\Authorize;
use MediaWiki\Html\Html;
use MediaWiki\Installer\DatabaseUpdater;
use MediaWiki\Request\WebRequest;
use MediaWiki\Rest\Handler;
use MediaWiki\Rest\HttpException;
use MediaWiki\Rest\Module\Module;
use MediaWiki\Rest\RequestInterface;
use MediaWiki\Rest\ResponseInterface;
use MediaWiki\Skin\Skin;
use MediaWiki\SpecialPage\SpecialPage;

final class ConnectionHooks {
	/** Correlate a REST response with the order active at request entry. */
	private static ?\WeakMap $activity = null;

	public static function onLoadExtensionSchemaUpdates( DatabaseUpdater $updater ): void {
		foreach ( [ 'sai_connection', 'sai_order_counter', 'sai_progress' ] as $oldTable ) {
			if ( $updater->getDB()->tableExists( $oldTable, __METHOD__ ) ) {
				throw new \RuntimeException( 'User AI: Zuerst die vorhandenen SAI-Tabellen mit der MariaDB-Migration aus dem Austauschpaket umbenennen.' );
			}
		}
		$updater->addExtensionTable( 'uai_order_counter', dirname( __DIR__ ) . '/sql/uai_order_counter.sql' );
		$updater->addExtensionTable( 'uai_progress', dirname( __DIR__ ) . '/sql/uai_progress.sql' );
		$updater->addExtensionField( 'uai_progress', 'uaip_connection', dirname( __DIR__ ) . '/sql/patch-progress-activity.sql' );
		$updater->addExtensionField( 'uai_progress', 'uaip_report_token', dirname( __DIR__ ) . '/sql/patch-progress-report.sql' );
		$updater->addExtensionTable( 'uai_connection', dirname( __DIR__ ) . '/sql/uai_connection.sql' );
		$updater->addExtensionTable( 'uai_order_review', dirname( __DIR__ ) . '/sql/uai_order_review.sql' );
	}

	public static function onBeforePageDisplay( \MediaWiki\Output\OutputPage $out, Skin $skin ): void {
		$config = $out->getConfig();
		$owner = $out->getUser()->getId();
		if ( $owner && $config->get( 'UserAIEnabled' ) && $config->get( 'UserAIRequireConnectionApproval' ) &&
			isset( $config->get( 'UserAIAssistants' )[$owner] )
		) {
			$out->addModuleStyles( 'ext.userai.notice.styles' );
		}
	}

	public static function onSiteNoticeAfter( &$siteNotice, Skin $skin ): void {
		$config = $skin->getConfig();
		$owner = $skin->getUser()->getId();
		if ( $owner < 1 || !$config->get( 'UserAIEnabled' ) ||
			!$config->get( 'UserAIRequireConnectionApproval' )
		) {
			return;
		}
		$actor = $config->get( 'UserAIAssistants' )[$owner] ?? null;
		if ( !is_int( $actor ) || ConnectionGate::owner( $config, $actor ) !== $owner ) {
			return;
		}
		$request = $skin->getRequest();
		if ( $request->getHeader( 'Authorization' ) ||
			!( $request->getSession()->getProvider() instanceof CookieSessionProvider )
		) {
			return;
		}

		// A previously rendered page may predate the approval request.
		$out = $skin->getOutput();
		$out->disableClientCache();
		$out->setCdnMaxage( 0 );
		$store = ConnectionGate::store();
		$pending = $store->findPending( $owner, $actor );
		$progress = $store->getProgress( $owner, $actor );
		$notice = '';
		if ( $progress !== null ) {
			$key = ConnectionStore::progressStatus( $progress->uaip_status, $progress->uaip_summary );
			$status = $skin->msg( 'userai-progress-' . $key )->text();
			$notice .= Html::element( 'strong', [], $skin->msg( 'userai-progress-heading',
				$progress->uaip_task, $status )->text() );
			$notice .= Html::element( 'div', [], $progress->uaip_summary );
			foreach ( [ $progress->uaip_write_notice, $progress->uaip_read_notice ] as $entry ) {
				if ( $entry !== null ) {
					$notice .= Html::element( 'div', [], $entry );
				}
			}
			$timestamp = (int)$progress->uaip_updated;
			$delayed = in_array( $key, [ 'running', 'approved' ], true ) && time() - $timestamp >= 60;
			if ( $delayed ) {
				$notice .= Html::element( 'div', [], $skin->msg( 'userai-progress-check-app' )->text() );
			}
			$localTime = $skin->getLanguage()->userTimeAndDate( wfTimestamp( TS_MW, $timestamp ), $skin->getUser() );
			$notice .= Html::element( 'time', [ 'datetime' => gmdate( DATE_ATOM, $timestamp ) ],
				$skin->msg( 'userai-progress-updated', $localTime )->text() );
			$notice = Html::rawElement( 'div', [
				'data-uai-key' => "$owner-$actor-progress",
				'data-uai-id' => hash( 'sha256', serialize( [ $progress, $delayed ] ) ),
			], $notice );
		}
		if ( $pending !== null ) {
			$id = $pending->uaic_id;
			$link = Html::element( 'a', [
				'href' => SpecialPage::getTitleFor( 'UserAIConnection', $id )->getLocalURL(),
			], $skin->msg( 'userai-connection-notice-link' )->text() );
			$message = Html::element( 'span', [], $skin->msg( 'userai-connection-notice', substr( $id, -8 ) )->text() );
			$notice .= Html::rawElement( 'div', [ 'data-uai-key' => "$owner-$actor-request", 'data-uai-id' => $id ], $message . ' ' . $link );
		}
		$reviews = ConnectionGate::reviews();
		$review = $reviews->pending( $owner, $actor );
		if ( $review === null && $progress !== null && in_array( $progress->uaip_status, [ 'running', 'approved' ], true ) ) {
			$review = $reviews->active( $owner, $actor, $progress->uaip_task );
		}
		if ( $review !== null ) {
			$link = Html::element( 'a', [
				'href' => SpecialPage::getTitleFor( 'UserAIOrderReview', $review->uaior_id )->getLocalURL(),
			], $skin->msg( $review->uaior_status === 'approved' ? 'userai-order-review-stop' : 'userai-order-review-link' )->text() );
			$notice .= Html::rawElement( 'div', [
				'data-uai-key' => "$owner-$actor-review",
				'data-uai-id' => $review->uaior_id . '-' . $review->uaior_status,
			], Html::element( 'strong', [], $review->uaior_task ) . ' ' . $link );
		}
		$out->addModules( 'ext.userai.notice.dismiss' );
		$siteNotice .= Html::rawElement( 'div', [
			'class' => 'userai-connection-notice',
			'data-uai-refresh' => SpecialPage::getTitleFor( 'UserAIConnection', 'banner' )->getLocalURL(),
			'data-owner' => $owner,
		], $notice );
	}

	public static function onApiCheckCanExecute( $module, $user, &$message ): bool {
		// All User AI operations apply the guard within the module, including its handshake.
		if ( $module instanceof ApiUserAI ) {
			return true;
		}
		$context = $module->getContext();
		$request = $context->getRequest();
		if ( self::mustProtect( $context->getConfig(), $user->getId(), $request ) ) {
			$module->getMain()->setCacheMode( 'private' );
			if ( !ConnectionGate::permits( $context->getConfig(), $context->getAuthority(), $context->getRequest() ) ) {
				$message = 'userai-connection-required';
				return false;
			}
		}
		return true;
	}

	public static function onRestCheckCanExecute(
		Module $module,
		Handler $handler,
		string $path,
		RequestInterface $request,
		?HttpException &$error
	): bool {
		$context = RequestContext::getMain();
		$authority = $handler->getAuthority();
		$config = $context->getConfig();
		if ( self::isOAuthBootstrap( $handler, $path, $request->getMethod() ) ) {
			return true;
		}
		$actor = $authority->getUser()->getId();
		if ( self::mustProtect( $config, $actor, $context->getRequest() ) ) {
			$connection = ConnectionGate::fromRequest( $config, $authority, $context->getRequest() );
			if ( !$connection || (int)$connection->uaic_state !== ConnectionStore::ACTIVE ) {
				$error = new HttpException( 'User AI connection approval required.', 403 );
				return false;
			}
			$method = $request->getMethod();
			if ( in_array( $method, [ 'GET', 'PUT' ], true ) &&
				preg_match( '~/uai/v0/subject/(E[0-9]{1,20})/?$~D', (string)parse_url( $context->getRequest()->getRequestURL(), PHP_URL_PATH ), $match )
			) {
				$owner = (int)$connection->uaic_owner;
				$progress = ConnectionGate::store()->getProgress( $owner, $actor );
				if ( $progress && $progress->uaip_connection === $connection->uaic_id &&
					in_array( $progress->uaip_status, [ 'running', 'approved' ], true )
				) {
					self::$activity ??= new \WeakMap();
					self::$activity[$request] = [ $owner, $actor, $progress, $method === 'PUT', $match[1] ];
					if ( $method === 'PUT' ) {
						ConnectionGate::store()->recordActivity( $owner, $actor, $progress, true,
							"Schreibanfrage für $match[1] eingegangen. Ergebnis steht aus." );
					}
				}
			}
		}
		return true;
	}

	public static function onRestAfterExecute(
		Module $module,
		?Handler $handler,
		string $path,
		RequestInterface $request,
		ResponseInterface $response
	): void {
		$context = RequestContext::getMain();
		if ( isset( self::$activity[$request] ) ) {
			[ $owner, $actor, $progress, $write, $id ] = self::$activity[$request];
			unset( self::$activity[$request] );
			$code = $response->getStatusCode();
			$action = $write ? 'Schreibanfrage' : 'Leseanfrage';
			$message = "$action für $id mit HTTP $code beantwortet.";
			ConnectionGate::store()->recordActivity( $owner, $actor, $progress, $write, $message );
		}
		if ( self::mustProtect( $context->getConfig(), $context->getUser()->getId(), $context->getRequest() ) ) {
			$response->setHeader( 'Cache-Control', 'private, no-store' );
		}
	}

	public static function isOAuthBootstrap( Handler $handler, string $path, string $method ): bool {
		return ( $handler instanceof Authorize && $path === '/oauth2/authorize' && $method === 'GET' )
			|| ( $handler instanceof AccessToken && $path === '/oauth2/access_token' && $method === 'POST' );
	}

	private static function mustProtect( \MediaWiki\Config\Config $config, int $actor, WebRequest $request ): bool {
		return $config->get( 'UserAIEnabled' ) && $config->get( 'UserAIRequireConnectionApproval' )
			&& $actor > 0 && in_array( $actor, $config->get( 'UserAIAssistants' ), true )
			&& !self::isWikiLogin( $request );
	}

	/** Bot-password and other programmatic providers can also be cookie-based. */
	private static function isWikiLogin( WebRequest $request ): bool {
		$provider = $request->getSession()->getProvider();
		return $provider !== null && get_class( $provider ) === CookieSessionProvider::class
			&& !is_string( $request->getHeader( 'Authorization' ) )
			&& !is_string( $request->getHeader( ConnectionGate::HEADER ) );
	}
}
