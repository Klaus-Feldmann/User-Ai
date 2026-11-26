import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedChange, changeReviewText, checkEntityChange, prepareChanges } from '../src/order-changes.mjs';

test('general approvals accept ordered batches across schemas without category, source or length presets', async () => {
	const current = [
		...Array.from({ length: 10 }, (_, index) => ({
			id: 'E' + (index + 1), pageId: index + 10, pageTitle: 'Vorlage:Test ' + index,
			fieldKeyVersion: 3, schema: { id: 'S11' }, label: '', descriptions: { de: 'Schon beschrieben.' },
			statements: { FQ1: { propertyType: 'select', value: ['WikipediaOption'] } },
		})),
		{ id: 'E12', pageId: 31, fieldKeyVersion: 0, pageTitle: 'Forschung', schema: { id: 'S42' },
			statements: { Thema: { propertyType: 'text', value: ['Logik'] } } },
	];
	const schemaProperties = {
		S11: {
			FK2: { type: 'text' }, FK3: { type: 'page', labels: { de: 'Hauptkategorie' } },
		},
		S42: { Thema: { type: 'text' } },
	};
	const read = async (tool, args) => {
		switch (tool) {
			case 'sws-get-subject': return { subjects: { [args.id]: current.find(subject => subject.id === args.id) } };
			case 'get-page': return { pageId: current.find(subject => subject.pageTitle === args.title).pageId,
				title: args.title, revision: { revisionId: 45 } };
			case 'sws-get-schema': return { schema: { propertyDefinitions: schemaProperties[args.name] } };
			case 'sws-validate-subject': return { violations: [] };
			default: assert.fail('Unexpected tool: ' + tool);
		}
	};
	const edits = current.map(subject => ({
		werkzeug: 'sws-update-subject',
		argumente: {
			id: subject.id, fieldKeyVersion: subject.fieldKeyVersion, baseRevisionId: 45,
			descriptions: { de: 'Aktuelle Beschreibung.' },
			statements: subject.schema.id === 'S11' ? {
				...subject.statements,
				FK2: { propertyType: 'text', value: ['Hier steht eine nun kurze Beschreibung'] },
				FK3: { propertyType: 'page', value: ['Kategorie:Wikipedia:WikiProjekt Vorlagen'] },
			} : { Thema: { propertyType: 'text', value: ['Sprachlogik'] } },
		},
	}));
	const validate = async (_name, args) => args;
	const ten = await prepareChanges(read, validate, edits.slice(0, 10));
	const [research] = await prepareChanges(read, validate, edits.slice(10));
	assert.equal(ten.length, 10);
	assert.equal(research.schema, 'S42');
	assert.match(changeReviewText(ten[0]), /Hauptkategorie.*|Wikipedia:WikiProjekt Vorlagen/);
	assert.match(changeReviewText(ten[0]), /Schon beschrieben/);
	const record = { status: 'freigegeben', aenderungsfreigabe: ten };
	assert.equal(approvedChange(record, ...Object.values(edits[0])), ten[0]);
	assert.throws(() => approvedChange(record, 'sws-update-subject', edits[10].argumente), /weicht/);
	assert.throws(() => approvedChange({ ...record, status: 'gestoppt' }, ...Object.values(edits[0])), /nicht zur Bearbeitung/);
	assert.throws(() => checkEntityChange(ten[0], { title: current[0].pageTitle, pageId: 10,
		revision: { revisionId: 46 } }, current[0]), /geändert/);
});
