<?php

declare( strict_types = 1 );

use AEWI\UserAI\RestOperation;

require_once __DIR__ . '/../src/RestOperation.php';

$swsRoot = $argv[1] ?? '';
if ( !is_file( $swsRoot . '/extension.json' ) ) {
	throw new RuntimeException( 'Pass the SWS checkout as argument.' );
}
$decode = static fn ( string $name ): array => json_decode( file_get_contents( $name ), true, 512, JSON_THROW_ON_ERROR );
$sws = $decode( $swsRoot . '/extension.json' )['RestRoutes'];
foreach ( [ 'Sparql' => 'sparql', 'Neo4j' => 'neo4j' ] as $folder => $name ) {
	$sws = [ ...$sws, ...$decode( "$swsRoot/src/GraphDatabasePlugins/$folder/EntryPoints/REST/{$name}Routes.json" ) ];
}
$routes = $decode( __DIR__ . '/../extension.json' )['RestRoutes'];
$operations = [];
foreach ( $routes as $route ) {
	[ $operation ] = $route['args'];
	if ( isset( $operations[$operation] ) || $route['factory'] !== RestOperation::class . '::newHandler' ) {
		throw new RuntimeException( 'Duplicate or invalid UAI operation: ' . $operation );
	}
	$operations[$operation] = true;
	[ , , $factory ] = RestOperation::OPERATIONS[$operation];
	$matches = array_filter( $sws, static fn ( array $upstream ): bool =>
		$upstream['path'] === '/sws/v0' . substr( $route['path'], 7 )
		&& $upstream['method'] === $route['method']
		&& ( $upstream['factory'] ?? '' ) === 'AEWI\\SWS\\SWSExtension::' . $factory
	);
	if ( count( $matches ) !== 1 ) {
		throw new RuntimeException( 'UAI route differs from SWS: ' . $operation );
	}
}
if ( count( $operations ) !== count( RestOperation::OPERATIONS ) ) {
	throw new RuntimeException( 'Catalog and route registry differ.' );
}
printf( "%d UAI routes match SWS handlers.\n", count( $routes ) );
