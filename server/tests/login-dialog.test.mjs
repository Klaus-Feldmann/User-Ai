import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLogin } from '../src/login-dialog.mjs';

test('German dialog confirms account before opening and retries a verified mismatch', async () => {
	const prompts = [];
	let attempts = 0;
	await requestLogin({ wiki: 'wiki.example', account: 'Sophos (7)', locale: 'de-AT',
		ask: async form => { prompts.push(form); return { action: 'accept', content: { open: true } }; },
		authenticate: async () => {
			if (++attempts === 1) throw Object.assign(new Error(), { code: 'UAI_ACCOUNT_MISMATCH' });
		} });
	assert.match(prompts[0].message, /Standardbrowser.*\nwiki.example$/);
	assert.match(prompts[1].message, /stimmt mit der Einrichtung/);
	assert.doesNotMatch(JSON.stringify(prompts), /Sophos|\b[37]\b/);
	assert.equal(attempts, 2);
});
test('declining in French leaves the browser closed', async () => {
	await assert.rejects(requestLogin({ locale: 'fr-CA', wiki: 'wiki.example', account: '7',
		ask: async () => ({ action: 'cancel' }), authenticate: assert.fail }), /Connexion annulée/);
});

import { resolveAppLocale } from '../src/app-locale.mjs';
test('host locale precedes macOS app preference, which precedes system language', async () => {
	const env = { UAI_APPROVAL_APP_BUNDLE: 'com.openai.codex' };
	const read = domain => domain === '-g' ? 'de-DE' : 'fr-CA';
	assert.equal(await resolveAppLocale('es', undefined, env, 'darwin', read), 'es');
	assert.equal(await resolveAppLocale(undefined, undefined, env, 'darwin', read), 'fr-CA');
	assert.equal(await resolveAppLocale(undefined, undefined, {}, 'darwin', read), 'de-DE');
});
