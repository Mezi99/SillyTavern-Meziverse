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
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

/* Noise a music search should never answer with. */
const QUERY_EXCLUSIONS = `-shorts -short -tiktok -meme -"be like"`;

const LOW_VALUE_RE =
    /(^|[\s#|:()[\]-])(shorts?|tiktok|tik\s*tok|memes?|be like|pov|react(?:ion)?s?|compilation|funny moments)(?=$|[\s#|:()[\]-])/i;

const LONG_FORM_RE =
    /\b(extended|one\s*hour|1\s*hour|hour(?:long)?|loop(?:able|ed)?|mix|ambient|ambience|soundtrack|ost|playlist)\b/i;

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
 * The search URL for one pass. The API's `videoEmbeddable` and
 * `videoSyndicated` filters keep out videos that cannot play off youtube.com.
 * The filter that rejects Shorts and memes is ours (the API has none), so more
 * is fetched than shown. A songs search starts in the Music category and
 * falls back to a plain search only if that pass comes back empty.
 *
 * @param {string} query
 * @param {string} key the YouTube Data API key
 * @param {{limit?:number, duration?:'long'|'medium', mode?:string, region?:string}} [options]
 */
export function buildSearchUrl(query, key, { limit = 5, duration, mode = 'orchestra', region } = {}) {
    const max = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
    const fetch = Math.max(max, Math.min(25, max * 4));

    const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        videoSyndicated: 'true',
        maxResults: String(fetch),
        q: `${typeof query === 'string' ? query.trim() : ''} ${QUERY_EXCLUSIONS}`,
        key: typeof key === 'string' ? key : '',
    });
    if (duration === 'long' || duration === 'medium') params.set('videoDuration', duration);
    if (/^[A-Za-z]{2}$/.test(String(region ?? ''))) params.set('regionCode', String(region).toUpperCase());
    if (mode === 'songs') params.set('videoCategoryId', '10');

    return `${SEARCH_URL}?${params}`;
}

/** A Shorts/meme/reaction title or channel - never a soundtrack. */
export function isLowValueResult(result) {
    return LOW_VALUE_RE.test(`${result?.title ?? ''} ${result?.channel ?? ''}`);
}

/**
 * The URL that checks candidates before they reach the player. The search
 * filters are honest but can go stale, so the whole pool is verified in one
 * cheap call (1 quota unit against the search's 100). `contentDetails` carries
 * duration, region restrictions, age rating and the licensed flag - all the
 * facts the player and the ranking need.
 *
 * @param {string[]} ids
 * @param {string} key the YouTube Data API key
 */
export function buildVideosUrl(ids, key) {
    const params = new URLSearchParams({
        part: 'status,contentDetails',
        id: (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 50).join(','),
        key: typeof key === 'string' ? key : '',
    });
    return `${VIDEOS_URL}?${params}`;
}

/** ISO 8601 duration (`PT#H#M#S`, `P#DT#H#M#S`) in seconds; null if unreadable. */
export function parseDuration(value) {
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(typeof value === 'string' ? value.trim() : '');
    if (!match || !match.slice(1).some(Boolean)) return null;
    const [, days, hours, minutes, seconds] = match;
    return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/**
 * The playable candidates: embeddable, public, processed, viewable here,
 * free of an age gate, long enough to be a track, and never a blocked id.
 * A video the details call never saw keeps its place - the player's own
 * fallback through the candidates is the safety net; missing fields on a
 * video that WAS seen are neutral too.
 *
 * @param {Array<{videoId:string}>} results
 * @param {Map<string, object>|Object<string, object>} details videos resource by id
 * @param {{region?:string, mode?:string, blockedIds?:Set<string>|string[]}} [options]
 */
export function dropUnplayable(results, details, { region, mode = 'orchestra', blockedIds = [] } = {}) {
    const list = Array.isArray(results) ? results : [];
    const map = details instanceof Map ? details : new Map(Object.entries(details ?? {}));
    const blocked = blockedIds instanceof Set ? blockedIds : new Set(Array.isArray(blockedIds) ? blockedIds : []);
    const knownRegion = /^[A-Za-z]{2}$/.test(String(region ?? '')) ? String(region).toUpperCase() : null;

    return list.filter(result => {
        const id = result?.videoId;
        if (!id || blocked.has(id)) return false;
        const detail = map.get(id);
        if (!detail) return true;

        const status = detail.status ?? {};
        const content = detail.contentDetails ?? {};
        if (status.embeddable === false) return false;
        if (status.privacyStatus && status.privacyStatus !== 'public') return false;
        if (status.uploadStatus && status.uploadStatus !== 'processed') return false;

        const restriction = content.regionRestriction;
        if (knownRegion && restriction) {
            if (Array.isArray(restriction.blocked) && restriction.blocked.includes(knownRegion)) return false;
            if (Array.isArray(restriction.allowed) && !restriction.allowed.includes(knownRegion)) return false;
        }
        if (content.contentRating?.ytRating === 'ytAgeRestricted') return false;

        const seconds = parseDuration(content.duration);
        if (seconds !== null) {
            if (seconds < 60) return false;
            if (mode === 'songs' && seconds > 4 * 3600) return false;
        }
        return true;
    });
}

const AUDIO_GOOD_RE = /official audio|audio only|\(audio\)/i;
const AUDIO_BAD_RE = /\b(?:live|cover|remix|karaoke|sped up|slowed|nightcore|8d|reverb|loop)\b/i;

/** Whether the query itself names the same word - the penalty is per word. */
function queryNames(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Best first, API order breaking ties, top 8. The weights are a first guess
 * at how YouTube uploads behave - the telemetry in the player is how they get
 * tuned. A `live` query wants live results, so the penalty stands down there.
 *
 * @param {Array<{videoId:string, title:string, channel:string}>} results
 * @param {Map<string, object>|Object<string, object>} details videos resource by id
 * @param {{mode?:string, query?:string}} [options]
 */
export function rankResults(results, details, { mode = 'orchestra', query = '' } = {}) {
    const list = Array.isArray(results) ? results : [];
    const map = details instanceof Map ? details : new Map(Object.entries(details ?? {}));
    const text = typeof query === 'string' ? query.toLowerCase() : '';

    return list
        .map((result, index) => {
            const content = map.get(result?.videoId)?.contentDetails ?? {};
            const title = String(result?.title ?? '');
            let score = 0;
            if (/- topic$/i.test(String(result?.channel ?? '').trim())) score += 2;
            if (AUDIO_GOOD_RE.test(title)) score += 1;
            const badWord = title.match(AUDIO_BAD_RE)?.[0];
            if (badWord && !queryNames(text, badWord)) score -= 2;
            if (mode === 'orchestra') {
                if (content.licensedContent === false) score += 1;
                const seconds = parseDuration(content.duration);
                if (seconds !== null && seconds > 15 * 60) score += 1;
            }
            return { result, index, score };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 8)
        .map(entry => entry.result);
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
