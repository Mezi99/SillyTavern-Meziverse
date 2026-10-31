/**
 * The tracker rails: a column of quiet cards on the right, one icon button
 * above each entry's boxes, and one popup with the full records — a bottom
 * sheet on small screens.
 *
 * The ledger entries land one at a time, each in ENTRIES with its own boxes,
 * popup body and feature switch. An entry draws only under Meziverse mode
 * AND its own switch, and only when its rows exist: with nothing to show the
 * whole rail steps aside and the pane keeps the width.
 *
 * The icons snap their rail part: pressed, the entry's boxes are visible;
 * clicking a box opens the popup, which closes on a click away or Esc —
 * clicks inside it never close it, so scrolling is safe. Story text is only
 * ever set as text, never as HTML.
 */

import { icon } from './icons.js';
import { entryOn, modeOn } from './settings.js';

const BOXES_MAX = 3;

/**
 * The ledger entries. `threads` is the first; hooks, lore, recap and the
 * rest join here as they land, and the future mode-features menu flips
 * their switches in `settings().entries`.
 */
const ENTRIES = {
    threads: {
        title: 'Threads',
        has: ledger => !!ledger && ledger.threads.length > 0,
        sub: ledger => `${ledger.threads.length} live${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.threads.slice(0, BOXES_MAX).map(threadBox),
        body: ledger => ledger.threads.map(threadRecord),
    },
};

let frame = null;
let glance = null;
let fly = null;
let flyTitle = null;
let flySub = null;
let flyBody = null;
let railButton = null;

let state = null;
let openKey = null;
let lastSignature = null;

/* Entries whose boxes are snapped off. Session-only: the future
   mode-features menu owns what should persist. */
const hiddenParts = new Set();

/** Mounts the rail inside the frame. Idempotent. */
export function mountDock(root) {
    if (!root || frame) return;

    frame = root.querySelector('.mz-frame');
    glance = root.querySelector('[data-mz="glance"]');
    fly = root.querySelector('[data-mz="fly"]');
    flyTitle = fly?.querySelector('[data-mz="fly-title"]');
    flySub = fly?.querySelector('[data-mz="fly-sub"]');
    flyBody = fly?.querySelector('[data-mz="fly-body"]');
    railButton = root.querySelector('[data-mz-railbtn]');

    if (!frame || !glance || !fly) return;

    // One listener on the document: it sees clicks inside the frame and
    // clicks on SillyTavern's own popups alike, which is exactly what
    // "clicking away closes" needs.
    document.addEventListener('click', onClick);
}

/**
 * Draws the rail for one resolved ledger (or null when the turn has none).
 * Rebuilds only when the board changes, so streaming frames are cheap.
 *
 * @param {{threads:object[], turn:number, carried:boolean}|null} ledger
 */
export function renderDock(ledger) {
    if (!frame) return;

    state = ledger && Array.isArray(ledger.threads) ? ledger : null;

    const visible = Object.keys(ENTRIES).filter(visibleNow);
    if (openKey && !visible.includes(openKey)) openKey = null;

    const active = visible.length > 0;
    frame.classList.toggle('is-rails', active);
    if (railButton) railButton.hidden = !active;
    glance.hidden = !active;

    const signature = JSON.stringify({ visible, state, hidden: [...hiddenParts] });

    if (signature !== lastSignature) {
        lastSignature = signature;
        buildRail();
        if (openKey) fillFly(openKey);
    }

    syncFly();
}

/** Whether one entry's popup is open. */
export function isDockOpen() {
    return openKey !== null;
}

/** Closes the popup, if one is open. */
export function closeDock() {
    if (openKey === null) return;
    openKey = null;
    syncFly();
}

/* ---------- the rail ---------- */

function visibleNow(key) {
    return modeOn() && entryOn(key) && !!ENTRIES[key]?.has(state);
}

function visibleKeys() {
    return Object.keys(ENTRIES).filter(visibleNow);
}

/** One entry's rail part: its icon button, then its boxes while snapped on. */
function railPart(key) {
    const entry = ENTRIES[key];
    const shown = !hiddenParts.has(key);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mz-dbtn${shown ? ' is-on' : ''}`;
    button.dataset.mzDock = key;
    button.title = `${shown ? 'Hide' : 'Show'} ${entry.title.toLowerCase()}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(shown));
    button.append(icon(`mz-i-${key}`));

    return shown ? [button, ...entry.boxes(state)] : [button];
}

function buildRail() {
    glance.replaceChildren(...visibleKeys().flatMap(railPart));
}

function toggleParts(key) {
    // The rail is rebuilt below, so remember keyboard focus on the icon.
    const hadFocus = document.activeElement?.dataset?.mzDock === key;

    if (hiddenParts.has(key)) {
        hiddenParts.delete(key);
    } else {
        hiddenParts.add(key);
        if (openKey === key) openKey = null;
    }
    buildRail();
    syncFly();

    if (hadFocus) glance.querySelector(`[data-mz-dock="${key}"]`)?.focus();
}

/* ---------- the popup ---------- */

function openPopup(key) {
    if (openKey === key) return;
    openKey = key;
    fillFly(key);
    syncFly();
}

function fillFly(key) {
    const entry = ENTRIES[key];
    flyTitle.textContent = entry.title;
    flySub.textContent = entry.sub(state);
    fly.setAttribute('aria-label', entry.title);
    flyBody.replaceChildren(...entry.body(state));
}

function syncFly() {
    if (!fly) return;

    fly.hidden = !openKey;
    frame.classList.toggle('is-fly-open', !!openKey);
    if (railButton) railButton.setAttribute('aria-expanded', String(!!openKey));
}

/* ---------- one thread ---------- */

/** A rail box: the ring clock, the name, and state where outcome used to be. */
function threadBox(thread) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mz-g mz-g--quiet';
    card.dataset.mzDock = 'threads';

    card.append(ring(thread));

    const txt = document.createElement('span');
    txt.className = 'mz-g-txt';

    const title = document.createElement('span');
    title.className = 'mz-g-t';
    title.textContent = thread.name || thread.outcome || thread.plot;

    const sub = document.createElement('span');
    sub.className = 'mz-g-s';
    sub.append(stateChip(thread));

    txt.append(title, sub);
    card.append(txt);
    return card;
}

function ring(thread) {
    const span = document.createElement('span');
    span.className = 'mz-ring';
    span.setAttribute('aria-label', `${thread.fill} of ${thread.total}`);

    const size = 38;
    const radius = 14;
    const length = 2 * Math.PI * radius;
    const arc = thread.total > 0 ? (length * thread.fill) / thread.total : 0;
    const stroke = thread.state === 'fires' ? 'var(--mz-warn)' : 'var(--mz-accent)';

    // Static markup plus numbers only — no story text ever passes through here.
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">`
        + `<circle cx="19" cy="19" r="${radius}" fill="none" stroke="var(--mz-line-strong)" stroke-width="3"/>`
        + `<circle cx="19" cy="19" r="${radius}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"`
        + ` stroke-dasharray="${arc.toFixed(1)} ${length.toFixed(1)}" transform="rotate(-90 19 19)"/></svg>`
        + `<b>${thread.fill}/${thread.total}</b>`;

    return span;
}

/** A popup record: name and clock, then plot, outcome and state — all of it. */
function threadRecord(thread) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const row = document.createElement('div');
    row.className = 'mz-item-row';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = thread.name || thread.outcome || thread.plot;

    row.append(title, pips(thread));
    item.append(row);

    if (thread.plot) {
        const plot = document.createElement('p');
        plot.className = 'mz-item-sub';
        plot.textContent = thread.plot;
        item.append(plot);
    }

    if (thread.outcome) {
        const outcome = document.createElement('p');
        outcome.className = 'mz-item-out';
        outcome.textContent = thread.outcome;
        item.append(outcome);
    }

    const foot = document.createElement('div');
    foot.className = 'mz-item-foot';
    foot.append(stateChip(thread));
    item.append(foot);

    return item;
}

function pips(thread) {
    const span = document.createElement('span');
    span.className = `mz-pips${thread.state === 'fires' ? ' is-warn' : ''}`;
    span.setAttribute('aria-label', `${thread.fill} of ${thread.total}`);

    for (let i = 0; i < thread.total; i += 1) {
        const pip = document.createElement('i');
        if (i < thread.fill) pip.className = 'on';
        span.append(pip);
    }

    return span;
}

function stateChip(thread) {
    const chip = document.createElement('span');
    chip.className = 'mz-tag'
        + (thread.state === 'fires' ? ' is-warn' : thread.state === 'resolved' ? ' is-done' : ' is-live');
    chip.textContent = thread.state;
    return chip;
}

/* ---------- input ---------- */

function onClick(event) {
    const trigger = event.target.closest('[data-mz-dock]');
    if (trigger) {
        const key = trigger.dataset.mzDock;

        if (trigger.classList.contains('mz-dbtn')) toggleParts(key);
        else if (trigger.classList.contains('mz-railbtn')) {
            // Small screens have no boxes to click: the button is the popup.
            if (openKey === key) closeDock();
            else openPopup(key);
        } else {
            openPopup(key);
        }
        return;
    }

    // A click anywhere else closes the popup. Clicks inside it never do,
    // so touching, scrolling or selecting within it is safe.
    if (openKey && !fly.contains(event.target)) closeDock();
}
