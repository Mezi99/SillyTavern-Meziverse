import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BG_STORE_VERSION,
    BG_STORY_REPLIES,
    WATCHER_SCHEMA,
    aliasLocation,
    buildWatcherRequest,
    cleanPlaceText,
    compileBgPrompt,
    currentRecord,
    decide,
    extractRecentPlaces,
    fallbackLocationPrompt,
    formatLatestStory,
    groupMessageByScene,
    isOurBackground,
    knownBackgroundsList,
    locationKey,
    lookupRecord,
    normalizeStore,
    noteBaseline,
    parseWatcherReply,
    placeShortName,
    planResolution,
    recoverCurrentKey,
    resolveRecordId,
    resolveStampId,
    restorePlan,
    setStamp,
    stampOf,
    storeRecord,
    toCssBgUrl,
    watcherSystemPrompt,
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

test('normalizeStore keeps a recorded baseline and prunes junk', () => {
    const kept = normalizeStore({ baseline: { lock: 'url("/bg/x.png")', shown: ' url("/bg/y.png") ' } });
    assert.deepEqual(kept.baseline, { lock: 'url("/bg/x.png")', shown: 'url("/bg/y.png")' });

    const empty = normalizeStore({ baseline: { lock: null, shown: '' } });
    assert.deepEqual(empty.baseline, { lock: null, shown: '' }, 'recorded as nothing is not unrecorded');

    for (const junk of ['x', 5, ['a'], { lock: 3, shown: '' }, { lock: null }, null]) {
        assert.equal(normalizeStore({ baseline: junk }).baseline, undefined, `junk baseline pruned: ${JSON.stringify(junk)}`);
    }
});

test('noteBaseline records the takeover once and never rewrites', () => {
    const store = normalizeStore();

    const first = noteBaseline(store, { lock: 'url("/bg/user.png")', shown: 'url("/bg/user.png")' });
    assert.deepEqual(first, { lock: 'url("/bg/user.png")', shown: 'url("/bg/user.png")' });

    const second = noteBaseline(store, { lock: null, shown: 'url("/bg/other.png")' });
    assert.deepEqual(second, first, 'the first takeover wins');
});

test('noteBaseline refuses to invent a baseline behind our own image', () => {
    const store = normalizeStore();
    storeRecord(store, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });

    // Drawn before the baseline bookkeeping existed: the lock is already
    // ours, the pre-chain state is unknowable, so nothing is recorded.
    assert.equal(noteBaseline(store, { lock: toCssBgUrl('/images/pier.png'), shown: '' }), undefined);
    assert.equal(store.baseline, undefined);

    assert.ok(noteBaseline(store, { lock: null, shown: '' }), 'a lockless chat records, even when found empty');
});

test('restorePlan hands back the baseline, unlocks legacy, stands down for the user', () => {
    const ours = toCssBgUrl('/images/pier.png');

    const store = normalizeStore();
    storeRecord(store, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });
    noteBaseline(store, { lock: null, shown: 'url("/bg/global.png")' });

    assert.deepEqual(restorePlan(store, ours), {
        action: 'restore',
        baseline: { lock: null, shown: 'url("/bg/global.png")' },
    });
    assert.deepEqual(restorePlan(store, 'url("/bg/user.png")'), { action: 'none' }, 'the user locked their own: theirs');
    assert.deepEqual(restorePlan(store, null), { action: 'none' }, 'nothing of ours on screen');
    assert.deepEqual(restorePlan(store, '   '), { action: 'none' });

    const legacy = normalizeStore();
    storeRecord(legacy, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });
    assert.deepEqual(restorePlan(legacy, ours), { action: 'unlock' }, 'drawn before baselines existed: SillyTavern unlocks');
    assert.deepEqual(restorePlan(legacy, 'url("/bg/user.png")'), { action: 'none' }, 'even legacy stands down for the user');

    assert.equal(isOurBackground(store, ours), true, 'the record path marks the background ours');
    assert.equal(isOurBackground(store, '/images/pier.png'), true, 'the raw path too');
    assert.equal(isOurBackground(store, 'url("/bg/user.png")'), false);
    assert.equal(isOurBackground(normalizeStore(), ours), false, 'an empty store owns nothing');
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

const msg = mes => ({ mes });

test('groupMessageByScene groups narration under the scene it happens in', () => {
    const groups = groupMessageByScene(
        'Pier approach. <scene date="Tuesday, March 4 · 9:40 PM" location="The city | Docks | Pier 9" weather="Rain" /> Rain hammers the planks. <scene location="The Docks" /> Silence on the boards.',
    );

    assert.deepEqual(groups, [
        { place: '', date: '', time: '', weather: '', text: 'Pier approach.' },
        { place: 'The city | Docks | Pier 9', date: 'Tuesday, March 4', time: '9:40 PM', weather: 'Rain', text: 'Rain hammers the planks.' },
        { place: 'The Docks', date: '', time: '', weather: '', text: 'Silence on the boards.' },
    ]);
});

test('groupMessageByScene strips other tags out of the narration', () => {
    const groups = groupMessageByScene('Walk on. <scene location="A" /> At the pier. <ledger>secret</ledger>');
    assert.deepEqual(groups.map(group => group.text), ['Walk on.', 'At the pier.']);
});

test('extractRecentPlaces walks the latest replies backwards, oldest first', () => {
    const messages = [
        msg('<scene location="The Docks" /> ...'),
        msg('plain text'),
        msg('<scene location="Pier 9" /> ...'),
        msg('<scene location="Pier 9" /> again'),
    ];

    assert.deepEqual(extractRecentPlaces(messages, { limit: 6 }), ['The Docks', 'Pier 9']);
});

test('formatLatestStory groups by scene when tagged and stays raw when not', () => {
    const messages = [msg('Pre. <scene location="A" weather="Rain" /> Post.')];

    assert.equal(formatLatestStory(messages, { tagged: true, count: 2 }), 'Pre.\nSCENE: A (Rain)\nPost.');
    assert.equal(formatLatestStory(messages, { tagged: false, count: 2 }), 'Pre. <scene location="A" weather="Rain" /> Post.');
    assert.equal(formatLatestStory([msg('one'), msg('two')], { tagged: false, count: 1 }), 'two', 'the window is the last count replies');

    const polluted = [msg('<scene date="[Friday]" location="[Metro City | Pier 9]" weather="[Cool]" /> x')];
    assert.equal(
        formatLatestStory(polluted, { tagged: true, count: 1 }),
        'SCENE: Metro City | Pier 9 (Friday, Cool)\nx',
        'the note example\'s bracket echo never reaches the story blocks');
});

test('buildWatcherRequest serves the store and the story, and knows force', () => {
    const store = normalizeStore();
    const messages = [msg('<scene location="A" /> x')];

    const empty = buildWatcherRequest({ store, messages, tagged: true, count: 2 });
    assert.ok(empty.prompt.includes('CURRENT BACKGROUND\nnone yet'));
    assert.ok(empty.prompt.includes('KNOWN BACKGROUNDS\nnone'));
    assert.ok(empty.prompt.includes('RECENT PLACES\nA'));
    assert.ok(empty.prompt.includes('LATEST STORY\n'));
    assert.equal(empty.jsonSchema, WATCHER_SCHEMA);
    assert.equal(empty.systemPrompt, watcherSystemPrompt());

    storeRecord(store, { key: 'A', place: 'A', prompt: 'a pier at dusk', path: '/a.png' });
    const full = buildWatcherRequest({ store, messages, tagged: true, count: 2 });
    assert.ok(full.prompt.includes('CURRENT BACKGROUND\nA [Full/world/map location: A] - a pier at dusk'));
    assert.ok(full.prompt.includes('KNOWN BACKGROUNDS\n- bg_1: A [Full/world/map location: A] - a pier at dusk'));

    assert.ok(watcherSystemPrompt({ force: true }).includes('fresh image'), 'force switches matching off');
});

test('watcherSystemPrompt keeps the answer format while the core stays tunable', () => {
    assert.ok(watcherSystemPrompt().includes('grouped by scene blocks'), 'the scene-tagged hand leans on the scene structure');
    assert.ok(watcherSystemPrompt({ tagged: false }).includes('no scene markers'), 'the plain-prose hand gets the raw-prose core');

    const custom = watcherSystemPrompt({ core: 'Describe places like a haiku.' });
    assert.ok(custom.startsWith('Describe places like a haiku.'));
    assert.ok(custom.includes('"state":"same|known|new"'), 'the answer format is appended whatever the core says');

    const forced = watcherSystemPrompt({ force: true, core: 'Describe places like a haiku.' });
    assert.ok(forced.includes('fresh image'), 'force switches matching off');
});

test('buildWatcherRequest uses the core and the hand it is given', () => {
    const store = normalizeStore();
    const request = buildWatcherRequest({ store, messages: [msg('<scene location="A" /> x')], systemCore: 'My own rules.' });
    assert.ok(request.systemPrompt.startsWith('My own rules.'));
    assert.ok(request.systemPrompt.includes('"state":"same|known|new"'));
    assert.equal(request.responseLength, 600);
});

test('buildWatcherRequest reads only the last reply by default', () => {
    const store = normalizeStore();
    const messages = [msg('the pier at dawn'), msg('the warehouse at midnight')];

    const request = buildWatcherRequest({ store, messages, tagged: false });
    assert.equal(BG_STORY_REPLIES, 1);
    assert.ok(request.prompt.includes('LATEST STORY\nthe warehouse at midnight'));
    assert.ok(!request.prompt.includes('the pier at dawn'), 'story context is hardcoded to the last reply');
});

test('planResolution runs the free outcomes at any pace and throttles the costly half', () => {
    const record = { id: 'bg_1' };

    // The default pace draws on every AI reply.
    assert.deepEqual(planResolution({ step: null, counter: 0, every: 1 }), { go: 'watch', record: null, counter: 0 });

    // A tagged reply's free outcomes run at once - no call, no image - and
    // still count the reply on the clock.
    assert.deepEqual(planResolution({ step: { action: 'none', record }, counter: 0, every: 5 }), { go: 'unchanged', record, counter: 1 });
    assert.deepEqual(planResolution({ step: { action: 'apply', record }, counter: 2, every: 5 }), { go: 'cached', record, counter: 3 });

    // The watcher and its image wait for the pace; replies between draws
    // keep the picture they carried.
    assert.deepEqual(planResolution({ step: null, counter: 0, every: 3 }), { go: 'keep', record: null, counter: 1 });
    assert.deepEqual(planResolution({ step: null, counter: 1, every: 3 }), { go: 'keep', record: null, counter: 2 });
    assert.deepEqual(planResolution({ step: null, counter: 2, every: 3 }), { go: 'watch', record: null, counter: 0 });
    assert.deepEqual(planResolution({ step: { action: 'watch', record: null }, counter: 2, every: 3 }), { go: 'watch', record: null, counter: 0 });

    // The brush never waits and never counts.
    assert.deepEqual(planResolution({ step: { action: 'none', record }, force: true, counter: 2, every: 3 }), { go: 'watch', record: null, counter: 2 });

    // A missing or broken setting clamps to 1.
    assert.equal(planResolution({ step: null, counter: 4, every: 0 }).go, 'watch');
});

test('parseWatcherReply reads the JSON, the text protocol, or a bare description', () => {
    assert.deepEqual(
        parseWatcherReply('{"state":"same","knownId":null,"place":"Pier 9","prompt":""}'),
        { state: 'same', knownId: null, place: 'Pier 9', prompt: '' },
    );
    assert.deepEqual(
        parseWatcherReply('Here you go:\n```json\n{"state":"known","knownId":3,"place":"Docks","prompt":""}\n```'),
        { state: 'known', knownId: '3', place: 'Docks', prompt: '' },
    );
    assert.deepEqual(
        parseWatcherReply('{"state":"unchanged","knownId":null,"place":"","prompt":""}'),
        { state: 'same', knownId: null, place: '', prompt: '' },
        'the state word is judged by meaning too',
    );

    assert.deepEqual(parseWatcherReply('SAME'), { state: 'same', knownId: null, place: '', prompt: '' });
    assert.deepEqual(parseWatcherReply('KNOWN bg_3'), { state: 'known', knownId: 'bg_3', place: '', prompt: '' });
    assert.deepEqual(
        parseWatcherReply('NEW\na pier at dusk, rain'),
        { state: 'new', knownId: null, place: '', prompt: 'a pier at dusk, rain' },
    );

    assert.deepEqual(
        parseWatcherReply('a lone pier at dusk, rain'),
        { state: 'new', knownId: null, place: '', prompt: 'a lone pier at dusk, rain' },
        'a bare description counts as new',
    );
    assert.equal(parseWatcherReply(''), null);
    assert.equal(parseWatcherReply('{"state":"???"}'), null, 'an unknown state is not guessed at');
});

test('compileBgPrompt layers the style over the watcher description', () => {
    assert.equal(compileBgPrompt('a pier at dusk', 'anime style'), 'anime style, a pier at dusk');
    assert.equal(compileBgPrompt('a pier at dusk.', ''), 'a pier at dusk');
    assert.equal(compileBgPrompt('', 'anime style'), 'anime style');
    assert.equal(compileBgPrompt('anime style, a pier at dusk', 'anime style'), 'anime style, a pier at dusk', 'the style is never stacked on its own echo');
    assert.equal(compileBgPrompt('Anime Style, a pier', 'anime style'), 'Anime Style, a pier', 'echo matching is case-blind');
});

test('cleanPlaceText and placeShortName read the location chain', () => {
    assert.equal(cleanPlaceText('[Metro City | Docks | Pier 9]'), 'Metro City | Docks | Pier 9');
    assert.equal(cleanPlaceText('  [Unit 4B - Bedroom]  '), 'Unit 4B - Bedroom');

    assert.equal(placeShortName('Metro City | Downtown District | Fifth Street Walk-Up | Unit 4B - Bedroom'), 'Unit 4B - Bedroom');
    assert.equal(placeShortName('[Metro City | Docks | Pier 9]'), 'Pier 9', 'bracket pollution never rides the short name');
    assert.equal(placeShortName('The docks'), 'The docks', 'a place with no chain is its own short name');
    assert.equal(placeShortName(''), '');
});

test('buildWatcherRequest labels the place and never truncates the description', () => {
    const store = normalizeStore();
    const long = 'dim gritty bedroom at night, ' + 'word '.repeat(60) + 'the end of the description';
    storeRecord(store, { key: 'Metro City | Unit 4B - Bedroom', place: '[Metro City | Unit 4B - Bedroom]', prompt: long, path: '/bed.png' });

    const request = buildWatcherRequest({ store, messages: [msg('<scene location="Metro City | Unit 4B - Bedroom" /> x')], tagged: true });
    const line = `- bg_1: Unit 4B - Bedroom [Full/world/map location: Metro City | Unit 4B - Bedroom] - ${long}`;
    assert.ok(request.prompt.includes(line), 'the short name names the picture, the chain is context, the description arrives whole');
    assert.ok(request.prompt.includes(`CURRENT BACKGROUND\nUnit 4B - Bedroom [Full/world/map location: Metro City | Unit 4B - Bedroom] - ${long}`));
    assert.ok(!request.prompt.includes('...'), 'nothing is cut');
});

test('fallbackLocationPrompt describes the place plainly when the watcher fails', () => {
    assert.equal(
        fallbackLocationPrompt({ placeFull: 'The Docks', date: 'Tuesday, March 4', time: '9:40 PM', weather: 'Rain' }),
        'The Docks, Tuesday, March 4 9:40 PM, Rain, wide establishing shot, empty place, detailed environment',
    );
    assert.equal(fallbackLocationPrompt('Pier 9'), 'Pier 9, wide establishing shot, empty place, detailed environment');
});

/* ---------- per-response stamps ---------- */

test('setStamp writes the variant slot and mirrors only the active variant', () => {
    const message = { extra: {}, swipes: ['a', 'b'], swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }] };

    assert.equal(stampOf(message), null, 'nothing stamped yet');

    assert.equal(setStamp(message, 0, 'bg_3'), true);
    assert.equal(stampOf(message, 0), 'bg_3', 'the variant keeps its own stamp');
    assert.equal(stampOf(message), null, 'the active variant is untouched');
    assert.equal(message.extra.meziverse, undefined, 'the mirror follows the active variant only');

    assert.equal(setStamp(message, 1, 'bg_4'), true);
    assert.equal(stampOf(message), 'bg_4', 'the active variant mirrors its stamp');
    assert.equal(stampOf(message, 1), 'bg_4');
    assert.equal(setStamp(message, 1, 'bg_4'), false, 'restamping the same record changes nothing');

    assert.equal(setStamp(message, 1, ''), false, 'an empty stamp is refused');
});

test('setStamp covers replies without swipes', () => {
    const message = { extra: {} };
    assert.equal(setStamp(message, 0, 'bg_2'), true);
    assert.equal(stampOf(message), 'bg_2');
    assert.equal(stampOf(message, 0), 'bg_2', 'the mirror is all there is');
});

test("resolveStampId keeps each reply's own picture and feeds user turns", () => {
    const messages = [
        msg('greeting'),
        { mes: 'reply one', extra: {}, swipes: ['x'], swipe_id: 0, swipe_info: [{ extra: {} }] },
        { mes: 'user turn', extra: {}, is_user: true },
        msg('reply two'),
    ];
    setStamp(messages[1], 0, 'bg_5');
    setStamp(messages[3], 0, 'bg_9');

    assert.deepEqual(resolveStampId(messages, 1), { id: 'bg_5', index: 1 });
    assert.deepEqual(resolveStampId(messages, 2), { id: 'bg_5', index: 1 }, 'a user turn takes the previous reply\'s picture');
    assert.deepEqual(resolveStampId(messages, 3), { id: 'bg_9', index: 3 }, 'a later picture supersedes walking back');
    assert.equal(resolveStampId(messages, 0), null, 'nothing before the first stamp');
});

test('resolveStampId finds the variant a fresh swipe was taken from', () => {
    const message = { mes: 'swipes', extra: {}, swipes: ['a', 'b', 'c'], swipe_id: 2, swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] };
    setStamp(message, 0, 'bg_1');

    assert.deepEqual(resolveStampId([message], 0), { id: 'bg_1', index: 0 }, 'an unseen variant inherits the nearest stamped one');

    setStamp(message, 1, 'bg_2');
    assert.deepEqual(resolveStampId([message], 0), { id: 'bg_2', index: 0 }, 'the nearer variant wins');

    setStamp(message, 2, 'bg_3');
    assert.deepEqual(resolveStampId([message], 0), { id: 'bg_3', index: 0 }, 'its own stamp rules');
});

test('decide carries what the reply already has, by meaning', () => {
    const store = normalizeStore();
    const pier = storeRecord(store, { place: 'The city | Docks | Pier 9', prompt: 'a pier', path: '/b/pier.png' });
    const roof = storeRecord(store, { place: 'Rooftop', prompt: 'a roof', path: '/b/roof.png' });

    assert.equal(decide(store, 'The city | Docks | Pier 9', { baseline: pier }).action, 'none', 'same place as carried: nothing to do');
    assert.equal(decide(store, 'the city | docks | PIER 9', { baseline: pier }).action, 'none', 'spelling drift is still the same picture');
    assert.equal(decide(store, 'Rooftop', { baseline: pier }).action, 'apply', 'a known place brings its cached picture');
    assert.equal(decide(store, 'Somewhere New', { baseline: pier }).action, 'watch', 'anything else goes to the watcher');

    assert.equal(decide(store, 'Rooftop', { baseline: null }).action, 'apply', 'with nothing carried in, a known place still applies');
    assert.equal(decide(store, 'Somewhere New', { baseline: null }).action, 'watch');
    assert.equal(decide(store, '', { baseline: pier }).action, 'none', 'no place known: nothing changes');

    // A record registered under one key but named another still counts as the
    // same picture when the reply carries it.
    const drift = normalizeStore();
    const aliased = storeRecord(drift, { key: 'pier 9', place: 'Pier No9', prompt: 'a pier', path: '/b/pier.png' });
    assert.equal(decide(drift, 'Pier No9', { baseline: aliased }).action, 'none', 'the name the carried picture goes by is a skip too');
});

test("buildWatcherRequest asks about its own reply, not the chat's end", () => {
    const store = normalizeStore();
    const prior = storeRecord(store, { place: 'Pier 9', prompt: 'a pier at dusk', path: '/b/pier.png' });
    const messages = [
        msg('<scene location="Pier 9" /> at the pier'),
        msg('<scene location="Rooftop" /> on the roof'),
        msg('still on the roof'),
    ];

    const request = buildWatcherRequest({ store, messages, at: 1, current: prior });
    assert.ok(request.prompt.includes('CURRENT BACKGROUND\nPier 9 [Full/world/map location: Pier 9] - a pier at dusk'), 'the reply carried its own baseline in');
    assert.ok(request.prompt.includes('SCENE: Rooftop'), 'the story ends at the target reply');
    assert.ok(!request.prompt.includes('still on the roof'), 'later replies are not part of its story');

    const plain = buildWatcherRequest({ store, messages });
    assert.ok(plain.prompt.includes('CURRENT BACKGROUND\nPier 9 [Full/world/map location: Pier 9] - a pier at dusk'), 'with no baseline given, the on-screen record stands in');
});
