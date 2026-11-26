<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use Wikimedia\Rdbms\IDatabase;

final class ConnectionStore {
	public const PENDING = 0;
	public const APPROVED = 1;
	public const ACTIVE = 2;
	public const CLOSED = 3;
	public const REQUEST_SECONDS = 120;
	private const DEFAULT_SESSION_HOURS = 2;

	public static function activeExpiration( int $now, mixed $hours ): int {
		if ( !is_int( $hours ) || $hours < 1 || $hours > intdiv( PHP_INT_MAX - $now, 3600 ) ) {
			$hours = self::DEFAULT_SESSION_HOURS;
		}
		return $now + $hours * 3600;
	}

	public function __construct( private readonly IDatabase $db ) {
	}

	public function create( int $owner, int $actor, array $identity ): array {
		$id = bin2hex( random_bytes( 16 ) );
		$secret = bin2hex( random_bytes( 32 ) );
		$expires = time() + self::REQUEST_SECONDS;
		$this->db->newInsertQueryBuilder()->insertInto( 'uai_connection' )->row( [
			'uaic_id' => $id,
			'uaic_proof' => hash( 'sha256', $secret ),
			'uaic_bearer' => $identity['bearer'],
			'uaic_owner' => $owner,
			'uaic_actor' => $actor,
			'uaic_consumer' => $identity['consumer'],
			'uaic_application' => $identity['name'],
			'uaic_state' => self::PENDING,
			'uaic_expires' => $expires,
		] )->caller( __METHOD__ )->execute();
		return [ 'id' => $id, 'secret' => "$id.$secret", 'expiresAt' => $expires ];
	}

	public function get( string $id ): ?object {
		if ( !preg_match( '/\A[a-f0-9]{32}\z/', $id ) ) {
			return null;
		}
		return $this->db->newSelectQueryBuilder()->select( '*' )->from( 'uai_connection' )
			->where( [ 'uaic_id' => $id, $this->db->expr( 'uaic_expires', '>', time() ) ] )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function findPending( int $owner, int $actor ): ?object {
		return $this->db->newSelectQueryBuilder()
			->select( [ 'uaic_id' ] )->from( 'uai_connection' )
			->where( [
				'uaic_owner' => $owner,
				'uaic_actor' => $actor,
				'uaic_state' => self::PENDING,
				$this->db->expr( 'uaic_expires', '>', time() ),
			] )->orderBy( [ 'uaic_expires', 'uaic_id' ], 'DESC' )->limit( 1 )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function nextOrderNumber( int $actor ): int {
		$number = 0;
		$this->db->doAtomicSection( __METHOD__, function () use ( $actor, &$number ): void {
			$this->db->newInsertQueryBuilder()->insertInto( 'uai_order_counter' )
				->row( [ 'uaioc_actor' => $actor, 'uaioc_number' => 1 ] )
				->onDuplicateKeyUpdate()->uniqueIndexFields( [ 'uaioc_actor' ] )
				->set( [ 'uaioc_number = uaioc_number + 1' ] )->caller( __METHOD__ )->execute();
			$number = (int)$this->db->newSelectQueryBuilder()->select( 'uaioc_number' )
				->from( 'uai_order_counter' )->where( [ 'uaioc_actor' => $actor ] )
				->forUpdate()->caller( __METHOD__ )->fetchField();
		} );
		return $number;
	}

	/** dev.21 and dev.22 report the decision on a draft as a completed step. */
	public static function progressStatus( string $status, string $summary ): string {
		if ( $status !== 'completed' ) {
			return $status;
		}
		return match ( $summary ) {
			'Entscheidung zum Entwurf: freigegeben.' => 'approved',
			'Entscheidung zum Entwurf: gestoppt.' => 'stopped',
			default => $status,
		};
	}

	public function saveProgress( int $owner, int $actor, string $task, string $status, string $summary, string $connection, ?string $reportToken = null ): int {
		$updated = time();
		$values = [
			'uaip_task' => $task,
			'uaip_connection' => $connection,
			'uaip_report_token' => $reportToken,
			'uaip_read_notice' => null,
			'uaip_write_notice' => null,
			'uaip_status' => self::progressStatus( $status, $summary ),
			'uaip_summary' => $summary,
			'uaip_updated' => $updated,
		];
		$this->db->newInsertQueryBuilder()->insertInto( 'uai_progress' )
			->row( [ 'uaip_owner' => $owner, 'uaip_actor' => $actor ] + $values )
			->onDuplicateKeyUpdate()->uniqueIndexFields( [ 'uaip_owner', 'uaip_actor' ] )
			->set( $values )->caller( __METHOD__ )->execute();
		return $updated;
	}

	public function clearReviewedReport( int $owner, int $actor, string $task, string $token, ?string $summary = null ): bool {
		$match = [ 'uaip_report_token' => $token ];
		if ( $summary !== null && $summary !== '' ) {
			// Older extensions saved the numbered order and report without a token.
			$match = [ $this->db->orExpr( [
				'uaip_report_token' => $token,
				$this->db->andExpr( [ 'uaip_report_token' => null, 'uaip_summary' => $summary ] ),
			] ) ];
		}
		$this->db->newDeleteQueryBuilder()->deleteFrom( 'uai_progress' )->where( [
			'uaip_owner' => $owner, 'uaip_actor' => $actor, 'uaip_task' => $task,
			'uaip_status' => 'completed', ...$match,
		] )->caller( __METHOD__ )->execute();
		return $this->db->affectedRows() === 1;
	}

	public function getProgress( int $owner, int $actor ): ?object {
		return $this->db->newSelectQueryBuilder()
			->select( [ 'uaip_task', 'uaip_status', 'uaip_summary', 'uaip_updated', 'uaip_connection', 'uaip_read_notice', 'uaip_write_notice' ] )->from( 'uai_progress' )
			->where( [ 'uaip_owner' => $owner, 'uaip_actor' => $actor ] )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function recordActivity( int $owner, int $actor, object $progress, bool $write, string $message ): void {
		$this->db->newUpdateQueryBuilder()->update( 'uai_progress' )->set( [
			( $write ? 'uaip_write_notice' : 'uaip_read_notice' ) => $message,
			'uaip_updated' => time(),
		] )->where( [
			'uaip_owner' => $owner, 'uaip_actor' => $actor, 'uaip_task' => $progress->uaip_task,
			'uaip_connection' => $progress->uaip_connection, 'uaip_status' => [ 'approved', 'running' ],
		] )->caller( __METHOD__ )->execute();
	}

	public function change( object $request, int $state, ?int $expires = null ): bool {
		$set = [ 'uaic_state' => $state ];
		if ( $expires !== null ) {
			$set['uaic_expires'] = $expires;
		}
		$this->db->newUpdateQueryBuilder()->update( 'uai_connection' )->set( $set )->where( [
			'uaic_id' => $request->uaic_id,
			'uaic_state' => $request->uaic_state,
			$this->db->expr( 'uaic_expires', '>', time() ),
		] )->caller( __METHOD__ )->execute();
		return $this->db->affectedRows() === 1;
	}

	public function authenticatedRequest( ?string $header, int $owner, int $actor, array $identity ): ?object {
		if ( $header === null || !preg_match( '/\A([a-f0-9]{32})\.([a-f0-9]{64})\z/', $header, $parts ) ) {
			return null;
		}
		$request = $this->get( $parts[1] );
		if ( !$request || !self::matches( $request, $parts[2], $owner, $actor, $identity ) ) {
			return null;
		}
		return $request;
	}

	public static function matches( object $request, string $secret, int $owner, int $actor, array $identity ): bool {
		return (int)$request->uaic_owner === $owner && (int)$request->uaic_actor === $actor
			&& hash_equals( $request->uaic_proof, hash( 'sha256', $secret ) )
			&& hash_equals( $request->uaic_bearer, $identity['bearer'] )
			&& hash_equals( $request->uaic_consumer, $identity['consumer'] );
	}

	public function removeExpired(): void {
		$expired = $this->db->newSelectQueryBuilder()->select( 'uaic_id' )->from( 'uai_connection' )
			->where( $this->db->expr( 'uaic_expires', '<=', time() ) )->limit( 100 )
			->caller( __METHOD__ )->fetchFieldValues();
		if ( $expired !== [] ) {
			$this->db->newDeleteQueryBuilder()->deleteFrom( 'uai_connection' )->where( [
				'uaic_id' => $expired,
				$this->db->expr( 'uaic_expires', '<=', time() ),
			] )->caller( __METHOD__ )->execute();
		}
	}
}
