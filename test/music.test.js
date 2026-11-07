import test from 'node:test';
import assert from 'node:assert/strict';

import { clampVolume, errorClass, parseVideoRef, readMusicTag, rotateIndex, thumbnailUrl } from '../src/music.js';

test('a transient error earns one rebuild; a blocked one never does', () => {
    assert.equal(errorClass(5), 'transient', 'a stream that would not load may settle in a fresh instance');
    for (const code of [2, 100, 101, 105, 150, 153, 999]) {
        assert.equal(errorClass(code), 'blocked', `error ${code} goes to the next candidate`);
    }
});

test('rotation skips the track playing and the ones just heard', () => {
    const results = [{ videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' }];
    assert.equal(rotateIndex(results, ['a']), 1);
    assert.equal(rotateIndex(results, ['a', 'b']), 2);
    assert.equal(rotateIndex(results, ['a', 'b', 'c']), 0, 'nowhere fresh left: the first candidate stands');
    assert.equal(rotateIndex(results, []), 0);
    assert.equal(rotateIndex([], ['a']), 0, 'no candidates at all');
});

/* ---------- parseVideoRef ---------- */

test('an empty request is empty', () => {
    assert.deepEqual(parseVideoRef(''), { kind: 'empty' });
    assert.deepEqual(parseVideoRef('   '), { kind: 'empty' });
    assert.deepEqual(parseVideoRef(undefined), { kind: 'empty' });
});

test('a bare video id is a video - but only when it cannot be a word', () => {
    assert.deepEqual(parseVideoRef('dQw4w9WgXcQ'), { kind: 'video', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseVideoRef('ScMzIvxBSi4'), { kind: 'video', id: 'ScMzIvxBSi4' });

    // Eleven letters of English are a query, not an id.
    assert.deepEqual(parseVideoRef('description'), { kind: 'query', query: 'description' });
    assert.deepEqual(parseVideoRef('atmospheric'), { kind: 'query', query: 'atmospheric' });
});

test('every shape of YouTube URL resolves to its video', () => {
    const id = 'dQw4w9WgXcQ';

    for (const url of [
        `https://www.youtube.com/watch?v=${id}`,
        `http://youtube.com/watch?v=${id}&list=PL123`,
        `www.youtube.com/watch?v=${id}`,
        `youtube.com/watch?v=${id}`,
        `https://m.youtube.com/watch?v=${id}`,
        `https://music.youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}`,
        `youtu.be/${id}`,
        `https://youtu.be/${id}?t=42`,
        `https://www.youtube.com/shorts/${id}`,
        `https://www.youtube.com/embed/${id}`,
        `https://www.youtube.com/live/${id}`,
        `https://www.youtube-nocookie.com/embed/${id}`,
    ]) {
        assert.deepEqual(parseVideoRef(url), { kind: 'video', id }, url);
    }
});

test('a URL without a video falls to a query, and so does anything else', () => {
    assert.deepEqual(parseVideoRef('https://www.youtube.com/@somechannel'), {
        kind: 'query',
        query: 'https://www.youtube.com/@somechannel',
    });
    assert.deepEqual(parseVideoRef('calm rain on a tin roof'), {
        kind: 'query',
        query: 'calm rain on a tin roof',
    });
    assert.deepEqual(parseVideoRef('lofi.hip.hop'), { kind: 'query', query: 'lofi.hip.hop' });
});

test('a non-YouTube link is not a video', () => {
    assert.deepEqual(parseVideoRef('https://vimeo.com/12345'), {
        kind: 'query',
        query: 'https://vimeo.com/12345',
    });
});

/* ---------- readMusicTag ---------- */

test('a music tag takes its request from the body or the query attribute', () => {
    assert.deepEqual(readMusicTag('<music>dQw4w9WgXcQ</music>'), {
        query: 'dQw4w9WgXcQ',
        mood: null,
    });
    assert.deepEqual(readMusicTag('<music query="https://youtu.be/dQw4w9WgXcQ" />'), {
        query: 'https://youtu.be/dQw4w9WgXcQ',
        mood: null,
    });
    assert.deepEqual(readMusicTag('<music mood="tense" query="rain, piano" />'), {
        query: 'rain, piano',
        mood: 'tense',
    });
});

test('the last music tag of a reply is the request in effect', () => {
    const mes = 'Prose. <music>first</music> More. <music query="second" />';
    assert.deepEqual(readMusicTag(mes), { query: 'second', mood: null });
});

test('a reply without a music request reads as null', () => {
    assert.equal(readMusicTag('plain prose with <div>html</div> in it'), null);
    assert.equal(readMusicTag('<music></music>'), null);
    assert.equal(readMusicTag('<scene date="Day 1" />'), null);
    // A half tag is not a request yet.
    assert.equal(readMusicTag('tailing words <music>unfinished'), null);
});

test('a music request is never prose', () => {
    // The tag catalogue hides the request with its wrapper (tags.js), so
    // the parse here is what the player sees - the message's own scanner.
    const mes = 'The door opened. <music mood="warm">coffee shop jazz</music>';
    const request = readMusicTag(mes);
    assert.equal(request.query, 'coffee shop jazz');
    assert.equal(request.mood, 'warm');
});

/* ---------- thumbnailUrl and clampVolume ---------- */

test('the thumbnail is the stable YouTube art, no key', () => {
    assert.equal(thumbnailUrl('dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
});

test('a volume is a whole number from 0 to 100', () => {
    assert.equal(clampVolume(60), 60);
    assert.equal(clampVolume('35'), 35);
    assert.equal(clampVolume(-5), 0);
    assert.equal(clampVolume(140), 100);
    assert.equal(clampVolume(12.7), 13);
    assert.equal(clampVolume('loud'), 0);
    assert.equal(clampVolume(undefined), 0);
});
