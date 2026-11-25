<?php
// Add after loading SemanticWikiSchema and SchemaBaseBridge, if used.
wfLoadExtension( 'UserAI' );
$wgUserAIEnabled = true;
// Replace these example numeric MediaWiki user IDs with the actual IDs.
$wgUserAIAssistants = [ 100 => 101 ];
// Optional wiki-specific guidance for the assistant.
$wgUserAISourcePolicy = null;
