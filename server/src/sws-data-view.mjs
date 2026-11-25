export async function discoverDataView(action) {
	const site = await action({ action: 'query', meta: 'siteinfo', siprop: 'extensions' });
	const installed = site.query?.extensions?.some(({ name }) => ['SchemaBaseBridge', 'SWSBaseBridge'].includes(name));
	if (!installed) return [];

	return [{
		name: 'swsbase-get-data-view',
		description: 'Read own, external and effective values of SWS page entities through SchemaBaseBridge. Use the exact field keys to narrow the response.',
		provider: 'mediawiki',
		annotations: { readOnlyHint: true, idempotentHint: true },
		inputSchema: {
			type: 'object', additionalProperties: false,
			oneOf: [{ required: ['title'] }, { required: ['pageId'] }],
			properties: {
				title: { type: 'string', minLength: 1, pattern: '^[^|]+$' },
				pageId: { type: 'integer', minimum: 1 },
				subject: { type: 'string', minLength: 1 },
				language: { type: 'string', pattern: '^[a-z]{2,12}(?:-[a-z0-9]{1,12})*$' },
				fields: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
			},
		},
		invoke: async ({ title, pageId, subject, language, fields }) => {
			if (pageId === undefined) {
				const page = (await action({ action: 'query', titles: title })).query?.pages?.[0];
				if (!Number.isSafeInteger(page?.pageid) || page.pageid < 1 || page.missing) {
					throw Object.assign(new Error('Wiki page not found.'), { status: 404 });
				}
				pageId = page.pageid;
			}
			const response = await action({
				action: 'swsbasedataview', pageid: pageId,
				...(subject !== undefined ? { subject } : {}),
				...(language !== undefined ? { language } : {}),
			});
			const view = response.swsbasedataview;
			if (view?.version !== 1 || view?.readOnly !== true || view?.page?.id !== pageId ||
				!Array.isArray(view?.subjects) ||
				view.subjects.some((entry) => typeof entry.id !== 'string' || !Array.isArray(entry.fields)) ||
				(subject !== undefined && (view.subjects.length !== 1 || view.subjects[0].id !== subject))) {
				throw new Error('Unconfirmed SWS data view response.');
			}
			let subjects = view.subjects;
			if (fields !== undefined) {
				const selected = new Set(fields);
				const available = new Set(subjects.flatMap((entry) => entry.fields.map(({ name }) => name)));
				if (fields.some((name) => !available.has(name))) {
					throw Object.assign(new Error('Unknown field key in the data view.'), { status: 400 });
				}
				subjects = subjects.map((entry) => ({ ...entry, fields: entry.fields.filter(({ name }) => selected.has(name)) }));
			}
			return { ...view, subjects, selection: { subject: subject ?? null, fields: fields ?? null } };
		},
	}];
}
