import { constants } from 'node:fs';
import { open, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const maxFileBytes = 20 * 1024 * 1024;
const pageTitle = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^|]+$' };
const fileName = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\:|]+$' };
const reason = { type: 'string', minLength: 1, maxLength: 255 };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const batch = (items) => ({ type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items });

export function managementTools(tool, handlers = {}, { filesEnabled = false } = {}) {
	const tools = [
		tool('move-pages', 'Move the explicitly listed source pages to their respective destinations. The default is to leave a redirect. Each item must have a distinct source and destination.', {
			moves: batch(object({ from: pageTitle, to: pageTitle, leaveRedirect: { type: 'boolean' } }, ['from', 'to'])),
			reason,
		}, ['moves', 'reason'], (args) => handlers.move(args), { write: true }),
		tool('undelete-pages', 'Restore the explicitly listed deleted pages. Restores their archived revisions. If a title exists again, MediaWiki may merge the restored history.', {
			titles: batch(pageTitle), reason,
		}, ['titles', 'reason'], (args) => handlers.undelete(args), { write: true }),
	];
	if (filesEnabled) {
		tools.push(
			tool('download-files', 'Save the named wiki files in the local staging directory. Existing local files are protected from overwrite.', {
				files: batch(fileName),
			}, ['files'], (args) => handlers.download(args), { write: true }),
			tool('upload-files', 'Upload explicitly named local files from the staging directory. MediaWiki upload warnings stop that file; existing wiki files are protected from overwrite.', {
				files: batch(object({ localName: fileName, filename: fileName, description: { type: 'string', maxLength: 20000 } },
					['localName', 'filename'])),
				reason,
			}, ['files', 'reason'], (args) => handlers.upload(args), { write: true }),
		);
	}
	return tools;
}

export async function fileInformation(action, filename) {
	safeName(filename);
	const result = await action({
		action: 'query', titles: 'File:' + filename, prop: 'info|imageinfo', inprop: 'url',
		iiprop: 'url|size|mime|timestamp|user|sha1', iilimit: 1,
	});
	const page = result.query?.pages?.[0];
	const data = page?.imageinfo?.[0];
	if (!data?.url) throw Object.assign(new Error('Wiki file not found.'), { status: 404 });
	return {
		title: page.title, pageUrl: data.descriptionurl ?? page.fullurl, fileUrl: data.url, bytes: data.size,
		mime: data.mime, user: data.user, timestamp: data.timestamp, sha1: data.sha1,
	};
}

export function managementHandlers({ action, authenticated, directory, fetchFile }) {
	const stableErrors = new Set([
		'articleexists', 'fileexists', 'missingtitle', 'notanarticle', 'permissiondenied', 'protectedpage',
		'immobilenamespace', 'cantmove', 'cantundelete', 'nodeletedrevisions', 'filetype-banned',
		'filetype-mime-mismatch', 'upload-disabled', 'filemissing', 'badfilename', 'duplicate',
	]);
	const stopErrors = new Set(['userai-connection-required','mwoauth-invalid-authorization','badtoken','assertuserfailed']);

	async function run(items, label, operate) {
		const results = [];
		let stopped = false;
		for (const item of items) {
			const target = label(item);
			if (stopped) { results.push({ ...target, status: 'not-attempted' }); continue; }
			try {
				results.push({ ...target, ...await operate(item) });
			} catch (error) {
				const code = error.code;
				if (stableErrors.has(code) || [400, 404, 409, 413].includes(error.status)) {
					results.push({ ...target, status: 'refused', ...(stableErrors.has(code) ? { code } : {}) });
					continue;
				}
				const blocked = stopErrors.has(code);
				results.push({ ...target, status: blocked ? 'refused' : 'unconfirmed', ...(blocked ? { code } : {}) });
				stopped = true;
			}
		}
		return { results, stopped };
	}

	return {
		async move({ moves, reason }) {
			// A batch contains independent moves. Avoid source/destination overlap or duplicate targets.
			const keys = moves.flatMap(({ from, to }) => [from, to]).map((title) => title.replaceAll('_', ' ').trim());
			if (new Set(keys).size !== keys.length) throw Object.assign(new Error('Overlapping moves.'), { status: 400 });
			const auth = await authenticated();
			return run(moves, ({ from, to }) => ({ from, to }), async ({ from, to, leaveRedirect = true }) => {
				const target = await action({ action: 'query', titles: to, prop: 'info' });
				if (target.query?.pages?.[0]?.missing !== true) return { status: 'refused', code: 'destination-not-free' };
				const result = (await action({ action: 'move', from, to, reason, ...auth,
					...(leaveRedirect ? {} : { noredirect: 1 }) })).move;
				if (!result?.from || !result?.to) throw new Error('Unconfirmed move.');
				return { status: 'moved', from: result.from, to: result.to, redirectCreated: Boolean(result.redirectcreated) };
			});
		},
		async undelete({ titles, reason }) {
			const auth = await authenticated();
			return run(titles, (title) => ({ title }), async (title) => {
				const result = (await action({ action: 'undelete', title, reason, ...auth })).undelete;
				if (!result?.title) throw new Error('Unconfirmed restoration.');
				return { status: 'restored', title: result.title, revisions: result.revisions, fileVersions: result.fileversions };
			});
		},
		async download({ files }) {
			const root = await realpath(directory);
			return run(files, (filename) => ({ filename }), async (filename) => {
				const info = await fileInformation(action, filename);
				if (info.bytes > maxFileBytes) return { status: 'refused', code: 'file-too-large' };
				const data = await fetchFile(info.fileUrl, maxFileBytes);
				const file = join(root, safeName(filename));
				try {
					await writeFile(file, data, { mode: 0o600, flag: 'wx' });
				} catch (error) {
					if (error.code === 'EEXIST') return { status: 'refused', code: 'local-file-exists' };
					throw error;
				}
				return { status: 'downloaded', path: file, bytes: data.length, url: info.fileUrl };
			});
		},
		async upload({ files, reason }) {
			const root = await realpath(directory);
			const auth = await authenticated();
			return run(files, ({ localName, filename }) => ({ localName, filename }), async ({ localName, filename, description }) => {
				const name = safeName(filename);
				// Reject existing wiki files up front. MediaWiki warnings remain enabled for races.
				const target = await action({ action: 'query', titles: 'File:' + name, prop: 'imageinfo' });
				if (target.query?.pages?.[0]?.missing !== true || target.query?.pages?.[0]?.imageinfo?.length) {
					return { status: 'refused', code: 'wiki-file-exists' };
				}
				let handle;
				try {
					handle = await open(join(root, safeName(localName)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				} catch (error) {
					if (['ENOENT', 'ELOOP'].includes(error.code)) return { status: 'refused', code: 'local-file-unavailable' };
					throw error;
				}
				let bytes;
				try {
					const stat = await handle.stat();
					if (!stat.isFile() || stat.size < 1 || stat.size > maxFileBytes) return { status: 'refused', code: 'invalid-file-size-or-type' };
					bytes = Buffer.alloc(stat.size);
					let offset = 0;
					while (offset < stat.size) {
						const { bytesRead } = await handle.read(bytes, offset, stat.size - offset);
						if (!bytesRead) return { status: 'refused', code: 'local-file-changed' };
						offset += bytesRead;
					}
				} finally {
					await handle.close();
				}
				const result = (await action({
					action: 'upload', filename: name, comment: reason, ...auth,
					...(description === undefined ? {} : { text: description }),
				}, { name, bytes })).upload;
				if (result?.result === 'Warning') return { status: 'refused', code: 'upload-warning', warnings: Object.keys(result.warnings ?? {}) };
				if (result?.result !== 'Success') throw new Error('Unconfirmed upload.');
				return { status: 'uploaded', filename: result.filename, url: result.imageinfo?.descriptionurl };
			});
		},
	};
}

function safeName(name) {
	if (typeof name !== 'string' || name !== basename(name) || !name.trim() || name === '.' || name === '..' || /[\\:|\u0000-\u001f]/.test(name)) {
		throw Object.assign(new Error('Invalid file basename.'), { status: 400 });
	}
	return name;
}
