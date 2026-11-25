<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

final class VersionGroups {

	public static function onExtensionTypes( array &$types ): void {
		$types['semantic'] ??= wfMessage( 'userai-version-group-semantic' )->text();
	}
}
