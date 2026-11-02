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
 * The creative core of the watcher's question, one per mode. These are the
 * parts meant to be tuned: the settings sheet edits copies of them, and the
 * answer format below is appended by code so parsing survives any edit.
 *
 * Mode ON sees the story grouped by scene blocks and leans on that structure;
 * mode OFF gets plain prose, where the location may change inside a single
 * paragraph or hold for many messages.
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
 * The watcher's system prompt: the editable core for the mode (or the
 * default core when none is set), with the answer format always appended.
 * With `force` (the brush button) it must draw something even when nothing
 * changed, so matching is switched off.
 *
 * @param {{mode?:boolean, force?:boolean, core?:string}} [options]
 * @returns {string}
 */
export function watcherSystemPrompt({ mode = true, force = false, core = '' } = {}) {
    const base = String(core ?? '').trim() || (mode ? DEFAULT_BG_PROMPT_ON : DEFAULT_BG_PROMPT_OFF);
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
 * Mode ON: narration grouped by scene, the tag's place, clock and weather on
 * each group's header line. The last group is the current place. Mode OFF has
 * no tags to group by, so the text goes in raw - nothing stripped, because in
 * untagged prose anything may carry the location.
 *
 * @param {Array<{mes:string}>} messages
 * @param {{mode?:boolean, count?:number, at?:number, persona?:string}} [options]
 * @returns {string}
 */
export function formatLatestStory(messages, { mode = true, count = 2, at, persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const end = Number.isInteger(at) ? Math.min(at, list.length - 1) : list.length - 1;
    const start = Math.max(0, end - Math.max(1, count) + 1);

    const turns = [];
    for (let i = start; i <= end; i += 1) {
        const mes = typeof list[i]?.mes === 'string' ? list[i].mes : '';
        if (!mes.trim()) continue;

        if (!mode) {
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
 * The watcher's whole question: what is on screen, what this chat already has,
 * where the story has been, and the latest story itself.
 *
 * @param {{store:object, messages:Array, mode?:boolean, count?:number, at?:number, persona?:string, force?:boolean, systemCore?:string}} options
 * @returns {{systemPrompt:string, prompt:string, responseLength:number, jsonSchema:object}}
 */
export function buildWatcherRequest({ store, messages, mode = true, count = 2, at, persona = '', force = false, systemCore = '' } = {}) {
    const blocks = [];

    const current = currentRecord(store);
    blocks.push(`CURRENT BACKGROUND\n${current ? `${current.place}\n${current.prompt}` : 'none yet'}`);

    const known = knownBackgroundsList(store, { limit: 12 });
    blocks.push(`KNOWN BACKGROUNDS\n${known.length
        ? known.map(entry => `- ${entry.id}: ${entry.place} - ${excerpt(entry.prompt, 200)}`).join('\n')
        : 'none'}`);

    const places = mode
        ? extractRecentPlaces(messages, { limit: 6, at, persona })
        : knownBackgroundsList(store, { limit: 6 }).map(entry => entry.place).reverse();
    blocks.push(`RECENT PLACES\n${places.length ? places.join(' -> ') : 'unknown'}`);

    blocks.push(`LATEST STORY\n${formatLatestStory(messages, { mode, count, at, persona }) || 'empty'}`);

    return {
        systemPrompt: watcherSystemPrompt({ mode, force, core: systemCore }),
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
