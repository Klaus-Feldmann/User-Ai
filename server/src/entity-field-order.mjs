import { isDeepStrictEqual } from 'node:util';

export const entityFieldChangeSchema = {
	type: 'object', additionalProperties: false,
	required: ['id', 'titel', 'schema', 'feld', 'propertyType', 'operation', 'value'],
	properties: {
		id: { type: 'string', pattern: '^E[1-9][0-9]*$' },
		titel: { type: 'string', minLength: 1, maxLength: 255 },
		schema: { type: 'string', pattern: '^S[1-9][0-9]*$' },
		feld: { type: 'string', minLength: 1, maxLength: 255 },
		propertyType: { type: 'string', minLength: 1, maxLength: 64 },
		operation: { type: 'string', enum: ['setzen', 'hinzufuegen'] },
		value: {},
	},
};

export function entityFieldReviewText(change) {
	return [
		change.titel + ' · ' + change.id + ' · ' + change.schema,
		'Feld ' + change.feld + ' (' + change.propertyType + ') · ' + change.operation,
		JSON.stringify(change.value, null, 2),
	].join('\n');
}

export function validateEntityFieldReplacement(change, args, page, current, schema) {
	if (!current || args.id !== change.id || current.id !== change.id ||
		page.title !== change.titel || current.pageId !== page.pageId ||
		current.schema?.id !== change.schema || schema?.id !== change.schema) {
		throw new Error('Seite, Entität oder Schema weicht vom freigegebenen Auftrag ab.');
	}
	if (args.baseRevisionId !== page.revision.revisionId || args.fieldKeyVersion !== current.fieldKeyVersion)
		throw new Error('Seitenrevision oder Feldstand hat sich geändert.');
	const properties = schema.propertyDefinitions;
	const field = properties && Object.hasOwn(properties, change.feld) ? properties[change.feld] : undefined;
	if (field?.type !== change.propertyType)
		throw new Error('Das freigegebene Feld fehlt oder sein Typ wurde geändert.');
	const previous = current.statements[change.feld];
	if (previous && previous.propertyType !== change.propertyType)
		throw new Error('Der gespeicherte Feldtyp weicht vom aktuellen Schema ab.');
	let value = change.value;
	if (change.operation === 'hinzufuegen') {
		if (!field.multiple || !Array.isArray(value) || !value.length ||
			(previous && !Array.isArray(previous.value)))
			throw new Error('Hinzufügen benötigt ein Mehrfachfeld und eine Liste von Werten.');
		const combined = [...(previous?.value ?? [])];
		for (const item of value) {
			if (!combined.some(existing => isDeepStrictEqual(existing, item))) combined.push(item);
		}
		value = combined;
	}
	const statements = { ...current.statements, [change.feld]: { propertyType: change.propertyType, value } };
	if (!isDeepStrictEqual(args.statements, statements) || (args.label || '') !== (current.label || '') ||
		(args.labels !== undefined && !isDeepStrictEqual(args.labels, current.labels)) ||
		(args.descriptions !== undefined && !isDeepStrictEqual(args.descriptions, current.descriptions)) ||
		(args.identityLanguage !== undefined && args.identityLanguage !== current.identityLanguage) ||
		args.dependentSubjects !== undefined || args.fieldNotes !== undefined) {
		throw new Error('Änderungen außerhalb der freigegebenen Feldwerte.');
	}
	return isDeepStrictEqual(current.statements, statements);
}
