/**
 * Global settings: they belong to the extension, not to a chat.
 *
 * SillyTavern persists extensionSettings for us, so there is no file of our
 * own to write and nothing to lose when the browser cache is cleared.
 */

import { ctx } from './st.js';

const DEFAULTS = {
    theme: 'ink-jade',
    background: 'none',
    reducedMotion: false,
    uiScale: 1,
    narrSize: 18.5,
    narrFont: 'theme',
    paneHeight: 300,
    logWidth: 400,
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

/** Ask SillyTavern to save settings on its usual debounce. */
export function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}
