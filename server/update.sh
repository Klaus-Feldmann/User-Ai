#!/usr/bin/env bash
set -euo pipefail

release="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ $# -ne 1 || ! -d "$1" ]]; then
    echo "Aufruf: ./update.sh '/Pfad/zum/installierten/UAI-MCP-Server'" >&2
    exit 2
fi
target="$(cd "$1" && pwd -P)"
if [[ "$release" == "$target" || ! -f "$target/src/start.mjs" ]]; then
    echo "Bitte den bisherigen UAI-MCP-Server-Ordner als Ziel angeben." >&2
    exit 2
fi
node -e 'if (+process.versions.node.split(".")[0] < 22 || !["@aewi/sai-mcp-server","@aewi/uai-mcp-server"].includes(require(process.argv[1]).name)) process.exit(1)' "$target/package.json" || {
    echo "Node.js ab Version 22 und ein bestehender UAI-MCP-Server sind erforderlich." >&2
    exit 2
}

staging="$(mktemp -d "$target/.uai-update.XXXXXX")"
mkdir "$staging/backup" "$staging/neu"
files=(src package.json package-lock.json node_modules)
rollback=1
finish() {
    local result=$?
    if (( rollback )); then
        local name
        for name in "${files[@]}"; do
            if [[ -e "$staging/backup/$name" || -L "$staging/backup/$name" ]]; then
                if [[ -e "$target/$name" || -L "$target/$name" ]]; then
                    mv "$target/$name" "$staging/neu/$name"
                fi
                mv "$staging/backup/$name" "$target/$name"
            fi
        done
        echo "Update abgebrochen. Arbeitsordner: $staging" >&2
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -R "$release/src" "$release/package.json" "$release/package-lock.json" "$staging/neu/"
npm ci --prefix "$staging/neu" --no-audit --no-fund
node --check "$staging/neu/src/start.mjs"
for name in "${files[@]}"; do
    if [[ -e "$target/$name" || -L "$target/$name" ]]; then
        mv "$target/$name" "$staging/backup/$name"
    fi
    mv "$staging/neu/$name" "$target/$name"
done
rollback=0
echo "UAI-MCP-Server aktualisiert. Sicherung: $staging/backup"
echo "Starte ChatGPT neu, damit der MCP-Server neu geladen wird."
