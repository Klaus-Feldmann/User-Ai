import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bannerText, draftText, fieldReviewText } from './auftrag.mjs';
import { prepareChanges } from './order-changes.mjs';
import { prepare, withOrder } from './template-order.mjs';

export async function wikiAuftrag(args, services) {
	const { directory, allocate, notify, read, clearReport, review, validateWrite } = services;
	if (!directory) throw new Error('Der Auftragsspeicher ist nicht eingerichtet.');
	if (!args.id) {
		const entwurf = args.entwurf?.trim();
		if (!entwurf || args.aktion || args.bericht || args.aenderungen || args.waitSeconds !== undefined)
			throw new Error('Vollständigen Auftragsentwurf vorlegen.');
		if (args.feldAenderung && (args.vorlagenauftrag || args.vorlagen || !Object.hasOwn(args.feldAenderung, 'value')))
			throw new Error('Einzelfeldauftrag mit Feldwert separat von einer Vorlagenanreicherung vorlegen.');
		const { number, user } = await allocate();
		const record = {
			id: randomUUID(), name: user + ' · Auftrag ' + number, entwurf,
			vorlagenauftrag: Boolean(args.vorlagenauftrag || args.vorlagen),
			allgemein: !args.vorlagenauftrag && !args.vorlagen && !args.feldAenderung,
			status: 'ausstehend',
			...(args.vorlagen ? { selection: args.vorlagen } : {}),
			...(args.feldAenderung ? { feldAenderung: args.feldAenderung } : {}),
			review: { id: randomUUID(), phase: 'draft' },
		};
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(join(directory, record.id + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
		try {
			return await wikiAuftrag({ id: record.id }, services);
		} catch (error) {
			throw Object.assign(error, { orderId: record.id });
		}
	}
	if (args.entwurf !== undefined || args.vorlagenauftrag !== undefined || args.feldAenderung !== undefined ||
		(args.waitSeconds !== undefined && (args.aktion || args.vorlagen || args.aenderungen || args.bericht)) ||
		(args.vorlagen && (args.aenderungen || args.aktion || args.bericht)) ||
		(args.aenderungen && (args.aktion || args.bericht)) ||
		(args.bericht && args.aktion !== 'abschliessen')) {
		throw new Error('Auftragsentscheidung separat abrufen.');
	}
	return withOrder(directory, args.id, async (record, save) => {
		const start = async (phase, status) => {
			record.review = { id: randomUUID(), phase };
			record.status = status;
			await save();
		};
		const fields = async (selection, allgemein = false) => {
			try {
				record.candidates = allgemein ? await prepareChanges(read, validateWrite, selection) : await prepare(read, selection);
			} catch (error) {
				record.status = 'unterbrochen';
				await save();
				await notify(record.name, 'paused', bannerText(error.message));
				throw error;
			}
			await start('fields', 'feldfreigabe-ausstehend');
		};

		if (record.review && ((args.aktion && args.aktion !== 'anhalten') || args.vorlagen || args.aenderungen))
			throw new Error('Offene Entscheidung im Wiki treffen und unter derselben ID abrufen.');
		if (args.aenderungen) {
			if (record.status !== 'freigegeben' || !record.allgemein)
				throw new Error('Kein offener Auftrag für diese Änderungsliste.');
			if (record.aenderungsfreigabe?.some(plan => plan.ausfuehrung !== 'ausgefuehrt'))
				throw new Error('Vorherige Änderungsliste zuerst vollständig abarbeiten.');
			await fields(args.aenderungen, true);
		} else if (args.vorlagen) {
			if (record.status !== 'freigegeben' || !record.vorlagenauftrag || record.targets)
				throw new Error('Kein offener Vorlagenauftrag für diese Auswahl.');
			await fields(args.vorlagen);
		} else if (args.aktion === 'anhalten') {
			if (!['ausstehend', 'freigegeben', 'feldfreigabe-ausstehend', 'unterbrochen'].includes(record.status))
				throw new Error('Der Auftrag kann in diesem Status nicht angehalten werden.');
			const approvalIds = [...(record.freigabeIds ?? []), ...(record.review?.approvalUrl ? [record.review.id] : [])];
			record.status = 'gestoppt';
			delete record.review;
			delete record.candidates;
			delete record.selection;
			await save();
			if (review.stop) for (const id of approvalIds) await review.stop(id);
			await notify(record.name, 'stopped', 'Auftrag angehalten.');
		} else if (args.aktion === 'abschliessen') {
			if (record.status !== 'freigegeben' || !args.bericht?.trim() || Buffer.byteLength(args.bericht) > 480)
				throw new Error('Zum Abschluss einen kurzen Bericht für einen freigegebenen Auftrag angeben.');
			record.bericht = args.bericht.trim();
			record.reportToken = randomUUID();
			await start('report', 'abgeschlossen');
			await notify(record.name, 'completed', record.bericht, record.reportToken);
		} else if (args.aktion === 'pruefen') {
			if (record.status !== 'abgeschlossen') throw new Error('Der Auftrag hat keinen offenen Abschlussbericht.');
			await start('report', 'abgeschlossen');
		}
		if (!record.review) return record;

		const publish = async () => {
			const phase = record.review.phase;
			const text = phase === 'draft' ? draftText(record) :
				phase === 'fields' ? fieldReviewText(record, record.candidates) : record.bericht;
			const reply = await review.create(record.review.id, record.name, phase, text);
			record.review.approvalUrl = reply.approvalUrl;
			record.review.expiresAt = reply.expiresAt;
			await save();
			return reply;
		};
		const answer = record.review.approvalUrl ? await review.status(record.review.id) : await publish();
		if (answer.status === 'pending') return record;
		const phase = record.review.phase;
		const approved = answer.status === 'approved' && !answer.feedback;
		if (phase === 'report') {
			if (approved) {
				record.bannerGeloescht = await clearReport(record.name, record.reportToken, record.bericht);
				record.status = 'geprüft';
			}
			delete record.review;
			await save();
			return record;
		}

		if (answer.feedback) record.korrektur = answer.feedback;
		if (approved && record.allgemein)
			(record.freigabeIds ??= []).push(record.review.id);
		if (approved && phase === 'fields') {
			if (record.allgemein) {
				if (record.aenderungsfreigabe)
					(record.bearbeiteteFreigaben ??= []).push(record.aenderungsfreigabe);
				record.aenderungsfreigabe = record.candidates;
			}
			else record.targets = record.candidates;
		}
		const selection = approved && phase === 'draft' ? record.selection : undefined;
		delete record.candidates;
		delete record.selection;
		delete record.review;
		record.status = approved ? 'freigegeben' : 'gestoppt';
		if (selection) await fields(selection);
		await save();
		await notify(record.name, approved ? 'running' : 'stopped',
			bannerText(record.korrektur || (answer.status === 'expired' ? 'Freigabe abgelaufen.' : record.entwurf)));
		if (record.review) await publish();
		return record;
	});
}
