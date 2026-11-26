import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, validateReplacement } from '../src/template-order.mjs';
import { auftrag } from '../src/auftrag.mjs';
import { wikiAuftrag } from '../src/wiki-auftrag.mjs';

const item = { titel: 'Vorlage:Beispiel', beschreibung: 'Die Vorlage verlinkt einen Eintrag.' };
const page = { title: item.titel, pageId: 123, revision: { source: '[[Eintrag]]', revisionId: 45 } };
const statements = { FQ1: { value: ['dewiki'] }, FU1: { value: ['https://de.wikipedia.org/'] } };
const subject = { id: 'E1', fieldKeyVersion: 1, schema: { id: 'S11' }, pageId: 123, statements, descriptions: {} };
const read = async name => ({
	'get-page': page, 'get-category-members': { members: [page] },
	'sws-get-schema': { schema: { propertyDefinitions: { FQ1: { options: [{ label: 'Wikipedia (de)', id: 'dewiki' }] } } } },
	'sws-get-page-subjects': { mainSubjectId: 'E1' }, 'sws-get-subject': { subjects: { E1: subject } },
})[name];
test('Bindung an Auswahl, Quelle, Revision, Felder und Freigabe', async () => {
	const order = { targets: await prepare(read, [item]), status: 'freigegeben' };
	const args = { id: 'E1', statements, descriptions: { de: item.beschreibung }, baseRevisionId: 45, fieldKeyVersion: 1 };
	validateReplacement(order, args, page, subject);
	assert.throws(() => validateReplacement(order, { ...args, id: 'E3' }, page, subject));
	assert.throws(() => validateReplacement(order, { ...args, statements: { ...statements, FU1: { value: ['fremd'] } } }, page, subject));
	assert.throws(() => validateReplacement({ ...order, status: 'gestoppt' }, args, page, subject));
	assert.throws(() => validateReplacement(order, { ...args, baseRevisionId: 44 }, page, subject));
	await assert.rejects(prepare(read, [item,item,item]));
	await assert.rejects(prepare(async (name,args) => name === 'get-page' ? { ...page, pageId: 124 } : read(name,args), [item]));
});
test('Abschlussbericht bleibt bei Abbruch; Prüfung schont neuere Meldung', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'uai-review-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let banner, decision = { action: 'accept', content: { entscheidung: 'Freigeben' } };
	const services = { directory, read, allocate: async () => ({ number: 1, user: 'Sophos' }),
		ask: async () => decision, notify: async (task,status,summary,token) => { banner = { task,token }; },
		clearReport: async (task,token) => { if (banner.task === task && banner.token === token) banner = null; } };
	const { id } = await auftrag({ entwurf: 'Beispiel', vorlagen: [item] }, services);
	decision = { action: 'cancel' };
	const record = await auftrag({ id, aktion: 'abschliessen', bericht: 'Eine Seite geprüft.' }, services);
	assert.equal(record.status, 'abgeschlossen');
	assert.equal(banner.token, record.reportToken);
	banner = { task: record.name, token: 'neu' };
	decision = { action: 'accept', content: { geprueft: true } };
	assert.equal((await auftrag({ id, aktion: 'pruefen' }, services)).status, 'geprüft');
	assert.equal(banner.token, 'neu');
	assert.equal((await auftrag({ id }, services)).bericht, 'Eine Seite geprüft.');
});

test('Zehnerauftrag bindet genau die zehn vorgelegten Entitäten', async () => {
	const items = Array.from({ length: 10 }, (_, i) => ({ ...item, titel: 'Vorlage:Test' + (i + 1) }));
	const members = items.map((x, i) => ({ title: x.titel, pageId: i + 1 }));
	const targets = await prepare(async (name, args) => {
		if (name === 'get-category-members') return { members };
		if (name === 'get-page') return { ...page, ...members.find(m => m.title === args.title) };
		if (name === 'sws-get-page-subjects') return { mainSubjectId: 'E' + args.pageId };
		if (name === 'sws-get-subject') return { subjects: { [args.id]: { ...subject, id: args.id, pageId: Number(args.id.slice(1)) } } };
		return read(name, args);
	}, items);
	assert.deepEqual(targets.map(t => t.id), members.map(m => 'E' + m.pageId));
	assert.throws(() => validateReplacement({ targets, status: 'freigegeben' }, { id: 'E11' }, page, subject));
});

test('Vorlagensuche beginnt erst nach Banner und Freigabe; Fehlende Entität pausiert denselben Auftrag', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'uai-ablauf-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const events = [];
	const services = {
		directory, allocate: async () => ({ number: 7, user: 'Sophos' }),
		notify: async (name, status, summary) => events.push([status, name, summary]),
		ask: async form => {
			assert.match(form.message, /Zwei Vorlagen prüfen/);
			assert.doesNotMatch(form.message, /Wikipedia|S11|Acht-Wort/);
			events.push(['dialog']);
			return { action: 'accept', content: { entscheidung: 'Freigeben' } };
		},
		read: async (name, args) => {
			events.push(['read']);
			if (name === 'sws-get-subject') return { subjects: {} };
			return read(name, args);
		},
	};
	const record = await auftrag({ entwurf: 'Zwei Vorlagen prüfen', vorlagenauftrag: true }, services);
	assert.deepEqual(events.map(e => e[0]), ['decision', 'dialog', 'running']);
	await assert.rejects(auftrag({ id: record.id, vorlagen: [item] }, services), /nicht geeignet/);
	assert.deepEqual(events.at(-1), ['paused', record.name, 'Entität nicht geeignet: Vorlage:Beispiel']);
	assert.equal((await auftrag({ id: record.id }, services)).status, 'unterbrochen');
	events.length = 0;
	services.ask = async () => ({ action: 'accept', content: { entscheidung: 'Freigeben', korrektur: 'Nur eine Vorlage' } });
	const stopped = await auftrag({ entwurf: 'Neuer Entwurf', vorlagen: [item] }, services);
	assert.deepEqual(events.map(e => e[0]), ['decision', 'stopped']);
	assert.equal(stopped.korrektur, 'Nur eine Vorlage');
});

test('Wiki-Freigaben speichern lange Entwürfe, prüfen Felder separat und schließen Berichte', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'uai-wiki-review-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const decisions = new Map();
	const reportClears = [];
	const services = {
		directory, read, notify: async () => {},
		allocate: async () => ({ number: 8, user: 'Sophos' }),
		clearReport: async (...args) => { reportClears.push(args); return true; },
		review: {
			create: async (id, task, phase, text) => {
				const state = { status: 'pending', approvalUrl: 'https://wiki.test/review/' + id, expiresAt: 123, task, phase, text };
				assert.ok(!decisions.has(id));
				decisions.set(id, state);
				return state;
			},
			status: async id => { assert.ok(decisions.has(id)); return decisions.get(id); },
		},
	};
	const draft = 'Vollständiger Auftrag mit langem Text.\n'.repeat(100).trim();
	const first = await wikiAuftrag({ entwurf: draft, vorlagenauftrag: true }, services);
	assert.equal(first.status, 'ausstehend');
	assert.ok(decisions.get(first.review.id).text.startsWith(draft));
	assert.equal((await wikiAuftrag({ id: first.id, waitSeconds: 0 }, services)).review.approvalUrl, first.review.approvalUrl);
	await assert.rejects(wikiAuftrag({ id: first.id, vorlagen: [item] }, services), /Offene Entscheidung/);
	decisions.get(first.review.id).status = 'approved';
	assert.equal((await wikiAuftrag({ id: first.id, waitSeconds: 100 }, services)).status, 'freigegeben');
	const fields = await wikiAuftrag({ id: first.id, vorlagen: [item] }, services);
	assert.equal(fields.status, 'feldfreigabe-ausstehend');
	assert.equal(fields.targets, undefined);
	assert.match(decisions.get(fields.review.id).text, /Vorlage:Beispiel \(E1, Revision 45\)/);
	decisions.get(fields.review.id).status = 'approved';
	assert.equal((await wikiAuftrag({ id: first.id }, services)).targets[0].id, 'E1');
	const report = await wikiAuftrag({ id: first.id, aktion: 'abschliessen', bericht: 'Geprüft.' }, services);
	decisions.get(report.review.id).status = 'stopped';
	assert.equal((await wikiAuftrag({ id: first.id }, services)).status, 'abgeschlossen');
	assert.equal(reportClears.length, 0);
	const retry = await wikiAuftrag({ id: first.id, aktion: 'pruefen' }, services);
	decisions.get(retry.review.id).status = 'approved';
	assert.equal((await wikiAuftrag({ id: first.id }, services)).status, 'geprüft');
	assert.deepEqual(reportClears, [[first.name, report.reportToken, 'Geprüft.']]);

	const next = await wikiAuftrag({ entwurf: 'Neuer Entwurf' }, services);
	Object.assign(decisions.get(next.review.id), { status: 'stopped', feedback: 'Bitte nur lesen.' });
	const stopped = await wikiAuftrag({ id: next.id }, services);
	assert.equal(stopped.status, 'gestoppt');
	assert.equal(stopped.korrektur, 'Bitte nur lesen.');
});
