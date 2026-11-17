/**
 * The map on screen: the minimap window and the full atlas window, both
 * drawing the same chart.
 *
 * The atlas is mapdata.js (pure); this file is its stage and its renderer.
 * The chart is generated from the atlas - territories as soft land, places as
 * picture pins, journeys as dotted legs with a mode glyph - and drawn as one
 * SVG string per surface. The minimap is a crop of that chart around the
 * story's place; the full window pans and zooms the same world and pairs it
 * with a text index and a place card. Nothing is stored but the window's
 * spot and the settings; selection speaks in stable keys, so a rebuild never
 * forgets or swaps a place.
 */

import {
    PIN_R,
    activeStamp,
    buildAtlas,
    deriveLegs,
    extractObservations,
    extractStampObservations,
    hashFold,
    layoutAtlas,
    travelMode,
    trailWalks,
    worldMatrix,
} from './mapdata.js';
import { recordSrc } from './backgrounds.js';
import { bgStore, chatMessages, currentChatId, on, personaName, saveTerrainRecord, terrainStore } from './st.js';
import { mapMiniOn, mapOn, saveSettings, settings } from './settings.js';
import { TERRAIN_QUALITY, createTerrain, deriveTerrainRecord, inkTint, mapInk, skyFor, validateTerrainRecord, weatherFx } from './terrain.js';

const LOG = '[Meziverse map]';

const NARROW = 760;
const EDGE = 10;
const MINI_W = 224;
const MINI_H = 150;

let uiIsOpen = () => false;
let frameEl = null;
let gotoTurn = null;
let widget = null;
let win = null;
let els = {};
let drag = null;
let miniSizing = false;
let winDrag = null;
let winSizing = false;
let resizeQueued = false;
let queued = false;

/* Derived state: the atlas and its legs are cached by a chat signature, the
   layout by (atlas, depth). Everything is thrown away and rebuilt - cheap,
   and never stale. */
let atlas = null;
let derived = null;
let layout = null;
let layoutDepth = null;
let lastSignature = null;
let lastChatId = null;
let selectedKey = null;
let visitsExpanded = false;
let trails = true;
let flagsShown = true;
let view = { tx: 0, ty: 0, s: 1, placed: false };
let lastFocus = null;

/* The deck: one vehicle's rooms, seen from inside. The world map shows the
   ship's icon and trail instead; entering the ship swaps the chart. */
let insideKey = null;
let deckLayout = null;
let insideBaseS = 1;
let lastSize = null;

/* The land under the chart: a shader canvas behind the SVG, decoration
   only - every hit-test stays on the map above it. The Flat look is
   today's chart, and the flat chart is also where the map lives whenever
   the land cannot draw (no WebGL, a lost context, the deck). */
let terrain = null;
let terrainCanvas = null;
let terrainStory = null;
let terrainRaf = 0;
let terrainQuality = -1;
let chartWalks = null;
let terrainT0 = performance.now();
let terrainDirty = true;
let terrainLastDraw = 0;
let lastViewChange = 0;
let idleTimer = 0;

/* The terrain record: the map's land as one small JSON per chat - derived
   by code from the watcher's own pictures and words, kept in the chat's
   metadata, free for the user to edit. A derived record follows the story
   as it grows; the moment a hand edits it (or Reseed), it is the user's
   until they ask for a fresh derivation. */
let terrainRecordPending = false;
let terrainDerivedSig = null;

/** The layout the chart is drawing right now: the deck when inside a ship. */
function activeLayout() {
    return insideKey && deckLayout ? deckLayout : layout;
}

/** The land is under the chart: true only where the shader draws. */
function terrainOn() {
    return !!terrain && !!terrainCanvas && settings().mapTerrain !== 'flat' && !insideKey;
}

/** The canvas draws for the land - and, over the flat chart, for the fog
    veil alone. */
function terrainLayerOn() {
    if (!terrain || !terrainCanvas || insideKey) return false;
    return settings().mapTerrain !== 'flat' || !!settings().mapTerrainFog;
}

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/* the alignment guard: ?mzmapdebug=1 draws red outlines over the land */
const ALIGN_DEBUG = new URLSearchParams(location.search).has('mzmapdebug');
const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const trunc = (value, max) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
};
const f1 = value => Math.round(value * 10) / 10;

/** Long names fold into two lines at the space nearest the middle, so labels
    stop colliding on a busy chart. */
function labelLines(name, max = 16) {
    const text = String(name ?? '');
    if (text.length <= max) return [text];
    const words = text.split(' ');
    if (words.length < 2) return [trunc(text, max)];
    let best = null;
    let bestDiff = Infinity;
    for (let i = 1; i < words.length; i += 1) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const diff = Math.abs(a.length - b.length);
        if (Math.max(a.length, b.length) <= max + 6 && diff < bestDiff) {
            best = [a, b];
            bestDiff = diff;
        }
    }
    return best || [trunc(text, max)];
}

const labelSvg = (name, y, max = 16) => labelLines(name, max)
    .map((line, i) => `<text class="mzc-pin-label" y="${f1(y + i * 11)}" text-anchor="middle">${esc(line)}</text>`)
    .join('');

/** The depth the chart shows: 2, 3 or 4 levels, or 99 for everything. */
function depthValue() {
    const depth = Number(settings().mapDepth);
    return [2, 3, 4, 99].includes(depth) ? depth : 4;
}

function depthLabel() {
    return depthValue() === 99 ? 'All' : String(depthValue());
}

/* ---------- the widget and the window shells ---------- */

const WIDGET_HTML = `
<div class="mz-map-head" data-mz-map-head>
    <button class="mz-map-art" type="button" title="Open the map" aria-label="Open the map" data-mz-map-open>${svg('map')}</button>
    <button class="mz-map-title" type="button" data-mz-map-open>
        <b data-mz-map-title>Map</b>
        <small data-mz-map-sub></small>
    </button>
    <button class="mz-ibtn mz-map-collapse" type="button" title="Minimap on/off" aria-label="Minimap on/off" data-mz-action="map-mini">${svg('collapse')}</button>
</div>
<div class="mz-map-mini" data-mz-map-mini>
    <div data-mz-map-minisvg style="position:absolute;inset:0"></div>
    <div class="mz-map-mini-zoom">
        <button type="button" title="Zoom in" aria-label="Zoom in" data-mz-mini-zoom="1">+</button>
        <button type="button" title="Zoom out" aria-label="Zoom out" data-mz-mini-zoom="-1">\u2212</button>
    </div>
    <span class="mz-map-mini-n" aria-hidden="true">N</span>
    <button class="mz-map-mini-open" type="button" title="Open the map" aria-label="Open the map" data-mz-map-open>${svg('expand')}</button>
    <div class="mz-map-mini-grip" data-mz-map-grip aria-hidden="true"></div>
</div>`;

const WIN_HTML = `
<header class="mz-mapwin-head">
    <span class="mz-mapwin-mark">${svg('map')}</span>
    <h2>Map</h2>
    <span class="mz-mapwin-sum" data-mz-map-sum></span>
    <div class="mz-mapwin-tools">
        <label class="mz-mapwin-search">${svg('search')}<input type="text" data-mz-map-find placeholder="Find a place" aria-label="Find a place"></label>
        <span class="mz-mapwin-lab">Detail</span>
        <div class="mz-step" role="group" aria-label="Map detail">
            <button type="button" data-mz-map-depth="-1" aria-label="Show fewer levels">\u2212</button>
            <span data-mz-map-depthv>All</span>
            <button type="button" data-mz-map-depth="1" aria-label="Show more levels">+</button>
        </div>
        <button class="mz-ibtn" type="button" title="Close map" aria-label="Close map" data-mz-map-close>${svg('close')}</button>
    </div>
</header>
<div class="mz-mapwin-body" data-mz-map-body>
    <nav class="mz-map-index" data-mz-map-index aria-label="Places"></nav>
    <div class="mz-map-stage" data-mz-map-stage>
        <div data-mz-map-chart style="position:absolute;inset:0"></div>
        <div class="mz-map-cart"><b data-mz-map-ctitle></b><small data-mz-map-csub></small></div>
        <div class="mz-map-tools">
            <div class="mz-map-seg" role="group" aria-label="Map look">
                <button type="button" aria-pressed="true" data-mz-map-look="ink">Terrain</button>
                <button type="button" aria-pressed="false" data-mz-map-look="flat">Flat</button>
            </div>
            <div class="mz-map-seg">
                <button type="button" aria-pressed="true" data-mz-map-layer="trails">${svg('m-route')}Journeys</button>
                <button type="button" aria-pressed="true" data-mz-map-layer="flags">Flags</button>
                <button type="button" aria-pressed="false" data-mz-map-layer="fog">Fog</button>
            </div>
            <div class="mz-map-seg is-round">
                <button type="button" title="Zoom out" aria-label="Zoom out" data-mz-map-zoom="-1">\u2212</button>
                <button type="button" title="Zoom in" aria-label="Zoom in" data-mz-map-zoom="1">+</button>
                <button type="button" title="Fit everything" aria-label="Fit everything" data-mz-map-fit>${svg('expand')}</button>
                <button type="button" title="Where the story is" aria-label="Go to where the story is" data-mz-map-now>${svg('m-target')}</button>
            </div>
        </div>
        <div class="mz-map-key" data-mz-map-key></div>
        <svg class="mz-map-compass" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-opacity=".35"/><path d="M24 6l4.2 18L24 42l-4.2-18z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M24 6l4.2 18H19.8z" fill="currentColor"/><text x="24" y="4.6" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" font-family="Inter,sans-serif">N</text></svg>
    </div>
    <aside class="mz-map-detail" data-mz-map-detail hidden></aside>
</div>
<div class="mz-mapwin-grip" data-mz-mapwin-grip aria-hidden="true"></div>`;

/* ---------- lifecycle ---------- */

/**
 * Wires the map to the story: every chat change and every settled reply
 * rebuilds the atlas. The master switch gates it all - with the scene
 * closed nothing is derived or drawn.
 *
 * @param {{isOpen?:() => boolean}} [parts] the scene's open-state gate
 */
export function initMap({ isOpen } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;

    const rebuild = () => {
        if (!uiIsOpen()) return;
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            refreshMap();
        });
    };

    on('CHAT_CHANGED', rebuild);
    on('CHAT_CREATED', rebuild);
    on('MESSAGE_EDITED', rebuild);
    on('MESSAGE_SWIPED', rebuild);
    on('MESSAGE_DELETED', rebuild);
    on('MORE_MESSAGES_LOADED', rebuild);
    on('GENERATION_ENDED', rebuild);
    on('GENERATION_STOPPED', rebuild);
    on('GROUP_WRAPPER_FINISHED', rebuild);

    window.addEventListener('resize', () => {
        if (uiIsOpen()) render();
    });
}

/**
 * Builds the map where the scene keeps it: the floating minimap window and
 * the full map window, both children of the frame.
 *
 * @param {{frame:Element, goto?:(index:number) => void}} parts
 */
export function mountMap({ frame, goto = null } = {}) {
    if (widget || !frame) return;

    frameEl = frame;
    gotoTurn = goto;

    widget = document.createElement('aside');
    widget.className = 'mz-map';
    widget.setAttribute('aria-label', 'Map');
    widget.hidden = true;
    widget.innerHTML = WIDGET_HTML;

    win = document.createElement('section');
    win.className = 'mz-mapwin';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-label', 'Map');
    win.setAttribute('aria-hidden', 'true');
    win.hidden = true;
    win.innerHTML = WIN_HTML;

    frame.append(widget, win);

    els = {
        head: widget.querySelector('[data-mz-map-head]'),
        mini: widget.querySelector('[data-mz-map-mini]'),
        miniSvg: widget.querySelector('[data-mz-map-minisvg]'),
        miniGrip: widget.querySelector('[data-mz-map-grip]'),
        title: widget.querySelector('[data-mz-map-title]'),
        collapse: widget.querySelector('.mz-map-collapse'),
        sub: widget.querySelector('[data-mz-map-sub]'),
        summary: win.querySelector('[data-mz-map-sum]'),
        find: win.querySelector('[data-mz-map-find]'),
        depthv: win.querySelector('[data-mz-map-depthv]'),
        body: win.querySelector('[data-mz-map-body]'),
        index: win.querySelector('[data-mz-map-index]'),
        stage: win.querySelector('[data-mz-map-stage]'),
        chart: win.querySelector('[data-mz-map-chart]'),
        cartTitle: win.querySelector('[data-mz-map-ctitle]'),
        cartSub: win.querySelector('[data-mz-map-csub]'),
        key: win.querySelector('[data-mz-map-key]'),
        detail: win.querySelector('[data-mz-map-detail]'),
        winHead: win.querySelector('.mz-mapwin-head'),
        winGrip: win.querySelector('[data-mz-mapwin-grip]'),
    };

    wireWidget();
    wireWin();
    wireMiniResize();
    wireWinDrag();
    render();
}

/** The scene opened: the map catches the chat up and shows itself. */
export function mapUiOpened() {
    refreshMap();
}

/** The scene closed: the map window goes away whole. */
export function mapUiClosed() {
    closeMapWin();
    if (widget) widget.hidden = true;
}

/** Re-reads the settings the map shows - called when a switch flips. */
export function refreshMap() {
    ensure();
    render();
}

/** Whether the full map window is on screen. */
export function isMapWinOpen() {
    return !!win && !win.hidden;
}

/**
 * Opens the full map, optionally at one place.
 *
 * @param {string|null} [nodeKey] the place's stable key
 */
export function openMapWin(nodeKey = null) {
    if (!win || !mapOn() || !uiIsOpen()) return;
    ensure();
    if (nodeKey && findByKey(nodeKey)) selectedKey = nodeKey;

    lastFocus = document.activeElement;
    win.hidden = false;
    win.setAttribute('aria-hidden', 'false');
    frameEl?.classList.add('is-mapwin-open');
    terrainT0 = performance.now();
    view.placed = false;
    renderWin();
    if (selectedKey) {
        const item = anchorOf(selectedKey);
        if (item) {
            centerOn(item.ax, item.ay, Math.max(view.s, 1.3));
            applyTransform();
        }
    }
    els.find?.focus();
}

/** Closes the full map window and returns focus where it came from. */
export function closeMapWin() {
    if (!win || win.hidden) return;
    win.hidden = true;
    win.setAttribute('aria-hidden', 'true');
    frameEl?.classList.remove('is-mapwin-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
}

/* ---------- the derived state ---------- */

function chatSignature() {
    const messages = chatMessages();
    let signature = `${currentChatId() || ''}|${messages.length}`;
    for (const message of messages) {
        const swipes = Array.isArray(message.swipes) ? message.swipes.length : 0;
        const text = typeof message.mes === 'string' ? message.mes : '';
        signature += `|${swipes}:${Number(message.swipe_id ?? 0)}:${hashFold(text)}`;
    }
    return signature;
}

/** The nodes a journey can land on - the layout gives each a real pin (a
    hub) so trails never end on an unmarked blob centre. */
function landingsFrom(derived) {
    const ids = new Set();
    for (const leg of (derived && derived.legs) || []) {
        if (leg.a) ids.add(leg.a);
        if (leg.b) ids.add(leg.b);
        for (const id of leg.dir || []) ids.add(id);
    }
    return ids;
}

function ensure() {
    const chatId = currentChatId();
    if (chatId !== lastChatId) {
        lastChatId = chatId;
        lastSignature = null;
        selectedKey = null;
        insideKey = null;
        deckLayout = null;
        view = { tx: 0, ty: 0, s: 1, placed: false };
    }

    const signature = chatSignature();
    if (signature !== lastSignature || !atlas) {
        lastSignature = signature;

        const messages = chatMessages();
        let obs = extractObservations(messages, { persona: personaName() });
        // No tags in the story: the drawn backgrounds still name their places.
        if (!obs.length) obs = extractStampObservations(messages, bgStore().records);
        atlas = obs.length ? buildAtlas(obs) : null;
        derived = atlas ? deriveLegs(atlas) : null;
        layout = null;
        layoutDepth = null;

        if (selectedKey && !findByKey(selectedKey)) selectedKey = null;
        if (!atlas) console.debug(`${LOG} no places to map`);
    }

    const depth = depthValue();
    if (atlas && (layoutDepth !== depth || !layout)) {
        layoutDepth = depth;
        layout = layoutAtlas(atlas, { depth, landings: landingsFrom(derived) });
    }

    if (atlas && insideKey) {
        const ship = findByKey(insideKey);
        deckLayout = ship ? layoutAtlas(atlas, { depth: 99, inside: ship.id, landings: landingsFrom(derived) }) : null;
        if (!deckLayout || !deckLayout.order.length) {
            insideKey = null;
            deckLayout = null;
        }
    } else {
        deckLayout = null;
    }
}

function findByKey(key) {
    return atlas ? Object.values(atlas.nodes).find(node => node.key === key) || null : null;
}

function anchorOf(key) {
    const node = findByKey(key);
    const lay = activeLayout();
    return node && lay ? lay.anchor(node.id) : null;
}

/**
 * The world-chart spot for "where the story is". A room aboard a ship lives
 * on the deck, not the world - so the world answers with the ship's berth or
 * last known position instead.
 */
function nowAnchor() {
    let node = derived?.nowId && atlas ? atlas.nodes[derived.nowId] : null;
    const own = node && layout ? layout.anchor(node.id) : null;
    if (own) return own;
    while (node && node.kind !== 'mobile') node = node.parentId ? atlas.nodes[node.parentId] : null;
    const stop = node ? (node.trajectory || []).slice(-1)[0] : null;
    return stop && stop.positionId && layout ? layout.anchor(stop.positionId) : null;
}

/** The node the story is at now, if it is at one. */
function nowNode() {
    return derived && derived.nowId ? atlas.nodes[derived.nowId] || null : null;
}

function pathOf(node) {
    const names = [];
    for (let at = node; at; at = at.parentId ? atlas.nodes[at.parentId] : null) {
        if (at.kind !== 'transient') names.unshift(at.name);
    }
    return names;
}

/** The cartouche's story name: the chat, presented as a title. */
function storyName() {
    const id = String(currentChatId() || '');
    if (!id) return 'No chat open';
    return id
        .replace(/\.[^.]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'Map';
}

/* ---------- pictures from the background store ---------- */

/**
 * The background record one observation's reply carries, or null. A reply
 * holds ONE picture pointer: the bg watcher counts only its LAST scene tag
 * (where narration stopped, waiting for the user) and draws for that place
 * alone - so only the scene the reply stopped at may claim the pointer. A
 * mid-reply scene shares the response but never its picture: that is how
 * the bedroom's painting used to leak onto the kitchen it passed through.
 */
function recordFor(obsIndex) {
    const obs = atlas.observations[obsIndex];
    if (!obs?.last) return null;
    const message = chatMessages()[obs?.at?.msgIndex ?? -1];
    const id = message ? activeStamp(message) : null;
    return id ? bgStore().records?.[id] || null : null;
}

/**
 * The place's latest drawn picture, or '' (the map glyph stands in). Only
 * scenes that ENDED at this place speak for its picture - a scene merely
 * passing through (the region above, the container around) drew the dot at
 * the end of the chain, not the chain's earlier links - and only the scene
 * its response stopped at owns that response's picture (`recordFor`). That
 * is also the details rule: images belong to last locations in the chain,
 * never to a region or territory.
 */
function thumbOf(node) {
    for (let i = node.visits.length - 1; i >= 0; i -= 1) {
        const obsIndex = node.visits[i];
        if (atlas.observations[obsIndex]?.nodeId !== node.id) continue;
        const src = recordSrc(recordFor(obsIndex));
        if (src) return src;
    }
    return '';
}

function isOutdoor(node) {
    const own = atlas.observations.find(obs => obs.nodeId === node.id && obs.locationTag);
    const kinded = own || atlas.observations.find(obs => {
        const found = atlas.nodes[obs.nodeId];
        return found && found.parentId === node.id && obs.locationTag;
    });
    return !!kinded && kinded.locationTag === 'Outdoor';
}

/* ---------- the chart renderer (SVG string, no DOM) ---------- */

function randomFrom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** A soft land outline: 18 name-seeded points, smoothed closed. */
function blob(cx, cy, r, seed, amp) {
    const rand = randomFrom(seed);
    const phase = [rand() * 6, rand() * 6, rand() * 6];
    const count = 18;
    const pts = [];
    for (let i = 0; i < count; i += 1) {
        const t = i / count * 6.2832;
        const k = 1 + amp * (Math.sin(2 * t + phase[0]) * 0.55 + Math.sin(3 * t + phase[1]) * 0.3 + Math.sin(5 * t + phase[2]) * 0.2);
        pts.push([cx + Math.cos(t) * r * k, cy + Math.sin(t) * r * k * 0.9]);
    }
    let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < count; i += 1) {
        const p0 = pts[(i - 1 + count) % count];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % count];
        const p3 = pts[(i + 2) % count];
        d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return `${d}Z`;
}

const icon = (name, x, y, size) => `<use href="#mz-i-${name}" x="${f1(x - size / 2)}" y="${f1(y - size / 2)}" width="${size}" height="${size}"/>`;

function descend(node) {
    const out = [];
    const walk = parent => parent.children.forEach(id => {
        out.push(atlas.nodes[id]);
        walk(atlas.nodes[id]);
    });
    walk(node);
    return out;
}

function renderChart(mode) {
    const mini = mode === 'mini';
    const deck = mode === 'deck';
    const lay = deck ? (deckLayout || layout) : layout;
    const nodes = atlas.nodes;
    const selNode = selectedKey ? findByKey(selectedKey) : null;
    const sel = selNode ? selNode.id : null;

    /* which pins carry a flag of their own (or below them) */
    const flagged = new Set();
    const sameFlags = flagsShown ? atlas.flags.same.filter(([a, b]) => lay.items[a] || lay.items[b]) : [];
    if (flagsShown) {
        sameFlags.forEach(([a, b]) => {
            flagged.add(a);
            flagged.add(b);
        });
        Object.values(nodes).forEach(node => {
            if (atlas.flags.ambiguous.includes(node.fold) || atlas.flags.mobilePending.includes(node.fold)) flagged.add(node.id);
        });
    }

    const nowItem = derived.nowId ? lay.anchor(derived.nowId) : null;

    /* The ship the story is aboard, if any: the "now" ring follows it. */
    let nowAboard = derived.nowId ? nodes[derived.nowId] : null;
    while (nowAboard && nowAboard.kind !== 'mobile') nowAboard = nowAboard.parentId ? nodes[nowAboard.parentId] : null;

    /* The ships' trails: where each vehicle sits in the blob hierarchy on
       its way through - one point per crossed level, placed inside that
       level's blob and outside the deeper ones (the open area the ship
       sails). The journey legs route through these points, so the trail
       climbs out of inner blobs and into new ones as the story moves. */
    const clipR = new Set();
    const wayPoints = new Map();
    const markers = ALIGN_DEBUG ? [] : null;
    const ships = [];
    const marks = [];
    const shipDrawn = new Set();
    if (!deck) {
        /* Pass one: settle every vehicle's crossed positions ONCE - the
           trail, the stop marks and the ship icons must all read the same
           points or the lines leave from spots where nothing is drawn.
           First writer wins; a place's own pin or hub wins outright. */
        for (const node of Object.values(nodes)) {
            if (node.kind !== 'mobile') continue;
            const seq = [];
            for (const stop of node.trajectory || []) {
                if (stop.positionId && seq[seq.length - 1] !== stop.positionId) seq.push(stop.positionId);
            }
            seq.forEach((id, i) => {
                if (wayPoints.has(id)) return;
                const home = lay.items[`hub:${id}`] || lay.items[id];
                if (!home) return;
                if (home.pin) {
                    wayPoints.set(id, { n: nodes[id], ax: home.ax, ay: home.ay, r: 12, pin: true });
                    return;
                }
                const item = home;
                const prevItem = i > 0 ? lay.items[seq[i - 1]] : null;
                const nextItem = i < seq.length - 1 ? lay.items[seq[i + 1]] : null;
                let dx = 1;
                let dy = 0;
                if (nextItem && prevItem) { dx = nextItem.ax - prevItem.ax; dy = nextItem.ay - prevItem.ay; }
                else if (nextItem) { dx = nextItem.ax - item.ax; dy = nextItem.ay - item.ay; }
                else if (prevItem) { dx = item.ax - prevItem.ax; dy = item.ay - prevItem.ay; }
                const len = Math.hypot(dx, dy) || 1;
                dx /= len;
                dy /= len;
                let p = null;
                for (let t = item.r * 0.72; t >= 0; t -= 6) {
                    const x = item.ax + dx * t;
                    const y = item.ay + dy * t;
                    if ((item.kids || []).every(k => Math.hypot(x - k.ax, y - k.ay) > k.r + 8)) {
                        p = { ax: x, ay: y };
                        break;
                    }
                }
                wayPoints.set(id, { n: nodes[id], ...(p || { ax: item.ax + dx * item.r * 0.5, ay: item.ay + dy * item.r * 0.5 }), r: 12, pin: true });
            });
        }

        /* Pass two: the icons and the stop marks, drawn from the settled map */
        for (const node of Object.values(nodes)) {
            if (node.kind !== 'mobile') continue;

            /* the icon: at the trail's head while moving, beside its berth
               when parked - and nowhere at all for a vehicle the story only
               ever names on the road (the stub glyph carries those). Rich
               when the vehicle has rooms aboard (its picture, the room
               count, look inside), a plain glyph disc when it has not. */
            const stops = node.trajectory || [];
            const lastStop = stops[stops.length - 1];
            // The ship sits where its journey ended: the trail's head while
            // under way, the berth its arrival leg closed on when parked -
            // the icon follows the trail to the last scene tag.
            const endLeg = [...derived.legs].reverse().find(leg => leg.vehicle === node.id);
            const endId = endLeg ? endLeg.dir[1] : (lastStop ? lastStop.positionId : null);
            const head = endId ? (wayPoints.get(endId) || lay.items[endId] || null) : null;
            if (!head) continue;
            shipDrawn.add(node.id);
            const aboard = !!(lastStop && lastStop.moving && endId === lastStop.positionId);
            const x = head.ax + (aboard ? 0 : 22);
            const y = head.ay + (aboard ? 0 : -22);
            const r = 15;
            const kids = node.children.filter(id => nodes[id].kind !== 'mobile' && nodes[id].kind !== 'transient').length;
            const isNow = !!nowAboard && nowAboard.id === node.id;
            const glyph = `m-${travelMode(node.name).glyph}`;
            const rich = kids > 0;
            const img = rich ? thumbOf(node) : '';
            if (img) clipR.add(r);
            if (markers) markers.push([x, y]);
            ships.push(`<g class="mzc-ship${isNow ? ' is-now' : ''}${sel === node.id ? ' is-sel' : ''}${rich ? '' : ' is-plain'}" data-node="${esc(node.key)}" transform="translate(${f1(x)} ${f1(y)})" tabindex="${mini ? -1 : 0}" role="button" aria-label="${esc(node.name)}">
            ${isNow ? `<circle class="mzc-ping" r="${r + 5}"/><circle class="mzc-ping p2" r="${r + 5}"/>` : ''}
            <circle class="mzc-pin-disc" r="${r}"/>
            ${icon(glyph, 0, 0, r * 1.15)}
            ${img ? `<image href="${esc(img)}" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" clip-path="url(#mzc-c${r})" preserveAspectRatio="xMidYMid slice" draggable="false"/>` : ''}
            <circle class="mzc-pin-ring" r="${r}"/>
            ${rich ? `<g class="mzc-shipglyph" transform="translate(${f1(r * 0.82)} ${f1(-r * 0.82)})"><circle r="8"/>${icon(glyph, 0, 0, 11)}</g>` : ''}
            ${rich && !mini ? `<g class="mzc-count" transform="translate(${f1(-r * 0.82)} ${f1(r * 0.82)})"><circle r="7.5"/><text y="3" text-anchor="middle">${kids}</text></g>` : ''}
            ${!mini ? labelSvg(node.name, r + 14, 16) : ''}
            <title>${esc(node.name)}</title></g>`);

            /* Past stops of the trail: where responses caught the vehicle
               under way (turns 15, 17 at Corporate Space) - a small vehicle
               icon each, about half the live one's size, clickable so the
               rail tells those turns. History never shouts. */
            if (!mini) {
                const caught = new Map();
                for (const stop of stops) {
                    if (!stop.positionId || !stop.moving) continue;
                    const entry = atlas.observations[stop.obs];
                    if (!entry || !entry.last) continue;
                    caught.set(stop.positionId, (caught.get(stop.positionId) || 0) + 1);
                }
                for (const [id, count] of caught) {
                    const p = id === endId ? null : wayPoints.get(id);
                    const placeNode = nodes[id];
                    if (!p || !placeNode) continue;
                    const mr = 7;
                    if (markers) markers.push([p.ax, p.ay]);
                    marks.push(`<g class="mzc-stopmark${sel === id ? ' is-sel' : ''}" data-node="${esc(placeNode.key)}" transform="translate(${f1(p.ax)} ${f1(p.ay)})" tabindex="0" role="button" aria-label="${esc(placeNode.name)}">
                    <circle class="mzc-pin-disc" r="${mr}"/>
                    ${icon(glyph, 0, 0, 8)}
                    <circle class="mzc-pin-ring" r="${mr}"/>
                    ${count > 1 ? `<g class="mzc-count mzc-count--sm" transform="translate(${f1(mr * 0.8)} ${f1(-mr * 0.8)})"><circle r="6"/><text y="2.2" text-anchor="middle" font-size="8">${count}</text></g>` : ''}
                    ${labelSvg(placeNode.name, mr + 11, 14)}
                    <title>${esc(placeNode.name)} \u00b7 ${count}\u00d7 on the road</title></g>`);
                }
            }
        }
    }
    const pointFor = id => wayPoints.get(id) || lay.anchor(id);

    const parts = [];

    /* ground and the contour rings that make land look like land */
    const rec = terrainStore() || {};
    const rootFoldOf = id => {
        let node = nodes[id];
        while (node && node.parentId) node = nodes[node.parentId];
        return node ? node.fold : '';
    };
    const containers = lay.order.filter(item => !item.pin);
    const rings = [];
    containers.filter(item => item.n.level === 0).forEach(item => {
        for (let k = 3; k >= 1; k -= 1) {
            rings.push(`<path class="mzc-ring r${k}" style="--mzc-tint:${inkTint(rec, item.n.fold)}" d="${blob(item.ax, item.ay, item.r + k * 15, hashFold(item.n.fold) + k, 0.11)}"/>`);
        }
    });
    parts.push(`<g class="mzc-rings">${rings.join('')}</g>`);

    /* territories: region, city, plot - biggest first so smaller sit on top */
    const terr = [];
    const align = [];
    containers.slice().sort((a, b) => b.r - a.r).forEach(item => {
        const level = item.n.level;
        const cls = item.n.kind === 'mobile' ? 'mobile' : level === 0 ? 'region' : level === 1 ? 'city' : 'plot';
        const amp = level === 0 ? 0.12 : level === 1 ? 0.09 : 0.07;
        const d = blob(item.ax, item.ay, item.r, hashFold(item.n.fold), amp);
        terr.push(`<path class="mzc-terr mzc-${cls}${sel === item.n.id ? ' is-sel' : ''}" data-node="${esc(item.n.key)}" style="--mzc-tint:${inkTint(rec, rootFoldOf(item.n.id))}" d="${d}"/>`);
        if (ALIGN_DEBUG) align.push(`<path d="${d}"/>`);
    });
    parts.push(`<g class="mzc-lands">${terr.join('')}</g>`);

    /* territory names: regions along an arc, like an atlas plate */
    const names = [];
    containers.forEach(item => {
        const level = item.n.level;
        if (level === 0) {
            const ra = item.r * 0.74;
            const arc = `mzc-arc-${item.n.id}`;
            names.push(`<path id="${arc}" d="M${f1(item.ax - ra)} ${f1(item.ay + 6)} A${f1(ra)} ${f1(ra)} 0 0 1 ${f1(item.ax + ra)} ${f1(item.ay + 6)}" fill="none"/><text class="mzc-name mzc-name-region"><textPath href="#${arc}" startOffset="50%" text-anchor="middle">${esc(item.n.name.toUpperCase())}</textPath></text>`);
        } else if (level === 1) {
            names.push(`<text class="mzc-name mzc-name-city" x="${f1(item.ax)}" y="${f1(item.ay - item.r * 0.72)}" text-anchor="middle">${esc(item.n.name.toUpperCase())}</text>`);
        } else {
            names.push(`<text class="mzc-name mzc-name-plot" x="${f1(item.ax)}" y="${f1(item.ay - item.r + 15)}" text-anchor="middle">${esc(trunc(item.n.name, 22))}</text>`);
        }
    });
    parts.push(`<g class="mzc-names">${names.join('')}</g>`);

    /* journeys: dotted legs, thicker the more travelled, the latest flowing.
       The walks are shared with the terrain's roads and fog corridors - one
       journey, one line everywhere it appears on the map. */
    const legSvg = [];
    const recent = derived.legs.slice().sort((a, b) => b.order - a.order);
    const lastKey = recent[0] && recent[0].key;
    const shown = new Set(mini ? recent.slice(0, 4).map(leg => leg.key) : derived.legs.map(leg => leg.key));
    const walks = trailWalks(derived.legs, pointFor);
    if (!deck) chartWalks = { sig: `${lastSignature}|${layoutDepth}`, walks };
    walks.forEach(({ leg, d }) => {
        if (deck || !trails || !shown.has(leg.key)) return;
        const width = Math.min(2.2, 1.2 + leg.count * 0.25);
        const isLast = leg.key === lastKey;
        const ride = !!(leg.vehicle || leg.mode);

        legSvg.push(`<path class="mzc-leg${ride ? '' : ' is-land'}${isLast ? ' is-last' : ''}${sel && (leg.a === sel || leg.b === sel) ? ' is-sel' : ''}" d="${d}" style="stroke-width:${f1(width)}px"/>`);
    });
    parts.push(`<g class="mzc-legs">${legSvg.join('')}</g>`);

    /* possible duplicates: a dotted tie, display only */
    if (flagsShown && !mini && !deck) {
        const ties = sameFlags.map(([a, b]) => {
            const p = lay.anchor(a);
            const q = lay.anchor(b);
            if (!p || !q || p === q) return '';
            return `<g class="mzc-same"><path d="M${f1(p.ax)} ${f1(p.ay)}L${f1(q.ax)} ${f1(q.ay)}"/><g transform="translate(${f1((p.ax + q.ax) / 2)} ${f1((p.ay + q.ay) / 2)})"><circle r="7"/><text y="3.2" text-anchor="middle">?</text></g></g>`;
        });
        parts.push(`<g class="mzc-ties">${ties.join('')}</g>`);
    }

    /* pins: each place is a small picture on the chart */
    const pins = [];
    const recentIds = new Set();
    recent.slice(0, 3).forEach(leg => {
        recentIds.add(leg.dir[0]);
        recentIds.add(leg.dir[1]);
    });

    lay.order.filter(item => item.pin).forEach(item => {
        const node = item.n;
        const isNow = nowItem === item;
        const isSel = sel === node.id;
        /* A stop draws as a picture pin - the places narration ended at. A
           place only passed through (no response ever stopped there) is a
           smaller flat dot, and promotes on its own the moment a response
           does stop there. */
        const stopped = node.stops > 0 || descend(node).some(child => child.stops > 0);
        const r = !stopped ? 10 : node.level >= 2 || (node.level === 1 && node.kind === 'spot') ? PIN_R : PIN_R + 2;
        const total = atlas.observations.length;
        const age = total ? (total - 1 - node.lastSeen) / total : 0;
        const img = stopped ? thumbOf(node) : '';
        const clip = `mzc-c${r}`;
        if (img) clipR.add(r);

        const flag = flagged.has(node.id) || (node.children.length && descend(node).some(child => flagged.has(child.id)));
        const people = isNow && derived.nowId ? Object.keys(derived.present[derived.nowId] || {}).slice(0, 3) : [];
        const parked = Object.values(nodes).find(vehicle => vehicle.kind === 'mobile'
            && !shipDrawn.has(vehicle.id)
            && vehicle.trajectory.length
            && lay.anchor(vehicle.trajectory[vehicle.trajectory.length - 1].positionId || '') === item);
        const label = mini ? (isNow || recentIds.has(node.id)) : true;
        const hiddenKids = node.children.filter(id => nodes[id].kind !== 'mobile' && nodes[id].kind !== 'transient').length;

        if (markers) markers.push([item.ax, item.ay]);
        pins.push(`<g class="mzc-pin lv${Math.min(node.level ?? 3, 3)}${!stopped ? ' is-passed' : ''}${isNow ? ' is-now' : ''}${isSel ? ' is-sel' : ''}${flag ? ' is-flag' : ''}${mini && !label ? ' is-quiet' : ''}" data-node="${esc(node.key)}" transform="translate(${f1(item.ax)} ${f1(item.ay)})" style="--age:${f1(Math.max(0, Math.min(1, age)))}" tabindex="${mini ? -1 : 0}" role="button" aria-label="${esc(node.name)}">
        ${isNow ? `<circle class="mzc-ping" r="${r + 4}"/><circle class="mzc-ping p2" r="${r + 4}"/>` : ''}
        <circle class="mzc-pin-disc" r="${r}"/>
        ${stopped ? icon('map', 0, 0, r * 0.9) : ''}
        ${img ? `<image href="${esc(img)}" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice" draggable="false"/>` : ''}
        <circle class="mzc-pin-ring" r="${r}"/>
        ${hiddenKids && !mini ? `<g class="mzc-count" transform="translate(${f1(r * 0.78)} ${f1(r * 0.78)})"><circle r="7.5"/><text y="3" text-anchor="middle">${hiddenKids}</text></g>` : ''}
        ${flag && !mini ? `<g class="mzc-flagdot" transform="translate(${f1(-r * 0.78)} ${f1(-r * 0.78)})"><circle r="6.5"/><text y="3.2" text-anchor="middle">!</text></g>` : ''}
        ${parked && !mini ? `<g class="mzc-parked" transform="translate(${f1(r * 0.8)} ${f1(-r * 0.8)})"><circle r="8"/>${icon(`m-${travelMode(parked.name).glyph}`, 0, 0, 10)}</g>` : ''}
        ${people.length ? `<g class="mzc-people">${people.map((name, k) => `<g transform="translate(${f1(-(people.length - 1) * 7 + k * 14)} ${-r - 11})"><circle r="7"/><text y="3" text-anchor="middle">${esc(name[0])}</text></g>`).join('')}</g>` : ''}
        ${label ? labelSvg(node.name, r + 14, mini ? 16 : 18) : ''}
        <title>${esc(node.name)}</title></g>`);
    });
    parts.push(`<g class="mzc-pins">${pins.join('')}</g>`);
    if (marks.length && trails) parts.push(`<g class="mzc-stopmarks">${marks.join('')}</g>`);
    if (ships.length) parts.push(`<g class="mzc-ships">${ships.join('')}</g>`);

    /* an unfinished journey: the story is still on the road */
    if (!deck && derived.inTransit && derived.fromId) {
        const from = pointFor(derived.fromId);
        if (from) {
            const angle = Math.atan2(from.ay - (layout.bounds.y0 + layout.bounds.y1) / 2, from.ax - (layout.bounds.x0 + layout.bounds.x1) / 2);
            const length = 70;
            const ex = from.ax + Math.cos(angle) * length;
            const ey = from.ay + Math.sin(angle) * length;
            const mode = derived.transitMode || travelMode('');
            // the ship's icon marks the head; the stub's glyph is only for
            // vehicles no icon can be placed for
            const tip = shipDrawn.size
                ? ''
                : `<g class="mzc-mode is-last" transform="translate(${f1(ex)} ${f1(ey)})"><circle r="13"/>${icon(`m-${mode.glyph}`, 0, 0, 18)}</g>`;
            parts.push(`<g class="mzc-open"><path class="mzc-leg is-last" d="M${f1(from.ax)} ${f1(from.ay)}L${f1(ex)} ${f1(ey)}"/>${tip}</g>`);
        }
    }

    const defs = `<defs>${[...clipR].map(r => `<clipPath id="mzc-c${r}"><circle r="${r}"/></clipPath>`).join('')}</defs>`;
    /* the alignment guard (?mzmapdebug=1): the territories again, in red,
       riding over the land - if a red outline ever leaves its coast at any
       zoom, the chart and the terrain disagree about where things are -
       and a red ring wherever a trail ends on nothing drawn */
    if (ALIGN_DEBUG) {
        parts.push(`<g class="mzc-align">${align.join('')}</g>`);
        if (!deck) {
            const orphan = [];
            for (const { from, to } of walks) {
                for (const pt of [from, to]) {
                    if ((markers || []).some(([mx, my]) => Math.hypot(mx - pt.ax, my - pt.ay) < 14)) continue;
                    orphan.push(`<circle cx="${f1(pt.ax)}" cy="${f1(pt.ay)}" r="16"/>`);
                }
            }
            if (orphan.length) parts.push(`<g class="mzc-orphan">${orphan.join('')}</g>`);
        }
    }
    return { defs, body: parts.join('') };
}

/* ---------- the two crops of one chart ---------- */

function fullSvg(width, height, mode = 'full') {
    const out = renderChart(mode);
    const tier = view.s < 0.5 ? 0 : view.s < 1.1 ? 1 : 2;
    return `<svg class="mzc${terrainOn() ? ' has-terrain' : terrainLayerOn() ? ' has-veil' : ''}" data-style="contour" data-zoom="${tier}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Map of the story's places" style="--mzc-tint:${mapInk(terrainStore() || {})}">${out.defs}<g class="mzc-world" style="transform-origin:0 0;transform:${worldMatrix(view)}"><rect class="mzc-ground" x="-6000" y="-6000" width="12000" height="12000"/>${out.body}</g></svg>`;
}

function miniSvg() {
    const ratio = MINI_W / MINI_H;
    const out = renderChart('mini');
    const now = nowAnchor();
    let box = layout.bounds;

    if (now) {
        let around = now;
        for (let at = atlas.nodes[now.n.id]; at; at = at.parentId ? atlas.nodes[at.parentId] : null) {
            const item = layout.items[at.id];
            if (item && !item.pin) {
                around = item;
                break;
            }
        }
        const k = 1.9;
        box = {
            x0: around.ax - around.r * k,
            x1: around.ax + around.r * k,
            y0: around.ay - around.r * k,
            y1: around.ay + around.r * k,
        };
        const prev = derived.fromId && derived.fromId !== derived.nowId ? layout.anchor(derived.fromId) : null;
        if (prev && Math.hypot(prev.ax - now.ax, prev.ay - now.ay) < (box.x1 - box.x0) * 1.1) {
            box = {
                x0: Math.min(box.x0, prev.ax - 50),
                x1: Math.max(box.x1, prev.ax + 50),
                y0: Math.min(box.y0, prev.ay - 50),
                y1: Math.max(box.y1, prev.ay + 50),
            };
        }
    }

    let width = Math.max(box.x1 - box.x0, 230);
    let height = Math.max(box.y1 - box.y0, 230 / ratio);
    if (width / height > ratio) height = width / ratio;
    else width = height * ratio;

    /* The user's zoom: the same crop, seen closer (zoom in shows less). */
    const zoom = clamp(Number(settings().mapMiniZoom) || 1, 0.6, 2.2);
    width /= zoom;
    height /= zoom;

    let cx = (box.x0 + box.x1) / 2;
    let cy = (box.y0 + box.y1) / 2;
    if (now) {
        cx = clamp(cx, now.ax - width * 0.3, now.ax + width * 0.3);
        cy = clamp(cy, now.ay - height * 0.3, now.ay + height * 0.3);
    }

    return `<svg class="mzc" data-style="contour" data-zoom="2" viewBox="${f1(cx - width / 2)} ${f1(cy - height / 2)} ${f1(width)} ${f1(height)}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Map around the story's current place">${out.defs}<rect class="mzc-ground" x="-6000" y="-6000" width="12000" height="12000"/>${out.body}</svg>`;
}

/* ---------- render ---------- */

function render() {
    if (!widget || !win) return;

    const on = mapOn() && uiIsOpen();
    widget.hidden = !on;
    if (!on) {
        closeMapWin();
        return;
    }

    ensure();
    renderWidget();
    if (!win.hidden) renderWin();
}

function renderWidget() {
    const now = nowNode();
    const inTransit = derived && derived.inTransit;

    els.title.textContent = inTransit
        ? (derived.transitMode && derived.transitMode.glyph !== 'route' ? 'On the road' : 'En route')
        : (now ? now.name : 'Map');

    if (inTransit) {
        const from = derived.fromId ? atlas.nodes[derived.fromId] : null;
        const mode = derived.transitMode || travelMode('');
        els.sub.textContent = `${mode.label}${from ? ` \u00b7 from ${from.name}` : ''}`;
    } else if (now) {
        els.sub.textContent = pathOf(now).slice(0, -1).reverse().join(' \u00b7 ');
    } else {
        els.sub.textContent = currentChatId() ? 'No places yet' : 'No chat open';
    }

    const narrow = window.innerWidth < NARROW;
    const compact = !mapMiniOn() || narrow;
    widget.classList.toggle('is-compact', compact);
    els.mini.hidden = compact;
    if (!compact && atlas) els.miniSvg.innerHTML = miniSvg();
    if (!compact && !atlas) els.miniSvg.innerHTML = '';

    /* The size the user chose for this window - not while their hand is on
       the grip, which would snap mid-resize. */
    if (!miniSizing) {
        const size = settings().mapMiniSize;
        const sized = !!size && Number.isFinite(size.w) && Number.isFinite(size.h);
        widget.style.width = compact ? '' : (sized ? `${clamp(size.w, 180, 420)}px` : '');
        els.mini.style.height = sized ? `${clamp(size.h, 110, 380)}px` : '';
    }

    /* The pill's way back to the minimap: the toggle stays on it - hidden
       only where the minimap cannot show at all - and names what it does. */
    if (els.collapse) {
        els.collapse.hidden = narrow;
        els.collapse.innerHTML = svg(mapMiniOn() ? 'collapse' : 'expand');
        const say = mapMiniOn() ? 'Hide minimap' : 'Show minimap';
        els.collapse.title = say;
        els.collapse.setAttribute('aria-label', say);
    }

    positionWidget();
}

/** The Land chips say what the settings hold. */
function syncLookChips() {
    if (!win) return;
    const look = settings().mapTerrain === 'flat' ? 'flat' : 'ink';
    win.querySelectorAll('[data-mz-map-look]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.mzMapLook === look));
    });
    /* there is no fog in Flat - the veil needs the land to ride over */
    const flat = look === 'flat';
    win.querySelectorAll('[data-mz-map-layer="fog"]').forEach(button => {
        button.setAttribute('aria-pressed', String(!flat && !!settings().mapTerrainFog));
        button.disabled = flat;
        button.setAttribute('aria-disabled', String(flat));
    });
}

function renderWin() {
    if (!win || win.hidden) return;

    applyWinPlace();
    syncLookChips();
    els.depthv.textContent = depthLabel();

    if (!atlas) {
        els.summary.textContent = currentChatId() ? '' : 'No chat open';
        els.cartTitle.textContent = currentChatId() ? 'Map' : 'No chat open';
        els.cartSub.textContent = '';
        els.key.innerHTML = '';
        els.index.innerHTML = '';
        els.chart.innerHTML = '';
        els.detail.hidden = true;
        els.body.classList.remove('has-card');
        return;
    }

    const places = Object.values(atlas.nodes).filter(node => node.kind !== 'mobile' && node.kind !== 'transient').length;
    els.summary.textContent = `${places} places \u00b7 ${atlas.observations.length} scenes \u00b7 ${derived.legs.length} journeys`;
    els.cartTitle.textContent = storyName();
    els.cartSub.textContent = `${places} places \u00b7 ${atlas.observations.length} scenes`;

    const hasFlags = atlas.flags.same.length || atlas.flags.ambiguous.length || atlas.flags.mobilePending.length;
    els.key.innerHTML = `<div><i class="k-now"></i>Where the story is</div><div><i class="k-pin"></i>Stopped here, as last drawn</div><div><i class="k-pass"></i>Passed through</div><div><i></i>A journey, with how it went</div>${flagsShown && hasFlags ? '<div><i class="k-flag"></i>Needs a look</div>' : ''}`;

    renderIndex();
    renderDetail();
    drawChart();
}

/* The index tree: a long story's places stay folded until asked for. Only
   the branch the story is IN stands open by default (plus the one being
   read); the user's own twists win over that, always. */
const twistState = new Map();

function branchOf(key, out) {
    for (let at = key ? findByKey(key) : null; at; at = at.parentId ? atlas.nodes[at.parentId] : null) {
        out.add(at.key);
    }
    return out;
}

function renderIndex() {
    if (!atlas) {
        els.index.innerHTML = '';
        return;
    }
    const query = (els.find?.value || '').trim().toLowerCase();

    const auto = new Set();
    if (query) {
        // while searching, every match's path stands open so it can be found
        Object.values(atlas.nodes).forEach(node => {
            if (node.kind === 'mobile' || node.kind === 'transient') return;
            const text = `${node.name} ${pathOf(node).join(' ')}`.toLowerCase();
            if (text.includes(query)) branchOf(node.key, auto);
        });
    } else {
        branchOf(nowNode()?.key, auto);
        branchOf(selectedKey, auto);
    }

    const isOpen = node => (twistState.has(node.key) ? twistState.get(node.key) : auto.has(node.key));
    const rows = [];

    const walk = (node, depth, out = rows) => {
        if (node.kind === 'mobile' || node.kind === 'transient') return;
        if (query && !auto.has(node.key)) return;

        const kids = node.children
            .map(id => atlas.nodes[id])
            .filter(kid => kid && kid.kind !== 'mobile' && kid.kind !== 'transient');
        const open = isOpen(node);
        const twist = kids.length
            ? `<button class="mz-map-twist${open ? ' is-open' : ''}" type="button" data-mz-map-twist="${esc(node.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(node.name)}">${svg('chevdown')}</button>`
            : '<span class="mz-map-twist"></span>';

        out.push(`<div class="mz-map-row d${Math.min(depth, 3)}${selectedKey === node.key ? ' is-sel' : ''}${derived.nowId === node.id ? ' is-now' : ''}">${twist}<button class="mz-map-pick" type="button" data-mz-map-pick="${esc(node.key)}"><span>${esc(node.name)}</span></button></div>`);
        if (open) kids.forEach(kid => walk(kid, depth + 1, out));
    };
    atlas.roots.forEach(id => walk(atlas.nodes[id], 0));

    /* Vehicles sit apart from places - and a vehicle with named spaces aboard
       unfolds into them: the ship first, then its rooms. */
    const vehicles = Object.values(atlas.nodes).filter(node => node.kind === 'mobile');
    const vehicleRows = vehicles.map(node => {
        const kids = node.children
            .map(id => atlas.nodes[id])
            .filter(kid => kid && kid.kind !== 'mobile' && kid.kind !== 'transient');
        const open = isOpen(node);
        const twist = kids.length
            ? `<button class="mz-map-twist${open ? ' is-open' : ''}" type="button" data-mz-map-twist="${esc(node.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(node.name)}">${svg('chevdown')}</button>`
            : '<span class="mz-map-twist"></span>';
        const rowsFor = [`<div class="mz-map-row d0${selectedKey === node.key ? ' is-sel' : ''}${derived.nowId === node.id ? ' is-now' : ''}">${twist}<button class="mz-map-pick" type="button" data-mz-map-pick="${esc(node.key)}">${svg(`m-${travelMode(node.name).glyph}`)}<span>${esc(node.name)}</span></button></div>`];
        if (open) kids.forEach(kid => walk(kid, 1, rowsFor));
        return rowsFor.join('');
    });
    els.index.innerHTML = `<h4>Places</h4>${rows.join('')}${vehicleRows.length ? `<h4>Vehicles</h4>${vehicleRows.join('')}` : ''}`;
}

/* The Seen block: when the place sat on the story's timeline, and the visits
   themselves as one-line rows with their Turn buttons. One section, not two -
   they told the same fact twice, and the rail should not need to scroll. */
function seenHtml(node) {
    const total = atlas.observations.length;
    const ticks = node.visits.map((visit, k) => `<rect class="${k === node.visits.length - 1 ? 'is-last' : ''}" x="${(visit / Math.max(1, total - 1) * 96 + 1).toFixed(1)}%" y="5" width="2.6" height="12" rx="1.3"/>`).join('');
    const first = atlas.observations[node.visits[0]];
    const last = atlas.observations[node.visits[node.visits.length - 1]];

    const shown = (visitsExpanded ? node.visits.slice().reverse() : node.visits.slice(-3).reverse());
    const rows = shown.map(index => {
        const obs = atlas.observations[index];
        const when = [obs.date, obs.time].filter(Boolean).join(' \u00b7 ') || 'undated';
        const who = obs.present?.length ? `<span class="who">${esc(obs.present.join(', '))}</span>` : '';
        return `<li><span class="lines"><span class="when">${esc(when)}</span>${who}</span><button class="mz-btn-ghost mz-map-goto" type="button" data-mz-map-goto="${obs.at?.msgIndex ?? ''}">Turn ${(obs.at?.msgIndex ?? -1) + 1}</button></li>`;
    }).join('');

    const more = node.visits.length > 3
        ? `<button class="mz-btn-ghost mz-map-more" type="button" data-mz-map-more>${visitsExpanded ? 'Show less' : `Show all ${node.visits.length}`}</button>`
        : '';

    return `<div class="mz-map-sect"><h4>Seen <i>${node.visits.length} scenes</i></h4><svg class="mz-map-seen" aria-hidden="true"><line x1="0" x2="100%" y1="11" y2="11"/>${ticks}</svg><div class="mz-map-span"><span>${esc(first?.date || '')}</span><span>${esc(last?.date || '')}</span></div><ul class="mz-map-visits">${rows}</ul>${more}</div>`;
}

function whoHtml(nodeId) {
    const counts = derived.present[nodeId] || {};
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (!top.length) return '';
    return `<div class="mz-map-sect"><h4>Who has been here</h4><div class="mz-map-who">${top.map(([name, count]) => `<span><b>${esc(name[0])}</b>${esc(name)}<i>${count}</i></span>`).join('')}</div></div>`;
}

function legsHtml(node) {
    const all = derived.legs
        .filter(leg => leg.a === node.id || leg.b === node.id)
        .sort((a, b) => b.order - a.order);
    if (!all.length) return '';
    const rows = all.slice(0, 4).map(leg => {
        const other = atlas.nodes[leg.a === node.id ? leg.b : leg.a];
        const dir = leg.dir[0] === node.id ? '\u2192' : '\u2190';
        const mode = leg.mode || travelMode('');
        return `<li>${svg(`m-${mode.glyph}`)}<span>${dir} ${esc(other.name)}</span><em>${esc(mode.label)}${leg.count > 1 ? ` \u00b7 ${leg.count}\u00d7` : ''}</em></li>`;
    });
    return `<div class="mz-map-sect"><h4>Journeys <i>${all.length}</i></h4><ul class="mz-map-legs">${rows.join('')}</ul></div>`;
}

function flagsFor(node) {
    const out = [];
    for (const [a, b] of atlas.flags.same) {
        const other = a === node.id ? b : b === node.id ? a : null;
        if (other) out.push(`May be the same as \u201c${atlas.nodes[other].name}\u201d.`);
    }
    if (atlas.flags.ambiguous.includes(node.fold)) out.push('This name appears in more than one place.');
    if (atlas.flags.mobilePending.includes(node.fold)) out.push('May be a moving place.');
    return out;
}

function renderDetail() {
    const node = selectedKey ? findByKey(selectedKey) : null;
    els.body.classList.toggle('has-card', !!node);
    els.detail.hidden = !node;
    if (!node) return;

    const mobile = node.kind === 'mobile';
    const path = pathOf(node);
    const stoppedHere = node.stops > 0;
    const chips = [`<span class="mz-map-chip${mobile ? ' is-accent' : ''}">${mobile ? svg(`m-${travelMode(node.name).glyph}`) : ''}${mobile ? 'moves' : node.kind}</span>`];
    if (!mobile && !stoppedHere) chips.push('<span class="mz-map-chip">Passed through</span>');
    if (!mobile) chips.push(`<span class="mz-map-chip">${isOutdoor(node) ? 'Outdoor' : 'Indoor'}</span>`);
    if (derived.nowId === node.id) chips.push('<span class="mz-map-chip is-accent">Now</span>');

    const flags = flagsShown ? flagsFor(node) : [];
    const thumb = thumbOf(node);
    const rooms = node.children
        .map(id => atlas.nodes[id])
        .filter(kid => kid && kid.kind !== 'mobile' && kid.kind !== 'transient').length;

    els.detail.innerHTML = `
        ${thumb ? `<div class="mz-map-hero"><img alt="" src="${esc(thumb)}"></div>` : ''}
        <div class="mz-map-card">
            <div><h3>${esc(node.name)}</h3><p class="mz-map-crumb">${esc(path.slice(0, -1).join(' \u203a ') || 'Top level')}</p></div>
            <div class="mz-map-chips">${chips.join('')}</div>
            ${mobile && rooms ? `<button class="mz-btn-ghost mz-map-lookinside" type="button" data-mz-map-inside="${esc(node.key)}">Look inside \u00b7 ${rooms} ${rooms === 1 ? 'room' : 'rooms'}</button>` : ''}
            ${flags.length ? `<ul class="mz-map-flags">${flags.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}
            ${seenHtml(node)}
            ${whoHtml(node.id)}
            ${legsHtml(node)}
        </div>`;
}

/* ---------- the chart on screen: pan and zoom ---------- */

/* ---------- the terrain record ---------- */

/** The world's top-level places - the record's region keys. */
function terrainRegions() {
    return (layout?.roots || []).map(root => ({ fold: root.n.fold, name: root.n.name }));
}

/* What the watcher's pictures were painted from, one bucket per region:
   every place's name, and the stored background words of the scenes that
   ended there. */
function terrainTexts() {
    const texts = {};
    for (const item of layout.order) {
        const node = item.n;
        let top = node;
        while (top.parentId) top = atlas.nodes[top.parentId];
        const bucket = texts[top.fold] || (texts[top.fold] = []);
        bucket.push(node.name);
        for (let i = node.visits.length - 1; i >= 0; i -= 1) {
            const obsIndex = node.visits[i];
            if (atlas.observations[obsIndex]?.nodeId !== node.id) continue;
            const prompt = recordFor(obsIndex)?.prompt;
            if (prompt) {
                bucket.push(String(prompt));
                break;
            }
        }
    }
    return texts;
}

/* Sampled pixels per picture, kept forever: deriving twice must not
   re-read every image. */
const terrainPixels = new Map();

function samplePicture(src) {
    if (!src) return Promise.resolve([]);
    if (terrainPixels.has(src)) return terrainPixels.get(src);
    const promise = new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 16;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0, 16, 16);
                const data = ctx.getImageData(0, 0, 16, 16).data;
                const out = [];
                for (let i = 0; i < data.length; i += 16) out.push([data[i], data[i + 1], data[i + 2]]);
                resolve(out);
            } catch {
                resolve([]); // a tainted canvas: the seeded palette stands in
            }
        };
        image.onerror = () => resolve([]);
        image.src = src;
    });
    terrainPixels.set(src, promise);
    return promise;
}

/* A couple of pictures per region is plenty to read a palette from - and
   the watcher may have painted many. */
async function terrainSamples() {
    const samples = {};
    const jobs = [];
    for (const root of layout.roots) {
        const bucket = samples[root.n.fold] = [];
        let taken = 0;
        for (const node of [root.n, ...descend(root.n)]) {
            if (taken >= 2) break;
            let src = '';
            for (let i = node.visits.length - 1; i >= 0; i -= 1) {
                const obsIndex = node.visits[i];
                if (atlas.observations[obsIndex]?.nodeId !== node.id) continue;
                src = recordSrc(recordFor(obsIndex));
                if (src) break;
            }
            if (!src) continue;
            taken += 1;
            jobs.push(samplePicture(src).then(pixels => bucket.push(...pixels)));
        }
    }
    await Promise.all(jobs);
    return samples;
}

/** The record this chat's land deserves, derived whole by code. */
async function deriveRecordForChat() {
    return {
        ...deriveTerrainRecord({
            regions: terrainRegions(),
            textsByRegion: terrainTexts(),
            samplesByRegion: await terrainSamples(),
            observations: atlas.observations || [],
        }),
        auto: true,
    };
}

/* The record to draw with: the user's if they have taken the pen, the
   derived one while it follows the story, and a fresh derivation asked for
   in the background the moment the story grows past its record. */
function terrainRecordForDraw(signature) {
    const stored = terrainStore();
    if (stored && stored.auto === false) return stored;
    if (stored && terrainDerivedSig === signature) return stored;
    if (!terrainRecordPending) {
        terrainRecordPending = true;
        const chatSig = lastSignature;
        deriveRecordForChat().then(record => {
            terrainRecordPending = false;
            if (!record || lastSignature !== chatSig) return;
            if (terrainStore()?.auto === false) return; // the user took the pen
            const same = terrainStore() && JSON.stringify(terrainStore()) === JSON.stringify(record);
            terrainDerivedSig = signature;
            if (!same) {
                saveTerrainRecord(record);
                terrainStory = null; // the land re-reads the record next frame
                scheduleTerrain();
            }
        }).catch(error => {
            terrainRecordPending = false;
            console.warn('[Meziverse map] terrain record:', error);
        });
    }
    return stored || null;
}

/** The terrain record for the open chat, or null before one exists. */
export function terrainRecordView() {
    return terrainStore() || null;
}

/**
 * Saves a hand-edited terrain record. The map follows at once.
 *
 * @param {string|object} input JSON text or a parsed record
 * @returns {{ok:true, record:object}|{ok:false, error:string}}
 */
export function writeTerrainRecord(input) {
    const result = validateTerrainRecord(input);
    if (!result.ok) return result;
    const record = { ...result.record, auto: false };
    saveTerrainRecord(record);
    terrainStory = null;
    scheduleTerrain();
    return { ok: true, record };
}

/** Reseed the noise behind the land - same story, new shores. */
export function reseedTerrainRecord() {
    const current = terrainStore();
    if (!current) return rederiveTerrainRecord();
    const record = { ...current, seed: (Number(current.seed) || 0) + 1, auto: false };
    saveTerrainRecord(record);
    terrainStory = null;
    scheduleTerrain();
    return { ok: true, record };
}

/** Throw the record away and derive a fresh one from the story as it is. */
export async function rederiveTerrainRecord() {
    if (!atlas || !layout) return null;
    const signature = `${lastSignature}|${layoutDepth}`;
    terrainDerivedSig = null;
    try {
        const record = await deriveRecordForChat();
        if (!record) return null;
        terrainDerivedSig = signature;
        saveTerrainRecord(record);
        terrainStory = null;
        scheduleTerrain();
        return record;
    } catch (error) {
        console.warn('[Meziverse map] terrain record:', error);
        return null;
    }
}

/* ---------- the land under the chart ---------- */

function ensureTerrain() {
    if (terrain || terrainCanvas || !els.stage) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'mz-terrain';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    els.stage.prepend(canvas);
    const make = () => {
        terrain = createTerrain(canvas, { quality: matchMedia('(pointer:coarse)').matches ? 1 : 2 });
        if (terrain) terrainStory = null;
    };
    make();
    if (!terrain) {
        canvas.remove();
        terrainCanvas = null;
        return;
    }
    terrainCanvas = canvas;
    /* a GPU reset is not the map's problem: the land goes away whole and
       comes back when the browser is ready, and the chart never notices */
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        terrain = null;
        terrainStory = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
        make();
        renderWin();
    });
}

function scheduleTerrain() {
    if (!terrainRaf) {
        terrainRaf = requestAnimationFrame(() => {
            terrainRaf = 0;
            drawTerrain();
        });
    }
}

function drawTerrain() {
    ensureTerrain();
    if (!terrainCanvas) return;
    const on = terrainLayerOn() && !win.hidden && document.visibilityState !== 'hidden' && atlas && layout;
    terrainCanvas.hidden = !on;
    if (!on) return;
    /* the story texture is baked per (chat, depth) - rare, and never stale */
    const signature = `${lastSignature}|${layoutDepth}`;
    if (terrainStory !== signature) {
        terrainStory = signature;
        const fresh = chartWalks && chartWalks.sig === signature ? chartWalks.walks : null;
        terrain.updateScene({ layout, atlas, derived, walks: fresh, record: terrainRecordForDraw(signature) });
    }
    /* quality: the settings row speaks, a slow frame steps down and is
       remembered - one land, whatever the GPU can carry */
    const wantQuality = Math.max(0, Math.min(TERRAIN_QUALITY.length - 1, Number(settings().mapTerrainQ) || 0));
    if (wantQuality !== terrainQuality) {
        terrainQuality = wantQuality;
        terrain.setQuality(wantQuality);
    }
    const animate = settings().mapTerrainAnim && !settings().reducedMotion;
    const nowMs = performance.now();
    /* the drift breathes at about 30fps - but a fresh view (or scene) draws
       at once: only the idle animation is ever paced */
    if (animate && !terrainDirty && nowMs - terrainLastDraw < 32) {
        scheduleTerrain();
        return;
    }
    terrainDirty = false;
    terrainLastDraw = nowMs;
    /* the sky over the land: the scene's own hour and weather - dawn light,
       night tint, rain on the hills - or a plain day when the story has
       said nothing. The flat chart stays itself. */
    const scene = atlas.observations?.[atlas.observations.length - 1] || null;
    const skyOn = !!settings().mapTerrainSky && settings().mapTerrain !== 'flat';
    terrain.draw({
        width: els.stage.clientWidth,
        height: els.stage.clientHeight,
        dpr: window.devicePixelRatio || 1,
        tx: view.tx,
        ty: view.ty,
        s: view.s,
        interact: performance.now() - lastViewChange < 140,
        time: animate ? (performance.now() - terrainT0) / 1000 : 0,
        fog: !!settings().mapTerrainFog && settings().mapTerrain !== 'flat',
        fogOnly: settings().mapTerrain === 'flat',
        sky: skyOn && scene ? skyFor(scene.hour) : null,
        weather: skyOn && scene ? weatherFx(scene.weather) : null,
        acc: mapInk(terrainStore() || {}),
    });
    // how many frames the land has drawn - the quiet proof it is alive
    terrainCanvas.dataset.draws = String((Number(terrainCanvas.dataset.draws) || 0) + 1);
    if (ALIGN_DEBUG) {
        const badge = els.chart.querySelector('[data-mz-align-badge]');
        if (badge) badge.textContent = `${terrainCanvas.width}\u00d7${terrainCanvas.height} \u00b7 ${TERRAIN_QUALITY[terrain.quality].name}`;
    }
    if (animate) scheduleTerrain();
}

function drawChart() {
    if (win.hidden || !atlas) return;
    ensureTerrain();
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    if (lastSize && (lastSize.w !== width || lastSize.h !== height)) {
        // the stage resized under us (the window, the rails): keep the view's
        // center rather than letting the content slide off the chart
        view.tx += (width - lastSize.w) / 2;
        view.ty += (height - lastSize.h) / 2;
    }
    lastSize = { w: width, h: height };
    if (!view.placed) {
        fit();
        view.placed = true;
        if (insideKey) insideBaseS = view.s;
    }
    els.chart.innerHTML = (ALIGN_DEBUG ? '<div class="mz-align-badge" data-mz-align-badge></div>' : '')
        + (insideKey ? deckBar() : '') + fullSvg(width, height, insideKey ? 'deck' : 'full');
    bindChart();
    terrainDirty = true;
    scheduleTerrain();
}

/** The deck's exit bar: the ship's name, and the way back to the world. */
function deckBar() {
    const ship = insideKey ? findByKey(insideKey) : null;
    return `<div class="mzc-deckbar"><button type="button" data-mz-map-deckexit title="Back to the world map" aria-label="Back to the world map">\u2190</button><b>${esc(ship ? ship.name : '')}</b><span>inside</span><button type="button" class="mz-btn-ghost" data-mz-map-deckexit>World map</button></div>`;
}

function applyTransform() {
    const chart = els.chart.querySelector('.mzc');
    if (!chart) return;
    const world = chart.querySelector('.mzc-world');
    if (world) world.style.transform = worldMatrix(view);
    chart.dataset.zoom = view.s < 0.5 ? 0 : view.s < 1.1 ? 1 : 2;
    terrainDirty = true;
    lastViewChange = performance.now();
    /* the land draws soft while the hand moves, then once more sharp */
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        terrainDirty = true;
        scheduleTerrain();
    }, 150);
    scheduleTerrain();
}

/** The scale fit() would pick. The zoom floor lives just below it, so every
    map can always zoom back out to its own fitted world - a house and a
    travel world keep their own floors. */
function fitScale() {
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    const bounds = activeLayout().bounds;
    const margin = 70;
    return Math.max(0.02, Math.min(1.25,
        Math.min((width - margin * 2) / Math.max(1, bounds.x1 - bounds.x0),
            (height - margin * 2) / Math.max(1, bounds.y1 - bounds.y0))));
}

const zoomMin = () => Math.min(0.35, fitScale() * 0.85);

/** Where fit() would put the view - the target a glide can fly to. */
function fitTarget() {
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    const bounds = activeLayout().bounds;
    const spanX = bounds.x1 - bounds.x0;
    const spanY = bounds.y1 - bounds.y0;
    const s = fitScale();
    return {
        s,
        tx: width / 2 - (bounds.x0 + spanX / 2) * s,
        ty: height / 2 - (bounds.y0 + spanY / 2) * s + 16,
    };
}

function fit() {
    Object.assign(view, fitTarget());
}

/** Where centerOn() would put the view - the target a glide can fly to. */
function centerTarget(x, y, scale) {
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    return { s: scale, tx: width / 2 - x * scale, ty: height / 2 - y * scale };
}

function centerOn(x, y, scale) {
    Object.assign(view, centerTarget(x, y, scale));
}

/* The view glides in JS so the land and the chart share every frame. A CSS
   transition here would move the SVG alone while the terrain jumps to the
   final view - the two drifting apart is exactly what "the land is a
   separate picture" feels like. */
let glideRaf = 0;

function glideCancel() {
    if (glideRaf) cancelAnimationFrame(glideRaf);
    glideRaf = 0;
}

function glideTo(target, ms = 420) {
    glideCancel();
    if (settings().reducedMotion) {
        Object.assign(view, target);
        applyTransform();
        return;
    }
    const from = { tx: view.tx, ty: view.ty, s: view.s };
    const t0 = performance.now();
    const step = now => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - (1 - k) ** 3;
        view.s = from.s * (target.s / from.s) ** e;
        view.tx = from.tx + (target.tx - from.tx) * e;
        view.ty = from.ty + (target.ty - from.ty) * e;
        applyTransform();
        if (k < 1) glideRaf = requestAnimationFrame(step);
        else glideRaf = 0;
    };
    glideRaf = requestAnimationFrame(step);
}

function zoomBy(direction) {
    const width = els.stage.clientWidth / 2;
    const height = els.stage.clientHeight / 2;
    const next = clamp(view.s * (direction > 0 ? 1.35 : 1 / 1.35), zoomMin(), 6);
    if (insideKey && next < insideBaseS * 0.82) {
        // zooming out of a ship's deck lands back on the world map
        exitInside();
        return;
    }
    glideTo({
        s: next,
        tx: width - (width - view.tx) * (next / view.s),
        ty: height - (height - view.ty) * (next / view.s),
    });
}

/**
 * Enters a vehicle's deck: the chart shows only its rooms - the ship as its
 * own little world. The exit is the bar, Esc, or zooming out past the fit.
 *
 * @param {string} key the vehicle's stable key
 */
function enterInside(key) {
    const node = key && findByKey(key);
    if (!node || node.kind !== 'mobile' || !node.children.length) return;
    insideKey = node.key;
    ensure();
    view.placed = false;
    renderWin();
}

/** Back out to the world map. */
function exitInside() {
    if (!insideKey) return;
    insideKey = null;
    deckLayout = null;
    view.placed = false;
    renderWin();
}

let pan = null;
let lastClick = { key: null, at: 0 };

function bindChart() {
    const chart = els.chart.querySelector('.mzc');
    if (!chart) return;

    /* a picture that never arrives falls back to the glyph beneath it -
       never a broken-image icon */
    chart.querySelectorAll('image').forEach(image => {
        image.addEventListener('error', () => image.remove());
    });

    chart.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        glideCancel();
        pan = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
        try { chart.setPointerCapture(event.pointerId); } catch { /* the pointer went away mid-gesture */ }
    });
    chart.addEventListener('pointermove', event => {
        if (!pan) return;
        const dx = event.clientX - pan.x;
        const dy = event.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) < 4) return;
        pan.moved = true;
        chart.classList.add('is-panning');
        view.tx = pan.tx + dx;
        view.ty = pan.ty + dy;
        applyTransform();
    });
    const endPan = event => {
        if (!pan) return;
        const moved = pan.moved;
        pan = null;
        chart.classList.remove('is-panning');
        if (moved) return;
        // Pointer capture retargets pointerup at the canvas - the swallowed
        // target would never name the pin under the cursor. Hit-test at the
        // click's coordinates instead.
        const under = document.elementFromPoint(event.clientX, event.clientY);
        const hit = under && under.closest ? under.closest('[data-node]') : null;
        const key = hit ? hit.dataset.node : null;
        // A second click on one ship steps inside it - a real dblclick event
        // can never fire here, the first click's re-render replaces the node.
        const pair = key && key === lastClick.key && Date.now() - lastClick.at < 450;
        lastClick = pair ? { key: null, at: 0 } : { key, at: Date.now() };
        const node = pair ? findByKey(key) : null;
        if (node && node.kind === 'mobile') {
            enterInside(node.key);
            return;
        }
        select(key, false);
    };
    chart.addEventListener('pointerup', endPan);
    chart.addEventListener('pointercancel', () => {
        pan = null;
        chart.classList.remove('is-panning');
    });
    chart.addEventListener('wheel', event => {
        event.preventDefault();
        glideCancel();
        const rect = chart.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0016);
        const next = clamp(view.s * factor, zoomMin(), 6);
        if (insideKey && next < insideBaseS * 0.82) {
            exitInside();
            return;
        }
        view.tx = px - (px - view.tx) * (next / view.s);
        view.ty = py - (py - view.ty) * (next / view.s);
        view.s = next;
        applyTransform();
    }, { passive: false });

    chart.querySelectorAll('.mzc-pin, .mzc-ship, .mzc-stopmark').forEach(pin => {
        pin.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(pin.dataset.node, true);
            }
        });
    });
}

function select(key, panThere) {
    const node = key ? findByKey(key) : null;
    selectedKey = node ? key : null;
    visitsExpanded = false;

    // The chart follows the selection: a room (or a stop on a trail) steps
    // into its ship's deck, another ship swaps the deck, a place on the
    // ground steps back out to the world. Picking the ship itself just
    // opens its card - the second click steps inside.
    if (node && atlas) {
        let at = node;
        while (at && at.kind !== 'mobile') at = at.parentId ? atlas.nodes[at.parentId] : null;
        const ship = at && at.children.length ? at : null;
        // enter on a room of another ship, or on a ship while already below
        // decks (shuffling vehicles swaps the deck); on the world the ship's
        // first click stays a card
        if (ship && insideKey !== ship.key && (ship !== node || insideKey)) {
            enterInside(ship.key);
            return;
        }
        if (!ship && insideKey) exitInside();
    }

    if (panThere && selectedKey) {
        const item = anchorOf(selectedKey);
        if (item) glideTo(centerTarget(item.ax, item.ay, Math.max(view.s, item.pin ? 1.4 : 0.9)));
    }
    renderIndex();
    renderDetail();
    drawChart();
    requestAnimationFrame(applyTransform);
}

/* ---------- wiring ---------- */

function wireWidget() {
    widget.addEventListener('click', event => {
        if (drag && drag.moved) return;
        const zoom = event.target.closest('[data-mz-mini-zoom]');
        if (zoom) {
            stepMiniZoom(Number(zoom.dataset.mzMiniZoom));
            return;
        }
        if (event.target.closest('[data-mz-map-open]')) openMapWin();
    });
    els.mini?.addEventListener('wheel', event => {
        if (els.mini.hidden) return;
        event.preventDefault();
        stepMiniZoom(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    wireDrag();
}

/** The minimap's crop zoom: one step closer or further out, remembered. */
function stepMiniZoom(direction) {
    const next = clamp((Number(settings().mapMiniZoom) || 1) * (direction > 0 ? 1.25 : 0.8), 0.6, 2.2);
    settings().mapMiniZoom = Math.round(next * 100) / 100;
    saveSettings();
    if (els.miniSvg && !els.mini.hidden) els.miniSvg.innerHTML = miniSvg();
}

/* The minimap's corner grip: the window grows to whatever the user wants
   and remembers it. Its own capture, and no bubbling to the window's drag. */
function wireMiniResize() {
    els.miniGrip?.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        event.preventDefault();
        event.stopPropagation();
        miniSizing = true;
        const start = {
            x: event.clientX,
            y: event.clientY,
            w: widget.offsetWidth,
            h: els.mini.offsetHeight,
        };
        els.miniGrip.setPointerCapture(event.pointerId);
        const move = event => {
            widget.style.width = `${clamp(start.w + event.clientX - start.x, 180, 420)}px`;
            els.mini.style.height = `${clamp(start.h + event.clientY - start.y, 110, 380)}px`;
        };
        const up = () => {
            els.miniGrip.removeEventListener('pointermove', move);
            els.miniGrip.removeEventListener('pointerup', up);
            miniSizing = false;
            settings().mapMiniSize = {
                w: parseFloat(widget.style.width) || 0,
                h: parseFloat(els.mini.style.height) || 0,
            };
            saveSettings();
            positionWidget();
        };
        els.miniGrip.addEventListener('pointermove', move);
        els.miniGrip.addEventListener('pointerup', up);
    });
}

/* The minimap window drags by ANY spot on it - the 4px threshold separates
   a drag from a click, and the widget's click handler drops clicks after
   one. What used to eat the pointer was the NATIVE image drag: a pin's
   picture is draggable like any image, and grabbing one cancelled the
   pointer mid-press. A dragstart here is never a drag there. */
function wireDrag() {
    widget.addEventListener('dragstart', event => event.preventDefault());
    widget.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        const rect = widget.getBoundingClientRect();
        const frameRect = frameEl.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
            fx: frameRect.left,
            fy: frameRect.top,
        };
    });
    widget.addEventListener('pointermove', event => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            /* Capture only once this IS a drag. Capturing on pointerdown
               would retarget the click at the widget and every button on it
               would go dead. */
            try { widget.setPointerCapture(drag.pointerId); } catch { /* the pointer went away mid-gesture */ }
        }
        widget.classList.add('is-dragging');
        const x = clamp(event.clientX - drag.fx - drag.dx, EDGE, frameEl.clientWidth - widget.offsetWidth - EDGE);
        const y = clamp(event.clientY - drag.fy - drag.dy, EDGE, frameEl.clientHeight - widget.offsetHeight - EDGE);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
    });
    const endDrag = () => {
        if (!drag) return;
        const moved = drag.moved;
        widget.classList.remove('is-dragging');
        if (moved) {
            settings().mapPos = {
                x: parseFloat(widget.style.left) || 0,
                y: parseFloat(widget.style.top) || 0,
            };
            saveSettings();
        }
        setTimeout(() => { drag = null; }, 0);
    };
    widget.addEventListener('pointerup', endDrag);
    widget.addEventListener('pointercancel', endDrag);
}

/** The window's spot: the saved one, else the bottom-left corner. */
function positionWidget() {
    if (!widget || widget.hidden || drag) return;

    const frameW = frameEl?.clientWidth || window.innerWidth;
    const frameH = frameEl?.clientHeight || window.innerHeight;
    const pos = settings().mapPos;
    const saved = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);

    const x = clamp(saved ? pos.x : EDGE, EDGE, Math.max(EDGE, frameW - widget.offsetWidth - EDGE));
    const y = clamp(saved ? pos.y : frameH - widget.offsetHeight - EDGE, EDGE, Math.max(EDGE, frameH - widget.offsetHeight - EDGE));

    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
}

/* ---------- the full window: move, resize, remember ---------- */

/**
 * Pins the window to an explicit box (left/top/width/height inline) - the
 * state a drag or resize leaves it in, versus the CSS default of centred.
 */
function placeWinExplicit() {
    if (win.classList.contains('is-placed')) return;
    const rect = win.getBoundingClientRect();
    const frameRect = frameEl.getBoundingClientRect();
    win.classList.add('is-placed');
    win.style.left = `${rect.left - frameRect.left}px`;
    win.style.top = `${rect.top - frameRect.top}px`;
    win.style.width = `${rect.width}px`;
    win.style.height = `${rect.height}px`;
}

function resetWinPlace() {
    win.classList.remove('is-placed');
    win.style.left = win.style.top = win.style.width = win.style.height = '';
}

function saveWinPlace() {
    if (!win.classList.contains('is-placed')) return;
    settings().mapWinPos = {
        x: parseFloat(win.style.left) || 0,
        y: parseFloat(win.style.top) || 0,
    };
    settings().mapWinSize = {
        w: parseFloat(win.style.width) || 0,
        h: parseFloat(win.style.height) || 0,
    };
    saveSettings();
}

/** The window's remembered box, kept inside the frame - or the centred default. */
function applyWinPlace() {
    if (!win || win.hidden || winDrag || winSizing) return;

    if (window.innerWidth <= NARROW) {
        resetWinPlace();
        return;
    }

    const pos = settings().mapWinPos;
    const size = settings().mapWinSize;
    const hasPlace = !!pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);
    const hasSize = !!size && Number.isFinite(size.w) && Number.isFinite(size.h);
    if (!hasPlace && !hasSize) return;

    placeWinExplicit();
    if (hasSize) {
        win.style.width = `${clamp(size.w, 680, Math.max(680, frameEl.clientWidth - 2 * EDGE))}px`;
        win.style.height = `${clamp(size.h, 440, Math.max(440, frameEl.clientHeight - 2 * EDGE))}px`;
    }
    if (hasPlace) {
        win.style.left = `${clamp(pos.x, EDGE, Math.max(EDGE, frameEl.clientWidth - win.offsetWidth - EDGE))}px`;
        win.style.top = `${clamp(pos.y, EDGE, Math.max(EDGE, frameEl.clientHeight - win.offsetHeight - EDGE))}px`;
    }
}

/* The full map window moves by its header and resizes by its corner. The
   header's own controls still click - the threshold separates the two. */
function wireWinDrag() {
    win.addEventListener('dragstart', event => event.preventDefault());

    els.winHead?.addEventListener('pointerdown', event => {
        if (event.button > 0 || event.target.closest('input, textarea')) return;
        winDrag = {
            pointerId: event.pointerId,
            dx: event.clientX - win.getBoundingClientRect().left,
            dy: event.clientY - win.getBoundingClientRect().top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
        };
    });
    els.winHead?.addEventListener('pointermove', event => {
        if (!winDrag) return;
        if (!winDrag.moved && Math.hypot(event.clientX - winDrag.x0, event.clientY - winDrag.y0) < 4) return;
        if (!winDrag.moved) {
            winDrag.moved = true;
            /* Capture only once this IS a drag: a capture on pointerdown
               would retarget the click and kill the header's own buttons
               (close, detail depth). */
            placeWinExplicit();
            try { els.winHead.setPointerCapture(winDrag.pointerId); } catch { /* the pointer went away mid-gesture */ }
        }
        win.classList.add('is-moving');
        const frameRect = frameEl.getBoundingClientRect();
        const x = clamp(event.clientX - frameRect.left - winDrag.dx, EDGE, frameEl.clientWidth - win.offsetWidth - EDGE);
        const y = clamp(event.clientY - frameRect.top - winDrag.dy, EDGE, frameEl.clientHeight - win.offsetHeight - EDGE);
        win.style.left = `${x}px`;
        win.style.top = `${y}px`;
    });
    const endMove = () => {
        if (!winDrag) return;
        const moved = winDrag.moved;
        win.classList.remove('is-moving');
        if (moved) saveWinPlace();
        setTimeout(() => { winDrag = null; }, 0);
    };
    els.winHead?.addEventListener('pointerup', endMove);
    els.winHead?.addEventListener('pointercancel', endMove);

    /* A double-click on the header puts the window back to centre. */
    els.winHead?.addEventListener('dblclick', event => {
        if (event.target.closest('button, input, textarea')) return;
        settings().mapWinPos = null;
        settings().mapWinSize = null;
        saveSettings();
        resetWinPlace();
    });

    els.winGrip?.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        event.preventDefault();
        event.stopPropagation();
        placeWinExplicit();
        winSizing = true;
        const start = { x: event.clientX, y: event.clientY, w: win.offsetWidth, h: win.offsetHeight };
        els.winGrip.setPointerCapture(event.pointerId);
        const move = event => {
            const frameRect = frameEl.getBoundingClientRect();
            const rect = win.getBoundingClientRect();
            win.style.width = `${clamp(start.w + event.clientX - start.x, 680, Math.max(680, frameRect.right - rect.left - EDGE))}px`;
            win.style.height = `${clamp(start.h + event.clientY - start.y, 440, Math.max(440, frameRect.bottom - rect.top - EDGE))}px`;
            /* the chart and the land re-render at the new size as it grows -
               CSS-stretching would scale the blobs but leave the terrain at
               its old pixels */
            if (!resizeQueued) {
                resizeQueued = true;
                requestAnimationFrame(() => {
                    resizeQueued = false;
                    drawChart();
                });
            }
        };
        const up = () => {
            els.winGrip.removeEventListener('pointermove', move);
            els.winGrip.removeEventListener('pointerup', up);
            winSizing = false;
            drawChart();
            saveWinPlace();
        };
        els.winGrip.addEventListener('pointermove', move);
        els.winGrip.addEventListener('pointerup', up);
    });
}

function wireWin() {
    win.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;

        if (button.hasAttribute('data-mz-map-close')) {
            closeMapWin();
        } else if (button.hasAttribute('data-mz-map-deckexit')) {
            exitInside();
        } else if (button.dataset.mzMapInside !== undefined) {
            enterInside(button.dataset.mzMapInside);
        } else if (button.dataset.mzMapTwist !== undefined) {
            twistState.set(button.dataset.mzMapTwist, button.getAttribute('aria-expanded') !== 'true');
            renderIndex();
        } else if (button.hasAttribute('data-mz-map-more')) {
            visitsExpanded = !visitsExpanded;
            renderDetail();
        } else if (button.hasAttribute('data-mz-map-pick') || button.dataset.mzMapPick !== undefined) {
            select(button.dataset.mzMapPick, true);
        } else if (button.dataset.mzMapDepth) {
            const order = [2, 3, 4, 99];
            const at = order.indexOf(depthValue());
            settings().mapDepth = order[clamp(at + Number(button.dataset.mzMapDepth), 0, 3)];
            saveSettings();
            ensure();
            view.placed = false;
            renderWin();
        } else if (button.dataset.mzMapLook) {
            settings().mapTerrain = button.dataset.mzMapLook;
            saveSettings();
            renderWin();
        } else if (button.dataset.mzMapLayer) {
            const layer = button.dataset.mzMapLayer;
            if (layer === 'trails') trails = !trails;
            else if (layer === 'flags') flagsShown = !flagsShown;
            else if (layer === 'fog' && settings().mapTerrain !== 'flat') {
                settings().mapTerrainFog = !settings().mapTerrainFog;
                saveSettings();
            }
            button.setAttribute('aria-pressed', String(
                layer === 'trails' ? trails : layer === 'flags' ? flagsShown : !!settings().mapTerrainFog));
            renderWin();
        } else if (button.dataset.mzMapZoom) {
            zoomBy(Number(button.dataset.mzMapZoom));
        } else if (button.hasAttribute('data-mz-map-fit')) {
            glideTo(fitTarget());
        } else if (button.hasAttribute('data-mz-map-now')) {
            const item = (insideKey ? activeLayout().anchor(derived?.nowId || '') : nowAnchor()) || null;
            if (item) {
                glideTo(centerTarget(item.ax, item.ay, Math.max(view.s, 1.3)));
            }
        }
    });

    win.addEventListener('click', event => {
        const goto = event.target.closest('[data-mz-map-goto]');
        if (!goto) return;
        const index = Number(goto.dataset.mzMapGoto);
        if (Number.isInteger(index) && index >= 0) {
            closeMapWin();
            gotoTurn?.(index);
        }
    });

    els.find?.addEventListener('input', renderIndex);
    els.find?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            const first = els.index.querySelector('[data-mz-map-pick]');
            if (first) select(first.dataset.mzMapPick, true);
        }
    });

    win.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (insideKey) exitInside();
        else closeMapWin();
    });
}
