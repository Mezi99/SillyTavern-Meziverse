import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTags } from '../src/tags.js';
import {
    clockHour,
    describeScene,
    describeScenes,
    hourFromWords,
    initials,
    isUsableScene,
    locationTagValue,
    parseClock,
    resolveScene,
    sceneAt,
    splitDate,
    splitLocation,
    splitPresent,
    weatherEffect,
    weatherIntensity,
    weatherPlan,
    weatherTagValue,
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

test('parseClock lifts the clock and its hour', () => {
    assert.deepEqual(parseClock('19:12'), { time: '19:12', hour: 19 });
    assert.deepEqual(parseClock('7:12 PM'), { time: '7:12 PM', hour: 19 });
    assert.deepEqual(parseClock('around 8 PM'), { time: '8 PM', hour: 20 });
    assert.deepEqual(parseClock('14.20'), { time: '14.20', hour: 14 });
    assert.deepEqual(parseClock('Early Evening'), { time: 'Early Evening', hour: 18 });
    assert.deepEqual(parseClock('noonish'), { time: 'noonish', hour: 12 });
    assert.deepEqual(parseClock(''), { time: '', hour: null });
});

test('clockHour reads 12-hour and 24-hour clocks alike', () => {
    assert.equal(clockHour('9:40 PM'), 21);
    assert.equal(clockHour('12 AM'), 0);
    assert.equal(clockHour('12 PM'), 12);
    assert.equal(clockHour('20:17'), 20);
    assert.equal(clockHour('8 PM'), 20);
    assert.equal(clockHour('14.20'), 14);
    assert.equal(clockHour('13:00 approx'), 13);
    assert.equal(clockHour(''), null);
});

test('hourFromWords knows the shape of a day', () => {
    assert.equal(hourFromWords('Friday, Early Evening'), 18);
    assert.equal(hourFromWords('morning'), 9);
    assert.equal(hourFromWords('early morning'), 7);
    assert.equal(hourFromWords('late afternoon'), 16);
    assert.equal(hourFromWords('Midnight bell'), 0);
    assert.equal(hourFromWords('late night'), 2);
    assert.equal(hourFromWords('Tuesday, March 4'), null);
});

test('describeScene follows the clock precedence chain', () => {
    const withTime = describeScene(tag('<scene date="Friday, Mid-April" time="19:12" />'));
    assert.equal(withTime.time, '19:12');
    assert.equal(withTime.timeRaw, '19:12');
    assert.equal(withTime.hour, 19);
    assert.equal(withTime.date, 'Friday, Mid-April');

    const legacy = describeScene(tag('<scene date="Friday, Mid-April, 7:12 PM" />'));
    assert.equal(legacy.time, '7:12 PM');
    assert.equal(legacy.hour, 19);

    const words = describeScene(tag('<scene date="Friday, Early Evening" />'));
    assert.equal(words.time, '');
    assert.equal(words.hour, 18);

    const slips = describeScene(tag('<scene date="Friday" time="Early Evening" />'));
    assert.equal(slips.time, 'Early Evening');
    assert.equal(slips.hour, 18);

    const none = describeScene(tag('<scene date="Friday, Mid-April" />'));
    assert.equal(none.time, '');
    assert.equal(none.hour, null);
});

test('describeScene reads the weather and location tags, spelling forgiving', () => {
    const scene = describeScene(tag('<scene date="Day 1" weatherTag="Rain" locationTag="Outdoor" />'));
    assert.equal(scene.weatherTag, 'rain');
    assert.equal(scene.locationTag, 'outdoor');

    const folded = describeScene(tag('<scene date="Day 1" weathertag="Blizzard" location_tag="\'Indoor\'" />'));
    assert.equal(folded.weatherTag, 'blizzard');
    assert.equal(folded.locationTag, 'indoor');

    const bare = describeScene(tag('<scene date="Day 1" />'));
    assert.equal(bare.weatherTag, '');
    assert.equal(bare.locationTag, '');
});

test('weatherTagValue folds synonyms and forgets the rest', () => {
    assert.equal(weatherTagValue('Rain'), 'rain');
    assert.equal(weatherTagValue('THUNDER'), 'storm');
    assert.equal(weatherTagValue('Blizzard'), 'blizzard');
    assert.equal(weatherTagValue('light rain'), 'rain');
    assert.equal(weatherTagValue('Clear skies'), 'clear');
    assert.equal(weatherTagValue('Sleet'), 'snow');
    assert.equal(weatherTagValue('dust storm'), 'storm');
    assert.equal(weatherTagValue('xyzzy'), '');
    assert.equal(weatherTagValue(''), '');
    assert.equal(weatherTagValue(weatherTagValue('Sleet')), 'snow');
});

test('locationTagValue folds synonyms and forgets the rest', () => {
    assert.equal(locationTagValue('Indoor'), 'indoor');
    assert.equal(locationTagValue('OUTDOOR'), 'outdoor');
    assert.equal(locationTagValue("'Outdoor'"), 'outdoor');
    assert.equal(locationTagValue('outside'), 'outdoor');
    assert.equal(locationTagValue('inside'), 'indoor');
    assert.equal(locationTagValue(''), '');
    assert.equal(locationTagValue('submarine'), '');
});

test('weatherEffect plays only outdoors, and never for clear', () => {
    const scene = mes => describeScene(tag(mes));
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Rain" locationTag="Outdoor" />')), 'rain');
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Storm" locationTag="Outdoor" />')), 'storm');
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Rain" locationTag="Indoor" />')), '');
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Rain" />')), '');
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Clear" locationTag="Outdoor" />')), '');
    assert.equal(weatherEffect(scene('<scene date="Day 1" weatherTag="Nuclear" locationTag="Outdoor" />')), '');
    assert.equal(weatherEffect(null), '');
});

test('weatherIntensity scales from the free-text weather', () => {
    assert.equal(weatherIntensity('Heavy rain, 8\u00b0C'), 'heavy');
    assert.equal(weatherIntensity('drizzle, mild'), 'light');
    assert.equal(weatherIntensity('Clear, golden sunset light'), 'light');
    assert.equal(weatherIntensity('Rain'), 'med');
    assert.equal(weatherIntensity(''), 'med');
});

test('weatherPlan gathers state, intensity and the hour of the light', () => {
    const scene = describeScene(tag('<scene date="Friday" time="19:12" weather="heavy rain" weatherTag="Storm" locationTag="Outdoor" />'));
    assert.deepEqual(weatherPlan(scene), { state: 'storm', intensity: 'heavy', hour: 19 });

    const sun = describeScene(tag('<scene date="Friday" time="9:00" weather="clear skies" weatherTag="Sunny" locationTag="Outdoor" />'));
    assert.deepEqual(weatherPlan(sun), { state: 'sunny', intensity: 'med', hour: 9 });

    const indoors = describeScene(tag('<scene date="Friday" time="19:12" weather="heavy rain" weatherTag="Storm" locationTag="Indoor" />'));
    assert.equal(weatherPlan(indoors), null);
});
