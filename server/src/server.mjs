import { setTimeout as sleep } from 'node:timers/promises';
import { approvedChange, checkEntityChange } from './order-changes.mjs';
import { resolveAppLocale } from './app-locale.mjs';
import { randomUUID } from 'node:crypto';
import { idPattern, validateReplacement, withOrder } from './template-order.mjs';
import { auftrag, bannerText, schema as auftragSchema } from './auftrag.mjs';
import { wikiAuftrag } from './wiki-auftrag.mjs';
import { validateEntityFieldReplacement } from './entity-field-order.mjs';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { discoverDataView } from './sws-data-view.mjs';
import swsWriteDefinitions from './sws-write-definitions.json' with { type: 'json' };
import { BrowserLoginRequiredError } from './oauth.mjs';
import { wikiTools, wikiPageWriteTools } from './wiki-tools.mjs';
import { mcpDefinitions } from './client.mjs';

export const serverInfo = { name: 'uai-mcp-server', version: '0.1.1' };
const serverInstance = randomUUID();
const runtime = { serverVersion: serverInfo.version, serverInstance };
const runtimeLabel = 'UAI-Server ' + serverInfo.version + ' · Instanz ' + serverInstance;
const accessPolicy = 'Access this wiki exclusively through UAI. Other access paths or external sources require separate, explicit supervisor approval for the specific access. If a tool required for the task is missing or fails technically, stop the task, report the tool, affected step and observed failure, and discuss it with the supervisor before continuing.';
const resultLimit = 75000;
const swsWriteNames = new Set(swsWriteDefinitions.map(({ name }) => name));

const progressToolName = 'uai-save-progress';
const progressTool = {
	name: progressToolName,
	provider: 'userai',
	description: 'Save a running checkpoint for the approved order. Start, pause and complete via auftrag. Summarize confirmed progress and blockers without secrets. Do not send an update after every wiki operation.',
	annotations: { title: 'UAI-Arbeitsstand speichern', readOnlyHint: false, destructiveHint: false },
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['task', 'status', 'summary'],
		properties: {
			task: { type: 'string', minLength: 1, maxLength: 120 },
			status: { type: 'string', enum: ['running', 'paused', 'completed'] },
			summary: { type: 'string', maxLength: 480 },
		},
	},
};

export async function connectToWiki(client, { allowPageWrites = false, allowSwsWrites = false, expectedActorId, fileDirectory } = {}) {
	const catalog = await client.loadCatalog();
	const context = await client.invoke(catalog, 'get-agent-context');
	if (!Number.isSafeInteger(context?.actorId) || context.actorId < 1 ||
		context.catalogVersion !== catalog.version ||
		(expectedActorId !== undefined && context.actorId !== expectedActorId)) {
		throw new Error('The wiki did not confirm an authenticated UAI catalog session.');
	}
	const caps = catalog.tools.some(({ name }) => name === 'sws-get-query-capabilities')
		? await client.invoke(catalog, 'sws-get-query-capabilities')
		: undefined;
	const configuredTools = new Set(catalog.tools.filter((tool) =>
		!tool.calls.some(({ backend }) => backend && caps?.[backend] === 'not-configured'),
	).map(({ name }) => name));
	const definitions = mcpDefinitions(catalog)
		.filter(({ name, annotations }) => configuredTools.has(name) &&
			(annotations?.readOnlyHint === true || (allowSwsWrites && swsWriteNames.has(name))))
		.map((tool) => ({ ...tool, provider: 'userai', invoke: (args) => client.invoke(catalog, tool.name, args) }));
	const dataView = catalog.tools.some(({ name }) => name === 'sws-get-schema')
		? await discoverDataView(client.coreAction)
		: [];
	if (context.progressEnabled === true) {
		const calls = new Map();
		for (const name of ['next-order-number', 'save-progress', 'clear-reviewed-report']) {
			const tool = catalog.tools.find(entry => entry.name === name);
			const call = tool?.calls.find(entry => entry.transport === 'action' && entry.operation === name);
			if (!call || tool.annotations?.readOnlyHint !== false)
				throw new Error('UAI-Extension: Im Werkzeugkatalog fehlt die Auftragsoperation ' + name);
			calls.set(name, call);
		}
		const invokeWorkflow = (name, args = {}) => {
			const call = calls.get(name);
			const parameters = Object.fromEntries(Object.entries(call.parameters).filter(([, key]) =>
				args[key] !== undefined).map(([parameter, key]) => [parameter, args[key]]));
			return client.coreAction({ ...parameters, action: catalog.actionModule, operation: call.operation });
		};
		definitions.push({
			...progressTool,
			review: context.wikiOrderReview === true ? wikiReviewOperations(client, catalog.actionModule) : undefined,
			allocate: async () => {
				const response = await invokeWorkflow('next-order-number');
				const data = response.userai;
				if (data?.version !== 1 || !Number.isSafeInteger(data.number) || data.number < 1 || !data.user?.trim()) {
					throw new Error('UAI hat die Auftragsnummer nicht bestätigt.');
				}
				return data;
			},
			clearReport: async (task, reporttoken, summary) => {
				const result = await invokeWorkflow('clear-reviewed-report', { task, reporttoken, summary });
				if (result.userai?.version !== 1 || typeof result.userai.cleared !== 'boolean')
					throw new Error('Berichtsprüfung vom Wiki nicht bestätigt.');
				return result.userai.cleared;
			},
			invoke: async ({ task, status, summary, reporttoken }) => {
				const response = await invokeWorkflow('save-progress', { task, status, summary, reporttoken });
				if (response.userai?.version !== 1 || !Number.isSafeInteger(response.userai.updatedAt)) {
					throw new Error('UAI did not confirm the saved progress.');
				}
				return response.userai;
			},
		});
	}
	return [...definitions, ...dataView, ...wikiTools(client.coreAction, { allowPageWrites, actorId: context.actorId, fileDirectory, fetchFile: client.download })];
}

function wikiReviewOperations(client, actionModule) {
	const call = async (operation, args) => {
		const { userai } = await client.coreAction({ action: actionModule, operation, ...args });
		if (userai?.version !== 1 || !['pending', 'approved', 'stopped', 'expired'].includes(userai.status))
			throw new Error('Das Wiki hat den Stand der Auftragsprüfung nicht bestätigt.');
		return userai;
	};
	return {
		create: async (id, task, reviewphase, reviewtext) => {
			const reply = await call('order-review-create', { id, task, reviewphase, reviewtext });
			if (typeof reply.approvalUrl !== 'string' || !Number.isSafeInteger(reply.expiresAt))
				throw new Error('Das Wiki hat keinen Freigabelink geliefert.');
			return reply;
		},
		status: id => call('order-review-status', { id }),
		stop: id => call('order-review-stop', { id }),
	};
}

async function invokeTool(tool, args) {
	try {
		const data = await tool.invoke(args);
		const payload = { provider: tool.provider, data: data ?? null };
		const text = JSON.stringify(payload);
		if (Buffer.byteLength(text) > resultLimit) return stoppedResult(tool.name, 'Die Wiki-Antwort überschreitet das Antwortlimit von UAI.');
		return { structuredContent: payload, content: [{ type: 'text', text }] };
	} catch (error) {
		if (error instanceof BrowserLoginRequiredError || error?.code === 'mwoauth-invalid-authorization') {
			return errorResult(new BrowserLoginRequiredError().message);
		}
		if (error?.code === 'userai-connection-required' ||
			(error?.status === 403 && error.message === 'User AI connection approval required.')) {
			return errorResult('Die UAI-Freigabe wurde widerrufen oder ist abgelaufen. Rufe uai-connect auf, um eine neue Freigabe anzufordern.');
		}
		const conflict = error?.status === 409 || ['editconflict', 'articleexists', 'pagedeleted'].includes(error?.code);
		const denied = error?.status === 403 || ['userai-denied', 'readapidenied', 'permissiondenied', 'protectedpage', 'cantcreate', 'badtoken'].includes(error?.code);
		if (!conflict && !denied && ![400, 404, 422].includes(error?.status)) {
			const status = Number.isInteger(error?.status) ? ' (HTTP ' + error.status + ')' : '';
			return stoppedResult(tool.name, 'Der Wiki-Aufruf ist technisch fehlgeschlagen' + status + '.');
		}
		return errorResult(conflict
			? 'The wiki reported an edit conflict. Read the current revision before retrying.'
			: denied
				? 'Access was denied for the authenticated wiki account.'
				: error?.status === 404
					? 'The wiki page or revision was not found.'
					: 'The wiki request failed. Check the wiki, arguments and account permissions.');
	}
}

export function createSessionServer({ wiki, reconnect, orderDirectory, allowPageWrites = false, allowSwsWrites = false, fileDirectory }) {
	const server = new McpServer(serverInfo, { capabilities: { tools: { listChanged: true } } });
	let connected = false;
	let pending;
	let halted;
	let order, changingOrder = false, calls = 0;
	const gate = () => halted || (changingOrder || order?.status !== 'freigegeben'
		? errorResult('Zuerst Auftrag vorlegen und die Freigabe bestätigen. Konkrete Änderungen anschließend zur Freigabe vorlegen.') : null);
	const notify = (task, status, summary, reporttoken) =>
		writeTools.get(progressToolName).tool.invoke({ task, status, summary, reporttoken });
	const halt = async result => {
		halted = result;
		if (order?.status === 'freigegeben') {
			await withOrder(orderDirectory, order.id, async (record, save) => {
				record.status = 'unterbrochen';
				await save();
				order = record;
			});
			await notify(order.name, 'paused', bannerText(result.content[0].text));
		}
		return result;
	};
	const runTool = async (tool, args) => {
		const blocked = gate();
		if (blocked) return blocked;
		calls++;
		try {
			const result = await invokeTool(tool, args);
			return result.structuredContent?.taskStopped === true ? await halt(result) : result;
		} finally { calls--; }
	};
	const readTools = new Map();
	const writeTools = new Map();

	const read = (name, args) => {
		const entry = readTools.get(name);
		if (!entry) throw new Error('Benötigtes Lesewerkzeug fehlt: ' + name);
		return entry.tool.invoke(args);
	};
	const registered = [];
	const clearTools = () => {
		for (const tool of registered.splice(0)) tool.remove();
		readTools.clear();
		writeTools.clear();
		connected = false;
	};

	const registerWiki = (definitions) => {
		for (const tool of definitions) {
			const { name, description, annotations } = tool;
			if (annotations.readOnlyHint !== true) {
				writeTools.set(name, { tool, inputSchema: fromJsonSchema(tool.inputSchema) });
				continue;
			}
			const inputSchema = fromJsonSchema(tool.inputSchema);
			registered.push(server.registerTool(name, { description, annotations, inputSchema }, (args) => runTool(tool, args)));
			if (annotations.readOnlyHint === true) readTools.set(name, { tool, inputSchema });
		}
		connected = true;
	};

	const processOrderCall = async (args, context) => {
		if (changingOrder || calls) return errorResult('Auftragsvorgang läuft. Bitte erneut versuchen.');
		if (args.entwurf && (order?.review || order?.status === 'freigegeben')) return errorResult('Laufenden Auftrag oder offene Freigabe zuerst abschließen.');
		if (halted && !args.entwurf && !args.id) return halted;
		if (args.id && (args.vorlagen || args.aenderungen || args.aktion) && order && order.id !== args.id)
			return errorResult('Diese ID gehört zu einem anderen Auftrag.');
		changingOrder = true;
		try {
			if (!connected) {
				const connection = await connect(0, context);
				if (!connection.structuredContent?.connected) return connection;
			}
			const progress = writeTools.get(progressToolName)?.tool;
			if (!progress) return errorResult('Auftrag benötigt eine aktive UAI-Verbindung mit Banner.');
			try {
				if ((args.feldAenderung || args.aenderungen) && !progress.review) return errorResult('Feld- und Änderungsfreigaben benötigen die Wiki-Auftragsfreigabe.');
				const processOrder = progress.review ? wikiAuftrag : auftrag;
				if (progress.review && args.id && order && order.id !== args.id && (order.review || order.status === 'freigegeben'))
					return errorResult('Diese ID gehört zu einem anderen Auftrag.');
				const record = await processOrder(args, {
					directory: orderDirectory,
					allocate: progress.allocate,
					read, validateWrite, clearReport: progress.clearReport,
					notify: (task, status, summary, reporttoken) => progress.invoke({ task, status, summary, reporttoken }),
					ask: params => context.mcpReq.elicitInput(params),
					review: progress.review,
					signal: context.signal,
				});
				if (args.entwurf || !order || args.id === order.id || args.aktion || args.vorlagen || args.aenderungen) order = record;
				if (args.entwurf) halted = undefined;
				if (record.review?.approvalUrl) {
					const { id, name, status, review: { approvalUrl, expiresAt, phase } } = record;
					return { structuredContent: { id, name, status, approvalUrl, expiresAt, phase }, content: [{
						type: 'text',
						text: name + ' · [Auftrag prüfen](' + approvalUrl + ')\nDie Entscheidung unter derselben ID mit waitSeconds abrufen. Auftrags-ID: ' + id,
					}] };
				}
				return { structuredContent: record, content: [{ type: 'text', text: JSON.stringify(record) }] };
			} catch (error) {
				if (error.code === 'userai-connection-required' || error.cause?.code === 'userai-connection-required') {
					const connection = await connect(0, context);
					if (connection.isError) return connection;
					connection.content.push({ type: 'text', text: error.orderId
						? 'Auftrag bereits angelegt. Nach der Verbindung zuerst den gespeicherten Status dieser ID abrufen: ' + error.orderId
						: 'Nach der Verbindungsfreigabe den ursprünglichen Auftrag erneut vorlegen.' });
					return connection;
				}
				if (args.id && order?.id === args.id)
					order = await auftrag({ id: args.id }, { directory: orderDirectory });
				return errorResult(error.orderId
					? error.message + ' Gespeicherten Auftrag unter derselben ID erneut abrufen: ' + error.orderId
					: error.message);
			}
		} finally {
			changingOrder = false;
		}
	};
	server.registerTool('auftrag', {
		description: 'Vollständigen Auftrag mit den jeweiligen Auswahlregeln vorlegen. Nach der Entwurfsfreigabe Recherche ausführen. Konkrete Schreibvorgänge als aenderungen unter derselben ID zur Freigabe vorlegen. Jeder Eintrag enthält werkzeug und argumente ohne auftragsId. Freigabelink sofort anzeigen und die Entscheidung unter derselben ID mit waitSeconds abrufen. Erst nach Freigabe exakt die vorgelegten Schreibvorgänge mit auftragsId ausführen. anhalten stoppt einen offenen Auftrag. Zum Abschluss abschliessen mit bericht verwenden.',
		annotations: { title: 'Auftrag', readOnlyHint: false, destructiveHint: false },
		inputSchema: fromJsonSchema(auftragSchema),
	}, async ({ waitSeconds, ...args }, context) => {
		if (waitSeconds === undefined) return processOrderCall(args, context);
		if (!args.id || Object.keys(args).length !== 1)
			return errorResult('Warteabfrage nur mit Auftrags-ID angeben.');
		const deadline = Date.now() + waitSeconds * 1000;
		while (true) {
			const result = await processOrderCall(args, context);
			const remaining = deadline - Date.now();
			if (remaining <= 0 || !result.structuredContent?.approvalUrl) return result;
			await sleep(Math.min(2000, remaining), undefined, { signal: context.signal });
		}
	});

	server.registerTool(progressToolName, {
		description: progressTool.description,
		annotations: progressTool.annotations,
		inputSchema: fromJsonSchema(progressTool.inputSchema),
	}, async (args) => {
		const blocked = gate();
		if (blocked) return blocked;
		if (args.status !== 'running') return errorResult('Zum Anhalten oder Abschließen auftrag verwenden.');
		args = { ...args, task: order.name };
		const active = writeTools.get(progressToolName);
		if (!active) return errorResult(connected
			? 'Das Wiki unterstützt keine UAI-Statusmeldungen.'
			: 'Das Wiki ist noch nicht verbunden. Rufe zuerst uai-connect auf.');
		if (!args.task.trim() || Buffer.byteLength(args.task.trim()) > 120 || Buffer.byteLength(args.summary.trim()) > 480) {
			return errorResult('Die UAI-Statusmeldung ist ungültig oder zu lang.');
		}
		return runTool(active.tool, args);
	});

	const offeredWrites = [
		...(allowPageWrites ? wikiPageWriteTools(undefined, undefined, undefined, Boolean(fileDirectory)) : []),
		...(allowSwsWrites ? swsWriteDefinitions : []),
	];
	const validateWrite = async (name, args) => {
		const active = writeTools.get(name);
		if (name === progressToolName || !active) throw new Error('Schreibwerkzeug nicht verfügbar: ' + name);
		if (Object.hasOwn(args, 'auftragsId')) throw new Error('Auftrags-ID gehört nicht in die Werkzeugargumente.');
		const validated = await active.inputSchema['~standard'].validate(args);
		if (validated.issues) throw new Error('Ungültige Argumente für Schreibwerkzeug: ' + name);
		return validated.value;
	};
	const checkApprovals = async record => {
		const review = writeTools.get(progressToolName)?.tool.review;
		const decisions = await Promise.all((record.freigabeIds ?? []).map(id => review.status(id)));
		return decisions.every(decision => decision.status === 'approved');
	};
	const markStopped = async (record, save) => {
		record.status = 'gestoppt';
		await save();
		order = record;
		await notify(record.name, 'stopped', 'Freigabe zurückgezogen oder abgelaufen.');
	};
	const writeApproved = async (name, args, auftragsId, active) => {
		if (!auftragsId || order.id !== auftragsId) throw new Error('Passende Auftrags-ID erforderlich.');
		const result = await withOrder(orderDirectory, auftragsId, async (record, save) => {
			const plan = approvedChange(record, name, args);
			if (plan.titel) {
				const page = await read('get-page', { title: plan.titel });
				const { subjects } = await read('sws-get-subject', { id: args.id, latest: true });
				checkEntityChange(plan, page, subjects[args.id]);
			}
			if (!await checkApprovals(record)) {
				await markStopped(record, save);
				throw new Error('Die Wiki-Freigabe ist nicht mehr gültig.');
			}
			plan.ausfuehrung = 'begonnen';
			await save();
			const reply = await invokeTool(active.tool, args);
			plan.ausfuehrung = reply.isError || reply.structuredContent?.taskStopped ? 'pruefen' : 'ausgefuehrt';
			await save();
			return reply;
		});
		return result.structuredContent?.taskStopped ? halt(result) : result;
	};
	const write = async (name, input) => {
		const blocked = gate();
		if (blocked) return blocked;
		const active = writeTools.get(name);
		if (!active) return connected
			? halt(stoppedResult(name, 'Das benötigte Schreibwerkzeug ist auf diesem Wiki nicht verfügbar.'))
			: errorResult('Das Wiki ist noch nicht verbunden. Rufe zuerst uai-connect auf.');
		const { auftragsId, ...args } = input;
		if (order.allgemein) {
			try { return await writeApproved(name, await validateWrite(name, args), auftragsId, active); }
			catch (error) { return errorResult(error.message); }
		}
		if (name !== 'sws-update-subject' && (order.vorlagenauftrag || order.targets || order.feldAenderung || auftragsId))
			return errorResult('Dieses Schreibwerkzeug liegt außerhalb des Auftrags.');
		const validated = await active.inputSchema['~standard'].validate(args);
		if (validated.issues) return errorResult('Die Eingaben entsprechen dem aktuellen Schema des Wiki-Werkzeugs nicht.');
		if (name !== 'sws-update-subject') return runTool(active.tool, validated.value);
		if (!auftragsId || order.id !== auftragsId) return errorResult('Passende Auftrags-ID erforderlich.');
		try {
			const result = await withOrder(orderDirectory, auftragsId, async record => {
				if (record.status === 'freigegeben' && record.feldAenderung) {
					const change = record.feldAenderung;
					if (args.id !== change.id) throw new Error('Entität liegt außerhalb des Auftrags.');
					const [page, subjects, definition] = await Promise.all([
						read('get-page', { title: change.titel }),
						read('sws-get-subject', { id: args.id, latest: true }),
						read('sws-get-schema', { name: change.schema }),
					]);
					const unchanged = validateEntityFieldReplacement(change, args, page, subjects.subjects[args.id], definition.schema);
					if (unchanged) return { structuredContent: { provider: 'userai', data: { status: 'unchanged', id: args.id } },
						content: [{ type: 'text', text: 'Der freigegebene Feldwert ist bereits gespeichert.' }] };
					return invokeTool(active.tool, validated.value);
				}
				const target = record.targets?.find(t => t.id === args.id);
				if (!target || record.status !== 'freigegeben') throw new Error('Ziel oder Auftrag nicht freigegeben.');
				const page = await read('get-page', { title: target.titel });
				const current = (await read('sws-get-subject', { id: args.id, latest: true })).subjects[args.id];
				validateReplacement(record, args, page, current);
				return invokeTool(active.tool, validated.value);
			});
			return result.structuredContent?.taskStopped ? await halt(result) : result;
		} catch (error) { return errorResult(error.message); }
	};
	for (const { name, description, annotations, inputSchema } of offeredWrites) {
		const schema = {
			...inputSchema,
			required: [...(inputSchema.required ?? []), ...(name === 'sws-update-subject' ? ['auftragsId'] : [])],
			properties: { ...inputSchema.properties, auftragsId: { type: 'string', pattern: idPattern } },
		};
		server.registerTool(name, { description, annotations, inputSchema: fromJsonSchema(schema) }, async args => { calls++; try { return await write(name, args); } finally { calls--; } });
	}

	async function connect(waitSeconds, context, fresh = false, locale) {
		// An explicit renewal must not join a concurrent check of the old proof.
		if (fresh && pending) await pending.catch(() => {});
		if (fresh) clearTools();
		let connectedPreviously = false;
		const appLocale = await resolveAppLocale(context?.mcpReq?._meta?.['openai/locale'], locale);
		pending ??= reconnect({ fresh, waitSeconds, signal: context?.signal,
			locale: appLocale,
			ask: form => context.mcpReq.elicitInput(form) }).finally(() => { pending = undefined; });
		try {
			const result = await pending;
			if (result.status !== 'active') {
				clearTools();
				if (result.status === 'pending') {
					const status = { connected: false, wiki, ...result, ...runtime, accessPolicy };
					const text = runtimeLabel + '\n' + (result.notice ?? 'Bitte im Wiki als Betreuer freigeben.') + ' Prüfcode: ' + result.code +
						'. ' + result.approvalUrl + ' Der nächste Aufruf mit waitSeconds wartet auf die Entscheidung.';
					return { structuredContent: status, content: [{ type: 'text', text }] };
				}
				return errorResult('Die Freigabe wurde abgelehnt, widerrufen oder ist abgelaufen. Rufe uai-connect für eine neue Anfrage auf.');
			}
			connectedPreviously = connected && !result.definitions;
			if (result.definitions) {
				clearTools();
				registerWiki(result.definitions);
			}
		} catch (error) {
			clearTools();
			return errorResult(error.message);
		}
		const approval = connectedPreviously ? 'reused' : 'new';
		const status = { connected: true, wiki, approval, ...runtime, accessPolicy };
		return {
			structuredContent: status,
			content: [{ type: 'text', text: runtimeLabel + '\nMit ' + wiki + ' verbunden. ' + (connectedPreviously ? 'Bestehende Wiki-Freigabe bestätigt.' : 'Neue Wiki-Freigabe bestätigt.') }],
		};
	}

	server.registerTool('uai-connect', {
		description: accessPolicy + ' Connect UAI to ' + wiki + '. Recognize German and English requests case-insensitively, such as “Verbinde dich UAI”, “Verbinde UAI”, “Connect UAI” and “Connect via UAI”. Report the server version, process instance and whether an approval was reused. For a new app session after a restart or an explicit new-session test, set fresh=true on the first call only. First call without waiting to get the approval link and verification code. Show these to the supervisor, then call again with waitSeconds: 100 in the same turn to receive the decision without asking for a second chat prompt.',
		annotations: { title: 'UAI mit dem Wiki verbinden / Connect UAI', readOnlyHint: true, destructiveHint: false },
		inputSchema: fromJsonSchema({
			type: 'object', additionalProperties: false,
			properties: { locale: { type: 'string', maxLength: 64, description: 'Selected AI app UI language (BCP 47). Supply when the host omits locale metadata.' }, fresh: { type: 'boolean', description: 'Request a new supervisor approval even when this server process has an active connection. Use only on the initial call.' }, waitSeconds: { type: 'integer', minimum: 0, maximum: 100,
				description: 'Maximum wait for an existing browser approval request. Omit on the initial call to get the link immediately.' } },
		}),
	}, ({ waitSeconds = 0, fresh = false, locale }, context) => {
		if (halted) return halted;
		return connect(waitSeconds, context, fresh, locale);
	});
	server.registerTool('uai-call', {
		description: accessPolicy + ' Lists or calls read-only wiki tools. Name a missing tool here with required=true to report that it blocks the task.',
		annotations: { title: 'Wiki-Lesewerkzeug aufrufen', readOnlyHint: true },
		inputSchema: fromJsonSchema({
			type: 'object', additionalProperties: false,
			properties: { tool: { type: 'string' }, arguments: { type: 'object' }, required: { type: 'boolean' } },
		}),
	}, async (args) => {
		if (halted) return halted;
		if (!connected) return errorResult('Das Wiki ist noch nicht verbunden. Rufe zuerst uai-connect auf.');
		if (!args.tool) {
			const tools = [...readTools.values()].map(({ tool }) => ({
				name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
			}));
			return { structuredContent: { tools }, content: [{ type: 'text', text: JSON.stringify({ tools }) }] };
		}
		const blocked = gate();
		if (blocked) return blocked;
		if (order.allgemein) {
			try {
				const current = order;
				if (!await checkApprovals(current)) {
					await withOrder(orderDirectory, current.id, async (record, save) => {
						if (record.status === 'freigegeben') await markStopped(record, save);
					});
					return errorResult('Die Wiki-Freigabe ist nicht mehr gültig.');
				}
				if (order !== current || gate()) return errorResult('Auftragsstatus hat sich geändert. Erneut abrufen.');
			} catch (error) { return errorResult(error.message); }
		}
		const entry = readTools.get(args.tool);
		if (!entry) return args.required
			? halt(stoppedResult(args.tool, 'Das benötigte Werkzeug ist über diesen UAI-Aufruf nicht verfügbar.'))
			: errorResult('Dieses Lesewerkzeug ist für die Verbindung nicht verfügbar.');
		const validation = await entry.inputSchema['~standard'].validate(args.arguments ?? {});
		if (validation.issues) return errorResult('Die Eingaben entsprechen dem Schema des Wiki-Werkzeugs nicht.');
		return runTool(entry.tool, validation.value);
	});
	return server;
}

function errorResult(text) {
	return { isError: true, content: [{ type: 'text', text }] };
}

function stoppedResult(tool, reason) {
	const text = 'UAI-Halt bei ' + tool + ': ' + reason + ' Melde den betroffenen Arbeitsschritt und kläre die Fortsetzung mit dem Betreuer.';
	return {
		isError: true,
		structuredContent: { taskStopped: true, tool, reason },
		content: [{ type: 'text', text }],
	};
}
