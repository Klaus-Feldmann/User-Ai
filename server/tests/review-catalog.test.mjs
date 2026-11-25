import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectToWiki } from '../src/server.mjs';

test('review uses the advertised operation and reports the wiki deletion result', async () => {
	const names = ['save-progress', 'next-order-number', 'clear-reviewed-report'];
	const catalog = { version: 1, actionModule: 'userai', tools: names.map(name => ({
		name, annotations: { readOnlyHint: false }, calls: [{ operation: name, transport: 'action',
			parameters: { task: 'task', summary: 'summary', reporttoken: 'reporttoken' } }],
	})) };
	let cleared = true;
	const client = { loadCatalog: async () => catalog,
		invoke: async () => ({ actorId: 7, catalogVersion: 1, progressEnabled: true }),
		coreAction: async parameters => {
			assert.deepEqual(parameters, { action: 'userai', operation: 'clear-reviewed-report',
				task: 'Sophos · Auftrag 6', reporttoken: 'token', summary: 'Bericht' });
			return { userai: { version: 1, cleared } };
		},
	};
	const progress = (await connectToWiki(client)).find(t => t.name === 'uai-save-progress');
	const clear = () => progress.clearReport('Sophos · Auftrag 6', 'token', 'Bericht');
	assert.equal(await clear(), true);
	cleared = false;
	assert.equal(await clear(), false);
	catalog.tools.pop();
	await assert.rejects(connectToWiki(client), /Werkzeugkatalog.*clear-reviewed-report/);
});
