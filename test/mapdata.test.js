import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAtlas,
    deriveLegs,
    extractObservations,
    extractStampObservations,
    foldSegment,
    isTransientFold,
    layoutAtlas,
    splitAspect,
    splitMapChain,
    travelMode,
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

test('shape 2: one mobile node per vehicle, trips as legs, parked stops as spots of their place', () => {
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
    assert.equal(car[0].key, '~jins lotus emira');
    assert.equal(car[0].name, 'Jin\u2019s Lotus Emira');
    assert.equal(car[0].visits.length, 4);
    assert.equal(car[0].trajectory.length, 4);

    // route context above the keyword is where the car WAS - placed as the
    // trail's crossed levels (visited, never a stop); the generic street
    // levels name no place and stay out
    assert.deepEqual(foldsOf(atlas).sort(), [
        'jins lotus emira',
        'local cafe parking lot',
        'new york city',
        'usa',
    ]);
    const lot = byFold(atlas, 'local cafe parking lot')[0];
    assert.equal(lot.kind, 'spot');
    assert.deepEqual(
        car[0].trajectory.map(stop => (stop.positionId ? atlas.nodes[stop.positionId].name : null)),
        ['New York City', 'New York City', 'Local Cafe Parking Lot', 'New York City']);
    assert.deepEqual(car[0].trajectory.map(stop => !!stop.moving), [true, true, false, true]);
});

test('en route places the route context as the trail - soft, and nothing at the keyword', () => {
    const atlas = buildAtlas(obs(['USA', 'New York City', 'En Route', 'Jin\u2019s Lotus Emira']));

    assert.deepEqual(foldsOf(atlas).sort(), ['jins lotus emira', 'new york city', 'usa']);
    const car = byFold(atlas, 'jins lotus emira')[0];
    assert.equal(car.kind, 'mobile');
    assert.equal(car.key, '~jins lotus emira');
    assert.equal(atlas.observations[0].nodeId, car.id);
    // the crossed levels are soft evidence: visited, never a stop
    const city = byFold(atlas, 'new york city')[0];
    assert.deepEqual(city.visits, [0]);
    assert.equal(city.stops, 0);
});

test('two trips in one vehicle share one node, and a walk is no place at all', () => {
    const atlas = buildAtlas(obs(
        ['Japan', 'Kyoto', 'En Route', 'Night Ferry'],
        ['Japan', 'Kyoto', 'En Route'],
        ['Japan', 'Osaka', 'En Route', 'Night Ferry'],
    ));

    assert.deepEqual(foldsOf(atlas).sort(), ['japan', 'kyoto', 'night ferry', 'osaka']);
    const ferry = byFold(atlas, 'night ferry')[0];
    assert.equal(ferry.kind, 'mobile');
    assert.deepEqual(ferry.visits, [0, 2]);

    // the walk between places is pure transit: no node, but not forgotten
    assert.equal(atlas.observations[1].transit, true);
    assert.equal(atlas.observations[1].nodeId, null);

    // the trail crossed Kyoto, then Osaka
    assert.deepEqual(
        ferry.trajectory.map(stop => (stop.positionId ? atlas.nodes[stop.positionId].name : null)),
        ['Kyoto', 'Osaka']);
});

test('a parked vehicle is a spot of its place until a trip makes it mobile', () => {
    const atlas = buildAtlas(obs(['USA', 'NYC', 'Local Cafe Parking Lot', 'Jin\u2019s Lotus Emira']));

    const car = byFold(atlas, 'jins lotus emira')[0];
    assert.equal(car.kind, 'spot');
    assert.equal(atlas.nodes[car.parentId].fold, 'local cafe parking lot');
    assert.equal(car.key, 'usa/nyc/local cafe parking lot/jins lotus emira');
});

test('stable keys: same-named rooms in different buildings get different keys', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'St. Vincent\u2019s High School', 'Locker Room'],
        ['USA', 'New York City', 'Jammie\u2019s house', 'Locker Room'],
    ));

    const rooms = byFold(atlas, 'locker room');
    assert.equal(rooms.length, 2);
    const keys = rooms.map(room => room.key).sort();
    assert.notEqual(keys[0], keys[1]);
    assert.ok(keys.every(key => key.startsWith('usa/new york city/') && key.endsWith('/locker room')));
    assert.ok(keys.some(key => key.includes('st vincents high school')));
    assert.ok(keys.some(key => key.includes('jammies house')));
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

    // route context is not a place
    assert.equal(byFold(atlas, 'en route').length, 0);
    assert.equal(byFold(atlas, 'street').length, 0);
    assert.equal(byFold(atlas, 'road').length, 0);
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

/* Synthetic scene tags only: never real story text. */
const tag = place => '<scene date="Day 1, Tuesday" time="9:00 AM" '
    + `location="${place}" locationTag="Indoor" present="" />`;

test('only the selected swipe variant becomes a scene; the others are branch material', () => {
    const hotel = 'The concierge takes their bags.\n'
        + `${tag('USA | New York City | Hotel | Lobby')}\n`;
    const docks = 'The ferry pulls away.\n'
        + `${tag('USA | New York City | Docks | Pier 9')}\n`;
    const message = { mes: hotel, swipes: [hotel, docks], swipe_id: 0 };

    let out = extractObservations([message]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].chain, ['USA', 'New York City', 'Hotel', 'Lobby']);

    // the user continues from the other path
    message.swipe_id = 1;
    message.mes = docks;
    out = extractObservations([message]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].chain, ['USA', 'New York City', 'Docks', 'Pier 9']);
});

test('the variant list is the truth: a lagging mes mirror never maps the wrong swipe', () => {
    const hotel = tag('USA | New York City | Hotel | Lobby');
    const trip = `${tag('USA | New York City | En Route | Jin')}\n`
        + `${tag('USA | New York City | Docks | Pier 9')}\n`;
    // mes still mirrors the first variant; the selection has already moved on
    const message = { mes: hotel, swipes: [hotel, trip], swipe_id: 1 };

    const out = extractObservations([message]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].chain, ['USA', 'New York City', 'En Route', 'Jin']);
    assert.deepEqual(out[1].chain, ['USA', 'New York City', 'Docks', 'Pier 9']);
});

test('a message without a usable variant falls back to mes', () => {
    const text = tag('USA | New York City | Hotel | Lobby');
    assert.equal(extractObservations([{ mes: text }])[0].chain[2], 'Hotel');
    assert.equal(extractObservations([{ mes: text, swipes: [text], swipe_id: 7 }])[0].chain[2], 'Hotel');
    assert.equal(extractObservations([{ mes: text, swipes: [text], swipe_id: -1 }])[0].chain[2], 'Hotel');
});

test('stamp observations follow the selected variant, never a sibling variant', () => {
    const records = {
        bg_hotel: { id: 'bg_hotel', place: 'Hotel | Lobby' },
        bg_docks: { id: 'bg_docks', place: 'Docks | Pier 9' },
    };
    // the mirror is stale: it names the last-stamped variant, not the selected one
    const message = {
        mes: 'One',
        swipes: ['One', 'Two'],
        swipe_id: 0,
        swipe_info: [
            { extra: { meziverse: { bg: 'bg_hotel' } } },
            { extra: { meziverse: { bg: 'bg_docks' } } },
        ],
        extra: { meziverse: { bg: 'bg_docks' } },
    };

    let out = extractStampObservations([message], records);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].chain, ['Hotel', 'Lobby']);

    message.swipe_id = 1;
    out = extractStampObservations([message], records);
    assert.deepEqual(out[0].chain, ['Docks', 'Pier 9']);
});

test('an unstamped selected variant maps no place at all', () => {
    const records = { bg_hotel: { id: 'bg_hotel', place: 'Hotel | Lobby' } };
    const message = {
        mes: 'Two',
        swipes: ['One', 'Two'],
        swipe_id: 1,
        swipe_info: [{ extra: { meziverse: { bg: 'bg_hotel' } } }, {}],
        extra: { meziverse: { bg: 'bg_hotel' } },
    };

    assert.equal(extractStampObservations([message], records).length, 0);
});

test('a response stops at its last scene tag - only that one owns the picture', () => {
    const message = {
        mes: `${tag('USA | New York City | House | Kitchen')}\n`
            + `${tag('USA | New York City | House | Hallway')}\n`
            + `${tag('USA | New York City | House | Bedroom')}`,
    };
    const out = extractObservations([{ mes: tag('Docks') }, message]);

    assert.deepEqual(out.map(entry => entry.last), [true, false, false, true]);
    assert.deepEqual(
        out.map(entry => entry.chain[entry.chain.length - 1]),
        ['Docks', 'Kitchen', 'Hallway', 'Bedroom']);
});

test('stops: a place counts only the responses that ended there, never the ones passing through', () => {
    const trip = `${tag('USA | New York City | House | Kitchen')}\n`
        + `${tag('USA | New York City | House | Hallway')}\n`
        + `${tag('USA | New York City | House | Bedroom')}`;
    const atlas = buildAtlas(extractObservations([
        { mes: tag('USA | New York City | House | Kitchen') },
        { mes: trip },
    ]));
    const find = fold => Object.values(atlas.nodes).find(node => node.fold === fold);

    assert.equal(find('kitchen').stops, 1);
    assert.equal(find('hallway').stops, 0);
    assert.equal(find('bedroom').stops, 1);
});

test('a passed place promotes the moment a response ends there', () => {
    const trip = `${tag('USA | New York City | House | Kitchen')}\n`
        + `${tag('USA | New York City | House | Hallway')}\n`
        + `${tag('USA | New York City | House | Bedroom')}`;
    const atlas = buildAtlas(extractObservations([
        { mes: trip },
        { mes: tag('USA | New York City | House | Hallway') },
    ]));
    const find = fold => Object.values(atlas.nodes).find(node => node.fold === fold);

    assert.equal(find('hallway').stops, 1);
    assert.equal(find('kitchen').stops, 0);
    assert.equal(find('bedroom').stops, 1);
});

test('legs: a trip by vehicle segments through the levels it crossed', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'Local Cafe'],
        ['USA', 'New York City', 'En Route', 'Jin\u2019s Lotus Emira'],
        ['USA', 'New York City', 'Pier 9'],
    ));
    const d = deriveLegs(atlas);

    assert.equal(d.legs.length, 2);
    const [out, back] = d.legs;
    assert.deepEqual(
        [atlas.nodes[out.dir[0]].name, atlas.nodes[out.dir[1]].name],
        ['Local Cafe', 'New York City']);
    assert.equal(out.mode.glyph, 'car', 'the car made this segment');
    assert.deepEqual(
        [atlas.nodes[back.dir[0]].name, atlas.nodes[back.dir[1]].name],
        ['New York City', 'Pier 9']);
    assert.equal(back.mode.glyph, 'car', 'the trip\u2019s mode carries to the arrival');
    assert.equal(d.nowId, atlas.nodes[back.dir[1]].id);
    assert.equal(d.inTransit, false);
});

test('legs: a flight changing country segments through the levels it crossed', () => {
    const atlas = buildAtlas(obs(
        ['Japan', 'Kyoto', 'Temple'],
        ['Japan', 'En Route', 'Sky Chariot'],
        ['USA', 'New York City', 'Hotel'],
    ));
    const d = deriveLegs(atlas);

    assert.equal(d.legs.length, 2);
    assert.deepEqual(
        [atlas.nodes[d.legs[0].dir[0]].name, atlas.nodes[d.legs[0].dir[1]].name],
        ['Temple', 'Japan']);
    assert.equal(d.legs[0].mode.glyph, 'plane');
    assert.deepEqual(
        [atlas.nodes[d.legs[1].dir[0]].name, atlas.nodes[d.legs[1].dir[1]].name],
        ['Japan', 'Hotel']);
    assert.equal(d.legs[1].mode.glyph, 'plane', 'the flight carries to the landing');
});

test('legs: a teleport with no vehicle gives a leg with no mode', () => {
    const atlas = buildAtlas(obs(['Local Cafe'], ['Docks']));
    const d = deriveLegs(atlas);

    assert.equal(d.legs.length, 1);
    assert.equal(d.legs[0].mode, null);
});

test('legs: a story ending in transit draws an open stub from the last place', () => {
    const atlas = buildAtlas(obs(
        ['Local Cafe'],
        ['En Route', 'Night Ferry'],
        ['En Route'],
    ));
    const d = deriveLegs(atlas);

    assert.equal(d.inTransit, true);
    assert.equal(d.legs.length, 0);
    assert.equal(atlas.nodes[d.fromId].name, 'Local Cafe');
    assert.equal(d.transitMode.glyph, 'boat');
});

test('legs: repeated trips raise the count, never new legs', () => {
    const atlas = buildAtlas(obs(
        ['Port', 'Pier 9'],
        ['En Route', 'Night Ferry'],
        ['Port', 'Harbor'],
        ['En Route', 'Night Ferry'],
        ['Port', 'Pier 9'],
    ));
    const d = deriveLegs(atlas);

    assert.equal(d.legs.length, 1);
    const leg = d.legs[0];
    assert.equal(leg.count, 2);
    assert.deepEqual(leg.at, [2, 4]);
    assert.deepEqual(
        [atlas.nodes[leg.dir[0]].name, atlas.nodes[leg.dir[1]].name],
        ['Harbor', 'Pier 9']);
});

test('legs: a move between two spots of one place is not a journey', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'NYC', 'Jammie\u2019s house', 'Living Room'],
        ['USA', 'NYC', 'Jammie\u2019s house', 'Kitchen'],
    ));
    const d = deriveLegs(atlas);

    assert.equal(d.legs.length, 0);
});

test('legs: who was where rides the located scenes', () => {
    const entry = (chain, present) => ({
        chain,
        at: { msgIndex: 0, tagIndex: 0 },
        present,
        date: '',
        time: '',
        hour: null,
        weather: '',
        locationTag: '',
    });
    const atlas = buildAtlas([entry(['Local Cafe'], ['Jin', 'Mara']), entry(['Docks'], ['Jin'])]);
    const d = deriveLegs(atlas);

    const cafe = Object.values(atlas.nodes).find(node => node.fold === 'local cafe').id;
    const docks = Object.values(atlas.nodes).find(node => node.fold === 'docks').id;
    assert.deepEqual(d.present[cafe], { Jin: 1, Mara: 1 });
    assert.deepEqual(d.present[docks], { Jin: 1 });
});

test('travelMode reads the vehicle, and the unknown rides the generic route', () => {
    assert.equal(travelMode('Jin\u2019s Lotus Emira').glyph, 'car');
    assert.equal(travelMode('Night Ferry').glyph, 'boat');
    assert.equal(travelMode('Sky Chariot').glyph, 'plane');
    assert.equal(travelMode('The Nightjar').glyph, 'route');
    assert.equal(travelMode('').label, 'on the way');
});

const coordsOf = layout => layout.order.map(item => [item.n.key, item.ax, item.ay]);

test('layout: the same story draws the same chart, rebuild after rebuild', () => {
    const make = () => buildAtlas(obs(
        ['USA', 'New York City', 'Local Cafe'],
        ['USA', 'New York City', 'Pier 9'],
        ['USA', 'Brooklyn', 'Docks'],
    ));
    assert.deepEqual(coordsOf(layoutAtlas(make(), { depth: 4 })), coordsOf(layoutAtlas(make(), { depth: 4 })));
});

test('layout: a new place claims a free slot and moves nobody', () => {
    const before = buildAtlas(obs(
        ['USA', 'New York City', 'Local Cafe'],
        ['USA', 'New York City', 'Pier 9'],
    ));
    const after = buildAtlas(obs(
        ['USA', 'New York City', 'Local Cafe'],
        ['USA', 'New York City', 'Pier 9'],
        ['USA', 'New York City', 'Harbor'],
    ));
    const a = layoutAtlas(before, { depth: 4 });
    const b = layoutAtlas(after, { depth: 4 });

    for (const id of before.order) {
        assert.equal(b.items[id].ax, a.items[id].ax);
        assert.equal(b.items[id].ay, a.items[id].ay);
    }
    assert.ok(Object.values(after.nodes).some(node => node.fold === 'harbor'));
});

test('layout: a whole new territory appends and leaves the old world alone', () => {
    const before = buildAtlas(obs(
        ['Japan', 'Kyoto', 'Temple'],
        ['Japan', 'Osaka', 'Castle'],
    ));
    const after = buildAtlas(obs(
        ['Japan', 'Kyoto', 'Temple'],
        ['Japan', 'Osaka', 'Castle'],
        ['USA', 'New York City', 'Docks'],
    ));
    const a = layoutAtlas(before, { depth: 4 });
    const b = layoutAtlas(after, { depth: 4 });

    for (const id of before.order) {
        assert.equal(b.items[id].ax, a.items[id].ax);
        assert.equal(b.items[id].ay, a.items[id].ay);
    }
});

test('layout: revisiting a place moves nothing at all', () => {
    const chains = [
        ['USA', 'New York City', 'Local Cafe'],
        ['USA', 'New York City', 'Pier 9'],
    ];
    const a = layoutAtlas(buildAtlas(obs(...chains)), { depth: 4 });
    const b = layoutAtlas(buildAtlas(obs(...chains, ['USA', 'New York City', 'Local Cafe'])), { depth: 4 });
    assert.deepEqual(coordsOf(a), coordsOf(b));
});

test('layout: depth collapses children into the parent pin, and the anchor follows', () => {
    const atlas = buildAtlas(obs(
        ['USA', 'New York City', 'Jammie\u2019s house', 'Kitchen'],
        ['USA', 'New York City', 'Jammie\u2019s house', 'Living Room'],
    ));
    const find = fold => Object.values(atlas.nodes).find(node => node.fold === fold);
    const house = find('jammies house');
    const kitchen = find('kitchen');
    const city = find('new york city');

    const wide = layoutAtlas(atlas, { depth: 99 });
    assert.equal(wide.items[kitchen.id].pin, true);

    const shallow = layoutAtlas(atlas, { depth: 3 });
    assert.equal(shallow.items[city.id].pin, false);
    assert.equal(shallow.items[house.id].pin, true);
    assert.equal(shallow.items[kitchen.id], undefined);
    assert.equal(shallow.anchor(kitchen.id).n.id, house.id);

    // a collapsed node draws to its nearest pin; a plate with no pin above it
    // anchors to itself
    assert.equal(shallow.anchor(city.id).n.id, city.id);
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

test('the trail: the journey segments through every level the ship crossed', () => {
    const atlas = buildAtlas(obs(
        ['Corporate Space', 'Outer Rim', 'Mara\u2019s Rest', 'Transit Hub', 'Landing Pad'],
        ['Corporate Space', 'Outer Rim', 'Mara\u2019s Rest', 'En Route', 'CV-7742 Shuttle'],
        ['Corporate Space', 'En Route', 'CV-7742 Shuttle', 'Cockpit'],
        ['Corporate Space', 'Kessel Drift', 'En Route', 'CV-7742 Shuttle', 'Bunk Room'],
        ['Corporate Space', 'Kessel Drift', 'Kessel\u2019s Rest Station', 'Docking Bay 7'],
    ));
    const d = deriveLegs(atlas);
    const name = id => atlas.nodes[id].name;

    assert.deepEqual(d.legs.map(leg => [name(leg.dir[0]), name(leg.dir[1])]), [
        ['Landing Pad', 'Mara\u2019s Rest'],
        ['Mara\u2019s Rest', 'Corporate Space'],
        ['Corporate Space', 'Kessel Drift'],
        ['Kessel Drift', 'Docking Bay 7'],
    ]);
    assert.ok(d.legs.every(leg => leg.mode && leg.mode.glyph === 'rocket'), 'the shuttle carries every segment');

    // rooms aboard are places of their own, never leg endpoints
    assert.deepEqual(foldsOf(atlas).filter(fold => fold === 'cockpit' || fold === 'bunk room').sort(), ['bunk room', 'cockpit']);
    const ship = byFold(atlas, 'cv 7742 shuttle')[0];
    assert.deepEqual(
        ship.trajectory.map(stop => (stop.positionId ? atlas.nodes[stop.positionId].name : null)),
        ['Mara\u2019s Rest', 'Corporate Space', 'Kessel Drift']);
    assert.deepEqual(ship.trajectory.map(stop => !!stop.moving), [true, true, true]);
    assert.equal(name(d.nowId), 'Docking Bay 7', 'the story ends on land');
});

test('layoutAtlas: a vehicle\u2019s rooms live on its deck, never on the world chart', () => {
    const atlas = buildAtlas(obs(
        ['Space', 'En Route', 'CV-7742 Shuttle', 'Cockpit'],
        ['Space', 'En Route', 'CV-7742 Shuttle', 'Bunk Room'],
        ['Space', 'Port', 'Pier 9'],
    ));

    const world = layoutAtlas(atlas, { depth: 99 });
    assert.deepEqual(world.order.map(item => item.n.name).sort(), ['Pier 9', 'Port', 'Space']);
    assert.ok(!world.order.some(item => item.n.name === 'Cockpit'), 'no rooms on the world chart');

    const ship = Object.values(atlas.nodes).find(node => node.kind === 'mobile');
    const deck = layoutAtlas(atlas, { depth: 99, inside: ship.id });
    assert.deepEqual(deck.order.map(item => item.n.name).sort(), ['Bunk Room', 'CV-7742 Shuttle', 'Cockpit']);
    assert.ok(deck.order.filter(item => item.pin).some(item => item.n.name === 'Cockpit'), 'the rooms are pins on the deck');
});
