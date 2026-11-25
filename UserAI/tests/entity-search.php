<?php

declare( strict_types = 1 );

use AEWI\UserAI\EntitySearch;

require_once __DIR__ . '/../src/EntitySearch.php';

$category = 'Kategorie:SWS Entität überarbeiten';
$descriptions = [ 'de' => 'Prüfbeispiel für ein Efeuzitat im Fließtext.' ];
$statements = [
	'FK2' => [ 'value' => [ 'Kurzbeschreibung' ] ],
	'FK3' => [ 'value' => [ $category ] ],
];
$query = [
	'schema' => 'S11',
	'cursor' => '',
	'limit' => 5,
	'descriptionContains' => 'EFEUZITAT',
	'fields' => [ 'FK3' ],
	'filters' => [ [ 'field' => 'FK3', 'operator' => 'equals', 'value' => $category ] ],
];
EntitySearch::validate( $query );

$cases = [
	'combination' => EntitySearch::matches( $descriptions, $statements, $query ),
	'category mismatch' => !EntitySearch::matches( $descriptions, [], $query ),
	'absent description' => !EntitySearch::matches( [], $statements, $query ),
	'no subtitle substitution' => !EntitySearch::matches(
		$descriptions, $statements, array_replace( $query, [ 'descriptionContains' => 'Kurzbeschreibung' ] )
	),
	'category only' => EntitySearch::matches(
		[], $statements, array_replace( $query, [ 'descriptionContains' => '' ] )
	),
	'description only' => EntitySearch::matches(
		$descriptions, [], array_replace( $query, [ 'filters' => [] ] )
	),
	'exact category' => !EntitySearch::matches(
		$descriptions, $statements,
		array_replace( $query, [ 'filters' => [ [ 'field' => 'FK3', 'operator' => 'equals', 'value' => 'Kategorie:SWS' ] ] ] )
	),
];
foreach ( $cases as $label => $passed ) {
	if ( !$passed ) {
		throw new RuntimeException( "Failed: $label" );
	}
}
try {
	EntitySearch::validate( array_replace( $query, [ 'limit' => 26 ] ) );
	throw new RuntimeException( 'Limit was accepted' );
} catch ( InvalidArgumentException ) {
}
echo "8 entity search checks passed.\n";
