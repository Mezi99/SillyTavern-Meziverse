/**
 * Icons are a small inline sprite. Keeping them here means the extension has no
 * icon-font dependency and no network request; the symbols are prefixed so they
 * cannot collide with anything else on SillyTavern's page.
 */

const SPRITE = `<svg class="mz-sprite" aria-hidden="true" focusable="false">
<symbol id="mz-i-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="3.3"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/></symbol>
<symbol id="mz-i-door" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5h5.5v17h-5.5"/><path d="M3.5 12h10.5"/><path d="M10 8l4 4-4 4"/></symbol>
<symbol id="mz-i-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h11"/></symbol>
<symbol id="mz-i-chevdown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></symbol>
<symbol id="mz-i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13M12 6.5l5.5 5.5L12 17.5"/></symbol>
<symbol id="mz-i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></symbol>
</svg>`;

/** Builds one icon node pointing at the sprite. */
export function icon(name, className = 'ico') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');

    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${name}`);
    svg.append(use);

    return svg;
}

/** Puts the sprite into the root once. */
export function injectSprite(root) {
    if (root.querySelector('.mz-sprite')) return;
    root.insertAdjacentHTML('afterbegin', SPRITE);
}
