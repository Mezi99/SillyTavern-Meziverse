import test from 'node:test';
import assert from 'node:assert/strict';

import {
    climateTemp,
    deriveTerrainRecord,
    fogReveal,
    paletteFromSamples,
    ratiosFromText,
    skyFor,
    validateTerrainRecord,
    weatherFx,
} from '../src/terrain.js';

import { buildAtlas, deriveLegs, layoutAtlas } from '../src/mapdata.js';

const HEX = /^#[0-9a-f]{6}$/;

/* ---------- ratios from words ---------- */

test('ratiosFromText: the words a picture was painted from decide its land', () => {
    const foresty = ratiosFromText(['a dense pine forest, mossy rocks, a wooden bridge'], 'x');
    assert.ok(foresty.forest > 0.5, `forest ${foresty.forest}`);
    const rocky = ratiosFromText(['sheer granite cliffs above a rocky canyon'], 'x');
    assert.ok(rocky.rugged > 0.5, `rugged ${rocky.rugged}`);
    const wet = ratiosFromText(['a river mouth, fishing boats, a rainy harbour pier'], 'x');
    assert.ok(wet.water > 0.5, `water ${wet.water}`);
});

test('ratiosFromText: cities are a counterweight to forest', () => {
    const wild = ratiosFromText(['forest and pine trees'], 'x');
    const built = ratiosFromText(['forest and pine trees', 'city streets, towers, office blocks'], 'x');
    assert.ok(built.forest < wild.forest, `${built.forest} < ${wild.forest}`);
});

test('ratiosFromText: words match at word starts only', () => {
    const out = ratiosFromText(['an important meeting in a forest'], 'x');
    assert.equal(out.water, 0.22, '"important" is never a port');
    assert.ok(out.forest > 0.3);
});

test('ratiosFromText: nothing to read seeds from the name, never wobbles', () => {
    const a = ratiosFromText(['a quiet room with beige walls'], 'japan');
    const b = ratiosFromText([], 'japan');
    const c = ratiosFromText([], 'japan');
    assert.deepEqual(b, c, 'same fold, same seed');
    assert.deepEqual(a, b, 'no keywords anywhere means seeded for both');
    for (const value of Object.values(b)) assert.ok(value >= 0 && value <= 1);
});

test('ratiosFromText: saturated reading stays inside 0..1', () => {
    const many = ratiosFromText(['forest forest forest forest forest'], 'x');
    assert.ok(many.forest <= 1 && many.forest >= 0);
    assert.ok(many.rugged >= 0);
});

/* ---------- palette from pictures ---------- */

test('paletteFromSamples: no pictures seeds one character per region', () => {
    const a = paletteFromSamples([], 'maras rest');
    const b = paletteFromSamples([], 'maras rest');
    const other = paletteFromSamples([], 'kessel drift');
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    for (const hex of a) assert.match(hex, HEX);
    assert.notDeepEqual(a, other, 'different regions, different character');
});

test('paletteFromSamples: land, forest and highland come out of the pixels', () => {
    const samples = [
        '#4a3520', '#3d2c1a', '#2f4a24', '#27401e',
        '#6b5638', '#c8b98e', '#d8cda6', '#59462c',
    ];
    const [land, forest, high] = paletteFromSamples(samples, 'x');
    const light = hex => {
        const n = parseInt(hex.slice(1), 16);
        return ((n >> 16 & 255) + (n >> 8 & 255) + (n & 255)) / 3;
    };
    assert.ok(light(forest) < light(land), 'forest is the dark of the frame');
    assert.ok(light(high) > light(land), 'highland is the bright of the frame');
});

test('paletteFromSamples: raw rgb triples and stray junk are all tolerated', () => {
    const a = paletteFromSamples([[200, 30, 30], [20, 120, 40], [240, 230, 210], null, 'nope'], 'x');
    for (const hex of a) assert.match(hex, HEX);
});

/* ---------- climate ---------- */

test('climateTemp: the story\\u2019s weather says how warm its world reads', () => {
    assert.equal(climateTemp([{ weather: 'Blizzard' }, { weather: 'snow' }]), -1);
    assert.equal(climateTemp([{ weather: 'desert heat' }]), 1);
    assert.equal(climateTemp([{ weather: 'scorching days, freezing nights' }]), 0);
    assert.equal(climateTemp([{ weather: '' }, {}]), 0);
    assert.equal(climateTemp([{ weather: 'light rain' }]), 0, 'rain is not temperature');
});

/* ---------- the record ---------- */

const REGIONS = [
    { fold: 'usa', name: 'USA' },
    { fold: 'japan', name: 'Japan' },
];

test('deriveTerrainRecord: one small record, derived the same every time', () => {
    const spec = {
        regions: REGIONS,
        samplesByRegion: { usa: ['#8c9b62', '#456b3b', '#8d8779', '#a09a72', '#c2b58c'] },
        textsByRegion: { usa: ['brick brownstone, street trees'], japan: ['cedar forest hillside, torii'] },
        observations: [{ weather: 'rain' }],
        seed: 3,
    };
    const a = deriveTerrainRecord(spec);
    const b = deriveTerrainRecord(spec);
    assert.deepEqual(a, b, 'same chat, same record');
    assert.equal(a.seed, 3);
    assert.match(a.sea, HEX);
    assert.match(a.shallow, HEX);
    assert.match(a.town, HEX);
    assert.deepEqual(Object.keys(a.regions).sort(), ['japan', 'usa']);
    for (const region of Object.values(a.regions)) {
        assert.equal(region.colors.length, 3);
        for (const hex of region.colors) assert.match(hex, HEX);
        for (const ratio of [region.rugged, region.forest, region.water]) {
            assert.ok(ratio >= 0 && ratio <= 1);
        }
    }
});

test('deriveTerrainRecord: climate warms or cools the whole palette', () => {
    const base = { regions: REGIONS };
    const cold = deriveTerrainRecord({ ...base, observations: [{ weather: 'blizzard' }] });
    const hot = deriveTerrainRecord({ ...base, observations: [{ weather: 'desert heat' }] });
    const mild = deriveTerrainRecord(base);
    assert.notEqual(cold.sea, hot.sea);
    assert.notEqual(mild.regions.usa.colors[0], hot.regions.usa.colors[0]);
    assert.deepEqual(mild, deriveTerrainRecord(base), 'the neutral case is stable');
});

/* ---------- validation ---------- */

test('validateTerrainRecord: the hand-edited record is checked before believed', () => {
    const good = { seed: 1, sea: '#143a45', shallow: '#2b7b82', town: '#b9b2a4', regions: { x: { rugged: 0.4, forest: 0.5, water: 0.3, colors: ['#111111', '#222222', '#333333'] } } };
    assert.deepEqual(validateTerrainRecord(JSON.stringify(good)), { ok: true, record: good });
    assert.deepEqual(validateTerrainRecord(good), { ok: true, record: good });

    assert.equal(validateTerrainRecord('{oops').ok, false);
    assert.equal(validateTerrainRecord('[1,2]').ok, false);
    assert.equal(validateTerrainRecord({ sea: '#143a45' }).ok, false);
    assert.equal(validateTerrainRecord({ ...good, sea: 'blue' }).ok, false);
    assert.equal(validateTerrainRecord({ regions: { x: { colors: ['#111111'] } } }).ok, false);
    assert.equal(validateTerrainRecord({ regions: { x: { rugged: 1.5, colors: ['#111111', '#222222', '#333333'] } } }).ok, false);
    // missing ratios are forgiven - derivation defaults can fill them
    assert.equal(validateTerrainRecord({ regions: { x: { colors: ['#111111', '#222222', '#333333'] } } }).ok, true);
});

/* ---------- the sky ---------- */

test('skyFor: noon is plain light, midnight is night', () => {
    const noon = skyFor(12);
    assert.deepEqual(noon.tint, [1, 1, 1]);
    assert.equal(noon.night, 0);
    const midnight = skyFor(0);
    assert.equal(midnight.night, 1);
    assert.ok(midnight.tint[2] > midnight.tint[0], 'night tints blue');
    assert.deepEqual(skyFor(null), skyFor(12), 'an unknown hour reads as day');
});

test('skyFor: hours blend between the keys, and wrap past midnight', () => {
    const six = skyFor(6);
    assert.ok(six.night < 0.72 && six.night > 0.15, `six sits between night and dawn: ${six.night}`);
    const late = skyFor(23);
    assert.ok(late.night > 0.85, `23h is nearly night: ${late.night}`);
    const dawn = skyFor(7);
    assert.ok(dawn.warm > skyFor(12).warm, 'dawn light is warmer than noon');
});

test('skyFor: the sun is a direction, and stays one', () => {
    for (const hour of [0, 3, 6, 9, 12, 15, 18, 21, 23.5]) {
        const { sun } = skyFor(hour);
        assert.equal(sun.length, 3);
        for (const axis of sun) assert.ok(axis >= -1 && axis <= 1);
    }
    assert.ok(skyFor(12).sun[2] > skyFor(0).sun[2], 'the sun is high at noon');
});

/* ---------- the weather ---------- */

test('weatherFx: one overlay per sky, strongest word wins', () => {
    assert.deepEqual(weatherFx('light rain'), { kind: 'rain', strength: 0.55 });
    assert.deepEqual(weatherFx('thunderstorm'), { kind: 'storm', strength: 0.55 });
    assert.deepEqual(weatherFx('snowing'), { kind: 'snow', strength: 0.55 });
    assert.deepEqual(weatherFx('thunder and rain'), { kind: 'storm', strength: 0.55 });
    assert.deepEqual(weatherFx('drizzle, drizzle, heavy drizzle'), { kind: 'rain', strength: 0.85 });
    assert.deepEqual(weatherFx('Dust haze, 28\u00b0C'), { kind: 'sand', strength: 0.55 });
    assert.deepEqual(weatherFx('Grey overcast, 46\u00b0F'), { kind: 'fog', strength: 0.7 }, 'grey AND overcast: the veil thickens');
    assert.deepEqual(weatherFx('Cool autumn night, 16\u00b0C'), { kind: null, strength: 0 }, 'a temperature is not a weather');
    assert.deepEqual(weatherFx('clear skies'), { kind: null, strength: 0 });
    assert.deepEqual(weatherFx(''), { kind: null, strength: 0 });
});

/* ---------- fog of war ---------- */

const item = (id, x, y, r = 17) => ({ n: { id }, r, pin: true, kids: [], ax: x, ay: y });

test('fogReveal: the trail paints the world open', () => {
    const layout = {
        items: {
            a: item('a', 0, 0),
            b: item('b', 100, 0),
            c: item('c', 200, 0),
        },
    };
    const atlas = {
        nodes: {
            a: { id: 'a', kind: 'spot', stops: 3 },
            b: { id: 'b', kind: 'spot', stops: 0 },
            c: { id: 'c', kind: 'spot', stops: 1 },
        },
    };
    const derived = {
        legs: [{ a: 'a', b: 'b', count: 2 }, { a: 'b', b: 'c', count: 1 }],
        nowId: 'c',
    };
    const { spots, ribbons } = fogReveal(layout, atlas, derived);
    assert.equal(ribbons.length, 2);
    assert.equal(ribbons[0].w, 0.66, 'a twice-worn trail is wider');
    assert.ok(ribbons[0].w > ribbons[1].w);

    const byId = Object.fromEntries(spots.map(s => [s.id, s]));
    assert.ok(byId.a.w >= 0.5, 'a place responses happened at breathes clear');
    assert.ok(byId.a.r > byId.b.r * 1.5, 'more turns, a wider clearing');
    assert.equal(byId.b.w, 0.18, 'passed through: the veil stays thin');
    assert.equal(byId.c.w, 1, 'the story\\u2019s now is always clear');
});

test('fogReveal: vehicles and soft evidence draw no fog of their own', () => {
    const layout = { items: { v: item('v', 0, 0), t: item('t', 50, 0) } };
    const atlas = {
        nodes: {
            v: { id: 'v', kind: 'mobile', stops: 2 },
            t: { id: 't', kind: 'transient', stops: 2 },
        },
    };
    const { spots, ribbons } = fogReveal(layout, atlas, { legs: [], nowId: null });
    assert.equal(spots.length, 0);
    assert.equal(ribbons.length, 0);
});

test('fogReveal: legs whose ends left the layout are skipped, not fatal', () => {
    const layout = { items: { a: item('a', 0, 0) } };
    const atlas = { nodes: { a: { id: 'a', kind: 'spot', stops: 1 } } };
    const derived = { legs: [{ a: 'a', b: 'gone', count: 1 }], nowId: 'a' };
    const { spots, ribbons } = fogReveal(layout, atlas, derived);
    assert.equal(ribbons.length, 0);
    assert.equal(spots.length, 1);
});

test('fogReveal: wears the real atlas without a stumble', () => {
    const base = { date: '', time: '', hour: null, weather: '', locationTag: '', present: [], last: false };
    const observations = [
        { ...base, chain: ['Space', 'Port', 'Pier 9'], at: { msgIndex: 0, tagIndex: 0 }, last: true },
        { ...base, chain: ['Space', 'Port', 'Market Row'], at: { msgIndex: 1, tagIndex: 0 }, last: true },
        { ...base, chain: ['Space', 'Port', 'Market Row'], at: { msgIndex: 2, tagIndex: 0 }, last: true },
        { ...base, chain: ['Space', 'Kessel Drift', 'Dock'], at: { msgIndex: 3, tagIndex: 0 }, last: true },
    ];
    const atlas = buildAtlas(observations);
    const layout = layoutAtlas(atlas);
    const derived = deriveLegs(atlas);
    const { spots, ribbons } = fogReveal(layout, atlas, derived);
    assert.ok(spots.length >= 3, `spots ${spots.length}`);
    assert.ok(ribbons.length >= 1, `ribbons ${ribbons.length}`);
    for (const spot of spots) {
        assert.ok(Number.isFinite(spot.ax) && Number.isFinite(spot.ay) && spot.r > 0 && spot.w > 0);
    }
    const now = spots.find(spot => spot.w === 1);
    assert.ok(now, 'the now is always clear somewhere');
});
