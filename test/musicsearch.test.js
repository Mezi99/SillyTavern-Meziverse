import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSearchUrl,
    friendlySearchError,
    isLowValueResult,
    preferredDuration,
    toResults,
} from '../src/musicsearch.js';

/* ---------- preferredDuration ---------- */

test('a long-form request asks for a long video, anything else a track', () => {
    for (const query of ['rain one hour', 'extended mix', 'lofi loop', 'ambient soundscape mix', 'game OST', '1 hour fireplace']) {
        assert.equal(preferredDuration(query), 'long', query);
    }
    for (const query of ['moonlight sonata', 'billie holiday - strange fruit', 'calm piano', '']) {
        assert.equal(preferredDuration(query), 'medium', query);
    }
    assert.equal(preferredDuration(undefined), 'medium');
});

/* ---------- buildSearchUrl ---------- */

test('the search asks for embeddable videos only and keeps the noise out', () => {
    const url = new URL(buildSearchUrl('rain on tin roof', 'KEY123'));
    const params = url.searchParams;

    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/search');
    assert.equal(params.get('type'), 'video');
    assert.equal(params.get('videoEmbeddable'), 'true');
    assert.equal(params.get('key'), 'KEY123');
    assert.match(params.get('q'), /rain on tin roof/);
    assert.match(params.get('q'), /-shorts/);
    assert.match(params.get('q'), /-tiktok/);
    assert.match(params.get('q'), /-meme/);
});

test('the duration rides only when one is asked for', () => {
    assert.equal(new URL(buildSearchUrl('q', 'k')).searchParams.get('videoDuration'), null);
    assert.equal(new URL(buildSearchUrl('q', 'k', { duration: 'long' })).searchParams.get('videoDuration'), 'long');
    assert.equal(new URL(buildSearchUrl('q', 'k', { duration: 'medium' })).searchParams.get('videoDuration'), 'medium');
});

test('more is fetched than shown, and the limit stays sane', () => {
    const params = new URL(buildSearchUrl('q', 'k', { limit: 5 })).searchParams;
    assert.equal(params.get('maxResults'), '20');

    // A nonsense limit falls back to the default of 5 (over-fetched to 20).
    assert.equal(new URL(buildSearchUrl('q', 'k', { limit: 0 })).searchParams.get('maxResults'), '20');
    assert.equal(new URL(buildSearchUrl('q', 'k', { limit: 3 })).searchParams.get('maxResults'), '12');
    assert.equal(new URL(buildSearchUrl('q', 'k', { limit: 99 })).searchParams.get('maxResults'), '25');
});

/* ---------- toResults / isLowValueResult ---------- */

const item = (videoId, title, channel) => ({
    id: { videoId },
    snippet: { title, channelTitle: channel, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` } } },
});

test('search items become playable results with decoded names', () => {
    const results = toResults([
        item('dQw4w9WgXcQ', 'Rick Astley &amp; Friends &quot;Live&quot;', 'RickAstleyVEVO'),
    ]);

    assert.deepEqual(results, [{
        videoId: 'dQw4w9WgXcQ',
        title: 'Rick Astley & Friends "Live"',
        channel: 'RickAstleyVEVO',
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
    }]);
});

test('shorts, memes and reactions never reach the player', () => {
    const results = toResults([
        item('aaaaaaaaaaa', 'Rain ambience 1 hour', 'CalmChannel'),
        item('bbbbbbbbbbb', 'rain shorts #shorts', 'SomeShorts'),
        item('ccccccccccc', 'rain be like', 'MemeLord'),
        item('ddddddddddd', 'I react to rain', 'ReactChannel'),
        item('eeeeeeeeeee', 'funny rain moments compilation', 'CompChannel'),
    ]);

    assert.deepEqual(results.map(result => result.videoId), ['aaaaaaaaaaa']);
    assert.equal(isLowValueResult({ title: 'totally fine', channel: 'A Good Orchestra' }), false);
});

test('duplicates fold away and junk items are skipped', () => {
    const results = toResults([
        item('aaaaaaaaaaa', 'First', 'One'),
        item('aaaaaaaaaaa', 'First again', 'One'),
        { id: {}, snippet: {} },
        null,
        item('bbbbbbbbbbb', 'Second', 'Two'),
    ]);

    assert.deepEqual(results.map(result => result.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('the filter can be stood down on purpose', () => {
    const results = toResults([item('bbbbbbbbbbb', 'rain shorts', 'SomeShorts')], { allowLowValue: true });
    assert.equal(results.length, 1);
});

/* ---------- friendlySearchError ---------- */

const apiError = (reason, message) => JSON.stringify({
    error: { message, errors: [{ reason }] },
});

test('every refusal names the fix', () => {
    assert.match(
        friendlySearchError(403, apiError('accessNotConfigured', 'YouTube Data API has not been used')),
        /enable/i,
    );
    assert.match(
        friendlySearchError(400, apiError('keyInvalid', 'API key not valid'),
        ), /invalid/i);
    assert.match(
        friendlySearchError(403, apiError('keyExpired', 'expired')),
        /expired/i,
    );
    assert.match(
        friendlySearchError(403, apiError('quotaExceeded', 'quota')),
        /quota/i,
    );
    // The referrer guidance is the mirror of a server proxy's: a browser
    // fetch pins its referrer, so the fix is allowing THIS address.
    assert.match(
        friendlySearchError(403, apiError('ipRefererBlocked', 'Request is missing a valid referrer')),
        /referr?ers?/i,
    );
    assert.match(friendlySearchError(500, '<html>boom</html>'), /500/);
});
