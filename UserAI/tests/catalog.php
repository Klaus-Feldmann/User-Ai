<?php

declare( strict_types = 1 );

use AEWI\UserAI\ToolCatalog;

require_once __DIR__ . '/../src/ToolCatalog.php';

$source = json_decode( file_get_contents( __DIR__ . '/../catalog/v1.json' ), false, 512, JSON_THROW_ON_ERROR );
$served = json_decode( ToolCatalog::read( true ), false, 512, JSON_THROW_ON_ERROR );
// Comparing the encoded objects preserves the distinction between {} and [].
if ( json_encode( $source, JSON_THROW_ON_ERROR ) !== json_encode( $served, JSON_THROW_ON_ERROR ) ) {
	throw new RuntimeException( 'Full catalog wire shape differs from its source.' );
}
$standaloneWire = json_decode( ToolCatalog::read( false ), false, 512, JSON_THROW_ON_ERROR );
$source->tools = array_values( array_filter( $source->tools, static fn ( object $tool ): bool => !$tool->requiresSws ) );
if ( json_encode( $source, JSON_THROW_ON_ERROR ) !== json_encode( $standaloneWire, JSON_THROW_ON_ERROR ) ) {
	throw new RuntimeException( 'Standalone catalog wire shape differs from its source.' );
}

$catalog = json_decode( ToolCatalog::read( true ), true, 512, JSON_THROW_ON_ERROR );
$standalone = json_decode( ToolCatalog::read( false ), true, 512, JSON_THROW_ON_ERROR );
$manifest = json_decode( file_get_contents( __DIR__ . '/../extension.json' ), true, 512, JSON_THROW_ON_ERROR );
$routes = $manifest['RestRoutes'];
$names = [];
foreach ( $catalog['tools'] as $tool ) {
	if ( isset( $names[$tool['name']] ) || $tool['inputSchema']['type'] !== 'object' ) {
		throw new RuntimeException( 'Invalid or duplicate tool ' . $tool['name'] );
	}
	$names[$tool['name']] = true;
	foreach ( $tool['calls'] as $call ) {
		if ( $call['transport'] !== 'rest' ) {
			continue;
		}
		$matches = array_filter( $routes, static fn ( array $route ): bool =>
			$route['path'] === $call['path'] && $route['method'] === [ $call['method'] ] &&
			$route['args'] === [ $call['operation'] ]
		);
		if ( count( $matches ) !== 1 || ( !$tool['annotations']['readOnlyHint'] && !$call['csrf'] ) ) {
			throw new RuntimeException( 'Invalid REST binding ' . $call['operation'] );
		}
	}
}
if ( count( $standalone['tools'] ) !== 5 || count( $names ) !== 21 || $catalog['version'] !== 1 ) {
	throw new RuntimeException( 'Unexpected standalone or full UAI catalog' );
}
echo "21 portable tools, 5 standalone tools, REST binding and CSRF checks passed.\n";
