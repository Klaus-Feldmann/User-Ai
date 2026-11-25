/**
 * UAI catalog v1 reference client. The host supplies authenticated, same-wiki
 * Action and REST transports. This module has no MCP or OAuth dependency.
 */
export function createUaiClient({ action, rest, download, allowWrites = false }) {
	const uai = async (operation, parameters = {}) => {
		const result = await action({ action: 'userai', operation, formatversion: 2, ...parameters });
		requireActionSuccess(result);
		if (result?.userai?.version !== 1) throw new Error('Unsupported UAI Action API response');
		return result.userai;
	};

	async function loadCatalog() {
		const result = await uai('catalog');
		// UAI Beta.2 loses the object type for these two empty JSON Schema keywords.
		const catalog = JSON.parse(result.data, (key, value) =>
			(key === 'properties' || key === 'additionalProperties') &&
			Array.isArray(value) && value.length === 0 ? {} : value
		);
		if (catalog.version !== 1 || catalog.actionModule !== 'userai' || !Array.isArray(catalog.tools)) {
			throw new Error('Unsupported UAI catalog');
		}
		return catalog;
	}

	async function coreAction(parameters, file) {
		const response = await action({ formatversion: 2, ...parameters }, file);
		requireActionSuccess(response);
		return response;
	}

	async function resolvePage(args) {
		if ((args.title === undefined) === (args.pageId === undefined)) {
			throw new Error('Provide exactly one of title or pageId');
		}
		if (args.pageId !== undefined) return args.pageId;
		const response = await coreAction({ action: 'query', titles: args.title });
		const page = response.query?.pages?.[0];
		if (!Number.isSafeInteger(page?.pageid) || page.pageid < 1) throw new Error('Wiki page not found');
		return page.pageid;
	}

	async function prepareArgs(call, original, catalog) {
		const args = { ...original };
		for (const step of call.prepare ?? []) {
			switch (step) {
				case 'resolve-page-id':
					args.pageId = await resolvePage(args);
					break;
				case 'initialize-identity': {
					if (args.identityLanguage === undefined) {
						const info = await coreAction({ action: 'query', meta: 'siteinfo', siprop: 'general' });
						args.identityLanguage = info.query?.general?.lang ?? 'en';
					}
					args.labels ??= args.label?.trim() ? { [args.identityLanguage]: args.label } : {};
					args.descriptions ??= {};
					break;
				}
				case 'merge-current-identity': {
					if (['identityLanguage', 'labels', 'descriptions'].every((key) => args[key] !== undefined)) break;
					const payload = await invoke(catalog, 'sws-get-subject', { id: args.id, latest: true });
					const current = payload.subjects?.[payload.requestedId ?? args.id];
					if (!current) throw new Error('SWS entity not found');
					if (!current.identityLanguage) break;
					args.identityLanguage ??= current.identityLanguage;
					if (args.labels === undefined) {
						args.labels = { ...current.labels };
						if (args.label?.trim()) args.labels[args.identityLanguage] = args.label;
						else delete args.labels[args.identityLanguage];
					}
					args.descriptions ??= current.descriptions ?? {};
					break;
				}
				default:
					throw new Error('Unsupported UAI preparation rule: ' + step);
			}
		}
		return args;
	}

	async function invoke(catalog, name, input = {}) {
		const tool = catalog.tools.find((entry) => entry.name === name);
		if (!tool) throw new Error('Tool is unavailable: ' + name);
		const call = tool.calls.find(({ when }) => !when || (when.present
			? Object.hasOwn(input, when.argument) && input[when.argument] !== undefined
			: input[when.argument] === when.equals));
		if (!call) throw new Error('No matching UAI call for ' + name);
		if (tool.annotations?.readOnlyHint !== true && !allowWrites) throw new Error('Wiki writes are disabled on this connection');
		const args = await prepareArgs(call, input, catalog);
		for (const key of call.require ?? []) {
			if (args[key] === undefined) throw new Error('Missing required argument: ' + key);
		}
		const parameters = { ...call.defaults, ...mapValues(call.parameters, args) };
		if (call.transport === 'action') {
			const result = await uai(call.operation, call.jsonParameter
				? { [call.jsonParameter]: JSON.stringify(parameters) }
				: parameters);
			return call.response === 'json-data' ? JSON.parse(result.data) : result;
		}
		if (call.transport === 'wiki-action' && call.action === 'swsprocessingstatus') {
			return (await coreAction({ action: call.action, ...parameters }))[call.responseKey];
		}
		if (call.transport !== 'rest' || !/^\/uai\/v0\/[\w/{}-]+$/.test(call.path)) {
			throw new Error('Unsupported UAI transport or path');
		}
		const path = call.path.replace(/\{(\w+)\}/g, (_, key) => {
			const value = args[call.pathArguments?.[key]];
			if ((typeof value !== 'string' && !Number.isSafeInteger(value)) || value === '' || value === '.' || value === '..') {
				throw new Error('Invalid REST path argument: ' + key);
			}
			return encodeURIComponent(value);
		});
		const body = call.body && select(call.body, args);
		if (!['GET', 'POST', 'PUT', 'DELETE'].includes(call.method) ||
			(['PUT', 'DELETE'].includes(call.method) && (!allowWrites || call.csrf !== true))) {
			throw new Error('Unsupported or unauthorized REST method');
		}
		return rest({
			method: call.method,
			path,
			query: { ...call.queryValues, ...mapValues(call.query, args) },
			...(body && (Object.keys(body).length > 0 || call.method !== 'DELETE') ? { body } : {}),
			csrf: call.csrf === true,
		});
	}

	async function provisionProfile(catalog, context) {
		if (!allowWrites) throw new Error('Wiki writes are disabled on this connection');
		if (context.profile?.status === 'loaded') return context;
		if (catalog.profile?.provision !== 'mediawiki-createonly' ||
			context.profile?.reason !== 'Profile revision is missing.' || !context.profile?.title) {
			throw new Error('UAI did not report a missing profile');
		}
		const identity = await coreAction({ action: 'query', meta: 'userinfo' });
		const actor = identity.query?.userinfo;
		if (!actor?.id || actor.id !== context.actorId || !actor.name) throw new Error('Wiki account changed');
		const template = await uai(catalog.profile.templateOperation);
		const response = await coreAction({ action: 'query', meta: 'tokens', type: 'csrf' });
		const token = response.query?.tokens?.csrftoken;
		if (typeof template.text !== 'string' || typeof token !== 'string') throw new Error('Profile template or request token missing');
		try {
			const result = await coreAction({
				action: 'edit', title: 'User:' + actor.name + '/profil', text: template.text,
				contentmodel: 'wikitext', createonly: 1, assert: 'user', assertuser: actor.name,
				summary: 'User AI: create assistant profile', token,
			});
			if (result.edit?.result !== 'Success') throw new Error('Profile creation failed');
		} catch (error) {
			if (error.code !== 'articleexists') throw error;
		}
		return uai('context');
	}

	return { loadCatalog, invoke, provisionProfile, coreAction, download };
}

function requireActionSuccess(result) {
	const failure = result?.error ?? result?.errors?.[0];
	if (failure) {
		const error = new Error(failure.info ?? failure.text ?? failure.code ?? 'MediaWiki request failed');
		error.code = failure.code;
		throw error;
	}
}

function mapValues(mapping, args) {
	return Object.fromEntries(Object.entries(mapping ?? {})
		.filter(([, source]) => args[source] !== undefined)
		.map(([target, source]) => [target, args[source]]));
}

function select(keys, args) {
	return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
}

export function mcpDefinitions(catalog) {
	return catalog.tools.map(({ name, description, inputSchema, annotations }) => ({
		name, description, inputSchema, annotations,
	}));
}
