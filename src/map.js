/**
 * The map on screen: the minimap window and the full atlas window.
 *
 * The atlas itself is mapdata.js (pure); this file is only its stage - like
 * the music player, the widget floats in the scene, drags by its head, and
 * carries no logic beyond rendering. Everything is derived on refresh and
 * thrown away: nothing is stored but the window's spot and the settings.
 *
 * The minimap is the small window in the corner (game-minimap style): a
 * quiet render of the atlas at the chosen depth with the story's current
 * place lit. Clicking it opens the full map - the whole journey as nested
 * place groups, a node card with its visits and its pictures, and the
 * "travels" strip for the places that move. With no scene tags the atlas
 * falls back to the places the chat's backgrounds already name.
 */

import { activeStamp, buildAtlas, extractObservations, extractStampObservations } from './mapdata.js';
import { bgStore, chatMessages, currentChatId, on, personaName } from './st.js';
import { mapMiniOn, mapOn, saveSettings, settings } from './settings.js';

const LOG = '[Meziverse map]';

const NARROW = 760;
const MINI_VW = 212;
const MINI_DOTS_MAX = 12;
const MINI_BLOCKS_MAX = 5;
const EDGE = 10;

let uiIsOpen = () => false;
let frameEl = null;
let gotoTurn = null;
let widget = null;
let win = null;
let els = {};
let atlas = null;
let selected = null;
let drag = null;
let queued = false;

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** The depth the atlas shows: 2, 3, 4 levels, or 99 for everything. */
function depthValue() {
    const depth = Number(settings().mapDepth);
    return [2, 3, 4, 99].includes(depth) ? depth : 4;
}

function depthLabel() {
    return depthValue() === 99 ? 'All' : String(depthValue());
}

const WIDGET_HTML = `
<div class="mz-map-head" data-mz-map-head>
    <button class="mz-map-art" type="button" title="Open the map" aria-label="Open the map" data-mz-map="open">${svg('map')}</button>
    <button class="mz-map-title" type="button" data-mz-map="open">
        <b data-mz-map="title">Map</b>
        <small data-mz-map="sub">No places yet</small>
    </button>
    <button class="mz-ibtn" type="button" title="Minimap on/off" aria-label="Minimap on/off" data-mz-action="map-mini">${svg('collapse')}</button>
</div>
<div class="mz-map-mini" data-mz-map-mini hidden></div>`;

const WIN_HTML = `
<header class="mz-mapwin-head">
    <h2>Map</h2>
    <span class="mz-mapwin-sum" data-mz-map="summary"></span>
    <div class="mz-mapwin-tools">
        <div class="mz-step" role="group" aria-label="Map depth">
            <button type="button" data-mz-step="map-depth" data-dir="-1" aria-label="Show fewer levels">\u2212</button>
            <span data-mz-map="depth">All</span>
            <button type="button" data-mz-step="map-depth" data-dir="1" aria-label="Show more levels">+</button>
        </div>
        <button class="mz-ibtn" type="button" title="Close map" aria-label="Close map" data-mz-action="map-close">${svg('close')}</button>
    </div>
</header>
<div class="mz-mapwin-body">
    <div class="mz-map-now" data-mz-map="now" hidden></div>
    <div class="mz-map-scroll">
        <div class="mz-map-atlas" data-mz-map="atlas"></div>
    </div>
    <aside class="mz-map-detail" data-mz-map="detail" hidden></aside>
</div>`;

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
        title: widget.querySelector('[data-mz-map="title"]'),
        sub: widget.querySelector('[data-mz-map="sub"]'),
        summary: win.querySelector('[data-mz-map="summary"]'),
        depth: win.querySelector('[data-mz-map="depth"]'),
        now: win.querySelector('[data-mz-map="now"]'),
        atlas: win.querySelector('[data-mz-map="atlas"]'),
        detail: win.querySelector('[data-mz-map="detail"]'),
    };

    wireWidget();
    wireWin();
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
    rebuild();
    render();
}

/** Whether the full map window is on screen. */
export function isMapWinOpen() {
    return !!win && !win.hidden;
}

/** Opens the full map, optionally at one node. */
export function openMapWin(nodeId = null) {
    if (!win || !mapOn() || !uiIsOpen()) return;
    if (nodeId && atlas?.nodes[nodeId]) selected = nodeId;

    win.hidden = false;
    win.setAttribute('aria-hidden', 'false');
    frameEl?.classList.add('is-mapwin-open');
    renderWin();
}

/** Closes the full map window. */
export function closeMapWin() {
    if (!win || win.hidden) return;
    win.hidden = true;
    win.setAttribute('aria-hidden', 'true');
    frameEl?.classList.remove('is-mapwin-open');
}

/* ---------- the atlas in memory ---------- */

function rebuild() {
    const previous = selected && atlas?.nodes[selected];
    const fold = previous?.fold ?? null;

    const messages = chatMessages();
    let obs = extractObservations(messages, { persona: personaName() });
    // No tags in the story: the drawn backgrounds still name their places.
    if (!obs.length) obs = extractStampObservations(messages, bgStore().records);
    atlas = obs.length ? buildAtlas(obs) : null;

    if (fold && atlas) {
        const hit = Object.values(atlas.nodes).find(node => node.fold === fold);
        selected = hit ? hit.id : null;
    } else {
        selected = null;
    }

    if (!atlas) console.debug(`${LOG} no places to map`);
}

/** The node the story is at now: the last observation's own place. */
function currentNodeId() {
    const obs = atlas?.observations;
    return obs?.length ? obs[obs.length - 1].nodeId || null : null;
}

function nodePath(node) {
    const names = [];
    for (let current = node; current; current = current.parentId ? atlas.nodes[current.parentId] : null) {
        names.unshift(current.name);
    }
    return names.join(' \u203a ');
}

/** The ancestor ids of a node, outermost first. */
function ancestorIds(node) {
    const ids = [];
    for (let current = node; current?.parentId;) {
        current = atlas.nodes[current.parentId];
        ids.unshift(current.id);
    }
    return ids;
}

/* ---------- pictures from the background store ---------- */

/** The background record one observation's reply carries, or null. */
function recordFor(obsIndex) {
    const obs = atlas.observations[obsIndex];
    const message = chatMessages()[obs?.at?.msgIndex ?? -1];
    const id = message ? activeStamp(message) : null;
    return id ? bgStore().records?.[id] || null : null;
}

/** The pictures drawn at a place - its own visits', or the whole subtree's. */
function nodeImages(node, deep = true) {
    const out = [];
    const seen = new Set();
    const collect = current => {
        for (const index of current.visits) {
            const record = recordFor(index);
            if (record && !seen.has(record.id)) {
                seen.add(record.id);
                out.push(record);
            }
        }
        if (deep) current.children.forEach(id => collect(atlas.nodes[id]));
    };
    collect(node);
    return out;
}

/* ---------- the minimap ---------- */

function miniSvg() {
    if (!atlas) return '';

    const depth = depthValue();
    const roots = atlas.roots.map(id => atlas.nodes[id]);
    const blocks = roots.map(node => ({
        label: node.name,
        mobile: node.kind === 'mobile',
        nodes: chipNodes(node, depth).slice(0, MINI_DOTS_MAX),
    })).slice(0, MINI_BLOCKS_MAX);

    const now = currentNodeId();
    const parts = [];
    let x = 4;
    let y = 4;
    let rowH = 0;

    for (const block of blocks) {
        const cols = Math.min(4, Math.max(1, block.nodes.length));
        const rows = Math.ceil(block.nodes.length / 4) || 1;
        const w = 14 + cols * 15;
        const h = 24 + rows * 15;
        if (x + w > MINI_VW && x > 4) {
            x = 4;
            y += rowH + 6;
            rowH = 0;
        }

        parts.push(`<rect class="mz-mini-block${block.mobile ? ' is-mobile' : ''}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`);
        parts.push(`<text class="mz-mini-label" x="${x + 7}" y="${y + 14}">${esc(truncate(block.label, 18))}</text>`);
        block.nodes.forEach((node, i) => {
            const cx = x + 12 + (i % 4) * 15;
            const cy = y + 24 + Math.floor(i / 4) * 15 + 4;
            parts.push(`<circle class="mz-mini-dot${node.id === now ? ' is-now' : ''}" data-node="${node.id}" cx="${cx}" cy="${cy}" r="${node.id === now ? 4.6 : 3.1}"><title>${esc(node.name)}</title></circle>`);
        });

        x += w + 6;
        rowH = Math.max(rowH, h);
    }

    const height = y + rowH + 4;
    return `<svg class="mz-mini-svg" viewBox="0 0 ${MINI_VW} ${Math.max(height, 28)}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Map of visited places">${parts.join('')}</svg>`;
}

/** The nodes one block shows as dots: the chips at this depth, leaves first. */
function chipNodes(node, depth) {
    const expandable = node.children.length
        && (depth === 99 || (Number.isFinite(node.level) ? node.level < depth - 1 : true));
    if (!expandable) return [node];

    const out = [];
    node.children.forEach(id => out.push(...chipNodes(atlas.nodes[id], depth)));
    return out;
}

function truncate(value, max) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

/* ---------- the full map ---------- */

function renderWin() {
    if (!win || win.hidden) return;

    els.depth.textContent = depthLabel();

    if (!atlas) {
        els.summary.textContent = currentChatId() ? '' : 'No chat open';
        els.now.hidden = true;
        els.atlas.innerHTML = '<p class="mz-map-empty">No places yet. The map draws itself from the story\u2019s scene tags \u2014 or, without tags, from the backgrounds the chat has drawn.</p>';
        els.detail.hidden = true;
        return;
    }

    const nowId = currentNodeId();
    els.summary.textContent = `${atlas.order.length} places \u00b7 ${atlas.observations.length} scenes`;
    els.now.hidden = !nowId;
    if (nowId) {
        els.now.innerHTML = `<span class="mz-label">Now</span><b>${esc(nodePath(atlas.nodes[nowId]))}</b>`;
    }

    const chunks = [];
    const roots = atlas.roots.map(id => atlas.nodes[id]);
    const travels = roots.filter(node => node.kind === 'mobile');
    const regions = roots.filter(node => node.kind !== 'mobile');

    if (travels.length) {
        chunks.push(`<section class="mz-map-group mz-map-travels"><header class="mz-map-group-head"><b>Travels</b><i>${travels.length}</i></header><div class="mz-map-kids">${travels.map(node => renderNode(node, depthValue())).join('')}</div></section>`);
    }
    for (const node of regions) chunks.push(renderNode(node, depthValue()));

    els.atlas.innerHTML = chunks.join('');
    renderDetail();
}

function renderNode(node, depth) {
    const children = node.children.map(id => atlas.nodes[id]);
    const expandable = children.length
        && node.kind !== 'transient'
        && (depth === 99 || (Number.isFinite(node.level) ? node.level < depth - 1 : true));

    if (expandable) {
        return `<section class="mz-map-group" data-mz-node="${node.id}"><header class="mz-map-group-head"><b>${esc(node.name)}</b><i>${children.length}</i></header><div class="mz-map-kids">${children.map(child => renderNode(child, depth)).join('')}</div></section>`;
    }
    return chip(node, children.length);
}

function chip(node, hidden = 0) {
    const now = node.id === currentNodeId();
    const classes = ['mz-map-chip', `is-${node.kind}`, now ? 'is-now' : '', selected === node.id ? 'is-sel' : '']
        .filter(Boolean).join(' ');
    const images = nodeImages(node, false);
    const thumb = images[0]?.url ? `<img class="mz-map-thumb" src="${esc(images[0].url)}" alt="" loading="lazy">` : '';

    return `<button class="${classes}" type="button" data-mz-node="${node.id}">${thumb}<span class="mz-map-name">${esc(node.name)}</span>${hidden ? `<i class="mz-map-more">+${hidden}</i>` : ''}</button>`;
}

function renderDetail() {
    const node = selected && atlas?.nodes[selected];
    if (!node) {
        els.detail.hidden = true;
        return;
    }
    els.detail.hidden = false;

    const pieces = [];
    pieces.push(`<header class="mz-map-detail-head"><h3>${esc(node.name)}</h3><span class="mz-map-tag is-${node.kind}">${kindLabel(node)}</span></header>`);

    const path = nodePath(node);
    if (path && path !== node.name) pieces.push(`<p class="mz-map-path">${esc(path)}</p>`);
    if (node.aliases.length) pieces.push(`<p class="mz-map-aliases">Also written: ${esc(node.aliases.join(', '))}</p>`);
    if (node.aspects.length) pieces.push(`<p class="mz-map-aliases">Seen as: ${esc(node.aspects.join(', '))}</p>`);

    const images = nodeImages(node);
    if (images.length) {
        pieces.push(`<div class="mz-map-gallery">${images.map(record => `<img class="mz-map-shot" src="${esc(record.url)}" alt="${esc(record.place)}" title="${esc(record.prompt || record.place)}" loading="lazy">`).join('')}</div>`);
    }

    const flags = detailFlags(node);
    if (flags.length) {
        pieces.push(`<ul class="mz-map-flags">${flags.map(text => `<li>${esc(text)}</li>`).join('')}</ul>`);
    }

    const rows = node.visits.map(index => {
        const obs = atlas.observations[index];
        const when = [obs.date, obs.time].filter(Boolean).join(' \u00b7 ') || 'undated';
        const bits = [when];
        if (obs.weather) bits.push(obs.weather);
        if (obs.present?.length) bits.push(obs.present.join(', '));
        return `<li>${esc(bits.join(' \u00b7 '))}<button class="mz-btn-ghost mz-map-goto" type="button" data-mz-goto="${obs.at.msgIndex}">Turn ${obs.at.msgIndex + 1}</button></li>`;
    });
    pieces.push(`<h4>Visits <i>${node.visits.length}</i></h4><ul class="mz-map-visits">${rows.join('')}</ul>`);

    if (node.trajectory?.length) {
        const stops = node.trajectory.map(stop => stop.positionId ? atlas.nodes[stop.positionId].name : '\u2014');
        pieces.push(`<h4>Route</h4><p class="mz-map-route">${esc(stops.join(' \u2192 '))}</p>`);
    }

    els.detail.innerHTML = pieces.join('');
}

function kindLabel(node) {
    if (node.kind === 'mobile') return 'moves';
    if (node.kind === 'transient') return 'on the way';
    return node.kind;
}

function detailFlags(node) {
    const out = [];
    for (const [a, b] of atlas.flags.same) {
        const other = a === node.id ? b : b === node.id ? a : null;
        if (other && atlas.nodes[other]) out.push(`May be the same as \u201c${atlas.nodes[other].name}\u201d.`);
    }
    if (atlas.flags.ambiguous.includes(node.fold)) out.push('This name appears in more than one place.');
    if (atlas.flags.mobilePending.includes(node.fold)) out.push('May be a moving place.');
    return out;
}

/* ---------- render (the widget) ---------- */

function render() {
    if (!widget || !win) return;

    const on = mapOn() && uiIsOpen();
    widget.hidden = !on;
    if (!on) {
        closeMapWin();
        return;
    }

    const compact = !mapMiniOn() || window.innerWidth < NARROW;
    widget.classList.toggle('is-compact', compact);
    els.mini.hidden = compact;

    els.sub.textContent = atlas
        ? `${atlas.order.length} places \u00b7 ${atlas.observations.length} scenes`
        : 'No places yet';

    if (!compact) els.mini.innerHTML = miniSvg();

    positionWidget();
    renderWin();
}

/** The window's spot: the saved one, else the bottom-left corner. */
function positionWidget() {
    if (!widget || widget.hidden) return;

    const frameW = frameEl?.clientWidth || window.innerWidth;
    const frameH = frameEl?.clientHeight || window.innerHeight;
    const pos = settings().mapPos;
    const saved = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);

    const x = clamp(saved ? pos.x : EDGE, EDGE, Math.max(EDGE, frameW - widget.offsetWidth - EDGE));
    const y = clamp(saved ? pos.y : frameH - widget.offsetHeight - EDGE, EDGE, Math.max(EDGE, frameH - widget.offsetHeight - EDGE));

    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
}

/* ---------- wiring ---------- */

function wireWidget() {
    widget.addEventListener('click', event => {
        const dot = event.target.closest('[data-node]');
        if (dot) {
            openMapWin(dot.dataset.node);
            return;
        }

        const target = event.target.closest('[data-mz-map]');
        if (!target) return;

        if (target.dataset.mzMap === 'open') openMapWin();
    });

    wireDrag();
}

/* The window is dragged by its head - never by its buttons. */
function wireDrag() {
    els.head.addEventListener('pointerdown', event => {
        if (event.target.closest('button, input, a')) return;
        const rect = widget.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        els.head.setPointerCapture(event.pointerId);
        widget.classList.add('is-dragging');
    });

    els.head.addEventListener('pointermove', event => {
        if (!drag) return;
        const x = clamp(event.clientX - drag.dx, EDGE, window.innerWidth - widget.offsetWidth - EDGE);
        const y = clamp(event.clientY - drag.dy, EDGE, window.innerHeight - widget.offsetHeight - EDGE);
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;
    });

    const endDrag = () => {
        if (!drag) return;
        drag = null;
        widget.classList.remove('is-dragging');
        settings().mapPos = {
            x: parseFloat(widget.style.left) || 0,
            y: parseFloat(widget.style.top) || 0,
        };
        saveSettings();
    };

    els.head.addEventListener('pointerup', endDrag);
    els.head.addEventListener('pointercancel', endDrag);
}

function wireWin() {
    win.addEventListener('click', event => {
        const goto = event.target.closest('[data-mz-goto]');
        if (goto) {
            const index = Number(goto.dataset.mzGoto);
            if (Number.isInteger(index)) {
                closeMapWin();
                gotoTurn?.(index);
            }
            return;
        }

        const target = event.target.closest('[data-mz-node]');
        if (!target) return;

        selected = target.dataset.mzNode;
        // The atlas stays put: only the highlight and the card move.
        win.querySelectorAll('.mz-map-chip.is-sel').forEach(el => el.classList.remove('is-sel'));
        target.classList.add('is-sel');
        renderDetail();
    });
}
