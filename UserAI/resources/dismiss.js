function bindButtons() {
	document.querySelectorAll( '.userai-connection-notice [data-uai-id]' ).forEach( function ( row ) {
		if ( row.dataset.uaiReady ) {
			return;
		}
		row.dataset.uaiReady = '1';
		const key = 'userai:' + mw.config.get( 'wgDBname' ) + ':' + row.dataset.uaiKey;
		function closeRow() {
			row.remove();
		}
		try {
			if ( localStorage.getItem( key ) === row.dataset.uaiId ) {
				closeRow();
				return;
			}
		} catch ( error ) { /* Storage may be disabled. */ }
		const button = document.createElement( 'button' );
		button.type = 'button';
		button.className = 'userai-dismiss';
		button.textContent = '×';
		button.setAttribute( 'aria-label', mw.msg( 'userai-dismiss' ) );
		button.addEventListener( 'click', function () {
			try {
				localStorage.setItem( key, row.dataset.uaiId );
			} catch ( error ) { /* Closing this view still works. */ }
			closeRow();
		} );
		row.prepend( button );
	} );
}

const bannerRefreshIntervalMs = 20000;

function watchBanner() {
	const banner = document.querySelector( '[data-uai-refresh]' );
	if ( !banner || banner.dataset.watching ) {
		return;
	}
	banner.dataset.watching = '1';
	let signature;
	async function refresh() {
		if ( !banner.isConnected ) {
			return;
		}
		try {
			if ( !document.hidden ) {
				const response = await fetch( banner.dataset.uaiRefresh, {
					credentials: 'same-origin', cache: 'no-store', redirect: 'error'
				} );
				if ( response.ok ) {
					const page = new DOMParser().parseFromString( await response.text(), 'text/html' );
					const next = page.querySelector( '[data-uai-refresh]' );
					const html = next && next.dataset.owner === banner.dataset.owner ? next.innerHTML : '';
					if ( html !== signature ) {
						banner.replaceChildren( ...( html ? next.children : [] ) );
						signature = html;
						bindButtons();
					}
				}
			}
		} catch ( error ) {
			// Retry transient network errors on the next refresh.
		} finally {
			setTimeout( refresh, bannerRefreshIntervalMs );
		}
	}
	setTimeout( refresh, bannerRefreshIntervalMs );
}
mw.hook( 'wikipage.content' ).add( function () {
	bindButtons();
	watchBanner();
} );
