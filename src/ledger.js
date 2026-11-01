/**
 * What a `LEDGER` block says, and which ledger belongs to the turn being read.
 *
 * Pure like scene.js: the chat is an array of messages, a message is `mes`,
 * and nothing here stores or edits either. The ledger is full state per reply
 * — parse only, never accumulated — so the last complete block of the shown
 * message governs, and a turn without one inherits the latest earlier block,
 * labelled with that turn's number.
 *
 * Only catalogue row tags are read. `goals` rows are collected (they exist)
 * but never rendered anywhere; no limits are enforced.
 */

import { parseMessage, parseTags } from './tags.js';

const rowsCache = new WeakMap();

function text(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * The complete rows of the last complete `LEDGER` block of one message,
 * or null when the message has none. A block still streaming is not a block:
 * it falls back to the earlier ledger rather than showing half its rows.
 *
 * @param {object} message
 * @returns {Array<object>|null}
 */
export function ledgerRows(message) {
    if (!message || typeof message !== 'object') return null;

    const { mes, tags } = parseMessage(message);
    const hit = rowsCache.get(message);
    if (hit && hit.mes === mes) return hit.rows;

    let rows = null;

    for (const tag of tags) {
        if (tag.name !== 'ledger' || !tag.closed) continue;
        rows = parseTags(text(tag.body)).filter(row => row.closed);
    }

    rowsCache.set(message, { mes, rows });
    return rows;
}

/**
 * Reads a thread's clock. The tag carries its own pip string (`●●●○○`); a
 * bare number is tolerated as N of N, and `N/M` is read as written.
 *
 * @param {string} value
 * @returns {{fill:number, total:number}}
 */
export function parseClock(value) {
    const raw = text(value).trim();
    if (!raw) return { fill: 0, total: 0 };

    const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
    if (ratio) {
        const total = Math.min(99, Number(ratio[2]));
        return { fill: Math.min(total, Number(ratio[1])), total };
    }

    if (/^\d+$/.test(raw)) {
        const n = Math.min(99, Number(raw));
        return { fill: n, total: n };
    }

    const glyphs = [...raw].filter(char => '\u25cf\u25c9\u25cb'.includes(char));
    const total = glyphs.length;
    const fill = glyphs.filter(char => char !== '\u25cb').length;

    return { fill, total };
}

/** The display state of a thread: `fires`, `resolved`, or `ticking`. */
export function normalizeState(value) {
    const raw = text(value).trim().toLowerCase();
    if (raw === 'fires') return 'fires';
    if (raw === 'resolved') return 'resolved';
    return 'ticking';
}

/**
 * The thread rows of a ledger, in the tag's own order.
 *
 * @param {Array<object>} rows
 * @returns {Array<{name:string, plot:string, outcome:string, state:string, clock:string, fill:number, total:number}>}
 */
export function normalizeThreads(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const threads = [];

    for (const row of list) {
        if (!row || row.name !== 'thread' || !row.closed) continue;

        const attrs = row.attrs || {};
        const name = text(attrs.name).trim();
        const plot = text(attrs.plot).trim();
        const outcome = text(attrs.outcome).trim();
        if (!name && !outcome && !plot) continue;

        const clock = text(attrs.clock).trim();
        const { fill, total } = parseClock(clock);

        threads.push({ name, plot, outcome, state: normalizeState(attrs.state), clock, fill, total });
    }

    return threads;
}

/**
 * The board order: threads about to fire lead, then the fullest clocks.
 * Ties keep the tag's own order.
 */
export function sortThreads(threads) {
    const list = Array.isArray(threads) ? threads : [];
    return [...list].sort((a, b) =>
        (b.state === 'fires') - (a.state === 'fires') || b.fill - a.fill);
}

/**
 * The plan rows of a ledger, in the tag's own order. `due` is free text,
 * so no date sort would be honest; the tag's order is the board.
 *
 * @param {Array<object>} rows
 * @returns {Array<{name:string, what:string, due:string, state:string}>}
 */
export function normalizePlans(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const plans = [];

    for (const row of list) {
        if (!row || row.name !== 'plan' || !row.closed) continue;

        const attrs = row.attrs || {};
        const name = text(attrs.name).trim();
        const what = text(attrs.what).trim();
        const due = text(attrs.due).trim();
        const state = text(attrs.state).trim();
        if (!name && !what && !due) continue;

        plans.push({ name, what, due, state });
    }

    return plans;
}

/**
 * The recap rows of a ledger — the story so far — in the tag's own order.
 * The order is the chronology, so it is never touched.
 *
 * @param {Array<object>} rows
 * @returns {Array<{era:string, fact:string, subtext:string}>}
 */
export function normalizeRecap(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const recap = [];

    for (const row of list) {
        if (!row || row.name !== 'recap' || !row.closed) continue;

        const attrs = row.attrs || {};
        const era = text(attrs.era).trim();
        const fact = text(attrs.fact).trim();
        const subtext = text(attrs.subtext).trim();
        if (!era && !fact) continue;

        recap.push({ era, fact, subtext });
    }

    return recap;
}

/**
 * The lore rows of a ledger, in the tag's own order: a kind and its idea.
 *
 * @param {Array<object>} rows
 * @returns {Array<{kind:string, idea:string}>}
 */
export function normalizeLore(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const lore = [];

    for (const row of list) {
        if (!row || row.name !== 'lore' || !row.closed) continue;

        const attrs = row.attrs || {};
        const kind = text(attrs.kind).trim();
        const idea = text(attrs.idea).trim();
        if (!kind && !idea) continue;

        lore.push({ kind, idea });
    }

    return lore;
}

/** The display state of a hook: `warm`, `answered`, or `open`. */
export function normalizeHookState(value) {
    const raw = text(value).trim().toLowerCase();
    if (raw === 'warm') return 'warm';
    if (raw === 'answered') return 'answered';
    return 'open';
}

/**
 * The hook rows of a ledger, in the tag's own order: an open question,
 * its clue, and how warm it is.
 *
 * @param {Array<object>} rows
 * @returns {Array<{question:string, clue:string, state:string}>}
 */
export function normalizeHooks(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const hooks = [];

    for (const row of list) {
        if (!row || row.name !== 'hook' || !row.closed) continue;

        const attrs = row.attrs || {};
        const question = text(attrs.question).trim();
        const clue = text(attrs.clue).trim();
        if (!question && !clue) continue;

        hooks.push({ question, clue, state: normalizeHookState(attrs.state) });
    }

    return hooks;
}

/**
 * The profile rows of a ledger, in the tag's own order. Every field is
 * free text — the ledger only carries it. A row naming nothing is
 * dropped: no character and no state, like a lone subtext on recap.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function normalizeProfiles(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const profiles = [];

    for (const row of list) {
        if (!row || row.name !== 'profile' || !row.closed) continue;

        const attrs = row.attrs || {};
        const character = text(attrs.character).trim();
        const state = text(attrs.state).trim();
        if (!character && !state) continue;

        profiles.push({
            character,
            state,
            look: text(attrs.look).trim(),
            secret: text(attrs.secret).trim(),
            next: text(attrs.next).trim(),
            goal: text(attrs.goal).trim(),
            ambition: text(attrs.ambition).trim(),
            desire: text(attrs.desire).trim(),
            thought: text(attrs.thought).trim(),
        });
    }

    return profiles;
}

/**
 * A standing's level. The tag writes 0–10; the number is clamped for
 * the bar and unreadable input is null — the row still renders, it just
 * carries no bar or number.
 *
 * @param {string} value
 * @returns {number|null}
 */
export function parseLevel(value) {
    const raw = text(value).trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Math.max(0, Math.min(10, Number(raw)));
}

/**
 * The standing rows of a ledger, in the tag's own order: how some part
 * of the world sees {{user}}, on a 0–10 track with both ends named.
 * Everything but the level is free text.
 *
 * @param {Array<object>} rows
 * @returns {Array<{name:string, track:string, state:string, level:number|null, stakes:string, cause:string}>}
 */
export function normalizeStanding(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const standing = [];

    for (const row of list) {
        if (!row || row.name !== 'standing' || !row.closed) continue;

        const attrs = row.attrs || {};
        const name = text(attrs.name).trim();
        const track = text(attrs.track).trim();
        const state = text(attrs.state).trim();
        if (!name && !track && !state) continue;

        standing.push({
            name,
            track,
            state,
            level: parseLevel(attrs.level),
            stakes: text(attrs.stakes).trim(),
            cause: text(attrs.cause).trim(),
        });
    }

    return standing;
}

/**
 * Reads the stakes line: `at 0: … ; at 10: …`, both ends named. A line
 * that does not pair up is not stakes — the caller shows it as written.
 *
 * @param {string} value
 * @returns {{zero:string, ten:string}|null}
 */
export function parseStakes(value) {
    const raw = text(value).trim();
    const hit = /^at\s*0:\s*(.+?)\s*[,;]\s*at\s*10:\s*(.+)$/is.exec(raw);
    if (!hit) return null;

    return { zero: hit[1].trim(), ten: hit[2].trim() };
}

function standingKey(track) {
    return (track.name || track.track).trim().toLowerCase();
}

/**
 * The change chips: how each level moved since the ledger last spoke.
 * A track the previous block did not carry is `new`; a level that did
 * not move is 0, and an unreadable pair simply has no change. This is
 * derived per block, never remembered — the ledger stays full state.
 *
 * @param {Array<object>} standing this block's rows
 * @param {Array<object>} previous the block before it
 * @returns {Array<object>} the same rows with a `delta` on each
 */
export function withStandingDeltas(standing, previous) {
    const list = Array.isArray(standing) ? standing : [];

    const before = new Map();
    for (const track of (Array.isArray(previous) ? previous : [])) {
        const key = standingKey(track);
        if (key && !before.has(key)) before.set(key, track.level);
    }

    return list.map(track => {
        const prev = before.get(standingKey(track));

        let delta = null;
        if (prev === undefined) delta = 'new';
        else if (prev !== null && track.level !== null) delta = track.level - prev;

        return { ...track, delta };
    });
}

/** The rows of the closest complete block before `from`, or null. */
function previousRows(list, from) {
    for (let i = from - 1; i >= 0; i -= 1) {
        const rows = ledgerRows(list[i]);
        if (rows) return rows;
    }

    return null;
}

/**
 * The ledger that governs a turn: the last complete block of the shown
 * message, or the most recent earlier one when the shown message has none.
 *
 * @param {object[]} messages SillyTavern's chat array
 * @param {number} at the shown message's index
 * @returns {{rows:object[], threads:object[], plans:object[], hooks:object[], lore:object[], recap:object[], profiles:object[], standing:object[], index:number, turn:number, carried:boolean}|null}
 */
export function resolveLedger(messages, at) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return null;

    let index = Number.isInteger(at) ? at : list.length - 1;
    if (index >= list.length) index = list.length - 1;

    for (let i = index; i >= 0; i -= 1) {
        const rows = ledgerRows(list[i]);
        if (!rows) continue;

        const before = previousRows(list, i);

        return {
            rows,
            threads: sortThreads(normalizeThreads(rows)),
            plans: normalizePlans(rows),
            hooks: normalizeHooks(rows),
            lore: normalizeLore(rows),
            recap: normalizeRecap(rows),
            profiles: normalizeProfiles(rows),
            standing: withStandingDeltas(normalizeStanding(rows), before ? normalizeStanding(before) : []),
            index: i,
            turn: i + 1,
            carried: i !== index,
        };
    }

    return null;
}
