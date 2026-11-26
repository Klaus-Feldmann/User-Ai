import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wikiTools } from '../src/wiki-tools.mjs';

const rev = { revid: 42, user: 'Sophos', slots: { main: { content: 'Wikitext' } } };
const sample = { title: 'Vorlage:Test/Doku', ns: 10, pageid: 3, fullurl: 'https://test.wiki/wiki/Vorlage:Test/Doku', revisions: [rev] };

function fixture(reply, allowPageWrites = false) {
	const requests = [];
	const tools = wikiTools(async (request) => { requests.push(request); return reply(request); },
		{ allowPageWrites, actorId: 7 });
	return { run: (name, args) => tools.find((tool) => tool.name === name).invoke(args), requests, tools };
}

test('reads template documentation and returns the canonical link and revision', async () => {
	const { run, requests } = fixture((args) => ({ query: { pages: [
		args.titles.endsWith('/Doku') ? sample : { title: 'Vorlage:Test', ns: 10 },
	] } }));
	const result = await run('get-template-documentation', { template: 'Vorlage:Test' });
	assert.equal(requests[1].titles, 'Vorlage:Test/Doku');
	assert.equal(result.url, sample.fullurl);
	assert.equal(result.revision.source, 'Wikitext');
	assert.equal(result.revision.revisionId, 42);
});

test('replays the complete category continuation across three result pages', async () => {
	const category = 'Kategorie:Test';
	const blocks = [
		{ gcmcontinue: 'page|424144454e|83478', continue: 'gcmcontinue||' },
		{ gcmcontinue: 'page|4245524c494e|83479', continue: 'gcmcontinue||' },
	];
	const { run } = fixture(request => {
		if (!request.generator) return { query: { pages: [{ ns: 14 }] } };
		if (request.continue === '-||') return { batchcomplete: true };
		const offset = request.gcmcontinue ? blocks.findIndex(block => block.gcmcontinue === request.gcmcontinue) + 1 : 0;
		if (offset > 0) assert.equal(request.continue, blocks[offset - 1].continue);
		return {
			query: { pages: [{ ...sample, pageid: offset + 1 }] },
			...(blocks[offset] ? { continue: blocks[offset] } : {}),
		};
	});
	const args = { category, namespaces: [10], limit: 1 };
	const first = await run('get-category-members', args);
	const second = await run('get-category-members', { ...args, continueFrom: first.nextCursor });
	const third = await run('get-category-members', { ...args, continueFrom: second.nextCursor });
	assert.deepEqual([first, second, third].map(result => result.members[0]?.pageId), [1, 2, 3]);
	assert.equal(third.nextCursor, null);
});

test('round-trips numeric search offsets and revision cursors without changing the general continuation', async () => {
	const { run, requests } = fixture((request) => ({
		query: { pages: [sample] },
		continue: request.generator === 'search' ?
			{ gsroffset: 20, continue: 'gsroffset||' } :
			{ rvcontinue: '20261126105100|43', continue: '-||' },
	}));
	const searchArgs = { query: 'Zitat', limit: 20 };
	const firstSearch = await run('search-page', searchArgs);
	await run('search-page', { ...searchArgs, continueFrom: firstSearch.nextCursor });
	assert.equal(requests[1].gsroffset, 20);
	assert.equal(requests[1].continue, 'gsroffset||');
	const historyArgs = { title: sample.title };
	const firstHistory = await run('get-page-history', historyArgs);
	await run('get-page-history', { ...historyArgs, continueFrom: firstHistory.nextCursor });
	assert.equal(requests[3].rvcontinue, '20261126105100|43');
	assert.equal(requests[3].continue, '-||');
	assert.equal((await run('get-revision', { revisionId: 42 })).revision.revisionId, 42);
	assert.equal(requests.at(-1).revids, 42);
});

test('accepts earlier module cursors and rejects a cursor that changes the fixed request', async () => {
	const { run, requests } = fixture(() => ({ query: { pages: [sample] } }));
	await run('search-page', { query: 'Zitat', continueFrom: '10' });
	assert.equal(requests[0].gsroffset, '10');
	assert.equal(requests[0].continue, 'gsroffset||');
	const forged = 'mw:' + Buffer.from(JSON.stringify({ gcmcontinue: 'page|00|1', continue: 'gcmcontinue||', action: 'edit' })).toString('base64url');
	await assert.rejects(run('get-category-members', { category: 'Kategorie:Test', continueFrom: forged }), { status: 400 });
	assert.equal(requests.length, 1);
});

test('requires a current revision and retains MediaWiki account and edit checks', async () => {
	const respond = (request) => {
		if (request.meta === 'userinfo') return { query: { userinfo: { id: 7, name: 'Sophos' } } };
		if (request.meta === 'tokens') return { query: { tokens: { csrftoken: 'fixture-only' } } };
		if (request.action === 'edit') return { edit: { result: 'Success', title: 'Test', newrevid: 43 } };
		return { query: { pages: [{ lastrevid: 42 }] } };
	};
	const writes = fixture(respond, true);
	const data = { title: 'Test', source: 'Inhalt', comment: 'Test' };
	await assert.rejects(writes.run('update-page', { ...data, baseRevisionId: 41 }), { status: 409 });
	assert.ok(writes.requests.every(({ action }) => action === 'query'));
	assert.equal((await writes.run('update-page', { ...data, baseRevisionId: 42 })).revisionId, 43);
	assert.deepEqual(writes.requests.at(-1), {
		action: 'edit', title: 'Test', text: 'Inhalt', summary: 'Test', token: 'fixture-only',
		assert: 'user', assertuser: 'Sophos', nocreate: 1, baserevid: 42,
	});
	await writes.run('create-page', data);
	assert.equal(writes.requests.at(-1).createonly, 1);
	assert.ok(fixture(respond).tools.every(({ annotations }) => annotations.readOnlyHint));
});

test('deletes only named pages and reports duplicates and partial failures', async () => {
	const { run, requests } = fixture((request) => {
		if (request.meta === 'userinfo') return { query: { userinfo: { id: 7, name: 'Sophos' } } };
		if (request.meta === 'tokens') return { query: { tokens: { csrftoken: 'fixture-only' } } };
		if (request.action === 'delete') {
			if (request.pageid === 2) throw Object.assign(new Error('Denied'), { code: 'permissiondenied' });
			return { delete: { title: 'Test A', logid: 55 } };
		}
		if (request.titles === 'Missing') return { query: { pages: [{ missing: true }] } };
		return { query: { pages: [{ pageid: request.titles === 'Test B' ? 2 : 1, title: request.titles }] } };
	}, true);
	const result = await run('delete-pages', { titles: ['Test A', 'Test_A', 'Missing', 'Test B'], reason: 'Test' });
	assert.deepEqual(result.results.map(({ status }) => status), ['deleted', 'duplicate', 'not-found', 'refused']);
	assert.equal(result.deleted, 1);
	const deletions = requests.filter(({ action }) => action === 'delete');
	assert.deepEqual(deletions.map(({ pageid }) => pageid), [1, 2]);
	assert.ok(deletions.every(({ assertuser, token, reason }) => assertuser === 'Sophos' && token === 'fixture-only' && reason === 'Test'));
	assert.ok(requests.every(({ redirects }) => redirects === undefined));
});

test('stops the batch after an unconfirmed deletion and does not retry', async () => {
	const { run, requests } = fixture((request) => {
		if (request.meta === 'userinfo') return { query: { userinfo: { id: 7, name: 'Sophos' } } };
		if (request.meta === 'tokens') return { query: { tokens: { csrftoken: 'fixture-only' } } };
		if (request.action === 'delete') throw new Error('Connection interrupted');
		return { query: { pages: [{ pageid: request.titles === 'A' ? 1 : 2, title: request.titles }] } };
	}, true);
	const result = await run('delete-pages', { titles: ['A', 'B'], reason: 'Test' });
	assert.deepEqual(result.results.map(({ status }) => status), ['unconfirmed', 'not-attempted']);
	assert.equal(requests.filter(({ action }) => action === 'delete').length, 1);
	assert.equal(result.stopped, true);
});

test('compares the two requested revisions using MediaWiki diff HTML', async () => {
	const { run, requests } = fixture(() => ({ compare: {
		fromrevid: 41, torevid: 42, fromtitle: 'Test', totitle: 'Test', body: '<tr>changed</tr>',
	} }));
	const result = await run('compare-pages', { fromRevisionId: 41, toRevisionId: 42 });
	assert.equal(result.diffHtml, '<tr>changed</tr>');
	assert.deepEqual(requests[0], { action: 'compare', fromrev: 41, torev: 42, prop: 'ids|title|size|diff' });
	await assert.rejects(run('compare-pages', { fromRevisionId: 40, toRevisionId: 42 }), { status: 502 });
});

test('checks redirects including fragments and missing targets while paging incoming links', async () => {
	const { run, requests } = fixture((args) => args.generator ? {
		query: { pages: [{ pageid: 6, title: 'Eingehend', fullurl: 'https://test.wiki/wiki/Eingehend' }] },
		continue: { gblcontinue: 'next', continue: 'gblcontinue||' },
	} : {
		query: { redirects: [{ from: 'Test', to: 'Fehlt', tofragment: 'Abschnitt' }],
			pages: [{ title: 'Fehlt', missing: true }] },
	});
	const result = await run('check-redirects', { title: 'Test', namespaces: [10], continueFrom: 'previous' });
	assert.deepEqual(result.outgoing, { status: 'missing-target', hops: [{ from: 'Test', to: 'Fehlt', fragment: 'Abschnitt' }] });
	assert.equal(result.incoming[0].url, 'https://test.wiki/wiki/Eingehend');
	await run('check-redirects', { title: 'Test', namespaces: [10], continueFrom: result.nextCursor });
	const resumed = requests.filter(({ generator }) => generator).at(-1);
	assert.equal(resumed.gblcontinue, 'next');
	assert.equal(resumed.continue, 'gblcontinue||');
	const inbound = requests.find(({ generator }) => generator);
	assert.equal(inbound.gbltitle, 'Test');
	assert.equal(inbound.gblfilterredir, 'redirects');
	assert.equal(inbound.gblcontinue, 'previous');
	assert.equal(inbound.continue, 'gblcontinue||');
	assert.equal(inbound.gblnamespace, '10');
});
