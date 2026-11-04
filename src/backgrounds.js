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
    const reuse = overwrite && existingId && ensured.records[existingId] ? existingId : null;
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
 * baseline existed, or stand down because the background on screen is not
 * ours to hand back (the user unlocked it or locked their own while we ran).
 *
 * @param {object} store
 * @param {string|null|undefined} currentLock what `custom_background` holds now
 * @returns {{action:'none'}|{action:'restore', baseline:{lock:string|null, shown:string}}|{action:'unlock'}}
 */
export function restorePlan(store, currentLock) {
    const ensured = normalizeStore(store);
    const lock = typeof currentLock === 'string' && currentLock.trim() ? currentLock.trim() : null;
    if (!lock || !isOurBackground(ensured, lock)) return { action: 'none' };
    if (ensured.baseline !== undefined) return { action: 'restore', baseline: ensured.baseline };
    return { action: 'unlock' };
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
 * The watcher's menu of images this chat already has: newest first, so it can
 * answer "known" instead of inventing a near-duplicate place.
 *
 * @param {object} store
 * @param {{limit?:number}} [options]
 * @returns {Array<{id:string, place:string, prompt:string}>}
 */
export function knownBackgroundsList(store, { limit = 12 } = {}) {
    if (!store || typeof store !== 'object') return [];
    const records = Object.values(store.records || {}).filter(record => record && typeof record === 'object');
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
export const DEFAULT_BG_PROMPT_ON = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY grouped by scene blocks - each block's header names the place, time and weather its narration happens in. The LAST block is where the story is now.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the block's time of day and weather when stated; never mention "background", styles, quality tags or anything about prompts. Output only the description in "prompt".`;

export const DEFAULT_BG_PROMPT_OFF = `You are a background-art assistant for a visual-novel style roleplay. You receive the CURRENT BACKGROUND (the place name and image description shown now), a list of KNOWN BACKGROUNDS, a RECENT PLACES timeline, and the LATEST STORY as plain story text. There are no scene markers here: the location may change abruptly inside a paragraph or stay put for many messages. Read the whole excerpt for where the characters are at its END.

VERIFY first: is the place at the end of the LATEST STORY the same place as the CURRENT BACKGROUND? Place names are free text written by another model: "Pier No9", "Pier 9" and "the ninth pier" may all be the same place. Judge by meaning, not by spelling. If it is the same place, answer state "same".

If the place is genuinely different but clearly equals one of the KNOWN BACKGROUNDS, answer state "known" with that background's id.

Otherwise answer state "new" and write an image prompt that describes ONLY the current place as an establishing shot for a visual-novel background. You write prompts for a text-to-image model: describe what a camera would see at that place - the space, architecture, objects, materials, weather, time of day, lighting, mood, and a clear vantage point. Rules: 40 to 90 words of comma-separated visual phrases; the place is the subject - no characters, no people, no silhouettes, no names, no actions, no emotions, no sounds; anchor lighting and sky on the story's time of day and weather when stated; never mention "background", styles, quality tags or anything about prompts. Output only the description in "prompt".`;

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
            const when = [group.date && group.time ? `${group.date}, ${group.time}` : (group.date || group.time), group.weather]
                .filter(Boolean)
                .join(', ');
            const header = group.place ? `SCENE: ${group.place}${when ? ` (${when})` : ''}` : '';
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
 * @returns {{systemPrompt:string, prompt:string, responseLength:number, jsonSchema:object}}
 */
export function buildWatcherRequest({ store, messages, tagged = true, count = BG_STORY_REPLIES, at, persona = '', force = false, systemCore = '', current } = {}) {
    const blocks = [];

    const shown = current !== undefined ? current : currentRecord(store);
    blocks.push(`CURRENT BACKGROUND\n${shown ? `${shown.place}\n${shown.prompt}` : 'none yet'}`);

    const known = knownBackgroundsList(store, { limit: 12 });
    blocks.push(`KNOWN BACKGROUNDS\n${known.length
        ? known.map(entry => `- ${entry.id}: ${entry.place} - ${excerpt(entry.prompt, 200)}`).join('\n')
        : 'none'}`);

    const places = tagged
        ? extractRecentPlaces(messages, { limit: 6, at, persona })
        : knownBackgroundsList(store, { limit: 6 }).map(entry => entry.place).reverse();
    blocks.push(`RECENT PLACES\n${places.length ? places.join(' -> ') : 'unknown'}`);

    blocks.push(`LATEST STORY\n${formatLatestStory(messages, { tagged, count, at, persona }) || 'empty'}`);

    return {
        systemPrompt: watcherSystemPrompt({ tagged, force, core: systemCore }),
        prompt: blocks.join('\n\n'),
        responseLength: 600,
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
    return [prefix, desc].filter(Boolean).join(', ');
}

/**
 * The deterministic description used when the watcher call fails but the tags
 * still know where the story is: better a plain picture of the place than no
 * picture at all.
 *
 * @param {object|string} scene a scene record, or a place name
 * @returns {string}
 */
export function fallbackLocationPrompt(scene) {
    const record = scene && typeof scene === 'object' ? scene : { placeFull: String(scene ?? '') };
    const place = String(record.placeFull || record.place || '').trim();
    const when = [record.date || '', record.time || ''].filter(Boolean).join(' ');
    return [place, when, record.weather || '', 'wide establishing shot', 'empty place, detailed environment']
        .filter(Boolean)
        .join(', ');
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

/** A prompt shortened at a word boundary, for the known-backgrounds menu. */
function excerpt(value, max) {
    const text = String(value ?? '').trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const boundary = cut.lastIndexOf(' ');
    return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).trim()}...`;
}
