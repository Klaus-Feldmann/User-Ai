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

test('passes search, category and revision pagination to MediaWiki', async () => {
	const { run, requests } = fixture((request) => ({
		query: { pages: [request.titles === 'Kategorie:Test' ? { ns: 14 } : sample] },
		continue: { gsroffset: 20, gcmcontinue: 'category-next', rvcontinue: 'rev-next' },
	}));
	assert.equal((await run('search-page', { query: 'Zitat', continueFrom: '10' })).nextCursor, '20');
	assert.equal(requests[0].gsroffset, '10');
	assert.equal((await run('get-category-members', { category: 'Kategorie:Test', continueFrom: 'previous' })).nextCursor, 'category-next');
	assert.equal(requests[2].gcmtitle, 'Kategorie:Test');
	assert.equal(requests[2].gcmcontinue, 'previous');
	assert.equal((await run('get-page-history', { title: sample.title })).nextCursor, 'rev-next');
	assert.equal((await run('get-revision', { revisionId: 42 })).revision.source, 'Wikitext');
	assert.equal(requests.at(-1).revids, 42);
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
		continue: { gblcontinue: 'next' },
	} : {
		query: { redirects: [{ from: 'Test', to: 'Fehlt', tofragment: 'Abschnitt' }],
			pages: [{ title: 'Fehlt', missing: true }] },
	});
	const result = await run('check-redirects', { title: 'Test', namespaces: [10], continueFrom: 'previous' });
	assert.deepEqual(result.outgoing, { status: 'missing-target', hops: [{ from: 'Test', to: 'Fehlt', fragment: 'Abschnitt' }] });
	assert.equal(result.incoming[0].url, 'https://test.wiki/wiki/Eingehend');
	assert.equal(result.nextCursor, 'next');
	const inbound = requests.find(({ generator }) => generator);
	assert.equal(inbound.gbltitle, 'Test');
	assert.equal(inbound.gblfilterredir, 'redirects');
	assert.equal(inbound.gblcontinue, 'previous');
	assert.equal(inbound.gblnamespace, '10');
});
