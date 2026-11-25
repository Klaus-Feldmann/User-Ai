import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import swsWrites from '../src/sws-write-definitions.json' with { type: 'json' };
import { oauthConfig, storeToken } from '../src/oauth.mjs';

test('keeps API tools closed until wiki approval and blocks them again after revocation', { timeout: 12000 }, async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), 'uai-approval-'));
	const env = { ...process.env, UAI_ACTION_URL: 'https://test.wiki/w/api.php',
		UAI_REST_URL: 'https://test.wiki/w/rest.php', UAI_CLIENT_ID: 'fixture-client', UAI_CLIENT_SECRET: '',
		UAI_EXPECTED_ACTOR_ID: '7', UAI_OAUTH_DIR: tmp, UAI_ALLOW_WRITES: '0',
		UAI_CREATE_PROFILE: '0', UAI_ALLOW_PAGE_WRITES: '1', UAI_ALLOW_SWS_WRITES: '1' };
	await storeToken(oauthConfig(env).tokenPath, { accessToken: 'fixture-only', expiresAt: Date.now() + 60000 });
	const fixture = fileURLToPath(new URL('../fixtures/wiki.mjs', import.meta.url));
	const entry = fileURLToPath(new URL('../src/start.mjs', import.meta.url));
	const child = spawn(process.execPath, ['--import', fixture, entry], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
	t.after(async () => { child.kill(); await rm(tmp, { recursive: true, force: true }); });
	const events = [];
	child.on('message', (message) => events.push(message));
	const requests = new Map();
	let decision, wikiReviews = false;
	const lines = createInterface({ input: child.stdout });
	lines.on('line', (line) => {
		const response = JSON.parse(line);
		if (response.method === 'elicitation/create') {
			if (response.params.requestedSchema.properties.open) {
				assert.match(response.params.message, /OAuth/);
				assert.doesNotMatch(response.params.message, /Sophos/);
				send({ id: response.id, result: { action: 'accept', content: { open: true } } });
				return;
			}
			assert.ok(!wikiReviews, 'Der Wiki-Auftrag darf kein App-Freigabeformular öffnen.');
			assert.match(response.params.message, /^Sophos · Auftrag [1234]\n/);
			assert.ok(response.params.message.includes('Kategorie lesen'));
			send({ id: response.id, result: { action: 'accept', content: { entscheidung: decision } } });
			return;
		}
		requests.get(response.id)?.(response);
		requests.delete(response.id);
	});
	let serial = 0;
	function send(command) {
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...command }) + '\n');
	}
	function rpc(method, params = {}) {
		const id = ++serial;
		return new Promise((resolve) => { requests.set(id, resolve); send({ id, method, params }); });
	}
	async function tools() {
		return (await rpc('tools/list')).result.tools.map(({ name }) => name).sort();
	}
	async function call(name, args = {}) {
		return (await rpc('tools/call', { name, arguments: args })).result;
	}
	function phase(name) {
		return new Promise((resolve) => {
			const confirmation = (message) => {
				if (message.acknowledged === name) { child.off('message', confirmation); resolve(); }
			};
			child.on('message', confirmation);
			child.send({ phase: name });
		});
	}

	await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'test', version: '1' } });
	send({ method: 'notifications/initialized' });
	assert.deepEqual(await tools(), ['auftrag', 'create-page', 'delete-pages', 'move-pages', 'uai-call', 'uai-connect', 'uai-save-progress', 'undelete-pages', 'update-page', ...swsWrites.map(({ name }) => name)].sort());
	const write = { title: 'Test', source: 'Testinhalt', comment: 'Test' };
	assert.ok((await call('create-page', write)).isError);
	assert.ok((await call('delete-pages', { titles: ['Test'], reason: 'Test' })).isError);
	const subject = { pageId: 42, schema: 'S11', statements: {} };
	assert.ok((await call('sws-create-subject', subject)).isError);
	const prematureProgress = await call('uai-save-progress', { task: 'Test', status: 'running', summary: '' });
	assert.ok(prematureProgress.isError);
	assert.equal(events.length, 0);
	assert.ok((await call('uai-call')).isError);
	const waiting = await call('uai-connect');
	assert.equal(waiting.structuredContent.status, 'pending');
	assert.equal(Object.hasOwn(waiting.structuredContent, 'proof'), false);
	assert.ok(events.some(({ browserOpened }) => browserOpened));
	assert.equal((await call('uai-connect')).structuredContent.status, 'pending');
	assert.deepEqual(await tools(), ['auftrag', 'create-page', 'delete-pages', 'move-pages', 'uai-call', 'uai-connect', 'uai-save-progress', 'undelete-pages', 'update-page', ...swsWrites.map(({ name }) => name)].sort());
	assert.ok(events.filter(({ operation }) => operation).every(({ operation }) => operation.startsWith('connection-')));
	const waitingForDecision = call('uai-connect', { waitSeconds: 5 });
	await new Promise((resolve) => setTimeout(resolve, 75));
	await phase('active');
	const approved = (await waitingForDecision).structuredContent;
	assert.equal(approved.connected, true);
	assert.equal(approved.approval, 'new');
	assert.equal(approved.serverVersion, '0.1.0-dev.34');
	assert.match(approved.serverInstance, /^[0-9a-f-]{36}$/);
	assert.equal(waiting.structuredContent.serverInstance, approved.serverInstance);
	assert.equal((await call('uai-connect')).structuredContent.approval, 'reused');
	const countRequests = () => events.filter(e => e.operation === 'connection-request').length;
	const previous = countRequests();
	assert.equal((await call('uai-connect', { fresh: true })).structuredContent.status, 'pending');
	assert.equal((await call('uai-connect', { fresh: true })).structuredContent.status, 'pending');
	assert.equal(countRequests(), previous + 1);
	assert.ok((await call('create-page', write)).isError);
	await phase('active');
	assert.equal((await call('uai-connect', { waitSeconds: 5 })).structuredContent.approval, 'new');
	assert.ok((await tools()).includes('sws-sparql-query'));
	assert.ok((await call('get-agent-context')).isError);
	assert.ok((await call('uai-call', { tool: 'get-agent-context' })).isError);
	assert.ok((await call('create-page', write)).isError);
	let currentOrder;
	for (const [choice, status] of [['Stoppen', 'gestoppt'], ['Freigeben', 'freigegeben']]) {
		decision = choice;
		const result = await call('auftrag', { entwurf: 'Kategorie lesen' });
		assert.ok(result.structuredContent?.id, JSON.stringify(result));
		assert.equal(result.structuredContent.name, 'Sophos · Auftrag ' + (choice === 'Stoppen' ? 1 : 2));
		assert.equal(result.structuredContent.status, status);
		currentOrder = result.structuredContent.id;
		assert.deepEqual((await call('auftrag', { id: result.structuredContent.id })).structuredContent, result.structuredContent);
	}
	assert.ok((await call('uai-call', { tool: 'sws-create-subject', arguments: subject })).isError);
	assert.equal((await call('sws-create-subject', subject)).structuredContent.data.subjectId, 'E2');
	assert.equal(events.at(-1).csrf, true);
	assert.equal(events.at(-1).connected, true);
	const view = await call('uai-call', { tool: 'swsbase-get-data-view', arguments: { pageId: 42, fields: ['FK3'] } });
	assert.deepEqual(view.structuredContent.data.subjects[0].fields, [{ name: 'FK3', effective: 'Beispiel' }]);
	assert.ok((await call('uai-call', { tool: 'create-page', arguments: write })).isError);
	assert.equal((await call('create-page', write)).structuredContent.data.revisionId, 43);
	const result = await call('uai-call', { tool: 'sws-sparql-query', arguments: { query: 'ASK WHERE {}' } });
	assert.equal(result.structuredContent.data.boolean, true);
	assert.equal(events.at(-1).connected, true);
	await phase('closed');
	const blockedRest = await call('uai-call', { tool: 'sws-sparql-query', arguments: { query: 'ASK WHERE {}' } });
	const blockedAction = await call('uai-call', { tool: 'get-agent-context' });
	for (const result of [blockedRest, blockedAction]) {
		assert.ok(result.isError);
		assert.match(result.content[0].text, /widerrufen oder ist abgelaufen.*uai-connect/);
	}
	const requestsBefore = events.filter(e => e.operation === 'connection-request').length;
	const expiredOrder = await call('auftrag', { id: currentOrder, aktion: 'anhalten' });
	assert.equal(expiredOrder.structuredContent.status, 'pending');
	assert.equal(expiredOrder.structuredContent.code, 'aaaaaaaa');
	const retry = await call('uai-connect');
	assert.equal(events.filter(e => e.operation === 'connection-request').length, requestsBefore + 1);
	assert.equal(retry.structuredContent.status, 'pending');
	assert.deepEqual(await tools(), ['auftrag', 'create-page', 'delete-pages', 'move-pages', 'uai-call', 'uai-connect', 'uai-save-progress', 'undelete-pages', 'update-page', ...swsWrites.map(({ name }) => name)].sort());
	await phase('active');
	assert.equal((await call('uai-connect', { waitSeconds: 5 })).structuredContent.connected, true);
	decision = 'Freigeben';
	await call('auftrag', { id: currentOrder });
	const resumed = await call('auftrag', { entwurf: 'Kategorie lesen', vorlagenauftrag: true });
	assert.equal(resumed.structuredContent.status, 'freigegeben');
	assert.equal(resumed.structuredContent.name, 'Sophos · Auftrag 3');
	const plan = await call('auftrag', { id: resumed.structuredContent.id, vorlagen: [
		{ titel: 'Vorlage:Beispiel', beschreibung: 'Beispielbeschreibung.' },
	] });
	assert.ok(plan.structuredContent?.targets, JSON.stringify(plan));
	const update = { auftragsId: plan.structuredContent.id, id: 'E1', baseRevisionId: 45, fieldKeyVersion: 1,
		descriptions: { de: 'Beispielbeschreibung.' }, statements: { FQ1: { propertyType: 'select', value: ['dewiki'] } } };
	const writesBefore = () => events.filter(e => e.path === '/w/rest.php/uai/v0/subject/E1').length;
	const initial = writesBefore();
	assert.ok((await call('sws-update-subject', { ...update, id: 'E3' })).isError);
	assert.ok((await call('sws-update-subject', { ...update, statements: {} })).isError);
	assert.ok((await call('uai-call', { tool: 'sws-update-subject', arguments: update })).isError);
	assert.equal(writesBefore(), initial);
	const allowed = await call('sws-update-subject', update);
	assert.equal(allowed.structuredContent?.data?.status, 'updated', JSON.stringify(allowed));
	assert.equal((await call('auftrag', { id: update.auftragsId, aktion: 'anhalten' })).structuredContent.status, 'gestoppt');
	assert.ok((await call('sws-update-subject', update)).isError);
	assert.equal(writesBefore(), initial + 1);
	wikiReviews = true;
	await phase('wiki-reviews');
	assert.equal((await call('uai-connect', { fresh: true })).structuredContent.status, 'pending');
	await phase('active');
	assert.equal((await call('uai-connect', { waitSeconds: 5 })).structuredContent.connected, true);
	const wikiDraft = await call('auftrag', { entwurf: 'Kategorie ergänzen\n'.repeat(250), feldAenderung: {
		id: 'E1', titel: 'Vorlage:Beispiel', schema: 'S11', feld: 'FK4', propertyType: 'page',
		operation: 'hinzufuegen', value: ['Kategorie:Testkategorie3'],
	} });
	assert.equal(wikiDraft.structuredContent.status, 'ausstehend');
	assert.match(wikiDraft.content[0].text, /\[Auftrag prüfen\]\(https:\/\/test\.wiki\/wiki\/Special:UserAIOrderReview\//);
	assert.ok((await call('uai-call', { tool: 'get-agent-context' })).isError);
	await phase('approve-order');
	const wikiApproved = await call('auftrag', { id: wikiDraft.structuredContent.id, waitSeconds: 5 });
	assert.equal(wikiApproved.structuredContent.status, 'freigegeben');
	const categoryUpdate = { ...update, auftragsId: wikiDraft.structuredContent.id, descriptions: {},
		statements: { ...update.statements, FK4: { propertyType: 'page', value: ['Kategorie:Testkategorie2', 'Kategorie:Testkategorie3'] } } };
	assert.ok((await call('sws-update-subject', { ...categoryUpdate, statements: {
		...categoryUpdate.statements, FK4: { propertyType: 'page', value: ['Kategorie:Testkategorie3'] },
	} })).isError);
	assert.ok((await call('sws-update-subject', { ...categoryUpdate, baseRevisionId: 44 })).isError);
	assert.equal((await call('sws-update-subject', categoryUpdate)).structuredContent?.data?.status, 'updated');
	const missing = await call('uai-call', { tool: 'required-missing-tool', required: true });
	assert.ok(missing.isError);
	assert.equal(missing.structuredContent.taskStopped, true);
	assert.equal(missing.structuredContent.tool, 'required-missing-tool');
	const beforeBlockedWrite = events.length;
	assert.deepEqual((await call('create-page', write)).structuredContent, missing.structuredContent);
	assert.deepEqual((await call('uai-connect')).structuredContent, missing.structuredContent);
	assert.equal(events.length, beforeBlockedWrite);

	assert.ok((await tools()).includes('uai-save-progress'));
	const progress = { task: 'Vorlagenbereinigung', status: 'paused', summary: 'Eine Vorlage geprüft.' };
	assert.ok((await call('uai-save-progress', progress)).isError);

});
