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
    // Per-entry feature switches for the ledger panels (scene info is always
    // on under mode and gets no switch). A later menu flips these by name;
    // a missing entry counts as on, so this list only grows.
    entries: {},
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

/**
 * Whether one ledger entry may draw. Every entry — threads, hooks, and the
 * rest as they land — asks this beside `modeOn()`. The switches live in
 * `settings().entries`, flipped by the mode-features menu when it arrives;
 * an entry without a switch yet counts as on.
 */
export function entryOn(name) {
    return settings().entries?.[name] !== false;
}

/** Ask SillyTavern to save settings on its usual debounce. */
export function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}
