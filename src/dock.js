/**
 * The tracker rails: an icon menu over each column — the People side on
 * the left, the story side on the right — quiet cards under the menus
 * for the entries that have them, and one popup with the full records
 * (a bottom sheet on small screens). The left menu also carries the
 * chat log, so the log is always within reach; on small screens one
 * slim strip in the chat bar stands in for both menus.
 *
 * The ledger entries land one at a time, each in ENTRIES with its own
 * side, popup body and feature switch; entries with `boxes` also draw
 * glance cards under their menu. An entry draws only under Meziverse
 * mode AND its own switch, and only when its rows exist: with nothing
 * to show the column steps aside and the pane keeps the width.
 *
 * The menu buttons snap their entry's boxes, or — for popup-only entries
 * like hooks, lore and recap — open the popup. Clicking a box or card
 * opens the popup too (profiles open their full card instead); it all
 * closes on a click away or Esc, and clicks inside never close it, so
 * scrolling is safe. Story text is only ever set as text, never HTML.
 */

import { icon } from './icons.js';
import { castAvatar } from './cast.js';
import { entryOn, modeOn } from './settings.js';
import { meterMax, parseStakes } from './ledger.js';
import { say } from './st.js';

const BOXES_MAX = 3;
const PROFILES_MAX = 6;
const SHIFTS_MAX = 6;

/**
 * The ledger entries. `standing` leads the left side — how the world
 * sees you, above the profiles — and `profiles` follows: mini profile
 * cards at a glance and a full card per character. `shifts` sits under
 * them: the pairs that moved this turn. `threads` and `plans` carry
 * right-side glance boxes; hooks, lore and recap are popup-only. The
 * rest joins here as it lands, and the future mode-features menu flips
 * their switches in `settings().entries`.
 */
const ENTRIES = {
    standing: {
        title: 'Standing',
        side: 'l',
        has: ledger => !!ledger && ledger.standing.length > 0,
        sub: ledger => `${ledger.standing.length} tracks${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.standing.slice(0, BOXES_MAX).map(standingBox),
        body: ledger => ledger.standing.map(standingRecord),
    },
    profiles: {
        title: 'Profiles',
        side: 'l',
        has: ledger => !!ledger && ledger.profiles.length > 0,
        sub: ledger => `${ledger.profiles.length} in this scene${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.profiles.slice(0, PROFILES_MAX).map(profileBox),
        body: ledger => ledger.profiles.map(profileRecord),
    },
    shifts: {
        title: 'Shifts',
        side: 'l',
        has: ledger => !!ledger && ledger.shifts.length > 0,
        sub: ledger => `${ledger.shifts.length} changed this turn${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.shifts.slice(0, SHIFTS_MAX).map(shiftBox),
        body: ledger => ledger.shifts.map(shiftRecord),
    },
    threads: {
        title: 'Threads',
        side: 'r',
        has: ledger => !!ledger && ledger.threads.length > 0,
        sub: ledger => `${ledger.threads.length} live${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => ledger.threads.slice(0, BOXES_MAX).map(threadBox),
        body: ledger => ledger.threads.map(threadRecord),
    },
    plans: {
        title: 'Plans',
        side: 'r',
        has: ledger => !!ledger && ledger.plans.length > 0,
        sub: ledger => `${ledger.plans.length} planned${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        boxes: ledger => [planCard(ledger.plans)],
        body: ledger => ledger.plans.map(planRecord),
    },
    hooks: {
        title: 'Hooks',
        side: 'r',
        has: ledger => !!ledger && ledger.hooks.length > 0,
        sub: ledger => `${ledger.hooks.length} open${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.hooks.map(hookRecord),
    },
    lore: {
        title: 'Lore',
        side: 'r',
        has: ledger => !!ledger && ledger.lore.length > 0,
        sub: ledger => `${ledger.lore.length} seeds${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.lore.map(loreRecord),
    },
    recap: {
        title: 'Story So Far',
        side: 'r',
        has: ledger => !!ledger && ledger.recap.length > 0,
        sub: ledger => `${ledger.recap.length} moments${ledger.carried ? ` \u00b7 from turn ${ledger.turn}` : ''}`,
        body: ledger => ledger.recap.map(recapRecord),
    },
};

let frame = null;
let glanceL = null;
let glanceR = null;
let fly = null;
let flyTitle = null;
let flySub = null;
let flyBody = null;
let railButtons = null;
let card = null;
let cardBody = null;

let state = null;
let openKey = null;
let lastSignature = null;

/* Entries whose boxes are snapped off. Session-only: the future
   mode-features menu owns what should persist. */
const hiddenParts = new Set();

/** Mounts the rails inside the frame. Idempotent. */
export function mountDock(root) {
    if (!root || frame) return;

    frame = root.querySelector('.mz-frame');
    glanceL = root.querySelector('[data-mz="glance-l"]');
    glanceR = root.querySelector('[data-mz="glance"]');
    fly = root.querySelector('[data-mz="fly"]');
    flyTitle = fly?.querySelector('[data-mz="fly-title"]');
    flySub = fly?.querySelector('[data-mz="fly-sub"]');
    flyBody = fly?.querySelector('[data-mz="fly-body"]');
    railButtons = root.querySelector('[data-mz-railbtns]');
    card = root.querySelector('[data-mz="card"]');
    cardBody = card?.querySelector('[data-mz="card-body"]');

    if (!frame || !glanceL || !glanceR || !fly || !card) return;

    // One listener on the document: it sees clicks inside the frame and
    // clicks on SillyTavern's own popups alike, which is exactly what
    // "clicking away closes" needs.
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
}

/**
 * Draws both rails for one resolved ledger (or null when the turn has
 * none). Rebuilds only when the board changes, so streaming frames are
 * cheap.
 *
 * @param {{threads:object[], profiles:object[], standing:object[], turn:number, carried:boolean}|null} ledger
 */
export function renderDock(ledger) {
    if (!frame) return;

    state = ledger && Array.isArray(ledger.threads) ? ledger : null;

    const visible = Object.keys(ENTRIES).filter(visibleNow);
    if (openKey && !visible.includes(openKey)) openKey = null;

    const leftOn = visible.some(key => ENTRIES[key].side === 'l');
    const rightOn = visible.some(key => ENTRIES[key].side !== 'l');
    frame.classList.toggle('is-rails-l', leftOn);
    frame.classList.toggle('is-rails-r', rightOn);
    glanceR.hidden = !rightOn;
    // The left column is chrome too — its menu carries the chat log — so
    // it never steps aside; only its cards come and go.

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

/** Whether one character's full profile card is open. */
export function isCardOpen() {
    return !!frame && frame.classList.contains('is-card-open');
}

/** Closes the full profile card, if one is open. */
export function closeCard() {
    if (!isCardOpen()) return;
    frame.classList.remove('is-card-open');
    card.setAttribute('aria-hidden', 'true');
}

/* ---------- the rails ---------- */

function visibleNow(key) {
    return modeOn() && entryOn(key) && !!ENTRIES[key]?.has(state);
}

function visibleKeys() {
    return Object.keys(ENTRIES).filter(visibleNow);
}

/** One menu button: the entry's glyph in its side's icon menu. */
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
 * The chat log button. It is chrome, not an entry: it lives at the head
 * of the left menu and at the head of the small-screen strip so the log
 * is always within reach.
 */
function logButton(className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.mzAction = 'log';
    button.title = 'Chat log';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', 'false');
    button.append(icon('mz-i-log'));
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
    for (const button of frame.querySelectorAll('.mz-dbtn[data-mz-dock]')) {
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
    const leftKeys = keys.filter(key => ENTRIES[key].side === 'l');
    const rightKeys = keys.filter(key => ENTRIES[key].side !== 'l');

    const leftNav = document.createElement('nav');
    leftNav.className = 'mz-dock mz-dock--h';
    leftNav.setAttribute('aria-label', 'People');
    leftNav.append(logButton('mz-dbtn'), ...leftKeys.map(menuButton));

    glanceL.replaceChildren(leftNav, ...boxesFor(leftKeys));

    const rightNav = document.createElement('nav');
    rightNav.className = 'mz-dock mz-dock--h';
    rightNav.setAttribute('aria-label', 'Story');
    rightNav.append(...rightKeys.map(menuButton));

    glanceR.replaceChildren(rightNav, ...boxesFor(rightKeys));

    if (railButtons) {
        railButtons.replaceChildren(logButton('mz-ibtn mz-railbtn'), ...keys.map(railButton));
    }
}

function boxesFor(keys) {
    return keys.flatMap(key => {
        const entry = ENTRIES[key];
        return entry.boxes && !hiddenParts.has(key) ? entry.boxes(state) : [];
    });
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

    if (hadFocus) frame.querySelector(`.mz-dbtn[data-mz-dock="${key}"]`)?.focus();
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

    // The popup opens beside its own rail: people on the left, story
    // on the right.
    if (openKey) {
        const left = ENTRIES[openKey]?.side === 'l';
        fly.classList.toggle('mz-fly--l', left);
        fly.classList.toggle('mz-fly--r', !left);
    }

    syncMenu();

    for (const button of railButtons?.querySelectorAll('.mz-railbtn[data-mz-dock]') || []) {
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

/* ---------- one standing ---------- */

/**
 * The level bar: a track of ten, filled to the level. The tone turns at
 * the halfway mark — below five is the bad end of the stakes.
 */
function levelBar(standing) {
    const bar = document.createElement('span');
    bar.className = 'mz-stand-bar ' + (standing.level >= 5 ? 'is-high' : 'is-low');

    const fill = document.createElement('i');
    fill.style.width = `${standing.level * 10}%`;
    bar.append(fill);
    return bar;
}

/**
 * The change chip: `+2` or `−1` since the ledger last spoke, or the
 * small `new` of a track the board has not seen before. An unchanged
 * meter wears nothing.
 */
function deltaChip(value) {
    const chip = document.createElement('span');

    if (value === 'new') {
        chip.className = 'mz-delta is-new';
        chip.textContent = 'new';
        return chip;
    }

    if (typeof value !== 'number' || value === 0) return null;

    chip.className = 'mz-delta' + (value > 0 ? ' is-up' : ' is-down');
    chip.textContent = value > 0 ? `+${value}` : `\u2212${Math.abs(value)}`;
    return chip;
}

/**
 * The change bubble: the mockup's notification badge — the colour on
 * the pill, the signed number white inside. A track new to the board
 * keeps its small italic word instead; an unchanged meter wears
 * nothing.
 */
function deltaBubble(value) {
    const chip = document.createElement('span');

    if (value === 'new') {
        chip.className = 'mz-delta is-new';
        chip.textContent = 'new';
        return chip;
    }

    if (typeof value !== 'number' || value === 0) return null;

    chip.className = 'mz-delta-b' + (value > 0 ? ' is-up' : ' is-down');
    chip.textContent = value > 0 ? `+${value}` : `−${Math.abs(value)}`;
    return chip;
}

/** The level and its change on one line, right of the name. */
function levelLine(standing) {
    const wrap = document.createElement('span');
    wrap.className = 'mz-stand-level';

    if (standing.level !== null) {
        const num = document.createElement('span');
        num.className = 'mz-stand-num';
        num.textContent = `${standing.level} / 10`;
        wrap.append(num);
    }

    const chip = deltaChip(standing.delta);
    if (chip) wrap.append(chip);
    return wrap;
}

/**
 * A rail box: the track's name with its change beside it, the level
 * pinned at the right — always the same spot, chip or no chip — and
 * the bar beneath. The rest of the record lives in the fly.
 */
function standingBox(standing) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mz-g mz-g--quiet mz-stand';
    card.dataset.mzDock = 'standing';

    const txt = document.createElement('span');
    txt.className = 'mz-g-txt';

    const row = document.createElement('span');
    row.className = 'mz-stand-row';

    const name = document.createElement('span');
    name.className = 'mz-g-t mz-stand-name';
    name.textContent = say(standing.name || standing.track);
    row.append(name);

    const chip = deltaBubble(standing.delta);
    if (chip) row.append(chip);

    if (standing.level !== null) {
        const num = document.createElement('span');
        num.className = 'mz-stand-num';
        num.textContent = `${standing.level} / 10`;
        row.append(num);
    }

    txt.append(row);
    if (standing.level !== null) txt.append(levelBar(standing));

    card.append(txt);
    return card;
}

/**
 * A popup record: the track with its level and change, then who sees
 * {{user}} and how — both ends of the stakes and what moved it.
 */
function standingRecord(standing) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = say(standing.name || standing.track);

    row.append(title, levelLine(standing));
    item.append(row);

    if (standing.level !== null) item.append(levelBar(standing));

    if (standing.track) {
        const track = document.createElement('p');
        track.className = 'mz-item-plot';
        track.textContent = say(standing.track);
        item.append(track);
    }

    if (standing.state) {
        const state = document.createElement('p');
        state.className = 'mz-item-out';
        state.textContent = `Now: ${say(standing.state)}`;
        item.append(state);
    }

    const stakes = parseStakes(standing.stakes);

    if (stakes) {
        const ends = document.createElement('div');
        ends.className = 'mz-ends';

        for (const [end, value] of [['0', stakes.zero], ['10', stakes.ten]]) {
            const col = document.createElement('div');
            const b = document.createElement('b');
            b.textContent = end;
            col.append(b, say(value));
            ends.append(col);
        }

        item.append(ends);
    } else if (standing.stakes) {
        const line = document.createElement('p');
        line.className = 'mz-item-out';
        line.textContent = `Stakes: ${say(standing.stakes)}`;
        item.append(line);
    }

    if (standing.cause) {
        const cause = document.createElement('p');
        cause.className = 'mz-item-sub mz-subtext';

        const label = document.createElement('span');
        label.className = 'mz-item-lbl';
        label.textContent = 'Cause:';

        cause.append(label, ` ${say(standing.cause)}`);
        item.append(cause);
    }

    return item;
}

/* ---------- one profile ---------- */

/**
 * A rail box: the avatar and the base info that changes every turn —
 * who they are, how they are. The look and the rest of the record live
 * in the full card, one button away.
 */
function profileBox(profile, index) {
    const card = document.createElement('div');
    card.className = 'mz-g mz-prof';
    card.dataset.mzProfile = String(index);

    card.append(avatar(profile.character, 'mz-avatar'));

    const txt = document.createElement('span');
    txt.className = 'mz-g-txt';

    const name = document.createElement('span');
    name.className = 'mz-g-t mz-prof-name';
    name.textContent = profile.character || profile.state;
    txt.append(name);

    if (profile.character && profile.state) {
        const state = document.createElement('span');
        state.className = 'mz-prof-state';
        state.textContent = profile.state;
        txt.append(state);
    }

    card.append(txt, fullProfileButton());
    return card;
}

/** A popup record for small screens: base info, and the full card's door. */
function profileRecord(profile, index) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';
    item.dataset.mzProfile = String(index);

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = profile.character || profile.state;

    row.append(avatar(profile.character, 'mz-avatar'), title, fullProfileButton());
    item.append(row);

    if (profile.character && profile.state) {
        const state = document.createElement('p');
        state.className = 'mz-item-plot';
        state.textContent = profile.state;
        item.append(state);
    }

    if (profile.look) {
        const look = document.createElement('p');
        look.className = 'mz-item-out';
        look.textContent = profile.look;
        item.append(look);
    }

    return item;
}

/**
 * The full profile card: a header "scene" — the avatar figure standing
 * in a spotlight where there is one, the name over the state over the
 * private thought — then the record as its own little sections. The
 * relevant shifts join the foot here when they land.
 */
function profileCard(profile) {
    const fragment = document.createDocumentFragment();
    const { src } = castAvatar(profile.character);

    const band = document.createElement('div');
    band.className = 'mz-card-band';

    if (src) {
        const image = document.createElement('img');
        image.className = 'mz-card-img';
        image.alt = '';
        image.src = src;
        band.append(image);
    }

    const head = document.createElement('div');
    head.className = 'mz-card-head';

    const title = document.createElement('h2');
    title.textContent = say(profile.character || profile.state);
    head.append(title);

    if (profile.character && profile.state) {
        const sub = document.createElement('p');
        sub.className = 'mz-card-sub';
        sub.textContent = say(profile.state);
        head.append(sub);
    }

    if (profile.thought) {
        const thought = document.createElement('p');
        thought.className = 'mz-thought';
        thought.textContent = say(profile.thought);
        head.append(thought);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mz-ibtn mz-card-close';
    close.dataset.mzCardClose = '';
    close.title = 'Close full profile';
    close.setAttribute('aria-label', close.title);
    close.append(icon('mz-i-close'));

    band.append(head, close);
    fragment.append(band);

    const body = document.createElement('div');
    body.className = 'mz-card-body';
    body.append(...profileSections(profile));
    fragment.append(body);
    return fragment;
}

/**
 * The record as the mockup's whim tiles: "Right now" (the look and the
 * next move side by side), "Wants" as a ladder (goal, ambition, desire),
 * and the secret on its own tile below. A section with no tiles does
 * not exist.
 */
function profileSections(profile) {
    const parts = [];

    const now = [
        profile.look && whimTile('look', 'Look', profile.look, 'mz-i-eye'),
        profile.next && whimTile('next', 'Next', profile.next, 'mz-i-next'),
    ].filter(Boolean);
    if (now.length) parts.push(whimSection('Right now', 'is-pair', now));

    const wants = [
        profile.goal && whimTile('goal', 'Goal', profile.goal, 'mz-i-plans'),
        profile.ambition && whimTile('ambition', 'Ambition', profile.ambition, 'mz-i-lore'),
        profile.desire && whimTile('desire', 'Desire', profile.desire, 'mz-i-desire'),
    ].filter(Boolean);
    if (wants.length) parts.push(whimSection('Wants', 'is-path', wants));

    if (profile.secret) {
        const grid = document.createElement('div');
        grid.className = 'mz-whims';
        grid.append(whimTile('secret', 'Secret', profile.secret, 'mz-i-eye-off'));
        parts.push(grid);
    }

    return parts;
}

/** A titled band of tiles under hairline rules. */
function whimSection(title, kind, tiles) {
    const section = document.createElement('section');
    section.className = 'mz-sec';

    const head = document.createElement('h3');
    head.className = 'mz-sec-t';
    head.textContent = title;

    const grid = document.createElement('div');
    grid.className = `mz-whims ${kind}`;
    grid.append(...tiles);

    section.append(head, grid);
    return section;
}

/**
 * One fact as a tile: the icon, the small label, the value. The look
 * reads as trait chips — a display-only split on commas; the text
 * itself is never touched.
 */
function whimTile(field, label, value, symbol) {
    const tile = document.createElement('div');
    tile.className = 'mz-whim' + (field === 'secret' ? ' is-secret' : '');

    const glyph = document.createElement('span');
    glyph.className = 'mz-whim-ico';
    glyph.append(icon(symbol));
    tile.append(glyph);

    const key = document.createElement('span');
    key.className = 'mz-whim-k';
    key.textContent = label;
    tile.append(key);

    if (field === 'look') {
        const traits = document.createElement('span');
        traits.className = 'mz-traits';
        for (const part of String(value).split(/,\s*/)) {
            if (!part) continue;
            const chip = document.createElement('span');
            chip.className = 'mz-trait';
            chip.textContent = say(part);
            traits.append(chip);
        }
        tile.append(traits);
    } else {
        const val = document.createElement('span');
        val.className = 'mz-whim-v';
        val.textContent = say(value);
        tile.append(val);
    }

    return tile;
}

/** The small avatar: the chat's portrait image, or just the initial. */
function avatar(name, className) {
    const span = document.createElement('span');
    span.className = className;
    span.setAttribute('aria-hidden', 'true');

    const { src, initial } = castAvatar(name);
    if (src) {
        const image = document.createElement('img');
        image.alt = '';
        image.src = src;
        span.append(image);
    } else {
        span.textContent = initial;
    }

    return span;
}

/** The door from any profile surface into the full card. */
function fullProfileButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-prof-more';
    button.title = 'Full profile';
    button.setAttribute('aria-label', button.title);
    button.append(icon('mz-i-profiles'));
    return button;
}

function openProfileCard(index) {
    const profile = state?.profiles?.[index];
    if (!profile || !card) return;

    // One surface at a time: the card takes the stage over everything.
    closeDock();
    cardBody.replaceChildren(profileCard(profile));
    frame.classList.add('is-card-open');
    card.setAttribute('aria-hidden', 'false');
    card.querySelector('[data-mz-card-close]')?.focus({ preventScroll: true });
}

/* ---------- one shift ---------- */

/** A meter total as display text: `+101 / 200`, signed and scaled. */
function meterNum(total, max) {
    const sign = total > 0 ? '+' : total < 0 ? '−' : '';
    return `${sign}${Math.abs(total)} / ${max}`;
}

/**
 * One meter of a pair. On the rail: the glyph, the slim bar taking all
 * the room the totals used to hold, and the change bubble in a fixed
 * slot — so the bar never grows or shrinks with the chip — with the
 * total on hover. In the fly: the word, the bar, the total and the
 * change, all of it on one line.
 *
 * The bar's full width is the pair's own recent widest — the total and
 * the one before it — rounded up to the next hundred, so 101 reads as
 * 101 / 200 and nothing caps the meters. The tone flips with the sign:
 * a bond spent below zero goes wary yellow, a desire below zero goes
 * its own purple.
 */
function meterStrip(kind, total, delta, full) {
    const strip = document.createElement('div');
    strip.className = 'mz-meter' + (kind === 'desire' ? ' is-desire' : '');

    if (full) {
        const label = document.createElement('span');
        label.className = 'mz-meter-l';
        label.textContent = kind;
        strip.append(label);
    } else {
        strip.append(icon(kind === 'desire' ? 'mz-i-desire' : 'mz-i-bond', 'mz-meter-ic'));
    }

    if (total !== null) {
        const max = meterMax(total, delta);

        const bar = document.createElement('span');
        bar.className = 'mz-meter-bar' + (total < 0 ? ' is-neg' : '');

        const fill = document.createElement('i');
        fill.style.width = `${Math.min(100, Math.abs(total) / max * 100)}%`;
        bar.append(fill);
        strip.append(bar);

        if (full) {
            const num = document.createElement('span');
            num.className = 'mz-meter-num';
            num.textContent = meterNum(total, max);
            strip.append(num);
        } else {
            strip.title = `${kind} ${meterNum(total, max)}`;
        }
    }

    if (full) {
        const chip = deltaChip(delta);
        if (chip) strip.append(chip);
    } else {
        const slot = document.createElement('span');
        slot.className = 'mz-meter-slot';

        const bubble = deltaBubble(delta);
        if (bubble) slot.append(bubble);
        strip.append(slot);
    }

    return strip;
}

/** The pair as display text: `from → toward`, whichever side exists. */
function pairLine(shift) {
    return [say(shift.from), say(shift.toward)].filter(Boolean).join(' → ');
}

/**
 * A rail box: the pair and its two meters — bond and desire, each a
 * slim bar with the total and this turn's move. The rest of the
 * record lives in the fly.
 */
function shiftBox(shift) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mz-g mz-g--quiet mz-shift';
    card.dataset.mzDock = 'shifts';

    const txt = document.createElement('span');
    txt.className = 'mz-g-txt';

    const pair = document.createElement('span');
    pair.className = 'mz-g-t mz-shift-pair';
    pair.textContent = pairLine(shift);

    txt.append(pair, meterStrip('bond', shift.bondTotal, shift.delta), meterStrip('desire', shift.desireTotal, shift.ddelta));
    card.append(txt);
    return card;
}

/**
 * A popup record, squeezed from the mockup: the pair with its bond
 * type, the two meters side by side, then the state of the pair and
 * what moved each meter — one tight foot instead of stacked panels.
 */
function shiftRecord(shift) {
    const item = document.createElement('div');
    item.className = 'mz-item is-full';

    const row = document.createElement('div');
    row.className = 'mz-item-row mz-item-row--title';

    const title = document.createElement('span');
    title.className = 'mz-item-title';
    title.textContent = pairLine(shift);
    row.append(title);

    if (shift.bond) {
        const bond = document.createElement('span');
        bond.className = 'mz-item-meta';
        bond.textContent = say(shift.bond);
        row.append(bond);
    }

    item.append(row);

    const meters = document.createElement('div');
    meters.className = 'mz-meters';
    meters.append(
        meterStrip('bond', shift.bondTotal, shift.delta, true),
        meterStrip('desire', shift.desireTotal, shift.ddelta, true),
    );
    item.append(meters);

    if (shift.status) {
        const state = document.createElement('p');
        state.className = 'mz-item-out';
        state.textContent = `Now: ${say(shift.status)}`;
        item.append(state);
    }

    if (shift.cause) {
        const cause = document.createElement('p');
        cause.className = 'mz-item-sub mz-subtext';

        const label = document.createElement('span');
        label.className = 'mz-item-lbl';
        label.textContent = 'Cause:';

        cause.append(label, ` ${say(shift.cause)}`);
        item.append(cause);
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
    const cardClose = event.target.closest('[data-mz-card-close]');
    if (cardClose) {
        closeCard();
        return;
    }

    const profileTrigger = event.target.closest('[data-mz-profile]');
    if (profileTrigger) {
        openProfileCard(Number(profileTrigger.dataset.mzProfile));
        return;
    }

    const trigger = event.target.closest('[data-mz-dock]');
    if (trigger) {
        activate(trigger);
        return;
    }

    // A click anywhere else closes the popup — a real one. Scripts
    // fire synthetic clicks (SillyTavern does, on the composer) and
    // carry no intent to dismiss anything.
    if (openKey && event.isTrusted && !fly.contains(event.target)) closeDock();
}

function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    const trigger = event.target.closest?.('[data-mz-dock]');
    // Real buttons do this on their own; only the card needs help.
    if (!trigger || trigger instanceof HTMLButtonElement) return;

    event.preventDefault();
    activate(trigger);
}
