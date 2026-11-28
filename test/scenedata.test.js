import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPlaceTree,
    buildReview,
    exactRows,
    matchesRow,
    planEdits,
    renameChanges,
} from '../src/scenedata.js';

/* Synthetic scene tags only - the same grammar the story writes. */
const scene = (location, { time = '09:00', weather = 'Clear, 12C', date = 'Day 1', present = 'Eli' } = {}) => {
    const attrs = [
        `date="${date}"`,
        time ? `time="${time}"` : '',
        weather ? `weather="${weather}"` : '',
        `location="${location}"`,
        present ? `present="${present}"` : '',
    ].filter(Boolean).join(' ');
    return `<scene ${attrs} />`;
};

const messagesOf = (...texts) => texts.map(mes => ({ mes }));

test('buildReview keeps the write ordinal separate from the usable-scene ordinal', () => {
    // The middle tag is complete but too thin for describeScenes to show. It
    // still counts for editSceneAttrs, so the third row must write at tag 2.
    const text = [
        scene('USA | House'),
        '<scene />',
        scene('USA | Diner'),
    ].join('\n');
    const { rows } = buildReview(messagesOf(text));

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.at), [0, 2]);
    assert.deepEqual(rows.map(row => row.tagIndex), [0, 1]);
    assert.deepEqual(rows[1].levels, ['USA', 'Diner']);
});

test('buildReview reads only the selected swipe', () => {
    const hotel = scene('USA | Hotel | Lobby');
    const docks = scene('USA | Docks | Pier 9');
    const message = { mes: hotel, swipes: [hotel, docks], swipe_id: 1 };

    assert.deepEqual(buildReview([message]).rows[0].levels, ['USA', 'Docks', 'Pier 9']);
});

test('the guide flags spelling drift toward the spelling the story uses more', () => {
    const common = scene('USA | Springfield | Blackwood Manor');
    const texts = [common, common, scene('USA | Springfield | Blackwood Mannor')];
    const { rows } = buildReview(messagesOf(...texts));
    const typo = rows.find(row => row.placeKey.includes('Mannor'));

    assert.ok(typo);
    assert.ok(typo.hard);
    assert.deepEqual(typo.flags.find(flag => flag.key === 'typo')?.kind, 'typo');
    assert.deepEqual(typo.fix.levels, ['USA', 'Springfield', 'Blackwood Manor']);
});

test('a digit-only difference is not a flag, even when one spelling is rarer', () => {
    const pier9 = scene('USA | Docks | Pier 9');
    const texts = [pier9, pier9, scene('USA | Docks | Pier 10')];
    const { rows } = buildReview(messagesOf(...texts));
    const ten = rows.find(row => row.placeKey.endsWith('Pier 10'));

    assert.ok(ten);
    assert.equal(ten.hard, false);
    assert.equal(ten.flags.some(flag => flag.key === 'typo'), false);
    assert.equal(ten.flags.some(flag => flag.key.startsWith('map-')), false);
});

test('a shallow location with a deeper same-named leaf suggests its parents', () => {
    const { rows } = buildReview(messagesOf(scene('Office'), scene('Building | Office')));
    const short = rows.find(row => row.placeKey === 'Office');

    assert.ok(short?.hard);
    assert.equal(short.flags.find(flag => flag.key === 'parents')?.kind, 'parents');
    assert.deepEqual(short.fix.levels, ['Building', 'Office']);
});

test('missing time and weather are soft chips, never a hard flag', () => {
    const { rows } = buildReview(messagesOf(scene('Home', { time: '', weather: '' })));
    const keys = rows[0].flags.map(flag => flag.key);

    assert.ok(keys.includes('soft-time'));
    assert.ok(keys.includes('soft-weather'));
    assert.equal(rows[0].hard, false);
});

test('the map\'s similar-place flag joins the story flags', () => {
    const hotel = scene('USA | Grand Hotel');
    const { rows } = buildReview(messagesOf(hotel, hotel, scene('USA | Grand Hotel Annex')));
    const annex = rows.find(row => row.placeKey.endsWith('Grand Hotel Annex'));

    assert.ok(annex?.hard);
    assert.equal(annex.flags.find(flag => flag.key === 'map-same')?.kind, 'similar');
});

test('buildPlaceTree folds spelling drift into one node and roots are populated', () => {
    const texts = [
        scene("St. Vincent's | Hall"),
        scene("St. Vincent's | Hall"),
        scene('St Vincents | Cupboard'),
    ];
    const { rows } = buildReview(messagesOf(...texts));
    const { roots, byKey } = buildPlaceTree(rows);

    assert.equal(roots.length, 1);
    assert.equal(roots[0].all.length, 3);
    assert.equal(roots[0].children.length, 2);
    assert.equal(byKey.get(roots[0].key), roots[0]);

    const changes = renameChanges(rows, roots[0], 'St Vincent');
    assert.equal(changes.length, 3);
    assert.ok(changes.every(change => change.levels[0] === 'St Vincent'));
});

test('search covers places, cast, date, time and message number', () => {
    const { rows } = buildReview(messagesOf(scene('USA | House', { present: 'Mike', date: 'Day 9', time: '18:40' })));
    const row = rows[0];

    assert.equal(matchesRow(row, 'house'), true);
    assert.equal(matchesRow(row, 'mike'), true);
    assert.equal(matchesRow(row, 'day 9'), true);
    assert.equal(matchesRow(row, '18:40'), true);
    assert.equal(matchesRow(row, '#1'), true);
    assert.equal(matchesRow(row, 'nowhere'), false);
});

test('planEdits groups a message into one write and drops no-ops', () => {
    const text = [scene('A | One'), scene('A | Two'), scene('A | Three')].join('\n');
    const { rows } = buildReview(messagesOf(text));
    const writes = planEdits(rows, [
        { id: rows[0].id, levels: ['X', 'One'] },
        { id: rows[1].id, levels: rows[1].levels },
        { id: rows[2].id, levels: ['X', 'Three'] },
    ]);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].msgIndex, 0);
    assert.equal(writes[0].edits, 2);
    assert.equal(writes[0].before, text);
    assert.equal(writes[0].after.includes('location="X | One"'), true);
    assert.equal(writes[0].after.includes('location="X | Three"'), true);
    assert.equal(writes[0].after.includes('location="A | Two"'), true);
});

test('exactRows targets the same written location, not merely a folded twin', () => {
    const { rows } = buildReview(messagesOf(
        scene("St. Vincent's | Hall"),
        scene('St Vincents | Hall'),
        scene('St Vincents | Hall'),
        scene('St Vincents | Cupboard'),
    ));

    assert.equal(exactRows(rows, rows[0]).length, 1);
    assert.equal(exactRows(rows, rows[1]).length, 2);
    assert.equal(exactRows(rows, rows[1]).some(row => row === rows[3]), false);
});
