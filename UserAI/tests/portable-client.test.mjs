import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUaiClient, mcpDefinitions } from '../reference/client.mjs';

const data = await readFile(new URL('../catalog/v1.json', import.meta.url), 'utf8');
const catalog = JSON.parse(data);

function fixture(allowWrites = false) {
	const actions = [];
	const requests = [];
	const client = createUaiClient({
		allowWrites,
		action: async (args) => {
			actions.push(args);
			switch (args.operation) {
				case 'catalog': return { userai: { version: 1, data } };
				case 'query-entities': return { userai: { version: 1, data: '{"matches":[],"nextCursor":"next"}' } };
				case 'profile-template': return { userai: { version: 1, text: 'Profile' } };
				case 'context': return { userai: { version: 1, actorId: 7, profile: { status: 'loaded' } } };
			}
			if (args.titles) return { query: { pages: [{ pageid: 42 }] } };
			if (args.meta === 'siteinfo') return { query: { general: { lang: 'de' } } };
			if (args.meta === 'userinfo') return { query: { userinfo: { id: 7, name: 'Sophos' } } };
			if (args.meta === 'tokens') return { query: { tokens: { csrftoken: 'fixture' } } };
			if (args.action === 'edit') return { edit: { result: 'Success' } };
			throw new Error('Unexpected action');
		},
		rest: async (request) => {
			requests.push(request);
			if (request.method === 'GET') return {
				requestedId: 'E1',
				subjects: { E1: { identityLanguage: 'de', labels: { de: 'Alt', en: 'Old' }, descriptions: { de: 'Beschreibung' } } },
			};
			return { status: 'ok' };
		},
	});
	return { client, actions, requests };
}

test('loads and registers 21 unique MCP definitions without another MCP server', async () => {
	const { client } = fixture();
	const definitions = mcpDefinitions(await client.loadCatalog());
	assert.equal(new Set(definitions.map((tool) => tool.name)).size, 21);
	assert.equal(definitions.find((tool) => tool.name === 'sws-update-subject').inputSchema.properties.baseRevisionId.type, 'integer');
});

test('serializes entity description, field filters and cursor for the UAI Action API', async () => {
	const { client, actions } = fixture();
	const result = await client.invoke(catalog, 'sws-query-entities', { schema: 'S11', descriptionContains: 'Efeuzitat', continueFrom: 'cursor' });
	assert.equal(result.nextCursor, 'next');
	assert.deepEqual(JSON.parse(actions[0].entityquery), {
		filters: [], fields: [], limit: 10, cursor: 'cursor', descriptionContains: 'Efeuzitat', schema: 'S11',
	});
});

test('selects create-main and forwards only REST body arguments', async () => {
	const { client, requests } = fixture(true);
	await client.invoke(catalog, 'sws-create-subject', { title: 'Vorlage:Test', schema: 'S11', isMain: true, label: 'Test', statements: {} });
	assert.deepEqual(requests[0], {
		method: 'POST', path: '/uai/v0/page/42/mainSubject', query: {}, csrf: true,
		body: { schema: 'S11', label: 'Test', identityLanguage: 'de', labels: { de: 'Test' }, descriptions: {}, statements: {} },
	});
});

test('keeps omitted description and alternate label on replacement and uses the UAI latest route', async () => {
	const { client, requests } = fixture(true);
	await client.invoke(catalog, 'sws-update-subject', { id: 'E1', label: 'Neu', statements: {}, baseRevisionId: 50 });
	assert.deepEqual(requests[0].query, { latest: '1', expand: 'page' });
	assert.deepEqual(requests[1].body, {
		baseRevisionId: 50, label: 'Neu', identityLanguage: 'de', labels: { de: 'Neu', en: 'Old' },
		descriptions: { de: 'Beschreibung' }, statements: {},
	});
});

test('allows SPARQL without enabling write operations', async () => {
	const { client, requests } = fixture();
	await client.invoke(catalog, 'sws-sparql-query', { query: 'ASK WHERE {}' });
	assert.deepEqual(requests[0], {
		method: 'POST', path: '/uai/v0/query/sparql', query: {}, csrf: false, body: { query: 'ASK WHERE {}' },
	});
	await assert.rejects(client.invoke(catalog, 'sws-delete-subject', { id: 'E1' }), /writes are disabled/);
	assert.equal(requests.length, 1);
});

test('provisions only the active account profile with createonly', async () => {
	const { client, actions } = fixture(true);
	const context = { actorId: 7, profile: { title: 'Benutzer:Sophos/profil', reason: 'Profile revision is missing.' } };
	assert.equal((await client.provisionProfile(catalog, context)).profile.status, 'loaded');
	const edit = actions.find(({ action }) => action === 'edit');
	assert.equal(edit.title, 'User:Sophos/profil');
	assert.equal(edit.createonly, 1);
	assert.equal(edit.assertuser, 'Sophos');
	await assert.rejects(client.provisionProfile(catalog, { ...context, actorId: 3 }), /account changed/);
	assert.equal(actions.filter(({ action }) => action === 'edit').length, 1);
});

test('fixed-wiki HTTP transport attaches CSRF and rejects a different origin', async () => {
	const { mediaWikiTransport } = await import('../reference/mediawiki-transport.mjs');
	const options = {
		actionUrl: 'https://test.wiki/w/api.php',
		restUrl: 'https://test.wiki/w/rest.php',
	};
	const requests = [];
	const { rest } = mediaWikiTransport({
		...options,
		fetch: async (url, init) => {
			requests.push([String(url), init]);
			return new Response(JSON.stringify(requests.length === 1
				? { query: { tokens: { csrftoken: 'fixture' } } }
				: { status: 'updated' }));
		},
	});
	await rest({ path: '/uai/v0/subject/E1', method: 'PUT', body: {}, csrf: true });
	assert.equal(requests[1][0], 'https://test.wiki/w/rest.php/uai/v0/subject/E1');
	assert.equal(requests[1][1].headers['X-CSRF-TOKEN'], 'fixture');
	assert.equal(requests[1][1].redirect, 'error');
	assert.throws(() => mediaWikiTransport({ ...options, restUrl: 'https://elsewhere.wiki/rest.php' }), /same-origin/);
});
