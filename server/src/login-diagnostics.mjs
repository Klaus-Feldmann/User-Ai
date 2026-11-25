const knownCodes = new Set([
	'userai-denied', 'userai-connection-required', 'unknown_action', 'badvalue',
	'readapidenied', 'permissiondenied', 'mwoauth-invalid-authorization',
]);

export async function describeIdentityFailure(action, expectedId, uaiCode) {
	const label = knownCodes.has(uaiCode) ? 'UAI-API: ' + uaiCode + '.' : 'UAI-Identitätsprüfung fehlgeschlagen.';
	let raw;
	try {
		// Native read-only account probe. The wiki may block it before supervisor approval.
		raw = await action({ action: 'query', meta: 'userinfo', formatversion: 2, errorformat: 'raw' });
	} catch (error) {
		const status = Number.isInteger(error.status) ? ' (HTTP ' + error.status + ')' : '';
		return label + ' MediaWiki-Kontoabfrage fehlgeschlagen' + status + '.';
	}
	const user = raw?.query?.userinfo;
	if (user?.id === 0 || user?.anon === true) {
		return label + ' MediaWiki hat den API-Aufruf als anonym behandelt.';
	}
	if (Number.isSafeInteger(user?.id) && user.id > 0) {
		return label + (user.id === expectedId ? ' Die Kontozuordnung stimmt.' : ' Die Kontozuordnung stimmt nicht.');
	}
	const errors = raw?.errors ?? [raw?.error];
	const code = errors.flatMap(error => [error?.key, error?.code]).find(value => knownCodes.has(value));
	return label + (code
		? ' MediaWiki-Kontoabfrage: ' + code + '.'
		: ' MediaWiki hat keine auswertbare Konto-ID geliefert.');
}
