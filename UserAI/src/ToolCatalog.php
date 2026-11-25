<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

final class ToolCatalog {

	public static function read( bool $hasSws ): string {
		$source = file_get_contents( dirname( __DIR__ ) . '/catalog/v1.json' );
		if ( $source === false ) {
			throw new \RuntimeException( 'User AI catalog is missing.' );
		}
		$catalog = json_decode( $source, false, 512, JSON_THROW_ON_ERROR );
		$catalog->tools = array_values( array_filter(
			$catalog->tools,
			static fn ( object $tool ): bool => $hasSws || !( $tool->requiresSws ?? false )
		) );
		return json_encode( $catalog, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	}
}
