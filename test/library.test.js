/**
 * The Character Library's pure core: record shapes, sprite payload reads,
 * and the portrait-resolution order. Synthetic strings only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CORE_LABELS,
    EXPRESSION_FAMILIES,
    SUGGESTED_LABELS,
    cleanSpriteLabel,
    labelFamily,
    matchLabel,
    normalizeLibraryRecord,
    recordFirst,
    resolveLibraryMatch,
    resolveLibraryPortrait,
    spriteCoverage,
    spriteLabelMap,
    spriteNameFromPath,
    spriteRowsFromPayload,
    visibleLibrary,
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

test('the first-name field defaults to the name\'s first word and keeps its own', () => {
    assert.equal(normalizeLibraryRecord({ name: 'Mike Smith' }).first, 'Mike');
    assert.equal(normalizeLibraryRecord({ name: 'Mike Smith', first: 'Mikey' }).first, 'Mikey');
    assert.equal(normalizeLibraryRecord({ name: 'Eli' }).first, 'Eli');

    // records saved before the field existed ride the fallback
    assert.equal(recordFirst({ name: 'Mike Reynolds' }), 'Mike');
    assert.equal(recordFirst({ name: 'Mike Reynolds', first: ' Ren ' }), 'Ren');
    assert.equal(recordFirst({}), '');
});

test('resolveLibraryMatch: the chat\'s binding beats everything', () => {
    const entries = {
        'mike smith': { name: 'Mike Smith', first: 'Mike', addedAt: '2026-01-01' },
        'mike reynolds': { name: 'Mike Reynolds', first: 'Mike', addedAt: '2026-02-01' },
    };
    const match = resolveLibraryMatch('Mike', entries, { mike: 'mike smith' });
    assert.equal(match.kind, 'one');
    assert.equal(match.record.name, 'Mike Smith');
});

test('resolveLibraryMatch: a record named exactly like the tag wins alone', () => {
    const entries = {
        'mike': { name: 'Mike', addedAt: '2026-01-01' },
        'mike smith': { name: 'Mike Smith', first: 'Mike', addedAt: '2026-02-01' },
    };
    const match = resolveLibraryMatch('  MIKE ', entries);
    assert.equal(match.kind, 'one');
    assert.equal(match.record.name, 'Mike');
    assert.deepEqual(match.candidates.map(record => record.name), ['Mike']);
});

test('resolveLibraryMatch: one first-name claim binds itself, two are the two-Mikes case', () => {
    const entries = {
        'mara vane': { name: 'Mara Vane', first: 'Mara', addedAt: '2026-01-01' },
    };
    const one = resolveLibraryMatch('Mara', entries);
    assert.equal(one.kind, 'one');
    assert.equal(one.record.name, 'Mara Vane');

    // two Mikes: the most recently used shows first, the candidates swap
    const two = {
        'mike smith': { name: 'Mike Smith', first: 'Mike', addedAt: '2026-01-01' },
        'mike reynolds': { name: 'Mike Reynolds', first: 'Mike', addedAt: '2026-02-01' },
    };
    const match = resolveLibraryMatch('mike', two);
    assert.equal(match.kind, 'ambiguous');
    assert.equal(match.record.name, 'Mike Reynolds');          // added later
    assert.deepEqual(match.candidates.map(record => record.name), ['Mike Reynolds', 'Mike Smith']);

    // a use outweighs the add date
    two['mike smith'].lastUsedAt = '2026-03-01';
    const used = resolveLibraryMatch('Mike', two);
    assert.equal(used.record.name, 'Mike Smith');

    assert.equal(resolveLibraryMatch('Nobody', two), null);
    assert.equal(resolveLibraryMatch('', two), null);
    assert.equal(resolveLibraryMatch('Mike', null), null);
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

test('visibleLibrary: the filters narrow saved records, the query narrows by name', () => {
    const entries = {
        'mara vane': { name: 'Mara Vane', portrait: '' },
        'kai': { name: 'Kai', portrait: '' },
        'sol': { name: 'Sol', portrait: '' },
    };
    const chatKeys = new Set(['mara vane', 'sol']);
    const sceneKeys = new Set(['sol']);
    const names = rows => rows.map(record => record.name);

    assert.deepEqual(names(visibleLibrary(entries)), ['Kai', 'Mara Vane', 'Sol']);
    assert.deepEqual(names(visibleLibrary(entries, { filter: 'chat', chatKeys, sceneKeys })), ['Mara Vane', 'Sol']);
    assert.deepEqual(names(visibleLibrary(entries, { filter: 'scene', chatKeys, sceneKeys })), ['Sol']);
    assert.deepEqual(names(visibleLibrary(entries, { query: '  ma ' })), ['Mara Vane']);
    assert.deepEqual(names(visibleLibrary(entries, { filter: 'scene', query: 'k', chatKeys, sceneKeys })), []);
    assert.deepEqual(names(visibleLibrary(entries, { filter: 'incomplete', needsKeys: new Set(['kai']) })), ['Kai']);
    assert.deepEqual(names(visibleLibrary(entries, { filter: 'incomplete' })), []);
    assert.deepEqual(names(visibleLibrary(null)), []);
});

test('the families regroup the 28 without losing any', () => {
    const flat = EXPRESSION_FAMILIES.flatMap(family => family.labels);
    assert.equal(flat.length, 28);
    assert.deepEqual(new Set(flat), new Set(SUGGESTED_LABELS));
    assert.equal(CORE_LABELS.length, 8);
    assert.equal(new Set(CORE_LABELS).size, 8);

    assert.equal(labelFamily('joy'), 'core');
    assert.equal(labelFamily('pride'), 'warm');
    assert.equal(labelFamily('grief'), 'tense');
    assert.equal(labelFamily('curiosity'), 'mind');
    assert.equal(labelFamily('smug'), 'custom');
    assert.equal(labelFamily(' Joy '), 'core');
});

test('matchLabel: filenames pick the slot, the trailing number picks the file', () => {
    const known = SUGGESTED_LABELS;

    assert.deepEqual(matchLabel('joy.png', known), { label: 'joy', extraIndex: 0 });
    assert.deepEqual(matchLabel('sadness-2.png', known), { label: 'sadness', extraIndex: 2 });
    assert.deepEqual(matchLabel('Sadness_2.png', known), { label: 'sadness', extraIndex: 2 });
    assert.deepEqual(matchLabel('JOY-1.webp', known), { label: 'joy', extraIndex: 1 });
    assert.deepEqual(matchLabel('nervousness.jpeg', known), { label: 'nervousness', extraIndex: 0 });

    // names the fold cannot place wait in the tray
    assert.equal(matchLabel('smug_face_final.png', known), null);
    assert.equal(matchLabel('IMG_0412.png', known), null);
    assert.equal(matchLabel('portrait.png', known), null);
    assert.equal(matchLabel('', known), null);
    assert.equal(matchLabel('joy.png', []), null);

    // custom labels are known too when the folder already carries them
    assert.deepEqual(matchLabel('big_grin.png', ['joy', 'big grin']), { label: 'big grin', extraIndex: 0 });
});

test('spriteCoverage: 28-counts, core counts, and the files beyond', () => {
    const rows = [
        { label: 'joy', spriteName: 'joy', path: '' },
        { label: 'joy', spriteName: 'joy-1', path: '' },
        { label: 'sadness', spriteName: 'sadness', path: '' },
        { label: 'smug', spriteName: 'smug', path: '' },
    ];
    const coverage = spriteCoverage(rows);

    assert.equal(coverage.count, 2);       // joy + sadness among the 28
    assert.equal(coverage.core, 2);        // both are core
    assert.equal(coverage.files, 4);
    assert.equal(coverage.extra, 2);       // joy-1 + the custom 'smug'
    assert.deepEqual(coverage.set, new Set(['joy', 'sadness', 'smug']));

    const none = spriteCoverage(null);
    assert.equal(none.count, 0);
    assert.equal(none.extra, 0);
});
