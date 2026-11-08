/**
 * Icons are a small inline sprite. Keeping them here means the extension has no
 * icon-font dependency and no network request; the symbols are prefixed so they
 * cannot collide with anything else on SillyTavern's page.
 */

const SPRITE = `<svg class="mz-sprite" aria-hidden="true" focusable="false">
<symbol id="mz-i-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="3.3"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/></symbol>
<symbol id="mz-i-brush" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5 20.5 7.5 11 17a3.5 3.5 0 0 1-5-5z"/><path d="M14 6l4 4"/><path d="M7 14c-2 1-3 2.6-3 4.5 1.4-.5 2.7-.4 3.8.1 1 .5 2.2.5 3.2 0 1.8-.8 2.5-2.6 1.6-4"/></symbol>
<symbol id="mz-i-door" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5h5.5v17h-5.5"/><path d="M3.5 12h10.5"/><path d="M10 8l4 4-4 4"/></symbol>
<symbol id="mz-i-log" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6.5L6.5 18v-3A3 3 0 0 1 4 12z"/><path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01"/></symbol>
<symbol id="mz-i-profiles" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.4 2.7-6 6-6s6 2.6 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/></symbol>
<symbol id="mz-i-standing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20v-8M12 20V5M19 20V9"/></symbol>
<symbol id="mz-i-shifts" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/></symbol>
<symbol id="mz-i-bond" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></symbol>
<symbol id="mz-i-desire" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></symbol>
<symbol id="mz-i-thought" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4h11A2.5 2.5 0 0 1 20 6.5v5a2.5 2.5 0 0 1-2.5 2.5H11l-3.2 2.7V14h-.3A2.5 2.5 0 0 1 4 11.5v-5A2.5 2.5 0 0 1 6.5 4z"/><path d="M8.5 20h.01M12 20.8h.01"/></symbol>
<symbol id="mz-i-threads" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="mz-i-plans" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M8 3v4M16 3v4M4 10.5h16"/></symbol>
<symbol id="mz-i-hooks" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></symbol>
<symbol id="mz-i-lore" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"/></symbol>
<symbol id="mz-i-recap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h10"/></symbol>
<symbol id="mz-i-chevdown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></symbol>
<symbol id="mz-i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13M12 6.5l5.5 5.5L12 17.5"/></symbol>
<symbol id="mz-i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></symbol>
<symbol id="mz-i-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="1.6"/></symbol>
<symbol id="mz-i-menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
<symbol id="mz-i-impersonate" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"/><path d="M5.5 20.5c.4-3.4 2.3-6 6.5-6s6.1 2.6 6.5 6"/><path d="M3.5 13.5h4M16.5 13.5h4" /></symbol>
<symbol id="mz-i-continue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 14-5.2"/><path d="M18.5 3.5v3.4h-3.4"/><path d="M20 12a8 8 0 0 1-14 5.2"/><path d="M5.5 20.5v-3.4h3.4"/></symbol>
<symbol id="mz-i-chat-new" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-4.4A8 8 0 1 1 20 11.5z"/><path d="M12 8.2v6.6M8.7 11.5h6.6"/></symbol>
<symbol id="mz-i-chat-parent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5v-.9A2.6 2.6 0 0 1 6.6 5h10.8A2.6 2.6 0 0 1 20 7.6v.9"/><path d="M4 15.5v.9A2.6 2.6 0 0 0 6.6 19h10.8a2.6 2.6 0 0 0 2.6-2.6v-.9"/><path d="M4 12h13M13.5 8.5l3.5 3.5-3.5 3.5"/></symbol>
<symbol id="mz-i-prev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6l-6 6 6 6"/></symbol>
<symbol id="mz-i-next" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></symbol>
<symbol id="mz-i-latest" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7.5l6 6 6-6"/><path d="M6 16.5h12"/></symbol>
<symbol id="mz-i-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="5.5" r="2.4"/><circle cx="7" cy="18.5" r="2.4"/><circle cx="17" cy="9" r="2.4"/><path d="M7 7.9v8.2"/><path d="M7 13c0-2 1.6-3.4 5.1-3.6 1.5-.1 2.5-.2 2.9-.4"/></symbol>
<symbol id="mz-i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5v-.7a2.3 2.3 0 0 0-2.3-2.3H6.2A2.7 2.7 0 0 0 3.5 5.2v7a2.3 2.3 0 0 0 2.3 2.3h.7"/></symbol>
<symbol id="mz-i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/></symbol>
<symbol id="mz-i-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 12S6 5.8 12 5.8c1.5 0 2.8.35 3.9.87M21.2 12S18 18.2 12 18.2c-1.5 0-2.8-.35-3.9-.87"/><path d="M9.8 9.8a2.8 2.8 0 0 0 4.4 3.5"/><path d="M4.5 19.5L19.5 4.5"/></symbol>
<symbol id="mz-i-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4.2L20 8.2a2.4 2.4 0 0 0-3.4-3.4L4.8 16.6 4 20z"/><path d="M15.2 6.2l2.6 2.6"/></symbol>
<symbol id="mz-i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></symbol>
<symbol id="mz-i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5h15"/><path d="M9 6.5V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8v1.7"/><path d="M6.5 6.5l.8 12.2A1.9 1.9 0 0 0 9.2 20.5h5.6a1.9 1.9 0 0 0 1.9-1.8l.8-12.2"/><path d="M10 10.5v6M14 10.5v6"/></symbol>
<symbol id="mz-i-camera" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5h3l1.5-2.2h6l1.5 2.2h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2 17.1v-7a1.5 1.5 0 0 1 1.5-1.6z"/><circle cx="12" cy="13" r="3.4"/></symbol>
<symbol id="mz-i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></symbol>
<symbol id="mz-i-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></symbol>
<symbol id="mz-i-map" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8z"/><path d="M9 4.5v12.7M15 6.8v12.7"/></symbol>
<symbol id="mz-i-crack" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3l-4 6 5 2.5-5 4 3 1.5-2 4"/><path d="M5 8l3 1M19 14l-3 .5"/></symbol>
<symbol id="mz-i-mask" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5c3-1.4 5.6-2 8-2s5 .6 8 2c0 6.2-3 10.2-8 11.5-5-1.3-8-5.3-8-11.5z"/><path d="M7.8 11.2c.9-.7 2-.7 2.9 0M13.3 11.2c.9-.7 2-.7 2.9 0"/><path d="M9.6 14.6c1.5.9 3.3.9 4.8 0"/></symbol>
<symbol id="mz-i-gap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5H5v14h3M16 5h3v14h-3"/><path d="M9.5 12h.01M12 12h.01M14.5 12h.01"/></symbol>
<symbol id="mz-i-cut" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 20L14 4M14 20l6-16"/></symbol>
<symbol id="mz-i-dream" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 14.2A8 8 0 1 1 9.8 4.5a6.4 6.4 0 0 0 9.7 9.7z"/><path d="M17 3.5v4M15 5.5h4"/></symbol>
<symbol id="mz-i-return" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/></symbol>
<symbol id="mz-i-music" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></symbol>
<symbol id="mz-i-play" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z"/></symbol>
<symbol id="mz-i-pause" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7.5" y="5" width="3.5" height="14" rx="1.2"/><rect x="13" y="5" width="3.5" height="14" rx="1.2"/></symbol>
<symbol id="mz-i-vol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.2L12 19V5L7.2 9.5z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.8a7.5 7.5 0 0 1 0 10.4"/></symbol>
<symbol id="mz-i-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.2L12 19V5L7.2 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></symbol>
<symbol id="mz-i-undock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5.5"/><path d="M13.5 3.5H20V10"/><path d="M20 3.5l-8 8"/></symbol>
<symbol id="mz-i-dock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5h4.5A1.5 1.5 0 0 1 20 5v4.5"/><path d="M20 14v4.5a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M3.5 12H15"/><path d="M11 8l4 4-4 4"/></symbol>
<symbol id="mz-i-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/></symbol>
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

/** The same icon as markup, for the prose strings that build HTML. */
export function iconHtml(name, className = 'ico') {
    return `<svg class="${className}" aria-hidden="true"><use href="#${name}"/></svg>`;
}

/** Puts the sprite into the root once. */
export function injectSprite(root) {
    if (root.querySelector('.mz-sprite')) return;
    root.insertAdjacentHTML('afterbegin', SPRITE);
}
