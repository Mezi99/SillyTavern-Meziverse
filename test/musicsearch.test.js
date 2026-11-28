import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSearchUrl,
    buildVideosUrl,
    dropUnplayable,
    friendlySearchError,
    isLowValueResult,
    parseDuration,
    preferredDuration,
    rankResults,
    toResults,
} from '../src/musicsearch.js';

/* ---------- preferredDuration ---------- */

test('a long-form request asks for a long video, anything else a track', () => {
    for (const query of ['rain one hour', 'extended mix', 'lofi loop', 'ambient soundscape mix', 'cyberpunk rain ambience', 'game OST', '1 hour fireplace']) {
        assert.equal(preferredDuration(query), 'long', query);
    }
    for (const query of ['moonlight sonata', 'billie holiday - strange fruit', 'calm piano', '']) {
        assert.equal(preferredDuration(query), 'medium', query);
    }
    assert.equal(preferredDuration(undefined), 'medium');
});

/* ---------- buildSearchUrl ---------- */

const searchParams = options => new URL(buildSearchUrl('rain on tin roof', 'KEY123', options)).searchParams;

test('the search asks for embeddable, syndicatable videos only and keeps the noise out', () => {
    const url = new URL(buildSearchUrl('rain on tin roof', 'KEY123'));
    const params = url.searchParams;

    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/search');
    assert.equal(params.get('type'), 'video');
    assert.equal(params.get('videoEmbeddable'), 'true');
    assert.equal(params.get('videoSyndicated'), 'true');
    assert.equal(params.get('key'), 'KEY123');
    assert.match(params.get('q'), /rain on tin roof/);
    assert.match(params.get('q'), /-shorts/);
    assert.match(params.get('q'), /-tiktok/);
    assert.match(params.get('q'), /-meme/);
});

test('a region rides only when one is actually known', () => {
    assert.equal(searchParams({ region: 'GR' }).get('regionCode'), 'GR');
    assert.equal(searchParams({ region: 'gr' }).get('regionCode'), 'GR');
    assert.equal(searchParams({ region: null }).get('regionCode'), null);
    assert.equal(searchParams({ region: '' }).get('regionCode'), null);
    assert.equal(searchParams({ region: 'el-GR' }).get('regionCode'), null, 'only a two-letter region is sent');
});

test('a songs search starts in the Music category; the others do not', () => {
    assert.equal(searchParams({ mode: 'songs' }).get('videoCategoryId'), '10');
    assert.equal(searchParams({ mode: 'orchestra' }).get('videoCategoryId'), null);
    assert.equal(searchParams().get('videoCategoryId'), null);
});

test('the duration rides only when one is asked for', () => {
    assert.equal(searchParams({}).get('videoDuration'), null);
    assert.equal(searchParams({ duration: 'long' }).get('videoDuration'), 'long');
    assert.equal(searchParams({ duration: 'medium' }).get('videoDuration'), 'medium');
});

test('more is fetched than shown, and the limit stays sane', () => {
    assert.equal(searchParams({ limit: 5 }).get('maxResults'), '20');

    // A nonsense limit falls back to the default of 5 (over-fetched to 20).
    assert.equal(searchParams({ limit: 0 }).get('maxResults'), '20');
    assert.equal(searchParams({ limit: 3 }).get('maxResults'), '12');
    assert.equal(searchParams({ limit: 99 }).get('maxResults'), '25');
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

/* ---------- buildVideosUrl ---------- */

test('the details URL checks every candidate with status and contentDetails', () => {
    const url = new URL(buildVideosUrl(['aaa', 'bbb', ''], 'KEY'));
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/videos');
    assert.equal(url.searchParams.get('part'), 'status,contentDetails');
    assert.equal(url.searchParams.get('id'), 'aaa,bbb');
    assert.equal(url.searchParams.get('key'), 'KEY');
});

/* ---------- parseDuration / dropUnplayable ---------- */

test('ISO 8601 durations become seconds; unreadable ones are null', () => {
    assert.equal(parseDuration('PT1H2M3S'), 3723);
    assert.equal(parseDuration('PT59S'), 59);
    assert.equal(parseDuration('P1DT2H'), 93600);
    assert.equal(parseDuration('PT'), null);
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration(undefined), null);
});

test('every refusal drops its video; unchecked and thin entries stand', () => {
    const ids = ['unembeddable', 'private', 'raw', 'blockedHere', 'notAllowed', 'age', 'short', 'blockedId', 'thin', 'unknown'];
    const results = ids.map(videoId => ({ videoId }));
    const details = new Map([
        ['unembeddable', { status: { embeddable: false } }],
        ['private', { status: { privacyStatus: 'private' } }],
        ['raw', { status: { uploadStatus: 'failed' } }],
        ['blockedHere', { contentDetails: { regionRestriction: { blocked: ['GR'] } } }],
        ['notAllowed', { contentDetails: { regionRestriction: { allowed: ['US'] } } }],
        ['age', { contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } }],
        ['short', { contentDetails: { duration: 'PT59S' } }],
        ['thin', {}],
    ]);

    assert.deepEqual(
        dropUnplayable(results, details, { region: 'GR', mode: 'orchestra', blockedIds: new Set(['blockedId']) }).map(result => result.videoId),
        ['thin', 'unknown'],
        'missing details and missing individual fields stay neutral; blocked ids never come back',
    );
    const unknownRegion = dropUnplayable(results, details, { region: null, mode: 'orchestra' }).map(result => result.videoId);
    assert.ok(unknownRegion.includes('blockedHere'), 'an unknown region stands down on region checks');
    assert.ok(unknownRegion.includes('notAllowed'));
    assert.deepEqual(dropUnplayable(null, details), []);
});

test('a very long video is only refused in songs mode', () => {
    const results = [{ videoId: 'long' }];
    const details = new Map([['long', { contentDetails: { duration: 'PT5H' } }]]);
    assert.deepEqual(dropUnplayable(results, details, { mode: 'orchestra' }), results);
    assert.deepEqual(dropUnplayable(results, details, { mode: 'songs' }), []);
});

/* ---------- rankResults ---------- */

const ranked = [
    { videoId: 'plain', title: 'Rain', channel: 'Channel' },
    { videoId: 'topic', title: 'Rain', channel: 'Rain - Topic' },
    { videoId: 'audio', title: 'Rain (official audio)', channel: 'Channel' },
    { videoId: 'live', title: 'Rain live', channel: 'Channel' },
    { videoId: 'cover', title: 'Rain cover', channel: 'Channel' },
];

test('Topic and official audio rise; live and cover sink unless asked for', () => {
    assert.deepEqual(rankResults(ranked, {}, { mode: 'songs', query: 'rain' }).map(result => result.videoId),
        ['topic', 'audio', 'plain', 'live', 'cover']);
    assert.deepEqual(rankResults(ranked, {}, { mode: 'songs', query: 'rain cover' }).map(result => result.videoId),
        ['topic', 'audio', 'plain', 'cover', 'live'], 'the word in the query stands the penalty down');
});

test('orchestra rewards unlicensed, long uploads; songs stays neutral', () => {
    const details = new Map([['plain', { contentDetails: { licensedContent: true, duration: 'PT3M' } }],
        ['bonus', { contentDetails: { licensedContent: false, duration: 'PT20M' } }]]);
    const results = [
        { videoId: 'plain', title: 'Rain', channel: 'Channel' },
        { videoId: 'bonus', title: 'Rain', channel: 'Channel' },
    ];
    assert.deepEqual(rankResults(results, details, { mode: 'orchestra', query: 'rain' }).map(result => result.videoId),
        ['bonus', 'plain']);
    assert.deepEqual(rankResults(results, details, { mode: 'songs', query: 'rain' }).map(result => result.videoId),
        ['plain', 'bonus'], 'licensedContent and duration do not bias a song pick');
});

test('ranking keeps only the best eight and breaks ties by API order', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ videoId: `v${i}`, title: 'Rain', channel: 'Channel' }));
    const rankedIds = rankResults(many, {}, { mode: 'orchestra', query: 'rain' }).map(result => result.videoId);
    assert.equal(rankedIds.length, 8);
    assert.deepEqual(rankedIds, many.slice(0, 8).map(result => result.videoId));
});
