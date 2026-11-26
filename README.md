# User AI

User AI connects an AI assistant to a MediaWiki account. A supervisor can approve connections and proposed work and follow its progress in the wiki. The optional SemanticWikiSchema integration lets the assistant read and edit entity data using the connected account's permissions.

This development snapshot contains the MediaWiki extension **0.1.0-beta.4.19** and the local MCP server **0.1.0-dev.35**.

## Installation

Download the [installer for this version](https://github.com/Klaus-Feldmann/User-Ai/releases/tag/v0.1.0-dev.35) and extract it, or use a checkout of this repository.

1. Place the [MediaWiki extension](UserAI/) in `extensions/UserAI`. It requires MediaWiki 1.47.0-wmf.24 or later and the OAuth extension. Configure it using [LocalSettings.example.php](UserAI/LocalSettings.example.php) and run MediaWiki's updater to create the database tables.
2. Set up a MediaWiki OAuth client for the assistant account as described in the [server guide](server/README.md#browser-anmeldung).
3. On macOS, with Node.js 22 or later, npm and Python 3.8 or later installed, run the following command to install the local server and configure the Codex stdio connector.

   ```sh
   ./install.command --target "$HOME/Applications/UserAI" --connector userai
   ```

The installer supports `--previous` to import private configuration and order records from an earlier SAI installation. For an existing installation, update both components. Replace the extension directory with the one in this release, then run [server/update.sh](server/update.sh) with the existing local `server` directory as its argument and restart the app. Updating the extension from beta.4.18 does not require a database schema update.

## License

The extension and server are distributed under [GPL-2.0-or-later](LICENSE). The adapted catalog and help material retain their [MIT notices](UserAI/help/LICENSE-MIT). The npm packages include their dependency licenses.
