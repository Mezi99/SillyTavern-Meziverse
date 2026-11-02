/**
 * Location backgrounds — state, cache, scene-grouped excerpt building, and
 * watcher reply parsing.
 *
 * The pure helpers at the top do not touch the DOM or SillyTavern and are
 * tested directly in `test/backgrounds.test.js`. Runtime wiring (ST glue and
 * triggers) plugs in on top of them.
 */

import { parseTags, stripNonSceneTags, stripTags } from './tags.js';
import { describeScene, describeScenes, isUsableScene, splitLocation } from './scene.js';

export const BG_STORE_VERSION = 1;

export const LANDSCAPE_SIZE = Object.freeze({
    width: 1216,
    height: 832,
});

/**
 * Normalizes a location string into a stable lookup key.
 *
 * `"The city |  Docks | Pier 9 "` and `"the city | docks | pier 9"` fold to
 * the same key (`"the city | docks | pier 9"`).
 *
 * @param {string} value
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
 * Ensures a valid chat-scoped background store object. Mutates `raw` in place
 * when an object is passed so writes on `chatMetadata.meziverse.bg` stay live.
 *
 * @param {object} [raw]
 * @returns {{version:number, currentKey:string|null, keys:Record<string,string>, records:Record<string,{id:string,place:string,prompt:string,path:string,url:string,createdAt:number}>, nextId:number}}
 */
export function normalizeBgStore(raw) {
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

    let maxNumericId = 0;
    for (const [id, rec] of Object.entries(store.records)) {
        if (!rec || typeof rec !== 'object') {
            delete store.records[id];
            continue;
        }
        const match = /^bg_(\d+)$/.exec(id);
        if (match) maxNumericId = Math.max(maxNumericId, Number(match[1]));
    }

    for (const [k, id] of Object.entries(store.keys)) {
        const normKey = locationKey(k);
        if (!normKey || typeof id !== 'string' || !store.records[id]) {
            delete store.keys[k];
            continue;
        }
        if (normKey !== k) {
            delete store.keys[k];
            store.keys[normKey] = id;
        }
    }

    if (store.currentKey && !store.keys[store.currentKey]) {
        store.currentKey = null;
    }

    const next = Number.isInteger(store.nextId) && store.nextId > maxNumericId
        ? store.nextId
        : maxNumericId + 1;
    store.nextId = Math.max(1, next);

    return store;
}

/**
 * Looks up a cached background record by location string or normalized key.
 *
 * @param {object} store
 * @param {string} placeOrKey
 * @returns {{id:string,place:string,prompt:string,path:string,url:string,createdAt:number}|null}
 */
export function lookupRecord(store, placeOrKey) {
    if (!store || typeof store !== 'object') return null;
    const key = locationKey(placeOrKey);
    if (!key) return null;
    const id = store.keys?.[key];
    if (!id) return null;
    return store.records?.[id] || null;
}

/**
 * Returns the record currently active on screen, or null.
 *
 * @param {object} store
 */
export function currentRecord(store) {
    if (!store || !store.currentKey) return null;
    return lookupRecord(store, store.currentKey);
}

/**
 * Aliases a location key (e.g. a spelling variant or matched location) to an
 * existing record id and marks it as the current key.
 *
 * @param {object} store
 * @param {string} placeOrKey
 * @param {string|number} targetId
 * @returns {{id:string,place:string,prompt:string,path:string,url:string,createdAt:number}|null}
 */
export function aliasLocation(store, placeOrKey, targetId) {
    const ensured = normalizeBgStore(store);
    const key = locationKey(placeOrKey);
    if (!key) return null;

    const id = resolveRecordId(ensured, targetId);
    if (!id || !ensured.records[id]) return null;

    ensured.keys[key] = id;
    ensured.currentKey = key;
    return ensured.records[id];
}

/**
 * Resolves a record id such as `'bg_3'`, `'3'`, or `3` against `store.records`.
 *
 * @param {object} store
 * @param {string|number|null|undefined} rawId
 * @returns {string|null}
 */
export function resolveRecordId(store, rawId) {
    if (rawId === null || rawId === undefined) return null;
    const str = String(rawId).trim();
    if (!str) return null;
    if (store?.records?.[str]) return str;
    const digits = /^(\d+)$/.exec(str);
    if (digits) {
        const candidate = `bg_${digits[1]}`;
        if (store?.records?.[candidate]) return candidate;
    }
    return null;
}

/**
 * Stores a newly generated background record (or overwrites the existing one
 * for `key` when `overwrite` is true) and marks `key` as current.
 *
 * @param {object} store
 * @param {{key?:string, place:string, prompt:string, path:string, url?:string, overwrite?:boolean, createdAt?:number}} entry
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
    const ensured = normalizeBgStore(store);
    const cleanPlace = String(place ?? key ?? '').trim();
    const normKey = locationKey(key || cleanPlace);
    const cleanPath = String(path ?? '').trim();
    if (!normKey || !cleanPath) return null;

    const cleanUrl = url ? String(url).trim() : toCssBgUrl(cleanPath);
    const existingId = ensured.keys[normKey];
    let id;

    if (overwrite && existingId && ensured.records[existingId]) {
        id = existingId;
    } else {
        id = `bg_${ensured.nextId}`;
        ensured.nextId += 1;
    }

    const record = {
        id,
        place: cleanPlace || normKey,
        prompt: String(prompt ?? '').trim(),
        path: cleanPath,
        url: cleanUrl,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };

    ensured.records[id] = record;
    ensured.keys[normKey] = id;
    ensured.currentKey = normKey;
    return record;
}

/**
 * Re-derives `currentKey` from SillyTavern's `chat_metadata.custom_background`
 * when a chat loads. If no stored record matches, `currentKey` becomes `null`.
 *
 * @param {object} store
 * @param {string|null|undefined} customBgUrl
 * @returns {string|null}
 */
export function recoverCurrentKey(store, customBgUrl) {
    const ensured = normalizeBgStore(store);
    const raw = String(customBgUrl ?? '').trim();
    if (!raw) {
        ensured.currentKey = null;
        return null;
    }

    // If currentKey already points at a matching record, keep it.
    const existing = currentRecord(ensured);
    if (existing && matchesBgUrl(existing, raw)) {
        return ensured.currentKey;
    }

    for (const [key, id] of Object.entries(ensured.keys)) {
        const rec = ensured.records[id];
        if (rec && matchesBgUrl(rec, raw)) {
            ensured.currentKey = key;
            return key;
        }
    }

    ensured.currentKey = null;
    return null;
}

function matchesBgUrl(record, customBgUrl) {
    if (!record) return false;
    if (record.url === customBgUrl || record.path === customBgUrl) return true;
    if (toCssBgUrl(record.path) === customBgUrl) return true;
    return false;
}

/**
 * Formats an image path as the CSS `url("...")` string ST stores in
 * `chat_metadata.custom_background`.
 *
 * @param {string} imagePath
 * @returns {string}
 */
export function toCssBgUrl(imagePath) {
    const raw = String(imagePath ?? '').trim();
    if (!raw) return '';
    if (/^url\(/i.test(raw)) return raw;
    return `url("${encodeURI(raw)}")`;
}

/**
 * Returns the most recent known background records (capped at `limit`).
 *
 * @param {object} store
 * @param {{limit?:number}} [options]
 */
export function knownBackgroundsList(store, { limit = 12 } = {}) {
    if (!store?.records || typeof store.records !== 'object') return [];
    const list = Object.values(store.records).filter(rec => rec && typeof rec === 'object' && rec.id);
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list.slice(0, Math.max(0, limit));
}

/* ---------- Story & scene grouping ---------- */

/**
 * Splits a message (after stripping all non-scene tags) into sequential scene
 * blocks so the watcher sees `<scene .../>` paired with the narration that
 * belongs to that location.
 *
 * @param {string} mes
 * @param {{persona?:string}} [options]
 * @returns {Array<{scene:object|null, rawTag:string, prose:string}>}
 */
export function groupMessageByScene(mes, { persona = '' } = {}) {
    const cleaned = stripNonSceneTags(mes);
    const tags = parseTags(cleaned);
    const blocks = [];

    let cursor = 0;
    let currentScene = null;
    let currentRawTag = '';

    for (const tag of tags) {
        if (tag.name !== 'scene' || !tag.closed) continue;

        const before = cleaned.slice(cursor, tag.start).trim();
        if (before || currentRawTag) {
            blocks.push({
                scene: currentScene,
                rawTag: currentRawTag,
                prose: before,
            });
        }

        currentRawTag = cleaned.slice(tag.start, tag.end);
        currentScene = isUsableScene(tag) ? describeScene(tag, { persona }) : null;
        cursor = tag.end;
    }

    const tail = cleaned.slice(cursor).trim();
    if (tail || currentRawTag) {
        blocks.push({
            scene: currentScene,
            rawTag: currentRawTag,
            prose: tail,
        });
    }

    return blocks;
}

/**
 * Collects the recent place-name timeline across `messages` (up to `limit`
 * entries, in chronological order, collapsing consecutive identical places).
 *
 * @param {Array<{mes?:string}>} messages
 * @param {{limit?:number, at?:number, persona?:string}} [options]
 * @returns {string[]}
 */
export function extractRecentPlaces(messages, { limit = 6, at, persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length || limit <= 0) return [];

    const end = Number.isInteger(at) && at < list.length ? at : list.length - 1;
    const timeline = [];

    for (let i = 0; i <= end; i += 1) {
        const scenes = describeScenes(list[i], { persona });
        for (const { scene } of scenes) {
            if (!scene?.placeFull) continue;
            const prev = timeline[timeline.length - 1];
            if (!prev || locationKey(prev) !== locationKey(scene.placeFull)) {
                timeline.push(scene.placeFull);
            }
        }
    }

    return timeline.slice(-limit);
}

/**
 * Formats recent messages for the watcher LLM call.
 *
 * - Mode ON (`mode === true`): strips all tags except `<scene>` and groups each
 *   message into its scene blocks.
 * - Mode OFF (`mode === false`): keeps raw message text untouched.
 *
 * @param {Array<{mes?:string, is_user?:boolean, is_system?:boolean}>} messages
 * @param {{mode?:boolean, count?:number, at?:number, persona?:string}} [options]
 * @returns {string}
 */
export function formatLatestStory(messages, { mode = true, count = 2, at, persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return '';

    const end = Number.isInteger(at) && at < list.length ? at : list.length - 1;
    const maxCount = Math.max(1, Number(count) || 2);
    const selected = [];

    for (let i = end; i >= 0 && selected.length < maxCount; i -= 1) {
        const msg = list[i];
        if (!msg || msg.is_system) continue;
        // Focus on AI replies (or fall back to the target message if none).
        if (msg.is_user && selected.length > 0) continue;
        selected.unshift({ index: i, message: msg });
    }

    if (!selected.length && list[end]) {
        selected.push({ index: end, message: list[end] });
    }

    if (!mode) {
        return selected
            .map(({ message }, idx) => `[Reply ${idx + 1}]\n${String(message.mes ?? '').trim()}`)
            .filter(Boolean)
            .join('\n\n');
    }

    const parts = [];
    for (let idx = 0; idx < selected.length; idx += 1) {
        const { message } = selected[idx];
        const blocks = groupMessageByScene(message.mes ?? '', { persona });
        if (!blocks.length) {
            const plain = stripTags(message.mes ?? '').trim();
            if (plain) parts.push(`[Reply ${idx + 1}]\n${plain}`);
            continue;
        }
        const formattedBlocks = blocks.map((b, bIdx) => {
            const header = b.rawTag || '(no scene tag)';
            const isFinalBlock = idx === selected.length - 1 && bIdx === blocks.length - 1;
            const label = isFinalBlock ? `${header} [CURRENT LOCATION]` : header;
            return b.prose ? `${label}\n${b.prose}` : label;
        });
        parts.push(`[Reply ${idx + 1}]\n${formattedBlocks.join('\n\n')}`);
    }

    return parts.join('\n\n');
}

/* ---------- Prompts & watcher parser ---------- */

/**
 * Compiles the final positive prompt sent to `/imagine` by combining the scene
 * description and the user's style suffix.
 *
 * @param {string} description
 * @param {string} [style]
 * @returns {string}
 */
export function compileBgPrompt(description, style = '') {
    const cleanDesc = String(description ?? '').trim().replace(/^,+|,+$/g, '').trim();
    const cleanStyle = String(style ?? '').trim().replace(/^,+|,+$/g, '').trim();
    if (!cleanDesc) return '';
    if (!cleanStyle) return cleanDesc;
    return `${cleanDesc}, ${cleanStyle}`;
}

/**
 * Deterministic fallback description when the watcher LLM fails in Mode ON.
 *
 * @param {{placeFull?:string, place?:string, levels?:string[], time?:string, date?:string, weather?:string}|null} scene
 * @returns {string}
 */
export function fallbackLocationPrompt(scene) {
    if (!scene || !scene.placeFull) return '';
    const pieces = [
        `wide establishing shot of ${scene.placeFull}`,
        scene.time ? `at ${scene.time}` : '',
        scene.weather ? `${scene.weather} weather` : '',
        'detailed environment, atmospheric lighting, empty of people',
    ].filter(Boolean);
    return pieces.join(', ');
}

/**
 * Parses the watcher LLM reply — accepts either JSON (`{state, knownId, place, prompt}`,
 * direct, fenced, or balanced `{...}`) or the plain-text fallback (`SAME`,
 * `KNOWN <id>`, `NEW\n<prompt>`).
 *
 * @param {string} raw
 * @returns {{state:'same'|'known'|'new', knownId:string|null, place:string, prompt:string}|null}
 */
export function parseWatcherReply(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    const json = extractJsonObject(text);
    if (json && typeof json === 'object') {
        const stateRaw = String(json.state ?? '').trim().toLowerCase();
        const place = String(json.place ?? '').trim();
        const prompt = String(json.prompt ?? '').trim();
        const knownId = json.knownId !== undefined && json.knownId !== null && String(json.knownId).trim() !== ''
            ? String(json.knownId).trim()
            : null;

        if (stateRaw === 'same' || stateRaw === 'unchanged' || stateRaw === '0') {
            return { state: 'same', knownId: null, place, prompt: '' };
        }
        if (stateRaw === 'known' || stateRaw === 'match') {
            if (knownId) return { state: 'known', knownId, place, prompt: '' };
        }
        if (stateRaw === 'new' || prompt) {
            if (prompt) return { state: 'new', knownId: null, place, prompt };
        }
    }

    // Plain-text fallback protocol:
    // Line 1: SAME | KNOWN <id> | NEW
    const cleaned = text.replace(/^```[\w-]*\s*/i, '').replace(/```\s*$/, '').trim();
    const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;

    const first = lines[0];
    if (/^(same|unchanged|no\s*change|0)\b/i.test(first)) {
        return { state: 'same', knownId: null, place: '', prompt: '' };
    }

    const knownMatch = /^(?:known|match)\s*[:#-]?\s*(bg_\d+|\d+)\b/i.exec(first);
    if (knownMatch) {
        return { state: 'known', knownId: knownMatch[1], place: '', prompt: '' };
    }

    if (/^new\b/i.test(first)) {
        const inlineRest = first.replace(/^new\s*[:\-]?\s*/i, '').trim();
        const body = [inlineRest, ...lines.slice(1)].filter(Boolean).join(', ').trim();
        if (body) {
            return { state: 'new', knownId: null, place: '', prompt: body };
        }
        return null;
    }

    return null;
}

function extractJsonObject(text) {
    try {
        return JSON.parse(text);
    } catch {
        // continue
    }

    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            // continue
        }
    }

    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                const candidate = text.slice(start, i + 1);
                try {
                    return JSON.parse(candidate);
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}
