import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { idPattern, prepare, selectionSchema, withOrder } from './template-order.mjs';
import { entityFieldChangeSchema, entityFieldReviewText } from './entity-field-order.mjs';
import { changeReviewText, orderChangesSchema } from './order-changes.mjs';
export const draftText = record => record.entwurf +
	(record.feldAenderung ? '\n\n' + entityFieldReviewText(record.feldAenderung) : '');
export const fieldReviewText = (record, targets) => record.entwurf + '\n\n' + targets.map(t =>
	t.werkzeug ? changeReviewText(t) :
		[t.titel + ' (' + t.id + ', Revision ' + t.revision + ')', t.beschreibung, t.kurzbeschreibung, t.klasse]
			.filter(Boolean).join('\n')).join('\n\n');
export function bannerText(text) {
	let result = '';
	for (const ch of text) {
		if (Buffer.byteLength(result + ch) > 477) return result + '…';
		result += ch;
	}
	return result;
}
export const schema = {
	type: 'object', additionalProperties: false,
	properties: {
		aenderungen: orderChangesSchema,
		vorlagen: selectionSchema,
		feldAenderung: entityFieldChangeSchema,
		vorlagenauftrag: { type: 'boolean', description: 'Kompatibilität für bisherige Vorlagenaufrufe. Neue Aufträge verwenden aenderungen.' },
		aktion: { type: "string", enum: ["anhalten","abschliessen","pruefen"] },
		bericht: { type: "string", minLength: 1, maxLength: 480 },
		entwurf: { type: 'string', minLength: 1, maxLength: 6000, description: 'Vollständiger Auftrag einschließlich Umfang, Werkzeugen und Ergebnis.' },
		id: { type: 'string', pattern: idPattern, description: 'Status eines bestehenden Auftrags abrufen.' },
		waitSeconds: { type: 'integer', minimum: 0, maximum: 300, description: 'Mit id auf die Entscheidung im Wiki warten. Beim Vorlegen weglassen.' },
	},
};

export async function auftrag(args, { directory, allocate, notify, ask, read, clearReport }) {
	if (!directory) throw new Error('Der Auftragsspeicher ist nicht eingerichtet.');
	if (Object.hasOwn(args, 'id')) {
		if (args.vorlagenauftrag !== undefined || Object.hasOwn(args, 'entwurf') || !new RegExp(idPattern).test(args.id)) throw new Error('Zum Abruf nur die Auftrags-ID angeben.');
		if (args.vorlagen) {
			if (args.aktion || args.bericht) throw new Error('Auswahl separat vorlegen.');
			return withOrder(directory, args.id, async (record, save) => {
				if (record.status !== 'freigegeben' || !record.vorlagenauftrag || record.targets)
					throw new Error('Kein offener Vorlagenauftrag für diese Auswahl.');
				try {
					const targets = await prepare(read, args.vorlagen);
					await notify(record.name, 'decision', bannerText('Vorlagenauswahl prüfen: ' + record.entwurf));
					const answer = await ask({
						mode: 'form', message: record.name + '\n\n' + fieldReviewText(record, targets),
						requestedSchema: decisionSchema,
					});
					if (answer?.content?.korrektur?.trim()) record.korrektur = answer.content.korrektur.trim();
					if (accepted(answer)) record.targets = targets;
					else record.status = 'gestoppt';
					await save();
					await notify(record.name, accepted(answer) ? 'running' : 'stopped', bannerText(record.korrektur || record.entwurf));
				} catch (error) {
					record.status = 'unterbrochen';
					record.grund = error.message;
					await save();
					await notify(record.name, 'paused', bannerText(error.message));
					throw error;
				}
				return record;
			});
		}
		if (!args.aktion) return JSON.parse(await readFile(join(directory, args.id + '.json'), 'utf8'));
		return withOrder(directory, args.id, async (record, save) => {
			const review = async () => {
				const answer = await ask({ mode: 'form', message: record.name + '\n\n' + record.bericht,
					requestedSchema: { type: 'object', properties: { geprueft: { type: 'boolean', title: 'Abwicklung geprüft, Abschlussmeldung schließen' } }, required: ['geprueft'] } });
				if (answer.action === 'accept' && answer.content?.geprueft === true) {
					record.bannerGeloescht = await clearReport(record.name, record.reportToken, record.bericht);
					record.status = 'geprüft';
					await save();
				}
			};
			if (args.aktion === 'anhalten') {
				if (record.status !== 'freigegeben') throw new Error('Nur laufende Aufträge können angehalten werden.');
				record.status = 'gestoppt';
				await save();
				await notify(record.name, 'stopped', 'Auftrag angehalten.');
			} else if (args.aktion === 'abschliessen') {
				if (record.status !== 'freigegeben' || !args.bericht?.trim() || Buffer.byteLength(args.bericht) > 480)
					throw new Error('Zum Abschluss einen kurzen Bericht für einen freigegebenen Auftrag angeben.');
				record.status = 'abgeschlossen';
				record.bericht = args.bericht.trim();
				record.reportToken = randomUUID();
				await save();
				await notify(record.name, 'completed', record.bericht, record.reportToken);
				await review();
			} else if (record.status === 'abgeschlossen') {
				await review();
			} else throw new Error('Der Auftrag hat keinen offenen Abschlussbericht.');
			return record;
		});
	}
	if (args.aktion || args.bericht) throw new Error("Auftrags-ID fehlt.");
	const entwurf = args.entwurf?.trim();
	if (!entwurf) throw new Error('Der Auftragsentwurf fehlt.');
	const vorlagenauftrag = Boolean(args.vorlagenauftrag || args.vorlagen);
	const { number, user } = await allocate();
	const name = user + " · Auftrag " + number;
	const record = { id: randomUUID(), name, entwurf, vorlagenauftrag, status: 'ausstehend' };
	const path = join(directory, record.id + '.json');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
	const finish = async status => {
		record.status = status;
		const temp = path + '.tmp';
		await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
		await rename(temp, path);
	};
	try {
		await notify(name, 'decision', bannerText(entwurf));
		const response = await ask({
			mode: 'form', message: name + '\n\n' + draftText(record),
			requestedSchema: decisionSchema,
		});
		if (response?.content?.korrektur?.trim()) record.korrektur = response.content.korrektur.trim();
		await finish(accepted(response) ? 'freigegeben' : 'gestoppt');
	} catch (error) {
		await finish('unterbrochen');
		await notify(name, 'paused', 'Auftragsprüfung unterbrochen. Details in der App.').catch(() => {});
		throw Object.assign(new Error(name + ' unterbrochen: ' + error.message, { cause: error }), { orderId: record.id });
	}
	try {
		await notify(name, record.status === 'freigegeben' ? 'running' : 'stopped', bannerText(record.korrektur || entwurf));
	} catch (error) {
		throw Object.assign(new Error(name + ': Banner konnte nicht aktualisiert werden.', { cause: error }), { orderId: record.id });
	}
	if (args.vorlagen && record.status === 'freigegeben')
		return auftrag({ id: record.id, vorlagen: args.vorlagen }, { directory, allocate, notify, ask, read, clearReport });
	return record;
}
const decisionSchema = { type: 'object', properties: {
	entscheidung: { type: 'string', title: 'Deine Entscheidung', enum: ['Freigeben', 'Stoppen'] },
	korrektur: { type: 'string', title: 'Änderungswunsch (stoppt diesen Entwurf)' },
}, required: ['entscheidung'] };
function accepted(response) {
	return response?.action === 'accept' && response.content?.entscheidung === 'Freigeben' && !response.content?.korrektur?.trim();
}
