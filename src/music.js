/**
 * The music player: the scene's soundtrack, played from YouTube.
 *
 * The player and the two ways to start it: pasting a YouTube link or video
 * ID into the player, and a `<music>` tag in a reply asking for one. A named
 * song - a search phrase - plays too, through the user's own YouTube Data
 * API key (`musicsearch.js` filters the results to what can embed); without
 * a key the request is remembered and shown, never played blind. Automatic
 * mood-based picks - the Music DJ - are the next phase.
 *
 * The player rides the master switch: with the scene closed, requests are
 * ignored and whatever is playing pauses. SillyTavern is touched only through
 * the seam (`st.js`), and the audio is an embedded YouTube player.
 *
 * Pure: the request read (`parseVideoRef`, `readMusicTag`, `thumbnailUrl`,
 * `clampVolume`) and the search read (`musicsearch.js`) have no DOM and no
 * side effects. The widget below is the only thing that renders.
 */

import { chatMessages, on } from './st.js';
import { musicAutoOn, musicDjOn, musicKey, musicOn, musicPickMode, saveSettings, settings } from './settings.js';
import { notify } from './notify.js';
import { parseTags } from './tags.js';
import { buildSearchUrl, buildVideosUrl, dropUnplayable, friendlySearchError, preferredDuration, rankResults, toResults } from './musicsearch.js';
import { initMusicDj, musicDjArrived, musicDjFreshPick, resetMusicDjPacing } from './musicdj.js';
import { generateOn } from './connections.js';

const LOG = '[Meziverse music]';

/* ---------- the pure read ---------- */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What a request holds: a video to play directly (a link or an id), or a
 * search phrase - which only the Music DJ's search can turn into a video.
 *
 * @param {string} text
 * @returns {{kind:'video', id:string}|{kind:'query', query:string}|{kind:'empty'}}
 */
export function parseVideoRef(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) return { kind: 'empty' };

    // A bare id is only trusted when it also carries one character no plain
    // word uses - "description" is eleven letters and a query.
    if (VIDEO_ID.test(raw) && /[^A-Za-z]/.test(raw)) return { kind: 'video', id: raw };

    const id = videoIdFromUrl(raw);
    if (id) return { kind: 'video', id };

    return { kind: 'query', query: raw };
}

/** The video id a YouTube URL points at, or null when it points at none. */
function videoIdFromUrl(text) {
    let url;
    try {
        url = new URL(SCHEME.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');

    if (host === 'youtu.be') {
        const [id] = url.pathname.split('/').filter(Boolean);
        return id && VIDEO_ID.test(id) ? id : null;
    }

    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

    const v = url.searchParams.get('v') ?? '';
    if (VIDEO_ID.test(v)) return v;

    const [kind, id] = url.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live', 'v'].includes(kind) && id && VIDEO_ID.test(id)) return id;
    return null;
}

/** The stable thumbnail YouTube serves for a video, no key needed. */
export function thumbnailUrl(id) {
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

/**
 * The last complete `<music>` tag of a message - the request in effect.
 * The body is the request; `query` / `src` / `url` attributes say the same
 * thing, and `mood` rides along for display only.
 *
 * @param {string} mes
 * @returns {{query:string, mood:string|null}|null}
 */
export function readMusicTag(mes) {
    const tags = parseTags(typeof mes === 'string' ? mes : '');
    const tag = [...tags].reverse().find(candidate => candidate.name === 'music' && candidate.closed);
    if (!tag) return null;

    const body = typeof tag.body === 'string' ? tag.body.trim() : '';
    const attr = (tag.attrs.query || tag.attrs.src || tag.attrs.url || '').trim();
    const query = attr || body;
    if (!query) return null;

    const mood = typeof tag.attrs.mood === 'string' ? tag.attrs.mood.trim() : '';
    return { query, mood: mood || null };
}

/** A volume the player can use: a whole number from 0 to 100. */
export function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * How a player error is handled. A transient failure earns one fresh
 * instance - that has settled born-broken players before - while a blocked
 * or gone video never will: no rebuild can unblock it, so the next
 * candidate is the only cure. Unknown codes count as blocked: reaching for
 * the next candidate is never wrong.
 */
export function errorClass(code) {
    return Number(code) === 5 ? 'transient' : 'blocked';
}

/** Video-specific refusals: this upload is gone or blocks embeds, remember it. */
export function isBlockedVideoError(code) {
    return [100, 101, 105, 150].includes(Number(code));
}

/** A configuration refusal: the videos are not the problem. */
export function isConfigError(code) {
    return Number(code) === 153;
}

/** Dedupe newest-first and keep the 200 most recent blocked ids. */
export function trimBlockedIds(ids) {
    return [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))].slice(0, 200);
}

const MAX_ATTEMPTS = 6;
const CONFIG_MESSAGE = 'YouTube refuses embeds from this address (error 153). Check that SillyTavern is opened as http://localhost or https.';
let blockedIds = null;

/** The session's blocked ids, hydrated once from the saved setting. */
function blockedSet() {
    if (!blockedIds) blockedIds = new Set(trimBlockedIds(settings().musicBlocked));
    return blockedIds;
}

function rememberBlocked(id) {
    if (!id || blockedSet().has(id)) return;
    const list = trimBlockedIds([id, ...blockedSet()]);
    blockedIds = new Set(list);
    settings().musicBlocked = list;
    saveSettings();
}

/* The browser's region, read once. A bare language (`en`) names no region;
   `el-GR` (or `zh-Hans-CN`) does. The internal override wins when present. */
let browserRegion;
function musicRegion() {
    const override = settings().musicRegion;
    if (/^[A-Za-z]{2}$/.test(String(override ?? ''))) return String(override).toUpperCase();
    if (browserRegion === undefined) {
        const parts = String(typeof navigator !== 'undefined' ? navigator.language ?? '' : '').split('-');
        browserRegion = parts.slice(1).find(part => /^[A-Za-z]{2}$/.test(part))?.toUpperCase() ?? null;
    }
    return browserRegion;
}

/** One line per pick's first play and every failure - how the ranks get tuned. */
function logAttempt({ videoId, channel, error = null }) {
    const licensed = state.details?.get?.(videoId)?.contentDetails?.licensedContent;
    console.info(`${LOG} attempt`, {
        videoId: videoId ?? null,
        channel: channel ?? '',
        mode: musicPickMode(),
        licensed: licensed === undefined ? null : licensed,
        error,
    });
}

/**
 * The candidate to play under rotation: the first one neither playing now
 * nor among the tracks just heard, so a fresh pick is never a repeat. With
 * nowhere fresh left, the first candidate stands.
 *
 * @param {Array<{videoId:string}>} results
 * @param {Array<string>} [skipIds]
 */
export function rotateIndex(results, skipIds = []) {
    const list = Array.isArray(results) ? results : [];
    const skip = new Set(skipIds);
    const at = list.findIndex(result => !skip.has(result?.videoId));
    return at >= 0 ? at : 0;
}

/* ---------- the player state ---------- */

const state = {
    videoId: null,
    title: '',
    channel: '',
    mood: null,
    pending: null,
    error: null,
    playing: false,
    searching: false,
    picking: false,
    panelOpen: false,
    videoOpen: false,
    candidates: null,
    candidateAt: 0,
    details: null,
    plan: null,
    cur: 0,
    dur: 0,
};

const NARROW = 760;

let uiIsOpen = () => true;
let onPickChange = null;
let widget = null;
let stage = null;
let els = {};
let player = null;
let ytApiPromise = null;
let lastHandled = null;
let drag = null;
let retryArmed = true;
let seekTimer = null;

/* The tracks heard this session - a rotating pick never returns to one. */
const RECENT_MAX = 5;
const recentIds = [];

function rememberPlayed(id) {
    if (!id) return;
    const at = recentIds.indexOf(id);
    if (at >= 0) recentIds.splice(at, 1);
    recentIds.unshift(id);
    if (recentIds.length > RECENT_MAX) recentIds.pop();
}

/* ---------- the YouTube IFrame API, loaded once ---------- */

function loadYouTubeApi() {
    const w = window;
    if (w.YT?.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;

    ytApiPromise = new Promise(resolve => {
        const previous = w.onYouTubeIframeAPIReady;
        w.onYouTubeIframeAPIReady = () => {
            previous?.();
            resolve();
        };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
    });
    return ytApiPromise;
}

/* ---------- playback ---------- */

/**
 * SillyTavern serves its pages with `Referrer-Policy: no-referrer`, and every
 * iframe inherits it - YouTube rejects embeds that arrive without a referrer
 * (every video, error 150, while thumbnail and metadata still load fine).
 * The official embed snippet pins the policy on the iframe; the IFrame API
 * builds its own, so we pin it on the one it made - synchronously, before
 * its navigation task runs - beside the official `allow` list.
 */
function pinEmbed(instance) {
    const frame = instance?.getIframe?.();
    if (!frame) return;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    frame.allowFullscreen = true;
}

async function playById(id) {
    await loadYouTubeApi();

    if (!player) {
        // First play: the embed is created with the video already in it.
        els.embed.innerHTML = '<div class="mz-music-embed"></div>';
        player = new window.YT.Player(els.embed.firstElementChild, {
            width: '100%',
            height: '100%',
            videoId: id,
            // Privacy-enhanced mode: youtube-nocookie.com sets no cookies
            // until the listener interacts - which also silences most of
            // the cross-site cookie noise Firefox logs for youtube.com
            // frames on every load.
            host: 'https://www.youtube-nocookie.com',
            // No YouTube chrome: the widget is the control surface.
            playerVars: {
                autoplay: 1,
                playsinline: 1,
                modestbranding: 1,
                rel: 0,
                controls: 0,
                origin: window.location.origin,
            },
            events: {
                onReady: () => {
                    applyVolume();
                    render();
                },
                onStateChange: event => onPlayerState(event.data),
                onError: event => onPlayerError(event.data),
            },
        });
        pinEmbed(player);
    } else {
        player.loadVideoById(id);
        player.playVideo();
    }

    applyVolume();
}

function onPlayerState(code) {
    const PLAYING = 1;
    state.playing = code === PLAYING;
    if (state.playing) {
        retryArmed = true;
        rememberPlayed(state.videoId);
    }

    try {
        const data = player?.getVideoData?.();
        if (data?.title) {
            state.title = data.title;
            state.channel = data.author ?? '';
        }
    } catch {
        /* the embed answers when it answers */
    }

    render();
}

const PLAYER_ERRORS = {
    2: 'YouTube does not understand that video reference.',
    5: 'YouTube refused playback here - the stream would not load.',
    100: 'That video is gone or private.',
    101: 'The owner of that video blocks embedded playback.',
    105: 'That video is gone or private.',
    150: 'The owner of that video blocks embedded playback.',
    153: CONFIG_MESSAGE,
};

function onPlayerError(code) {
    const id = state.videoId ?? null;
    logAttempt({ videoId: id, channel: state.channel, error: Number(code) });
    console.warn(`${LOG} embed error ${code} for ${id ?? '(none)'}`);

    if (state.plan) state.plan.lastError = Number(code);

    // 153 is the embedder's fault, not the upload's. One try is fair; a
    // second different video failing the same way stops the whole cycle.
    if (isConfigError(code)) {
        if (!state.plan || (state.plan.lastConfigId && state.plan.lastConfigId !== id)) {
            stopPick(CONFIG_MESSAGE);
            return;
        }
        if (state.plan) state.plan.lastConfigId = id;
        void advanceCandidate();
        return;
    }
    if (state.plan) state.plan.lastConfigId = null;

    // A video-specific refusal is learned, so the same search never puts it
    // first again. A transient stream failure is not the video's fault.
    if (isBlockedVideoError(code)) rememberBlocked(id);

    // A transient failure earns one fresh instance - that has settled
    // born-broken players before. The rebuild keeps the same video and the
    // same place in the plan.
    if (errorClass(code) === 'transient' && retryArmed && id) {
        retryArmed = false;
        rebuildPlayer(id);
        return;
    }

    if (state.plan) {
        void advanceCandidate();
        return;
    }

    stopPick(PLAYER_ERRORS[code] ?? 'This video cannot play here.');
}

/** Ends a pick with one message and the escape-hatch link still on screen. */
function stopPick(message) {
    state.plan = null;
    state.candidates = null;
    state.details = new Map();
    state.candidateAt = 0;
    state.error = message;
    state.playing = false;
    state.searching = false;
    state.panelOpen = true;
    render();
    notify(message, 'warning');
}

/**
 * The next attempt: the next candidate of this query, then the next query's
 * candidates, until a playable one starts or the pick is out of attempts.
 * The iframe is reused throughout - only a null player builds a new one.
 */
async function advanceCandidate() {
    const plan = state.plan;
    if (!plan) return;

    while (plan.attempts < MAX_ATTEMPTS) {
        const next = (state.candidates ?? [])[state.candidateAt + 1];
        if (next) {
            state.candidateAt += 1;
            await playCandidate(next, { plan });
            return;
        }

        const query = plan.queries[plan.queryIndex + 1];
        if (!query) break;
        const pick = await loadQuery(plan.queryIndex + 1, plan.rotate);
        if (state.plan !== plan) return;
        if (pick) {
            await playCandidate(pick, { firstForQuery: true, plan });
            return;
        }
    }

    const message = plan.lastError === 153 ? CONFIG_MESSAGE
        : (PLAYER_ERRORS[plan.lastError] ?? `Nothing playable found for \u201c${plan.queries[0]}\u201d.`);
    stopPick(message);
}

/** Plays one already-chosen candidate, counted against this pick's cap. */
async function playCandidate(pick, { firstForQuery = false, plan = null } = {}) {
    if (!pick || !state.plan || (plan && state.plan !== plan)) return;
    const first = state.plan.attempts === 0;

    state.plan.attempts += 1;
    state.pending = null;
    state.videoId = pick.videoId;
    state.title = pick.title ?? '';
    state.channel = pick.channel ?? '';
    state.cur = 0;
    state.dur = 0;
    state.error = null;
    retryArmed = true;
    if (first || firstForQuery) logAttempt({ videoId: pick.videoId, channel: pick.channel });
    render();

    try {
        await playById(pick.videoId);
    } catch (error) {
        console.warn(`${LOG} the embed failed`, error);
    }
}

/** Tears the embed down and plays the same video in a fresh one, once. */
function rebuildPlayer(id) {
    try {
        player?.destroy?.();
    } catch {
        /* the embed answers when it answers */
    }
    player = null;
    render();

    playById(id).catch(error => {
        console.warn(`${LOG} the embed failed`, error);
    });
}

function applyVolume() {
    if (!player?.setVolume) return;
    player.setVolume(clampVolume(settings().musicVolume));
    if (settings().musicMuted === true) player.mute?.();
    else player.unMute?.();
}

/**
 * Plays a request - a link or id at once, a named song through search. This
 * is where every way in meets: the story's `<music>` tag, the player's own
 * input, and the Music DJ. `rotate` is the DJ's: a repeated pick is never
 * the track already playing.
 */
function playRequest(text, { mood = null, rotate = false, alternates = [] } = {}) {
    if (!musicOn()) return;

    const ref = parseVideoRef(text);
    if (ref.kind === 'empty') return;

    if (ref.kind === 'query') {
        if (!musicKey()) {
            state.pending = ref.query;
            state.mood = mood;
            render();
            notify(`\u201c${ref.query}\u201d \u2014 song search needs a YouTube Data API key (Settings \u25b8 Features \u25b8 Music).`, 'info');
            return;
        }
        searchAndPlay(ref.query, { mood, rotate, alternates });
        return;
    }

    state.pending = null;
    state.mood = mood;
    state.videoId = ref.id;
    state.title = '';
    state.channel = '';
    state.error = null;
    state.plan = null;
    state.candidates = null;
    state.details = new Map();
    state.candidateAt = 0;
    state.cur = 0;
    state.dur = 0;
    retryArmed = true;
    logAttempt({ videoId: ref.id, channel: '' });
    render();

    playById(ref.id).catch(error => {
        console.warn(`${LOG} the embed failed`, error);
    });
}

/* ---------- song search ---------- */

/* One session's answers, so a repeated request costs no quota. */
const searchCache = new Map();
const SEARCH_CACHE_MAX = 30;

/**
 * One API call. The page's `Referrer-Policy: no-referrer` (SillyTavern's
 * default) is inherited by fetches - which would break every
 * referrer-restricted key - so the referrer is pinned here, exactly like
 * the embed's.
 */
async function searchFetch(url) {
    const res = await fetch(url, { referrerPolicy: 'strict-origin-when-cross-origin' });
    const body = await res.text();
    if (!res.ok) throw new Error(friendlySearchError(res.status, body));
    try {
        return JSON.parse(body);
    } catch {
        throw new Error('YouTube search answered with something unreadable.');
    }
}

/** The primary query plus up to two distinct, non-empty backups. */
function searchQueries(query, alternates) {
    const seen = new Set([query.toLowerCase()]);
    const queries = [query];
    for (const value of (Array.isArray(alternates) ? alternates : [])) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        queries.push(text);
        if (queries.length === 3) break;
    }
    return queries;
}

/** A cached answer is still filtered on every read: a block is learned late. */
function readCache(query) {
    const hit = searchCache.get(query);
    if (!hit) return null;
    return {
        results: dropUnplayable(hit.results, hit.details, {
            region: musicRegion(), mode: musicPickMode(), blockedIds: blockedSet(),
        }),
        details: hit.details,
    };
}

/**
 * The verified candidates for a query: filtered, ranked, deduped, cached.
 * The whole fetched pool is checked in one call before the best eight are
 * kept, so a few refusals cannot leave a pick short of candidates.
 */
async function searchVideos(query) {
    const cached = readCache(query);
    if (cached) return cached;

    const key = musicKey();
    const limit = 5;
    const mode = musicPickMode();
    const region = musicRegion();
    const options = { limit, duration: preferredDuration(query), mode, region };

    const preferred = await searchFetch(buildSearchUrl(query, key, options));
    let results = toResults(preferred.items);
    if (!results.length && mode === 'songs') {
        // The Music category was too narrow; a plain search may find the song.
        results = toResults((await searchFetch(buildSearchUrl(query, key, { ...options, mode: 'orchestra' }))).items);
    }
    results = results.slice(0, 25);
    const verified = await verifyPlayable(results, query, { mode, region });

    if (searchCache.size >= SEARCH_CACHE_MAX) {
        searchCache.delete(searchCache.keys().next().value);
    }
    const entry = { results: verified.results, details: verified.details };
    searchCache.set(query, entry);
    return readCache(query) ?? entry;
}

/**
 * One cheap details call (1 quota unit against the search's 100) checks
 * every candidate before any embed frame is loaded. A check that fails
 * changes nothing: the player's own fallback through the candidates is the
 * safety net.
 */
async function verifyPlayable(results, query, { mode, region }) {
    const details = new Map();
    if (!results.length) return { results, details };
    try {
        const data = await searchFetch(buildVideosUrl(results.map(result => result.videoId), musicKey()));
        for (const item of data.items ?? []) {
            if (item?.id) details.set(item.id, item);
        }
        const playable = dropUnplayable(results, details, { region, mode, blockedIds: blockedSet() });
        return { results: rankResults(playable, details, { mode, query }), details };
    } catch (error) {
        console.warn(`${LOG} the playability check changed nothing`, error);
        return {
            results: results.filter(result => !blockedSet().has(result.videoId)).slice(0, 8),
            details,
        };
    }
}

/**
 * Points the plan at one query's best candidate. An empty answer is not an
 * error: it is the signal to spend the next alternate.
 */
async function loadQuery(index, rotate) {
    const plan = state.plan;
    if (!plan) return null;
    const query = plan.queries[index];
    plan.queryIndex = index;
    state.pending = query;
    render();

    const { results, details } = await searchVideos(query);
    if (state.plan !== plan) return null;
    state.candidates = results;
    state.details = details;
    state.candidateAt = rotate ? rotateIndex(results, [state.videoId, ...recentIds]) : 0;
    state.pending = null;
    return state.candidates[state.candidateAt] ?? null;
}

/** Searches a named song and plays the best candidate, then its backups. */
async function searchAndPlay(query, { mood = null, rotate = false, alternates = [] } = {}) {
    const plan = {
        queries: searchQueries(query, alternates),
        queryIndex: 0,
        attempts: 0,
        lastError: null,
        lastConfigId: null,
        rotate: !!rotate,
    };
    state.searching = true;
    state.pending = query;
    state.mood = mood;
    state.error = null;
    state.plan = plan;
    state.candidates = null;
    state.details = new Map();
    state.candidateAt = 0;
    render();

    try {
        for (let index = 0; index < plan.queries.length; index += 1) {
            const pick = await loadQuery(index, plan.rotate);
            if (state.plan !== plan) return;
            if (pick) {
                await playCandidate(pick, { firstForQuery: index > 0, plan });
                return;
            }
        }
        stopPick(`Nothing playable found for \u201c${query}\u201d.`);
    } catch (error) {
        stopPick(error instanceof Error ? error.message : 'YouTube search failed.');
    } finally {
        state.searching = false;
        render();
    }
}

/** Turns the volume and remembers it - the DJ's volume intents land here. */
function setVolume(value) {
    settings().musicVolume = clampVolume(value);
    applyVolume();
    saveSettings();
    render();
}

/* ---------- the read of new turns ---------- */

/**
 * Scans the reply that just landed for a `<music>` request. True when one
 * was found - played or held - so the DJ leaves the reply alone.
 */
function scanNewTurn() {
    const messages = chatMessages();
    const message = messages[messages.length - 1];
    if (!message || message.is_user) return false;

    const request = readMusicTag(message.mes);
    if (!request) return false;

    // One reply cues once: a re-run of the same turn never restarts the
    // track, but the same song in a new reply is a new cue.
    const key = `${message.send_date ?? messages.length - 1}::${request.query}`;
    if (key === lastHandled) return true;
    lastHandled = key;

    playRequest(request.query, { mood: request.mood });
    return true;
}

/**
 * Wires the player to the story: every finished reply is scanned for a
 * `<music>` tag, and a chat change forgets what was handled. The master
 * switch gates it all - closed or never opened, nothing is asked and
 * nothing plays.
 *
 * @param {{isOpen?:() => boolean, onPickChange?:() => void}} [parts] the scene's open-state gate and the settings-sheet sync
 */
export function initMusic({ isOpen, onPickChange: pickChange } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;
    if (typeof pickChange === 'function') onPickChange = pickChange;

    // The DJ is its own watcher - switch, pace, prompt and call - reaching
    // the player only through this controller. `enabled` is the floor (the
    // player and the key: a pick the app cannot search cannot play);
    // `auto` is the watcher's own switch. Fresh pick needs only the floor,
    // so a manual pick is always one tap away - the brush beside the
    // background watcher's own switch.
    initMusicDj({
        isOpen,
        controller: {
            enabled: () => musicOn() && !!musicKey(),
            auto: () => musicDjOn(),
            everyN: () => Number(settings().musicDjEveryN) || 1,
            promptCore: () => settings().musicDjPrompt,
            pickMode: () => musicPickMode(),
            current: () => ({ title: state.title, channel: state.channel, mood: state.mood }),
            play: (query, options) => playRequest(query, { ...options, rotate: true }),
            setVolume,
            // The loader: while a DJ call is in flight the player says
            // "Selecting track..." itself - in the widget, never a toast.
            picking: on => {
                state.picking = !!on;
                render();
            },
            // The one ride for the DJ's calls: whatever connection the
            // Music Agent's section on the Connections tab has chosen.
            ask: request => generateOn('musicAgent', request),
        },
    });

    const arrived = () => {
        if (!uiIsOpen() || !musicOn()) return;
        // An explicit `<music>` request owns its reply - the DJ never
        // overrules the story's own cue.
        const cued = musicAutoOn() && scanNewTurn();
        if (!cued) musicDjArrived();
    };

    on('GENERATION_ENDED', arrived);
    on('GENERATION_STOPPED', arrived);
    on('GROUP_WRAPPER_FINISHED', arrived);
    on('CHAT_CHANGED', () => {
        lastHandled = null;
        resetMusicDjPacing();
    });

    // The settings sheet may start from a saved pick style: let it sync the
    // player once, and keep both faces in step from then on.
    onPickChange?.();

    window.addEventListener('resize', () => {
        if (widget && !widget.hidden) render();
    });
}

/** The scene opened: the player shows its state again and stays paused. */
export function musicUiOpened() {
    render();
}

/** The scene closed: the master switch turns off and the music stops. */
export function musicUiClosed() {
    try {
        player?.pauseVideo?.();
    } catch {
        /* the embed answers when it answers */
    }
    state.playing = false;
    syncSeekTimer();
}

/** Re-reads the settings the widget shows - called when a switch flips. */
export function refreshMusic() {
    if (!musicOn()) musicUiClosed();
    render();
}

/* ---------- the widget ---------- */

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

const WIDGET_HTML = `
<div class="mz-music-pill">
    <button class="mz-music-art" type="button" data-mz-music="toggle-panel" aria-label="Music player">
        <img class="mz-music-thumb" alt="" hidden>
        ${svg('music')}
    </button>
    <button class="mz-music-ticker" type="button" data-mz-music="toggle-panel"><span class="mz-music-ticker-in" data-mz-music="ticker">No track</span></button>
    <button class="mz-ibtn" type="button" data-mz-music="playpause" data-mz-playbtn></button>
    <button class="mz-ibtn mz-music-more" type="button" title="Player panel" aria-label="Player panel" data-mz-music="toggle-panel">${svg('chevdown')}</button>
    <button class="mz-ibtn" type="button" data-mz-music="dock" data-mz-dockbtn></button>
</div>
<section class="mz-music-card" aria-label="Music player">
    <div class="mz-music-ambient" aria-hidden="true"><img alt="" hidden></div>
    <header class="mz-music-grip" data-mz-music-grip tabindex="0" role="group" aria-label="Move the player. Arrow keys nudge it.">
        <span class="mz-music-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="mz-music-status"><span class="mz-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span data-mz-music="status">Nothing playing</span></span>
        <span class="mz-music-wintools">
            <button class="mz-ibtn mz-music-minibtn" type="button" title="Shrink" aria-label="Shrink the player" data-mz-music="mini">${svg('chevup')}</button>
            <button class="mz-ibtn" type="button" data-mz-music="dock" data-mz-dockbtn></button>
        </span>
    </header>
    <div class="mz-music-now">
        <span class="mz-music-art"><img class="mz-music-thumb" alt="" hidden>${svg('music')}</span>
        <div class="mz-music-meta">
            <b class="mz-music-name" data-mz-music="title">No track</b>
            <span class="mz-music-by" data-mz-music="by"></span>
        </div>
        <div class="mz-music-nowtools">
            <button class="mz-ibtn mz-music-miniplay" type="button" data-mz-music="playpause" data-mz-playbtn></button>
            <button class="mz-ibtn" type="button" title="Expand" aria-label="Expand the player" data-mz-music="mini">${svg('chevdown')}</button>
        </div>
    </div>
    <div class="mz-music-seek">
        <span data-mz-music="cur">0:00</span>
        <input class="mz-music-range mz-music-scrub" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek" data-mz-music="scrub">
        <span data-mz-music="dur">0:00</span>
    </div>
    <div class="mz-music-transport">
        <div class="mz-music-vols">
            <button class="mz-ibtn" type="button" data-mz-music="mute" data-mz-mutebtn></button>
            <input class="mz-music-range mz-music-vol" type="range" min="0" max="100" step="1" aria-label="Volume" data-mz-music="volume">
        </div>
        <div class="mz-music-mid">
            <button class="mz-ibtn" type="button" title="Stop" aria-label="Stop" data-mz-music="stop">${svg('stop')}</button>
            <button class="mz-music-play" type="button" data-mz-music="playpause" data-mz-playbtn></button>
            <button class="mz-ibtn mz-music-fresh" type="button" title="Fresh pick: ask the Music DJ for something different" aria-label="Fresh pick" data-mz-music="dj">${svg('fresh')}</button>
        </div>
        <div class="mz-music-end">
            <button class="mz-ibtn" type="button" title="Show video" aria-label="Show video" aria-pressed="false" data-mz-music="video">${svg('video')}</button>
        </div>
    </div>
    <div class="mz-music-pick" role="group" aria-label="Pick style">
        <span class="mz-music-pick-label">Pick style</span>
        <div class="mz-seg">
            <button type="button" data-mz-music="pick" data-pick="orchestra" aria-pressed="false" title="Instrumental scores that fit the story's world">Orchestra</button>
            <button type="button" data-mz-music="pick" data-pick="songs" aria-pressed="false" title="Real songs the characters might know">Songs</button>
        </div>
    </div>
    <label class="mz-music-find">${svg('search')}<input type="text" data-mz-music="input" placeholder="Paste a link or name a song" aria-label="YouTube link, video ID, or song to find"><button class="mz-ibtn mz-music-go" type="button" title="Play" aria-label="Play" data-mz-music="load" disabled>${svg('send')}</button></label>
    <p class="mz-music-note" data-mz-music="note" hidden></p>
</section>`;

/**
 * Builds the player where the scene keeps it: a pill in the header that can
 * undock into a draggable card on wide screens, and one fixed stage behind
 * the video panel. The stage is never `display:none` while audio plays -
 * the embed is clipped away instead, so the music never stops.
 *
 * @param {{slot:Element, frame:Element}} parts where the pill docks and floats
 */
export function mountMusic({ slot, frame }) {
    if (widget || !slot || !frame) return;

    widget = document.createElement('aside');
    widget.className = 'mz-music';
    widget.setAttribute('aria-label', 'Music player');
    widget.hidden = true;
    widget.innerHTML = WIDGET_HTML;

    stage = document.createElement('div');
    stage.className = 'mz-music-stage';
    stage.hidden = true;
    stage.innerHTML = '<div class="mz-music-embed"></div>';

    slot.appendChild(widget);
    frame.appendChild(stage);

    els = {
        input: widget.querySelector('[data-mz-music="input"]'),
        volume: widget.querySelector('[data-mz-music="volume"]'),
        scrub: widget.querySelector('[data-mz-music="scrub"]'),
        ticker: widget.querySelector('[data-mz-music="ticker"]'),
        pick: widget.querySelector('.mz-music-pick'),
        embed: stage.querySelector('.mz-music-embed'),
    };

    wireWidget();
    render();
}

/**
 * Every element answering to a widget name: the pill, the card and the mini
 * row share them, so one update reaches all faces at once.
 */
function q(name) {
    return Array.from(widget.querySelectorAll(`[data-mz-music="${name}"]`));
}

function one(name) {
    return q(name)[0] ?? null;
}

function wireWidget() {
    widget.addEventListener('click', event => {
        const target = event.target.closest('[data-mz-music]');
        if (!target) return;

        switch (target.dataset.mzMusic) {
            case 'toggle-panel':
                state.panelOpen = !state.panelOpen;
                render();
                break;
            case 'playpause':
                if (!state.videoId) {
                    state.panelOpen = true;
                    render();
                    els.input?.focus();
                    break;
                }
                state.playing = !state.playing;
                try {
                    if (state.playing) player?.playVideo?.();
                    else player?.pauseVideo?.();
                } catch {
                    /* the embed answers when it answers */
                }
                render();
                break;
            case 'stop':
                state.playing = false;
                try {
                    player?.pauseVideo?.();
                    player?.seekTo?.(0, false);
                } catch {
                    /* the embed answers when it answers */
                }
                render();
                break;
            case 'dock':
                settings().musicDocked = settings().musicDocked === false;
                saveSettings();
                render();
                break;
            case 'mini':
                settings().musicMini = settings().musicMini !== true;
                saveSettings();
                render();
                break;
            case 'mute':
                settings().musicMuted = settings().musicMuted !== true;
                applyVolume();
                saveSettings();
                render();
                break;
            case 'video':
                state.videoOpen = !state.videoOpen;
                render();
                break;
            case 'dj':
                musicDjFreshPick().catch(error => {
                    console.warn(`${LOG} the pick failed`, error);
                });
                break;
            case 'pick':
                settings().musicPick = target.dataset.pick === 'songs' ? 'songs' : 'orchestra';
                saveSettings();
                render();
                onPickChange?.();
                break;
            case 'load': {
                const text = els.input?.value ?? '';
                if (text.trim()) playRequest(text);
                break;
            }
            default:
                break;
        }
    });

    els.volume.addEventListener('input', () => {
        setVolume(els.volume.value);
    });

    els.scrub.addEventListener('input', () => {
        if (!state.dur) return;
        try {
            player?.seekTo?.(state.dur * (els.scrub.value / 1000), true);
        } catch {
            /* the embed answers when it answers */
        }
    });

    els.input.addEventListener('input', () => {
        const load = one('load');
        if (load) load.disabled = !els.input.value.trim();
    });

    els.input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const text = els.input.value;
        if (text.trim()) playRequest(text);
    });

    // A thumbnail that never lands falls back to the music glyph beside it
    // (capture: the error event does not bubble).
    widget.addEventListener('error', event => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement)) return;
        img.hidden = true;
        const icon = img.parentElement?.querySelector('.ico');
        if (icon) icon.style.display = '';
    }, true);

    wireDrag();
}

/* The whole undocked card is the handle - only controls are exempt. */
function wireDrag() {
    widget.addEventListener('pointerdown', event => {
        if (!isUndocked() || event.button > 0 || event.target.closest('button, input, a, label')) return;
        const rect = widget.getBoundingClientRect();
        drag = {
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
        };
        // Capture on the widget: a release outside the window still ends it.
        widget.setPointerCapture(event.pointerId);
    });

    widget.addEventListener('pointermove', event => {
        if (!drag) return;
        // A 4px threshold keeps clicks clean - a press on the title stays one.
        if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            widget.classList.add('is-dragging');
            widget.classList.remove('is-snapping');
        }
        const x = clamp(event.clientX - drag.dx, 8, window.innerWidth - widget.offsetWidth - 8);
        const y = clamp(event.clientY - drag.dy, 8, window.innerHeight - widget.offsetHeight - 8);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
        positionStage();
    });

    const endDrag = () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        widget.classList.remove('is-dragging');
        if (!moved) return;

        // A soft magnet to the 12px gutter when the card lands near an edge.
        const MARGIN = 12;
        const THRESHOLD = 28;
        const w = widget.offsetWidth;
        const h = widget.offsetHeight;
        const x = parseFloat(widget.style.left) || 0;
        const y = parseFloat(widget.style.top) || 0;
        const sx = x < MARGIN + THRESHOLD ? MARGIN
            : x > window.innerWidth - w - MARGIN - THRESHOLD ? window.innerWidth - w - MARGIN
                : x;
        const sy = y < MARGIN + THRESHOLD ? MARGIN
            : y > window.innerHeight - h - MARGIN - THRESHOLD ? window.innerHeight - h - MARGIN
                : y;
        if (sx !== x || sy !== y) {
            widget.classList.add('is-snapping');
            widget.style.left = `${sx}px`;
            widget.style.top = `${sy}px`;
            setTimeout(() => {
                widget.classList.remove('is-snapping');
                positionStage();
            }, 200);
        }

        settings().musicPos = { x: sx, y: sy };
        saveSettings();
        positionStage();
    };

    widget.addEventListener('pointerup', endDrag);
    widget.addEventListener('pointercancel', endDrag);

    // Keyboard: the grip holds focus, arrows nudge (Shift for a longer step),
    // and a double-click on it shrinks the card out of the story's way.
    const grip = widget.querySelector('[data-mz-music-grip]');
    grip.addEventListener('keydown', event => {
        const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!dir || !isUndocked()) return;
        event.preventDefault();
        const step = event.shiftKey ? 48 : 12;
        const x = clamp((parseFloat(widget.style.left) || 0) + dir[0] * step, 8, window.innerWidth - widget.offsetWidth - 8);
        const y = clamp((parseFloat(widget.style.top) || 0) + dir[1] * step, 8, window.innerHeight - widget.offsetHeight - 8);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
        settings().musicPos = { x, y };
        saveSettings();
        positionStage();
    });

    grip.addEventListener('dblclick', event => {
        if (event.target.closest('button')) return;
        settings().musicMini = settings().musicMini !== true;
        saveSettings();
        render();
    });
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The card floats only on wide screens: a narrow one re-docks the pill at
 * once rather than let the card cover the story.
 */
function isUndocked() {
    return settings().musicDocked === false && window.innerWidth >= NARROW;
}

/**
 * The stage sits under the card at the card's own width - clamped, and above
 * the card when the bottom edge leaves no room. With the card closed the
 * stage keeps the spot it has: the audio never stops for a reposition.
 */
function positionStage() {
    if (!widget || !stage || stage.hidden) return;

    const card = widget.querySelector('.mz-music-card');
    const rect = card?.getBoundingClientRect();
    if (!rect?.width) return;

    const width = rect.width;
    const height = Math.round(width * 9 / 16);
    const left = clamp(rect.left, 8, window.innerWidth - width - 8);
    const below = rect.bottom + 8;
    const top = below + height + 8 <= window.innerHeight
        ? below
        : clamp(rect.top - height - 8, 8, window.innerHeight - height - 8);

    stage.style.width = `${width}px`;
    stage.style.left = `${left}px`;
    stage.style.top = `${top}px`;
}

/** Clock time as the seek row reads it: m:ss, or h:mm:ss past the hour. */
function fmtTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The seek row's own pulse: while the embed plays, its clock is read twice a
 * second and written to the row directly - never a full render. It stops the
 * moment the music does.
 */
function syncSeekTimer() {
    const want = !!player && state.playing;
    if (want && !seekTimer) seekTimer = setInterval(seekTick, 500);
    if (!want && seekTimer) {
        clearInterval(seekTimer);
        seekTimer = null;
    }
}

function seekTick() {
    try {
        state.cur = Number(player?.getCurrentTime?.()) || 0;
        state.dur = Number(player?.getDuration?.()) || 0;
    } catch {
        /* the embed answers when it answers */
        return;
    }

    q('cur').forEach(span => { span.textContent = fmtTime(state.cur); });
    q('dur').forEach(span => { span.textContent = fmtTime(state.dur); });
    const scrub = els.scrub;
    if (scrub) {
        scrub.value = String(state.dur ? Math.round(state.cur / state.dur * 1000) : 0);
        scrub.style.setProperty('--p', `${scrub.value / 10}%`);
    }
    widget?.classList.toggle('is-stream', !!state.videoId && !state.dur);
}

/** The widget, told the truth about every piece of state it carries. */
function render() {
    if (!widget) return;

    const on = musicOn();
    const undocked = isUndocked();
    const live = !!state.videoId;
    const playing = state.playing && live;
    const picking = state.picking;

    widget.hidden = !on;
    widget.classList.toggle('is-undocked', undocked);
    widget.classList.toggle('is-open', undocked || state.panelOpen);
    widget.classList.toggle('is-mini', undocked && settings().musicMini === true);
    widget.classList.toggle('is-playing', playing);
    widget.classList.toggle('is-live', live);
    widget.classList.toggle('is-stream', live && !state.dur);
    widget.classList.toggle('has-error', !!state.error);
    widget.classList.toggle('is-picking', picking);

    if (undocked) {
        // The saved spot, but never mid-drag: a buffering event landing
        // between pointer moves must not snap the card back.
        if (!drag) {
            const pos = settings().musicPos;
            const x = clamp(Number(pos?.x) || window.innerWidth - 380, 8, window.innerWidth - widget.offsetWidth - 8);
            const y = clamp(Number(pos?.y) || 80, 8, window.innerHeight - widget.offsetHeight - 8);
            widget.style.left = `${x}px`;
            widget.style.top = `${y}px`;
        }
    } else {
        widget.style.left = '';
        widget.style.top = '';
    }

    // The title is only ever the track - an error or a wait leaves it and
    // speaks through the note or the status line instead.
    const title = state.searching ? 'Searching\u2026'
        : picking ? 'Selecting track\u2026'
            : (state.title || (live ? 'Loading\u2026' : 'No track'));
    q('title').forEach(el => {
        el.textContent = title;
        el.title = state.title || '';
        el.classList.toggle('is-empty', !state.title);
    });

    const by = state.searching ? `\u201c${state.pending}\u201d`
        : picking ? ''
            : (state.title ? state.channel : (live ? '' : 'Paste a link or name a song'));
    q('by').forEach(el => { el.textContent = by; });

    // The status line reads the room: working, playing, or gone wrong.
    const status = state.error ? 'Could not play'
        : state.searching ? 'Finding a track'
            : picking ? 'Selecting track'
                : !live ? 'Nothing playing'
                    : playing ? 'Now playing' : 'Paused';
    q('status').forEach(el => { el.textContent = status; });

    const tk = els.ticker;
    if (tk) {
        tk.textContent = state.searching ? 'Searching\u2026'
            : picking ? 'Selecting track\u2026'
                : (state.title || 'No track');
        tk.title = state.title || '';
    }

    // Thumbnails and ambient: the track's own picture everywhere it shows.
    const src = live ? thumbnailUrl(state.videoId) : '';
    widget.querySelectorAll('.mz-music-thumb').forEach(img => {
        img.hidden = !live;
        if (live && img.getAttribute('src') !== src) img.src = src;
    });
    widget.querySelectorAll('.mz-music-art > .ico').forEach(icon => {
        icon.style.display = live ? 'none' : '';
    });
    const ambient = widget.querySelector('.mz-music-ambient img');
    if (ambient) {
        ambient.hidden = !live;
        if (live && ambient.getAttribute('src') !== src) ambient.src = src;
    }

    // Buttons: one name, every face.
    q('playpause').forEach(btn => {
        btn.innerHTML = playing ? svg('pause') : svg('play');
        btn.title = playing ? 'Pause' : 'Play';
        btn.setAttribute('aria-label', btn.title);
    });

    const muted = settings().musicMuted === true;
    q('mute').forEach(btn => {
        btn.innerHTML = muted ? svg('mute') : svg('vol');
        btn.title = muted ? 'Unmute' : 'Mute';
        btn.setAttribute('aria-label', btn.title);
    });

    q('dock').forEach(btn => {
        btn.innerHTML = undocked ? svg('dock') : svg('undock');
        btn.title = undocked ? 'Dock the player' : 'Undock';
        btn.setAttribute('aria-label', undocked ? 'Dock the player' : 'Undock the player');
    });

    // Fresh pick is the manual trigger: it lives wherever a search can run,
    // the Music DJ switch (the auto watcher) notwithstanding.
    const dj = one('dj');
    if (dj) dj.hidden = !musicKey();
    const pick = musicPickMode();
    q('pick').forEach(button => {
        const isOn = button.dataset.pick === pick;
        button.classList.toggle('is-on', isOn);
        button.setAttribute('aria-pressed', String(isOn));
    });
    if (els.pick) els.pick.hidden = !musicKey();
    const video = one('video');
    if (video) video.setAttribute('aria-pressed', String(state.videoOpen));

    // The seek row and the volume, with their filled parts.
    const scrub = els.scrub;
    if (scrub) {
        scrub.value = String(state.dur ? Math.round(state.cur / state.dur * 1000) : 0);
        scrub.style.setProperty('--p', `${scrub.value / 10}%`);
    }
    q('cur').forEach(el => { el.textContent = fmtTime(state.cur); });
    q('dur').forEach(el => { el.textContent = fmtTime(state.dur); });

    const vol = els.volume;
    if (vol) {
        vol.value = String(muted ? 0 : clampVolume(settings().musicVolume));
        vol.style.setProperty('--p', `${vol.value}%`);
    }

    // The note carries what went wrong or what is missing - the escape
    // hatch link beside a blocked video is the only button in it.
    const note = one('note');
    if (note) {
        if (state.error) {
            note.hidden = false;
            note.className = 'mz-music-note is-bad';
            note.innerHTML = `<span></span>${state.videoId ? `<a href="https://www.youtube.com/watch?v=${state.videoId}" target="_blank" rel="noreferrer noopener">Watch on YouTube</a>` : ''}`;
            note.firstChild.textContent = state.error;
        } else if (!musicKey() && state.pending) {
            note.hidden = false;
            note.className = 'mz-music-note';
            note.innerHTML = '<span></span>';
            note.firstChild.textContent = `\u201c${state.pending}\u201d \u2014 add a YouTube API key in Settings to play named songs.`;
        } else {
            note.hidden = true;
        }
    }

    // The pill's ticker glides only when the title does not fit in it.
    requestAnimationFrame(() => {
        if (!tk?.isConnected) return;
        const over = tk.scrollWidth - tk.clientWidth;
        tk.classList.toggle('is-long', over > 2);
        tk.style.setProperty('--mz-over', `${-(over + 4)}px`);
    });

    // The stage renders whenever a track exists - an embed created inside a
    // `display:none` box fails exactly like a blocked video, so the clip
    // hides the audio-only stage visually and never with `hidden`.
    stage.hidden = !on || !live;
    stage.classList.toggle('is-open', state.videoOpen);
    stage.classList.toggle('is-audio', !state.videoOpen);
    positionStage();

    syncSeekTimer();
}
