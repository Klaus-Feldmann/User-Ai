import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { managementHandlers } from '../src/wiki-management.mjs';
import { mediaWikiTransport } from '../src/mediawiki-transport.mjs';

const authenticated = async () => ({ assert: 'user', assertuser: 'Sophos', token: 'fixture' });

test('moves and restores a fixed list with MediaWiki identity and redirect settings', async () => {
	const requests = [];
	const handler = managementHandlers({ authenticated, action: async (req) => {
		requests.push(req);
		if (req.action === 'query') return { query: { pages: [{ missing: req.titles === 'B' }] } };
		if (req.action === 'move') return { move: { from: req.from, to: req.to } };
		return { undelete: { title: req.title, revisions: 2 } };
	} });
	const result = await handler.move({ moves: [{ from: 'A', to: 'B', leaveRedirect: false }, { from: 'C', to: 'D' }], reason: 'Test' });
	assert.deepEqual(result.results.map(({ status }) => status), ['moved', 'refused']);
	assert.equal(requests.find(r => r.action === 'move').noredirect, 1);
	assert.equal(requests.find(r => r.action === 'move').assertuser, 'Sophos');
	assert.equal((await handler.undelete({ titles: ['E'], reason: 'Test' })).results[0].revisions, 2);
	await assert.rejects(handler.move({ moves: [{ from: 'A', to: 'B' }, { from: 'C', to: 'B' }], reason: 'Test' }), { status: 400 });
});

test('uploads staged files with warnings enabled and rejects path traversal and symlinks', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'uai-files-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, 'source.png'), 'fixture');
	await symlink(join(directory, 'source.png'), join(directory, 'link.png'));
	const calls = [];
	const handler = managementHandlers({ directory, authenticated, action: async (req, file) => {
		calls.push({ req, file });
		return req.action === 'query' ? { query: { pages: [{ missing: true }] } }
			: { upload: { result: 'Warning', warnings: { exists: 'fixture' } } };
	} });
	const result = await handler.upload({ files: [
		{ localName: 'source.png', filename: 'target.png' },
		{ localName: 'link.png', filename: 'link-target.png' },
		{ localName: '../outside.png', filename: 'outside-target.png' },
	], reason: 'Test' });
	assert.deepEqual(result.results.map(({ code }) => code), ['upload-warning', 'local-file-unavailable', undefined]);
	assert.equal(result.results[2].status, 'refused');
	const uploads = calls.filter(({ req }) => req.action === 'upload');
	assert.equal(uploads.length, 1);
	assert.equal(uploads[0].req.ignorewarnings, undefined);
	assert.equal(uploads[0].file.bytes.toString(), 'fixture');
});

test('downloads a wiki-resolved file and preserves an existing local file', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'uai-download-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const handler = managementHandlers({ directory, action: async () => ({
		query: { pages: [{ title: 'Datei:Test.png', imageinfo: [{ url: 'https://test.wiki/images/test.png', size: 7 }] }] },
	}), fetchFile: async (url) => {
		assert.equal(url, 'https://test.wiki/images/test.png');
		return Buffer.from('fixture');
	} });
	assert.equal((await handler.download({ files: ['Test.png'] })).results[0].status, 'downloaded');
	assert.equal((await handler.download({ files: ['Test.png'] })).results[0].code, 'local-file-exists');
	assert.equal(await readFile(join(directory, 'Test.png'), 'utf8'), 'fixture');
});

test('HTTP transport sends multipart uploads and rejects off-wiki downloads before sending credentials', async () => {
	let requests = 0;
	const transport = mediaWikiTransport({
		actionUrl: 'https://test.wiki/w/api.php', restUrl: 'https://test.wiki/w/rest.php',
		fetch: async (url, options) => {
			requests++;
			if (options.method === 'POST') {
				assert.equal(options.body.get('action'), 'upload');
				assert.equal(options.body.get('file').name, 'fixture.png');
				return Response.json({ upload: { result: 'Success' } });
			}
			return new Response('123456');
		},
	});
	await transport.action({ action: 'upload' }, { name: 'fixture.png', bytes: Buffer.from('123') });
	await assert.rejects(transport.download('https://outside.wiki/file', 8), { status: 400 });
	assert.equal(requests, 1);
	await assert.rejects(transport.download('https://test.wiki/file', 5), { status: 413 });
});
