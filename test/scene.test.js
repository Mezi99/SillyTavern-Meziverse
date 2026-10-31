import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTags } from '../src/tags.js';
import {
    describeScene,
    describeScenes,
    initials,
    isUsableScene,
    resolveScene,
    sceneAt,
    splitDate,
    splitLocation,
    splitPresent,
} from '../src/scene.js';

const tag = mes => parseTags(mes)[0];

test('splitDate keeps the date and lifts the trailing clock', () => {
    assert.deepEqual(splitDate('Tuesday, March 4 \u00b7 9:40 PM'), {
        date: 'Tuesday, March 4',
        time: '9:40 PM',
    });
    assert.deepEqual(splitDate('20:17'), { date: '', time: '20:17' });
    assert.deepEqual(splitDate('8 PM'), { date: '', time: '8 PM' });
    assert.deepEqual(splitDate('Tuesday \u00b7 14.20'), { date: 'Tuesday', time: '14.20' });
    assert.deepEqual(splitDate('March 4'), { date: 'March 4', time: '' });
    assert.deepEqual(splitDate(''), { date: '', time: '' });
});

test('splitLocation keeps the deepest level and the whole path', () => {
    assert.deepEqual(splitLocation('The city | Docks | Pier 9'), {
        place: 'Pier 9',
        placeFull: 'The city | Docks | Pier 9',
        levels: ['The city', 'Docks', 'Pier 9'],
    });
    assert.equal(splitLocation('The Docks').place, 'The Docks');
    assert.equal(splitLocation('A | B | ').levels.length, 2);
    assert.equal(splitLocation('').place, '');
});

test('splitPresent drops the persona, then duplicates', () => {
    assert.deepEqual(splitPresent('Mara, Ilya, Wren', ''), ['Mara', 'Ilya', 'Wren']);
    assert.deepEqual(splitPresent('Mara Voss, Mara, Ilya', 'Mara Voss'), ['Ilya']);
    assert.deepEqual(splitPresent('Mara, mara, MARA'), ['Mara']);
    assert.deepEqual(splitPresent('  Mara ,  Ilya  ', 'Wren'), ['Mara', 'Ilya']);
});

test('initials take the first and last words', () => {
    assert.equal(initials('Mara Voss'), 'MV');
    assert.equal(initials('Mara'), 'M');
    assert.equal(initials('Jean-Luc Picard'), 'JP');
    assert.equal(initials('  '), '');
});

test('a scene is usable only when closed and carrying date, place or cast', () => {
    assert.equal(isUsableScene(tag('<scene />')), false);
    assert.equal(isUsableScene(tag('<scene weather="Rain" />')), false);
    assert.equal(isUsableScene(tag('<scene present="  " />')), false);
    assert.equal(isUsableScene(tag('<scene date="Day 1" />')), true);
    assert.equal(isUsableScene(tag('<scene location="The Docks">')), true);
    assert.equal(isUsableScene(tag('<scene present="Mara" />')), true);
    assert.equal(isUsableScene(tag('<scene date="Day 1"')), false);
});

test('describeScene resolves every display field', () => {
    const scene = describeScene(tag('<scene date="Tuesday \u00b7 9:40 PM" location="The city | Docks" weather="Rain" present="Mara, Wren" />'), {
        persona: 'Ilya',
    });

    assert.equal(scene.date, 'Tuesday');
    assert.equal(scene.time, '9:40 PM');
    assert.equal(scene.dateRaw, 'Tuesday \u00b7 9:40 PM');
    assert.equal(scene.place, 'Docks');
    assert.equal(scene.placeFull, 'The city | Docks');
    assert.deepEqual(scene.levels, ['The city', 'Docks']);
    assert.equal(scene.weather, 'Rain');
    assert.deepEqual(scene.present, ['Mara', 'Wren']);
});

test('describeScenes keeps every usable scene and drops the rest', () => {
    const message = {
        mes: '<scene />intro<scene date="Day 1" />mid<scene date="Day 2">end',
    };

    const scenes = describeScenes(message);
    assert.deepEqual(scenes.map(entry => entry.scene.date), ['Day 1', 'Day 2']);
});

test('describeScenes caches on identity and rereads when mes changes', () => {
    const message = { mes: '<scene date="Day 1" />' };

    const first = describeScenes(message);
    assert.equal(describeScenes(message), first);

    message.mes = '<scene date="Day 2" />';
    const second = describeScenes(message);
    assert.notEqual(second, first);
    assert.equal(second[0].scene.date, 'Day 2');
});

test('resolveScene takes the last scene of the shown message', () => {
    const messages = [{ mes: '<scene date="Day 1" />one<scene date="Day 2" />two' }];

    const found = resolveScene(messages, 0);
    assert.equal(found.index, 0);
    assert.equal(found.scene.date, 'Day 2');
});

test('resolveScene walks back to the most recent earlier scene', () => {
    const messages = [
        { mes: '<scene date="Day 1" present="Mara" />' },
        { mes: 'prose only' },
        { mes: '<scene date="Day 3" present="Wren" />' },
        { mes: 'more prose' },
    ];

    assert.equal(resolveScene(messages, 1).scene.date, 'Day 1');
    assert.equal(resolveScene(messages, 2).scene.date, 'Day 3');
    assert.equal(resolveScene(messages, 3).scene.date, 'Day 3');
    assert.equal(resolveScene(messages, 99).scene.date, 'Day 3');
});

test('resolveScene applies the persona filter', () => {
    const messages = [{ mes: '<scene date="Day 1" present="Ilya, Mara, Wren" />' }];

    assert.deepEqual(resolveScene(messages, 0, { persona: 'Ilya' }).scene.present, ['Mara', 'Wren']);
});

test('resolveScene returns null when nothing is usable', () => {
    assert.equal(resolveScene([], 0), null);
    assert.equal(resolveScene([{ mes: 'no scene' }], 0), null);
    assert.equal(resolveScene([{ mes: '<scene />' }], 0), null);
});

test('sceneAt is the older name for resolveScene', () => {
    assert.equal(sceneAt, resolveScene);
});
