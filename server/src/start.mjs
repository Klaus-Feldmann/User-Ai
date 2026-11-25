import { requestLogin } from './login-dialog.mjs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createUaiClient } from './client.mjs';
import { mediaWikiTransport } from './mediawiki-transport.mjs';
import { connectToWiki, createSessionServer } from './server.mjs';
import { BrowserLoginRequiredError, login, oauthConfig, storeToken, tokenProvider } from './oauth.mjs';
import { describeIdentityFailure } from './login-diagnostics.mjs';
import { handshake, supervisorSession } from './supervisor.mjs';

function transportFor(actionUrl, restUrl, getToken, proof) {
	return mediaWikiTransport({
		actionUrl, restUrl,
		fetch: async (url, options) => {
			const headers = new Headers(options.headers);
			headers.set('Authorization', 'Bearer ' + await getToken());
			if (proof) headers.set('X-UAI-Connection', proof);
			return fetch(url, { ...options, headers, signal: AbortSignal.timeout(20000) });
		},
	});
}

async function main() {
	// Existing launchers keep their private configuration and storage paths.
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith('SAI_')) process.env['UAI_' + key.slice(4)] ??= value;
	}
	const actionUrl = process.env.UAI_ACTION_URL;
	const restUrl = process.env.UAI_REST_URL;
	if (!actionUrl || !restUrl) throw new Error('Set UAI_ACTION_URL and UAI_REST_URL.');
	if (process.env.UAI_ALLOW_WRITES === '1' || process.env.UAI_CREATE_PROFILE === '1') {
		throw new Error('Diese öffentliche Alpha unterstützt nur Lesezugriffe.');
	}
	const allowPageWrites = process.env.UAI_ALLOW_PAGE_WRITES === '1';
	const allowSwsWrites = process.env.UAI_ALLOW_SWS_WRITES === '1';
	const fileDirectory = process.env.UAI_FILE_DIRECTORY;
	const wantsLogin = process.argv[2] === '--login';
	const config = oauthConfig(process.env);
	// Validate the API endpoints before any browser interaction.
	transportFor(actionUrl, restUrl, () => '');
	async function authenticate(messages) {
		const token = await login(config, { messages });
		const verifier = transportFor(actionUrl, restUrl, () => token.accessToken);
		let context;
		try {
			context = await handshake(verifier.action, 'connection-identity');
		} catch (error) {
			if (messages && error.code === 'userai-denied') {
				const identity = await verifier.action({ action: 'query', meta: 'userinfo' });
				const id = identity?.query?.userinfo?.id;
				if (Number.isSafeInteger(id) && id !== config.expectedActorId) throw Object.assign(new Error('Account mismatch'), { code: 'UAI_ACCOUNT_MISMATCH' });
			}
			const detail = error instanceof BrowserLoginRequiredError
				? 'Das Wiki hat das neu ausgestellte Zugriffstoken abgelehnt.'
				: Number.isInteger(error.status)
					? 'Die Wiki-API antwortete mit HTTP ' + error.status + '.'
					: error.name === 'TimeoutError'
						? 'Die Wiki-API hat nicht rechtzeitig geantwortet.'
						: await describeIdentityFailure(verifier.action, config.expectedActorId, error.code);
			throw new Error('UAI-Kontoprüfung nach erfolgreichem Token-Austausch: ' + detail);
		}
		if (context.actorId !== config.expectedActorId) {
			throw Object.assign(new Error('The wiki authorized a different account. No OAuth token was saved.'), { code: 'UAI_ACCOUNT_MISMATCH' });
		}
		try {
			await storeToken(config.tokenPath, token);
		} catch (error) {
			const detail = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error.code) ? ' (' + error.code + ')' : '';
			throw new Error('OAuth-Token konnte nach bestätigter Kontozuordnung nicht lokal gespeichert werden' + detail + '.');
		}
	}
	if (wantsLogin) {
		console.error('Bitte das Wiki im Browser mit dem zugeordneten Assistentenkonto freigeben.');
		await authenticate();
		console.error('OAuth-Freigabe für das eingerichtete Konto gespeichert.');
		return;
	}

	const wiki = new URL(actionUrl).host;
	serveStdio(() => {
		const transport = (proof) => transportFor(actionUrl, restUrl, tokenProvider(config), proof);
		const session = supervisorSession({ wikiUrl: actionUrl, actionFor: (proof) => transport(proof).action });
		let currentProof;
		return createSessionServer({
			wiki,
			orderDirectory: config.tokenPath + ".auftraege-" + wiki + "-" + config.expectedActorId,
			allowPageWrites,
			allowSwsWrites,
			fileDirectory,
			reconnect: async (options) => {
				try {
					let result;
					try { result = await session.connect(options); }
					catch (error) {
						if (!(error instanceof BrowserLoginRequiredError) && error.status !== 401 && error.code !== 'mwoauth-invalid-authorization') throw error;
						await requestLogin({ ...options, wiki, authenticate })
							.catch(cause => { throw Object.assign(cause, { loginDialog: true }); });
						options.signal?.throwIfAborted();
						result = await session.connect({ ...options, fresh: true });
					}
					if (result.status !== 'active') {
						currentProof = undefined;
						return result;
					}
					if (result.proof === currentProof) return { status: 'active' };
					const client = createUaiClient({ ...transport(result.proof), allowWrites: allowSwsWrites });
					const definitions = await connectToWiki(client, { expectedActorId: config.expectedActorId, allowPageWrites, allowSwsWrites, fileDirectory });
					currentProof = result.proof;
					return { status: 'active', definitions };
				} catch (error) {
					currentProof = undefined;
					if (error.loginDialog || error instanceof BrowserLoginRequiredError) throw error;
					throw new Error('Die UAI-Verbindung konnte nicht geprüft werden. Prüfe Wiki, Kontozuordnung und UAI-Version.');
				}
			},
		});
	});
}

try {
	await main();
} catch (error) {
	// Keep credentials and raw upstream errors out of the MCP stream and logs.
	const message = error?.message ?? '';
	const known = ['Set UAI_', 'Diese öffentliche Alpha unterstützt nur Lesezugriffe.', 'OAuth-Freigabe', 'The wiki authorized a different account',
		'OAuth-Token-Austausch:', 'UAI-Kontoprüfung nach erfolgreichem Token-Austausch:', 'OAuth-Token konnte nach bestätigter Kontozuordnung',
		'OAuth requires a fixed HTTPS', 'MediaWiki OAuth token exchange failed.', 'Browser konnte nicht geöffnet werden.'].some((prefix) => message.startsWith(prefix));
	const fallback = process.argv[2] === '--login'
		? 'UAI-Anmeldung fehlgeschlagen. Prüfe Client-Schlüssel, Rückrufadresse und die Zuordnung des Wiki-Kontos.'
		: 'UAI-Start fehlgeschlagen. Prüfe Wiki-Adresse, Kontozuordnung und Anmeldung. Für Browser-OAuth zuerst --login ausführen.';
	console.error(known || error instanceof BrowserLoginRequiredError ? message : fallback);
	process.exitCode = 1;
}
