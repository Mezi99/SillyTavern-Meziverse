/**
 * Song search: the YouTube Data API v3 read behind a story naming a song.
 *
 * Pure: query building, result filtering, error wording - no DOM, no fetch,
 * no SillyTavern. `music.js` does the fetching and the playing. The filtering
 * mirrors what a music search must reject (Shorts, memes, reactions) and what
 * to prefer (long-form, embeddable), so the player only ever receives results
 * that can actually play embedded.
 *
 * The key is the user's own free Google key, used from the browser. Two
 * consequences shape this file: a key can be restricted by HTTP referrer (so
 * the fetch must pin its referrer - see `searchFetch` in music.js), and the
 * errors must say exactly what to fix in the Google Cloud Console.
 */

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

/* Noise a music search should never answer with. */
const QUERY_EXCLUSIONS = `-shorts -short -tiktok -meme -"be like"`;

const LOW_VALUE_RE =
    /(^|[\s#|:()[\]-])(shorts?|tiktok|tik\s*tok|memes?|be like|pov|react(?:ion)?s?|compilation|funny moments)(?=$|[\s#|:()[\]-])/i;

const LONG_FORM_RE =
    /\b(extended|one\s*hour|1\s*hour|hour(?:long)?|loop(?:able|ed)?|mix|ambient|soundtrack|ost|playlist)\b/i;

/**
 * The duration a request asks for: a long-form request ("one hour", "mix",
 * "OST") keeps its promise, anything else is a plain track.
 *
 * @param {string} query
 * @returns {'long'|'medium'}
 */
export function preferredDuration(query) {
    return LONG_FORM_RE.test(typeof query === 'string' ? query : '') ? 'long' : 'medium';
}

/**
 * The search URL for one pass. The API's `videoEmbeddable` filter is the
 * whole point: a video that cannot embed cannot play here. The filter that
 * rejects Shorts and memes is ours (the API has none), so more is fetched
 * than shown. Omit `duration` for the fallback pass.
 *
 * @param {string} query
 * @param {string} key the YouTube Data API key
 * @param {{limit?:number, duration?:'long'|'medium'}} [options]
 */
export function buildSearchUrl(query, key, { limit = 5, duration } = {}) {
    const max = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
    const fetch = Math.max(max, Math.min(25, max * 4));

    const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        maxResults: String(fetch),
        q: `${typeof query === 'string' ? query.trim() : ''} ${QUERY_EXCLUSIONS}`,
        key: typeof key === 'string' ? key : '',
    });
    if (duration === 'long' || duration === 'medium') params.set('videoDuration', duration);

    return `${SEARCH_URL}?${params}`;
}

/** A Shorts/meme/reaction title or channel - never a soundtrack. */
export function isLowValueResult(result) {
    return LOW_VALUE_RE.test(`${result?.title ?? ''} ${result?.channel ?? ''}`);
}

/**
 * Search items to playable results: ids kept, names decoded, low-value
 * results dropped (unless asked otherwise), duplicates folded.
 *
 * @param {Array} items raw `items` from the search response
 * @param {{allowLowValue?:boolean}} [options]
 * @returns {Array<{videoId:string, title:string, channel:string, thumbnail:string|null}>}
 */
export function toResults(items, { allowLowValue = false } = {}) {
    const byId = new Map();

    for (const item of Array.isArray(items) ? items : []) {
        const videoId = item?.id?.videoId;
        if (!videoId) continue;

        const result = {
            videoId,
            title: decodeEntities(item?.snippet?.title ?? ''),
            channel: decodeEntities(item?.snippet?.channelTitle ?? ''),
            thumbnail: item?.snippet?.thumbnails?.medium?.url ?? null,
        };

        if (!allowLowValue && isLowValueResult(result)) continue;
        if (!byId.has(videoId)) byId.set(videoId, result);
    }

    return [...byId.values()];
}

const HTML_ENTITIES = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
};

function decodeEntities(str) {
    return String(str).replace(/&amp;|&quot;|&#39;|&lt;|&gt;/g, match => HTML_ENTITIES[match] ?? match);
}

/**
 * What to tell the user when the API says no - each answer names the fix.
 * Note the referrer guidance is the mirror image of a server-side proxy's:
 * searches run in the user's own browser, so a referrer-restricted key is
 * the RIGHT restriction here (and an IP-restricted one works from home).
 *
 * @param {number} status
 * @param {string} body the error response body
 */
export function friendlySearchError(status, body) {
    let reason = '';
    let message = '';
    try {
        const parsed = JSON.parse(body);
        reason = String(parsed?.error?.errors?.[0]?.reason ?? '').toLowerCase();
        message = String(parsed?.error?.message ?? '');
    } catch {
        /* a non-JSON body still has a story to tell below */
    }
    const blob = `${reason} ${message} ${body}`.toLowerCase();

    if (
        blob.includes('api keys are not supported')
        || reason === 'accessnotconfigured'
        || blob.includes('has not been used in project')
        || blob.includes('it is disabled')
    ) {
        return 'The YouTube Data API v3 is not enabled for this key\u2019s Google Cloud project. Open the API Library, enable \u201cYouTube Data API v3\u201d, wait a minute, and try again.';
    }
    if (reason === 'keyinvalid' || blob.includes('api key not valid')) {
        return 'This YouTube Data API key is invalid. Re-check the key saved in Settings \u25b8 Features \u25b8 Music.';
    }
    if (reason === 'keyexpired') {
        return 'This YouTube Data API key has expired. Create a new one in the Google Cloud Console.';
    }
    if (reason === 'iprefererblocked' || blob.includes('referer') || blob.includes('referrer')) {
        return 'This key\u2019s restrictions do not allow this SillyTavern address. Add it to the key\u2019s allowed HTTP referrers (for example http://localhost:8000/*), or set the restriction to your IP.';
    }
    if (reason === 'quotaexceeded' || reason === 'dailylimitexceeded' || blob.includes('quota')) {
        return 'YouTube Data API daily quota exceeded for this key. Try again tomorrow, or use a different key.';
    }
    return `YouTube search failed (${status}): ${message || String(body).slice(0, 160)}`;
}
