# User AI

User AI is an independent AEWI extension for MediaWiki. It exposes a
wiki-managed assistant profile and a catalogue of operations. Its Semantic
WikiSchema tools run with the authenticated MediaWiki account and that
account's permissions.

Software design: Klaus Feldmann / AufEinWort. Programming: ChatGPT / Sophos.

The optional client adapter is a patch for the
[MediaWiki MCP Server](https://github.com/ProfessionalWiki/mediawiki-mcp-server)
by Professional Wiki. User AI and the adapter are maintained independently
of Professional Wiki. The copyright and MIT license for the adapted help
material are retained in [help/LICENSE-MIT](help/LICENSE-MIT). The extension
code is distributed under [GPL-2.0-or-later](COPYING).

The [versioned tool catalog](catalog/README.md) is available to authenticated
assistant accounts. A protocol-independent reference client is included for
connections from another MCP server.
