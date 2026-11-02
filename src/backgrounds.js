/**
 * Location backgrounds: the per-chat place cache, and the pure decisions the
 * background chain makes with it.
 *
 * Pure like scene.js - the store is a plain object that lives in
 * `chatMetadata.meziverse.bg` (SillyTavern persists it for us), and nothing
 * here touches the DOM, the network, or SillyTavern itself. On top of this
 * layer the runtime chain adds three things: the watcher LLM call that
 * verifies whether the place actually changed and writes image prompts, image
 * generation through SillyTavern's Image Generation, and setting the result as
 * the chat background.
 *
 * One rule shapes everything below: string comparison is only a skip-gate,
 * never the change-detector. Tags are free text written by an LLM - "Pier 9"
 * and "Pier No9" may be the same place - so an exact key match skips the
 * watcher for free, while any difference is verified by meaning before a new
 * image is ever generated.
 */

import { splitLocation } from './scene.js';

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
 * @returns {{version:number, currentKey:string|null, keys:Record<string,string>, records:Record<string,object>, nextId:number}}
 */
export function normalizeStore(raw) {
    const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    store.version = BG_STORE_VERSION;

    if (typeof store.currentKey !== 'string' || !store.currentKey.trim()) {
        store.currentKey = null;
    } else {
        store.currentKey = locationKey(store.currentKey);
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

/**
 * What the chain should do about the place the story is at now: nothing (it is
 * already on screen), apply a cached image (the place was seen before), or ask
 * the watcher (a genuinely new place - or a spelling drift only the LLM can
 * recognise, which it answers with `aliasLocation` instead).
 *
 * @param {object} store
 * @param {string} key the resolved location, e.g. scene placeFull
 * @returns {{action:'none'|'apply'|'watch', record:object|null}}
 */
export function decide(store, key) {
    const ensured = normalizeStore(store);
    const normKey = locationKey(key);

    if (!normKey) return { action: 'none', record: null };
    if (normKey === ensured.currentKey) return { action: 'none', record: currentRecord(ensured) };

    const record = lookupRecord(ensured, normKey);
    if (record) return { action: 'apply', record };

    return { action: 'watch', record: null };
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
