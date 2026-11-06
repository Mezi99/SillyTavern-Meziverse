/**
 * Global settings: they belong to the extension, not to a chat.
 *
 * SillyTavern persists extensionSettings for us, so there is no file of our
 * own to write and nothing to lose when the browser cache is cleared.
 */

import { ctx } from './st.js';
import { DEFAULT_BG_PROMPT_ON, DEFAULT_BG_PROMPT_OFF } from './backgrounds.js';

const DEFAULTS = {
    // Meziverse mode: the master switch for the extras (see modeOn). Phase 5
    // binds it to the owned preset; until then it is flipped by hand.
    mode: true,
    // Per-entry feature switches for the ledger panels (scene info is always
    // on under mode and gets no switch). A later menu flips these by name;
    // a missing entry counts as on, so this list only grows.
    entries: {},
    theme: 'ink-jade',
    background: 'none',
    // The cast strip above the reading pane. Off draws no avatars at all -
    // no posters, no initials - and the background stays alone on stage.
    avatars: true,
    // The background master switch: the whole image-generation side. Off
    // means the watcher never runs - the brush included - and the stage
    // shows the chat's own pictures or SillyTavern's background. Weather
    // and indoor effects ride the scene tags and play regardless.
    bgImages: true,
    // Location backgrounds: an image generated from the story's place by
    // SillyTavern's Image Generation. Auto works everywhere - a `<scene>` tag
    // names the place outright (free outcomes run at any pace, new draws at
    // the pace below), and stories without tags get the plain-prose watcher
    // at the same pace - while the brush button always fires on demand. Names
    // start with bg so they never collide with the scene's own `background`
    // mirror above.
    bgAuto: false,
    // "Background generation pace": the watcher draws at most once every N AI
    // replies (swipes and edits count, user turns never do). 1 - the default -
    // renders every new place; higher values keep the last picture while new
    // places wait their turn.
    bgEveryN: 1,
    bgStyle: 'anime style, visual novel background art, detailed environment, cinematic lighting',
    bgNegative: 'people, characters, crowd, portrait, text, watermark, logo, signature, blurry, low quality',
    bgSize: 'landscape',
    // Weather effects on the background stage: the scene tag's weatherTag
    // names the state, locationTag gates it to outdoors, and the free-text
    // weather's tone words tune its strength. Off leaves the scene still.
    weatherFx: true,
    // Indoor effects: the room's quiet mood, seeded per place. Independent
    // of the weather switch and of image generation.
    indoorFx: true,
    // The watcher prompts the user tunes: the scene-tagged hand and the
    // plain-prose hand. The answer format is appended by code.
    bgPromptOn: DEFAULT_BG_PROMPT_ON,
    bgPromptOff: DEFAULT_BG_PROMPT_OFF,
    reducedMotion: false,
    // How the inline cue popovers open: on hover and tap, or tap only.
    cuePopovers: 'both',
    // How a memory arrives: as a pill, or opening on arrival.
    cueMemories: 'pill',
    // How the meanwhile boxes arrive: closed, or the latest one open.
    cueMeanwhile: 'closed',
    uiScale: 1,
    narrSize: 18.5,
    narrFont: 'inter',
    proseColors: 'theme',
    prosePlain: '#e9e7e2',
    proseQ: '#77c2aa',
    proseEm: '#8d9199',
    proseStrong: '#e9e7e2',
    paneHeight: 300,
    paneOpacity: 90,
    paneBlur: 16,
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
 * Whether Meziverse mode is on - the master switch for the EXTRAS: the ledger
 * rails, cue marks and popovers, mindscape, meanwhile boxes, thought bubbles,
 * everything that reads a Meziverse.json preset's own tags. The scene-tag
 * experience - backgrounds, the header cluster, scene rows, the cast strip -
 * works in both modes and never asks this. Off means a non-Meziverse preset
 * is in play: tags are still stripped from the prose, and whatever a
 * `<scene>` tag carries still draws.
 */
/**
 * The Meziverse mode is still under development, and this flag is the release
 * switch. True - the dev builds - keeps its settings tab and the extras in
 * play. False - a release - hides the tab whole and `modeOn()` answers false
 * whatever the setting says: the extras stay inert and the release ships the
 * base extension alone.
 */
export const DEV_EXTRAS = true;

export function modeOn() {
    return DEV_EXTRAS && settings().mode !== false;
}

/** Whether the cast strip draws avatars. Off: no posters, no initials. */
export function avatarsOn() {
    return settings().avatars !== false;
}

/** Whether automatic background generation is on. The brush needs no gate. */
export function bgAutoOn() {
    return settings().bgAuto === true;
}

/** Whether background image generation exists at all - the master switch. */
export function bgImagesOn() {
    return settings().bgImages !== false;
}

/** Whether the weather effects play on the background stage. */
export function weatherFxOn() {
    return settings().weatherFx !== false;
}

/** Whether the indoor effects play - the room's quiet mood. */
export function indoorFxOn() {
    return settings().indoorFx !== false;
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
