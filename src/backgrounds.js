/**
 * Location backgrounds: the per-chat place cache, the per-response stamps over
 * it, and the pure decisions the background chain makes with both.
 *
 * Pure like scene.js - the store is a plain object that lives in
 * `chatMetadata.meziverse.bg` (SillyTavern persists it for us), stamps ride
 * the messages themselves (`extra.meziverse.bg`, mirrored per swipe), and
 * nothing here touches the DOM, the network, or SillyTavern itself. On top of
 * this layer the runtime chain adds three things: the watcher LLM call that
 * verifies whether the place actually changed and writes image prompts, image
 * generation through SillyTavern's Image Generation, and setting the result as
 * the chat background.
 *
 * One rule shapes everything below: string comparison is only a skip-gate,
 * never the change-detector. Tags are free text written by an LLM - "Pier 9"
 * and "Pier No9" may be the same place - so an exact key match skips the
 * watcher for free, while any difference is verified by meaning before a new
 * image is ever generated.
 *
 * Everything here is pure: the watcher's question is assembled from the store
 * and the messages, and its answer is parsed back. Asking it - and drawing,
 * applying and scheduling - happens in bgchain.js.
 */

import { describeScene, describeScenes, splitLocation } from './scene.js';
import { parseTags, stripNonSceneTags } from './tags.js';

export const BG_STORE_VERSION = 1;

/** The size passed to Image Generation when bgSize is 'landscape'. */
export const LANDSCAPE_SIZE = Object.freeze({
    width: 1216,
    height: 832,
});

/**
 * Normalizes a location string into a stable lookup key.
 *
 * `"The city |  Docks | Pier 9 "` and `"the city | docks | pier 9"` fold to
 * the same key, so a spelling drift only costs a watcher call, never a
 * duplicate image.
 *
 * @param {string} value e.g. 'The city | Docks | Pier 9'
 * @returns {string}
 */
export function locationKey(value) {
    const raw = typeof value === 'string' ? value : '';
    const { levels } = splitLocation(raw);
    const joined = levels.length ? levels.join(' | ') : raw;
    const normalized = typeof joined.normalize === 'function' ? joined.normalize('NFC') : joined;
    return normalized.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Ensures a valid background store. Mutates `raw` in place - the store lives
 * on `chatMetadata.meziverse.bg`, and SillyTavern saves that object by
 * reference - and returns it. Anything unrecognised is pruned rather than
 * trusted, so a hand-edited or stale chat file can never wedge the chain.
 *
 * @param {object} [raw]
 * @returns {{version:number, currentKey:string|null, keys:Record<string,string>, records:Record<string,object>, nextId:number, baseline?:{lock:string|null, shown:string}}}
 */
export function normalizeStore(raw) {
    const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    store.version = BG_STORE_VERSION;

    if (typeof store.currentKey !== 'string' || !store.currentKey.trim()) {
        store.currentKey = null;
    } else {
        store.currentKey = locationKey(store.currentKey);
    }

    // The takeover baseline - the background the chain found before it first
    // wrote one - rides the store so it survives reloads. Unrecognised shapes
    // are pruned: an absent field means "never recorded", never "recorded as
    // nothing".
    if (store.baseline !== undefined) {
        const base = store.baseline;
        const valid = base && typeof base === 'object' && !Array.isArray(base)
            && (base.lock === null || typeof base.lock === 'string')
            && typeof base.shown === 'string';
        if (valid) {
            store.baseline = { lock: base.lock ? base.lock.trim() : null, shown: base.shown.trim() };
        } else {
            delete store.baseline;
        }
    }

    if (!store.keys || typeof store.keys !== 'object' || Array.isArray(store.keys)) {
        store.keys = {};
    }
    if (!store.transports || typeof store.transports !== 'object' || Array.isArray(store.transports)) {
        store.transports = {};
    }
    if (!store.records || typeof store.records !== 'object' || Array.isArray(store.records)) {
        store.records = {};
    }

    let maxId = 0;
    for (const [id, record] of Object.entries(store.records)) {
        const match = /^bg_(\d+)$/.exec(id);
        if (match) maxId = Math.max(maxId, Number(match[1]));
        if (!record || typeof record !== 'object') delete store.records[id];
    }

    for (const [key, id] of Object.entries(store.keys)) {
        const normKey = locationKey(key);
        if (!normKey || typeof id !== 'string' || !store.records[id]) {
            delete store.keys[key];
            continue;
        }
        if (normKey !== key) {
            delete store.keys[key];
            store.keys[normKey] = id;
        }
    }

    for (const [key, id] of Object.entries(store.transports)) {
        const normKey = locationKey(key);
        if (!normKey || typeof id !== 'string' || !store.records[id]) {
            delete store.transports[key];
            continue;
        }
        if (normKey !== key) {
            delete store.transports[key];
            store.transports[normKey] = id;
        }
    }

    if (store.currentKey && !store.keys[store.currentKey]) {
        store.currentKey = null;
    }

    const next = Number.isInteger(store.nextId) && store.nextId > maxId
        ? store.nextId
        : maxId + 1;
    store.nextId = Math.max(1, next);

    return store;
}

/**
 * Looks up a cached record by location string or by normalized key.
 *
 * @param {object} store
 * @param {string} placeOrKey e.g. 'The city | Docks | Pier 9'
 * @returns {object|null} the record, or null when this place was never drawn
 */
export function lookupRecord(store, placeOrKey) {
    if (!store || typeof store !== 'object') return null;
    const key = locationKey(placeOrKey);
    if (!key) return null;
    const id = store.keys?.[key];
    return (id && store.records?.[id]) || null;
}

/**
 * The record whose image is on screen right now, or null.
 *
 * @param {object} store
 * @returns {object|null}
 */
export function currentRecord(store) {
    if (!store || !store.currentKey) return null;
    return lookupRecord(store, store.currentKey);
}

/**
 * Resolves a record id the way the watcher may write it - `'bg_3'`, `'3'` or
 * `3` - against `store.records`.
 *
 * @param {object} store
 * @param {string|number|null|undefined} rawId
 * @returns {string|null} the record id, or null when nothing matches
 */
export function resolveRecordId(store, rawId) {
    if (rawId === null || rawId === undefined) return null;
    const str = String(rawId).trim();
    if (!str) return null;
    if (store?.records?.[str]) return str;
    const digits = /^(\d+)$/.exec(str);
    if (digits && store?.records?.[`bg_${digits[1]}`]) return `bg_${digits[1]}`;
    return null;
}

/**
 * Points a location key at an existing record - the watcher's "this is the
 * same place, just spelled differently" answer - and marks it current, so the
 * skip-gate compares equal from now on.
 *
 * @param {object} store
 * @param {string} placeOrKey the location as the newest tag spelled it
 * @param {string|number} targetId the record the watcher matched
 * @returns {object|null} the aliased record, or null for an unknown id
 */
export function aliasLocation(store, placeOrKey, targetId) {
    const ensured = normalizeStore(store);
    const key = locationKey(placeOrKey);
    if (!key) return null;

    const id = resolveRecordId(ensured, targetId);
    if (!id) return null;

    ensured.keys[key] = id;
    ensured.currentKey = key;
    return ensured.records[id];
}

/**
 * The location edit's side of the books: a reply whose place was re-spelled
 * (the scene editor rewrites the tag) keeps its picture and the record is
 * renamed and re-keyed to match, so the tag and the library never drift
 * apart. The old key is dropped when it belongs to this record - the edit
 * says it was never that place's name.
 *
 * @param {object} store
 * @param {string} recordId the record the edited reply points at
 * @param {string} place the location as the edit spelled it
 * @returns {object|null} the renamed record, or null for a missing record or place
 */
export function reconcileRecordPlace(store, recordId, place) {
    const ensured = normalizeStore(store);
    const record = ensured.records?.[String(recordId ?? '').trim()];
    if (!record) return null;

    const normKey = locationKey(place);
    if (!normKey) return null;

    const oldKey = locationKey(record.place);
    if (normKey === oldKey) return record;

    record.place = String(place ?? '').trim() || normKey;
    ensured.keys[normKey] = record.id;
    if (oldKey && ensured.keys[oldKey] === record.id) delete ensured.keys[oldKey];
    if (ensured.currentKey === oldKey) ensured.currentKey = normKey;
    return record;
}

/**
 * Stores a freshly generated background and marks its place current. With
 * `overwrite` the existing record for that place is replaced in place (the
 * brush button's "give me a new one"); without it every call adds a record,
 * even for a place seen before.
 *
 * @param {object} store
 * @param {{key?:string, place:string, prompt:string, path:string, url?:string, overwrite?:boolean, createdAt?:number}} entry
 * @returns {object|null} the stored record, or null when place/path is missing
 */
export function storeRecord(store, {
    key,
    place,
    prompt,
    path,
    url,
    overwrite = false,
    createdAt = Date.now(),
} = {}) {
    const ensured = normalizeStore(store);
    const cleanPlace = String(place ?? key ?? '').trim();
    const normKey = locationKey(key || cleanPlace);
    const cleanPath = String(path ?? '').trim();
    if (!normKey || !cleanPath) return null;

    const existingId = ensured.keys[normKey];
    // "Replace it" only holds when the record IS this place's picture. A
    // record shared by several keys is a fold from the careless-matching
    // days: overwriting it in place would repaint every folded place at
    // once, so the fresh picture takes this key alone and the others keep
    // the record they knew.
    const shared = existingId
        && Object.values(ensured.keys).filter(id => id === existingId).length > 1;
    const reuse = overwrite && existingId && !shared && ensured.records[existingId] ? existingId : null;
    const id = reuse || `bg_${ensured.nextId}`;
    if (!reuse) ensured.nextId += 1;

    const record = {
        id,
        place: cleanPlace || normKey,
        prompt: String(prompt ?? '').trim(),
        path: cleanPath,
        url: url ? String(url).trim() : toCssBgUrl(cleanPath),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };

    ensured.records[id] = record;
    ensured.keys[normKey] = id;
    ensured.currentKey = normKey;
    return record;
}

/**
 * Re-derives `currentKey` from SillyTavern's `chat_metadata.custom_background`
 * when a chat loads. The background on screen is the truth, not our memory of
 * the last reply; when no stored record matches, there is no current place.
 *
 * @param {object} store
 * @param {string|null|undefined} customBgUrl what SillyTavern restored
 * @returns {string|null} the recovered key, or null
 */
export function recoverCurrentKey(store, customBgUrl) {
    const ensured = normalizeStore(store);
    const raw = String(customBgUrl ?? '').trim();
    if (!raw) {
        ensured.currentKey = null;
        return null;
    }

    const existing = currentRecord(ensured);
    if (existing && matchesBgUrl(existing, raw)) return ensured.currentKey;

    for (const [key, id] of Object.entries(ensured.keys)) {
        const record = ensured.records[id];
        if (record && matchesBgUrl(record, raw)) {
            ensured.currentKey = key;
            return key;
        }
    }

    ensured.currentKey = null;
    return null;
}

/**
 * Whether a chat background value belongs to one of this chat's records -
 * in other words, whether the chain (or the brush) is holding the chat's
 * background right now. Tolerates the raw path and the wrapped CSS form.
 *
 * @param {object} store
 * @param {string|null|undefined} customBgUrl
 * @returns {boolean}
 */
export function isOurBackground(store, customBgUrl) {
    if (!store?.records) return false;
    return Object.values(store.records).some(record => matchesBgUrl(record, customBgUrl));
}

/**
 * Records the takeover baseline once per chat: what SillyTavern had on screen
 * before the chain first wrote a background - its lock (`custom_background`)
 * and the shown image - so exiting can hand the chat back exactly as it was
 * found. Recorded at the first write and never rewritten; a chat where the
 * chain already held the background (drawn before this bookkeeping existed)
 * records nothing, because the pre-chain state is unknowable.
 *
 * @param {object} store
 * @param {{lock?:string|null, shown?:string}} found what the takeover found
 * @returns {{lock:string|null, shown:string}|undefined} the stored baseline, or undefined when none can be recorded
 */
export function noteBaseline(store, { lock = null, shown = '' } = {}) {
    const ensured = normalizeStore(store);
    if (ensured.baseline !== undefined) return ensured.baseline;

    const cleanLock = typeof lock === 'string' && lock.trim() ? lock.trim() : null;
    if (cleanLock && isOurBackground(ensured, cleanLock)) return undefined;

    ensured.baseline = {
        lock: cleanLock,
        shown: typeof shown === 'string' ? shown.trim() : '',
    };
    return ensured.baseline;
}

/**
 * What exiting should do about the chat's background: hand back the recorded
 * baseline, fall back to SillyTavern's own unlock for a chat drawn before the
 * baseline existed - or where the baseline holds nothing to hand back, since
 * painting an empty value would leave a hole where the picture was - or stand
 * down because the background on screen is not ours to hand back (the user
 * unlocked it or locked their own while we ran).
 *
 * @param {object} store
 * @param {string|null|undefined} currentLock what `custom_background` holds now
 * @returns {{action:'none'}|{action:'restore', baseline:{lock:string|null, shown:string}}|{action:'unlock'}}
 */
export function restorePlan(store, currentLock) {
    const ensured = normalizeStore(store);
    const lock = typeof currentLock === 'string' && currentLock.trim() ? currentLock.trim() : null;
    if (!lock || !isOurBackground(ensured, lock)) return { action: 'none' };
    if (ensured.baseline !== undefined) {
        const baseline = ensured.baseline;
        if (baseline && (baseline.lock || baseline.shown)) return { action: 'restore', baseline };
        return { action: 'unlock' };
    }
    return { action: 'unlock' };
}

/**
 * The one shape of background value the scene's mirror may hold: an authored
 * CSS `url(...)` as it was written. `getComputedStyle` is no such thing - it
 * reports a running transition as `cross-fade(...)` machine syntax and
 * resolves urls to absolutes; that is valid to read and poison to put back
 * into CSS, where one bad substitution kills the whole declaration. Anything
 * the mirror cannot trust answers null: it keeps the last good picture
 * rather than paint a stranger's.
 *
 * @param {*} value
 * @param {string} [base] resolve the url against this base - the mirror's
 *   values land in our own stylesheet, where relative urls would resolve
 *   against the extension's folder. Empty keeps the value as authored.
 * @returns {string|null} the authored value, or null when unusable
 */
export function sceneUrl(value, base = '') {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || !/^url\(/i.test(clean) || /cross-fade/i.test(clean)) return null;
    if (!base) return clean;

    // The mirror's value lands in OUR stylesheet - where a relative url
    // resolves against the extension's own folder and quietly 404s (the
    // black hole a chat's default background used to fall into). Make it
    // absolute once, here: still an authored url(), just unambiguous.
    const inner = clean.slice(clean.indexOf('(') + 1, clean.lastIndexOf(')')).trim().replace(/^["']|["']$/g, '');
    if (!inner || /^(?:data:|#)/i.test(inner)) return clean;

    try {
        return `url("${new URL(inner, base).href}")`;
    } catch {
        return clean;
    }
}

/* 'Nothing is showing': an empty value, CSS's own none, or SillyTavern's
   transparent placeholder tile - its way of saying no picture. A stranger
   is none of these. */
const NO_PICTURE = /^(?:none|url\(["']?(?:[^"')]*\/)?__transparent\.png["']?\))$/i;

/**
 * Whether a background value means no picture at all. The mirror's fall
 * through to SillyTavern's own default starts here; a true stranger (a value
 * that exists but cannot be mirrored) answers false and keeps the last good
 * picture instead.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isNoPicture(value) {
    const clean = typeof value === 'string' ? value.trim() : '';
    return !clean || NO_PICTURE.test(clean);
}

/**
 * The CSS `url(...)` value SillyTavern's background module expects, wrapped
 * the same way its own force-set handler wraps image paths.
 *
 * @param {string} imagePath
 * @returns {string}
 */
export function toCssBgUrl(imagePath) {
    const path = String(imagePath ?? '').trim();
    return path ? `url("${encodeURI(path)}")` : '';
}

/**
 * A record's picture as a bare src for `<img>` and SVG `<image>`. The record
 * stores `url` in the CSS `url(...)` form the scene's mirror consumes (or a
 * raw url a watcher wrote), and an image element wants neither wrapper - so
 * the wrapper comes off here, once. Falls back to `path`, the file the
 * wrapper was made from.
 *
 * @param {object} record
 * @returns {string} the image src, or '' when the record carries none
 */
export function recordSrc(record) {
    const value = typeof record?.url === 'string' ? record.url.trim() : '';
    const wrapped = /^url\((.*)\)$/is.exec(value);
    const inner = wrapped ? wrapped[1].trim().replace(/^["']|["']$/g, '') : value;
    if (inner) return inner;
    return typeof record?.path === 'string' ? record.path.trim() : '';
}

/**
 * The request's own block tags - a story that carries a look-alike never
 * breaks the block layout (story text is another model's output and may say
 * anything). Place text passes through the same scrub.
 */
const REQUEST_TAG_RE = /<\/?(?:currentBackground|knownBackgrounds|recentPlaces|latestStory|parkingLot|transportInterior)>/gi;

/**
 * A place string as the watcher should see it. The bracket characters a
 * model's echo of the note's example leaves behind are stripped: they read as
 * placeholders and confuse more than they clarify. The request's own block
 * tags are stripped too - story text is untrusted and may carry look-alikes.
 *
 * @param {*} value
 * @returns {string}
 */
export function cleanPlaceText(value) {
    return String(value ?? '')
        .replace(REQUEST_TAG_RE, ' ')
        .replace(/[[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The name to paint by: the most specific segment of a location chain - what
 * follows the last "|" ("Unit 4B - Bedroom" out of "Metro City | Downtown
 * District | Fifth Street Walk-Up | Unit 4B - Bedroom"). The chain before it
 * is wider context only, and a place with no chain is its own short name.
 *
 * @param {*} value
 * @returns {string}
 */
export function placeShortName(value) {
    const clean = cleanPlaceText(value);
    const at = clean.lastIndexOf('|');
    return (at >= 0 ? clean.slice(at + 1) : clean).trim();
}

/**
 * A place as every prompt names it: the short name (the specific spot to
 * paint) first, the chain as its world in brackets. One shape everywhere -
 * the library lines, the story headers, the recent-places timeline - so the
 * reader never mistakes the description for the name.
 *
 * @param {*} value
 * @returns {string}
 */
export function placeLabel(value) {
    const clean = cleanPlaceText(value);
    const short = placeShortName(clean);
    return short ? `${short} [World location: ${clean}]` : '';
}

/** Number words a place name may spell out ("Pier Nine" is "Pier 9"). */
const NAME_NUMBERS = new Map(Object.entries({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
}));

const NAME_STOPWORDS = new Set(['the', 'of', 'a', 'an', 'at', 'in', 'on', 'and', 'or', 'no']);

/** One short name reduced to its comparable parts. */
function nameSignature(value) {
    const text = placeShortName(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tokens = new Set();
    const numbers = new Set();

    for (const word of text.split(' ').filter(Boolean)) {
        for (const run of word.match(/\d+/g) || []) numbers.add(String(Number(run)));
        const letters = word.replace(/\d+/g, '');
        if (!letters) continue;
        if (NAME_NUMBERS.has(letters)) {
            numbers.add(String(NAME_NUMBERS.get(letters)));
            continue;
        }
        if (letters.length >= 2 && !NAME_STOPWORDS.has(letters)) tokens.add(letters);
    }

    return { text, tokens, numbers };
}

function sameNumbers(first, second) {
    if (first.size !== second.size) return false;
    for (const number of first) if (!second.has(number)) return false;
    return true;
}

/**
 * Whether two place names could name the same spot under different spellings:
 * "Pier No9", "Pier 9" and "the ninth pier" are one pier, while "Corridor
 * C-12" and "Corridor C-9" are two corridors and "Landing Pad" and "Kaffe
 * Station" share nothing. The watcher's "same"/"known" answers claim exactly
 * that, so the claim is checked before it folds two locations onto one
 * picture - a careless fold sticks in the keys map and one brush then
 * repaints both places. The rule is deliberately strict: a rejected answer
 * draws a fresh picture (recoverable), a wrong fold merges two places
 * forever.
 *
 * @param {*} a one place, e.g. 'Metro City | Docks | Pier 9'
 * @param {*} b the place it claims to be
 * @returns {boolean}
 */
export function placeNamesLikelySame(a, b) {
    const first = nameSignature(a);
    const second = nameSignature(b);
    if (!first.text || !second.text) return false;
    if (first.text === second.text) return true;

    // Numbers decide before words do: "C-12" and "C-9" share every word
    // but the one that matters.
    if (first.numbers.size && second.numbers.size && !sameNumbers(first.numbers, second.numbers)) return false;

    if (first.text.includes(second.text) || second.text.includes(first.text)) return true;

    for (const token of first.tokens) if (second.tokens.has(token)) return true;
    return false;
}

/**
 * The watcher's menu of images this chat already has: newest first, so it can
 * answer "known" instead of inventing a near-duplicate place. `kind` splits
 * the menu the way the two hands read it: 'place' for the location library,
 * 'transport' for the parking lot - the pools never see each other, so a
 * docking bay can never fold onto a shuttle interior.
 *
 * @param {object} store
 * @param {{limit?:number, kind?:'place'|'transport'}} [options]
 * @returns {Array<{id:string, place:string, prompt:string}>}
 */
export function knownBackgroundsList(store, { limit = 12, kind = '' } = {}) {
    if (!store || typeof store !== 'object') return [];
    const records = Object.values(store.records || {})
        .filter(record => record && typeof record === 'object')
        .filter(record => (kind === 'transport' ? !!record.vehicle : kind === 'place' ? !record.vehicle : true));
    records.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return records.slice(0, Math.max(0, limit)).map(record => ({
        id: record.id,
        place: record.place || '',
        prompt: record.prompt || '',
    }));
}

/* ---------- per-response stamps ---------- */

/**
 * The background one message variant carries: the record id stamped on it, or
 * null. The active variant reads from `message.extra` (the mirror SillyTavern
 * keeps in step around swipes); any variant can be read from its `swipe_info`
 * slot. Stamps are record ids, never image paths - a place has one canonical
 * record, and the brush replaces that record's image everywhere it appears.
 *
 * @param {object} message
 * @param {number|null} [swipeId] the variant to read; the active one by default
 * @returns {string|null}
 */
export function stampOf(message, swipeId = null) {
    if (!message || typeof message !== 'object') return null;

    const slot = swipeId === null || swipeId === undefined
        ? null
        : message.swipe_info?.[Number(swipeId)];

    const fromSlot = slot?.extra?.meziverse?.bg;
    if (typeof fromSlot === 'string' && fromSlot.trim()) return fromSlot.trim();

    const fromExtra = message.extra?.meziverse?.bg;
    return typeof fromExtra === 'string' && fromExtra.trim() ? fromExtra.trim() : null;
}

/**
 * Writes a stamp onto one message variant. Pure mutation of a plain message:
 * the `swipe_info` slot is the variant's own home, and `message.extra` - the
 * live mirror of whatever variant is active - is only touched while that
 * variant IS the active one, so a chain landing mid-swipe can never write its
 * result onto the wrong variant.
 *
 * @param {object} message
 * @param {number} swipeId the variant being stamped
 * @param {string} recordId
 * @returns {boolean} whether anything changed
 */
export function setStamp(message, swipeId, recordId) {
    const id = String(recordId ?? '').trim();
    if (!message || typeof message !== 'object' || !id) return false;

    const slot = message.swipe_info?.[Number(swipeId)];
    let changed = false;

    if (slot && typeof slot === 'object') {
        if (!slot.extra || typeof slot.extra !== 'object') slot.extra = {};
        if (!slot.extra.meziverse || typeof slot.extra.meziverse !== 'object') slot.extra.meziverse = {};
        if (slot.extra.meziverse.bg !== id) {
            slot.extra.meziverse.bg = id;
            changed = true;
        }
    }

    const active = !Array.isArray(message.swipes) || message.swipes.length === 0
        || Number(message.swipe_id ?? 0) === Number(swipeId);
    if (active) {
        if (!message.extra || typeof message.extra !== 'object') message.extra = {};
        if (!message.extra.meziverse || typeof message.extra.meziverse !== 'object') message.extra.meziverse = {};
        if (message.extra.meziverse.bg !== id) {
            message.extra.meziverse.bg = id;
            changed = true;
        }
    }

    return changed;
}

/**
 * The background in effect at one point in the chat: the message's own stamp
 * (its active variant, then the nearest stamped variant - a swipe taken from
 * another variant keeps that variant's picture), then the nearest stamp at or
 * before it, walking back. User turns and gaps inherit the previous reply's
 * image exactly that way - nothing is written on them.
 *
 * @param {Array} messages
 * @param {number} index the message being asked about
 * @returns {{id:string, index:number}|null} the stamp and the message that owns it
 */
export function resolveStampId(messages, index) {
    const list = Array.isArray(messages) ? messages : [];
    const at = Number.isInteger(index) ? Math.min(index, list.length - 1) : list.length - 1;

    const message = list[at];
    if (message) {
        const active = Number(message.swipe_id ?? 0);
        const own = stampOf(message, active);
        if (own) return { id: own, index: at };

        if (Array.isArray(message.swipe_info) && message.swipe_info.length > 1) {
            const order = message.swipe_info
                .map((_, i) => i)
                .filter(i => i !== active)
                .sort((a, b) => Math.abs(a - active) - Math.abs(b - active) || a - b);
            for (const i of order) {
                const id = stampOf(message, i);
                if (id) return { id, index: at };
            }
        }
    }

    for (let i = at - 1; i >= 0; i -= 1) {
        const id = stampOf(list[i]);
        if (id) return { id, index: i };
    }

    return null;
}

/**
 * The record one point in the chat shows, per `resolveStampId` - or null when
 * this chat carries no history yet.
 *
 * @param {object} store
 * @param {Array} messages
 * @param {number} index
 * @returns {object|null}
 */
export function resolveStampRecord(store, messages, index) {
    const hit = resolveStampId(messages, index);
    return (hit && store?.records?.[hit.id]) || null;
}

/**
 * The reply the brush redraws: the shown turn when it is a reply, the nearest
 * reply before it when it is a user turn (user turns own no picture), the
 * chat's end only when nothing was shown. Never some earlier owner of the
 * on-screen picture - the brush redraws the response it was clicked on, and
 * that response keeps the new picture.
 *
 * @param {Array} messages
 * @param {number|null} [at] the shown turn's index; the chat's end by default
 * @returns {number}
 */
export function brushTargetIndex(messages, at = null) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return 0;

    const shown = Number.isInteger(at) ? at : list.length - 1;
    const from = Math.min(shown, list.length - 1);
    for (let i = from; i >= 0; i -= 1) {
        if (!list[i]?.is_user) return i;
    }
    return Math.max(0, list.length - 1);
}

/**
 * What the chain should do about one reply's place: nothing (the reply keeps
 * the picture it carried), apply a cached image (the place was seen before),
 * or ask the watcher (a genuinely new place - or a spelling drift only the
 * LLM can recognise, which it answers with `aliasLocation` instead).
 *
 * `baseline` is the record in effect before the reply being resolved - its
 * own stamp when re-resolving, the story's carried picture otherwise. Given
 * no baseline the on-screen record stands in, which is the same thing for the
 * ordinary end-of-chat flow.
 *
 * @param {object} store
 * @param {string} key the resolved location, e.g. scene placeFull
 * @param {{baseline?:object|null}} [options]
 * @returns {{action:'none'|'apply'|'watch', record:object|null}}
 */
export function decide(store, key, { baseline } = {}) {
    const ensured = normalizeStore(store);
    const normKey = locationKey(key);

    if (!normKey) return { action: 'none', record: null };

    const prior = baseline !== undefined ? baseline : currentRecord(ensured);

    const record = lookupRecord(ensured, normKey);
    if (record) {
        if (prior && record.id === prior.id) return { action: 'none', record: prior };
        return { action: 'apply', record };
    }

    if (prior && normKey === locationKey(prior.place)) return { action: 'none', record: prior };

    return { action: 'watch', record: null };
}

/**
 * The shared resolution table behind both modes: given `decide`'s answer for
 * a tagged reply (or nothing at all, when the story carries no scene tag),
 * what the pipeline may do next, and the pace clock after the reply.
 *
 * Free outcomes - the reply keeps its carried picture ("none") or swaps to a
 * cached one ("apply") - run at any pace: they cost no call and no image, so
 * throttling them would only cost truth. Only the costly half (the watcher
 * and the image it may ask for) waits for the "Background generation pace",
 * and every arriving reply - swipe and edit included - advances the clock.
 * The brush never waits and never counts.
 *
 * @param {{step?:{action:string, record?:object|null}|null, force?:boolean, counter?:number, every?:number}} [options]
 *   `step` is `decide`'s answer, or null for an untagged reply (the
 *   plain-prose fallback has no free outcomes).
 * @returns {{go:'unchanged'|'cached'|'keep'|'watch', record:object|null, counter:number}}
 */
export function planResolution({ step = null, force = false, counter = 0, every = 1 } = {}) {
    // The brush demands a fresh picture outright: it never waits for the
    // pace and never advances the clock.
    if (force) return { go: 'watch', record: null, counter };

    const limit = Math.max(1, Number(every) || 1);
    const next = (Number(counter) || 0) + 1;

    if (step?.action === 'none') return { go: 'unchanged', record: step.record || null, counter: next };
    if (step?.action === 'apply') return { go: 'cached', record: step.record || null, counter: next };

    if (next < limit) return { go: 'keep', record: null, counter: next };
    return { go: 'watch', record: null, counter: 0 };
}

/**
 * Whether a record's image is the one behind SillyTavern's custom-background
 * value. Tolerates the raw path and the wrapped CSS form alike.
 */
function matchesBgUrl(record, customBgUrl) {
    const value = String(customBgUrl ?? '').trim();
    if (!value || !record) return false;
    if (record.url && record.url === value) return true;
    if (record.path && (record.path === value || toCssBgUrl(record.path) === value)) return true;
    return false;
}

/* ---------- the parking lot: transport interiors ---------- */

const EN_ROUTE_RE = /^en[\s-]?route$/i;

/**
 * The vehicle a location chain rides, or null for a place on the ground. The
 * chain grammar puts the vehicle last and its position before it -
 * "... | En Route | CV-7742 Shuttle" is that shuttle on the move - but the
 * read is deliberately loose about where "En Route" sits (the chat LLM
 * misbehaves sometimes): any level naming it turns the scene into a ride, and
 * the level right after it is the vehicle. A chain ending at "En Route" names
 * no vehicle and stays a place.
 *
 * @param {*} value a location chain, e.g. 'Space | Mars | En Route | CV-7742 Shuttle'
 * @returns {{vehicle:string, key:string}|null}
 */
export function transportOf(value) {
    const levels = cleanPlaceText(value).split('|').map(level => level.trim()).filter(Boolean);
    const at = levels.findIndex(level => EN_ROUTE_RE.test(level));
    if (at < 0 || at >= levels.length - 1) return null;

    const vehicle = levels[at + 1];
    const key = locationKey(vehicle);
    return key ? { vehicle, key } : null;
}

/**
 * The parked interior of one vehicle, or null. The parking lot is keyed by
 * the VEHICLE's name - never the travel chain, which changes as the vehicle
 * moves - so every ride of that vehicle shares one interior whatever the
 * chain spelled.
 *
 * @param {object} store
 * @param {string} vehicle e.g. 'CV-7742 Shuttle'
 * @returns {object|null}
 */
export function lookupTransport(store, vehicle) {
    if (!store || typeof store !== 'object') return null;
    const key = locationKey(vehicle);
    if (!key) return null;
    const id = store.transports?.[key];
    return (id && store.records?.[id]) || null;
}

/**
 * Parks one vehicle's interior in the lot. One record per vehicle, always:
 * `overwrite` (the brush) replaces the parked record IN PLACE, so every ride
 * of that vehicle repaints together - change the interior on one response and
 * it changes everywhere. Without it a first parking adds a record.
 *
 * @param {object} store
 * @param {{vehicle:string, place?:string, prompt:string, path:string, overwrite?:boolean, createdAt?:number}} entry
 * @returns {object|null}
 */
export function parkTransport(store, { vehicle, place, prompt, path, overwrite = false, createdAt = Date.now() } = {}) {
    const ensured = normalizeStore(store);
    const name = String(vehicle ?? '').trim();
    const key = locationKey(name);
    const cleanPath = String(path ?? '').trim();
    if (!key || !cleanPath) return null;

    const existingId = ensured.transports[key];
    const reuse = overwrite && existingId && ensured.records[existingId] ? existingId : null;
    const id = reuse || `bg_${ensured.nextId}`;
    if (!reuse) ensured.nextId += 1;

    const record = {
        id,
        vehicle: name,
        place: String(place ?? '').trim() || `En Route | ${name}`,
        prompt: String(prompt ?? '').trim(),
        path: cleanPath,
        url: toCssBgUrl(cleanPath),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };

    ensured.records[id] = record;
    ensured.transports[key] = id;
    return record;
}

/**
 * What the chain should do about one reply's ride: nothing (it already shows
 * this vehicle's interior), apply the parked interior, or ask the watcher
 * (an unparked vehicle - or a spelling drift only the LLM can recognise,
 * which parks the variant's name onto the interior it matched). The ride is
 * decided HERE, by code: the watcher is never asked whether a ride changed.
 *
 * @param {object} store
 * @param {string} vehicle
 * @param {{baseline?:object|null}} [options]
 * @returns {{action:'none'|'apply'|'watch', record:object|null}}
 */
export function decideTransport(store, vehicle, { baseline } = {}) {
    const ensured = normalizeStore(store);
    const record = lookupTransport(ensured, vehicle);
    if (!record) return { action: 'watch', record: null };

    const prior = baseline !== undefined ? baseline : currentRecord(ensured);
    if (prior && record.id === prior.id) return { action: 'none', record: prior };
    return { action: 'apply', record };
}

/**
 * The one-interior-per-vehicle fold, run over the library and the stamps:
 * legacy chats parked a separate interior per travel chain ("Mara's Rest |
 * En Route | X", "Outer Rim | En Route | X"), and every ride must show the
 * one interior - the newest parked wins, the rest leave the library and
 * their stamps follow the winner. Chain keys of rides are dropped outright:
 * the parking lot owns them now. Returns whether anything changed.
 *
 * @param {object} store
 * @param {Array} messages the chat, for the stamps to re-point
 * @returns {boolean}
 */
export function collapseTransports(store, messages) {
    const ensured = normalizeStore(store);
    const list = Array.isArray(messages) ? messages : [];

    const groups = new Map();
    for (const record of Object.values(ensured.records)) {
        const ride = record && typeof record === 'object' ? transportOf(record.place || '') : null;
        if (!ride) continue;
        const group = groups.get(ride.key) || [];
        group.push(record);
        groups.set(ride.key, group);
    }
    if (!groups.size) return false;

    let changed = false;
    const losers = new Map();
    for (const [key, group] of groups) {
        group.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
        const [winner, ...rest] = group;
        if (!winner.vehicle) winner.vehicle = transportOf(winner.place)?.vehicle || winner.place;
        if (ensured.transports[key] !== winner.id) {
            ensured.transports[key] = winner.id;
            changed = true;
        }
        for (const loser of rest) losers.set(loser.id, winner.id);
    }

    for (const key of Object.keys(ensured.keys)) {
        if (transportOf(key)) {
            delete ensured.keys[key];
            changed = true;
        }
    }

    if (losers.size) {
        for (const message of list) {
            if (!message) continue;
            const variants = Math.max(1, Array.isArray(message.swipe_info) ? message.swipe_info.length : 1);
            for (let swipeId = 0; swipeId < variants; swipeId += 1) {
                const id = stampOf(message, swipeId);
                const winner = id && losers.get(id);
                if (winner && setStamp(message, swipeId, winner)) changed = true;
            }
        }
        for (const loserId of losers.keys()) {
            delete ensured.records[loserId];
            changed = true;
        }
    }

    // Every ride reply wears its vehicle's parked interior - a legacy stamp
    // of anything else (a location it passed through, a stale fold) follows
    // the lot, so the parking lot answers "what does this show" everywhere.
    for (const message of list) {
        if (!message || message.is_user) continue;
        const scenes = groupMessageByScene(typeof message.mes === 'string' ? message.mes : '');
        const last = scenes.length ? scenes[scenes.length - 1] : null;
        const ride = last ? transportOf(last.place || '') : null;
        if (!ride) continue;

        const winner = ensured.transports[ride.key];
        if (!winner) continue;

        const variants = Math.max(1, Array.isArray(message.swipe_info) ? message.swipe_info.length : 1);
        for (let swipeId = 0; swipeId < variants; swipeId += 1) {
            if (stampOf(message, swipeId) !== winner && setStamp(message, swipeId, winner)) changed = true;
        }
    }

    return changed;
}

/**
 * The library reduced to what the chat still refers to: every record behind a
 * stamp (any swipe variant) or on screen stays, everything else leaves - the
 * branched-away pictures, the deleted replies', the folds' losers. Ids are
 * never recycled. Image files stay on disk: they live in SillyTavern's shared
 * gallery and another chat may still wear one.
 *
 * @param {object} store
 * @param {Array} messages the branched chat
 * @returns {boolean} whether anything was pruned
 */
export function pruneStore(store, messages) {
    const ensured = normalizeStore(store);
    const list = Array.isArray(messages) ? messages : [];

    const referenced = new Set();
    for (const message of list) {
        if (!message) continue;
        const variants = Math.max(1, Array.isArray(message.swipe_info) ? message.swipe_info.length : 1);
        for (let swipeId = 0; swipeId < variants; swipeId += 1) {
            const id = stampOf(message, swipeId);
            if (id) referenced.add(id);
        }
    }
    const onScreen = ensured.currentKey && ensured.keys[ensured.currentKey];
    if (onScreen) referenced.add(onScreen);

    let changed = false;
    for (const id of Object.keys(ensured.records)) {
        if (referenced.has(id)) continue;
        delete ensured.records[id];
        changed = true;
    }
    if (!changed) return false;

    for (const [key, id] of Object.entries(ensured.keys)) {
        if (!ensured.records[id]) delete ensured.keys[key];
    }
    for (const [key, id] of Object.entries(ensured.transports)) {
        if (!ensured.records[id]) delete ensured.transports[key];
    }
    return true;
}

/* ---------- the watcher's question and answer ---------- */

/**
 * The shape the watcher answers in. The plain-text protocol - a first line of
 * SAME, KNOWN <id> or NEW, then the prompt - is accepted too, because
 * structured output is not available on every connection.
 */
export const WATCHER_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        state: { type: 'string', enum: ['same', 'known', 'new'] },
        knownId: { type: ['string', 'number', 'null'] },
        place: { type: 'string' },
        prompt: { type: 'string' },
    },
    required: ['state', 'knownId', 'place', 'prompt'],
    additionalProperties: false,
});

/**
 * The creative core of the watcher's question, one per hand. These are the
 * parts meant to be tuned: the settings sheet edits copies of them, and the
 * answer format below is appended by code so parsing survives any edit.
 *
 * The scene-tagged hand sees the story grouped by scene blocks and leans on
 * that structure; the plain-prose hand gets raw text, where the location may
 * change inside a single paragraph or hold for many messages.
 */
export const DEFAULT_BG_PROMPT_ON = `You are a background-art assistant for a visual-novel style roleplay. You receive <currentBackground> (the place name and image description shown now), <knownBackgrounds> (the image library this chat has drawn), a <recentPlaces> timeline, and <latestStory> grouped by scene blocks - each block's header names the place, time and weather its narration happens in. The LAST block is where the story is now.

Every place arrives as "short name [World location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of <latestStory> the same place as <currentBackground>? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the <knownBackgrounds>, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the block's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

export const DEFAULT_BG_PROMPT_OFF = `You are a background-art assistant for a visual-novel style roleplay. You receive <currentBackground> (the place name and image description shown now), <knownBackgrounds> (the image library this chat has drawn), a <recentPlaces> timeline, and <latestStory> as plain story text. There are no scene markers here: the location may change abruptly inside a paragraph or stay put for many messages. Read the whole excerpt for where the characters are at its END.

Every place arrives as "short name [World location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of <latestStory> the same place as <currentBackground>? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the <knownBackgrounds>, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the story's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

/**
 * The prompt cores before the request blocks wore their tags (v2.9.4) - kept
 * only so a saved settings copy that followed the default forward can follow
 * the default back (see settings.js).
 */
export const PRIOR_DEFAULT_BG_PROMPT_ON = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY grouped by scene blocks - each block's header names the place, time and weather its narration happens in. The LAST block is where the story is now.

Every place arrives as "short name [Full/world/map location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the block's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

export const PRIOR_DEFAULT_BG_PROMPT_OFF = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY as plain story text. There are no scene markers here: the location may change abruptly inside a paragraph or stay put for many messages. Read the whole excerpt for where the characters are at its END.

Every place arrives as "short name [Full/world/map location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the story's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

/**
 * The prompt cores as the raw-story rewrite (v2.8.1) shipped them - kept
 * only so a saved settings copy that followed that default forward can
 * follow the default back to the scene-grouped design above (see
 * settings.js). The watcher story is v2.8.0\u2019s by design: the same small
 * context on every call - the last reply grouped by scene and stripped to
 * environment - never a window that follows the pace (see Technical.md).
 */
export const LEGACY_DEFAULT_BG_PROMPT_ON = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY as the chat's recent turns exactly as they came - scene tags included, each naming the place, time and weather its narration happens in. The reply to resolve is the last assistant turn; the story is at its END.

Every place arrives as "short name [Full/world/map location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the scene tag's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

export const LEGACY_DEFAULT_BG_PROMPT_OFF = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY as the chat's recent turns exactly as they came - tags and all. There are no scene markers here: the location may change abruptly inside a paragraph or stay put for many messages. Read the whole story for where the characters are at its END.

Every place arrives as "short name [Full/world/map location: ...]": a location chain like Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom. The short name - the part after the last "|" - is the specific place to paint; the chain before it (region, city, district, street) is the world the place lives in: the short name decides what to paint, the chain decides how it looks - architecture, materials, vegetation, cultural details, era and climate follow the world named first. A suburb of Las Vegas, a street in Pyongyang and a village in a high-fantasy realm must never share the same buildings.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the story's time of day and weather when stated; anchor the place's style on the location chain's world - buildings, materials, colors, vegetation and signage follow the region, and invented worlds take their visual identity from the names and the story's own words; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

const WATCHER_FORMAT = `Answer with one JSON object and nothing else:
{"state":"same|known|new","knownId":null,"place":"short name of the current place","prompt":"image prompt or empty"}`;

const WATCHER_FORCE = 'The user asked for a fresh image of the place the story is at now: answer "new" with a fresh description even when the place matches a known background.';

/**
 * The watcher's system prompt: the editable core for the hand (or the
 * default core when none is set), with the answer format always appended.
 * With `force` (the brush button) it must draw something even when nothing
 * changed, so matching is switched off.
 *
 * @param {{tagged?:boolean, force?:boolean, core?:string}} [options]
 * @returns {string}
 */
export function watcherSystemPrompt({ tagged = true, force = false, core = '' } = {}) {
    const base = String(core ?? '').trim() || (tagged ? DEFAULT_BG_PROMPT_ON : DEFAULT_BG_PROMPT_OFF);
    return force
        ? `${base}\n\n${WATCHER_FORMAT}\n\n${WATCHER_FORCE}`
        : `${base}\n\n${WATCHER_FORMAT}`;
}

/**
 * The transport hand's core: the scene is INSIDE a vehicle on the move. The
 * creative part is tunable like the others; the interior rule below it is
 * protocol and appended by code - it must never be edited away, or the same
 * shuttle gets a different cabin in every town it passes.
 */
export const DEFAULT_BG_TRANSPORT_PROMPT = `You are a background-art assistant for a visual-novel style roleplay. The scene happens inside a transport medium - a vehicle or moving space named at the end of the location chain ("... | En Route | CV-7742 Shuttle"). You receive the TRANSPORT TO PAINT, the PARKING LOT (the transport interiors this chat has already drawn), and the LATEST STORY grouped by scene blocks.

VERIFY first: is the transport to paint one of the parked vehicles? Vehicle names are free text written by another model: judge by meaning, not by spelling. If it is the same vehicle, answer state "known" with that vehicle's id.

Otherwise answer state "new" and write an image prompt describing ONLY the vehicle's interior as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see inside - the space, materials, seats or fittings, instruments, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the interior is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting on the block's time of day when stated; anchor the vehicle's style on the world named first in its location chain; the prompt is always a visual description - never a location chain, a place name, or any text you received verbatim; style and quality words are appended for you - never include them; never mention "background" or anything about prompts. Output only the description in "prompt".`;

const WATCHER_TRANSPORT_FORMAT = `Answer with one JSON object and nothing else:
{"state":"known|new","knownId":null,"place":"vehicle name","prompt":"interior description or empty"}`;

const TRANSPORT_INTERIOR = 'This scene takes place INSIDE a transport medium while it moves - the interior is all there is. The description must be the vehicle\'s INTERIOR and nothing else: it must never change wherever the vehicle travels, never show the outside, the scenery, or any location. Vehicle identity is decided by meaning: "CV 7742", "CV-7742" and "CV-7742 Shuttle" may all be one vehicle.';

const WATCHER_TRANSPORT_FORCE = 'The user asked for a fresh image of this vehicle\u2019s interior: answer "new" with a fresh interior description even when it matches a parked vehicle.';

/**
 * The transport hand's system prompt: the editable core with the interior
 * rule and the answer format appended by code. `force` (the brush) switches
 * matching off - the retry must paint.
 *
 * @param {{force?:boolean, core?:string}} [options]
 * @returns {string}
 */
export function watcherTransportSystemPrompt({ force = false, core = '' } = {}) {
    const base = String(core ?? '').trim() || DEFAULT_BG_TRANSPORT_PROMPT;
    return force
        ? `${base}\n\n${TRANSPORT_INTERIOR}\n\n${WATCHER_TRANSPORT_FORMAT}\n\n${WATCHER_TRANSPORT_FORCE}`
        : `${base}\n\n${TRANSPORT_INTERIOR}\n\n${WATCHER_TRANSPORT_FORMAT}`;
}

/**
 * The transport hand's question: the vehicle to paint, the parking lot (the
 * interiors this chat already holds - the menu it matches names against),
 * and the story, for the world the interior lives in. The location library
 * never appears here, and this hand never asks "same": a reply boarding from
 * a location must never inherit the place it left.
 *
 * @param {{store:object, messages:Array, at?:number, persona?:string, vehicle:string, place?:string, force?:boolean, systemCore?:string}} options
 * @returns {{systemPrompt:string, prompt:string, jsonSchema:object}}
 */
export function buildTransportRequest({ store, messages, at, persona = '', vehicle, place = '', force = false, systemCore = '' } = {}) {
    const blocks = [];

    blocks.push(`<transportInterior>\n${placeLabel(place || vehicle)} - paint its INTERIOR\n</transportInterior>`);

    const known = knownBackgroundsList(store, { limit: 12, kind: 'transport' });
    blocks.push(`<parkingLot>\nPARKING LOT (TRANSPORT INTERIORS)\n${known.length
        ? known.map(entry => `- ${entry.id}: ${placeLabel(entry.place)}, Description: ${entry.prompt}`).join('\n')
        : 'none'}\n</parkingLot>`);

    blocks.push(`<latestStory>\n${formatLatestStory(messages, { tagged: true, count: BG_STORY_REPLIES, at, persona }) || 'empty'}\n</latestStory>`);

    return {
        systemPrompt: watcherTransportSystemPrompt({ force, core: systemCore }),
        prompt: blocks.join('\n\n'),
        jsonSchema: WATCHER_SCHEMA,
    };
}

/**
 * Splits one message at its complete scene tags, so narration arrives grouped
 * by the place it happens in. The tag's own place, clock and weather ride
 * along with each group. Text before the first scene tag is its own group with
 * no place - it belongs to wherever the story was before.
 *
 * The message is stripped first (see `stripNonSceneTags`), so what lands in
 * the groups is the narration and the scene tags, nothing else.
 *
 * @param {string} mes
 * @returns {Array<{place:string, date:string, time:string, weather:string, text:string}>}
 */
export function groupMessageByScene(mes) {
    const clean = stripNonSceneTags(typeof mes === 'string' ? mes : '');
    const tags = parseTags(clean).filter(tag => tag.name === 'scene' && tag.closed);

    const groups = [];
    let cursor = 0;
    let current = null;

    for (const tag of tags) {
        const lead = clean.slice(cursor, tag.start).trim();
        if (current) {
            current.text = [current.text, lead].filter(Boolean).join('\n');
        } else if (lead) {
            groups.push({ place: '', date: '', time: '', weather: '', text: lead });
        }

        const scene = describeScene(tag);
        current = {
            place: scene.placeFull || '',
            date: scene.date || '',
            time: scene.time || '',
            weather: scene.weather || '',
            text: '',
        };
        groups.push(current);
        cursor = tag.end;
    }

    const tail = clean.slice(cursor).trim();
    if (current) {
        current.text = [current.text, tail].filter(Boolean).join('\n');
    } else if (tail) {
        groups.push({ place: '', date: '', time: '', weather: '', text: tail });
    }

    return groups;
}

/**
 * The place-name timeline of the latest replies, oldest first: where the
 * story has been, so the watcher can feel a hop like "meanwhile, back at..."
 * without seeing those messages in full.
 *
 * @param {Array<{mes:string}>} messages
 * @param {{limit?:number, at?:number, persona?:string}} [options]
 * @returns {string[]}
 */
export function extractRecentPlaces(messages, { limit = 6, at, persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];
    let index = Number.isInteger(at) ? Math.min(at, list.length - 1) : list.length - 1;

    for (; index >= 0 && out.length < limit; index -= 1) {
        const scenes = describeScenes(list[index], { persona });
        if (!scenes.length) continue;
        const place = scenes[scenes.length - 1].scene.placeFull || '';
        if (place && out[0] !== place) out.unshift(place);
    }

    return out;
}

/**
 * The story excerpt the watcher reads.
 *
 * Tagged: narration grouped by scene, the tag's place, clock and weather on
 * each group's header line. The last group is the current place. Untagged
 * prose has no tags to group by, so the text goes in raw - nothing stripped,
 * because in untagged prose anything may carry the location.
 *
 * @param {Array<{mes:string}>} messages
 * @param {{tagged?:boolean, count?:number, at?:number, persona?:string}} [options]
 * @returns {string}
 */
export function formatLatestStory(messages, { tagged = true, count = BG_STORY_REPLIES, at, persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const end = Number.isInteger(at) ? Math.min(at, list.length - 1) : list.length - 1;
    const start = Math.max(0, end - Math.max(1, count) + 1);

    const turns = [];
    for (let i = start; i <= end; i += 1) {
        const mes = typeof list[i]?.mes === 'string' ? list[i].mes : '';
        if (!mes.trim()) continue;

        if (!tagged) {
            turns.push(mes.trim());
            continue;
        }

        const blocks = [];
        for (const group of groupMessageByScene(mes)) {
            // Clean of the note example's bracket echo: raw "[...]" reads as a
            // placeholder and invites the model to answer with it verbatim.
            const when = [group.date && group.time ? `${group.date}, ${group.time}` : (group.date || group.time), group.weather]
                .map(cleanPlaceText)
                .filter(Boolean)
                .join(', ');
            const header = group.place ? `SCENE: ${placeLabel(group.place)}${when ? ` (${when})` : ''}` : '';
            blocks.push([header, group.text].filter(Boolean).join('\n'));
        }
        if (blocks.length) turns.push(blocks.join('\n'));
    }

    return turns.join('\n\n');
}

/**
 * How much story the watcher reads: the reply being resolved and nothing
 * older - the image prompts are ours to keep robust, not a user's choice.
 * (The finetuning knob: 2, for slow-paced roleplays.)
 */
export const BG_STORY_REPLIES = 1;

/**
 * The watcher's whole question: what the reply carried in, what this chat
 * already has, where the story has been, and the story up to the reply being
 * resolved. Everything is scoped to `at` - a run that lands late still asks
 * about its own reply, not the chat's end.
 *
 * @param {{store:object, messages:Array, tagged?:boolean, count?:number, at?:number, persona?:string, force?:boolean, systemCore?:string, current?:object|null}} options
 * @returns {{systemPrompt:string, prompt:string, jsonSchema:object}}
 */
export function buildWatcherRequest({ store, messages, tagged = true, count = BG_STORY_REPLIES, at, persona = '', force = false, systemCore = '', current } = {}) {
    const blocks = [];

    // Every block wears its own tags and every place reads "short name
    // [World location: ...]", with the image description behind an explicit
    // "Description:" - so the watcher never mistakes the description for the
    // name (or answers with a location string), and the leaf it must paint is
    // always the first thing it reads.
    const shown = current !== undefined ? current : currentRecord(store);
    blocks.push(`<currentBackground>\n${shown ? `${placeLabel(shown.place)}, Description: ${shown.prompt}` : 'none yet'}\n</currentBackground>`);

    const known = knownBackgroundsList(store, { limit: 12, kind: 'place' });
    blocks.push(`<knownBackgrounds>\nKNOWN BACKGROUNDS (IMAGE LIBRARY)\n${known.length
        ? known.map(entry => `- ${entry.id}: ${placeLabel(entry.place)}, Description: ${entry.prompt}`).join('\n')
        : 'none'}\n</knownBackgrounds>`);

    const places = tagged
        ? extractRecentPlaces(messages, { limit: 6, at, persona })
        : knownBackgroundsList(store, { limit: 6, kind: 'place' }).map(entry => entry.place).reverse();
    blocks.push(`<recentPlaces>\n${places.length ? places.map(placeLabel).join(' -> ') : 'unknown'}\n</recentPlaces>`);

    blocks.push(`<latestStory>\n${formatLatestStory(messages, { tagged, count, at, persona }) || 'empty'}\n</latestStory>`);

    return {
        systemPrompt: watcherSystemPrompt({ tagged, force, core: systemCore }),
        prompt: blocks.join('\n\n'),
        // No responseLength: on providers that count the prompt against the
        // budget, a cap this request can afford starves the answer to
        // nothing ("No message generated"). The global response length is
        // used instead.
        jsonSchema: WATCHER_SCHEMA,
    };
}

/**
 * The final image prompt: the watcher's description under our style suffix.
 * SillyTavern's Image Generation adds its own quality prefix on top.
 *
 * @param {string} description what the watcher wrote
 * @param {string} style the user's style suffix (settings.bgStyle)
 * @returns {string}
 */
export function compileBgPrompt(description, style = '') {
    const desc = String(description ?? '').trim().replace(/[.,;]+$/, '');
    const prefix = String(style ?? '').trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    // The style rides in on the description already when the watcher echoes
    // what the known-backgrounds menu showed it: never stack it twice.
    if (prefix && desc.toLowerCase().startsWith(prefix.toLowerCase())) return desc;
    return [prefix, desc].filter(Boolean).join(', ');
}

/**
 * The clock as an image model wants it: a day-part for the lighting, never a
 * calendar stamp ("Friday, March 16, 2347 09:58" is noise in a picture).
 */
function dayPart(time) {
    const match = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(time ?? ''));
    if (!match) return '';

    let hour = Number(match[1]) % 24;
    const suffix = (match[3] || '').toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;

    if (hour >= 5 && hour <= 9) return 'morning light';
    if (hour >= 10 && hour <= 15) return 'daylight';
    if (hour >= 16 && hour <= 19) return 'evening light';
    return 'night';
}

/**
 * The deterministic description used when the watcher call fails but the tags
 * still know where the story is: better a plain picture of the place than no
 * picture at all. The shape is the image model's, not the map's: the specific
 * spot first, its world as plain words after it (a "|" chain is noise in a
 * picture), the weather and the day-part for the light, then the shot tags.
 *
 * @param {object|string} scene a scene record, or a place name
 * @returns {string}
 */
export function fallbackLocationPrompt(scene) {
    const record = scene && typeof scene === 'object' ? scene : { placeFull: String(scene ?? '') };
    const place = String(record.placeFull || record.place || '').trim();

    const levels = cleanPlaceText(place).split('|').map(level => level.trim()).filter(Boolean);
    const leaf = levels.length ? levels[levels.length - 1] : place;
    const world = levels.slice(0, -1).reverse();

    return [
        leaf,
        ...world,
        cleanPlaceText(record.weather || ''),
        dayPart(record.time),
        'wide establishing shot',
        'empty place, detailed environment',
    ].filter(Boolean).join(', ');
}

/**
 * The transport hand's deterministic description - the same job as
 * `fallbackLocationPrompt`, for a ride whose watcher call failed: the
 * INTERIOR first and always (it must not change wherever the vehicle
 * travels), its world as plain words after it, then the light and the shot
 * tags.
 *
 * @param {object|string} scene a scene record, or a place name
 * @returns {string}
 */
export function fallbackTransportPrompt(scene) {
    const record = scene && typeof scene === 'object' ? scene : { placeFull: String(scene ?? '') };
    const place = String(record.placeFull || record.place || '').trim();

    const ride = transportOf(place);
    const vehicle = ride?.vehicle || placeShortName(place);
    const levels = cleanPlaceText(place).split('|').map(level => level.trim()).filter(Boolean);
    const at = levels.findIndex(level => EN_ROUTE_RE.test(level));
    const world = (at >= 0 ? levels.slice(0, at) : levels.slice(0, -1)).reverse();

    return [
        `interior of ${vehicle}`,
        'vehicle interior',
        ...world,
        cleanPlaceText(record.weather || ''),
        dayPart(record.time),
        'wide establishing shot',
        'empty place, detailed environment',
    ].filter(Boolean).join(', ');
}

/**
 * The watcher's answer, from whatever shape it came in: the JSON object, or
 * the plain-text protocol (a first line of SAME, KNOWN <id> or NEW, then the
 * prompt). A reply that is just a description counts as "new" with that
 * description - the graceful failure worth honoring. Null means nothing
 * usable came back.
 *
 * @param {string} raw
 * @returns {{state:'same'|'known'|'new', knownId:string|null, place:string, prompt:string}|null}
 */
export function parseWatcherReply(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    const json = extractJsonObject(text);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
        const state = normalizeState(json.state);
        if (!state) return null;

        const knownId = json.knownId === null || json.knownId === undefined ? '' : String(json.knownId).trim();
        return {
            state,
            knownId: knownId || null,
            place: String(json.place ?? '').trim(),
            prompt: String(json.prompt ?? '').trim(),
        };
    }

    const [head, ...rest] = text.split(/\r?\n/);
    const body = rest.join('\n').trim();

    if (/^same\b/i.test(head.trim())) return { state: 'same', knownId: null, place: '', prompt: '' };
    const known = /^known\b[\s:,-]*(\S+)/i.exec(head.trim());
    if (known) return { state: 'known', knownId: known[1], place: '', prompt: body };
    if (/^new\b/i.test(head.trim())) return { state: 'new', knownId: null, place: '', prompt: body || text };

    return { state: 'new', knownId: null, place: '', prompt: text };
}

/** Maps whatever word the watcher used onto the three states it may mean. */
function normalizeState(value) {
    const state = String(value ?? '').trim().toLowerCase();
    if (state === 'same' || state === 'unchanged') return 'same';
    if (state === 'known' || state === 'match' || state === 'reuse') return 'known';
    if (state === 'new' || state === 'changed' || state === 'generate') return 'new';
    return null;
}

/**
 * The first balanced `{...}` object in a text, parsed - tolerating fences and
 * prose wrapped around it.
 */
function extractJsonObject(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inString && ch === '\\') {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}
