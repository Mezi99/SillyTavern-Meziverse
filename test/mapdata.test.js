import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAtlas,
    extractObservations,
    extractStampObservations,
    foldSegment,
    isTransientFold,
    splitAspect,
    splitMapChain,
} from '../src/mapdata.js';

const obs = (...chains) => chains.map((chain, i) => ({
    at: { msgIndex: i, tagIndex: 0 },
    chain,
    date: '',
    time: '',
    hour: null,
    weather: '',
    locationTag: '',
    present: [],
}));

const foldsOf = atlas => Object.values(atlas.nodes).map(node => node.fold);
const byFold = (atlas, fold) => Object.values(atlas.nodes).filter(node => node.fold === fold);

test('splitMapChain splits on | and the separators a model drifts to', () => {
    assert.deepEqual(
        splitMapChain('USA | New York City | St. Vincent\u2019s High School'),
        ['USA', 'New York City', 'St. Vincent\u2019s High School']);
    assert.deepEqual(
        splitMapChain('USA|New York City\u203aLocal Cafe Parking Lot | Jin\u2019s Lotus Emira'),
        ['USA', 'New York City', 'Local Cafe Parking Lot', 'Jin\u2019s Lotus Emira']);
    assert.deepEqual(splitMapChain('A -> B'), ['A', 'B']);
    assert.deepEqual(splitMapChain('Street| Jin'), ['Street', 'Jin']);
    assert.deepEqual(splitMapChain('  '), []);
});

test('splitAspect keeps the name whole unless the qualifier is a view word', () => {
    assert.deepEqual(splitAspect('Jin\u2019s Lotus Emira - Interior'), {
        core: 'Jin\u2019s Lotus Emira',
        aspect: 'Interior',
    });
    assert.deepEqual(splitAspect('Jin\u2019s Lotus Emira (interior)'), {
        core: 'Jin\u2019s Lotus Emira',
        aspect: 'interior',
    });
    assert.deepEqual(splitAspect('Unit 4B - Bedroom'), {
        core: 'Unit 4B - Bedroom',
        aspect: '',
    });
    assert.deepEqual(splitAspect('Main Hallway near Locker Room'), {
        core: 'Main Hallway near Locker Room',
        aspect: '',
    });
});

test('foldSegment folds spelling drift and nothing more', () => {
    assert.equal(foldSegment('St. Vincent\u2019s'), foldSegment('St Vincents'));
    assert.equal(foldSegment('Pier No9'), foldSegment('Pier 9'));
    assert.equal(foldSegment('Pier #9'), foldSegment('Pier 9'));
    assert.equal(foldSegment('PIER 9'), foldSegment('Pier 9'));
    assert.notEqual(foldSegment('Pier 9'), foldSegment('Pier 10'));
    assert.equal(foldSegment('Bike Racks & Parking Lot'), foldSegment('Bike Racks and Parking Lot'));
    assert.equal(foldSegment('Walk-Up'), foldSegment('Walk Up'));
    assert.equal(foldSegment(''), '');
});

test('extractObservations reads every scene tag in story order, mid-reply hops included', () => {
    const messages = [
        {
            mes: 'Before.\n'
                + '<scene date="Day 1, Tuesday" time="9:00 AM" location="USA | New York City | St. Vincent\u2019s High School | Water Polo Locker Room" locationTag="Indoor" present="Jin, Mara" />\n'
                + 'At the lockers.\n'
                + '<scene location="USA | New York City | St. Vincent\u2019s High School | Main Hallway" />\n'
                + 'Walking out.',
        },
        { mes: 'No tags in this one.' },
    ];

    const out = extractObservations(messages);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].at, { msgIndex: 0, tagIndex: 0 });
    assert.deepEqual(out[1].at, { msgIndex: 0, tagIndex: 1 });
    assert.equal(out[0].chain.length, 4);
    assert.deepEqual(out[1].chain.slice(0, 3), ['USA', 'New York City', 'St. Vincent\u2019s High School']);
    assert.equal(out[0].date, 'Day 1, Tuesday');
    assert.equal(out[0].time, '9:00 AM');
    assert.deepEqual(out[0].present, ['Jin', 'Mara']);
});

test('shape 1: a fixed container with varying spots builds one containment tree', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'St. Vincent\u2019s High School', 'Water Polo Locker Room'],
        ['USA', 'New York City', 'St. Vincent\u2019s High School', 'Main Hallway near Locker Room'],
        ['USA', 'New York City', 'St. Vincent\u2019s High School', 'Outdoor Bike Racks & Parking Lot'],
    ));

    const school = byFold(atlas, 'st vincents high school');
    assert.equal(school.length, 1);
    assert.equal(school[0].kind, 'site');
    assert.equal(school[0].children.length, 3);

    const city = byFold(atlas, 'new york city');
    assert.equal(city[0].kind, 'city');
    assert.equal(school[0].parentId, city[0].id);

    for (const id of school[0].children) assert.equal(atlas.nodes[id].kind, 'spot');
    assert.deepEqual(foldsOf(atlas).sort(), [
        'main hallway near locker room',
        'new york city',
        'outdoor bike racks and parking lot',
        'st vincents high school',
        'usa',
        'water polo locker room',
    ].sort());
    assert.equal(atlas.flags.mobilePending.length, 0);
    assert.equal(Object.values(atlas.nodes).filter(node => node.kind === 'mobile').length, 0);
});

test('shape 2: a moving place becomes one mobile node with a trajectory of positions', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'En Route', 'Jin\u2019s Lotus Emira - Interior'],
        ['USA', 'New York City', 'Street', 'Jin\u2019s Lotus Emira - Interior'],
        ['USA', 'New York City', 'Local Cafe Parking Lot', 'Jin\u2019s Lotus Emira'],
        ['USA', 'New York City', 'Downtown Streets', 'Jin\u2019s Lotus Emira'],
    ));

    const car = byFold(atlas, 'jins lotus emira');
    assert.equal(car.length, 1);
    assert.equal(car[0].kind, 'mobile');
    assert.equal(car[0].parentId, null);
    assert.equal(car[0].name, 'Jin\u2019s Lotus Emira');
    assert.equal(car[0].visits.length, 4);
    assert.equal(car[0].trajectory.length, 4);
    assert.deepEqual(
        car[0].trajectory.map(stop => atlas.nodes[stop.positionId].name),
        ['En Route', 'Street', 'Local Cafe Parking Lot', 'Downtown Streets']);

    assert.equal(byFold(atlas, 'en route')[0].kind, 'transient');
    assert.equal(byFold(atlas, 'street')[0].kind, 'transient');
    assert.equal(byFold(atlas, 'downtown streets')[0].kind, 'transient');
    assert.equal(byFold(atlas, 'local cafe parking lot')[0].kind, 'spot');
});

test('an aspect is the same place, and its interior/exterior flavour is remembered', () => {
    const atlas = buildAtlas(obs(
        ['Garage', 'Jin\u2019s Lotus Emira - Interior'],
        ['Driveway', 'Jin\u2019s Lotus Emira - Interior'],
        ['Parking Lot', 'Jin\u2019s Lotus Emira'],
    ));

    const car = byFold(atlas, 'jins lotus emira');
    assert.equal(car.length, 1);
    assert.equal(car[0].kind, 'mobile');
    assert.ok(car[0].aspects.includes('Interior'));
    assert.equal(car[0].trajectory.length, 3);
});

test('depth healing: bare and middle-dropped chains attach to the known subtree', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'St. Vincent\u2019s High School', 'Water Polo Locker Room'],
        ['St. Vincent\u2019s High School', 'Main Hallway'],
        ['USA', 'New York City', 'Water Polo Locker Room'],
    ));

    const school = byFold(atlas, 'st vincents high school');
    assert.equal(school.length, 1);

    const hallway = byFold(atlas, 'main hallway');
    assert.equal(hallway.length, 1);
    assert.equal(hallway[0].parentId, school[0].id);

    const locker = byFold(atlas, 'water polo locker room');
    assert.equal(locker.length, 1);
    assert.equal(locker[0].parentId, school[0].id);
});

test('two same-named rooms stay two nodes, and the bare one flags as ambiguous', () => {
    const atlas = buildAtlas(obs(
        ['Jammie\u2019s house', 'Kitchen'],
        ['Anna\u2019s house', 'Kitchen'],
        ['Kitchen'],
    ));

    const kitchens = byFold(atlas, 'kitchen');
    assert.equal(kitchens.length, 2);
    assert.ok(atlas.flags.ambiguous.includes('kitchen'));
    assert.ok(atlas.flags.mobilePending.includes('kitchen'));
    assert.equal(Object.values(atlas.nodes).filter(node => node.kind === 'mobile').length, 0);

    const recent = kitchens.reduce((a, b) => (a.lastSeen > b.lastSeen ? a : b));
    assert.deepEqual(recent.visits, [1, 2]);
});

test('interleaving other places never splits a mobile place', () => {
    const atlas = buildAtlas(obs(
        ['En Route', 'The Car'],
        ['Jammie\u2019s house', 'Kitchen'],
        ['Street', 'The Car'],
        ['Road', 'The Car'],
    ));

    const car = byFold(atlas, 'the car');
    assert.equal(car.length, 1);
    assert.equal(car[0].kind, 'mobile');
    assert.equal(car[0].trajectory.length, 3);
    assert.equal(byFold(atlas, 'kitchen').length, 1);
});

test('equivalences fold two spellings onto one place', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'Docks'],
        ['NYC', 'Docks'],
    ), { equivalences: [['NYC', 'New York City']] });

    assert.equal(byFold(atlas, 'new york city').length, 1);
    assert.equal(byFold(atlas, 'docks').length, 1);
    assert.equal(foldsOf(atlas).filter(fold => fold === 'nyc').length, 0);
    assert.equal(atlas.roots.length, 1);
});

test('a name that only sounds generic is still a place', () => {
    const atlas = buildAtlas(obs(['Fifth Street Walk-Up', 'Unit 4B - Bedroom']));

    assert.equal(byFold(atlas, 'fifth street walk up')[0].kind, 'region');
    assert.equal(Object.values(atlas.nodes).filter(node => node.kind === 'transient').length, 0);
    assert.equal(isTransientFold('en route'), true);
    assert.equal(isTransientFold('downtown streets'), true);
    assert.equal(isTransientFold('street'), true);
    assert.equal(isTransientFold('fifth street walk up'), false);
    assert.equal(isTransientFold('local cafe parking lot'), false);
});

test('every observation lands on its deepest node', () => {
    const atlas = buildAtlas(obs(['USA', 'NYC'], ['USA', 'NYC', 'Docks']));

    assert.equal(atlas.observations[0].nodeId, byFold(atlas, 'nyc')[0].id);
    assert.equal(atlas.observations[1].nodeId, byFold(atlas, 'docks')[0].id);
});

test('stamp observations: a story without tags still maps its drawn places', () => {
    const messages = [
        { mes: 'One', extra: { meziverse: { bg: 'bg_1' } } },
        { mes: 'Two', extra: { meziverse: { bg: 'bg_1' } } },
        { mes: 'Three', extra: { meziverse: { bg: 'bg_2' } } },
        { mes: 'Four' },
    ];
    const records = {
        bg_1: { id: 'bg_1', place: 'The Docks' },
        bg_2: { id: 'bg_2', place: 'Jammie’s house | Kitchen' },
    };

    const out = extractStampObservations(messages, records);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].chain, ['The Docks']);
    assert.deepEqual(out[2].chain, ['Jammie’s house', 'Kitchen']);
    assert.deepEqual(out[1].at, { msgIndex: 1, tagIndex: 0 });

    const atlas = buildAtlas(out);
    assert.ok(Object.values(atlas.nodes).some(node => node.name === 'Kitchen'));
});

test('similarity is flagged for the curator, and digits alone never flag', () => {
    const atlas = buildAtlas(obs(
        ['The Docks'],
        ['Docks'],
        ['St. Vincent\u2019s High School'],
        ['St Vincents High'],
        ['Pier 9'],
        ['Pier 10'],
    ));

    const id = fold => byFold(atlas, fold)[0].id;
    const pair = (a, b) => atlas.flags.same.some(([x, y]) =>
        (x === id(a) && y === id(b)) || (x === id(b) && y === id(a)));

    assert.ok(pair('the docks', 'docks'));
    assert.ok(pair('st vincents high school', 'st vincents high'));
    assert.ok(!pair('pier 9', 'pier 10'));
    assert.equal(atlas.flags.same.length, 2);
});
