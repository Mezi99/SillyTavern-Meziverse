import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_DJ_PROMPT,
    LEGACY_DEFAULT_DJ_PROMPT,
    PRIOR_DEFAULT_DJ_PROMPT,
    PICK_MODES,
    djMessages,
    djSystemPrompt,
    parseDjAnswer,
    tidyQuery,
} from '../src/musicdj.js';

/* ---------- djSystemPrompt ---------- */

test('the system prompt is the core, the pick style, and the answer format', () => {
    const prompt = djSystemPrompt({ core: 'You are a tiny DJ. Say little.' });

    assert.match(prompt, /^You are a tiny DJ\. Say little\./);
    assert.match(prompt, /PICK STYLE - ORCHESTRA/);
    assert.match(prompt, /"action":"play"\|"volume"\|"none"/);
    assert.match(prompt, /"alternates"/);
    assert.match(prompt, /searchQuery/);
    // The core stays free of the plumbing - no edit can break parsing.
    assert.doesNotMatch(DEFAULT_DJ_PROMPT, /"action"/);
    assert.doesNotMatch(DEFAULT_DJ_PROMPT, /PICK STYLE/);
    assert.match(DEFAULT_DJ_PROMPT, /music supervisor/);
    assert.match(DEFAULT_DJ_PROMPT, /world decides the sound/);
});

test('both pick styles take the genre from the story itself', () => {
    for (const mode of ['orchestra', 'songs']) {
        assert.match(PICK_MODES[mode], /genre/, `${mode} lets the story's own world decide the sound`);
        assert.match(PICK_MODES[mode], /era/);
        assert.match(PICK_MODES[mode], /alternates: up to 2/);
    }
    assert.match(PICK_MODES.orchestra, /instrumental/i);
    assert.match(PICK_MODES.orchestra, /Never choose songs with vocals/);
    assert.match(PICK_MODES.orchestra, /3 to 6 words/);
    assert.match(PICK_MODES.orchestra, /medieval tavern lute music/);
    assert.match(PICK_MODES.songs, /Artist - Title/);
    assert.match(PICK_MODES.songs, /no "official", "audio", "lyrics"/);
    assert.match(PICK_MODES.songs, /ORCHESTRA form/);
    assert.match(PICK_MODES.songs, /Never invent a song/);
});

test('songs is the pick style it names; anything else falls back to orchestra', () => {
    assert.match(djSystemPrompt({ mode: 'songs' }), /PICK STYLE - SONGS/);
    assert.match(djSystemPrompt({ mode: 'anything' }), /PICK STYLE - ORCHESTRA/);
    assert.match(djSystemPrompt(), /PICK STYLE - ORCHESTRA/);
});

test('an empty or missing core falls back to the default', () => {
    assert.equal(djSystemPrompt({ core: '   ' }), djSystemPrompt());
    assert.equal(djSystemPrompt(), djSystemPrompt({ core: DEFAULT_DJ_PROMPT }));
});

test('old defaults are preserved so untouched saved copies follow the default', () => {
    assert.notEqual(LEGACY_DEFAULT_DJ_PROMPT, DEFAULT_DJ_PROMPT);
    assert.match(LEGACY_DEFAULT_DJ_PROMPT, /Favor instrumental/);
    assert.notEqual(PRIOR_DEFAULT_DJ_PROMPT, DEFAULT_DJ_PROMPT);
    assert.match(PRIOR_DEFAULT_DJ_PROMPT, /You are the scene's music DJ/);
    assert.match(PRIOR_DEFAULT_DJ_PROMPT, /plays the top result/);
});

/* ---------- djMessages ---------- */

test('the question rides as chat turns: history in its own roles, the last turn apart', () => {
    const messages = djMessages({
        history: [
            { role: 'assistant', text: 'The rain eases.' },
            { role: 'user', text: 'You stay.' },
        ],
        last: { role: 'assistant', text: 'She smiles.' },
        playing: { title: 'Blue in Green', channel: 'Miles Davis', mood: 'tender' },
    });

    assert.deepEqual(messages.map(message => message.role), ['assistant', 'user', 'assistant', 'user']);
    assert.equal(messages[0].content, 'The rain eases.');
    assert.equal(messages[2].content, 'She smiles.', 'the turn to judge is its own assistant message');

    const ask = messages[3].content;
    assert.match(ask, /CURRENTLY PLAYING: Blue in Green - Miles Davis \(chosen for mood: tender\)/);
    assert.match(ask, /just above is the latest story turn/);
    assert.doesNotMatch(ask, /FORCED/);
});

test('nothing playing, nothing judged, no forced pick - the ask says so', () => {
    const ask = djMessages({})[0].content;
    assert.match(ask, /CURRENTLY PLAYING: nothing/);
    assert.match(ask, /story is just beginning/);
    assert.doesNotMatch(ask, /FORCED/);
    assert.doesNotMatch(ask, /chosen for mood/);

    const forced = djMessages({ last: { role: 'assistant', text: 'x' }, forceFreshPick: true });
    assert.match(forced[forced.length - 1].content, /FORCED FRESH PICK/);
});

test('the mood rides the playing line only when the track has one', () => {
    const messages = djMessages({ playing: { title: 'T', channel: 'C' } });
    assert.match(messages[messages.length - 1].content, /CURRENTLY PLAYING: T - C/);
    assert.doesNotMatch(messages[messages.length - 1].content, /chosen for mood/);
});

/* ---------- parseDjAnswer ---------- */

test('a clean intent parses as written', () => {
    assert.deepEqual(
        parseDjAnswer('{"action":"play","mood":"tender","searchQuery":"warm jazz piano","volume":35}'),
        { action: 'play', mood: 'tender', searchQuery: 'warm jazz piano', alternates: [], volume: 35 },
    );
});

test('code fences and chatter around the JSON are tolerated', () => {
    const intent = parseDjAnswer('Sure! Here you go:\n```json\n{"action":"volume","mood":"","searchQuery":null,"volume":80}\n```\nEnjoy.');
    assert.deepEqual(intent, { action: 'volume', mood: null, searchQuery: null, alternates: [], volume: 80 });
});

test('an unreadable answer is none - the DJ failing never stops the music', () => {
    assert.deepEqual(parseDjAnswer('I think the scene is lovely'), { action: 'none', mood: null, searchQuery: null, alternates: [], volume: null });
    assert.deepEqual(parseDjAnswer(''), { action: 'none', mood: null, searchQuery: null, alternates: [], volume: null });
    assert.deepEqual(parseDjAnswer(null), { action: 'none', mood: null, searchQuery: null, alternates: [], volume: null });
    assert.deepEqual(parseDjAnswer('[1,2,3]'), { action: 'none', mood: null, searchQuery: null, alternates: [], volume: null });
});

test('impossible intents are folded down, and volume is clamped', () => {
    // A play with nothing to search is not a play.
    assert.equal(parseDjAnswer('{"action":"play","searchQuery":""}').action, 'none');
    // A volume with no number is not a volume.
    assert.equal(parseDjAnswer('{"action":"volume","volume":null}').action, 'none');
    // Unknown actions are none.
    assert.equal(parseDjAnswer('{"action":"dance"}').action, 'none');
    // A volume is a whole number from 0 to 100.
    assert.equal(parseDjAnswer('{"action":"volume","volume":140.6}').volume, 100);
    assert.equal(parseDjAnswer('{"action":"volume","volume":-4}').volume, 0);
});

test('alternates are trimmed, de-duplicated, capped at two and 80 characters', () => {
    const intent = parseDjAnswer(JSON.stringify({
        action: 'play',
        searchQuery: 'medieval tavern lute music',
        alternates: [' western saloon piano ', 'western saloon piano', '', 42, 'x'.repeat(90), 'a third song'],
        volume: 30,
    }));
    assert.deepEqual(intent.alternates, ['western saloon piano', 'x'.repeat(80)]);
});

test('a non-array alternates field is ignored, and a play without a query is not a play', () => {
    for (const alternates of [null, 'backup', { 0: 'one' }]) {
        const intent = parseDjAnswer(JSON.stringify({ action: 'play', searchQuery: 'rain ambience', alternates }));
        assert.deepEqual(intent.alternates, []);
        assert.equal(intent.action, 'play');
    }
    const none = parseDjAnswer('{"action":"play","searchQuery":"   ","alternates":["ok"]}');
    assert.equal(none.action, 'none');
    assert.deepEqual(none.alternates, []);
});

test('tidyQuery strips quotes and orchestra filler, and caps at seven words', () => {
    assert.equal(tidyQuery('  “Medieval   TAVERN lute music.”  '), 'Medieval TAVERN lute music');
    assert.equal(
        tidyQuery('medieval tavern lute music, no copyright, extended, HD'),
        'medieval tavern lute music',
    );
    assert.equal(tidyQuery('one two three four five six seven eight instrumental loop'), 'one two three four five six seven');
    assert.equal(tidyQuery(undefined), '');
});

test('a songs query is only trimmed, never rewritten', () => {
    assert.equal(tidyQuery('  "Artist - Title"  ', 'songs'), 'Artist - Title');
    assert.equal(tidyQuery('Artist - Title extended', 'songs'), 'Artist - Title extended', 'the orchestra stoplist does not apply');
    assert.equal(tidyQuery('one two three four five six seven eight', 'songs'), 'one two three four five six seven eight');
});
