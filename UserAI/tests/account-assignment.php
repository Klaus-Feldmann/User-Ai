<?php

// Test configuration validation without bootstrapping MediaWiki.
class ApiBase {}
require dirname( __DIR__ ) . '/src/ApiUserAI.php';

use AEWI\UserAI\ApiUserAI;

foreach ( [
	[ 101, [ 100 => 101 ], true ],
	[ 100, [ 100 => 101 ], false ],
	[ 0, [ 100 => 101 ], false ],
	[ 101, [], false ],
	[ 101, [ 100 => 101, 200 => 101 ], false ],
	[ 101, [ 101 => 101 ], false ],
	[ 101, [ 100 => 101, 101 => 102 ], false ],
	[ 101, [ 100 => '101' ], false ],
] as [ $id, $assignments, $expected ] ) {
	if ( ApiUserAI::isAssignedAssistant( $id, $assignments ) !== $expected ) {
		throw new RuntimeException( 'Unexpected assignment result.' );
	}
}
echo "8 account assignment checks passed.\n";
