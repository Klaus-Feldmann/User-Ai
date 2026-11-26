let orderNumber = 0;
import writes from '../src/sws-write-definitions.json' with { type: 'json' };
const schema = { type: 'object', additionalProperties: false };
const graph = { ...schema, properties: { query: { type: 'string' } }, required: ['query'] };
const catalog = { version: 1, actionModule: 'userai', tools: [
    {"name": "next-order-number", "description": "Nächste Auftragsnummer vergeben.", "annotations": {"readOnlyHint": false}, "requiresSws": false, "inputSchema": {"type": "object", "properties": {}, "required": [], "additionalProperties": false}, "calls": [{"transport": "action", "operation": "next-order-number", "parameters": {}}]},
    {"name": "save-progress", "description": "Arbeitsstand im privaten Banner speichern.", "annotations": {"readOnlyHint": false}, "requiresSws": false, "inputSchema": {"type": "object", "properties": {"task": {"type": "string"}, "status": {"type": "string"}, "summary": {"type": "string"}, "reporttoken": {"type": "string"}}, "required": ["task", "status", "summary"], "additionalProperties": false}, "calls": [{"transport": "action", "operation": "save-progress", "parameters": {"task": "task", "status": "status", "summary": "summary", "reporttoken": "reporttoken"}}]},
    {"name": "clear-reviewed-report", "description": "Den vom Betreuer geprüften Abschlussbericht schließen.", "annotations": {"readOnlyHint": false}, "requiresSws": false, "inputSchema": {"type": "object", "properties": {"task": {"type": "string"}, "reporttoken": {"type": "string"}, "summary": {"type": "string"}}, "required": ["task", "reporttoken"], "additionalProperties": false}, "calls": [{"transport": "action", "operation": "clear-reviewed-report", "parameters": {"task": "task", "reporttoken": "reporttoken", "summary": "summary"}}]},

	{ name: 'get-agent-context', inputSchema: schema, annotations: { readOnlyHint: true },
		calls: [{ transport: 'action', operation: 'context' }] },
	{ name: 'sws-validate-subject', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
		calls: [{ transport: 'action', operation: 'validate-subject' }] },
	{ name: 'sws-get-schema', inputSchema: schema, annotations: { readOnlyHint: true },
		calls: [{ transport: 'action', operation: 'schema' }] },
	...['sws-get-page-subjects','sws-get-subject'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
		calls: [{ transport: 'action', operation: name, response: 'json-data' }] })),
	{ ...writes.find(t => t.name === 'sws-update-subject'), calls: [{ transport: 'rest', method: 'PUT', path: '/uai/v0/subject/{id}', csrf: true, pathArguments: { id: 'id' }, body: ['statements','descriptions','baseRevisionId'] }] },
	...writes.filter(({ name }) => name === 'sws-create-subject').map((tool) => ({ ...tool,
		calls: [{ transport: 'rest', method: 'POST', path: '/uai/v0/page/{pageId}/subjects', csrf: true,
			pathArguments: { pageId: 'pageId' }, body: ['schema','statements'] }] })),
	{ name: 'sws-sparql-query', inputSchema: graph, annotations: { readOnlyHint: true },
		calls: [{ transport: 'rest', method: 'POST', path: '/uai/v0/query/sparql', body: ['query'] }] },
] };
const proof = 'a'.repeat(32) + '.' + 'b'.repeat(64);
let phase = 'pending';
let wikiReviews = false;
const reviews = new Map();
process.on('message', ({ phase: next }) => {
	if (next === 'wiki-reviews') wikiReviews = true;
	else if (next === 'approve-order') {
		for (const review of reviews.values()) if (review.status === 'pending') review.status = 'approved';
	} else if (next === 'stop-order') {
		const review = [...reviews.values()].at(-1);
		if (review) review.status = 'stopped';
	} else phase = next;
	process.send({ acknowledged: next });
});

globalThis.fetch = async (target, options) => {
	const url = new URL(target);
	const headers = new Headers(options.headers);
	const connected = headers.get('X-UAI-Connection') === proof;
	const operation = new URLSearchParams(String(options.body)).get('operation');
	process.send({ path: url.pathname, operation, connected, csrf: headers.has('X-CSRF-TOKEN') });
	if (headers.get('Authorization') !== 'Bearer fixture-only') return Response.json({ error: { code: 'readapidenied' } });
	let data;
	switch (operation) {
		case 'connection-request':
			phase = 'pending';
			data = { connectionProof: proof, approvalUrl: 'https://test.wiki/wiki/Special:UserAIConnection/' + 'a'.repeat(32),
				expiresAt: Math.floor(Date.now()/1000) + 60, code: 'aaaaaaaa' }; break;
		case 'connection-claim': data = { status: connected ? phase : 'closed' }; break;
		default:
			if (!connected || phase !== 'active') {
				return url.pathname.includes('/rest.php/')
					? Response.json({ message: 'User AI connection approval required.' }, { status: 403 })
					: Response.json({ error: { code: 'userai-connection-required' } });
			}
			const params = new URLSearchParams(String(options.body));
			const page = { title: 'Vorlage:Beispiel', pageid: 42, ns: 10, revisions: [{ revid: 45, slots: { main: { content: 'Beispiel' } } }] };
			if (params.get('generator') === 'categorymembers' || params.get('titles') === page.title)
				return Response.json({ query: { pages: [page] } });
			if (operation === 'validate-subject') data = { violations: [] };
			if (operation === 'sws-get-page-subjects') data = { data: JSON.stringify({ mainSubjectId: 'E1' }) };
			if (operation === 'sws-get-subject') data = { data: JSON.stringify({ subjects: { E1: { id: 'E1', pageId: 42, pageTitle: 'Vorlage:Beispiel', schema: { id: 'S11' }, descriptions: {}, fieldKeyVersion: 1, statements: { FQ1: { propertyType: 'select', value: ['dewiki'] }, ...(wikiReviews ? { FK4: { propertyType: 'page', value: ['Kategorie:Testkategorie2'] } } : {}) } } } }) };
			if (url.pathname === '/w/rest.php/uai/v0/subject/E1' && options.method === 'PUT') return Response.json({ status: 'updated' });
			if (operation === 'schema') data = { schema: { id: 'S11', propertyDefinitions: { FQ1: { options: [{ label: 'Wikipedia (de)', id: 'dewiki' }] }, FK3: { type: 'page', labels: { de: 'Hauptkategorie' } }, FK4: { type: 'page', multiple: true } } } };
			if (params.get('meta') === 'userinfo') {
				return Response.json({ query: { userinfo: { id: 7, name: 'Sophos' } } });
			}
			if (params.get('meta') === 'siteinfo') return Response.json({ query: { extensions: [{ name: 'SchemaBaseBridge' }] } });
			if (params.get('action') === 'swsbasedataview') return Response.json({
				swsbasedataview: { version: 1, readOnly: true, page: { id: 42 }, subjects: [
					{ id: 'E1', fields: [{ name: 'FK3', effective: 'Beispiel' }, { name: 'FK4' }] },
				] },
			});
			if (url.pathname === '/w/rest.php/uai/v0/page/42/subjects' && headers.get('X-CSRF-TOKEN') === 'fixture-csrf') {
				return Response.json({ status: 'created', subjectId: 'E2' });
			}
			if (params.get('meta') === 'tokens') {
				return Response.json({ query: { tokens: { csrftoken: 'fixture-csrf' } } });
			}
			if (params.get('action') === 'edit' && params.get('createonly') === '1' && params.get('assertuser') === 'Sophos') {
				return Response.json({ edit: { result: 'Success', title: 'Test', newrevid: 43 } });
			}
			if (operation === 'catalog') data = { data: JSON.stringify(catalog) };
			if (operation === 'next-order-number') data = { number: ++orderNumber, user: 'Sophos' };
			if (operation === 'save-progress' && ['running', 'paused', 'decision', 'completed', 'stopped'].includes(params.get('status'))) data = { updatedAt: 123 };
			if (operation === 'context') data = { catalogVersion: 1, actorId: 7, progressEnabled: true, wikiOrderReview: wikiReviews };
			if (operation === 'order-review-create' && wikiReviews) {
				const id = params.get('id');
				data = {
					status: 'pending', approvalUrl: 'https://test.wiki/wiki/Special:UserAIOrderReview/' + id,
					expiresAt: Math.floor(Date.now() / 1000) + 60,
				};
				reviews.set(id, data);
			}
			if (['order-review-status', 'order-review-stop'].includes(operation) && wikiReviews) {
				data = reviews.get(params.get('id')) ?? { status: 'expired' };
				if (operation === 'order-review-stop' && data.status !== 'expired') data.status = 'stopped';
			}
			if (url.pathname === '/w/rest.php/uai/v0/query/sparql') return Response.json({ head: {}, boolean: true });
	}
	return Response.json({ userai: { version: 1, ...data } });
};

const { default: childProcess } = await import('node:child_process');
const { syncBuiltinESMExports } = await import('node:module');
childProcess.execFile = (file, args, options, callback) => {
	process.send({ browserOpened: true });
	queueMicrotask(() => callback(null, '', ''));
};
syncBuiltinESMExports();
