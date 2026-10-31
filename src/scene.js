/**
 * What a `<scene>` tag says, and which scene belongs to the turn being read.
 *
 * Pure like tags.js: the chat is an array of messages, a message is `mes`, and
 * nothing here stores or edits either. Persona filtering is passed in because
 * only the caller knows SillyTavern's persona name.
 */

import { parseMessage, scenesOf } from './tags.js';

/* A trailing clock: 9:40 PM, 20:17, 8 PM, or a tolerated 14.20. */
const TIME = /(?:\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?\s*[Mm]\.?)?|\b\d{1,2}\s*[AaPp]\.?\s*[Mm]\.?|\b\d{1,2}[.,]\d{2}\b)/g;

const TRAILING_SEPARATORS = /[\s,;:|\-\u2013\u2014\u00b7]+$/;

const describeCache = new WeakMap();

function text(value) {
    return typeof value === 'string' ? value : '';
}

/** Lower-cased, single-spaced, Unicode-normalised, for identity comparisons. */
function nameKey(name) {
    const value = text(name);
    const normalised = typeof value.normalize === 'function' ? value.normalize('NFC') : value;
    return normalised.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Splits a scene's date value into the date words and its trailing clock.
 *
 * @param {string} value e.g. 'Tuesday, March 4 · 9:40 PM'
 * @returns {{date:string, time:string}}
 */
export function splitDate(value) {
    const raw = text(value).trim();
    if (!raw) return { date: '', time: '' };

    TIME.lastIndex = 0;
    let last = null;
    let match;

    while ((match = TIME.exec(raw))) {
        last = match;
        if (match[0].length === 0) TIME.lastIndex += 1;
    }

    if (!last) return { date: raw, time: '' };

    return {
        date: raw.slice(0, last.index).replace(TRAILING_SEPARATORS, '').trim(),
        time: last[0].replace(/\s+/g, ' ').trim(),
    };
}

/**
 * Splits a location path on `|` and keeps the deepest level for the header.
 *
 * @param {string} value e.g. 'The city | Docks | Pier 9'
 * @returns {{place:string, placeFull:string, levels:string[]}}
 */
export function splitLocation(value) {
    const raw = text(value).trim();
    const levels = raw.split('|').map(level => level.trim()).filter(Boolean);

    return {
        place: levels.length ? levels[levels.length - 1] : raw,
        placeFull: raw,
        levels,
    };
}

/**
 * The cast for a scene, without the persona.
 *
 * Drops the full persona name, and the first word of a multi-word persona, so
 * "you" never stands in the cast. Duplicates collapse case-insensitively and
 * the scene's own order is kept.
 *
 * @param {string} value comma-separated names
 * @param {string} [persona]
 * @returns {string[]}
 */
export function splitPresent(value, persona = '') {
    const names = text(value).split(',').map(name => name.trim()).filter(Boolean);
    const person = text(persona).trim();
    const blocked = new Set();

    if (person) {
        blocked.add(nameKey(person));
        const first = person.split(/\s+/)[0];
        if (first && first !== person) blocked.add(nameKey(first));
    }

    const seen = new Set();
    const present = [];

    for (const name of names) {
        const key = nameKey(name);
        if (!key || blocked.has(key) || seen.has(key)) continue;
        seen.add(key);
        present.push(name);
    }

    return present;
}

/** Up to two letters for a portrait plate: 'Mara Voss' becomes 'MV'. */
export function initials(name) {
    const words = text(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';

    const letters = words.length === 1
        ? [Array.from(words[0])[0]]
        : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];

    return letters.join('').toUpperCase();
}

/** A scene worth showing: complete, and at least one of date, place or cast. */
export function isUsableScene(tag) {
    if (!tag || tag.name !== 'scene' || !tag.closed) return false;
    const attrs = tag.attrs || {};
    return !!(text(attrs.date).trim() || text(attrs.location).trim() || text(attrs.present).trim());
}

/**
 * The display fields of one scene tag.
 *
 * @param {object} tag
 * @param {{persona?: string}} [options]
 * @returns {{date:string, time:string, place:string, placeFull:string, levels:string[], weather:string, present:string[], dateRaw:string}}
 */
export function describeScene(tag, { persona = '' } = {}) {
    const attrs = tag?.attrs || {};
    const dateRaw = text(attrs.date).trim();
    const { date, time } = splitDate(dateRaw);
    const location = splitLocation(attrs.location);

    return {
        date,
        time,
        dateRaw,
        place: location.place,
        placeFull: location.placeFull,
        levels: location.levels,
        weather: text(attrs.weather).trim(),
        present: splitPresent(attrs.present, persona),
    };
}

/**
 * The usable scenes of one message, in order, cached on identity + `mes` +
 * persona. Every complete scene is returned; nothing is collapsed.
 *
 * @param {object} message
 * @param {{persona?: string}} [options]
 * @returns {Array<{tag:object, scene:object}>}
 */
export function describeScenes(message, { persona = '' } = {}) {
    if (!message || typeof message !== 'object') return [];

    const { mes, tags } = parseMessage(message);
    const person = text(persona);
    const hit = describeCache.get(message);
    if (hit && hit.mes === mes && hit.persona === person) return hit.scenes;

    const scenes = scenesOf(tags)
        .filter(isUsableScene)
        .map(tag => ({ tag, scene: describeScene(tag, { persona: person }) }));

    describeCache.set(message, { mes, persona: person, scenes });
    return scenes;
}

/**
 * The scene that governs a turn: the last usable scene in the shown message,
 * or the most recent earlier one when the shown message has none.
 *
 * @param {object[]} messages SillyTavern's chat array
 * @param {number} at the shown message's index
 * @param {{persona?: string}} [options]
 * @returns {{tag:object, index:number, scene:object}|null}
 */
export function resolveScene(messages, at, { persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return null;

    let index = Number.isInteger(at) ? at : list.length - 1;
    if (index >= list.length) index = list.length - 1;

    for (let i = index; i >= 0; i -= 1) {
        const scenes = describeScenes(list[i], { persona });
        if (!scenes.length) continue;

        const last = scenes[scenes.length - 1];
        return { tag: last.tag, index: i, scene: last.scene };
    }

    return null;
}

/** The older name for `resolveScene`. */
export const sceneAt = resolveScene;
