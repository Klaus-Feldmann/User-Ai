import { readFile, stat } from 'node:fs/promises';
const config = new URL('./private/connection.json', import.meta.url);
if ((await stat(config)).mode & 0o077) throw new Error('Private configuration requires mode 0600.');
const settings = JSON.parse(await readFile(config, 'utf8'));
delete process.env.SAI_ACCESS_TOKEN;
Object.assign(process.env, settings);
await import('./server/src/start.mjs');
