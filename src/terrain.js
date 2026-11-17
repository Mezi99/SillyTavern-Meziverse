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

import { hashFold, trailWalks, walkSegments } from './mapdata.js';

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
    ['sand', /\b(sand|dust|sirocco)/],
    ['fog', /\b(fog|mist|haze|smog|murk|overcast|cloud|grey|drab)/],
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

/* ---------- the towns: where the story stood ---------- */

/**
 * The town field's sources: the pins the story actually stood in, and the
 * city / plot territories those pins belong to - never regions, never a
 * whole blob (the mockup paints towns at places, not across lands). Each
 * pin carries the fog clearing it earns (200 now / 160 stopped / 112
 * passed), so one list serves both fields.
 *
 * @param {object} layout `layoutAtlas` output (items with ax/ay/r/pin)
 * @param {object} atlas `buildAtlas` output (nodes carry stops/level/kind)
 * @param {object} derived `deriveLegs` output (nowId)
 * @returns {{pins:Array<{ax:number,ay:number,size:number,r:number}>,
 *            ters:Array<{ax:number,ay:number,r:number,w:number}>}}
 */
export function townSources(layout, atlas, derived) {
    const items = (layout && layout.items) || {};
    const nodes = (atlas && atlas.nodes) || {};
    const pins = [];
    const terIds = new Set();
    for (const item of Object.values(items)) {
        if (!item.pin) continue;
        const id = item.n && item.n.id;
        const node = nodes[id];
        if (!node || node.kind === 'mobile' || node.kind === 'transient') continue;
        const now = derived && derived.nowId === id;
        const stops = node.stops || 0;
        const stood = !!(stops || now);
        const level = Number.isFinite(node.level) ? node.level : 3;
        pins.push({
            ax: item.ax,
            ay: item.ay,
            // passed-through places get no town glow - just their clearing
            size: stood ? (level <= 1 ? 46 : level === 2 ? 34 : 24) : 0,
            r: now ? 200 : stops ? 160 : 112,
        });
        if (!stood) continue;
        for (let at = node; at; at = at.parentId ? nodes[at.parentId] : null) {
            if (at.kind === 'mobile' || at.kind === 'transient') continue;
            const holder = items[at.id];
            const lvl = Number.isFinite(at.level) ? at.level : 3;
            if (holder && !holder.pin && (lvl === 1 || lvl === 2)) terIds.add(at.id);
        }
    }
    const ters = [];
    for (const id of terIds) {
        const item = items[id];
        const node = nodes[id];
        if (!item || !node) continue;
        ters.push({ ax: item.ax, ay: item.ay, r: item.r, w: node.level === 1 ? 0.55 : 0.8 });
    }
    return { pins, ters };
}

/**
 * The road's line segments: the same-region legs the story walked, sampled
 * along the very curve the SVG's dotted trail draws - so the lit road lies
 * on the trail to the pixel. Each segment is [ax, ay, bx, by].
 *
 * @param {object} layout `layoutAtlas` output (items with ax/ay)
 * @param {object} atlas `buildAtlas` output (nodes carry parentId)
 * @param {object} derived `deriveLegs` output (legs)
 * @param {Array<object>} [walks] `trailWalks` output (derived here when omitted)
 * @returns {Array<[number, number, number, number]>}
 */
export function roadSegments(layout, atlas, derived, walks = null) {
    const items = (layout && layout.items) || {};
    const nodes = (atlas && atlas.nodes) || {};
    /* resolve exactly like the SVG's pointFor: the layout's anchor (pins and
       hubs first) - never a raw blob centre, or the road runs beside the
       trail instead of under it */
    const pointFor = id => (layout && layout.anchor ? layout.anchor(id) : items[id]) || null;
    const trail = walks || trailWalks((derived && derived.legs) || [], pointFor);
    const rootOf = id => {
        let node = nodes[id];
        while (node && node.parentId) node = nodes[node.parentId];
        return node;
    };
    const segs = [];
    for (const step of trail) {
        const { leg, from, to } = step;
        const ra = rootOf(leg.a);
        const rb = rootOf(leg.b);
        if (!ra || ra.id !== rb?.id) continue;
        if (Math.hypot(from.ax - to.ax, from.ay - to.ay) > 340) continue;
        const pts = walkSegments(step.pts);
        for (let i = 1; i < pts.length; i += 1) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
    }
    return segs;
}

/* ---------- fog of war: what the story has earned ----------
 * The fog is analytic now - the shader's pin loop breathes the clearings
 * (see TERRAIN_FS). What remains here is the towns' source selection. */

/* ---------- the renderer ----------
 *
 * One fullscreen triangle, one fragment shader: the terrain IS the map's
 * own layout seen as land. The territory blobs become the landmasses
 * (regionField reproduces the exact seeded outlines the SVG draws), the
 * journey legs become roads and clearings in the fog. Everything the story
 * knows about itself is analytic: towns (townField), roads (roadField) and
 * the fog's clearings are evaluated per pixel from small uniform arrays -
 * the mockup's model, so every edge stays crisp at any zoom and no loop
 * grows with the story beyond a fixed cap (view-culled every frame).
 *
 * Adapted from the mockup's shader (MapPlanA) and Abyssal Garden's look
 * techniques - caustics, hillshading, the adaptive pixel budget. Ink is
 * the v1 look; more looks are branches on this same ground.
 */

export const TERRAIN_QUALITY = [
    { name: 'Low', res: 0.6, oct: 4, px: 0.45e6 },
    { name: 'Medium', res: 0.85, oct: 6, px: 0.9e6 },
    { name: 'High', res: 1, oct: 8, px: 4e6 },
];

/* Same little generator mapdata seeds its packing with - two modules, one
   deterministic world. */
const randomFrom = seed => {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
};

const TERRAIN_VS = `#version 300 es
in vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
#define MAXR 24
#define MAXP 48
#define MAXT 20
#define MAXL 64
#define SIG 28.
out vec4 fragColor;
uniform vec2 uRes,uCenter,uSeedV;
uniform float uZ,uScale,uTime,uOct,uFog,uFogOnly,uNight;
uniform vec3 uAcc,uSea,uShallow,uTownC,uTint,uSun;
uniform int uNR;
uniform vec4 uReg[MAXR],uRegB[MAXR],uRegP[MAXR];
uniform vec3 uRC[MAXR*3];
uniform vec4 uWeather;
uniform vec4 uPin[MAXP],uTer[MAXT],uLeg[MAXL];
uniform int uNP,uNT,uNL;
uniform float uRelief,uWater,uForest,uTowns;

float h21(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p,float oct){float a=.5,s=0.,n=0.;for(int i=0;i<8;i++){if(float(i)>=oct)break;s+=a*vn(p);n+=a;p=p*2.03+vec2(17.1,31.7);a*=.5;}return s/n;}
float ss(float a,float b,float x){float t=clamp((x-a)/(b-a),0.,1.);return t*t*(3.-2.*t);}

/* the same radial blob the SVG draws, as a field: positive inside */
void regionField(vec2 p,out float S,out int rid){
  float best=-1e4;int bi=0;
  for(int i=0;i<MAXR;i++){if(i>=uNR)break;
    vec4 r=uReg[i],b=uRegB[i];vec2 q=p-r.xy;q.y/=.9;
    float t=atan(q.y,q.x);
    float k=1.+b.w*(sin(2.*t+b.x)*.55+sin(3.*t+b.y)*.3+sin(5.*t+b.z)*.2);
    float d=r.z*k-length(q);
    if(d>best){best=d;bi=i;}
  }
  rid=bi;S=.5+best/(2.*SIG);
}

/* where the towns are: the mockup's field, verbatim - pin gaussians and
   city/plot discs, MAX-combined so stacking never grows the town */
float townField(vec2 p){
  float t=0.;
  for(int i=0;i<MAXP;i++){if(i>=uNP)break;vec4 q=uPin[i];if(q.z>.5){float d=length(p-q.xy);t=max(t,exp(-d*d/(q.z*q.z))*.95);}}
  for(int i=0;i<MAXT;i++){if(i>=uNT)break;vec4 q=uTer[i];float d=length(p-q.xy);t=max(t,(1.-ss(.15*q.z,q.z,d))*q.w);}
  return t;
}
float segD(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-4),0.,1.);return length(pa-ba*h);}
float roadField(vec2 p,float w,float aa){
  vec2 wp=p+(vec2(vn(p*.045),vn(p*.045+9.))-.5)*16.;
  float d=1e4;
  for(int i=0;i<MAXL;i++){if(i>=uNL)break;d=min(d,segD(wp,uLeg[i].xy,uLeg[i].zw));}
  return 1.-ss(w*.5,w*.5+aa,d);
}

/* land height, 0.30 is the sea line */
float elev(vec2 p,float towns,float oct,out float landV,out int rid,out float mount){
  float S;regionField(p,S,rid);
  vec2 sp=p+uSeedV;
  float wob=(fbm(sp*.016,min(oct,3.))-.5)*.6;
  if(oct>4.5)wob+=(fbm(sp*.05+5.,4.)-.5)*.09;
  float land=S+wob;landV=land;
  vec4 P=uRegP[rid];
  float rug=clamp(P.x*uRelief,0.,1.5);
  vec2 q=sp+(vec2(fbm(sp*.012+3.,3.),fbm(sp*.012+9.,3.))-.5)*60.;
  float n=fbm(q*.011,oct);
  float rd=1.-abs(fbm(q*.013+2.,3.)*2.-1.);rd*=rd;
  float rd2=1.-abs(fbm(q*.03+4.,min(oct,5.))*2.-1.);
  float massif=ss(.38,.66,fbm(q*.0065+7.,3.)+.2*(rug-.4));
  mount=(rd*.75+rd2*.25)*massif;
  float inland=ss(.55,1.05,land),isLand=ss(.46,.54,land);
  float rel=(mount*rug*.6+(n-.5)*.22)*inland*(1.-.9*towns);
  float h=.30*ss(-.1,.5,land)+isLand*(.012+.05*inland+rel);
  float lk=fbm(sp*.017+31.,3.);
  float lake=1.-ss(.0,.07,lk-(.235+P.z*uWater*.13));
  h-=lake*.12*inland*(1.-towns)*(1.-mount);
  return h;
}

float caus(vec2 uv,float t){ /* tiling caustic, after Abyssal Garden's water */
  vec2 p=uv*6.2831853,i=p;float c=0.;
  for(int n=1;n<=4;n++){float tt=t*(1.-3.5/float(n));i=p+vec2(cos(tt-i.x)+sin(tt+i.y),sin(tt-i.y)+cos(tt+i.x));float s=sin(i.x+tt),k=cos(i.y+tt);c+=abs(s*k)/(1.25*sqrt(s*s+k*k)+1e-4);}
  c=1.17-pow(c/4.,1.4);return pow(abs(c),8.);
}
vec2 vor(vec2 p){vec2 i=floor(p),f=fract(p);float d1=9.,d2=9.,id=0.;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 o=vec2(float(x),float(y)),c=i+o;vec2 r=o+.12+.76*vec2(h21(c),h21(c+17.3))-f;float d=dot(r,r);if(d<d1){d2=d1;d1=d;id=h21(c+5.1);}else if(d<d2)d2=d;}
  return vec2(sqrt(d2)-sqrt(d1),id);}
float lines(float v,float w){float g=abs(fract(v-.5)-.5)/(fwidth(v)*w+1e-5);return 1.-min(g,1.);}

void main(){
  vec2 px=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y);
  vec2 p=uCenter+(px-.5*uRes)/uScale;
  vec2 sp=p+uSeedV;
  float px1=1./uScale;
  float t=uTime;

  /* the story: towns, roads and fog are all analytic now */
  float towns=townField(p);

  float landV,mountV;int rid;
  float h0=elev(p,towns,uOct,landV,rid,mountV);
  float eps=2.*px1;float d1,d2;int r2;float m2;
  float hx=elev(p+vec2(eps,0),towns,min(uOct,6.),d1,r2,m2);
  float hy=elev(p+vec2(0,eps),towns,min(uOct,6.),d2,r2,m2);
  vec2 g=vec2(hx-h0,hy-h0)/eps;
  float shadeK=70.*clamp(uRelief,.2,1.6);
  vec3 nrm=normalize(vec3(-g.x*shadeK,-g.y*shadeK,1.));
  vec3 lightDir=normalize(vec3(uSun.x*.8-.45,-uSun.y*.8-.45,max(uSun.z,.15)+.55));
  float sh=clamp(dot(nrm,lightDir),0.,1.);
  float isWater=1.-ss(.296,.304,h0);
  /* the road: the mockup's field, verbatim - a fine hand-trodden line
     along the very walks the dotted trail draws */
  float roadAA=px1*.9;
  float road=roadField(p,1.5*clamp(uTowns,.3,1.4),roadAA)*(1.-isWater)*step(.01,uTowns);
  vec4 P=uRegP[rid];
  vec3 Lc=uRC[rid*3],Fc=uRC[rid*3+1],Hc=uRC[rid*3+2];
  float hh=h0-.30;
  float fm=ss(.46,.62,fbm(sp*.028+11.,uOct)+(P.y*uForest-.5)*.55)*(1.-ss(.14,.26,hh))*(1.-ss(.1,.4,towns));
  float tw=ss(.32,.46,towns)*uTowns;
  float zf=ss(.55,1.5,uZ);

  /* the ink look: dark land, accent contour lines, a lit shore */
  vec3 land=mix(vec3(.07,.13,.125),vec3(.15,.25,.225),ss(0.,.3,hh));
  land=mix(land,Lc*.32+vec3(.03),.22);
  land=mix(land,Fc*.30+vec3(.02),fm*.45);
  land*=.72+.6*sh;
  land*=.95+.1*vn(sp*.1)+.05*(vn(sp*.45)-.5)*zf;
  float lv=hh*10.;
  float cl=lines(lv,1.0)*(1.-isWater)*ss(.01,.03,hh)*zf;
  float idx=lines(lv/4.,1.2)*(1.-isWater)*ss(.01,.03,hh);
  land+=uAcc*(cl*.09+idx*.15);
  vec2 vv=tw>.01?vor(sp/15.):vec2(1.,.5);float blk=vv.y;float street=1.-ss(.0,.11,vv.x);
  vec3 tc=uTownC*(.36+.1*mix(.5,blk,zf))*(1.-.3*street*zf);
  land=mix(land,tc,tw*.8);
  land=mix(land,uAcc*.9,road*.55);
  vec3 wat=mix(uSea*.9,uShallow*.6,ss(.10,.30,h0));
  wat+=uAcc*caus(sp*.012,t*.5+3.)*.06*ss(.12,.30,h0)*(1.-.6*uNight);
  vec3 col=mix(wat,land,1.-isWater);
  float glow=exp(-abs(h0-.30)*60.);
  col+=uAcc*glow*.14;
  float cs=1.-min(abs(h0-.30)/(fwidth(h0)*1.1+1e-5),1.);
  col=mix(col,uAcc*.9,cs*.5);

  /* the sky: the story's hour over the land */
  col*=uTint;

  /* fog of war: clouds over everything the story has not earned */
  float fogA=0.;
  vec3 fogC=vec3(0.);
  if(uFog>.5){
    float cn=fbm(sp*.014+vec2(t*.6,t*.25),4.);
    /* the mockup's fog, verbatim: every pin breathes its own hole in the
       cloud (200 now / 160 stopped / 112 passed), and the drift bends the
       rim before the edge is cut - so the edges swirl like cloud edges */
    float rev=0.;
    for(int i=0;i<MAXP;i++){if(i>=uNP)break;vec4 q=uPin[i];float d=length(p-q.xy)+(cn-.5)*70.;rev=max(rev,1.-ss(.52*q.w,q.w,d));}
    float cloud=.8+.4*fbm(sp*.02+vec2(-t*.8,t*.3)+7.,5.);
    fogC=vec3(.05,.075,.082)*cloud;
    fogA=(1.-rev)*.88;
  }

  /* the weather: one overlay per sky */
  if(uWeather.y>.001){
    float k=uWeather.x,s=uWeather.y;
    if(k<1.5){float streak=smoothstep(.72,1.,fract((px.x*.4+px.y*1.35+t*240.)/22.));col*=1.-.5*streak*s;col*=1.-.3*s;}
    else if(k<2.5){vec2 cell=fract(px/4.+vec2(0.,t*70.))-.5;float flake=step(.94,h21(floor(px/4.+vec2(0.,t*70.))))*ss(.28,0.,length(cell));col=mix(col,vec3(.92,.94,.97),flake*s);col=mix(col,vec3(.75,.78,.84),s*.3);}
    else if(k<3.5){float streak=smoothstep(.78,1.,fract((px.x*.25+px.y*1.5+t*320.)/26.));col*=1.-.45*streak*s;col*=1.-.22*s;}
    else if(k<4.5){col=mix(col,vec3(.42,.46,.5),s*.5);}
    else{col=mix(col,vec3(.52,.4,.26),s*.38);col+=(h21(px*.7)-.5)*.06*s;}
  }

  if(uFogOnly>.5){
    /* the flat chart keeps its own ground: the veil alone rides above it */
    fragColor=vec4(fogC,fogA);
    return;
  }

  col=mix(col,fogC,fogA);
  col+=(h21(gl_FragCoord.xy)-.5)/255.;
  fragColor=vec4(col,1.);
}`;

const hexToRgb = hex => {
    const n = parseInt(String(hex || '').replace('#', ''), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const WEATHER_ID = { storm: 1, snow: 2, rain: 3, fog: 4, sand: 5 };

/**
 * The GL controller: one per map window, thrown away on context loss and
 * quietly rebuilt. Everything it draws is decoration - the map above it
 * keeps every click and never learns it exists.
 *
 * @param {HTMLCanvasElement} canvas where the land goes
 * @param {{quality?:number}} [opts] initial quality tier index
 */
export function createTerrain(canvas, { quality = 2 } = {}) {
    /* alpha so the flat chart can keep its own ground and wear only the fog
       veil above it - straight (un-premultiplied) alpha keeps that veil honest */
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) return null;

    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
    };

    let prog = null;
    const U = {};
    try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, TERRAIN_VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, TERRAIN_FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (error) {
        console.error('[Meziverse] terrain shader:', error);
        return null;
    }
    gl.useProgram(prog);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uniformCount = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i += 1) {
        const info = gl.getActiveUniform(prog, i);
        U[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
    }

    /* scene state, set by updateScene and then read frame after frame */
    let scene = null;
    const pinBuf = new Float32Array(48 * 4);
    const terBuf = new Float32Array(20 * 4);
    const legBuf = new Float32Array(64 * 4);
    let qIndex = Math.max(0, Math.min(TERRAIN_QUALITY.length - 1, quality));
    /* Session-only quality guard: a GPU timer (when the driver exposes one)
       watches what frames really cost. After warm-up, three genuinely slow
       frames in a row step the tier down for this session only - it is never
       written to settings, so the quality the user chose returns next open. */
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const timerQuery = timerExt ? gl.createQuery() : null;
    let timerOut = false;
    let slowStreak = 0;
    let warm = 4;

    /**
     * A new story (or record): rebuild the uniform arrays. Rare - only when
     * the atlas or the record changes.
     *
     * @param {object} sceneIn
     * @param {object} sceneIn.layout `layoutAtlas` output
     * @param {object} sceneIn.atlas `buildAtlas` output
     * @param {object} [sceneIn.derived] `deriveLegs` output
     * @param {Array<object>} [sceneIn.walks] `trailWalks` output - the map's
     *        own walks, so the roads and corridors follow the dotted trail
     * @param {object} [sceneIn.record] the terrain record (see the module doc)
     */
    const updateScene = ({ layout, atlas, derived = null, walks = null, record = null }) => {
        const roots = (layout.roots || []).slice(0, 24);
        const reg = new Float32Array(24 * 4);
        const regB = new Float32Array(24 * 4);
        const regP = new Float32Array(24 * 4);
        const rc = new Float32Array(24 * 9);
        roots.forEach((root, i) => {
            const fold = root.n.fold;
            const region = (record && record.regions && record.regions[fold])
                || { ...ratiosFromText([], fold), colors: paletteFromSamples([], fold) };
            const rand = randomFrom(hashFold(fold));
            reg.set([root.ax, root.ay, root.r, 0], i * 4);
            regB.set([rand() * 6, rand() * 6, rand() * 6, 0.12], i * 4);
            regP.set([region.rugged, region.forest, region.water, 0], i * 4);
            (region.colors || []).slice(0, 3).forEach((color, k) => rc.set(hexToRgb(color), i * 9 + k * 3));
        });
        const towns = townSources(layout, atlas, derived);
        const rec = record || {};
        scene = {
            reg, regB, regP, rc,
            nRegions: roots.length,
            pins: towns.pins,
            ters: towns.ters,
            legs: roadSegments(layout, atlas, derived, walks),
            sea: hexToRgb(rec.sea || '#143a45'),
            shallow: hexToRgb(rec.shallow || '#2b7b82'),
            town: hexToRgb(rec.town || '#b9b2a4'),
            seed: [(rec.seed || 0) * 91.7 + 3.1, (rec.seed || 0) * 53.3 + 8.9],
        };
        gl.uniform4fv(U.uReg, scene.reg);
        gl.uniform4fv(U.uRegB, scene.regB);
        gl.uniform4fv(U.uRegP, scene.regP);
        gl.uniform3fv(U.uRC, scene.rc);
        gl.uniform1i(U.uNR, scene.nRegions);
        gl.uniform3fv(U.uSea, scene.sea);
        gl.uniform3fv(U.uShallow, scene.shallow);
        gl.uniform3fv(U.uTownC, scene.town);
        gl.uniform2f(U.uSeedV, scene.seed[0], scene.seed[1]);
        warm = 4;
        slowStreak = 0;
    };

    /**
     * One frame. Static unless the caller hands time in - the land only
     * moves when the story's sky says so.
     */
    const draw = ({
        width, height, dpr = 1, tx = 0, ty = 0, s = 1, interact = false,
        time = 0, sky = null, weather = null, fog = false, fogOnly = false, acc = '#77c2aa',
    }) => {
        if (!scene) return;
        const q = TERRAIN_QUALITY[qIndex];
        /* full resolution at rest; while the hand is moving the land draws
           at 0.6 so pans and zooms stay fluid, and the caller's idle timer
           repaints the settled frame sharp */
        let k = dpr * (interact ? 0.6 : q.res);
        if (width * height * k * k > q.px) k = Math.sqrt(q.px / Math.max(1, width * height));
        const w = Math.max(2, Math.round(width * k));
        const h = Math.max(2, Math.round(height * k));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        const skyNow = sky || { tint: [1, 1, 1], sun: [0, 0, 1], night: 0 };
        gl.uniform2f(U.uRes, w, h);
        gl.uniform2f(U.uCenter, (width / 2 - tx) / s, (height / 2 - ty) / s);
        gl.uniform1f(U.uScale, s * (w / Math.max(1, width)));
        gl.uniform1f(U.uZ, s);
        gl.uniform1f(U.uTime, time);
        gl.uniform1f(U.uOct, Math.min(q.oct, Math.max(3, Math.round(3 + Math.log2(Math.max(0.5, s)) * 1.5 + (q.oct - 4) / 2))));
        gl.uniform1f(U.uFog, fog ? 1 : 0);
        gl.uniform1f(U.uFogOnly, fogOnly ? 1 : 0);
        gl.uniform1f(U.uNight, skyNow.night || 0);
        gl.uniform3fv(U.uTint, skyNow.tint);
        gl.uniform3fv(U.uSun, skyNow.sun);
        gl.uniform3fv(U.uAcc, hexToRgb(acc));
        gl.uniform4f(U.uWeather, weather && weather.kind ? WEATHER_ID[weather.kind] || 0 : 0,
            weather ? weather.strength || 0 : 0, 0, 0);

        /* the story's towns: analytic, so all that matters is which ones the
           window shows - culled to the view, capped per tier */
        const sx = Math.max(0.01, s);
        const cx = (width / 2 - tx) / sx;
        const cy = (height / 2 - ty) / sx;
        const x0 = cx - width / 2 / sx - 120, x1 = cx + width / 2 / sx + 120;
        const y0 = cy - height / 2 / sx - 120, y1 = cy + height / 2 / sx + 120;
        const pinCap = qIndex >= 2 ? 48 : qIndex === 1 ? 36 : 24;
        const terCap = qIndex >= 2 ? 20 : qIndex === 1 ? 14 : 10;
        let np = 0, nt = 0;
        for (const pin of scene.pins) {
            if (np >= pinCap) break;
            if (pin.ax < x0 || pin.ax > x1 || pin.ay < y0 || pin.ay > y1) continue;
            pinBuf.set([pin.ax, pin.ay, pin.size, pin.r], np * 4);
            np += 1;
        }
        for (const ter of scene.ters) {
            if (nt >= terCap) break;
            if (ter.ax + ter.r < x0 || ter.ax - ter.r > x1 || ter.ay + ter.r < y0 || ter.ay - ter.r > y1) continue;
            terBuf.set([ter.ax, ter.ay, ter.r, ter.w], nt * 4);
            nt += 1;
        }
        gl.uniform4fv(U.uPin, pinBuf);
        gl.uniform1i(U.uNP, np);
        gl.uniform4fv(U.uTer, terBuf);
        gl.uniform1i(U.uNT, nt);
        /* the roads: culled like the towns, capped per tier */
        const legCap = qIndex >= 2 ? 64 : qIndex === 1 ? 48 : 32;
        let nl = 0;
        for (const seg of scene.legs) {
            if (nl >= legCap) break;
            if (Math.max(seg[0], seg[2]) < x0 || Math.min(seg[0], seg[2]) > x1
                || Math.max(seg[1], seg[3]) < y0 || Math.min(seg[1], seg[3]) > y1) continue;
            legBuf.set(seg, nl * 4);
            nl += 1;
        }
        gl.uniform4fv(U.uLeg, legBuf);
        gl.uniform1i(U.uNL, nl);
        /* the mockup's slider maxima as the fixed baseline: the look at the
           strength the user liked - sliders can return as settings later */
        gl.uniform1f(U.uRelief, 1.6);
        gl.uniform1f(U.uWater, 2.0);
        gl.uniform1f(U.uForest, 1.6);
        gl.uniform1f(U.uTowns, 1.4);

        /* harvest the previous frame's GPU time before starting this one */
        if (timerExt && timerQuery && timerOut && gl.getQueryParameter(timerQuery, gl.QUERY_RESULT_AVAILABLE)) {
            timerOut = false;
            const ns = gl.getQueryParameter(timerQuery, gl.QUERY_RESULT);
            if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
                if (warm > 0) warm -= 1;
                else if (ns > 40e6 && qIndex > 0) {
                    slowStreak += 1;
                    if (slowStreak >= 3) {
                        slowStreak = 0;
                        qIndex -= 1;
                    }
                } else slowStreak = 0;
            }
        }
        const timed = !!(timerExt && timerQuery && !timerOut);
        if (timed) gl.beginQuery(timerExt.TIME_ELAPSED_EXT, timerQuery);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (timed) {
            gl.endQuery(timerExt.TIME_ELAPSED_EXT);
            timerOut = true;
        }
    };

    return {
        ok: true,
        updateScene,
        draw,
        dispose() {
            gl.deleteProgram(prog);
            gl.deleteBuffer(buffer);
            if (timerQuery) gl.deleteQuery(timerQuery);
        },
        get quality() { return qIndex; },
        setQuality(index) { qIndex = Math.max(0, Math.min(TERRAIN_QUALITY.length - 1, index)); warm = 4; slowStreak = 0; },
    };
}
