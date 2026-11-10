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
} from './mapdata.js';
import { recordSrc } from './backgrounds.js';
import { bgStore, chatMessages, currentChatId, on, personaName } from './st.js';
import { mapMiniOn, mapOn, saveSettings, settings } from './settings.js';

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
let trails = true;
let flagsShown = true;
let view = { tx: 0, ty: 0, s: 1, placed: false };
let lastFocus = null;

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const trunc = (value, max) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
};
const f1 = value => Math.round(value * 10) / 10;

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
            <div class="mz-map-seg">
                <button type="button" aria-pressed="true" data-mz-map-layer="trails">${svg('m-route')}Journeys</button>
                <button type="button" aria-pressed="true" data-mz-map-layer="flags">Flags</button>
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

function ensure() {
    const chatId = currentChatId();
    if (chatId !== lastChatId) {
        lastChatId = chatId;
        lastSignature = null;
        selectedKey = null;
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
        layout = layoutAtlas(atlas, { depth });
    }
}

function findByKey(key) {
    return atlas ? Object.values(atlas.nodes).find(node => node.key === key) || null : null;
}

function anchorOf(key) {
    const node = findByKey(key);
    return node && layout ? layout.anchor(node.id) : null;
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

/** The background record one observation's reply carries, or null. */
function recordFor(obsIndex) {
    const obs = atlas.observations[obsIndex];
    const message = chatMessages()[obs?.at?.msgIndex ?? -1];
    const id = message ? activeStamp(message) : null;
    return id ? bgStore().records?.[id] || null : null;
}

/**
 * The place's latest drawn picture, or '' (the map glyph stands in). Only
 * scenes that ENDED at this place speak for its picture - a scene merely
 * passing through (the region above, the container around) drew the dot at
 * the end of the chain, not the chain's earlier links. That is also the
 * details rule: images belong to last locations in the chain, never to a
 * region or territory.
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
    const nodes = atlas.nodes;
    const selNode = selectedKey ? findByKey(selectedKey) : null;
    const sel = selNode ? selNode.id : null;

    /* which pins carry a flag of their own (or below them) */
    const flagged = new Set();
    const sameFlags = flagsShown ? atlas.flags.same.filter(([a, b]) => layout.items[a] || layout.items[b]) : [];
    if (flagsShown) {
        sameFlags.forEach(([a, b]) => {
            flagged.add(a);
            flagged.add(b);
        });
        Object.values(nodes).forEach(node => {
            if (atlas.flags.ambiguous.includes(node.fold) || atlas.flags.mobilePending.includes(node.fold)) flagged.add(node.id);
        });
    }

    const nowItem = derived.nowId ? layout.anchor(derived.nowId) : null;
    const parts = [];

    /* ground and the contour rings that make land look like land */
    const containers = layout.order.filter(item => !item.pin);
    const rings = [];
    containers.filter(item => item.n.level === 0).forEach(item => {
        for (let k = 3; k >= 1; k -= 1) {
            rings.push(`<path class="mzc-ring r${k}" d="${blob(item.ax, item.ay, item.r + k * 15, hashFold(item.n.fold) + k, 0.11)}"/>`);
        }
    });
    parts.push(`<g class="mzc-rings">${rings.join('')}</g>`);

    /* territories: region, city, plot - biggest first so smaller sit on top */
    const terr = [];
    containers.slice().sort((a, b) => b.r - a.r).forEach(item => {
        const level = item.n.level;
        const cls = level === 0 ? 'region' : level === 1 ? 'city' : 'plot';
        const amp = level === 0 ? 0.12 : level === 1 ? 0.09 : 0.07;
        terr.push(`<path class="mzc-terr mzc-${cls}${sel === item.n.id ? ' is-sel' : ''}" data-node="${esc(item.n.key)}" d="${blob(item.ax, item.ay, item.r, hashFold(item.n.fold), amp)}"/>`);
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

    /* journeys: dotted legs, thicker the more travelled, the latest flowing */
    const legSvg = [];
    const modeSvg = [];
    const recent = derived.legs.slice().sort((a, b) => b.order - a.order);
    const lastKey = recent[0] && recent[0].key;
    const shown = new Set(mini ? recent.slice(0, 4).map(leg => leg.key) : derived.legs.map(leg => leg.key));
    const seen = new Map();
    derived.legs.forEach(leg => {
        if (!trails || !shown.has(leg.key)) return;
        const from = layout.anchor(leg.dir[0]);
        const to = layout.anchor(leg.dir[1]);
        if (!from || !to || from === to) return;

        const pairKey = [from.n.id, to.n.id].sort().join('|');
        const nth = seen.get(pairKey) || 0;
        seen.set(pairKey, nth + 1);

        const dx = to.ax - from.ax;
        const dy = to.ay - from.ay;
        const len = Math.hypot(dx, dy) || 1;
        const bow = (nth % 2 ? -1 : 1) * (0.16 + nth * 0.08) * len * (hashFold(pairKey) % 2 ? 1 : -1);
        const mx = (from.ax + to.ax) / 2 - dy / len * bow;
        const my = (from.ay + to.ay) / 2 + dx / len * bow;
        const width = Math.min(3.4, 1.4 + leg.count * 0.45);
        const isLast = leg.key === lastKey;

        legSvg.push(`<path class="mzc-leg${isLast ? ' is-last' : ''}${sel && (leg.a === sel || leg.b === sel) ? ' is-sel' : ''}" d="M${f1(from.ax)} ${f1(from.ay)}Q${f1(mx)} ${f1(my)} ${f1(to.ax)} ${f1(to.ay)}" style="stroke-width:${f1(width)}px"/>`);

        if (leg.mode && (!mini || isLast)) {
            const px = 0.25 * from.ax + 0.5 * mx + 0.25 * to.ax;
            const py = 0.25 * from.ay + 0.5 * my + 0.25 * to.ay;
            const size = mini ? 18 : 17;
            modeSvg.push(`<g class="mzc-mode${isLast ? ' is-last' : ''}" transform="translate(${f1(px)} ${f1(py)})"><title>${esc(leg.mode.name)} \u00b7 ${leg.count}\u00d7</title><circle r="${mini ? 13 : 12}"/>${icon(`m-${leg.mode.glyph}`, 0, 0, size)}</g>`);
        }
    });
    parts.push(`<g class="mzc-legs">${legSvg.join('')}</g>`);

    /* possible duplicates: a dotted tie, display only */
    if (flagsShown && !mini) {
        const ties = sameFlags.map(([a, b]) => {
            const p = layout.anchor(a);
            const q = layout.anchor(b);
            if (!p || !q || p === q) return '';
            return `<g class="mzc-same"><path d="M${f1(p.ax)} ${f1(p.ay)}L${f1(q.ax)} ${f1(q.ay)}"/><g transform="translate(${f1((p.ax + q.ax) / 2)} ${f1((p.ay + q.ay) / 2)})"><circle r="7"/><text y="3.2" text-anchor="middle">?</text></g></g>`;
        });
        parts.push(`<g class="mzc-ties">${ties.join('')}</g>`);
    }

    /* pins: each place is a small picture on the chart */
    const pins = [];
    const clipR = new Set();
    const recentIds = new Set();
    recent.slice(0, 3).forEach(leg => {
        recentIds.add(leg.dir[0]);
        recentIds.add(leg.dir[1]);
    });

    layout.order.filter(item => item.pin).forEach(item => {
        const node = item.n;
        const r = node.level >= 2 || (node.level === 1 && node.kind === 'spot') ? PIN_R : PIN_R + 2;
        const isNow = nowItem === item;
        const isSel = sel === node.id;
        const total = atlas.observations.length;
        const age = total ? (total - 1 - node.lastSeen) / total : 0;
        const img = thumbOf(node);
        const clip = `mzc-c${r}`;
        clipR.add(r);

        const flag = flagged.has(node.id) || (node.children.length && descend(node).some(child => flagged.has(child.id)));
        const people = isNow && derived.nowId ? Object.keys(derived.present[derived.nowId] || {}).slice(0, 3) : [];
        const parked = Object.values(nodes).find(vehicle => vehicle.kind === 'mobile'
            && vehicle.trajectory.length
            && layout.anchor(vehicle.trajectory[vehicle.trajectory.length - 1].positionId || '') === item);
        const label = mini ? (isNow || recentIds.has(node.id)) : true;
        const hiddenKids = node.children.filter(id => nodes[id].kind !== 'mobile' && nodes[id].kind !== 'transient').length;

        pins.push(`<g class="mzc-pin lv${Math.min(node.level ?? 3, 3)}${isNow ? ' is-now' : ''}${isSel ? ' is-sel' : ''}${flag ? ' is-flag' : ''}${mini && !label ? ' is-quiet' : ''}" data-node="${esc(node.key)}" transform="translate(${f1(item.ax)} ${f1(item.ay)})" style="--age:${f1(Math.max(0, Math.min(1, age)))}" tabindex="${mini ? -1 : 0}" role="button" aria-label="${esc(node.name)}">
        ${isNow ? `<circle class="mzc-ping" r="${r + 4}"/><circle class="mzc-ping p2" r="${r + 4}"/>` : ''}
        <circle class="mzc-pin-disc" r="${r}"/>
        ${img ? `<image href="${esc(img)}" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice" draggable="false"/>` : icon('map', 0, 0, r * 0.9)}
        <circle class="mzc-pin-ring" r="${r}"/>
        ${hiddenKids && !mini ? `<g class="mzc-count" transform="translate(${f1(r * 0.78)} ${f1(r * 0.78)})"><circle r="7.5"/><text y="3" text-anchor="middle">${hiddenKids}</text></g>` : ''}
        ${flag && !mini ? `<g class="mzc-flagdot" transform="translate(${f1(-r * 0.78)} ${f1(-r * 0.78)})"><circle r="6.5"/><text y="3.2" text-anchor="middle">!</text></g>` : ''}
        ${parked && !mini ? `<g class="mzc-parked" transform="translate(${f1(r * 0.8)} ${f1(-r * 0.8)})"><circle r="8"/>${icon(`m-${travelMode(parked.name).glyph}`, 0, 0, 10)}</g>` : ''}
        ${people.length ? `<g class="mzc-people">${people.map((name, k) => `<g transform="translate(${f1(-(people.length - 1) * 7 + k * 14)} ${-r - 11})"><circle r="7"/><text y="3" text-anchor="middle">${esc(name[0])}</text></g>`).join('')}</g>` : ''}
        ${label ? `<text class="mzc-pin-label" y="${r + 14}" text-anchor="middle">${esc(trunc(node.name, mini ? 16 : 20))}</text>` : ''}
        <title>${esc(node.name)}</title></g>`);
    });
    parts.push(`<g class="mzc-pins">${pins.join('')}</g><g class="mzc-modes">${modeSvg.join('')}</g>`);

    /* an unfinished journey: the story is still on the road */
    if (derived.inTransit && derived.fromId) {
        const from = layout.anchor(derived.fromId);
        if (from) {
            const angle = Math.atan2(from.ay - (layout.bounds.y0 + layout.bounds.y1) / 2, from.ax - (layout.bounds.x0 + layout.bounds.x1) / 2);
            const length = 70;
            const ex = from.ax + Math.cos(angle) * length;
            const ey = from.ay + Math.sin(angle) * length;
            const mode = derived.transitMode || travelMode('');
            parts.push(`<g class="mzc-open"><path class="mzc-leg is-last" d="M${f1(from.ax)} ${f1(from.ay)}L${f1(ex)} ${f1(ey)}"/><g class="mzc-mode is-last" transform="translate(${f1(ex)} ${f1(ey)})"><circle r="13"/>${icon(`m-${mode.glyph}`, 0, 0, 18)}</g></g>`);
        }
    }

    const defs = `<defs>${[...clipR].map(r => `<clipPath id="mzc-c${r}"><circle r="${r}"/></clipPath>`).join('')}</defs>`;
    return { defs, body: parts.join('') };
}

/* ---------- the two crops of one chart ---------- */

function fullSvg(width, height) {
    const out = renderChart('full');
    const tier = view.s < 0.5 ? 0 : view.s < 1.1 ? 1 : 2;
    return `<svg class="mzc" data-style="contour" data-zoom="${tier}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Map of the story's places">${out.defs}<g class="mzc-world" style="transform-origin:0 0;transform:translate(${f1(view.tx)}px,${f1(view.ty)}px) scale(${f1(view.s)})"><rect class="mzc-ground" x="-6000" y="-6000" width="12000" height="12000"/>${out.body}</g></svg>`;
}

function miniSvg() {
    const ratio = MINI_W / MINI_H;
    const out = renderChart('mini');
    const now = derived.nowId ? layout.anchor(derived.nowId) : null;
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

function renderWin() {
    if (!win || win.hidden) return;

    applyWinPlace();
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
    els.key.innerHTML = `<div><i class="k-now"></i>Where the story is</div><div><i class="k-pin"></i>A place, as last drawn</div><div><i></i>A journey, with how it went</div>${flagsShown && hasFlags ? '<div><i class="k-flag"></i>Needs a look</div>' : ''}`;

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

    const walk = (node, depth) => {
        if (node.kind === 'mobile' || node.kind === 'transient') return;
        if (query && !auto.has(node.key)) return;

        const kids = node.children
            .map(id => atlas.nodes[id])
            .filter(kid => kid && kid.kind !== 'mobile' && kid.kind !== 'transient');
        const open = isOpen(node);
        const twist = kids.length
            ? `<button class="mz-map-twist${open ? ' is-open' : ''}" type="button" data-mz-map-twist="${esc(node.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(node.name)}">${svg('chevdown')}</button>`
            : '<span class="mz-map-twist"></span>';

        rows.push(`<div class="mz-map-row d${Math.min(depth, 3)}${selectedKey === node.key ? ' is-sel' : ''}${derived.nowId === node.id ? ' is-now' : ''}">${twist}<button class="mz-map-pick" type="button" data-mz-map-pick="${esc(node.key)}"><span>${esc(node.name)}</span></button></div>`);
        if (open) kids.forEach(kid => walk(kid, depth + 1));
    };
    atlas.roots.forEach(id => walk(atlas.nodes[id], 0));

    const vehicles = Object.values(atlas.nodes).filter(node => node.kind === 'mobile');
    els.index.innerHTML = `<h4>Places</h4>${rows.join('')}${vehicles.length ? `<h4>Vehicles</h4>${vehicles.map(node => `<div class="mz-map-row d0${selectedKey === node.key ? ' is-sel' : ''}"><span class="mz-map-twist"></span><button class="mz-map-pick" type="button" data-mz-map-pick="${esc(node.key)}">${svg(`m-${travelMode(node.name).glyph}`)}<span>${esc(node.name)}</span></button></div>`).join('')}` : ''}`;
}

function seenHtml(node) {
    const total = atlas.observations.length;
    const ticks = node.visits.map((visit, k) => `<rect class="${k === node.visits.length - 1 ? 'is-last' : ''}" x="${(visit / Math.max(1, total - 1) * 96 + 1).toFixed(1)}%" y="5" width="2.6" height="12" rx="1.3"/>`).join('');
    const first = atlas.observations[node.visits[0]];
    const last = atlas.observations[node.visits[node.visits.length - 1]];
    return `<div class="mz-map-sect"><h4>Seen <i>${node.visits.length} scenes</i></h4><svg class="mz-map-seen" aria-hidden="true"><line x1="0" x2="100%" y1="11" y2="11"/>${ticks}</svg><div class="mz-map-span"><span>${esc(first?.date || '')}</span><span>${esc(last?.date || '')}</span></div></div>`;
}

function whoHtml(nodeId) {
    const counts = derived.present[nodeId] || {};
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) return '';
    return `<div class="mz-map-sect"><h4>Who has been here</h4><div class="mz-map-who">${top.map(([name, count]) => `<span><b>${esc(name[0])}</b>${esc(name)}<i>${count}</i></span>`).join('')}</div></div>`;
}

function legsHtml(node) {
    const mine = derived.legs
        .filter(leg => leg.a === node.id || leg.b === node.id)
        .sort((a, b) => b.order - a.order);
    if (!mine.length) return '';
    const rows = mine.map(leg => {
        const other = atlas.nodes[leg.a === node.id ? leg.b : leg.a];
        const dir = leg.dir[0] === node.id ? '\u2192' : '\u2190';
        const mode = leg.mode || travelMode('');
        return `<li>${svg(`m-${mode.glyph}`)}<span>${dir} ${esc(other.name)}</span><em>${esc(mode.label)}${leg.count > 1 ? ` \u00b7 ${leg.count}\u00d7` : ''}</em></li>`;
    });
    return `<div class="mz-map-sect"><h4>Journeys <i>${mine.length}</i></h4><ul class="mz-map-legs">${rows.join('')}</ul></div>`;
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
    const chips = [`<span class="mz-map-chip${mobile ? ' is-accent' : ''}">${mobile ? svg(`m-${travelMode(node.name).glyph}`) : ''}${mobile ? 'moves' : node.kind}</span>`];
    if (!mobile) chips.push(`<span class="mz-map-chip">${isOutdoor(node) ? 'Outdoor' : 'Indoor'}</span>`);
    if (derived.nowId === node.id) chips.push('<span class="mz-map-chip is-accent">Now</span>');

    const flags = flagsShown ? flagsFor(node) : [];
    const thumb = thumbOf(node);
    const visits = node.visits.slice(-5).reverse().map(index => {
        const obs = atlas.observations[index];
        const when = [obs.date, obs.time].filter(Boolean).join(' \u00b7 ');
        const bits = [when || 'undated'];
        if (obs.present?.length) bits.push(obs.present.join(', '));
        return `<li><span>${esc(bits.join(' \u00b7 '))}</span><button class="mz-btn-ghost mz-map-goto" type="button" data-mz-map-goto="${obs.at?.msgIndex ?? ''}">Turn ${(obs.at?.msgIndex ?? -1) + 1}</button></li>`;
    }).join('');

    els.detail.innerHTML = `
        ${thumb ? `<div class="mz-map-hero"><img alt="" src="${esc(thumb)}"></div>` : ''}
        <div class="mz-map-card">
            <div><h3>${esc(node.name)}</h3><p class="mz-map-crumb">${esc(path.slice(0, -1).join(' \u203a ') || 'Top level')}</p></div>
            <div class="mz-map-chips">${chips.join('')}</div>
            ${flags.length ? `<ul class="mz-map-flags">${flags.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}
            ${seenHtml(node)}
            ${whoHtml(node.id)}
            ${legsHtml(node)}
            <div class="mz-map-sect"><h4>Recent visits <i>${node.visits.length}</i></h4><ul class="mz-map-visits">${visits}</ul></div>
        </div>`;
}

/* ---------- the chart on screen: pan and zoom ---------- */

function drawChart() {
    if (win.hidden || !atlas) return;
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    if (!view.placed) {
        fit();
        view.placed = true;
    }
    els.chart.innerHTML = fullSvg(width, height);
    bindChart();
}

function applyTransform() {
    const chart = els.chart.querySelector('.mzc');
    if (!chart) return;
    const world = chart.querySelector('.mzc-world');
    if (world) world.style.transform = `translate(${f1(view.tx)}px,${f1(view.ty)}px) scale(${f1(view.s)})`;
    chart.dataset.zoom = view.s < 0.5 ? 0 : view.s < 1.1 ? 1 : 2;
}

function fit() {
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    const bounds = layout.bounds;
    const spanX = bounds.x1 - bounds.x0;
    const spanY = bounds.y1 - bounds.y0;
    const margin = 70;
    view.s = Math.min(1.25, Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY));
    view.tx = width / 2 - (bounds.x0 + spanX / 2) * view.s;
    view.ty = height / 2 - (bounds.y0 + spanY / 2) * view.s + 16;
}

function centerOn(x, y, scale) {
    const width = els.stage.clientWidth;
    const height = els.stage.clientHeight;
    view.s = scale;
    view.tx = width / 2 - x * view.s;
    view.ty = height / 2 - y * view.s;
}

function zoomBy(direction) {
    const width = els.stage.clientWidth / 2;
    const height = els.stage.clientHeight / 2;
    const next = clamp(view.s * (direction > 0 ? 1.35 : 1 / 1.35), 0.35, 3.2);
    view.tx = width - (width - view.tx) * (next / view.s);
    view.ty = height - (height - view.ty) * (next / view.s);
    view.s = next;
    applyTransform();
}

let pan = null;

function bindChart() {
    const chart = els.chart.querySelector('.mzc');
    if (!chart) return;

    chart.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        pan = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
        chart.setPointerCapture(event.pointerId);
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
        if (!moved) {
            const hit = event.target.closest && event.target.closest('[data-node]');
            select(hit ? hit.dataset.node : null, false);
        }
    };
    chart.addEventListener('pointerup', endPan);
    chart.addEventListener('pointercancel', () => {
        pan = null;
        chart.classList.remove('is-panning');
    });
    chart.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = chart.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0016);
        const next = clamp(view.s * factor, 0.35, 3.2);
        view.tx = px - (px - view.tx) * (next / view.s);
        view.ty = py - (py - view.ty) * (next / view.s);
        view.s = next;
        applyTransform();
    }, { passive: false });

    chart.querySelectorAll('.mzc-pin').forEach(pin => {
        pin.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(pin.dataset.node, true);
            }
        });
    });
}

function select(key, panThere) {
    selectedKey = key && findByKey(key) ? key : null;
    if (panThere && selectedKey) {
        const item = anchorOf(selectedKey);
        if (item) centerOn(item.ax, item.ay, Math.max(view.s, item.pin ? 1.4 : 0.9));
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
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
            fx: frameRect.left,
            fy: frameRect.top,
        };
        widget.setPointerCapture(event.pointerId);
    });
    widget.addEventListener('pointermove', event => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < 4) return;
        drag.moved = true;
        widget.classList.add('is-dragging');
        const x = clamp(event.clientX - drag.fx - drag.dx, EDGE, frameEl.clientWidth - widget.offsetWidth - EDGE);
        const y = clamp(event.clientY - drag.fy - drag.dy, EDGE, frameEl.clientHeight - widget.offsetHeight - EDGE);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
    });
    const endDrag = () => {
        if (!drag) return;
        widget.classList.remove('is-dragging');
        settings().mapPos = {
            x: parseFloat(widget.style.left) || 0,
            y: parseFloat(widget.style.top) || 0,
        };
        saveSettings();
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
        placeWinExplicit();
        winDrag = {
            dx: event.clientX - win.getBoundingClientRect().left,
            dy: event.clientY - win.getBoundingClientRect().top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
        };
        els.winHead.setPointerCapture(event.pointerId);
    });
    els.winHead?.addEventListener('pointermove', event => {
        if (!winDrag) return;
        if (!winDrag.moved && Math.hypot(event.clientX - winDrag.x0, event.clientY - winDrag.y0) < 4) return;
        winDrag.moved = true;
        win.classList.add('is-moving');
        const frameRect = frameEl.getBoundingClientRect();
        const x = clamp(event.clientX - frameRect.left - winDrag.dx, EDGE, frameEl.clientWidth - win.offsetWidth - EDGE);
        const y = clamp(event.clientY - frameRect.top - winDrag.dy, EDGE, frameEl.clientHeight - win.offsetHeight - EDGE);
        win.style.left = `${x}px`;
        win.style.top = `${y}px`;
    });
    const endMove = () => {
        if (!winDrag) return;
        win.classList.remove('is-moving');
        saveWinPlace();
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
        };
        const up = () => {
            els.winGrip.removeEventListener('pointermove', move);
            els.winGrip.removeEventListener('pointerup', up);
            winSizing = false;
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
        } else if (button.dataset.mzMapTwist !== undefined) {
            twistState.set(button.dataset.mzMapTwist, button.getAttribute('aria-expanded') !== 'true');
            renderIndex();
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
        } else if (button.dataset.mzMapLayer) {
            if (button.dataset.mzMapLayer === 'trails') trails = !trails;
            else flagsShown = !flagsShown;
            button.setAttribute('aria-pressed', String(button.dataset.mzMapLayer === 'trails' ? trails : flagsShown));
            renderWin();
        } else if (button.dataset.mzMapZoom) {
            zoomBy(Number(button.dataset.mzMapZoom));
        } else if (button.hasAttribute('data-mz-map-fit')) {
            fit();
            applyTransform();
        } else if (button.hasAttribute('data-mz-map-now')) {
            const item = derived?.nowId ? layout.anchor(derived.nowId) : null;
            if (item) {
                centerOn(item.ax, item.ay, Math.max(view.s, 1.3));
                applyTransform();
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
}
