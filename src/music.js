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
import { buildSearchUrl, buildVideosUrl, dropUnembeddable, friendlySearchError, preferredDuration, toResults } from './musicsearch.js';
import { initMusicDj, musicDjArrived, musicDjFreshPick, resetMusicDjPacing } from './musicdj.js';

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
    panelOpen: false,
    videoOpen: false,
    candidates: null,
    candidateAt: 0,
};

const NARROW = 760;
const STAGE_W = 320;

let uiIsOpen = () => true;
let widget = null;
let stage = null;
let els = {};
let player = null;
let ytApiPromise = null;
let lastHandled = null;
let drag = null;
let retryArmed = true;

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
    153: 'The owner of that video blocks embedded playback here.',
};

function onPlayerError(code) {
    const message = PLAYER_ERRORS[code] ?? 'This video cannot play here.';
    console.warn(`${LOG} embed error ${code} for ${state.videoId ?? '(none)'}`);

    // A transient failure earns one fresh instance - that has settled
    // born-broken players before. A blocked video is blocked in any
    // instance, so it goes straight to the candidates below.
    if (errorClass(code) === 'transient' && retryArmed && state.videoId) {
        retryArmed = false;
        rebuildPlayer(state.videoId);
        return;
    }

    // Blocked or gone: fall through to the next search candidate before
    // saying anything - only the last one speaks.
    if (state.candidates && state.candidateAt + 1 < state.candidates.length) {
        advanceCandidate();
        return;
    }

    state.error = message;
    state.playing = false;
    state.panelOpen = true;
    render();
    notify(message, 'warning');
}

/** Steps to the next search candidate - its own title, channel and all. */
function advanceCandidate() {
    state.candidateAt += 1;
    const next = state.candidates[state.candidateAt];
    retryArmed = true;
    state.videoId = next.videoId;
    state.title = next.title ?? '';
    state.channel = next.channel ?? '';
    render();
    rebuildPlayer(next.videoId);
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
function playRequest(text, { mood = null, rotate = false } = {}) {
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
        searchAndPlay(ref.query, { mood, rotate });
        return;
    }

    state.pending = null;
    state.mood = mood;
    state.videoId = ref.id;
    state.title = '';
    state.channel = '';
    state.error = null;
    state.candidates = null;
    state.candidateAt = 0;
    retryArmed = true;
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

/** The playable candidates for a query: filtered, deduped, cached. */
async function searchVideos(query) {
    const hit = searchCache.get(query);
    if (hit) return hit;

    const key = musicKey();
    const limit = 5;

    const preferred = await searchFetch(buildSearchUrl(query, key, { limit, duration: preferredDuration(query) }));
    let results = toResults(preferred.items);
    if (!results.length) {
        // The long-form pass came back empty; a plain track may still fit.
        const fallback = await searchFetch(buildSearchUrl(query, key, { limit }));
        results = toResults(fallback.items);
    }
    results = results.slice(0, limit);
    results = await verifyEmbeddable(results);

    if (searchCache.size >= SEARCH_CACHE_MAX) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(query, results);
    return results;
}

/**
 * Drops candidates the API now reports unembeddable before any embed frame
 * is loaded - one cheap call (1 quota unit against the search's 100). A
 * check that fails changes nothing: the player's own fallback through the
 * candidates is the safety net.
 */
async function verifyEmbeddable(results) {
    if (!results.length) return results;
    try {
        const data = await searchFetch(buildVideosUrl(results.map(result => result.videoId), musicKey()));
        const statuses = new Map((data.items ?? []).map(item => [item.id, item?.status?.embeddable]));
        return dropUnembeddable(results, statuses);
    } catch (error) {
        console.warn(`${LOG} the embeddable check changed nothing`, error);
        return results;
    }
}

/** Searches a named song and plays the best candidate. */
async function searchAndPlay(query, { mood = null, rotate = false } = {}) {
    state.searching = true;
    state.pending = query;
    state.mood = mood;
    state.error = null;
    render();

    try {
        const results = await searchVideos(query);
        if (!results.length) {
            state.error = `Nothing playable found for \u201c${query}\u201d.`;
            state.panelOpen = true;
            notify(state.error, 'warning');
            return;
        }

        state.pending = null;
        state.candidates = results;
        // A rotating pick skips what plays now and what played recently -
        // the next candidate carries the same mood instead of repeating it.
        state.candidateAt = rotate ? rotateIndex(results, [state.videoId, ...recentIds]) : 0;
        const pick = results[state.candidateAt];
        state.videoId = pick.videoId;
        state.title = pick.title;
        state.channel = pick.channel;
        retryArmed = true;
        render();

        await playById(pick.videoId);
    } catch (error) {
        state.error = error instanceof Error ? error.message : 'YouTube search failed.';
        state.panelOpen = true;
        render();
        notify(state.error, 'warning');
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
 * @param {{isOpen?:() => boolean}} [parts] the scene's open-state gate
 */
export function initMusic({ isOpen } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;

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
}

/** Re-reads the settings the widget shows - called when a switch flips. */
export function refreshMusic() {
    if (!musicOn()) musicUiClosed();
    render();
}

/* ---------- the widget ---------- */

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

const WIDGET_HTML = `
<div class="mz-music-head" data-mz-music-head>
    <button class="mz-music-art" type="button" title="Music player" aria-label="Music player" data-mz-music="toggle-panel">
        <img class="mz-music-thumb" alt="" hidden>
        ${svg('music')}
    </button>
    <button class="mz-music-title" type="button" data-mz-music="toggle-panel">
        <b data-mz-music="title">No track</b>
        <small data-mz-music="sub">Paste a link or name a song</small>
    </button>
    <button class="mz-ibtn" type="button" title="Play" aria-label="Play" data-mz-music="playpause">${svg('play')}</button>
    <button class="mz-ibtn" type="button" title="Stop" aria-label="Stop" data-mz-music="stop">${svg('stop')}</button>
    <button class="mz-ibtn mz-music-more" type="button" title="Player panel" aria-label="Player panel" data-mz-music="toggle-panel">${svg('chevdown')}</button>
    <button class="mz-ibtn" type="button" title="Undock" aria-label="Undock the player" data-mz-music="dock">${svg('undock')}</button>
</div>
<div class="mz-music-body" data-mz-music-body hidden>
    <a class="mz-btn-ghost mz-music-watch" data-mz-music-watch href="#" target="_blank" rel="noreferrer noopener" hidden>Watch on YouTube</a>
    <div class="mz-music-row">
        <input class="mz-select mz-music-input" data-mz-music="input" placeholder="YouTube link, video ID, or song to find" aria-label="YouTube link, video ID, or song to find">
        <button class="mz-btn-ghost" type="button" data-mz-music="load">Play</button>
    </div>
    <div class="mz-music-row">
        <button class="mz-ibtn" type="button" title="Mute" aria-label="Mute" data-mz-music="mute">${svg('vol')}</button>
        <input class="mz-music-vol" type="range" min="0" max="100" step="1" data-mz-music="volume" aria-label="Volume">
        <button class="mz-btn-ghost" type="button" data-mz-music="video">Video</button>
        <button class="mz-btn-ghost" type="button" title="Ask the Music DJ for a different pick" data-mz-music="dj" hidden>Fresh pick</button>
    </div>
</div>`;

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
        head: widget.querySelector('[data-mz-music-head]'),
        body: widget.querySelector('[data-mz-music-body]'),
        thumb: widget.querySelector('.mz-music-thumb'),
        note: widget.querySelector('.mz-music-art .ico'),
        title: widget.querySelector('[data-mz-music="title"]'),
        sub: widget.querySelector('[data-mz-music="sub"]'),
        playpause: widget.querySelector('[data-mz-music="playpause"]'),
        mute: widget.querySelector('[data-mz-music="mute"]'),
        dock: widget.querySelector('[data-mz-music="dock"]'),
        volume: widget.querySelector('[data-mz-music="volume"]'),
        input: widget.querySelector('[data-mz-music="input"]'),
        dj: widget.querySelector('[data-mz-music="dj"]'),
        watch: widget.querySelector('[data-mz-music-watch]'),
        embed: stage.querySelector('.mz-music-embed'),
    };

    wireWidget();
    render();
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

    els.input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const text = els.input.value;
        if (text.trim()) playRequest(text);
    });

    // A thumbnail that never lands falls back to the note glyph.
    els.thumb.addEventListener('error', () => {
        els.thumb.hidden = true;
        if (els.note) els.note.hidden = false;
    });

    wireDrag();
}

/* The undocked card is dragged by its head - never by its buttons. */
function wireDrag() {
    els.head.addEventListener('pointerdown', event => {
        if (!isUndocked() || event.target.closest('button, input, a')) return;
        const rect = widget.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        els.head.setPointerCapture(event.pointerId);
        widget.classList.add('is-dragging');
    });

    els.head.addEventListener('pointermove', event => {
        if (!drag) return;
        const x = clamp(event.clientX - drag.dx, 8, window.innerWidth - widget.offsetWidth - 8);
        const y = clamp(event.clientY - drag.dy, 8, window.innerHeight - widget.offsetHeight - 8);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
        positionStage();
    });

    const endDrag = () => {
        if (!drag) return;
        drag = null;
        widget.classList.remove('is-dragging');
        settings().musicPos = {
            x: parseFloat(widget.style.left) || 0,
            y: parseFloat(widget.style.top) || 0,
        };
        saveSettings();
    };

    els.head.addEventListener('pointerup', endDrag);
    els.head.addEventListener('pointercancel', endDrag);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The card floats only on wide screens: a narrow one re-docks the pill at
 * once rather than let the card cover the story.
 */
function isUndocked() {
    return settings().musicDocked === false && window.innerWidth >= NARROW;
}

/** The stage sits under the widget, clamped - above it at the bottom edge. */
function positionStage() {
    if (!widget || !stage || stage.hidden) return;

    const rect = widget.getBoundingClientRect();
    const width = STAGE_W;
    const height = Math.round(width * 9 / 16);
    const left = clamp(rect.right - width, 8, window.innerWidth - width - 8);
    const below = rect.bottom + 8;
    const top = below + height + 8 <= window.innerHeight
        ? below
        : clamp(rect.top - height - 8, 8, window.innerHeight - height - 8);

    stage.style.left = `${left}px`;
    stage.style.top = `${top}px`;
}

/** The widget, told the truth about every piece of state it carries. */
function render() {
    if (!widget) return;

    const on = musicOn();
    const undocked = isUndocked();
    const live = !!state.videoId;

    widget.hidden = !on;
    widget.classList.toggle('is-undocked', undocked);
    widget.classList.toggle('is-open', undocked || state.panelOpen);
    widget.classList.toggle('is-playing', state.playing);
    widget.classList.toggle('is-live', live);

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

    els.body.hidden = !(undocked || state.panelOpen);

    els.title.textContent = state.error
        ?? (state.searching ? 'Searching\u2026' : (state.title || (live ? 'Loading\u2026' : 'No track')));
    els.sub.textContent = state.pending
        ? (musicKey()
            ? `\u201c${state.pending}\u201d`
            : `Wants: \u201c${state.pending}\u201d \u00b7 add an API key to play named songs`)
        : (state.channel
            || (state.mood ? `Mood: ${state.mood}` : (live ? '' : 'Paste a link or name a song')));

    const thumb = els.thumb;
    if (live) {
        const src = thumbnailUrl(state.videoId);
        if (thumb.getAttribute('src') !== src) thumb.src = src;
        thumb.hidden = false;
        if (els.note) els.note.hidden = true;
    } else {
        thumb.hidden = true;
        if (els.note) els.note.hidden = false;
    }

    els.playpause.innerHTML = state.playing ? svg('pause') : svg('play');
    els.playpause.title = state.playing ? 'Pause' : 'Play';
    els.playpause.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');

    const muted = settings().musicMuted === true;
    els.mute.innerHTML = muted ? svg('mute') : svg('vol');
    els.mute.title = muted ? 'Unmute' : 'Mute';
    els.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');

    els.dock.innerHTML = undocked ? svg('dock') : svg('undock');
    els.dock.title = undocked ? 'Dock the player' : 'Undock';
    els.dock.setAttribute('aria-label', undocked ? 'Dock the player' : 'Undock the player');

    els.volume.value = String(clampVolume(settings().musicVolume));
    // Fresh pick is the manual trigger: it lives wherever a search can run,
    // the Music DJ switch (the auto watcher) notwithstanding.
    els.dj.hidden = !musicKey();

    // The escape hatch: a blocked or gone video is still one click away.
    if (live) {
        els.watch.href = `https://www.youtube.com/watch?v=${state.videoId}`;
        els.watch.hidden = !state.error;
    } else {
        els.watch.hidden = true;
    }

    // The stage renders whenever a track exists - an embed created inside a
    // `display:none` box fails exactly like a blocked video, so the clip
    // hides the audio-only stage visually and never with `hidden`.
    stage.hidden = !on || !live;
    stage.classList.toggle('is-open', state.videoOpen);
    stage.classList.toggle('is-audio', !state.videoOpen);
    positionStage();
}
