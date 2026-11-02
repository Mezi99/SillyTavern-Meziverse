import test from 'node:test';
import assert from 'node:assert/strict';

import {
    aliasLocation,
    compileBgPrompt,
    currentRecord,
    extractRecentPlaces,
    fallbackLocationPrompt,
    formatLatestStory,
    groupMessageByScene,
    knownBackgroundsList,
    locationKey,
    lookupRecord,
    normalizeBgStore,
    parseWatcherReply,
    recoverCurrentKey,
    storeRecord,
} from '../src/backgrounds.js';

test('locationKey normalizes pipes, whitespace, and case', () => {
    assert.equal(
        locationKey('  The City |  Docks  | Pier 9 '),
        'the city | docks | pier 9',
    );
    assert.equal(
        locationKey('the city | docks | pier 9'),
        'the city | docks | pier 9',
    );
    assert.equal(locationKey(''), '');
});

test('storeRecord, lookupRecord, currentRecord, and aliasLocation manage the store', () => {
    const store = normalizeBgStore({});
    assert.equal(store.currentKey, null);
    assert.equal(store.nextId, 1);

    const first = storeRecord(store, {
        place: 'The City | Docks | Pier 9',
        prompt: 'rainy wooden pier at night, neon reflections',
        path: '/user/images/pier9.png',
        createdAt: 1000,
    });

    assert.equal(first.id, 'bg_1');
    assert.equal(store.currentKey, 'the city | docks | pier 9');
    assert.equal(currentRecord(store).id, 'bg_1');
    assert.equal(lookupRecord(store, 'THE CITY | DOCKS | PIER 9').path, '/user/images/pier9.png');

    // Spelling drift aliased to the same record
    const aliased = aliasLocation(store, 'The City | Docks | Pier No. 9', 1);
    assert.equal(aliased.id, 'bg_1');
    assert.equal(store.currentKey, 'the city | docks | pier no. 9');
    assert.equal(lookupRecord(store, 'the city | docks | pier no. 9').id, 'bg_1');

    // Overwrite on manual brush forces update on the existing id
    const overwritten = storeRecord(store, {
        key: 'The City | Docks | Pier 9',
        place: 'The City | Docks | Pier 9',
        prompt: 'stormy wooden pier at dawn',
        path: '/user/images/pier9_v2.png',
        overwrite: true,
        createdAt: 2000,
    });
    assert.equal(overwritten.id, 'bg_1');
    assert.equal(lookupRecord(store, 'The City | Docks | Pier No. 9').path, '/user/images/pier9_v2.png');
    assert.equal(knownBackgroundsList(store).length, 1);
});

test('recoverCurrentKey matches custom_background URL or clears when unknown', () => {
    const store = normalizeBgStore({});
    storeRecord(store, {
        place: 'Old Town | Bakery',
        prompt: 'warm bakery interior',
        path: '/images/bakery 1.png',
    });
    store.currentKey = null;

    assert.equal(recoverCurrentKey(store, 'url("/images/bakery%201.png")'), 'old town | bakery');
    assert.equal(recoverCurrentKey(store, 'url("/images/other.png")'), null);
    assert.equal(store.currentKey, null);
});

test('groupMessageByScene pairs each scene tag with its prose and strips other tags', () => {
    const mes = [
        '<think>planning</think>',
        '<scene date="9:00 PM" location="City | Street" />',
        'Wet cobblestones. <lie character="Mara" />',
        '<scene date="9:15 PM" location="City | Cafe" weather="Warm" />',
        'Steam on the windows. <speech character="Mara">"Sit."</speech>',
        '<ledger><recap era="1" fact="met" /></ledger>',
    ].join('\n');

    const blocks = groupMessageByScene(mes);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].scene.placeFull, 'City | Street');
    assert.equal(blocks[0].prose, 'Wet cobblestones.');
    assert.equal(blocks[1].scene.placeFull, 'City | Cafe');
    assert.equal(blocks[1].prose, 'Steam on the windows. "Sit."');
});

test('extractRecentPlaces builds a deduplicated chronological place timeline', () => {
    const messages = [
        { mes: '<scene location="City | Street" />Walking.' },
        { mes: '<scene location="city | street" />Still walking.<scene location="City | Pier 9" />Arrived.' },
        { mes: '<scene location="City | Warehouse" />Inside.' },
    ];

    assert.deepEqual(extractRecentPlaces(messages), [
        'City | Street',
        'City | Pier 9',
        'City | Warehouse',
    ]);
});

test('formatLatestStory marks the final scene block as CURRENT LOCATION in mode ON', () => {
    const messages = [
        { mes: '<scene location="City | Street" />Walking.<scene location="City | Pier 9" />By the water.' },
    ];

    const out = formatLatestStory(messages, { mode: true, count: 1 });
    assert.equal(out.includes('<scene location="City | Street" />\nWalking.'), true);
    assert.equal(out.includes('<scene location="City | Pier 9" /> [CURRENT LOCATION]\nBy the water.'), true);
});

test('compileBgPrompt and fallbackLocationPrompt build clean prompts', () => {
    assert.equal(
        compileBgPrompt('rainy wooden pier, lanterns', 'anime style, detailed'),
        'rainy wooden pier, lanterns, anime style, detailed',
    );
    assert.equal(
        fallbackLocationPrompt({ placeFull: 'Old Town | Pier 9', time: '9:40 PM', weather: 'Rain' }),
        'wide establishing shot of Old Town | Pier 9, at 9:40 PM, Rain weather, detailed environment, atmospheric lighting, empty of people',
    );
});

test('parseWatcherReply handles JSON, fenced JSON, and plain-text fallbacks', () => {
    assert.deepEqual(
        parseWatcherReply('{"state":"same","knownId":null,"place":"Pier 9","prompt":""}'),
        { state: 'same', knownId: null, place: 'Pier 9', prompt: '' },
    );

    assert.deepEqual(
        parseWatcherReply('```json\n{"state":"known","knownId":"bg_3","place":"Pier 9","prompt":""}\n```'),
        { state: 'known', knownId: 'bg_3', place: 'Pier 9', prompt: '' },
    );

    assert.deepEqual(
        parseWatcherReply('Here is the result: {"state":"new","knownId":null,"place":"Warehouse","prompt":"dark warehouse interior, crates, dusty shafts of light"}'),
        { state: 'new', knownId: null, place: 'Warehouse', prompt: 'dark warehouse interior, crates, dusty shafts of light' },
    );

    assert.deepEqual(
        parseWatcherReply('SAME'),
        { state: 'same', knownId: null, place: '', prompt: '' },
    );

    assert.deepEqual(
        parseWatcherReply('KNOWN bg_4'),
        { state: 'known', knownId: 'bg_4', place: '', prompt: '' },
    );

    assert.deepEqual(
        parseWatcherReply('NEW\ndark warehouse interior, crates, dusty shafts of light'),
        { state: 'new', knownId: null, place: '', prompt: 'dark warehouse interior, crates, dusty shafts of light' },
    );
});
