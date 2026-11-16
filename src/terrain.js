/* Terrain - the map's land, drawn by code.
 *
 * The map's terrain is a shader under the chart: the landmasses are the
 * territory blobs themselves (the same name-seeded outlines the SVG draws),
 * and everything the shader needs to know about the STORY is one small
 * record per chat. This module is the quiet half of that: it derives the
 * record entirely by code - no calls, no requests, no picture files - and
 * answers the pure questions the renderer asks (what the sky is doing at
 * this hour, what the weather is doing, where the story has earned the fog
 * to part).
 *
 * The GL half (shader source, the controller) joins in the next step. It
 * consumes exactly what is defined here and adds nothing to it.
 *
 * The record - `chatMetadata.meziverse.terrain` - is deliberately plain
 * JSON the user can open and edit:
 *
 *   { seed: 3,
 *     sea: '#143a45', shallow: '#2b7b82', town: '#b9b2a4',
 *     regions: { 'maras rest': { rugged: .4, forest: .5, water: .3,
 *                                colors: ['#8c9b62', '#456b3b', '#8d8779'] } } }
 *
 * A record is DERIVED, never stored twice: the palette comes from the
 * region's own background pictures (the watcher already painted what the
 * world looks like), the ratios from the words those pictures were painted
 * from, the temperature from the story's weathers. Same chat, same record -
 * only Reseed changes the noise behind it.
 */

import { hashFold } from './mapdata.js';

/* ---------- numbers ---------- */

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const r2 = value => Math.round(value * 100) / 100;

/* ---------- colour helpers (pure; the sampler that feeds us lives in the
   renderer, where there is a canvas to sample) ---------- */

function toRgb(sample) {
    if (Array.isArray(sample)) return sample;
    const text = String(sample || '').trim();
    const hex = /^#?([0-9a-f]{6})$/i.exec(text);
    if (!hex) return null;
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
    return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return [h * 360, s, l];
}

function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const at = t => {
        t = ((t % 1) + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [at(h + 1 / 3) * 255, at(h) * 255, at(h - 1 / 3) * 255];
}

/* Angle mixing takes the short way round - warmth must never drag a colour
   the long way through the wheel. */
function mixHue(hue, target, amount) {
    let d = ((target - hue + 540) % 360) - 180;
    return (hue + d * amount + 360) % 360;
}

/* A palette warms toward desert sun and cools toward snow light - the same
   land seen under the story's own climate. */
function warmHex(hex, temp) {
    if (!temp) return hex;
    const [h, s, l] = rgbToHsl(toRgb(hex));
    const target = temp > 0 ? 38 : 214;
    const shifted = mixHue(h, target, Math.abs(temp) * 0.22);
    return toHex(hslToRgb([shifted, clamp(s + Math.abs(temp) * 0.05, 0, 1), clamp(l + temp * 0.035, 0, 1)]));
}

/* ---------- the record: ratios from words ---------- */

/* What the watcher's pictures were painted from. The words are stems with a
   soft tail (trees, wooded, rocky) and are always matched at word starts -
   "important" never counts as a port. */
const LOOK_WORDS = {
    forest: ['forest', 'tree', 'wood', 'jungle', 'cedar', 'pine', 'grove', 'canopy', 'moss', 'fern', 'leaf', 'meadow', 'thicket'],
    water: ['river', 'lake', 'sea', 'ocean', 'coast', 'harbour', 'harbor', 'port', 'pier', 'rain', 'swamp', 'marsh', 'bay', 'beach', 'island', 'canal', 'water', 'stream', 'pond'],
    rugged: ['mountain', 'cliff', 'rock', 'boulder', 'glacier', 'canyon', 'desert', 'dune', 'peak', 'ridge', 'crag', 'cave', 'volcano', 'stone', 'quarry', 'ravine'],
    urban: ['city', 'street', 'station', 'tower', 'building', 'shop', 'market', 'subway', 'rail', 'road', 'avenue', 'plaza', 'office', 'apartment', 'warehouse', 'factory'],
};

const WORD_RE = {};
for (const [key, words] of Object.entries(LOOK_WORDS)) {
    WORD_RE[key] = new RegExp(words.map(word => `\\b${word}(?:s|es|ed|ing|y)?\\b`).join('|'), 'g');
}

const saturate = hits => hits / (hits + 2);

/**
 * How rugged, wooded and wet a place looks, read off the words its pictures
 * were painted from. Urban words are a counterweight: a city district is
 * not a forest however green its parks.
 *
 * With nothing to read, the region's own name seeds plausible defaults -
 * deterministic, so the record never wobbles between loads.
 *
 * @param {string[]} texts bg prompts and place names
 * @param {string} fold the region's folded key (the seed when silent)
 * @returns {{rugged:number, forest:number, water:number}} ratios in 0..1
 */
export function ratiosFromText(texts, fold) {
    const body = (texts || []).join(' \n ').toLowerCase();
    let total = 0;
    const hits = {};
    for (const [key, re] of Object.entries(WORD_RE)) {
        re.lastIndex = 0;
        const found = body.match(re);
        hits[key] = found ? found.length : 0;
        total += hits[key];
    }
    if (!total) {
        const h = hashFold(fold);
        return {
            rugged: r2(0.2 + (h % 100) / 250),
            forest: r2(0.15 + ((h >> 7) % 100) / 200),
            water: r2(0.1 + ((h >> 14) % 100) / 300),
        };
    }
    const fs = saturate(hits.forest);
    const ws = saturate(hits.water);
    const rs = saturate(hits.rugged);
    const us = saturate(hits.urban);
    return {
        rugged: r2(clamp(0.3 + 0.55 * rs - 0.1 * us, 0, 1)),
        forest: r2(clamp(0.3 + 0.55 * fs - 0.25 * us, 0, 1)),
        water: r2(clamp(0.22 + 0.5 * ws - 0.1 * us, 0, 1)),
    };
}

/* ---------- the record: palette from pictures ---------- */

/**
 * Three colours for one region - land, forest, highland - chosen from the
 * pixels of the region's own background pictures. The land is the middle
 * light, the forest the darkest saturated thing in frame, the highland the
 * brightest. No pictures (or no colour in them) falls back to a seeded
 * triple that keeps each region its own character.
 *
 * @param {Array<number[]|string>} samples [r,g,b] 0..255 or #rrggbb
 * @param {string} fold the region's folded key (the seed when empty)
 * @returns {string[]} three #rrggbb colours
 */
export function paletteFromSamples(samples, fold) {
    const rgbs = (samples || []).map(toRgb).filter(Boolean);
    if (rgbs.length < 3) {
        const h = hashFold(fold);
        const hue = h % 360;
        return [
            toHex(hslToRgb([hue, 0.26, 0.42])),
            toHex(hslToRgb([(hue + 30) % 360, 0.34, 0.28])),
            toHex(hslToRgb([(hue + 355) % 360, 0.18, 0.62])),
        ];
    }
    const hsl = rgbs.map(rgb => ({ rgb, hsl: rgbToHsl(rgb) }));
    const byLight = hsl.slice().sort((a, b) => a.hsl[2] - b.hsl[2] || a.hsl[0] - b.hsl[0]);
    const land = byLight[Math.floor(byLight.length / 2)].rgb;
    const landL = rgbToHsl(land)[2];
    const darker = byLight.filter(entry => entry.hsl[2] < landL);
    const forestEntry = darker.slice().sort((a, b) => b.hsl[1] - a.hsl[1])[0];
    const highEntry = byLight[byLight.length - 1];
    const forest = forestEntry
        ? forestEntry.rgb
        : hslToRgb([rgbToHsl(land)[0], clamp(rgbToHsl(land)[1] + 0.1, 0, 1), clamp(landL - 0.18, 0, 1)]);
    const high = hslToRgb([rgbToHsl(highEntry.rgb)[0], highEntry.hsl[1], clamp(highEntry.hsl[2] + 0.12, 0, 1)]);
    return [toHex(land), toHex(forest), toHex(high)];
}

/* ---------- the record: climate from the story's weather ---------- */

/* Word starts only, tails open: "thunderstorm", "snowing" and "desert heat"
   all read - a weather string is short and compound by nature. */
const COLD = /\b(snow|blizzard|ice|icy|frost|freez|cold|winter|sleet|hail)/;
const HOT = /\b(hot|heat|scorch|desert|sand|summer|warm|tropic)/;

/**
 * How warm the story's world reads, -1 (snow and ice) to +1 (desert heat),
 * from the weathers the scene tags have carried. 0 when the story has said
 * nothing about temperature - the palette then keeps its own voice.
 *
 * @param {Array<{weather:string}>} observations
 * @returns {number} -1..1
 */
export function climateTemp(observations) {
    let sum = 0;
    let count = 0;
    for (const entry of observations || []) {
        const text = String(entry.weather || '').toLowerCase();
        if (!text) continue;
        if (COLD.test(text)) { sum -= 1; count += 1; }
        if (HOT.test(text)) { sum += 1; count += 1; }
    }
    return count ? r2(clamp(sum / count, -1, 1)) : 0;
}

/* ---------- the record: derivation ---------- */

const SEA_BASE = '#143a45';
const SHALLOW_BASE = '#2b7b82';
const TOWN_BASE = '#b9b2a4';

/**
 * The whole terrain record for one chat, derived by code. Every input is
 * something the extension already holds: the regions from the atlas, the
 * pictures from the watcher's store, the words those pictures were painted
 * from, the weathers from the scene tags.
 *
 * @param {object} spec
 * @param {Array<{fold:string, name:string}>} spec.regions the world's top-level places
 * @param {Record<string, Array>} [spec.samplesByRegion] pixels per region fold
 * @param {Record<string, string[]>} [spec.textsByRegion] bg prompts / names per region fold
 * @param {Array<{weather:string}>} [spec.observations] for the climate hint
 * @param {number} [spec.seed] noise seed; Reseed bumps it
 * @returns {object} the record (see the module doc)
 */
export function deriveTerrainRecord({ regions = [], samplesByRegion = {}, textsByRegion = {}, observations = [], seed = 0 } = {}) {
    const temp = climateTemp(observations);
    const out = {
        seed: seed >>> 0,
        sea: warmHex(SEA_BASE, temp),
        shallow: warmHex(SHALLOW_BASE, temp),
        town: warmHex(TOWN_BASE, temp),
        regions: {},
    };
    for (const region of regions) {
        const colors = paletteFromSamples(samplesByRegion[region.fold] || [], region.fold)
            .map(hex => warmHex(hex, temp));
        out.regions[region.fold] = {
            ...ratiosFromText(textsByRegion[region.fold] || [], region.fold),
            colors,
        };
    }
    return out;
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Check a hand-edited record before the map believes it. Forgiving where it
 * can be (missing ratios fall back to derivation defaults) and strict where
 * it must be (colors are colors).
 *
 * @param {string|object} input JSON text or a parsed object
 * @returns {{ok:true, record:object}|{ok:false, error:string}}
 */
export function validateTerrainRecord(input) {
    let record = input;
    if (typeof input === 'string') {
        try {
            record = JSON.parse(input);
        } catch {
            return { ok: false, error: 'not valid JSON' };
        }
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { ok: false, error: 'needs to be an object' };
    }
    if (!record.regions || typeof record.regions !== 'object' || Array.isArray(record.regions)) {
        return { ok: false, error: 'needs a "regions" object' };
    }
    for (const key of ['sea', 'shallow', 'town']) {
        if (record[key] !== undefined && !HEX6.test(record[key])) {
            return { ok: false, error: `"${key}" must be a #rrggbb colour` };
        }
    }
    for (const [fold, region] of Object.entries(record.regions)) {
        if (!region || typeof region !== 'object') {
            return { ok: false, error: `region "${fold}" must be an object` };
        }
        if (!Array.isArray(region.colors) || region.colors.length !== 3 || region.colors.some(c => !HEX6.test(c))) {
            return { ok: false, error: `region "${fold}" needs three #rrggbb colours` };
        }
        for (const ratio of ['rugged', 'forest', 'water']) {
            if (region[ratio] !== undefined && !(Number.isFinite(region[ratio]) && region[ratio] >= 0 && region[ratio] <= 1)) {
                return { ok: false, error: `region "${fold}" ${ratio} must be a number in 0..1` };
            }
        }
    }
    return { ok: true, record };
}

/* ---------- the sky: hour to light ---------- */

/* Keyframes of one day: tint (screen-space multiplier), sun elevation in
   degrees, how warm the light reads and how far night has fallen. The
   renderer lerps between them, so 6am is a slow dawn and not a switch. */
const SKY_KEYS = [
    { h: 0, tint: [0.50, 0.58, 0.82], elev: -18, warm: 0.05, night: 1 },
    { h: 5, tint: [0.60, 0.63, 0.82], elev: -4, warm: 0.25, night: 0.72 },
    { h: 7, tint: [1.04, 0.88, 0.78], elev: 14, warm: 0.9, night: 0.15 },
    { h: 12, tint: [1, 1, 1], elev: 62, warm: 0.15, night: 0 },
    { h: 17, tint: [1, 0.97, 0.9], elev: 26, warm: 0.35, night: 0 },
    { h: 19, tint: [1.02, 0.82, 0.72], elev: 7, warm: 1, night: 0.2 },
    { h: 21, tint: [0.72, 0.7, 0.88], elev: -9, warm: 0.35, night: 0.7 },
    { h: 24, tint: [0.50, 0.58, 0.82], elev: -18, warm: 0.05, night: 1 },
];

/**
 * What the light is doing at an hour of the story: the tint over the land,
 * the sun's elevation for the hillshade, how warm and how deep the night.
 * Unknown hours read as plain day - a map that cannot tell the time still
 * shows the land.
 *
 * @param {number|null} hour 0..23 (null = unknown)
 * @returns {{tint:number[], sun:number[], warm:number, night:number}} sun is [x,y,z]
 */
export function skyFor(hour) {
    const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
    let a = SKY_KEYS[0];
    let b = SKY_KEYS[SKY_KEYS.length - 1];
    for (let i = 0; i < SKY_KEYS.length - 1; i += 1) {
        if (h >= SKY_KEYS[i].h && h <= SKY_KEYS[i + 1].h) {
            a = SKY_KEYS[i];
            b = SKY_KEYS[i + 1];
            break;
        }
    }
    const span = b.h - a.h || 1;
    const t = clamp((h - a.h) / span, 0, 1);
    const mix = (x, y) => x + (y - x) * t;
    const tint = [0, 1, 2].map(i => r2(mix(a.tint[i], b.tint[i])));
    const elev = mix(a.elev, b.elev);
    const warm = r2(mix(a.warm, b.warm));
    const night = r2(mix(a.night, b.night));
    // the sun walks east to west across the day; elevation decides its height
    const az = Math.PI * (h / 12 - 1);
    const el = elev * Math.PI / 180;
    const sun = [r2(Math.cos(el) * Math.cos(az)), r2(Math.cos(el) * -Math.sin(az)), r2(Math.sin(el))];
    return { tint, sun, warm, night };
}

/* ---------- the weather: words to overlay ---------- */

const WEATHER_KINDS = [
    ['storm', /\b(thunder|storm|gale|hurricane|typhoon|tempest)/],
    ['snow', /\b(snow|blizzard|sleet|hail|flurr)/],
    ['rain', /\b(rain|drizzle|shower|downpour|rainy|wet)/],
    ['fog', /\b(fog|mist|haze|smog|murk)/],
    ['sand', /\b(sand|dust|sirocco)/],
];

/**
 * What the weather is doing, as one overlay the shader knows how to draw.
 * The strongest kind wins (a thunderstorm is not "rain with thunder"), and
 * repeats only thicken it.
 *
 * @param {string} text a scene tag's weather
 * @returns {{kind:string|null, strength:number}} strength in 0..1
 */
export function weatherFx(text) {
    const body = String(text || '').toLowerCase();
    if (!body) return { kind: null, strength: 0 };
    for (const [kind, re] of WEATHER_KINDS) {
        const found = body.match(new RegExp(re.source, 'g'));
        if (found) return { kind, strength: r2(clamp(0.55 + 0.15 * (found.length - 1), 0, 1)) };
    }
    return { kind: null, strength: 0 };
}

/* ---------- fog of war: what the story has earned ---------- */

/**
 * Where the clouds part. The trail paints the world open: every journey leg
 * is a ribbon of clear sky, every place a response happened at breathes a
 * hole in the fog (the more turns, the wider), places only PASSED through
 * stay half-veiled, and the story's now is always clear. Deliberately dumb
 * geometry - the renderer smears it into cloud cover.
 *
 * @param {object} layout `layoutAtlas` output (items with ax/ay/r)
 * @param {object} atlas `buildAtlas` output (nodes carry visits/stops/kind)
 * @param {object} derived `deriveLegs` output (legs, nowId)
 * @returns {{spots:Array<{id:string,ax:number,ay:number,r:number,w:number}>,
 *            ribbons:Array<{ax:number,ay:number,bx:number,by:number,w:number}>}}
 */
export function fogReveal(layout, atlas, derived) {
    const spots = [];
    const ribbons = [];
    const items = (layout && layout.items) || {};
    const nodes = (atlas && atlas.nodes) || {};

    for (const leg of (derived && derived.legs) || []) {
        const from = items[leg.a];
        const to = items[leg.b];
        if (!from || !to) continue;
        ribbons.push({
            ax: from.ax, ay: from.ay, bx: to.ax, by: to.ay,
            w: r2(clamp(0.42 + 0.12 * (leg.count || 1), 0.42, 1)),
        });
    }

    for (const item of Object.values(items)) {
        const node = nodes[item.n && item.n.id];
        if (!node || node.kind === 'mobile' || node.kind === 'transient') continue;
        const stops = node.stops || 0;
        const isNow = derived && derived.nowId === node.id;
        if (!stops && !isNow) {
            // passed through: the trail crossed this land, but the story
            // never stood still in it - a thin veil stays over it
            spots.push({ id: node.id, ax: item.ax, ay: item.ay, r: r2(item.r * 1.5), w: 0.22 });
            continue;
        }
        spots.push({
            id: node.id,
            ax: item.ax,
            ay: item.ay,
            r: r2(item.r * (2.3 + 0.35 * Math.log2(1 + stops)) * (isNow ? 1.35 : 1)),
            w: isNow ? 1 : r2(clamp(0.5 + 0.16 * stops, 0.5, 1)),
        });
    }
    return { spots, ribbons };
}
