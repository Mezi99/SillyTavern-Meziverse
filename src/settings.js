/**
 * Global settings: they belong to the extension, not to a chat.
 *
 * SillyTavern persists extensionSettings for us, so there is no file of our
 * own to write and nothing to lose when the browser cache is cleared.
 */

import { ctx } from './st.js';

const DEFAULTS = {
    // Meziverse mode: the master switch every feature sits under. Phase 5
    // binds it to the owned preset; until then it is flipped by hand.
    mode: true,
    theme: 'ink-jade',
    background: 'none',
    reducedMotion: false,
    uiScale: 1,
    narrSize: 18.5,
    narrFont: 'theme',
    proseColors: 'theme',
    prosePlain: '#e9e7e2',
    proseQ: '#77c2aa',
    proseEm: '#8d9199',
    proseStrong: '#e9e7e2',
    paneHeight: 300,
    paneOpacity: 90,
    logWidth: 720,
    logHeight: null,
};

/** The live settings object, with defaults filled in on first use. */
export function settings() {
    const store = ctx()?.extensionSettings;
    if (!store || typeof store !== 'object') return { ...DEFAULTS };

    if (!store.meziverse || typeof store.meziverse !== 'object') {
        store.meziverse = {};
    }

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (store.meziverse[key] === undefined) store.meziverse[key] = value;
    }

    return store.meziverse;
}

/**
 * Whether Meziverse mode is on. Every feature — scene rows, the header scene
 * cluster, the cast strip — asks this before it draws anything. Off means a
 * non-Meziverse preset is in play: tags are still stripped from the prose, but
 * no decoration is drawn and no placeholders promise otherwise.
 */
export function modeOn() {
    return settings().mode !== false;
}

/** Ask SillyTavern to save settings on its usual debounce. */
export function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}
