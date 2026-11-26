import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const idPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const selectionSchema = {
	type: 'array', minItems: 1,
	items: { type: 'object', additionalProperties: false, required: ['titel', 'beschreibung'],
		properties: {
			titel: { type: 'string', minLength: 1, maxLength: 255 },
			beschreibung: { type: 'string', minLength: 1, maxLength: 2000 },
			kurzbeschreibung: { type: 'string', minLength: 1, maxLength: 240 },
			klasse: { type: 'string', minLength: 1, maxLength: 120 },
		} },
};

export async function prepare(read, selection) {
	if (!selection.length || new Set(selection.map(x => x.titel)).size !== selection.length)
		throw new Error('Mindestens eine Vorlage angeben. Jeder Titel darf nur einmal vorkommen.');
	const targets = [];
	for (const item of selection) {
		const page = await read('get-page', { title: item.titel });
		if (page.title !== item.titel) throw new Error('Seitenidentität stimmt nicht: ' + item.titel);
		const { mainSubjectId: id } = await read('sws-get-page-subjects', { pageId: page.pageId });
		const subject = (await read('sws-get-subject', { id, latest: true })).subjects[id];
		if (!subject || subject.pageId !== page.pageId) throw new Error('Entität nicht geeignet: ' + item.titel);
		const schema = (await read('sws-get-schema', { name: subject.schema.id })).schema.propertyDefinitions;
		const classId = item.klasse && schema.FK1?.options?.find(x => x.label === item.klasse)?.id;
		if (item.klasse && !classId) throw new Error('Klasse fehlt im Schema.');
		if (item.kurzbeschreibung !== undefined && schema.FK2?.type !== 'text')
			throw new Error('Kurzbeschreibung fehlt im Schema. Beliebige Felder mit aenderungen vorlegen.');
		targets.push({ ...item, id, schema: subject.schema.id, pageId: page.pageId, revision: page.revision.revisionId, classId });
	}
	return targets;
}

export function validateReplacement(record, args, page, current) {
	if (record.status !== 'freigegeben') throw new Error('Auftrag ist nicht zur Bearbeitung freigegeben.');
	const target = record.targets?.find(x => x.id === args.id);
	if (!target || current.id !== target.id || current.pageId !== target.pageId || page.pageId !== target.pageId ||
		page.title !== target.titel || (target.schema
			? current.schema.id !== target.schema
			: current.schema.id !== 'S11' || current.descriptions?.de ||
				!isDeepStrictEqual(current.statements.FQ1?.value, [target.source]))) throw new Error('Ziel außerhalb des Auftrags.');
	if (target.revision !== page.revision.revisionId || args.baseRevisionId !== target.revision)
		throw new Error('Die vorgelegte Revision hat sich geändert.');
	const statements = structuredClone(current.statements);
	if (target.kurzbeschreibung) statements.FK2 = { propertyType: 'text', value: [target.kurzbeschreibung] };
	if (target.classId) statements.FK1 = { propertyType: 'select', value: [target.classId] };
	if (!isDeepStrictEqual(args.statements, statements) || !isDeepStrictEqual(args.descriptions, { ...current.descriptions, de: target.beschreibung }) ||
		args.dependentSubjects !== undefined || args.fieldNotes !== undefined ||
		(args.label || '') !== (current.label || '') || (args.labels && !isDeepStrictEqual(args.labels, current.labels)) ||
		(args.identityLanguage && args.identityLanguage !== current.identityLanguage) || args.fieldKeyVersion !== current.fieldKeyVersion)
		throw new Error('Änderungen außerhalb der freigegebenen Feldwerte.');
}

export async function withOrder(directory, id, action) {
	if (!new RegExp(idPattern).test(id)) throw new Error('Ungültige Auftrags-ID.');
	const path = join(directory, id + '.json');
	const lock = path + '.lock';
	try { await mkdir(lock, { mode: 0o700 }); } catch (e) {
		if (e.code === 'EEXIST') throw new Error('Auftrag ist gesperrt. Laufenden Vorgang prüfen.');
		throw e;
	}
	try {
		const record = JSON.parse(await readFile(path, 'utf8'));
		const save = async () => {
			const temp = path + '.' + randomUUID();
			await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
			await rename(temp, path);
		};
		return await action(record, save);
	} finally { await rmdir(lock); }
}
