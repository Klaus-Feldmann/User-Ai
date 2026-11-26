import { isDeepStrictEqual } from 'node:util';

export const orderChangesSchema = {
	type: 'array', minItems: 1, maxItems: 100,
	items: {
		type: 'object', additionalProperties: false, required: ['werkzeug', 'argumente'],
		properties: {
			werkzeug: { type: 'string', minLength: 1, maxLength: 120 },
			argumente: { type: 'object', additionalProperties: true },
		},
	},
};

function fieldDiff(before, after) {
	return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter(key => !isDeepStrictEqual(before[key], after[key]))
		.map(key => [key, { bisher: before[key] ?? null, vorgesehen: after[key] ?? null }]));
}

export async function prepareChanges(read, validateWrite, changes) {
	const plans = [];
	for (const { werkzeug, argumente } of changes) {
		const args = await validateWrite(werkzeug, argumente);
		if (plans.some(plan => plan.werkzeug === werkzeug && (isDeepStrictEqual(plan.argumente, args) ||
			(werkzeug === 'sws-update-subject' && plan.argumente.id === args.id)))) {
			throw new Error('Denselben Schreibvorgang oder dieselbe Entität nur einmal pro Freigabe vorlegen.');
		}
		if (werkzeug !== 'sws-update-subject') {
			plans.push({ werkzeug, argumente: args });
			continue;
		}
		const { subjects } = await read('sws-get-subject', { id: args.id, latest: true });
		const current = subjects[args.id];
		if (!current) throw new Error('Entität nicht gefunden: ' + args.id);
		const page = await read('get-page', { title: current.pageTitle });
		const plan = { werkzeug, argumente: args, titel: page.title, pageId: page.pageId, schema: current.schema.id };
		checkEntityChange(plan, page, current);
		const { schema } = await read('sws-get-schema', { name: plan.schema });
		const fields = fieldDiff(current.statements, args.statements);
		for (const [key, entry] of Object.entries(fields)) {
			const field = Object.hasOwn(schema.propertyDefinitions, key) ? schema.propertyDefinitions[key] : undefined;
			if (entry.vorgesehen && field?.type !== entry.vorgesehen.propertyType)
				throw new Error('Feld fehlt im Schema oder hat einen anderen Typ: ' + key);
			entry.bezeichnung = field?.labels?.de ?? key;
		}
		const validation = await read('sws-validate-subject', { id: args.id, statements: args.statements });
		const errors = validation.violations.filter(issue => issue.severity === 'error');
		if (errors.length) throw new Error(args.id + ': ' + JSON.stringify(errors));
		plan.diff = {
			Felder: fields,
			Beschreibungen: fieldDiff(current.descriptions ?? {}, args.descriptions ?? current.descriptions ?? {}),
			Identität: fieldDiff(
				{ Bezeichnung: current.label ?? '', Sprachen: current.labels ?? {}, Standardsprache: current.identityLanguage },
				{ Bezeichnung: args.label ?? '', Sprachen: args.labels ?? current.labels ?? {},
					Standardsprache: args.identityLanguage ?? current.identityLanguage }),
		};
		if (args.fieldNotes !== undefined) plan.diff.Feldanmerkungen = args.fieldNotes;
		if (args.dependentSubjects !== undefined) plan.diff['Abhängige Entitäten'] = args.dependentSubjects;
		if (args.comment) plan.diff.Bearbeitungskommentar = args.comment;
		plans.push(plan);
	}
	return plans;
}

export function checkEntityChange(plan, page, current) {
	const { argumente: args } = plan;
	if (!current || current.id !== args.id || current.pageId !== plan.pageId ||
		page.pageId !== plan.pageId || page.title !== plan.titel || current.schema.id !== plan.schema)
		throw new Error('Seite, Entität oder Schema weicht von der Feldfreigabe ab.');
	if (args.baseRevisionId !== page.revision.revisionId || args.fieldKeyVersion !== current.fieldKeyVersion)
		throw new Error('Seitenrevision oder Feldstand hat sich geändert: ' + plan.titel);
}

export function changeReviewText(plan) {
	const title = plan.titel
		? plan.titel + ' · ' + plan.argumente.id + ' · ' + plan.schema + ' · Revision ' + plan.argumente.baseRevisionId
		: plan.werkzeug;
	return title + '\n' + JSON.stringify(plan.diff ?? plan.argumente, null, 2);
}

export function approvedChange(record, name, args) {
	if (record.status !== 'freigegeben') throw new Error('Auftrag ist nicht zur Bearbeitung freigegeben.');
	const plan = record.aenderungsfreigabe?.find(entry =>
		entry.werkzeug === name && isDeepStrictEqual(entry.argumente, args));
	if (!plan) throw new Error('Schreibvorgang weicht von der konkreten Auftragsfreigabe ab.');
	if (plan.ausfuehrung) throw new Error('Dieser Schreibvorgang wurde bereits begonnen. Ergebnis zuerst prüfen.');
	return plan;
}
