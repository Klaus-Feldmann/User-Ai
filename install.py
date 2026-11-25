"""Install the local User AI MCP server from a release directory."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--target', type=Path, default=Path.home()/'Applications'/'UsaerAI')
parser.add_argument('--previous', type=Path, help='Previous SAI installation containing private/connection.json')
parser.add_argument('--codex-config', type=Path, default=Path.home()/'.codex'/'config.toml')
parser.add_argument('--connector', default='aufeinwort')
args = parser.parse_args()
os.umask(0o077)
target = args.target.expanduser().absolute()
cfg = args.codex_config.expanduser()
if not re.fullmatch(r'[A-Za-z0-9_-]+', args.connector):
    raise SystemExit('Invalid connector name.')
if target.exists():
    raise SystemExit('Ziel ist bereits vorhanden: ' + str(target))
if int(subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'])) < 22:
    raise SystemExit('Node.js ab Version 22 erforderlich.')
previous = args.previous
if not previous:
    for candidate in [Path.home()/'Applications/AufEinWort/SAI-MCP', Path.home()/'.Trash/SAI-MCP']:
        try:
            if (candidate/'private/connection.json').is_file():
                previous = candidate
                break
        except PermissionError:
            pass
if previous:
    old = json.loads((previous/'private/connection.json').read_text())
    settings = {('UAI_' + k[4:] if k.startswith('SAI_') else k): v for k,v in old.items()
                if k.startswith(('UAI_', 'SAI_'))}
    launcher = (previous/'launch.mjs').read_text()
    for key, value in re.findall(r"^process\.env\.(?:UAI|SAI)_(\w+) = '([^']*)';$", launcher, re.M):
        settings['UAI_'+key] = value
else:
    from getpass import getpass
    print('Neue OAuth-Einrichtung. Für die Übernahme bestehender Aufträge hier mit Strg-C abbrechen und --previous verwenden.')
    settings = {'UAI_ACTION_URL': input('Wiki Action API (HTTPS): ').strip(),
                'UAI_REST_URL': input('Wiki REST API (HTTPS): ').strip(),
                'UAI_CLIENT_ID': input('OAuth-Client-ID: ').strip(),
                'UAI_EXPECTED_ACTOR_ID': input('Wiki-ID des Assistenten: ').strip()}
    secret = getpass('Optionales Client-Geheimnis: ')
    if secret:
        settings['UAI_CLIENT_SECRET'] = secret
for key in ['UAI_ACTION_URL', 'UAI_REST_URL', 'UAI_CLIENT_ID', 'UAI_EXPECTED_ACTOR_ID']:
    if not settings.get(key):
        raise SystemExit('Konfiguration unvollständig: ' + key)
text = cfg.read_text() if cfg.exists() else ''
section = '[mcp_servers.' + args.connector + ']'
pattern = re.compile(r'^' + re.escape(section) + r'[ \t]*\n(?:(?!^\[).*(?:\n|$))*', re.M)
entry = 'command = ' + json.dumps(shutil.which('node')) + '\nargs = [' + json.dumps(str(target/'launch.mjs')) + ']\ncwd = ' + json.dumps(str(target)) + '\n'
match = pattern.search(text)
if match:
    body = re.sub(r'^(?:args|cwd|command)\s*=.*\n?', '', match.group()[len(section)+1:], flags=re.M)
    updated = text[:match.start()] + section+'\n'+entry+body + text[match.end():]
else:
    updated = text.rstrip()+'\n\n'+section+'\n'+entry
target.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
    stage = Path(tmp)/'install'
    shutil.copytree(root/'server', stage/'server', ignore=shutil.ignore_patterns('node_modules'))
    shutil.copy2(root/'launch.mjs', stage/'launch.mjs')
    private = stage/'private'
    private.mkdir()
    for key, rel in [('UAI_OAUTH_DIR','private/oauth'), ('UAI_FILE_DIRECTORY','Dateien')]:
        if previous and (key in settings or key == 'UAI_OAUTH_DIR'):
            configured = Path(settings.get(key, str(previous/rel)))
            # The old installation may have been moved to another directory.
            source = previous/rel if (previous/rel).is_dir() else configured
            if source.is_dir():
                shutil.copytree(source, stage/rel)
            elif key == 'UAI_OAUTH_DIR':
                raise SystemExit('OAuth- und Auftragsspeicher fehlt: ' + str(source))
        if key in settings or key == 'UAI_OAUTH_DIR':
            (stage/rel).mkdir(parents=True, exist_ok=True)
            settings[key] = str(target/rel)
    (private/'connection.json').write_text(json.dumps(settings, indent=2))
    subprocess.run(['npm','ci','--prefer-offline','--no-audit','--no-fund'], cwd=stage/'server', check=True)
    subprocess.run(['node','--check',stage/'launch.mjs'],check=True)
    cfg.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cfg.parent, mode='w',delete=False) as f:
        f.write(updated)
    try:
        if cfg.exists():
            with tempfile.NamedTemporaryFile(prefix='config.before-userai-',dir=cfg.parent,delete=False) as backup:
                backup.write(text.encode())
        if (cfg.read_text() if cfg.exists() else '') != text:
            raise SystemExit('Codex-Konfiguration zwischenzeitlich geändert.')
        stage.rename(target)
        try:
            os.replace(f.name,cfg)
        except OSError:
            target.rename(stage)
            raise
    finally:
        Path(f.name).unlink(missing_ok=True)
print('User AI installiert:', target)
print('ChatGPT neu starten und uai-connect aufrufen.')
