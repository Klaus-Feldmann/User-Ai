import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationRequest, exchangeAuthorizationCode, oauthConfig, storeToken, tokenProvider } from '../src/oauth.mjs';

const config = oauthConfig({
	UAI_REST_URL: 'https://wiki.example/w/rest.php',
	UAI_CLIENT_ID: 'fixture-client',
	UAI_EXPECTED_ACTOR_ID: '7',
});

test('authorization request binds a fresh state and a PKCE S256 challenge', () => {
	const first = authorizationRequest(config);
	const second = authorizationRequest(config);
	assert.notEqual(first.state, second.state);
	assert.notEqual(first.verifier, second.verifier);
	assert.equal(first.url.searchParams.get('state'), first.state);
	assert.equal(first.url.searchParams.get('redirect_uri'), config.redirectUri);
	assert.equal(first.url.searchParams.get('code_challenge'), createHash('sha256').update(first.verifier).digest('base64url'));
	assert.equal(first.url.searchParams.get('code_challenge_method'), 'S256');
});

test('exchanges an authorization code using the original verifier and redirect', async () => {
	const grant = { code: 'fixture-code', code_verifier: 'fixture-verifier', redirect_uri: config.redirectUri };
	const token = await exchangeAuthorizationCode(config, grant, {
		now: () => 1000,
		fetch: async (target, call) => {
			assert.equal(target, 'https://wiki.example/w/rest.php/oauth2/access_token');
			assert.equal(call.redirect, 'error');
			assert.deepEqual(Object.fromEntries(call.body), { client_id: 'fixture-client', grant_type: 'authorization_code', ...grant });
			return Response.json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 300 });
		},
	});
	assert.deepEqual(token, { accessToken: 'fixture-token', expiresAt: 301000 });
});

test('an expired or missing token requires a fresh browser approval even if an old refresh token exists', async () => {
	let effective = { accessToken: 'expired', refreshToken: 'unused', expiresAt: 0 };
	const provide = tokenProvider(config, {
		load: async () => {
			if (!effective) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
			return effective;
		},
		now: () => 1000,
	});
	await assert.rejects(provide(), /Browserfreigabe/);
	effective = undefined;
	await assert.rejects(provide(), /Browserfreigabe/);
	effective = { accessToken: 'explicit-browser-grant', expiresAt: 2000 };
	assert.equal(await provide(), 'explicit-browser-grant');
});

test('stores token files with private permissions', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'uai-oauth-'));
	try {
		const path = join(dir, 'oauth', 'token.json');
		await storeToken(path, { accessToken: 'fixture', expiresAt: 1000, refreshToken: 'must-not-store' });
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(await readFile(path)), { accessToken: 'fixture', expiresAt: 1000 });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects a supervisor URL pointing to a different host', async () => {
	const { supervisorSession } = await import('../src/supervisor.mjs');
	let opened = false;
	const session = supervisorSession({
		wikiUrl: 'https://test.wiki/w/api.php',
		actionFor: () => async () => ({ userai: { version: 1, approvalUrl: 'https://elsewhere.wiki/approve',
			connectionProof: 'a'.repeat(32) + '.' + 'b'.repeat(64), expiresAt: Math.floor(Date.now()/1000) + 60,
			code: 'aaaaaaaa' } }),
		open: async () => { opened = true; },
	});
	await assert.rejects(session.connect(), /Freigabeadresse/);
	assert.equal(opened, false);
});

test('a bounded wait finishes without exposing proof or issuing another request', async () => {
	const { supervisorSession } = await import('../src/supervisor.mjs');
	let time = 0;
	let requests = 0;
	let claims = 0;
	const session = supervisorSession({
		wikiUrl: 'https://test.wiki/w/api.php',
		actionFor: () => async ({ operation }) => {
			if (operation === 'connection-request') {
				requests++;
				return { userai: { version: 1, approvalUrl: 'https://test.wiki/approve',
					connectionProof: 'a'.repeat(32) + '.' + 'b'.repeat(64), expiresAt: 2, code: 'aaaaaaaa' } };
			}
			claims++;
			return { userai: { version: 1, status: 'pending' } };
		},
		now: () => time,
		pause: async (ms) => { time += ms; },
		open: async () => {},
	});
	const pending = await session.connect();
	assert.equal(pending.code, 'aaaaaaaa');
	assert.equal(pending.proof, undefined);
	assert.equal((await session.connect({ waitSeconds: 4 })).status, 'closed');
	assert.equal(requests, 1);
	assert.equal(claims, 2);
});
