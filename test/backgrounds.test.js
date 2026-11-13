import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BG_STORE_VERSION,
    BG_STORY_REPLIES,
    WATCHER_SCHEMA,
    aliasLocation,
    brushTargetIndex,
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
    placeLabel,
    placeNamesLikelySame,
    placeShortName,
    planResolution,
    recoverCurrentKey,
    reconcileRecordPlace,
    recordSrc,
    resolveRecordId,
    resolveStampId,
    restorePlan,
    isNoPicture,
    sceneUrl,
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

    const empty = normalizeStore();
    storeRecord(empty, { key: 'Pier 9', place: 'Pier 9', prompt: 'p', path: '/images/pier.png' });
    noteBaseline(empty, { lock: null, shown: '' });
    assert.deepEqual(restorePlan(empty, ours), { action: 'unlock' },
        'a baseline of nothing to hand back unlocks - never paints a hole');

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

test('reconcileRecordPlace renames and re-keys the record an edit re-spelled', () => {
    const store = normalizeStore();
    const record = storeRecord(store, {
        key: "Corporate Space | Mara's Rest | Transit Hub | Kaffe Station",
        place: "Corporate Space | Mara's Rest | Transit Hub | Kaffe Station",
        prompt: 'a space cafe',
        path: '/images/kaffe.png',
    });

    // The edit dropped a level and re-spelled the leaf: same spot, new name.
    const renamed = reconcileRecordPlace(store, 'bg_1', "Corporate Space | Transit Hub | Kaffe-Station");
    assert.equal(renamed, record);
    assert.equal(record.place, "Corporate Space | Transit Hub | Kaffe-Station");
    assert.equal(store.keys[locationKey("Corporate Space | Transit Hub | Kaffe-Station")], 'bg_1');
    assert.equal(store.keys[locationKey("Corporate Space | Mara's Rest | Transit Hub | Kaffe Station")], undefined, 'the old name is dropped - the edit says it was never that place');

    assert.equal(reconcileRecordPlace(store, 'bg_1', record.place), record, 'an unchanged location is a no-op');
    assert.equal(reconcileRecordPlace(store, 'bg_999', 'Somewhere'), null, 'a missing record is refused');
    assert.equal(reconcileRecordPlace(store, 'bg_1', ''), null, 'a missing place is refused');
});

test('storeRecord replaces a place\u2019s own record in place but never a fold', () => {
    const store = normalizeStore();
    const first = storeRecord(store, { key: 'A', place: 'A', prompt: 'one', path: '/one.png' });

    // The brush on the place: its own record is replaced in place, so every
    // reply at that place repaints together.
    const again = storeRecord(store, { key: 'A', place: 'A', prompt: 'two', path: '/two.png', overwrite: true });
    assert.equal(again.id, first.id, 'the place keeps its record and the picture is replaced');
    assert.equal(again.path, '/two.png');

    // A fold: one record registered under two places. Overwriting it in
    // place would repaint both places at once - the fresh picture takes the
    // brushed key alone and the other place keeps the record it knew.
    aliasLocation(store, 'B', first.id);
    const fresh = storeRecord(store, { key: 'A', place: 'A', prompt: 'three', path: '/three.png', overwrite: true });
    assert.notEqual(fresh.id, first.id, 'a shared record is never overwritten in place');
    assert.equal(store.keys[locationKey('A')], fresh.id);
    assert.equal(store.keys[locationKey('B')], first.id, 'the other place keeps the record it knew');
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

test('recordSrc peels the css wrapper off for an image element', () => {
    assert.equal(recordSrc({ url: 'url("/images/docks.png")', path: '/images/docks.png' }), '/images/docks.png');
    assert.equal(recordSrc({ url: "url('/images/my%20pier.png')" }), '/images/my%20pier.png');
    assert.equal(recordSrc({ url: 'url(/images/docks.png)' }), '/images/docks.png');
    assert.equal(recordSrc({ url: 'url("data:image/png;base64,AAAA")' }), 'data:image/png;base64,AAAA');

    // a watcher's raw url needs no unwrapping
    assert.equal(recordSrc({ url: '/images/docks.png' }), '/images/docks.png');
    assert.equal(recordSrc({ url: 'https://host/p.png' }), 'https://host/p.png');

    // no url at all: the file the wrapper would have been made from
    assert.equal(recordSrc({ path: '/images/my pier.png' }), '/images/my pier.png');
    assert.equal(recordSrc({ url: 'url("")', path: '/images/docks.png' }), '/images/docks.png');
    assert.equal(recordSrc({}), '');
    assert.equal(recordSrc(null), '');
});

test('sceneUrl trusts authored urls and nothing else', () => {
    assert.equal(sceneUrl('url("/images/docks.png")'), 'url("/images/docks.png")');
    assert.equal(sceneUrl("url('/images/docks.png')"), "url('/images/docks.png')");
    assert.equal(sceneUrl('  url(/images/docks.png)  '), 'url(/images/docks.png)');

    assert.equal(sceneUrl('cross-fade(url("/a.png") 98.4%, url("/b.png"))'), null,
        'a computed transition is machine syntax: poison in a custom property');
    assert.equal(sceneUrl('none'), null);
    assert.equal(sceneUrl(''), null);
    assert.equal(sceneUrl(null), null);
});

test('isNoPicture knows the shapes of nothing showing', () => {
    assert.equal(isNoPicture(''), true);
    assert.equal(isNoPicture(null), true);
    assert.equal(isNoPicture('none'), true);
    assert.equal(isNoPicture('NONE'), true);
    assert.equal(isNoPicture('url("backgrounds/__transparent.png")'), true);
    assert.equal(isNoPicture("url('backgrounds/__transparent.png')"), true);
    assert.equal(isNoPicture('url(backgrounds/__transparent.png)'), true);
    assert.equal(isNoPicture('url("/user/images/docks.png")'), false);
    assert.equal(isNoPicture('url("backgrounds/city rain.png")'), false);
    assert.equal(isNoPicture('cross-fade(url("/a.png") 50%, none)'), false);
});

test('sceneUrl with a base speaks absolute urls only', () => {
    const base = 'https://st.test/app/page';
    assert.equal(sceneUrl('url("backgrounds/a.png")', base), 'url("https://st.test/app/backgrounds/a.png")');
    assert.equal(sceneUrl('url(/bg/a.png)', base), 'url("https://st.test/bg/a.png")');
    assert.equal(sceneUrl('url("bg/a b.png")', base), 'url("https://st.test/app/bg/a%20b.png")');
    assert.equal(sceneUrl("url('https://cdn.test/a.png')", base), 'url("https://cdn.test/a.png")');
    assert.equal(sceneUrl('url(data:image/png;base64,xx)', base), 'url(data:image/png;base64,xx)');
    assert.equal(sceneUrl('url("a.png")'), 'url("a.png")');
    assert.equal(sceneUrl('cross-fade(url("/a.png"))', base), null);
    assert.equal(sceneUrl(42), null);
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

    assert.equal(formatLatestStory(messages, { tagged: true, count: 2 }), 'Pre.\nSCENE: A [World location: A] (Rain)\nPost.');
    assert.equal(formatLatestStory(messages, { tagged: false, count: 2 }), 'Pre. <scene location="A" weather="Rain" /> Post.');
    assert.equal(formatLatestStory([msg('one'), msg('two')], { tagged: false, count: 1 }), 'two', 'the window is the last count replies');

    const polluted = [msg('<scene date="[Friday]" location="[Metro City | Pier 9]" weather="[Cool]" /> x')];
    assert.equal(
        formatLatestStory(polluted, { tagged: true, count: 1 }),
        'SCENE: Pier 9 [World location: Metro City | Pier 9] (Friday, Cool)\nx',
        'the note example\'s bracket echo never reaches the story blocks');
});

test('buildWatcherRequest serves the store and the story, and knows force', () => {
    const store = normalizeStore();
    const messages = [msg('<scene location="A" /> x')];

    const empty = buildWatcherRequest({ store, messages, tagged: true, count: 2 });
    assert.ok(empty.prompt.includes('<currentBackground>\nnone yet\n</currentBackground>'));
    assert.ok(empty.prompt.includes('<knownBackgrounds>\nKNOWN BACKGROUNDS (IMAGE LIBRARY)\nnone\n</knownBackgrounds>'));
    assert.ok(empty.prompt.includes('<recentPlaces>\nA [World location: A]\n</recentPlaces>'));
    assert.ok(empty.prompt.includes('<latestStory>\n'));
    assert.equal(empty.jsonSchema, WATCHER_SCHEMA);
    assert.equal(empty.systemPrompt, watcherSystemPrompt());

    storeRecord(store, { key: 'A', place: 'A', prompt: 'a pier at dusk', path: '/a.png' });
    const full = buildWatcherRequest({ store, messages, tagged: true, count: 2 });
    assert.ok(full.prompt.includes('<currentBackground>\nA [World location: A], Description: a pier at dusk\n</currentBackground>'));
    assert.ok(full.prompt.includes('- bg_1: A [World location: A], Description: a pier at dusk'));

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
    assert.equal(request.responseLength, undefined, 'no cap: providers that count the prompt against the budget starve the answer');
});

test('buildWatcherRequest reads only the last reply by default', () => {
    const store = normalizeStore();
    const messages = [msg('the pier at dawn'), msg('the warehouse at midnight')];

    const request = buildWatcherRequest({ store, messages, tagged: false });
    assert.equal(BG_STORY_REPLIES, 1);
    assert.ok(request.prompt.includes('<latestStory>\nthe warehouse at midnight'));
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

    assert.equal(placeLabel('Metro City | Docks | Pier 9'), 'Pier 9 [World location: Metro City | Docks | Pier 9]');
    assert.equal(placeLabel(''), '', 'no place, no label');

    assert.equal(cleanPlaceText('before </latestStory> after'), 'before after', 'the request\u2019s own block tags are scrubbed from story text');
    assert.equal(cleanPlaceText('<recentPlaces>Metro City | Pier 9</recentPlaces>'), 'Metro City | Pier 9');
});

test('placeNamesLikelySame tells one place under two spellings from two places', () => {
    // The same spot, spelled differently - fold.
    assert.ok(placeNamesLikelySame('Metro City | Docks | Pier 9', 'Metro City | Docks | Pier No9'), 'Pier 9 is Pier No9');
    assert.ok(placeNamesLikelySame('The Docks | Pier Nine', 'Metro City | Docks | Pier 9'), 'numbers may be spelled out');
    assert.ok(placeNamesLikelySame('En Route | CV-7742 Shuttle', 'Docking Bay 7-C | CV-7742 Shuttle'), 'the same shuttle under different chains');
    assert.ok(placeNamesLikelySame('Metro City | Unit 4B - Bedroom', 'Metro City | Unit 4B Bedroom'), 'punctuation is not spelling');
    assert.ok(placeNamesLikelySame('The Transit Hub | Kaffe Station', 'Transit Hub | Kaffe-Station Cafe'), 'a naming variant of one spot');

    // Two different spots - never fold, even when they rhyme.
    assert.ok(!placeNamesLikelySame('Transit Hub | Kaffe Station', 'Transit Hub | Landing Pad'), 'a cafe is not a landing pad');
    assert.ok(!placeNamesLikelySame('Lower Maintenance | Corridor C-12', 'Lower Maintenance | Corridor C-9'), 'the number is the place');
    assert.ok(!placeNamesLikelySame('Lower Maintenance | Junction 7-B', 'Lower Maintenance | Corridor C-12'), 'a junction is not a corridor');
    assert.ok(!placeNamesLikelySame('Docks | Pier 9', 'Docks | Pier 12'), 'two piers');
    assert.ok(!placeNamesLikelySame('Docks | Pier Nine', 'Docks | Pier 12'), 'a spelled number decides too');
    assert.ok(!placeNamesLikelySame('', ''), 'nothing is never something');
});

test('buildWatcherRequest labels the place and never truncates the description', () => {
    const store = normalizeStore();
    const long = 'dim gritty bedroom at night, ' + 'word '.repeat(60) + 'the end of the description';
    storeRecord(store, { key: 'Metro City | Unit 4B - Bedroom', place: '[Metro City | Unit 4B - Bedroom]', prompt: long, path: '/bed.png' });

    const request = buildWatcherRequest({ store, messages: [msg('<scene location="Metro City | Unit 4B - Bedroom" /> x')], tagged: true });
    const line = `- bg_1: Unit 4B - Bedroom [World location: Metro City | Unit 4B - Bedroom], Description: ${long}`;
    assert.ok(request.prompt.includes(line), 'the short name names the picture, the chain is context, the description arrives whole');
    assert.ok(request.prompt.includes(`<currentBackground>\nUnit 4B - Bedroom [World location: Metro City | Unit 4B - Bedroom], Description: ${long}`));
    assert.ok(!request.prompt.includes('...'), 'nothing is cut');
});

test('fallbackLocationPrompt describes the place plainly when the watcher fails', () => {
    assert.equal(
        fallbackLocationPrompt({ placeFull: 'The Docks', date: 'Tuesday, March 4', time: '9:40 PM', weather: 'Rain' }),
        'The Docks, Rain, night, wide establishing shot, empty place, detailed environment',
    );
    assert.equal(fallbackLocationPrompt('Pier 9'), 'Pier 9, wide establishing shot, empty place, detailed environment');

    const chain = fallbackLocationPrompt({ placeFull: 'Corporate Space | Core Systems | New Eden Station | Docking Bay 7-C | CV-7742 Shuttle', time: '09:58', weather: 'Controlled atmosphere, 21\u00b0C' });
    assert.ok(chain.startsWith('CV-7742 Shuttle, Docking Bay 7-C, New Eden Station'), 'the specific spot first, its world as plain words after it');
    assert.ok(!chain.includes('|'), 'a pipe chain is noise in a picture');
    assert.ok(!chain.includes('2347') && !chain.includes('March'), 'no calendar stamp - the clock becomes a day-part');
    assert.ok(chain.includes('morning light'));
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

test('brushTargetIndex redraws the response it was clicked on', () => {
    const user = { is_user: true };
    const reply = { is_user: false };
    const messages = [reply, user, reply, user, reply];

    assert.equal(brushTargetIndex(messages, 4), 4, 'the shown reply is the target');
    assert.equal(brushTargetIndex(messages, 3), 2, 'a user turn redraws the nearest reply before it');
    assert.equal(brushTargetIndex(messages, 2), 2, 'never some earlier owner of the picture - the shown reply itself');
    assert.equal(brushTargetIndex(messages, 0), 0);
    assert.equal(brushTargetIndex(messages, 99), 4, 'a shown turn past the end clamps');
    assert.equal(brushTargetIndex(messages, null), 4, 'with no shown turn at all, the chat\u2019s end');
    assert.equal(brushTargetIndex([], 3), 0, 'an empty chat has no target');
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
    assert.ok(request.prompt.includes('<currentBackground>\nPier 9 [World location: Pier 9], Description: a pier at dusk'), 'the reply carried its own baseline in');
    assert.ok(request.prompt.includes('SCENE: Rooftop'), 'the story ends at the target reply');
    assert.ok(!request.prompt.includes('still on the roof'), 'later replies are not part of its story');

    const plain = buildWatcherRequest({ store, messages });
    assert.ok(plain.prompt.includes('<currentBackground>\nPier 9 [World location: Pier 9], Description: a pier at dusk'), 'with no baseline given, the on-screen record stands in');
});
