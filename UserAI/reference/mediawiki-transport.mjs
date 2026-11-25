/** Fixed-wiki transport. The host supplies a fetch already bound to its authenticated account. */
export function mediaWikiTransport({ actionUrl, restUrl, fetch: authenticatedFetch }) {
	const actionEndpoint = new URL(actionUrl);
	const restEndpoint = new URL(restUrl);
	if (actionEndpoint.origin !== restEndpoint.origin ||
		actionEndpoint.username || actionEndpoint.password || restEndpoint.username || restEndpoint.password ||
		actionEndpoint.search || actionEndpoint.hash || restEndpoint.search || restEndpoint.hash ||
		(actionEndpoint.protocol !== 'https:' && !(actionEndpoint.protocol === 'http:' &&
			['localhost', '127.0.0.1', '[::1]'].includes(actionEndpoint.hostname)))) {
		throw new Error('Use fixed same-origin MediaWiki endpoints over HTTPS (HTTP is allowed on loopback)');
	}

	async function read(url, options) {
		const response = await authenticatedFetch(url, { ...options, redirect: 'error' });
		if (response.status === 204) return null;
		let value;
		try { value = await response.json(); } catch { value = null; }
		if (!response.ok) {
			const error = new Error(value?.message ?? value?.error ?? `MediaWiki HTTP ${response.status}`);
			error.status = response.status;
			throw error;
		}
		if (value === null) throw new Error('MediaWiki returned no JSON response');
		return value;
	}

	function action(parameters) {
		return read(actionEndpoint, { method: 'POST', body: new URLSearchParams({ format: 'json', ...parameters }) });
	}

	async function rest({ path, method, query, body, csrf }) {
		if (!path.startsWith('/uai/v0/')) throw new Error('Unexpected REST API namespace');
		const endpoint = new URL(restEndpoint);
		endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + path;
		if (!endpoint.pathname.startsWith(restEndpoint.pathname.replace(/\/$/, '') + '/uai/v0/')) {
			throw new Error('REST path left the UAI namespace');
		}
		for (const [key, value] of Object.entries(query ?? {})) endpoint.searchParams.set(key, value);
		const headers = { Accept: 'application/json' };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (csrf) {
			const tokenResponse = await action({ action: 'query', meta: 'tokens', type: 'csrf' });
			const token = tokenResponse.query?.tokens?.csrftoken;
			if (typeof token !== 'string' || token === '+\\') throw new Error('MediaWiki did not issue an authenticated CSRF token');
			headers['X-CSRF-TOKEN'] = token;
		}
		return read(endpoint, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
	}

	return { action, rest };
}
