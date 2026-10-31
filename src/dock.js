/**
 * The tracker rails: a glance column of quiet cards on the right, its dock of
 * round buttons, and one flyout panel beside it — a bottom sheet on small
 * screens.
 *
 * The ledger entries land one at a time, each in ENTRIES with its own glance
 * cards, flyout body and feature switch. An entry draws only under Meziverse
 * mode AND its own switch, and only when its rows exist: with nothing to
 * show the whole rail steps aside and the pane keeps the width. Story text
 * is only ever set as text, never as HTML.
 */

import { icon } from './icons.js';
import { entryOn, modeOn } from './settings.js';

const GLANCE_MAX = 3;

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
        glance: ledger => ledger.threads.slice(0, GLANCE_MAX).map(threadCard),
        body: ledger => ledger.threads.map((thread, index) => threadItem(thread, index)),
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
const openItems = new Set();

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

    frame.addEventListener('click', onClick);
    frame.addEventListener('keydown', onKeyDown);
}

/**
 * Draws the rail for one resolved ledger (or null when the turn has none).
 * Rebuilds only when the board changes, so streaming frames are cheap and
 * unfolded items stay unfolded.
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
    frame.classList.toggle('is-fly-open', !!openKey);
    if (railButton) {
        railButton.hidden = !active;
        railButton.setAttribute('aria-expanded', String(!!openKey));
    }
    glance.hidden = !active;

    const signature = JSON.stringify({
        visible,
        state,
    });

    if (signature !== lastSignature) {
        lastSignature = signature;
        glance.replaceChildren(...visible.flatMap(glanceOf), dockNav(visible));
        if (openKey) fillFly(openKey);
    }

    syncFly();
}

/** Whether one entry's flyout is open. */
export function isDockOpen() {
    return openKey !== null;
}

/** Closes the flyout, if one is open. */
export function closeDock() {
    if (openKey === null) return;
    openKey = null;
    syncFly();
}

/* ---------- entries ---------- */

function visibleNow(key) {
    return modeOn() && entryOn(key) && !!ENTRIES[key]?.has(state);
}

function glanceOf(key) {
    return ENTRIES[key].glance(state);
}

function dockNav(keys) {
    const nav = document.createElement('nav');
    nav.className = 'mz-dock mz-dock--h';
    nav.setAttribute('aria-label', 'Story trackers');

    for (const key of keys) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mz-dbtn';
        button.dataset.mzDock = key;
        button.title = ENTRIES[key].title;
        button.setAttribute('aria-label', ENTRIES[key].title);
        button.append(icon(`mz-i-${key}`));
        nav.append(button);
    }

    return nav;
}

function fillFly(key) {
    const entry = ENTRIES[key];
    flyTitle.textContent = entry.title;
    flySub.textContent = entry.sub(state);
    fly.setAttribute('aria-label', entry.title);

    const nodes = entry.body(state);
    flyBody.replaceChildren(...nodes);

    for (const node of nodes) {
        node.classList.toggle('is-open', openItems.has(itemKey(node)));
    }
}

function syncFly() {
    if (!fly) return;

    fly.hidden = !openKey;
    frame.classList.toggle('is-fly-open', !!openKey);

    if (openKey && flyBody.childElementCount === 0) fillFly(openKey);

    if (railButton) railButton.setAttribute('aria-expanded', String(!!openKey));

    for (const button of glance.querySelectorAll('.mz-dbtn')) {
        const on = button.dataset.mzDock === openKey;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-pressed', String(on));
    }
}

function toggle(key, isToggle) {
    if (!ENTRIES[key] || !visibleNow(key)) return;
    openKey = isToggle && openKey === key ? null : key;
    if (openKey) fillFly(openKey);
    syncFly();
}

/* ---------- one thread ---------- */

function threadCard(thread) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mz-g';
    card.dataset.mzDock = 'threads';

    card.append(ring(thread));

    const txt = document.createElement('span');
    txt.className = 'mz-g-txt';

    const title = document.createElement('span');
    title.className = 'mz-g-t';
    title.textContent = thread.name || thread.outcome;

    const sub = document.createElement('span');
    sub.className = 'mz-g-s';
    sub.textContent = thread.outcome;

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

function threadItem(thread, index) {
    const item = document.createElement('div');
    item.className = 'mz-item';
    item.dataset.mzItem = `${index}:${thread.name}`;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');

    const row = document.createElement('div');
    row.className = 'mz-item-row';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = thread.name || thread.outcome;

    row.append(title, pips(thread));
    item.append(row);

    if (thread.name && thread.outcome) {
        const sub = document.createElement('p');
        sub.className = 'mz-item-sub';
        sub.textContent = thread.outcome;
        item.append(sub);
    }

    if (thread.state !== 'ticking') {
        const more = document.createElement('div');
        more.className = 'mz-more';

        const chip = document.createElement('span');
        chip.className = `mz-tag ${thread.state === 'fires' ? 'is-warn' : 'is-done'}`;
        chip.textContent = thread.state;

        more.append(chip);
        item.append(more);
    }

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

function itemKey(node) {
    return `${openKey}:${node.dataset.mzItem}`;
}

/* ---------- input ---------- */

function onClick(event) {
    const trigger = event.target.closest('[data-mz-dock]');
    if (trigger) {
        // Dock buttons and the small-screen button toggle; glance cards open.
        const toggles = trigger.classList.contains('mz-dbtn')
            || trigger.classList.contains('mz-railbtn');
        toggle(trigger.dataset.mzDock, toggles);
        return;
    }

    const item = event.target.closest('.mz-item');
    if (item && fly.contains(item)) unfold(item);
}

function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest?.('.mz-item');
    if (!item || !fly.contains(item)) return;

    event.preventDefault();
    unfold(item);
}

function unfold(item) {
    const key = itemKey(item);
    if (openItems.has(key)) openItems.delete(key);
    else openItems.add(key);
    item.classList.toggle('is-open', openItems.has(key));
}
