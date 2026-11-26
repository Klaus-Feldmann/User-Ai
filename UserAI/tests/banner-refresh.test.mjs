import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Eine offene Betreuerseite übernimmt den ersten Auftrag, Statuswechsel und geleerten Bericht', async () => {
	const js = await readFile(new URL('../resources/dismiss.js', import.meta.url), 'utf8');
	let tick, nextHtml = 'Wartet auf Freigabe';
	const delays = [];
	const banner = {
		isConnected: true, dataset: { owner: '1', uaiRefresh: '/banner' },
		replaceChildren(...children) { this.children = children; },
	};
	runInNewContext(js, {
		document: { hidden: false, querySelector: () => banner, querySelectorAll: () => [] },
		mw: { hook: () => ({ add: callback => callback() }) },
		setTimeout: (callback, delay) => { tick = callback; delays.push(delay); },
		fetch: async () => ({ ok: true, text: async () => nextHtml }),
		DOMParser: class {
			parseFromString(html) {
				return { querySelector: () => ({
					dataset: { owner: '1' }, innerHTML: html, children: html ? [html] : [],
				}) };
			}
		},
	});
	for (const state of ['Wartet auf Freigabe', 'Läuft', 'Angehalten', 'Abgeschlossen', '']) {
		nextHtml = state;
		await tick();
		assert.deepEqual(banner.children, state ? [state] : []);
	}
	assert.deepEqual(delays, Array(6).fill(20000));
});
