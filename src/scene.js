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
 * The hour a clock value stands for, 0-23.
 *
 * Handles the shapes the TIME regex lifts ('9:40 PM', '20:17', '8 PM',
 * '14.20') and, when no clock is in sight, the day words stories use instead
 * ('Early Evening' -> 18). Anything else answers null: no clock, no claim.
 *
 * @param {string} value
 * @returns {number|null}
 */
export function clockHour(value) {
    const raw = text(value).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!raw) return null;

    const match = raw.match(/(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?/);
    if (!match) return hourFromWords(raw);

    let hour = parseInt(match[1], 10);
    const tail = raw.slice(match.index + match[0].length).trim();
    if (/^[ap]\.?\s*m?\b/.test(tail)) hour = (hour % 12) + (tail[0] === 'p' ? 12 : 0);

    return ((hour % 24) + 24) % 24;
}

/* Day words to hours, longest phrases first so 'early evening' wins over
   'evening' and 'midnight' over 'night'. */
const DAY_WORDS = [
    [/(?:early\s+)?dawn|sunrise/, 6],
    [/early\s+morning/, 7],
    [/morning/, 9],
    [/early\s+afternoon/, 13],
    [/late\s+afternoon/, 16],
    [/afternoon/, 15],
    [/midday|noon/, 12],
    [/early\s+evening/, 18],
    [/evening|dusk|sunset/, 19],
    [/twilight/, 20],
    [/midnight/, 0],
    [/late\s+night/, 2],
    [/night/, 22],
];

/**
 * The hour a stretch of day words plausibly stands for, or null.
 *
 * @param {string} value e.g. 'Friday, Early Evening'
 * @returns {number|null}
 */
export function hourFromWords(value) {
    const raw = text(value).toLowerCase();
    if (!raw) return null;

    for (const [pattern, hour] of DAY_WORDS) {
        if (pattern.test(raw)) return hour;
    }

    return null;
}

/**
 * The clock a time field stands for: its clock text and the hour behind it.
 *
 * A field without a clock still speaks - the day words carry an approximate
 * hour - and its words are shown as they were written.
 *
 * @param {string} value e.g. '19:12', '7:12 PM', 'Early Evening'
 * @returns {{time:string, hour:number|null}}
 */
export function parseClock(value) {
    const raw = text(value).trim();
    if (!raw) return { time: '', hour: null };

    TIME.lastIndex = 0;
    let last = null;
    let match;

    while ((match = TIME.exec(raw))) {
        last = match;
        if (match[0].length === 0) TIME.lastIndex += 1;
    }

    if (!last) return { time: raw, hour: hourFromWords(raw) };

    return {
        time: last[0].replace(/\s+/g, ' ').trim(),
        hour: clockHour(last[0]),
    };
}

/* The weather effect states, and the words that name them. The exact list
   the tag contract asks for is Clear/Sunny/Rain/Storm/Snow/Fog/Overcast/Wind;
   the extra words are leniency for replies that spell things their own way.
   'blizzard' is the one composed state: snow carried on the wind. */
const WEATHER_WORDS = [
    ['blizzard', ['blizzard', 'whiteout']],
    ['storm', ['storm', 'thunder', 'thunderstorm', 'lightning', 'tempest']],
    ['rain', ['rain', 'rainy', 'drizzle', 'shower', 'downpour', 'pouring']],
    ['snow', ['snow', 'snowy', 'flurry', 'flurries', 'sleet', 'snowfall']],
    ['fog', ['fog', 'foggy', 'mist', 'misty', 'haze', 'hazy']],
    ['overcast', ['overcast', 'cloudy', 'cloud', 'clouds']],
    ['wind', ['wind', 'windy', 'breeze', 'breezy', 'gust', 'gale']],
    ['sunny', ['sunny', 'sun', 'sunshine', 'sunlit', 'sunset', 'sunrise']],
    ['clear', ['clear', 'fine', 'fair', 'none']],
];

/**
 * The effect state a weatherTag names, or '' for none. Exact values first,
 * then a forgiving word scan. Idempotent: a normalized state maps to itself.
 *
 * @param {string} value
 * @returns {string} one of the WEATHER_WORDS ids, or ''
 */
export function weatherTagValue(value) {
    const raw = text(value).trim().toLowerCase().replace(/['"]/g, '');
    if (!raw) return '';

    for (const [id, words] of WEATHER_WORDS) {
        if (words.includes(raw)) return id;
    }

    for (const [id, words] of WEATHER_WORDS) {
        if (words.some(word => raw.includes(word))) return id;
    }

    return '';
}

/**
 * Whether the scene plays outdoors. Strict: effects show only when the tag
 * says 'Outdoor' outright - a forgotten tag means no effect, never rain
 * indoors.
 *
 * @param {string} value
 * @returns {'indoor'|'outdoor'|''}
 */
export function locationTagValue(value) {
    const raw = text(value).trim().toLowerCase().replace(/['"]/g, '');
    if (!raw) return '';

    if (['outdoor', 'outdoors', 'outside', 'exterior', 'out'].includes(raw)) return 'outdoor';
    if (['indoor', 'indoors', 'inside', 'interior', 'in'].includes(raw)) return 'indoor';

    return '';
}

/* The free-text weather's tone words: they scale an effect, never pick one. */
const INTENSITY_HEAVY = ['heavy', 'downpour', 'pouring', 'torrential', 'intense', 'blizzard', 'howling', 'fierce', 'relentless', 'driving'];
const INTENSITY_LIGHT = ['light', 'gentle', 'mild', 'faint', 'slight', 'weak', 'drizzle', 'drizzly', 'sparse', 'patchy', 'thin', 'scattered', 'flurry', 'flurries', 'barely', 'soft'];

/**
 * How hard the weather reads: 'light', 'med' or 'heavy', from the free-text
 * weather field. No tone words, no claim - 'med'.
 *
 * @param {string} value
 * @returns {'light'|'med'|'heavy'}
 */
export function weatherIntensity(value) {
    const raw = text(value).toLowerCase();
    if (!raw) return 'med';

    if (INTENSITY_HEAVY.some(word => raw.includes(word))) return 'heavy';
    if (INTENSITY_LIGHT.some(word => raw.includes(word))) return 'light';

    return 'med';
}

/**
 * The effect state a scene earns: its weatherTag's state, but only outdoors.
 * 'clear' and everything unknown or indoor answer ''.
 *
 * @param {{weatherTag?:string, locationTag?:string}|null} scene
 * @returns {string}
 */
export function weatherEffect(scene) {
    const state = weatherTagValue(scene?.weatherTag);
    if (!state || state === 'clear') return '';

    return locationTagValue(scene?.locationTag) === 'outdoor' ? state : '';
}

/**
 * The whole weather plan for a scene - what plays, how hard, and the hour
 * the light sits at - or null when nothing plays.
 *
 * @param {object|null} scene
 * @returns {{state:string, intensity:'light'|'med'|'heavy', hour:number|null}|null}
 */
export function weatherPlan(scene) {
    const state = weatherEffect(scene);
    if (!state) return null;

    return {
        state,
        intensity: weatherIntensity(scene?.weather),
        hour: Number.isFinite(scene?.hour) ? scene.hour : null,
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

/** The first attribute answering one of several spellings, or ''. */
function pickAttr(attrs, ...names) {
    const wanted = new Set(names.map(name => name.toLowerCase()));
    for (const [key, value] of Object.entries(attrs || {})) {
        if (wanted.has(key.toLowerCase())) return text(value);
    }
    return '';
}

/**
 * The display fields of one scene tag.
 *
 * The clock follows a precedence chain: the tag's own `time` field first,
 * then a trailing clock inside `date` (older tags), then the day words the
 * date carries ('Early Evening'), and finally no claim at all.
 *
 * @param {object} tag
 * @param {{persona?: string}} [options]
 * @returns {{date:string, time:string, timeRaw:string, hour:number|null, place:string, placeFull:string, levels:string[], weather:string, weatherTag:string, locationTag:string, present:string[], dateRaw:string}}
 */
export function describeScene(tag, { persona = '' } = {}) {
    const attrs = tag?.attrs || {};
    const dateRaw = text(attrs.date).trim();
    const timeRaw = pickAttr(attrs, 'time');
    const legacy = splitDate(dateRaw);

    let time = '';
    let hour = null;

    if (timeRaw.trim()) {
        const clock = parseClock(timeRaw);
        time = clock.time;
        hour = clock.hour;
    } else if (legacy.time) {
        time = legacy.time;
        hour = clockHour(legacy.time);
    } else {
        hour = hourFromWords(dateRaw);
    }

    const location = splitLocation(attrs.location);

    return {
        date: legacy.date,
        time,
        dateRaw,
        timeRaw: timeRaw.trim(),
        hour,
        place: location.place,
        placeFull: location.placeFull,
        levels: location.levels,
        weather: text(attrs.weather).trim(),
        weatherTag: weatherTagValue(pickAttr(attrs, 'weatherTag', 'weather_tag', 'weather-tag')),
        locationTag: locationTagValue(pickAttr(attrs, 'locationTag', 'location_tag', 'location-tag')),
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
