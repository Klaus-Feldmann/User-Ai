import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function oauthConfig(env) {
	const rest = new URL(env.UAI_REST_URL);
	if (rest.protocol !== 'https:' || rest.username || rest.password || rest.search || rest.hash) {
		throw new Error('OAuth requires a fixed HTTPS MediaWiki REST URL.');
	}
	if (!env.UAI_CLIENT_ID) throw new Error('Set UAI_CLIENT_ID for browser OAuth.');
	const base = rest.href.replace(/\/$/, '');
	const account = env.UAI_EXPECTED_ACTOR_ID;
	if (!account || !/^[1-9]\d*$/.test(account) || !Number.isSafeInteger(Number(account))) {
		throw new Error('Set UAI_EXPECTED_ACTOR_ID to the assigned wiki account ID.');
	}
	const support = join(homedir(), 'Library', 'Application Support');
	const legacy = join(support, 'SAI-MCP', 'oauth');
	const tokenDirectory = env.UAI_OAUTH_DIR || (existsSync(legacy) ? legacy : join(support, 'UAI-MCP', 'oauth'));
	const clientId = env.UAI_CLIENT_ID;
	const cacheKey = createHash('sha256').update(JSON.stringify([base, clientId, account])).digest('hex');
	return {
		clientId,
		clientSecret: env.UAI_CLIENT_SECRET,
		expectedActorId: Number(account),
		authorizeUrl: base + '/oauth2/authorize',
		tokenUrl: base + '/oauth2/access_token',
		redirectUri: 'http://127.0.0.1:47832/oauth/callback',
		tokenPath: join(tokenDirectory, cacheKey + '.json'),
	};
}

export function authorizationRequest(config) {
	const verifier = randomBytes(32).toString('base64url');
	const state = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const url = new URL(config.authorizeUrl);
	url.search = new URLSearchParams({
		response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
		state, code_challenge: challenge, code_challenge_method: 'S256',
	});
	return { url, state, verifier };
}

export async function exchangeAuthorizationCode(config, { code, redirect_uri, code_verifier }, { fetch: send = fetch, now = Date.now } = {}) {
	let response;
	try {
		response = await send(config.tokenUrl, {
			method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
			headers: { Accept: 'application/json' },
			body: new URLSearchParams({
				client_id: config.clientId,
				...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
				grant_type: 'authorization_code', code, redirect_uri, code_verifier,
			}),
		});
	} catch (error) {
		const reason = error.name === 'TimeoutError' ? 'Zeitlimit überschritten' :
			error.cause?.code === 'ENOTFOUND' ? 'Wiki-Hostname konnte nicht aufgelöst werden' :
				'HTTPS-Anfrage fehlgeschlagen';
		throw new Error('OAuth-Token-Austausch: ' + reason + '.');
	}
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error('MediaWiki OAuth token exchange failed. HTTP ' + response.status + ', no JSON response.');
	}
	if (!response.ok || data.error) {
		const code = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client',
			'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error'].includes(data.error)
			? data.error : 'unrecognized OAuth error';
		throw new Error('MediaWiki OAuth token exchange failed. HTTP ' + response.status + ', ' + code + '.');
	}
	if (typeof data.access_token !== 'string' || !data.access_token ||
		data.token_type?.toLowerCase() !== 'bearer' ||
		!Number.isFinite(data.expires_in) || data.expires_in <= 0) {
		throw new Error('MediaWiki OAuth token exchange failed. Missing or invalid token fields.');
	}
	return {
		accessToken: data.access_token,
		expiresAt: now() + data.expires_in * 1000,
	};
}

export async function login(config, { open = openBrowser, request = exchangeAuthorizationCode, messages } = {}) {
	const flow = authorizationRequest(config);
	const redirect = new URL(config.redirectUri);
	let settle;
	const callback = new Promise((resolve) => { settle = resolve; });
	let received = false;
	const listener = createServer((req, res) => {
		const url = new URL(req.url, redirect.origin);
		const state = url.searchParams.get('state');
		const code = url.searchParams.get('code');
		const denied = url.searchParams.has('error');
		if (req.method !== 'GET' || url.pathname !== redirect.pathname) {
			res.writeHead(404).end();
			return;
		}
		if (received || state !== flow.state || (!code && !denied)) {
			res.writeHead(400).end('Ungültiger OAuth-Rückruf.');
			return;
		}
		received = true;
		res.writeHead(200, {
			'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer', Connection: 'close',
		}).end(denied ? (messages?.cancelled ?? 'Freigabe abgebrochen.') : (messages?.callback ?? 'Rückruf empfangen. Das Terminal zeigt das Ergebnis.'));
		settle(denied ? null : code);
	});
	const timeout = setTimeout(() => settle(null), 180000);
	try {
		await new Promise((resolve, reject) => {
			listener.once('error', reject);
			listener.listen(Number(redirect.port), '127.0.0.1', resolve);
		});
		await open(flow.url);
		const code = await callback;
		if (!code) throw new Error('OAuth-Freigabe abgebrochen oder abgelaufen.');
		return await request(config, {
			code,
			redirect_uri: config.redirectUri, code_verifier: flow.verifier,
		});
	} finally {
		clearTimeout(timeout);
		listener.close();
	}
}

function openBrowser(url) {
	return new Promise((resolve, reject) => {
		const child = spawn('open', [url.href], { stdio: 'ignore' });
		child.once('error', reject);
		child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Browser konnte nicht geöffnet werden.')));
	});
}

export async function storeToken(path, token) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = path + '.' + randomBytes(8).toString('hex');
	try {
		await writeFile(temporary, JSON.stringify({ accessToken: token.accessToken, expiresAt: token.expiresAt }), { mode: 0o600, flag: 'wx' });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export class BrowserLoginRequiredError extends Error {
	constructor() {
		super('Die OAuth-Anmeldung fehlt, ist abgelaufen oder wurde widerrufen. Bitte starte die Browserfreigabe selbst mit --login.');
	}
}

export function tokenProvider(config, { load = readToken, now = Date.now } = {}) {
	return async () => {
		let token;
		try {
			token = await load(config.tokenPath);
		} catch (error) {
			if (error.code === 'ENOENT') throw new BrowserLoginRequiredError();
			throw error;
		}
		if (token.expiresAt <= now()) throw new BrowserLoginRequiredError();
		return token.accessToken;
	};
}

async function readToken(file) {
	const info = await stat(file);
	if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('OAuth token file must be private.');
	const token = JSON.parse(await readFile(file, 'utf8'));
	if (typeof token.accessToken !== 'string' || !token.accessToken || !Number.isFinite(token.expiresAt)) {
		throw new Error('Invalid cached OAuth token.');
	}
	return token;
}
