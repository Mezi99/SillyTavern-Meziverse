/**
 * The Character Library's pure core: record shapes, sprite payload reads,
 * and the portrait-resolution order. Synthetic strings only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SUGGESTED_LABELS,
    cleanSpriteLabel,
    normalizeLibraryRecord,
    resolveLibraryPortrait,
    spriteLabelMap,
    spriteNameFromPath,
    spriteRowsFromPayload,
} from '../src/library.js';

test('normalizeLibraryRecord trims its fields and stamps the date', () => {
    const record = normalizeLibraryRecord({ name: '  Mara Vane ', portrait: ' user/images/meziverse/x.webp ' });
    assert.equal(record.name, 'Mara Vane');
    assert.equal(record.portrait, 'user/images/meziverse/x.webp');
    assert.ok(record.addedAt && !Number.isNaN(Date.parse(record.addedAt)));
});

test('normalizeLibraryRecord keeps a given date and shrugs at nothing', () => {
    const record = normalizeLibraryRecord({ name: 'A', addedAt: '2026-11-18T00:00:00.000Z' });
    assert.equal(record.addedAt, '2026-11-18T00:00:00.000Z');

    const empty = normalizeLibraryRecord();
    assert.equal(empty.name, '');
    assert.equal(empty.portrait, '');
    assert.ok(empty.addedAt);
});

test('cleanSpriteLabel folds case and strips the folder-hostile marks', () => {
    assert.equal(cleanSpriteLabel('Joy'), 'joy');
    assert.equal(cleanSpriteLabel('big-smile'), 'big smile');
    assert.equal(cleanSpriteLabel('v.2 look'), 'v 2 look');
    assert.equal(cleanSpriteLabel('  Spaced   Out  '), 'spaced out');
    assert.equal(cleanSpriteLabel(''), '');
    assert.equal(cleanSpriteLabel(null), '');
});

test('spriteNameFromPath reads the file base out of a sprite url', () => {
    assert.equal(spriteNameFromPath('/characters/Mara Vane/joy-1.png?t=20260101120000'), 'joy-1');
    assert.equal(spriteNameFromPath('/characters/A/plain.png'), 'plain');
    assert.equal(spriteNameFromPath('/characters/A/my%20sprite.jpg'), 'my sprite');
    assert.equal(spriteNameFromPath(''), '');
});

test('spriteRowsFromPayload tidies, skips and sorts', () => {
    assert.deepEqual(spriteRowsFromPayload(null), []);
    assert.deepEqual(spriteRowsFromPayload({ nope: true }), []);

    const rows = spriteRowsFromPayload([
        { label: 'Joy', path: '/characters/A/joy-1.png?t=1' },
        { label: 'joy', path: '/characters/A/joy.png?t=1' },
        { path: '/characters/A/lost.png' },
        { label: 'anger', path: '' },
        { label: 'anger', path: '/characters/A/anger.png?t=1' },
    ]);

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.spriteName), ['anger', 'joy', 'joy-1']);
    assert.equal(rows[1].label, 'joy');
    assert.equal(rows[1].path, '/characters/A/joy.png?t=1');
});

test('spriteLabelMap keeps the first row of each label', () => {
    const sorted = spriteRowsFromPayload([
        { label: 'joy', path: '/characters/A/joy-1.png' },
        { label: 'joy', path: '/characters/A/joy.png' },
        { label: 'anger', path: '/characters/A/anger.png' },
    ]);
    const map = spriteLabelMap(sorted);
    assert.equal(map.size, 2);
    assert.equal(map.get('joy').spriteName, 'joy');
    assert.equal(map.get('anger').spriteName, 'anger');
});

test('resolveLibraryPortrait: the chat face wins, then the library face', () => {
    const library = {
        'mara vane': { name: 'Mara Vane', portrait: 'user/images/meziverse/lib.webp' },
        'kai': { name: 'Kai', portrait: '' },
    };

    assert.equal(resolveLibraryPortrait('mara vane', { 'mara vane': 'user/images/meziverse/chat.webp' }, library), 'user/images/meziverse/chat.webp');
    assert.equal(resolveLibraryPortrait('mara vane', {}, library), 'user/images/meziverse/lib.webp');
    assert.equal(resolveLibraryPortrait('mara vane', { 'mara vane': '   ' }, library), 'user/images/meziverse/lib.webp');
    assert.equal(resolveLibraryPortrait('kai', {}, library), '');
    assert.equal(resolveLibraryPortrait('stranger', {}, library), '');
});

test('SUGGESTED_LABELS is SillyTavern\'s own 28', () => {
    assert.equal(SUGGESTED_LABELS.length, 28);
    assert.equal(new Set(SUGGESTED_LABELS).size, 28);
    assert.ok(SUGGESTED_LABELS.includes('neutral'));
});
