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
<symbol id="mz-i-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="1.6"/></symbol>
<symbol id="mz-i-regen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.6 4v4.4H16.2"/></symbol>
<symbol id="mz-i-prev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6l-6 6 6 6"/></symbol>
<symbol id="mz-i-next" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></symbol>
<symbol id="mz-i-latest" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7.5l6 6 6-6"/><path d="M6 16.5h12"/></symbol>
<symbol id="mz-i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></symbol>
<symbol id="mz-i-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></symbol>
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
