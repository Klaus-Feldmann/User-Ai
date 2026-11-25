<?php

declare( strict_types = 1 );

namespace AEWI\UserAI;

use AEWI\SWS\EntryPoints\REST\CursorPaginationTrait;

final class SchemaPagination {
	use CursorPaginationTrait {
		buildPage as public;
	}
}
