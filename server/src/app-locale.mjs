import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

async function preferredLanguage(domain) {
	try {
		const { stdout } = await run('/usr/bin/defaults', ['read', domain, 'AppleLanguages'], { timeout: 1500 });
		return stdout.match(/^\s*\(\s*"?([a-z]{2,3}(?:[-_][a-z0-9]+)*)"?\s*[,)]/i)?.[1];
	} catch { return undefined; }
}

export async function resolveAppLocale(metadata, explicit, env = process.env, platform = process.platform, read = preferredLanguage) {
	for (const value of [metadata, explicit, env.UAI_APP_LOCALE]) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	if (platform === 'darwin') {
		const bundle = env.UAI_APPROVAL_APP_BUNDLE;
		const app = bundle && /^[\w-]+(?:\.[\w-]+)+$/.test(bundle) && await read(bundle);
		if (app) return app;
		const system = await read('-g');
		if (system) return system;
	}
	return Intl.DateTimeFormat().resolvedOptions().locale;
}
