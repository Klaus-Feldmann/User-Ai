<?php

declare( strict_types = 1 );

use AEWI\UserAI\ConnectionStore;

require_once __DIR__ . '/../src/ConnectionStore.php';

$secret = str_repeat( 'a', 64 );
$identity = [
	'consumer' => str_repeat( 'b', 32 ),
	'bearer' => hash( 'sha256', 'fixture-access-token' ),
];
$row = (object)[
	'uaic_owner' => '3',
	'uaic_actor' => '7',
	'uaic_proof' => hash( 'sha256', $secret ),
	'uaic_bearer' => $identity['bearer'],
	'uaic_consumer' => $identity['consumer'],
];
$cases = [
	'bound proof' => ConnectionStore::matches( $row, $secret, 3, 7, $identity ),
	'wrong proof' => !ConnectionStore::matches( $row, str_repeat( 'c', 64 ), 3, 7, $identity ),
	'changed owner' => !ConnectionStore::matches( $row, $secret, 4, 7, $identity ),
	'wrong assistant' => !ConnectionStore::matches( $row, $secret, 3, 8, $identity ),
	'wrong consumer' => !ConnectionStore::matches( $row, $secret, 3, 7, array_replace( $identity, [
		'consumer' => str_repeat( 'c', 32 ),
	] ) ),
	'separate OAuth token' => !ConnectionStore::matches( $row, $secret, 3, 7, array_replace( $identity, [
		'bearer' => hash( 'sha256', 'different-access-token' ),
	] ) ),
];
foreach ( $cases as $label => $ok ) {
	if ( !$ok ) {
		throw new RuntimeException( 'Connection proof case failed: ' . $label );
	}
}
echo "6 connection proof checks passed.\n";
