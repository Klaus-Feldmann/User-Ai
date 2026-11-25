import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Pass the built MediaWiki MCP Beta.1 source checkout.');
const { z } = createRequire(resolve(source, 'package.json'))('zod');
const extension = JSON.parse(await readFile(new URL('../extension.json', import.meta.url)));
const swsTools = resolve(source, 'dist/tools/extensions/sws');
const upstream = new Map();
for (const file of await readdir(swsTools)) {
	if (!/^sws-.*\.js$/.test(file)) continue;
	const module = await import(pathToFileURL(resolve(swsTools, file)));
	for (const item of Object.values(module)) if (item?.name && item?.inputSchema) upstream.set(item.name, item);
}
const helpTopics = ['overview', 'sws', 'query', 'editing', 'authentication', 'backends'];
upstream.set('get-agent-context', {
	inputSchema: {}, description: 'Read this authenticated assistant context and wiki profile.',
	annotations: { readOnlyHint: true },
});
upstream.set('get-skill-topic', {
	inputSchema: { topic: z.enum(helpTopics) }, annotations: { readOnlyHint: true },
});
const action = (operation, properties = {}) => ({ transport: 'action', operation, ...properties });
const rest = (operation, properties = {}) => {
	const route = extension.RestRoutes.find((item) => item.args[0] === operation);
	if (!route) throw new Error('No route for ' + operation);
	return { transport: 'rest', operation, method: route.method[0], path: route.path, csrf: false, ...properties };
};
const common = ['label', 'identityLanguage', 'labels', 'descriptions', 'statements', 'fieldNotes', 'dependentSubjects', 'comment'];
const create = { pathArguments: { pageId: 'pageId' }, csrf: true, body: ['id', 'schema', ...common], prepare: ['resolve-page-id', 'initialize-identity'] };
const tools = [
	['get-agent-context', false, [action('context')]],
	['get-skill-topic', false, [action('help', { parameters: { topic: 'topic' } })]],
	['sws-get-subject', true, [
		rest('subject-rest', { when: { argument: 'latest', equals: true }, pathArguments: { subjectId: 'id' }, queryValues: { latest: '1', expand: 'page' } }),
		action('subject', { parameters: { id: 'id' }, response: 'json-data' }),
	]],
	['sws-get-page-subjects', true, [action('page-subjects', { prepare: ['resolve-page-id'], parameters: { pageid: 'pageId' }, response: 'json-data' })]],
	['sws-list-schemas', true, [action('schemas', { parameters: { cursor: 'continueFrom' }, response: 'json-data' })]],
	['sws-get-schema', true, [action('schema', { parameters: { name: 'name' }, response: 'json-data' })]],
	['sws-query-entities', true, [action('query-entities', {
		jsonParameter: 'entityquery', parameters: { schema: 'schema', filters: 'filters', fields: 'fields', limit: 'limit', cursor: 'continueFrom', descriptionContains: 'descriptionContains' },
		defaults: { filters: [], fields: [], limit: 10, cursor: '', descriptionContains: '' }, response: 'json-data',
	})]],
	['sws-get-query-capabilities', true, [action('backend-capabilities')]],
	['sws-search-subjects', true, [rest('search-subjects', { query: { search: 'search', schema: 'schema' }, queryValues: { limit: '50' } })]],
	['sws-create-subject', true, [
		rest('create-main-subject', { when: { argument: 'isMain', equals: true }, ...create }),
		rest('create-subject', create),
	]],
	['sws-update-subject', true, [rest('update-subject', {
		pathArguments: { subjectId: 'id' }, body: ['baseRevisionId', 'fieldKeyVersion', ...common],
		prepare: ['merge-current-identity'], csrf: true,
	})]],
	['sws-delete-subject', true, [rest('delete-subject', { pathArguments: { subjectId: 'id' }, body: ['comment'], csrf: true })]],
	['sws-set-main-subject', true, [rest('set-main-subject', { prepare: ['resolve-page-id'], pathArguments: { pageId: 'pageId' }, body: ['subjectId', 'comment'], csrf: true })]],
	['sws-mint-subject-ids', true, [rest('mint-subject-ids', { body: ['count'], csrf: true })]],
	['sws-validate-subject', true, [
		rest('validate-subject-update', { when: { argument: 'id', present: true }, pathArguments: { subjectId: 'id' }, body: ['statements'] }),
		rest('validate-subject', { require: ['schema'], body: ['schema', 'statements'] }),
	]],
	['sws-sparql-query', true, [rest('sparql-query', { body: ['query'], backend: 'sparql' })]],
	['sws-cypher-query', true, [rest('cypher-query', { body: ['cypher', 'parameters'], backend: 'cypher' })]],
	['sws-get-processing-status', true, [{ transport: 'wiki-action', action: 'swsprocessingstatus',
		parameters: { title: 'title', pageid: 'pageId', entity: 'entity', language: 'language', field: 'field' }, responseKey: 'swsprocessingstatus' }]],
];
const out = {
	version: 1,
	inputDialect: 'https://json-schema.org/draft/2020-12/schema',
	actionModule: 'userai',
	authentication: 'assigned-mediawiki-account',
	profile: { templateOperation: 'profile-template', titleSuffix: '/profil', provision: 'mediawiki-createonly' },
	tools: tools.map(([name, requiresSws, calls]) => {
		const item = upstream.get(name);
		if (!item) throw new Error('Missing tool ' + name);
		const fields = { ...item.inputSchema };
		if (name === 'get-skill-topic') delete fields.fromWiki;
		if (name === 'sws-get-query-capabilities') delete fields.refresh;
		const inputSchema = z.toJSONSchema(z.strictObject(fields), { io: 'input', unrepresentable: 'any' });
		let description = item.description;
		if (name === 'get-skill-topic') description = 'Read the authenticated, wiki-managed User AI help topic.';
		if (name === 'sws-get-query-capabilities') description = 'Read the SWS SPARQL and Cypher configuration, without running a graph query.';
		if (['sws-get-page-subjects', 'sws-create-subject', 'sws-set-main-subject'].includes(name)) {
			inputSchema.oneOf = [{ required: ['title'] }, { required: ['pageId'] }];
		}
		if (name === 'sws-get-processing-status') {
			inputSchema.oneOf = [{ required: ['title'] }, { required: ['pageId'] }, { required: ['entity'] }];
		}
		if (name === 'sws-validate-subject') inputSchema.anyOf = [{ required: ['id'] }, { required: ['schema'] }];
		return { name, description, annotations: item.annotations, requiresSws, inputSchema, calls };
	}),
};
await writeFile(new URL('../catalog/v1.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
