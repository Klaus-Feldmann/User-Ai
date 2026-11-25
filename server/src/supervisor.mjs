import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserLoginRequiredError } from './oauth.mjs';

export function requestBrowserOpen(url) {
	return new Promise((resolve) => {
		execFile('/usr/bin/open', [url.href], { timeout: 5000 }, (error) => resolve(!error));
	});
}

export async function handshake(action, operation) {
	const raw = await action({ action: 'userai', operation, formatversion: 2 });
	const code = raw.error?.code ?? raw.errors?.[0]?.code;
	if (code === 'mwoauth-invalid-authorization') throw new BrowserLoginRequiredError();
	if (code || raw.userai?.version !== 1) {
		throw Object.assign(new Error('Das Wiki hat die UAI-Verbindungsanfrage abgewiesen. Prüfe Kontozuordnung und UAI-Version.'), { code });
	}
	return raw.userai;
}

export function supervisorSession({ wikiUrl, actionFor, open = requestBrowserOpen, now = Date.now, pause = sleep }) {
	const base = new URL(wikiUrl);
	let pending;
	let active;

	return {
		async connect({ waitSeconds = 0, signal, fresh: renew = false, ask, locale } = {}) {
			if (renew) active = undefined;
			if (active) {
				const status = await handshake(actionFor(active), 'connection-claim');
				if (status.status === 'active') return { status: 'active', proof: active };
				active = undefined;
			}
			if (pending) {
				const deadline = Math.min(now() + waitSeconds * 1000, pending.expiresAt * 1000);
				for (;;) {
					signal?.throwIfAborted();
					const claim = await handshake(actionFor(pending.proof), 'connection-claim');
					if (claim.status === 'active') {
						active = pending.proof;
						pending = undefined;
						return { status: 'active', proof: active };
					}
					const time = now();
					if (claim.status !== 'pending' || pending.expiresAt * 1000 <= time) {
						pending = undefined;
						return { status: 'closed' };
					}
					if (deadline <= time) return pending.display;
					await pause(Math.min(2000, deadline - time), undefined, { signal });
				}
			}

			const fresh = await handshake(actionFor(), 'connection-request');
			const url = new URL(fresh.approvalUrl);
			if (base.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password ||
				!(typeof fresh.connectionProof === 'string' && /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(fresh.connectionProof)) ||
				!Number.isSafeInteger(fresh.expiresAt) || fresh.expiresAt <= now() / 1000 ||
				!(typeof fresh.code === 'string' && /^[a-f0-9]{8}$/.test(fresh.code))) {
				throw new Error('Das Wiki hat keine gültige Freigabeadresse oder Prüfdaten bereitgestellt.');
			}
			pending = {
				proof: fresh.connectionProof,
				expiresAt: fresh.expiresAt,
				display: { status: 'pending', approvalUrl: url.href, expiresAt: fresh.expiresAt, code: fresh.code },
			};
			const language = String(locale || 'en').toLowerCase().split(/[-_]/)[0];
			const notices = {
				de: ['Die OAuth-Anmeldung ist gültig. Jetzt muss der Betreuer die Verbindung im Wiki freigeben. Auf einem anderen Gerät genügt es, als Betreuer eine Wiki-Seite zu laden und die Anfrage im UAI-Banner zu öffnen.', 'Freigabeseite auf diesem Gerät öffnen'],
				en: ['OAuth sign-in is valid. The supervisor must now approve the connection in the wiki. On another device, load a wiki page as the supervisor and open the request in the UAI banner.', 'Open the approval page on this device'],
				fr: ['La connexion OAuth est valide. Le responsable doit maintenant autoriser la connexion dans le wiki. Sur un autre appareil, il peut charger une page du wiki et ouvrir la demande dans le bandeau UAI.', 'Ouvrir la page sur cet appareil'],
				es: ['La sesión OAuth es válida. El supervisor debe autorizar la conexión en el wiki. Desde otro dispositivo puede cargar una página del wiki y abrir la solicitud en el aviso de UAI.', 'Abrir la página en este dispositivo'],
			};
			const [message, title] = Object.hasOwn(notices, language) ? notices[language] : notices.en;
			pending.display.notice = message;
			if (ask) {
				const decision = await ask({ mode: 'form', message,
					requestedSchema: { type: 'object', properties: { open: { type: 'boolean', title, default: false } }, required: ['open'] } });
				if (decision.action === 'accept' && decision.content?.open === true) await open(url);
			}
			return pending.display;
		},
	};
}
