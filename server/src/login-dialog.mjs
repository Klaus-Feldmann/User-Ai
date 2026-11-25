const messages = {
	de: ['Melde dich im Standardbrowser beim folgenden Wiki mit dem für UAI eingerichteten Konto an, bevor du OAuth freigibst.', 'Anmeldung im Browser öffnen', 'Anmeldung abgebrochen.', 'Anmeldung fehlgeschlagen. Prüfe das Wiki-Konto und starte die Verbindung erneut.', 'Das verwendete Wiki-Konto stimmt mit der Einrichtung von UAI nicht überein.', 'Rückruf empfangen. Kehre zur KI-App zurück.'],
	en: ['Before approving OAuth, sign in to the following wiki in your default browser with the account configured for UAI.', 'Open browser sign-in', 'Sign-in cancelled.', 'Sign-in failed. Check the wiki account and reconnect.', 'The wiki account used does not match the UAI configuration.', 'Callback received. Return to the AI app.'],
	fr: ['Avant d’autoriser OAuth, connectez-vous au wiki suivant dans votre navigateur par défaut avec le compte configuré pour UAI.', 'Ouvrir la connexion dans le navigateur', 'Connexion annulée.', 'Échec de connexion. Vérifiez le compte wiki et réessayez.', 'Le compte wiki utilisé ne correspond pas à la configuration de UAI.', 'Réponse reçue. Revenez à l’application.'],
	es: ['Antes de autorizar OAuth, inicia sesión en el siguiente wiki desde tu navegador predeterminado con la cuenta configurada para UAI.', 'Abrir el inicio de sesión', 'Inicio de sesión cancelado.', 'Error de acceso. Comprueba la cuenta del wiki y vuelve a conectar.', 'La cuenta del wiki utilizada no coincide con la configuración de UAI.', 'Respuesta recibida. Vuelve a la aplicación.'],
};
export function loginMessages(locale) {
	const language = String(locale || 'en').toLowerCase().split(/[-_]/)[0];
	const [prompt, open, cancelled, failed, mismatch, callback] = Object.hasOwn(messages, language) ? messages[language] : messages.en;
	return { prompt, open, cancelled, failed, mismatch, callback };
}
export async function requestLogin({ ask, authenticate, locale, wiki }) {
	const m = loginMessages(locale);
	let detail = '';
	for (;;) {
		const answer = await ask({ mode: 'form', message: detail + m.prompt + '\n' + wiki,
			requestedSchema: { type: 'object', required: ['open'], properties: { open: { type: 'boolean', title: m.open } } } });
		if (answer.action !== 'accept' || answer.content?.open !== true) throw new Error(m.cancelled);
		try { await authenticate(m); return; }
		catch (error) {
			if (error.code !== 'UAI_ACCOUNT_MISMATCH') throw new Error(m.failed);
			detail = m.mismatch + '\n';
		}
	}
}
