<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use Wikimedia\Rdbms\IDatabase;

final class OrderReviewStore {
	public const PHASES = [ 'draft', 'fields', 'report' ];
	private const LIFETIME = 1800;

	public function __construct( private readonly IDatabase $db ) {
	}

	public static function validId( string $id ): bool {
		return (bool)preg_match( '/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/', $id );
	}

	public function create( string $id, int $owner, int $actor, string $task, string $phase, string $text ): ?object {
		$now = time();
		$this->db->newDeleteQueryBuilder()->deleteFrom( 'uai_order_review' )
			->where( $this->db->expr( 'uaior_expires', '<=', $now ) )->caller( __METHOD__ )->execute();
		$this->db->newInsertQueryBuilder()->insertInto( 'uai_order_review' )->ignore()->row( [
			'uaior_id' => $id,
			'uaior_owner' => $owner,
			'uaior_actor' => $actor,
			'uaior_task' => $task,
			'uaior_phase' => $phase,
			'uaior_text' => $text,
			'uaior_status' => 'pending',
			'uaior_feedback' => '',
			'uaior_expires' => $now + self::LIFETIME,
		] )->caller( __METHOD__ )->execute();
		$row = $this->find( $id );
		return $row && (int)$row->uaior_owner === $owner && (int)$row->uaior_actor === $actor &&
			$row->uaior_task === $task && $row->uaior_phase === $phase && $row->uaior_text === $text
			? $row : null;
	}

	public function find( string $id ): ?object {
		if ( !self::validId( $id ) ) {
			return null;
		}
		return $this->db->newSelectQueryBuilder()->select( '*' )->from( 'uai_order_review' )
			->where( [ 'uaior_id' => $id, $this->db->expr( 'uaior_expires', '>', time() ) ] )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function pending( int $owner, int $actor ): ?object {
		return $this->db->newSelectQueryBuilder()->select( [ 'uaior_id', 'uaior_task', 'uaior_status' ] )->from( 'uai_order_review' )
			->where( [
				'uaior_owner' => $owner,
				'uaior_actor' => $actor,
				'uaior_status' => 'pending',
				$this->db->expr( 'uaior_expires', '>', time() ),
			] )->orderBy( [ 'uaior_expires', 'uaior_id' ], 'DESC' )->limit( 1 )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function active( int $owner, int $actor, string $task ): ?object {
		return $this->db->newSelectQueryBuilder()->select( [ 'uaior_id', 'uaior_task', 'uaior_status' ] )
			->from( 'uai_order_review' )->where( [
				'uaior_owner' => $owner,
				'uaior_actor' => $actor,
				'uaior_task' => $task,
				'uaior_status' => 'approved',
				'uaior_phase' => [ 'draft', 'fields' ],
				$this->db->expr( 'uaior_expires', '>', time() ),
			] )->orderBy( [ 'uaior_expires', 'uaior_id' ], 'DESC' )->limit( 1 )
			->caller( __METHOD__ )->fetchRow() ?: null;
	}

	public function stop( object $row ): bool {
		$stoppable = $row->uaior_phase === 'report' ? [ 'pending' ] : [ 'pending', 'approved' ];
		$this->db->newUpdateQueryBuilder()->update( 'uai_order_review' )
			->set( [ 'uaior_status' => 'stopped' ] )->where( [
				'uaior_id' => $row->uaior_id,
				'uaior_owner' => $row->uaior_owner,
				'uaior_actor' => $row->uaior_actor,
				'uaior_status' => $stoppable,
				$this->db->expr( 'uaior_expires', '>', time() ),
			] )->caller( __METHOD__ )->execute();
		return $this->db->affectedRows() === 1;
	}

	public function decide( object $row, string $decision, string $feedback ): bool {
		if ( !in_array( $decision, [ 'approved', 'stopped' ], true ) || strlen( $feedback ) > 4000 ) {
			return false;
		}
		$this->db->newUpdateQueryBuilder()->update( 'uai_order_review' )
			->set( [ 'uaior_status' => $feedback === '' ? $decision : 'stopped', 'uaior_feedback' => $feedback ] )
			->where( [
				'uaior_id' => $row->uaior_id,
				'uaior_owner' => $row->uaior_owner,
				'uaior_actor' => $row->uaior_actor,
				'uaior_status' => 'pending',
				$this->db->expr( 'uaior_expires', '>', time() ),
			] )->caller( __METHOD__ )->execute();
		return $this->db->affectedRows() === 1;
	}
}
