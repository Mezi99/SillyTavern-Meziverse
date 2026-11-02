import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BG_STORE_VERSION,
    aliasLocation,
    currentRecord,
    decide,
    knownBackgroundsList,
    locationKey,
    lookupRecord,
    normalizeStore,
    recoverCurrentKey,
    resolveRecordId,
    storeRecord,
    toCssBgUrl,
} from '../src/backgrounds.js';

test('locationKey folds spelling drift to one key', () => {
    assert.equal(locationKey('The city |  Docks | Pier 9 '), 'the city | docks | pier 9');
    assert.equal(locationKey('the city | Docks | PIER 9'), 'the city | docks | pier 9');
    assert.equal(locationKey(' The   Docks '), 'the docks');
    assert.equal(locationKey(''), '');
    assert.equal(locationKey(null), '');
});

test('normalizeStore fills the shape and repairs what it can', () => {
    assert.deepEqual(normalizeStore(), {
        version: BG_STORE_VERSION,
        currentKey: null,
        keys: {},
        records: {},
        nextId: 1,
    });

    const raw = {};
    assert.equal(normalizeStore(raw), raw, 'mutates in place - the store lives on chatMetadata');

    const messy = normalizeStore({
        currentKey: 'The Docks ',
        keys: { 'The Docks': 'bg_7', Elsewhere: 'bg_404', Dangling: 5 },
        records: { bg_7: { id: 'bg_7', path: '/images/docks.png' }, bg_9: 'junk' },
        nextId: 3,
    });
    assert.equal(messy.currentKey, 'the docks');
    assert.deepEqual(Object.keys(messy.keys), ['the docks']);
    assert.deepEqual(Object.keys(messy.records), ['bg_7']);
    assert.equal(messy.nextId, 10, 'ids are never recycled - not even the number of a corrupt record that gets pruned');

    const roomy = normalizeStore({ records: { bg_7: {} }, nextId: 99 });
    assert.equal(roomy.nextId, 99, 'a larger stored nextId is kept');
});

test('storeRecord keeps the newest image per place and rebinds current', () => {
    const store = normalizeStore();

    const first = storeRecord(store, {
        key: 'The city | Docks | Pier 9',
        place: 'Pier 9',
        prompt: 'a wooden pier at dusk',
        path: '/images/pier.png',
    });
    assert.equal(first.id, 'bg_1');
    assert.equal(first.url, 'url("/images/pier.png")');
    assert.equal(store.currentKey, 'the city | docks | pier 9');
    assert.equal(currentRecord(store), first);

    const again = storeRecord(store, {
        key: 'The city | Docks | Pier 9',
        place: 'Pier 9',
        prompt: 'new',
        path: '/images/pier2.png',
    });
    assert.equal(again.id, 'bg_2', 'without overwrite every generation adds a record');
    assert.equal(lookupRecord(store, 'The city | Docks | Pier 9'), again, 'the key follows the newest record');

    const fresh = storeRecord(store, {
        key: 'The city | Docks | Pier 9',
        place: 'Pier 9',
        prompt: 'fresher',
        path: '/images/pier3.png',
        overwrite: true,
    });
    assert.equal(fresh.id, 'bg_2', 'overwrite replaces the record in place');
    assert.equal(store.records.bg_2.prompt, 'fresher');
    assert.equal(store.nextId, 3);

    assert.equal(storeRecord(store, { place: '', path: '' }), null, 'a missing place or path is refused');
});

test('aliasLocation folds a spelling drift onto the matched record', () => {
    const store = normalizeStore();
    const record = storeRecord(store, {
        key: 'The Docks',
        place: 'The Docks',
        prompt: 'rain-slick docks',
        path: '/images/docks.png',
    });

    const aliased = aliasLocation(store, 'The Docks!!', 'bg_1');
    assert.equal(aliased, record);
    assert.equal(store.keys['the docks!!'], 'bg_1');
    assert.equal(store.currentKey, 'the docks!!');

    assert.equal(aliasLocation(store, 'Elsewhere', 'bg_404'), null, 'an unknown id is refused');
});

test('resolveRecordId tolerates every way the watcher writes an id', () => {
    const store = normalizeStore();
    storeRecord(store, { key: 'A', place: 'A', prompt: 'p', path: '/a.png' });

    assert.equal(resolveRecordId(store, 'bg_1'), 'bg_1');
    assert.equal(resolveRecordId(store, '1'), 'bg_1');
    assert.equal(resolveRecordId(store, 1), 'bg_1');
    assert.equal(resolveRecordId(store, 'nope'), null);
    assert.equal(resolveRecordId(store, null), null);
});

test('recoverCurrentKey trusts the background SillyTavern restored', () => {
    const store = normalizeStore();
    storeRecord(store, { key: 'The Docks', place: 'The Docks', prompt: 'p', path: '/images/docks.png' });
    storeRecord(store, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });

    assert.equal(recoverCurrentKey(store, 'url("/images/docks.png")'), 'the docks');
    assert.equal(store.currentKey, 'the docks');
    assert.equal(recoverCurrentKey(store, '/images/pier.png'), 'pier 9', 'the raw path matches too');
    assert.equal(recoverCurrentKey(store, 'url("/images/none.png")'), null);
    assert.equal(store.currentKey, null);
    assert.equal(recoverCurrentKey(store, ''), null);
});

test('toCssBgUrl wraps paths the way SillyTavern reads them', () => {
    assert.equal(toCssBgUrl('/images/docks.png'), 'url("/images/docks.png")');
    assert.equal(toCssBgUrl('/images/my pier.png'), 'url("/images/my%20pier.png")');
    assert.equal(toCssBgUrl(''), '');
});

test('knownBackgroundsList serves the newest places first, capped', () => {
    const store = normalizeStore();
    storeRecord(store, { key: 'A', place: 'A', prompt: 'pa', path: '/a.png', createdAt: 1 });
    storeRecord(store, { key: 'B', place: 'B', prompt: 'pb', path: '/b.png', createdAt: 3 });
    storeRecord(store, { key: 'C', place: 'C', prompt: 'pc', path: '/c.png', createdAt: 2 });

    const list = knownBackgroundsList(store, { limit: 2 });
    assert.deepEqual(list.map(entry => entry.place), ['B', 'C']);
    assert.deepEqual(Object.keys(list[0]), ['id', 'place', 'prompt']);
});

test('decide turns a resolved place into none, apply, or watch', () => {
    const store = normalizeStore();
    assert.deepEqual(decide(store, ''), { action: 'none', record: null });

    const docks = storeRecord(store, { key: 'The Docks', place: 'The Docks', prompt: 'p', path: '/images/docks.png' });
    assert.deepEqual(decide(store, 'the docks'), { action: 'none', record: docks }, 'already on screen');

    storeRecord(store, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });
    const back = decide(store, 'The Docks');
    assert.equal(back.action, 'apply', 'a place seen before comes back from the cache');
    assert.equal(back.record.path, '/images/docks.png');

    assert.deepEqual(decide(store, 'Somewhere New'), { action: 'watch', record: null }, 'a new place asks the watcher');
});
