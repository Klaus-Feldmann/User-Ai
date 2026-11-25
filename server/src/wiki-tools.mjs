import { fileInformation, managementHandlers, managementTools } from './wiki-management.mjs';

const text = { type: 'string', minLength: 1 };
const id = { type: 'integer', minimum: 1 };
const limit = { type: 'integer', minimum: 1, maximum: 50 };
const cursor = { type: 'string', minLength: 1, maxLength: 2048 };
const namespaces = { type: 'array', minItems: 1, maxItems: 30, items: { type: 'integer', minimum: 0 } };

function tool(name, description, properties, required, invoke, { write = false, ...constraints } = {}) {
	return {
		name, description, invoke,
		inputSchema: { type: 'object', properties, required, additionalProperties: false, ...constraints },
		annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write },
		provider: 'mediawiki',
	};
}

function wikiError(message, status) {
	return Object.assign(new Error(message), { status });
}

function pageFrom(response) {
	const page = response.query?.pages?.[0];
	if (!page || page.invalid || page.missing) throw wikiError('Wiki page not found.', 404);
	return page;
}

function revisionView(revision) {
	return {
		revisionId: revision.revid, parentId: revision.parentid, timestamp: revision.timestamp,
		user: revision.user, comment: revision.comment, contentModel: revision.slots?.main?.contentmodel,
		source: revision.slots?.main?.content,
	};
}

function pageView(page) {
	return { pageId: page.pageid, title: page.title, url: page.fullurl };
}

const revFields = 'ids|timestamp|user|comment|contentmodel|content';

export function wikiTools(action, { allowPageWrites = false, actorId, fileDirectory, fetchFile } = {}) {
	async function readPage({ title }) {
		const response = await action({
			action: 'query', titles: title,
			prop: 'info|revisions', inprop: 'url', redirects: 1, rvprop: revFields, rvslots: 'main',
		});
		const page = pageFrom(response);
		return { ...pageView(page), revision: revisionView(page.revisions?.[0] ?? {}) };
	}

	const tools = [
		tool('get-page', 'Read a wiki page and its latest wikitext revision, including the canonical URL.', { title: text }, ['title'],
			(args) => readPage(args)),
		tool('get-template-documentation', 'Read the /Doku subpage of a template unless a different documentation title is provided.', {
			template: text, documentationTitle: text,
		}, ['template'], async ({ template, documentationTitle }) => {
			if (documentationTitle) return readPage({ title: documentationTitle });
			const resolved = await action({ action: 'query', titles: template, prop: 'info' });
			const candidate = resolved.query?.pages?.[0];
			const title = candidate?.ns === 10 ? candidate.title : 'Template:' + template;
			return readPage({ title: title.endsWith('/Doku') ? title : title + '/Doku' });
		}),
		tool('search-page', 'Search wiki text or page titles. Use continueFrom to fetch further hits.', {
			query: text, limit, continueFrom: cursor, namespaces,
		}, ['query'], async ({ query, limit = 10, continueFrom, namespaces }) => {
			if (continueFrom !== undefined && !/^\d+$/.test(continueFrom)) throw wikiError('Invalid search cursor.', 400);
			const response = await action({
				action: 'query', generator: 'search', gsrsearch: query, gsrlimit: limit,
				prop: 'info', inprop: 'url',
				...(continueFrom === undefined ? {} : { gsroffset: continueFrom, continue: '-||' }),
				...(namespaces ? { gsrnamespace: namespaces.join('|') } : {}),
			});
			const pages = [...(response.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			return { matches: pages.map(pageView), nextCursor: response.continue?.gsroffset?.toString() ?? null };
		}),
		tool('get-category-members', 'List a category’s members. Use continueFrom to fetch more.', {
			category: text, limit, continueFrom: cursor, namespaces,
		}, ['category'], async ({ category, limit = 20, continueFrom, namespaces }) => {
			const named = await action({ action: 'query', titles: category });
			const title = named.query?.pages?.[0]?.ns === 14 ? category : 'Category:' + category;
			const response = await action({
				action: 'query', generator: 'categorymembers', gcmtitle: title, gcmlimit: limit, prop: 'info', inprop: 'url',
				...(continueFrom ? { gcmcontinue: continueFrom, continue: '-||' } : {}),
				...(namespaces ? { gcmnamespace: namespaces.join('|') } : {}),
			});
			return { members: (response.query?.pages ?? []).map((p) => ({
				...pageView(p), namespace: p.ns,
			})), nextCursor: response.continue?.gcmcontinue ?? null };
		}),
		tool('get-page-history', 'List recent revisions of a page with users, timestamps and edit summaries.', {
			title: text, limit, continueFrom: cursor,
		}, ['title'], async ({ title, limit = 10, continueFrom }) => {
			const response = await action({
				action: 'query', titles: title, prop: 'info|revisions', inprop: 'url', rvlimit: limit,
				rvprop: 'ids|timestamp|user|comment',
				...(continueFrom ? { rvcontinue: continueFrom, continue: '-||' } : {}),
			});
			const page = pageFrom(response);
			return { ...pageView(page), revisions: (page.revisions ?? []).map(revisionView), nextCursor: response.continue?.rvcontinue ?? null };
		}),
		tool('get-revision', 'Read the wikitext and metadata of a specific past wiki revision.', {
			revisionId: id,
		}, ['revisionId'], async ({ revisionId }) => {
			const response = await action({ action: 'query', revids: revisionId, prop: 'info|revisions', inprop: 'url', rvprop: revFields, rvslots: 'main' });
			const page = pageFrom(response);
			const revision = page.revisions?.find((r) => r.revid === revisionId);
			if (!revision) throw wikiError('Wiki revision not found.', 404);
			return { ...pageView(page), revision: revisionView(revision) };
		}),
		tool('compare-pages', 'Compare two exact wiki revisions and return MediaWiki’s line-by-line diff HTML.', {
			fromRevisionId: id, toRevisionId: id,
		}, ['fromRevisionId', 'toRevisionId'], async ({ fromRevisionId, toRevisionId }) => {
			const response = await action({
				action: 'compare', fromrev: fromRevisionId, torev: toRevisionId, prop: 'ids|title|size|diff',
			});
			const diff = response.compare;
			const html = diff?.body ?? diff?.['*'];
			if (typeof html !== 'string' || diff.fromrevid !== fromRevisionId || diff.torevid !== toRevisionId) {
				throw wikiError('The wiki did not return the requested revision comparison.', 502);
			}
			return {
				from: { revisionId: diff.fromrevid, pageId: diff.fromid, title: diff.fromtitle, size: diff.fromsize },
				to: { revisionId: diff.torevid, pageId: diff.toid, title: diff.totitle, size: diff.tosize },
				diffHtml: html,
			};
		}),
		tool('check-redirects', 'Check the destination of a wiki redirect and list redirect pages pointing directly to the given title. Use continueFrom for more incoming redirects.', {
			title: { ...text, pattern: '^[^|]+$' }, limit, continueFrom: cursor, namespaces,
		}, ['title'], async ({ title, limit = 20, continueFrom, namespaces }) => {
			const [outgoing, incoming] = await Promise.all([
				action({ action: 'query', titles: title, redirects: 1, prop: 'info', inprop: 'url' }),
				action({
					action: 'query', generator: 'backlinks', gbltitle: title, gblfilterredir: 'redirects',
					gbllimit: limit, prop: 'info', inprop: 'url',
					...(continueFrom ? { gblcontinue: continueFrom, continue: '-||' } : {}),
					...(namespaces ? { gblnamespace: namespaces.join('|') } : {}),
				}),
			]);
			const page = outgoing.query?.pages?.[0];
			const hops = (outgoing.query?.redirects ?? []).map(({ from, to, tofragment }) => ({
				from, to, ...(tofragment !== undefined ? { fragment: tofragment } : {}),
			}));
			return {
				title: outgoing.query?.normalized?.[0]?.to ?? title,
				outgoing: {
					status: page?.invalid ? 'invalid-title'
						: !page ? 'unresolved'
							: hops.length === 0 ? (page.missing ? 'missing-page' : 'not-a-redirect')
								: page.missing ? 'missing-target' : 'resolved',
					hops,
					...(page && !page.missing && !page.invalid ? { target: pageView(page) } : {}),
				},
				incoming: (incoming.query?.pages ?? []).map(pageView),
				nextCursor: incoming.continue?.gblcontinue ?? null,
			};
		}),
		tool('get-file', 'Read wiki file metadata, the description page link and the direct file URL. Supply the filename without a namespace prefix.', {
			filename: text,
		}, ['filename'], ({ filename }) => fileInformation(action, filename)),
	];

	if (!allowPageWrites) return tools;

	async function authorizedIdentity() {
		const identity = (await action({ action: 'query', meta: 'userinfo' })).query?.userinfo;
		if (identity?.id !== actorId || !identity.name) throw wikiError('Wiki account changed.', 403);
		return identity.name;
	}

	async function csrfToken() {
		const csrf = (await action({ action: 'query', meta: 'tokens', type: 'csrf' })).query?.tokens?.csrftoken;
		if (!csrf || csrf === '+\\') throw wikiError('MediaWiki did not issue an authenticated token.', 403);
		return csrf;
	}

	async function edit(args, create) {
		const username = await authorizedIdentity();
		if (!create) {
			const current = await action({ action: 'query', titles: args.title, prop: 'info' });
			if (pageFrom(current).lastrevid !== args.baseRevisionId) throw wikiError('The page revision changed.', 409);
		}
		const csrf = await csrfToken();
		const response = await action({
			action: 'edit', title: args.title, text: args.source, summary: args.comment, token: csrf,
			assert: 'user', assertuser: username,
			...(create ? { createonly: 1, contentmodel: 'wikitext' } : { nocreate: 1, baserevid: args.baseRevisionId }),
		});
		if (response.edit?.result !== 'Success') throw wikiError('The wiki did not report a successful edit.', 502);
		const saved = response.edit;
		return { title: saved.title, pageId: saved.pageid, revisionId: saved.newrevid, noChange: Object.hasOwn(saved, 'nochange') };
	}

	async function deletePages({ titles, reason }) {
		const username = await authorizedIdentity();
		const csrf = await csrfToken();
		const targetList = [];
		const seen = new Set();

		// Resolve every explicitly named title before the first deletion. Never follow redirects.
		for (const title of titles) {
			if (!title.trim() || title.includes('|')) throw wikiError('Invalid wiki page title.', 400);
			const response = await action({ action: 'query', titles: title, prop: 'info', inprop: 'url' });
			const page = response.query?.pages?.[0];
			if (!page || page.invalid || page.missing || !Number.isSafeInteger(page.pageid) || page.pageid < 1) {
				targetList.push({ title, status: 'not-found' });
				continue;
			}
			if (seen.has(page.pageid)) {
				targetList.push({ title, status: 'duplicate' });
				continue;
			}
			seen.add(page.pageid);
			targetList.push({ page: pageView(page) });
		}

		const results = [];
		let stopped = false;
		for (const target of targetList) {
			if (!target.page) {
				results.push(target);
				continue;
			}
			const page = target.page;
			if (stopped) {
				results.push({ ...page, status: 'not-attempted' });
				continue;
			}
			try {
				const response = await action({
					action: 'delete', pageid: page.pageId, reason, token: csrf,
					assert: 'user', assertuser: username,
				});
				if (!response.delete || !Number.isSafeInteger(response.delete.logid)) {
					throw wikiError('Unconfirmed deletion.', 502);
				}
				results.push({ ...page, title: response.delete.title ?? page.title,
					status: 'deleted', logId: response.delete.logid });
			} catch (error) {
				const known = ['permissiondenied', 'protectedpage', 'cantdelete', 'missingtitle', 'nosuchpageid'];
				if (known.includes(error.code)) {
					results.push({ ...page, status: 'refused', code: error.code });
					continue;
				}
				const blocked = ['userai-connection-required', 'mwoauth-invalid-authorization',
					'badtoken', 'assertuserfailed'].includes(error.code);
				results.push({ ...page, status: blocked ? 'refused' : 'unconfirmed',
					...(blocked ? { code: error.code } : {}) });
				stopped = true;
			}
		}
		return { results, deleted: results.filter(({ status }) => status === 'deleted').length, stopped };
	}

	const authenticated = async () => ({ assert: 'user', assertuser: await authorizedIdentity(), token: await csrfToken() });
	const handlers = managementHandlers({ action, authenticated, directory: fileDirectory, fetchFile });
	return [...tools, ...wikiPageWriteTools(edit, deletePages, handlers, Boolean(fileDirectory))];
}

export function wikiPageWriteTools(edit, deletePages, handlers, filesEnabled) {
	const editFields = { title: text, source: { type: 'string', maxLength: 500000 }, comment: text };
	return [
		tool('create-page', 'Create a new wikitext page. Existing pages are protected from overwrite.', editFields,
			['title', 'source', 'comment'], (args) => edit(args, true), { write: true }),
		tool('update-page', 'Replace the wikitext of an existing page using the revision ID obtained when reading the page.', {
			...editFields, baseRevisionId: id,
		}, ['title', 'source', 'comment', 'baseRevisionId'], (args) => edit(args, false), { write: true }),
		tool('delete-pages', 'Delete one explicit list of wiki pages in a single approval. No title patterns or redirect targets. Review every title before approving.', {
			titles: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: {
				type: 'string', minLength: 1, maxLength: 255, pattern: '^[^|]+$',
			} },
			reason: { type: 'string', minLength: 1, maxLength: 255 },
		}, ['titles', 'reason'], (args) => deletePages(args), { write: true }),
		...managementTools(tool, handlers, { filesEnabled }),
	];
}
