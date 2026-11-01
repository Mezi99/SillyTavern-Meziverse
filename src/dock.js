/**
 * The tracker rails: an icon menu at the top of the right column, quiet
 * cards under it for the entries that have them, and one popup with the
 * full records — a bottom sheet on small screens.
 *
 * The ledger entries land one at a time, each in ENTRIES with its own
 * popup body and feature switch; entries with `boxes` also draw a glance
 * part under the menu. An entry draws only under Meziverse mode AND its
 * own switch, and only when its rows exist: with nothing to show the
 * whole rail steps aside and the pane keeps the width.
 *
 * The menu buttons snap their entry's boxes, or — for popup-only entries
 * like hooks, lore and recap — open the popup. Clicking a box or card
 * opens the popup too; it closes on a click away or Esc, and clicks
 * inside it never close it, so scrolling is safe. Story text is only
 * ever set as text, never as HTML.
 */

import { icon } from './icons.js';
import { entryOn, modeOn } from './settings.js';

const BOXES_MAX = 3;

/**
 * The ledger entries. `threads` and `plans` carry glance boxes; hooks,
 * lore and recap are popup-only. The rest joins here as it lands, and
 * the future mode-features menu flips their switches in
 * `settings().entries`.
 */
const ENTRIES = {
    threads: {
        title: 'Threads',
        has: ledger => !!ledger && ledger.threads.length > 0,
        sub: ledger => `${ledger.threads.length} live${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.threads.slice(0, BOXES_MAX).map(threadBox),
        body: ledger => ledger.threads.map(threadRecord),
    },
    plans: {
        title: 'Plans',
        has: ledger => !!ledger && ledger.plans.length > 0,
        sub: ledger => `${ledger.plans.length} planned${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => [planCard(ledger.plans)],
        body: ledger => ledger.plans.map(planRecord),
    },
    hooks: {
        title: 'Hooks',
        has: ledger => !!ledger && ledger.hooks.length > 0,
        sub: ledger => `${ledger.hooks.length} open${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.hooks.map(hookRecord),
    },
    lore: {
        title: 'Lore',
        has: ledger => !!ledger && ledger.lore.length > 0,
        sub: ledger => `${ledger.lore.length} seeds${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.lore.map(loreRecord),
    },
    recap: {
        title: 'Story So Far',
        has: ledger => !!ledger && ledger.recap.length > 0,
        sub: ledger => `${ledger.recap.length} moments${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.recap.map(recapRecord),
    },
};

let frame = null;
let glance = null;
let fly = null;
let flyTitle = null;
let flySub = null;
let flyBody = null;
let railButtons = null;

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
    railButtons = root.querySelector('[data-mz-railbtns]');

    if (!frame || !glance || !fly) return;

    // One listener on the document: it sees clicks inside the frame and
    // clicks on SillyTavern's own popups alike, which is exactly what
    // "clicking away closes" needs.
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
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
    if (railButtons) railButtons.hidden = !active;
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

/** One menu button: the entry's glyph in the shared icon menu. */
function menuButton(key) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-dbtn';
    button.dataset.mzDock = key;
    button.append(icon(`mz-i-${key}`));
    syncMenuButton(button, key);
    return button;
}

/**
 * Pressed means the entry is showing itself: boxes visible for the
 * entries that have them, popup open for the popup-only ones.
 */
function syncMenuButton(button, key) {
    const entry = ENTRIES[key];
    const on = entry.boxes ? !hiddenParts.has(key) : openKey === key;

    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = entry.boxes
        ? `${on ? 'Hide' : 'Show'} ${entry.title.toLowerCase()}`
        : entry.title;
    button.setAttribute('aria-label', button.title);
}

function syncMenu() {
    for (const button of glance.querySelectorAll('.mz-dbtn')) {
        syncMenuButton(button, button.dataset.mzDock);
    }
}

/** The chat bar's stand-in for small screens: one popup button per entry. */
function railButton(key) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-ibtn mz-railbtn';
    button.dataset.mzDock = key;
    button.title = ENTRIES[key].title;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(openKey === key));
    button.append(icon(`mz-i-${key}`));
    return button;
}

function buildRail() {
    const keys = visibleKeys();
    const boxes = keys.flatMap(key => {
        const entry = ENTRIES[key];
        return entry.boxes && !hiddenParts.has(key) ? entry.boxes(state) : [];
    });

    const nav = document.createElement('nav');
    nav.className = 'mz-dock mz-dock--h';
    nav.setAttribute('aria-label', 'Ledger');
    nav.append(...keys.map(menuButton));

    glance.replaceChildren(nav, ...boxes);

    if (railButtons) railButtons.replaceChildren(...keys.map(railButton));
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
    syncMenu();

    for (const button of railButtons?.querySelectorAll('.mz-railbtn') || []) {
        button.setAttribute('aria-expanded', String(openKey === button.dataset.mzDock));
    }
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

/** A popup record: name with its state, then plot and outcome — all of it. */
function threadRecord(thread) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = thread.name || thread.outcome || thread.plot;

    // The state pill rides next to the name; the clock keeps the right edge.
    row.append(title, stateChip(thread), pips(thread));
    item.append(row);

    if (thread.plot) {
        const plot = document.createElement('p');
        plot.className = 'mz-item-plot';
        plot.textContent = thread.plot;
        item.append(plot);
    }

    if (thread.outcome) {
        const outcome = document.createElement('p');
        outcome.className = 'mz-item-out';
        outcome.textContent = `Outcome: ${thread.outcome}`;
        item.append(outcome);
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

function stateChip(thread) {
    const chip = document.createElement('span');
    chip.className = 'mz-tag'
        + (thread.state === 'fires' ? ' is-warn' : thread.state === 'resolved' ? ' is-done' : ' is-live');
    chip.textContent = thread.state;
    return chip;
}

/* ---------- one plan ---------- */

/** The rail card: one bordered box, every plan as due over name. */
function planCard(plans) {
    const card = document.createElement('div');
    card.className = 'mz-g mz-plans';
    card.dataset.mzDock = 'plans';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const label = document.createElement('span');
    label.className = 'mz-label';
    label.textContent = 'Plans';
    card.append(label);

    for (const plan of plans) {
        const row = document.createElement('div');
        row.className = 'mz-plan-row';

        const due = document.createElement('span');
        due.className = 'mz-plan-due';
        due.textContent = plan.due || '\u2014';

        const name = document.createElement('span');
        name.className = 'mz-plan-name';
        name.textContent = plan.name || plan.what;

        row.append(due, name);
        card.append(row);
    }

    return card;
}

/** A popup record: due and what and state — the name would only clutter it. */
function planRecord(plan) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const due = document.createElement('div');
    due.className = 'mz-item-title';
    due.textContent = plan.due || '\u2014';
    item.append(due);

    if (plan.what) {
        const what = document.createElement('p');
        what.className = 'mz-item-plot';
        what.textContent = plan.what;
        item.append(what);
    }

    if (plan.state) {
        const state = document.createElement('p');
        state.className = 'mz-item-out';
        state.textContent = `State: ${plan.state}`;
        item.append(state);
    }

    return item;
}

/* ---------- one hook ---------- */

/** A popup record: the question with its state, then the clue. */
function hookRecord(hook) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = hook.question || hook.clue;

    row.append(title, hookChip(hook));
    item.append(row);

    if (hook.question && hook.clue) {
        const clue = document.createElement('p');
        clue.className = 'mz-item-clue';

        const label = document.createElement('span');
        label.className = 'mz-item-lbl';
        label.textContent = 'Clue:';

        clue.append(label, ` ${hook.clue}`);
        item.append(clue);
    }

    return item;
}

function hookChip(hook) {
    const chip = document.createElement('span');
    chip.className = 'mz-tag'
        + (hook.state === 'warm' ? ' is-warn' : hook.state === 'answered' ? ' is-done' : ' is-live');
    chip.textContent = hook.state;
    return chip;
}

/* ---------- one lore seed ---------- */

/** A popup record: the kind over its idea. */
function loreRecord(lore) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    if (lore.kind) {
        const kind = document.createElement('span');
        kind.className = 'mz-kind';
        kind.textContent = lore.kind;
        item.append(kind);
    }

    if (lore.idea) {
        const idea = document.createElement('p');
        idea.className = 'mz-item-plot';
        idea.textContent = lore.idea;
        item.append(idea);
    }

    return item;
}

/* ---------- one recap moment ---------- */

/** A popup record on the story timeline: era, fact, and the subtext. */
function recapRecord(recap) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full mz-recap';

    const orn = document.createElement('i');
    orn.className = 'mz-orn';
    orn.setAttribute('aria-hidden', 'true');
    item.append(orn);

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const era = document.createElement('span');
    era.className = 'mz-item-title';
    era.textContent = recap.era || recap.fact;

    row.append(era);
    item.append(row);

    if (recap.era && recap.fact) {
        const fact = document.createElement('p');
        fact.className = 'mz-item-plot';
        fact.textContent = recap.fact;
        item.append(fact);
    }

    if (recap.subtext) {
        const subtext = document.createElement('p');
        subtext.className = 'mz-item-out';
        subtext.textContent = `Subtext: ${recap.subtext}`;
        item.append(subtext);
    }

    return item;
}

/* ---------- input ---------- */

function activate(trigger) {
    const key = trigger.dataset.mzDock;
    const entry = ENTRIES[key] || {};

    if (trigger.classList.contains('mz-dbtn')) {
        // The menu snaps the boxes, or opens the popup when there are none.
        if (entry.boxes) toggleParts(key);
        else if (openKey === key) closeDock();
        else openPopup(key);
    } else if (trigger.classList.contains('mz-railbtn')) {
        // Small screens have no boxes to click: the button is the popup.
        if (openKey === key) closeDock();
        else openPopup(key);
    } else {
        openPopup(key);
    }
}

function onClick(event) {
    const trigger = event.target.closest('[data-mz-dock]');
    if (trigger) {
        activate(trigger);
        return;
    }

    // A click anywhere else closes the popup. Clicks inside it never do,
    // so touching, scrolling or selecting within it is safe.
    if (openKey && !fly.contains(event.target)) closeDock();
}

function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    const trigger = event.target.closest?.('[data-mz-dock]');
    // Real buttons do this on their own; only the card needs help.
    if (!trigger || trigger instanceof HTMLButtonElement) return;

    event.preventDefault();
    activate(trigger);
}
