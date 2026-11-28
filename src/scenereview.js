/**
 * The scene review window: one place to spot and correct wrong locations.
 *
 * scenedata.js is the pure half; this file owns the DOM and the writes. Every
 * save goes through SillyTavern's own message editor - open, set its textarea,
 * accept - one message at a time, never in parallel and never while the model
 * is generating or a SillyTavern editor is already open.
 */

import {
    acceptEdit,
    chatMessages,
    editMessage,
    editorTextarea,
    on,
    personaName,
} from './st.js';
import { saveSettings, settings } from './settings.js';
import { notify } from './notify.js';
import { weatherGlyph } from './prose.js';
import { sourceOf } from './mapdata.js';
import {
    buildPlaceTree,
    buildReview,
    exactRows,
    matchesRow,
    planEdits,
    renameChanges,
} from './scenedata.js';

const EDGE = 10;
const NARROW = 760;
const MIN_W = 560;
const MIN_H = 420;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
const ico = (name, className = 'ico') => `<svg class="${className}" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

const WINDOW_HTML = `
<header class="mz-sr-head" data-mz-sr-head>
    <span class="mz-sr-mark">${ico('scenes')}</span>
    <h2>Scenes</h2>
    <span class="mz-sr-sum" data-mz-sr-sum></span>
    <span class="mz-sr-sp"></span>
    <button class="mz-sr-close" type="button" title="Close scenes" aria-label="Close scenes" data-mz-sr-close>${ico('close')}</button>
</header>
<div class="mz-sr-tools">
    <label class="mz-sr-find">${ico('search')}<input type="search" data-mz-sr-find placeholder="Find a place, name or message" aria-label="Find a scene"></label>
    <div class="mz-sr-seg" role="group" aria-label="View">
        <button type="button" data-mz-sr-view="place" class="is-on">By place</button>
        <button type="button" data-mz-sr-view="story">Story order</button>
    </div>
    <button class="mz-sr-chip" type="button" aria-pressed="false" data-mz-sr-filter><i></i>Needs a look <span data-mz-sr-count>0</span></button>
    <span class="mz-sr-sp"></span>
    <button class="mz-sr-tiny" type="button" data-mz-sr-fold>Collapse all</button>
</div>
<div class="mz-sr-batch" data-mz-sr-batch hidden></div>
<div class="mz-sr-progress" data-mz-sr-progress hidden></div>
<div class="mz-sr-list" data-mz-sr-list></div>
<div class="mz-sr-grip" data-mz-sr-grip role="separator" aria-label="Resize scene review" tabindex="0"></div>`;

let frame = null;
let goto = null;
let uiIsOpen = () => false;
let win = null;
let els = {};
let review = { rows: [], summary: { scenes: 0, messages: 0, places: 0, hard: 0 } };
let tree = { roots: [], byKey: new Map() };
let view = 'place';
let query = '';
let onlyFlag = false;
let shut = new Set();
let editing = null;
let rename = null;
let pending = null;
let progress = null;
let writing = false;
let cancelRequested = false;
let lastFocus = null;
let queued = false;
let winDrag = null;
let winSizing = false;

/* ---------- lifecycle ---------- */

export function mountSceneReview({ frame: frameEl, goto: goTo = null } = {}) {
    if (win || !frameEl) return;
    frame = frameEl;
    goto = goTo;

    win = document.createElement('section');
    win.className = 'mz-scenewin';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-label', 'Scene review');
    win.setAttribute('aria-hidden', 'true');
    win.hidden = true;
    win.innerHTML = WINDOW_HTML;
    frame.append(win);

    els = {
        head: win.querySelector('[data-mz-sr-head]'),
        sum: win.querySelector('[data-mz-sr-sum]'),
        find: win.querySelector('[data-mz-sr-find]'),
        filter: win.querySelector('[data-mz-sr-filter]'),
        count: win.querySelector('[data-mz-sr-count]'),
        fold: win.querySelector('[data-mz-sr-fold]'),
        batch: win.querySelector('[data-mz-sr-batch]'),
        progress: win.querySelector('[data-mz-sr-progress]'),
        list: win.querySelector('[data-mz-sr-list]'),
        grip: win.querySelector('[data-mz-sr-grip]'),
        topCount: frame.querySelector('[data-mz="scene-count"]'),
    };

    wireWin();
}

/** Chat events rebuild the data even while the window is shut: the top-bar
 *  badge has to stay honest. */
export function initSceneReview({ isOpen } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;

    const events = [
        'CHAT_CHANGED', 'CHAT_CREATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED',
        'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED', 'GENERATION_ENDED',
        'GENERATION_STOPPED', 'GROUP_WRAPPER_FINISHED',
    ];
    for (const event of events) on(event, requestRebuild);
    window.addEventListener('resize', applyWinPlace);
    rebuild();
}

/** An explicit refresh, for callers outside the chat event chain. */
export function refreshSceneReview() {
    rebuild();
    if (isSceneReviewOpen()) render();
}

/** The master scene's open/close hooks: the badge follows the chat either way. */
export function sceneReviewUiOpened() {
    rebuild();
}

export function sceneReviewUiClosed() {
    closeSceneReview();
}

export function isSceneReviewOpen() {
    return !!win && !win.hidden;
}

export function openSceneReview() {
    if (!win || !uiIsOpen() || writing) return;
    rebuild();
    lastFocus = document.activeElement;
    win.hidden = false;
    win.setAttribute('aria-hidden', 'false');
    frame.classList.add('is-scenewin-open');
    applyWinPlace();
    render();
    els.find.focus({ preventScroll: true });
}

export function closeSceneReview() {
    if (!win || win.hidden || writing) return;
    win.hidden = true;
    win.setAttribute('aria-hidden', 'true');
    frame.classList.remove('is-scenewin-open');
    saveWinPlace();
    editing = null;
    rename = null;
    pending = null;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    lastFocus = null;
}

/* ---------- data and state ---------- */

function requestRebuild() {
    if (!win || queued) return;
    queued = true;
    requestAnimationFrame(() => {
        queued = false;
        if (writing) return;
        rebuild();
        if (isSceneReviewOpen()) render();
    });
}

function rebuild() {
    if (!win) return;
    review = buildReview(chatMessages(), { persona: personaName() });
    tree = buildPlaceTree(review.rows);

    const found = new Set(review.rows.map(row => row.id));
    if (editing && !found.has(editing)) editing = null;
    if (rename && !tree.byKey.has(rename)) rename = null;

    const count = review.summary.hard || 0;
    els.topCount.hidden = !count;
    els.topCount.textContent = count ? String(count) : '';
    const label = count === 1 ? '1 scene needs a look' : `${count} scenes need a look`;
    els.topCount.title = label;
    frame.querySelector('[data-mz-action="scenes-open"]')?.setAttribute('aria-label', `Scene review - ${label}`);
}

function rowOf(id) {
    return review.rows.find(row => String(row.id) === String(id)) || null;
}

/** The writer's gate: the pencil may open for reading, but no save runs while
 *  a reply streams or SillyTavern's own editor holds a message. */
function writeBlockReason() {
    if (frame?.classList.contains('is-generating')) return 'Wait for the reply to finish before saving locations.';
    if (editorTextarea()) return "Close SillyTavern's message editor before saving locations.";
    return '';
}

function matches(row) {
    return (!onlyFlag || row.hard) && matchesRow(row, query);
}

/* ---------- markup ---------- */

function crumbHtml(row) {
    if (!row.levels.length) return '<div class="mz-sr-crumb"><span>No place</span></div>';
    return `<div class="mz-sr-crumb">${row.levels.map((level, at) => at === row.levels.length - 1
        ? `<b>${esc(level)}</b>`
        : `<span>${esc(level)}</span><em>›</em>`).join('')}</div>`;
}

function metaHtml(row) {
    const bits = [];
    bits.push(row.time
        ? `<span class="mz-sr-t">${esc(row.time)}</span>`
        : '<span class="mz-sr-no is-bad">no time</span>');
    if (row.date) bits.push(`<span>${esc(row.date)}</span>`);
    bits.push(row.weather || row.weatherTag
        ? `<span class="mz-sr-w">${weatherGlyph(row.weatherTag, row.hour)}${esc(row.weather || row.weatherTag)}</span>`
        : '<span class="mz-sr-no is-bad">no weather</span>');
    if (row.present.length) bits.push(`<span class="mz-sr-c">${row.present.map(esc).join(', ')}</span>`);
    return `<div class="mz-sr-meta">${bits.join('')}</div>`;
}

function flagHtml(row) {
    // Soft gaps live in the meta line as dashed chips; only hard flags earn
    // a pill (and, where the story suggests a fix, a button).
    const flags = row.flags.filter(flag => flag.hard);
    if (!flags.length) return '';
    return `<div class="mz-sr-flags">${flags.map(flag => {
        const parts = [`<span class="mz-sr-l">${esc(flag.label)}</span>`];
        if (row.fix && (flag.kind === 'typo' || flag.kind === 'parents')) {
            const text = flag.kind === 'typo' ? 'Fix' : 'Use full';
            parts.push(`<button type="button" data-mz-sr-fix="${esc(row.id)}">${text}</button>`);
        }
        return `<span class="mz-sr-pill">${parts.join('')}</span>`;
    }).join('')}</div>`;
}

function editorHtml(row) {
    const others = exactRows(review.rows, row).filter(other => other.id !== row.id).length;
    const levels = row.levels.map((level, at) => `${at ? '<span class="mz-sr-sep">›</span>' : ''}`
        + `<span class="mz-sr-lvw"><input class="mz-sr-lv" value="${esc(level)}" aria-label="Level ${at + 1}">`
        + `<button class="mz-sr-ib is-sm" type="button" data-mz-sr-del aria-label="Remove level ${at + 1}">${ico('close')}</button></span>`).join('');
    return `<div class="mz-sr-ed" data-mz-sr-ed="${esc(row.id)}">
    <div class="mz-sr-lvs" data-mz-sr-lvs>${levels}<button class="mz-sr-ib" type="button" data-mz-sr-add title="Add a level" aria-label="Add a level">${ico('plus')}</button></div>
    ${row.fix ? `<div class="mz-sr-sug">Suggested <button type="button" data-mz-sr-use="${esc(row.id)}">${esc(row.fix.levels.join(' › '))}</button></div>` : ''}
    ${others ? `<label class="mz-sr-ck"><input type="checkbox" data-mz-sr-same> Also change the ${others} other ${others === 1 ? 'scene' : 'scenes'} at this exact place</label>` : ''}
    <div class="mz-sr-foot"><button class="mz-sr-btn" type="button" data-mz-sr-cancel>Cancel</button><button class="mz-sr-btn is-pri" type="button" data-mz-sr-save="${esc(row.id)}">Save</button></div>
</div>`;
}

function rowHtml(row, showCrumb) {
    if (editing === String(row.id)) {
        return `<div class="mz-sr-tag is-editing">${editorHtml(row)}</div>`;
    }

    return `<div class="mz-sr-tag${row.hard ? ' is-flag' : ''}" data-mz-sr-row="${esc(row.id)}">
    <div class="mz-sr-badge"><button type="button" data-mz-sr-jump="${row.msgIndex}" title="Go to this message"><b>#${row.msgIndex + 1}</b></button><span>${row.tagIndex + 1}/${row.of}</span></div>
    <div class="mz-sr-tm">${showCrumb ? crumbHtml(row) : ''}${metaHtml(row)}</div>
    ${flagHtml(row)}
    <div class="mz-sr-acts"><button class="mz-sr-ib" type="button" data-mz-sr-jump="${row.msgIndex}" title="Go to this message" aria-label="Go to message ${row.msgIndex + 1}">${ico('jump')}</button><button class="mz-sr-ib" type="button" data-mz-sr-edit="${esc(row.id)}" title="Edit this scene's location" aria-label="Edit this scene's location">${ico('pencil')}</button></div>
</div>`;
}

function nodeHtml(node, depth, out) {
    const visible = node.all.filter(matches);
    if (!visible.length) return;

    const open = !shut.has(node.key);
    const flagged = visible.filter(row => row.hard).length;
    const header = `<div class="mz-sr-nh${depth === 0 ? ' is-root' : ''}" style="--d:${depth}">
        <button class="mz-sr-tw${open ? '' : ' is-shut'}" type="button" data-mz-sr-twist="${esc(node.key)}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(node.name)}" aria-expanded="${open}">${ico('chevdown')}</button>
        <span class="mz-sr-nm">${esc(node.name)}</span><span class="mz-sr-cnt">${visible.length}</span>
        ${flagged ? `<span class="mz-sr-wdot">${flagged}</span>` : ''}
        <span class="mz-sr-nact"><button class="mz-sr-ib" type="button" data-mz-sr-rnstart="${esc(node.key)}" title="Rename this place everywhere" aria-label="Rename ${esc(node.name)}">${ico('pencil')}</button></span>
    </div>`;

    if (rename === node.key) {
        out.push(`<div class="mz-sr-node">${header.replace(/<span class="mz-sr-nm">[\s\S]*?<\/span>/, '')}
        <div class="mz-sr-rn"><input value="${esc(node.name)}" aria-label="Rename ${esc(node.name)}"><small>renames it in ${node.all.length} ${node.all.length === 1 ? 'scene' : 'scenes'}</small><button class="mz-sr-btn" type="button" data-mz-sr-rncancel>Cancel</button><button class="mz-sr-btn is-pri" type="button" data-mz-sr-rnsave>Rename</button></div></div>`);
    } else {
        out.push(`<div class="mz-sr-node">${header}</div>`);
    }

    if (!open) return;
    const here = node.rows.filter(matches);
    if (here.length) out.push(`<div class="mz-sr-leaf" style="--d:${depth}">${here.map(row => rowHtml(row, false)).join('')}</div>`);
    for (const child of node.children) nodeHtml(child, depth + 1, out);
}

function storyHtml(rows) {
    const out = [];
    let current = -1;
    let cards = [];
    const flush = () => {
        if (cards.length) out.push(`<div class="mz-sr-mcard">${cards.join('')}</div>`);
        cards = [];
    };
    for (const row of rows) {
        if (row.msgIndex !== current) {
            flush();
            current = row.msgIndex;
            out.push(`<div class="mz-sr-mh">Message ${current + 1}</div>`);
        }
        cards.push(rowHtml(row, true));
    }
    flush();
    return out;
}

function allNodeKeys() {
    const keys = [];
    const walk = node => {
        keys.push(node.key);
        node.children.forEach(walk);
    };
    tree.roots.forEach(walk);
    return keys;
}

function renderBatch() {
    if (!pending) {
        els.batch.hidden = true;
        els.batch.innerHTML = '';
        return;
    }
    els.batch.hidden = false;
    els.batch.innerHTML = `<span><b>${pending.total} ${pending.total === 1 ? 'change' : 'changes'}</b> ready across ${pending.writes.length} ${pending.writes.length === 1 ? 'message' : 'messages'}</span>
        <span class="mz-sr-sp"></span>
        <button class="mz-sr-btn" type="button" data-mz-sr-batchcancel>Cancel</button>
        <button class="mz-sr-btn is-pri" type="button" data-mz-sr-apply>Apply ${pending.total} ${pending.total === 1 ? 'change' : 'changes'}</button>`;
}

function renderProgress() {
    if (!progress) {
        els.progress.hidden = true;
        els.progress.innerHTML = '';
        return;
    }
    els.progress.hidden = false;
    const at = Math.min(progress.done + 1, progress.total);
    els.progress.innerHTML = `<span>Saving ${at} of ${progress.total} ${progress.total === 1 ? 'message' : 'messages'}…</span>
        <span class="mz-sr-sp"></span>
        <button class="mz-sr-btn" type="button" data-mz-sr-stop>Stop after this message</button>`;
}

function render() {
    if (!win || win.hidden) return;
    const scroll = els.list.scrollTop;
    const { summary } = review;
    els.sum.textContent = `${summary.scenes} scenes · ${summary.messages} messages · ${summary.places} places`;
    els.count.textContent = String(summary.hard || 0);
    els.filter.classList.toggle('is-on', onlyFlag);
    els.filter.setAttribute('aria-pressed', String(onlyFlag));
    els.fold.hidden = view !== 'place';
    els.fold.textContent = allNodeKeys().length && allNodeKeys().every(key => shut.has(key)) ? 'Expand all' : 'Collapse all';
    for (const button of win.querySelectorAll('[data-mz-sr-view]')) {
        button.classList.toggle('is-on', button.dataset.mzSrView === view);
    }

    renderBatch();
    renderProgress();

    const visible = review.rows.filter(matches);
    const out = [];
    if (!visible.length) {
        out.push(`<div class="mz-sr-empty">${onlyFlag && !query ? 'Nothing needs a look.' : 'No scene matches.'}</div>`);
    } else if (view === 'place') {
        tree.roots.forEach(root => nodeHtml(root, 0, out));
    } else {
        out.push(...storyHtml(visible));
    }
    els.list.innerHTML = out.join('');
    els.list.scrollTop = scroll;

    const active = editing
        ? els.list.querySelector('[data-mz-sr-ed] .mz-sr-lv')
        : rename ? els.list.querySelector('.mz-sr-rn input') : null;
    if (active && !active.dataset.focused) {
        active.dataset.focused = '1';
        active.focus({ preventScroll: true });
        if (rename) active.select();
    }
}

/* ---------- editing and writes ---------- */

function queue(targets, label) {
    const reason = writeBlockReason();
    if (reason) {
        notify(reason, 'warning');
        return;
    }

    const clean = [];
    const seen = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
        const id = String(target?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        clean.push({ id, levels: target.levels });
    }

    const writes = planEdits(review.rows, clean);
    if (!writes.length) {
        notify('Nothing to save - the location is already correct.', 'info');
        return;
    }

    pending = { writes, label, total: seen.size };
    editing = null;
    rename = null;
    render();
    if (seen.size < 2) void runPending();
}

function saveEditor(id) {
    const editor = [...els.list.querySelectorAll('[data-mz-sr-ed]')]
        .find(element => element.dataset.mzSrEd === String(id));
    if (!editor) return;

    const levels = [...editor.querySelectorAll('.mz-sr-lv')]
        .map(input => input.value.trim()).filter(Boolean);
    if (!levels.length) {
        notify('A location needs at least one level.', 'warning');
        return;
    }

    const row = rowOf(id);
    if (!row) return;
    const targets = [{ id: row.id, levels }];
    if (editor.querySelector('[data-mz-sr-same]')?.checked) {
        for (const other of exactRows(review.rows, row)) {
            if (other.id !== row.id) targets.push({ id: other.id, levels });
        }
    }
    queue(targets, 'Location saved');
}

function applyFix(id) {
    const row = rowOf(id);
    if (!row?.fix) return;
    const targets = exactRows(review.rows, row).map(other => ({ id: other.id, levels: row.fix.levels }));
    queue(targets, row.fix.kind === 'typo' ? 'Spelling fixed' : 'Full location applied');
}

function saveRename() {
    const node = tree.byKey.get(rename);
    const input = els.list.querySelector('.mz-sr-rn input');
    const name = String(input?.value ?? '').trim();
    if (!node || !name) return;
    queue(renameChanges(review.rows, node, name), 'Place renamed');
}

async function commitWrite(write) {
    const current = chatMessages()[write.msgIndex];
    if (!current || sourceOf(current).mes !== write.before) {
        throw new Error(`Message #${write.msgIndex + 1} changed while saving; the rest was left alone.`);
    }

    const opened = await editMessage(write.msgIndex);
    if (!opened) throw new Error(`Message #${write.msgIndex + 1} could not be opened for editing.`);

    const textarea = editorTextarea(write.msgIndex);
    if (!textarea) throw new Error(`SillyTavern did not open an editor for message #${write.msgIndex + 1}.`);

    textarea.value = write.after;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    const accepted = await acceptEdit();
    if (!accepted) throw new Error(`SillyTavern did not accept the edit to message #${write.msgIndex + 1}.`);

    // Let its own handler finish, so the next edit cannot auto-accept this one.
    for (let i = 0; i < 30 && editorTextarea(write.msgIndex); i += 1) await nextFrame();
    if (editorTextarea(write.msgIndex)) {
        throw new Error(`SillyTavern kept message #${write.msgIndex + 1} in its editor.`);
    }
}

async function runPending() {
    if (writing || !pending) return;
    const reason = writeBlockReason();
    if (reason) {
        notify(reason, 'warning');
        render();
        return;
    }

    const job = pending;
    pending = null;
    writing = true;
    cancelRequested = false;
    progress = { done: 0, total: job.writes.length };
    render();

    let applied = 0;
    let stopped = false;
    let failure = '';
    for (let i = 0; i < job.writes.length; i += 1) {
        if (cancelRequested) { stopped = true; break; }
        const blocked = writeBlockReason();
        if (blocked) { failure = blocked; stopped = true; break; }

        progress.done = i;
        renderProgress();
        await nextFrame();

        try {
            await commitWrite(job.writes[i]);
            applied += 1;
        } catch (error) {
            failure = error?.message || 'The edit could not be saved.';
            stopped = true;
            break;
        }
    }

    writing = false;
    progress = null;
    cancelRequested = false;
    rebuild();
    if (isSceneReviewOpen()) render();

    if (failure) {
        notify(`${applied ? `Saved ${applied} message${applied === 1 ? '' : 's'} first. ` : ''}${failure}`, 'error');
    } else if (stopped) {
        notify(`Stopped after ${applied} message${applied === 1 ? '' : 's'}.`, 'info');
    } else {
        notify(`${job.label}: ${job.total} ${job.total === 1 ? 'scene' : 'scenes'} changed in ${applied} ${applied === 1 ? 'message' : 'messages'}.`, 'success');
    }
}

/* ---------- window plumbing ---------- */

function placeWinExplicit() {
    if (win.classList.contains('is-placed')) return;
    const rect = win.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
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
    settings().sceneWinPos = {
        x: parseFloat(win.style.left) || 0,
        y: parseFloat(win.style.top) || 0,
    };
    settings().sceneWinSize = {
        w: parseFloat(win.style.width) || 0,
        h: parseFloat(win.style.height) || 0,
    };
    saveSettings();
}

function applyWinPlace() {
    if (!win || win.hidden || winDrag || winSizing) return;
    if (window.innerWidth <= NARROW) {
        resetWinPlace();
        return;
    }

    const pos = settings().sceneWinPos;
    const size = settings().sceneWinSize;
    const hasPlace = !!pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);
    const hasSize = !!size && Number.isFinite(size.w) && Number.isFinite(size.h);
    if (!hasPlace && !hasSize) return;

    placeWinExplicit();
    if (hasSize) {
        win.style.width = `${clamp(size.w, MIN_W, Math.max(MIN_W, frame.clientWidth - 2 * EDGE))}px`;
        win.style.height = `${clamp(size.h, MIN_H, Math.max(MIN_H, frame.clientHeight - 2 * EDGE))}px`;
    }
    if (hasPlace) {
        win.style.left = `${clamp(pos.x, EDGE, Math.max(EDGE, frame.clientWidth - win.offsetWidth - EDGE))}px`;
        win.style.top = `${clamp(pos.y, EDGE, Math.max(EDGE, frame.clientHeight - win.offsetHeight - EDGE))}px`;
    }
}

function wireWinDrag() {
    win.addEventListener('dragstart', event => event.preventDefault());

    els.head.addEventListener('pointerdown', event => {
        if (event.button > 0 || event.target.closest('button, input')) return;
        winDrag = {
            pointerId: event.pointerId,
            dx: event.clientX - win.getBoundingClientRect().left,
            dy: event.clientY - win.getBoundingClientRect().top,
            x0: event.clientX,
            y0: event.clientY,
            moved: false,
        };
    });
    els.head.addEventListener('pointermove', event => {
        if (!winDrag) return;
        if (!winDrag.moved && Math.hypot(event.clientX - winDrag.x0, event.clientY - winDrag.y0) < 4) return;
        if (!winDrag.moved) {
            winDrag.moved = true;
            placeWinExplicit();
            try { els.head.setPointerCapture(winDrag.pointerId); } catch { /* the pointer went away */ }
        }
        win.classList.add('is-moving');
        const frameRect = frame.getBoundingClientRect();
        const x = clamp(event.clientX - frameRect.left - winDrag.dx, EDGE, frame.clientWidth - win.offsetWidth - EDGE);
        const y = clamp(event.clientY - frameRect.top - winDrag.dy, EDGE, frame.clientHeight - win.offsetHeight - EDGE);
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
    els.head.addEventListener('pointerup', endMove);
    els.head.addEventListener('pointercancel', endMove);

    els.head.addEventListener('dblclick', event => {
        if (event.target.closest('button, input')) return;
        settings().sceneWinPos = null;
        settings().sceneWinSize = null;
        saveSettings();
        resetWinPlace();
    });

    els.grip.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        event.preventDefault();
        event.stopPropagation();
        placeWinExplicit();
        winSizing = true;
        const start = { x: event.clientX, y: event.clientY, w: win.offsetWidth, h: win.offsetHeight };
        els.grip.setPointerCapture(event.pointerId);
        const move = moveEvent => {
            const rect = win.getBoundingClientRect();
            win.style.width = `${clamp(start.w + moveEvent.clientX - start.x, MIN_W, Math.max(MIN_W, frame.getBoundingClientRect().right - rect.left - EDGE))}px`;
            win.style.height = `${clamp(start.h + moveEvent.clientY - start.y, MIN_H, Math.max(MIN_H, frame.getBoundingClientRect().bottom - rect.top - EDGE))}px`;
        };
        const up = () => {
            els.grip.removeEventListener('pointermove', move);
            els.grip.removeEventListener('pointerup', up);
            winSizing = false;
            saveWinPlace();
        };
        els.grip.addEventListener('pointermove', move);
        els.grip.addEventListener('pointerup', up);
    });
}

function wireWin() {
    win.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || !win.contains(button)) return;

        if (button.hasAttribute('data-mz-sr-close')) { closeSceneReview(); return; }
        if (button.dataset.mzSrView) {
            view = button.dataset.mzSrView;
            editing = null;
            rename = null;
            render();
            return;
        }
        if (button.hasAttribute('data-mz-sr-filter')) {
            onlyFlag = !onlyFlag;
            render();
            return;
        }
        if (button.hasAttribute('data-mz-sr-fold')) {
            const keys = allNodeKeys();
            shut = keys.length && keys.every(key => shut.has(key)) ? new Set() : new Set(keys);
            render();
            return;
        }
        if (button.dataset.mzSrJump !== undefined) {
            goto?.(Number(button.dataset.mzSrJump));
            return;
        }
        if (button.dataset.mzSrTwist !== undefined) {
            const key = button.dataset.mzSrTwist;
            if (shut.has(key)) shut.delete(key);
            else shut.add(key);
            render();
            return;
        }
        if (button.dataset.mzSrRnstart !== undefined) {
            rename = button.dataset.mzSrRnstart;
            editing = null;
            render();
            return;
        }
        if (button.hasAttribute('data-mz-sr-rncancel')) { rename = null; render(); return; }
        if (button.hasAttribute('data-mz-sr-rnsave')) { saveRename(); return; }
        if (button.dataset.mzSrEdit !== undefined) {
            editing = String(button.dataset.mzSrEdit);
            rename = null;
            render();
            return;
        }
        if (button.hasAttribute('data-mz-sr-cancel')) { editing = null; render(); return; }
        if (button.hasAttribute('data-mz-sr-add')) {
            const levels = els.list.querySelector('[data-mz-sr-lvs]');
            if (!levels) return;
            levels.querySelector('[data-mz-sr-add]').insertAdjacentHTML('beforebegin',
                `<span class="mz-sr-sep">›</span><span class="mz-sr-lvw"><input class="mz-sr-lv" value="" aria-label="New level"><button class="mz-sr-ib is-sm" type="button" data-mz-sr-del aria-label="Remove this level">${ico('close')}</button></span>`);
            levels.lastElementChild.previousElementSibling?.querySelector('input')?.focus();
            return;
        }
        if (button.hasAttribute('data-mz-sr-del')) {
            const levels = els.list.querySelector('[data-mz-sr-lvs]');
            const wrap = button.closest('.mz-sr-lvw');
            if (!levels || !wrap || levels.querySelectorAll('.mz-sr-lvw').length <= 1) return;
            const sibling = wrap.previousElementSibling?.classList.contains('mz-sr-sep')
                ? wrap.previousElementSibling
                : wrap.nextElementSibling?.classList.contains('mz-sr-sep') ? wrap.nextElementSibling : null;
            sibling?.remove();
            wrap.remove();
            return;
        }
        if (button.dataset.mzSrUse !== undefined) {
            const row = rowOf(button.dataset.mzSrUse);
            const levels = els.list.querySelector('[data-mz-sr-lvs]');
            if (!row?.fix || !levels) return;
            levels.querySelectorAll('.mz-sr-lvw, .mz-sr-sep').forEach(node => node.remove());
            const add = levels.querySelector('[data-mz-sr-add]');
            row.fix.levels.forEach((level, at) => add.insertAdjacentHTML('beforebegin',
                `${at ? '<span class="mz-sr-sep">›</span>' : ''}<span class="mz-sr-lvw"><input class="mz-sr-lv" value="${esc(level)}" aria-label="Level ${at + 1}"><button class="mz-sr-ib is-sm" type="button" data-mz-sr-del aria-label="Remove level ${at + 1}">${ico('close')}</button></span>`));
            return;
        }
        if (button.dataset.mzSrSave !== undefined) { saveEditor(button.dataset.mzSrSave); return; }
        if (button.dataset.mzSrFix !== undefined) { applyFix(button.dataset.mzSrFix); return; }
        if (button.hasAttribute('data-mz-sr-batchcancel')) { pending = null; render(); return; }
        if (button.hasAttribute('data-mz-sr-apply')) { void runPending(); return; }
        if (button.hasAttribute('data-mz-sr-stop')) { cancelRequested = true; return; }
    });

    els.find.addEventListener('input', event => {
        query = String(event.target.value ?? '').trim();
        render();
    });

    win.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (editing) editing = null;
            else if (rename) rename = null;
            else if (pending) pending = null;
            else if (writing) cancelRequested = true;
            else { closeSceneReview(); return; }
            render();
            return;
        }
        if (event.key !== 'Enter') return;
        if (event.target.matches('.mz-sr-lv')) {
            event.preventDefault();
            const editor = event.target.closest('[data-mz-sr-ed]');
            saveEditor(editor?.dataset.mzSrEd);
        } else if (event.target.closest('.mz-sr-rn')) {
            event.preventDefault();
            saveRename();
        }
    });

    // A press outside closes the panel; the top-bar pill toggles instead.
    document.addEventListener('pointerdown', event => {
        if (win.hidden || writing) return;
        if (win.contains(event.target)) return;
        if (event.target.closest?.('[data-mz-action="scenes-open"]')) return;
        closeSceneReview();
    }, true);

    wireWinDrag();
}
