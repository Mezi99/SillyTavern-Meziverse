/**
 * Global settings: they belong to the extension, not to a chat.
 *
 * SillyTavern persists extensionSettings for us, so there is no file of our
 * own to write and nothing to lose when the browser cache is cleared.
 */

import { ctx } from './st.js';
import { DEFAULT_BG_PROMPT_ON, DEFAULT_BG_PROMPT_OFF, LEGACY_DEFAULT_BG_PROMPT_ON, LEGACY_DEFAULT_BG_PROMPT_OFF, PRIOR_DEFAULT_BG_PROMPT_ON, PRIOR_DEFAULT_BG_PROMPT_OFF } from './backgrounds.js';
import { DEFAULT_DJ_PROMPT, LEGACY_DEFAULT_DJ_PROMPT } from './musicdj.js';

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
    // Speech bubbles in the reading pane: the speaker's label, the words in
    // a quiet bubble, the tone said in after. Off leaves the prose plain.
    speechFx: true,
    // The reasoning block in the reading pane: the model's thinking as an
    // expandable block above the turn's prose. Off leaves the pane exactly
    // as it was - and the log drawer never shows reasoning either way.
    showReasoning: true,
    // The scene header's wardrobe in the reading pane: 'quiet' (the default),
    // 'rule' (chapter rule), 'date' (date-first, for fast-paced stories) or
    // 'simple' (the first band Meziverse ever drew). One ribbon, four
    // wardrobes; the log drawer keeps its own compact band whatever this says.
    sceneHeaderStyle: 'quiet',
    // The music player: the scene's soundtrack, a compact YouTube player in
    // the header. Off hides it whole and nothing plays.
    music: true,
    // The map: the story's places as a live atlas - a minimap window on
    // screen that opens the full map. Built from the scene tags; without
    // tags, from the places the chat's backgrounds already name. Off hides
    // the module whole.
    map: true,
    // The minimap window itself - the small one in the corner. Off leaves
    // the compact map button, which still opens the full map.
    mapMini: true,
    // How deep the atlas shows places: 2, 3 or 4 levels, or 99 for all.
    mapDepth: 4,
    // The minimap window's remembered spot. Null parks it bottom-left.
    mapPos: null,
    // The minimap's remembered size {w, h} and crop zoom. Null / 1 = built in.
    mapMiniSize: null,
    mapMiniZoom: 1,
    // The full map window's remembered spot and size. Null = centred default.
    mapWinPos: null,
    mapWinSize: null,
    // Story requests: a `<music>` tag in a reply starts playback when the
    // reply lands. Off leaves playback to the player's own input.
    musicAuto: true,
    musicVolume: 60,
    musicMuted: false,
    // The pill docks in the header; undocked, it is a draggable card on
    // wide screens and re-docks itself on narrow ones. Its remembered spot.
    musicDocked: true,
    musicPos: null,
    // Mini: the undocked card shrinks to one row when it is in the story's
    // way. Toggled by the card's own shrink/expand buttons.
    musicMini: false,
    // The YouTube Data API key behind song search - the user's own free
    // Google key, used from the browser. Restrict it by HTTP referrer (the
    // search fetch pins one) or by IP; never leave it unrestricted.
    musicApiKey: '',
    // The Music DJ: an independent watcher that reads each new reply and
    // picks music to match its mood - its own LLM call, pace and prompt.
    // Opt-in, like automatic backgrounds: off leaves picks to the player.
    musicDj: false,
    // The DJ asks at most once every N AI replies (user turns never count).
    musicDjEveryN: 1,
    // What the DJ picks: an instrumental score, or one specific real song.
    // Either way the story's own genre and era decide the sound.
    musicPick: 'orchestra',
    // The DJ prompt the user tunes: the rules. The pick style and the answer
    // format are appended by code.
    musicDjPrompt: DEFAULT_DJ_PROMPT,
    // The Connections tab: which LLM each watcher agent's calls ride - the
    // current ST API, a Connection Manager profile, or a custom
    // OpenAI-compatible endpoint. One entry per agent id (connections.js).
    connections: {},
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

/**
 * Saved prompt cores that still equal a superseded default, paired with the
 * current one - see `settings()` for why they follow the default (either
 * way the default moves).
 */
const PROMPT_DEFAULT_REFRESH = [
    ['musicDjPrompt', LEGACY_DEFAULT_DJ_PROMPT, DEFAULT_DJ_PROMPT],
    ['bgPromptOn', LEGACY_DEFAULT_BG_PROMPT_ON, DEFAULT_BG_PROMPT_ON],
    ['bgPromptOn', PRIOR_DEFAULT_BG_PROMPT_ON, DEFAULT_BG_PROMPT_ON],
    ['bgPromptOff', LEGACY_DEFAULT_BG_PROMPT_OFF, DEFAULT_BG_PROMPT_OFF],
    ['bgPromptOff', PRIOR_DEFAULT_BG_PROMPT_OFF, DEFAULT_BG_PROMPT_OFF],
];

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

    // A saved prompt core still holding an older default is not a user's
    // text - it followed the default once and keeps following it. An edited
    // core is the user's own and is never touched.
    for (const [key, legacy, fresh] of PROMPT_DEFAULT_REFRESH) {
        if (store.meziverse[key] === legacy) store.meziverse[key] = fresh;
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

/** Whether the speech bubbles play in the reading pane. */
export function speechFxOn() {
    return settings().speechFx !== false;
}

/** Whether the reasoning block shows above the reading pane's prose. */
export function reasoningOn() {
    return settings().showReasoning !== false;
}

const SCENE_HEADER_STYLES = ['quiet', 'rule', 'date', 'simple'];

/** The scene header's wardrobe: 'quiet', 'rule', 'date' or 'simple'. */
export function sceneHeaderStyle() {
    const value = settings().sceneHeaderStyle;
    return SCENE_HEADER_STYLES.includes(value) ? value : 'quiet';
}

/** Whether the music player exists at all - the master switch. */
export function musicOn() {
    return settings().music !== false;
}

/** Whether the map exists at all - the master switch for the atlas windows. */
export function mapOn() {
    return settings().map !== false;
}

/** Whether the minimap window shows; off leaves the compact map button. */
export function mapMiniOn() {
    return settings().mapMini !== false;
}

/** Whether a `<music>` tag in a reply may start playback on arrival. */
export function musicAutoOn() {
    return settings().musicAuto !== false;
}

/** The saved YouTube Data API key, or '' when song search has none. */
export function musicKey() {
    const value = settings().musicApiKey;
    return typeof value === 'string' ? value.trim() : '';
}

/** Whether the Music DJ picks for new replies. Opt-in. */
export function musicDjOn() {
    return settings().musicDj === true;
}

/** What the DJ picks: 'songs' for one specific real song, else the score. */
export function musicPickMode() {
    return settings().musicPick === 'songs' ? 'songs' : 'orchestra';
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

/**
 * One watcher agent's connection, with every field filled in: the source is
 * 'current' (the API SillyTavern is talking through now) unless it was
 * deliberately set to 'profile' or 'custom'. A copy - patches go back
 * through `setConnection`.
 */
export function normalizeConnection(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
        source: value.source === 'profile' || value.source === 'custom' ? value.source : 'current',
        profileId: typeof value.profileId === 'string' ? value.profileId : '',
        customUrl: typeof value.customUrl === 'string' ? value.customUrl : '',
        customKey: typeof value.customKey === 'string' ? value.customKey : '',
        customModel: typeof value.customModel === 'string' ? value.customModel : '',
    };
}

/** The connection one watcher agent rides. See `normalizeConnection`. */
export function connectionFor(id) {
    return normalizeConnection(settings().connections?.[id]);
}

/** Applies a patch to one agent's connection and remembers it. */
export function setConnection(id, patch) {
    const store = settings();
    if (!store.connections || typeof store.connections !== 'object') store.connections = {};
    store.connections[id] = { ...normalizeConnection(store.connections[id]), ...patch };
    saveSettings();
}
