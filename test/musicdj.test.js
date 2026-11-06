import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_DJ_PROMPT,
    djQuestion,
    djStory,
    djSystemPrompt,
    parseDjAnswer,
} from '../src/musicdj.js';

/* ---------- djSystemPrompt ---------- */

test('the system prompt is the core with the answer format appended by code', () => {
    const prompt = djSystemPrompt({ core: 'You are a tiny DJ. Say little.' });

    assert.match(prompt, /^You are a tiny DJ\. Say little\./);
    assert.match(prompt, /"action":"play"\|"volume"\|"none"/);
    assert.match(prompt, /searchQuery/);
    // The core stays free of the format - no edit can break parsing.
    assert.doesNotMatch(DEFAULT_DJ_PROMPT, /"action"/);
});

test('an empty or missing core falls back to the default', () => {
    assert.equal(djSystemPrompt({ core: '   ' }), djSystemPrompt());
    assert.equal(djSystemPrompt(), djSystemPrompt({ core: DEFAULT_DJ_PROMPT }));
});

/* ---------- djStory ---------- */

test('the story is the last replies, tags stripped, from the end', () => {
    const story = djStory([
        { mes: 'An old turn.', is_user: false },
        { mes: 'You walk in. <scene location="The Docks" /> The rain eases.', is_user: false },
        { mes: 'A user line.', is_user: true },
        { mes: '<speech character="Mara" tone="warm">There you are.</speech> <ledger><standing>Mara 2</standing></ledger>', is_user: false },
    ]);

    // The last two replies - the old turn is beyond the window.
    assert.match(story, /You walk in\./);
    assert.match(story, /The rain eases\./);
    assert.match(story, /There you are\./);
    assert.doesNotMatch(story, /An old turn|scene|ledger|speech|Mara 2/);

    assert.equal(
        djStory([{ mes: 'One.', is_user: false }, { mes: 'Two.', is_user: false }], { turns: 1 }),
        'Two.',
    );
});

test('the story is capped from the end, where the mood is', () => {
    const long = 'quiet '.repeat(500);
    const story = djStory([{ mes: `start ${long} end`, is_user: false }], { maxChars: 50 });

    assert.equal(story.length, 50);
    assert.match(story, /end$/);
});

test('an empty chat reads as nothing at all', () => {
    assert.equal(djStory([]), '');
});

/* ---------- djQuestion ---------- */

test('the question names what plays, the story, and a forced pick only when forced', () => {
    const calm = djQuestion({ story: 'Rain on the roof.', playing: { title: 'Blue in Green', channel: 'Miles Davis' } });
    assert.match(calm, /CURRENTLY PLAYING: Blue in Green - Miles Davis/);
    assert.match(calm, /LATEST STORY:\nRain on the roof\./);
    assert.doesNotMatch(calm, /FORCED/);

    const forced = djQuestion({ story: 'Rain.', forceFreshPick: true });
    assert.match(forced, /CURRENTLY PLAYING: nothing/);
    assert.match(forced, /FORCED FRESH PICK/);
});

/* ---------- parseDjAnswer ---------- */

test('a clean intent parses as written', () => {
    assert.deepEqual(
        parseDjAnswer('{"action":"play","mood":"tender","searchQuery":"warm jazz piano","volume":35}'),
        { action: 'play', mood: 'tender', searchQuery: 'warm jazz piano', volume: 35 },
    );
});

test('code fences and chatter around the JSON are tolerated', () => {
    const intent = parseDjAnswer('Sure! Here you go:\n```json\n{"action":"volume","mood":"","searchQuery":null,"volume":80}\n```\nEnjoy.');
    assert.deepEqual(intent, { action: 'volume', mood: null, searchQuery: null, volume: 80 });
});

test('an unreadable answer is none - the DJ failing never stops the music', () => {
    assert.deepEqual(parseDjAnswer('I think the scene is lovely'), { action: 'none', mood: null, searchQuery: null, volume: null });
    assert.deepEqual(parseDjAnswer(''), { action: 'none', mood: null, searchQuery: null, volume: null });
    assert.deepEqual(parseDjAnswer(null), { action: 'none', mood: null, searchQuery: null, volume: null });
    assert.deepEqual(parseDjAnswer('[1,2,3]'), { action: 'none', mood: null, searchQuery: null, volume: null });
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
