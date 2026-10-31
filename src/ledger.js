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
 * The ledger that governs a turn: the last complete block of the shown
 * message, or the most recent earlier one when the shown message has none.
 *
 * @param {object[]} messages SillyTavern's chat array
 * @param {number} at the shown message's index
 * @returns {{rows:object[], threads:object[], index:number, turn:number, carried:boolean}|null}
 */
export function resolveLedger(messages, at) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return null;

    let index = Number.isInteger(at) ? at : list.length - 1;
    if (index >= list.length) index = list.length - 1;

    for (let i = index; i >= 0; i -= 1) {
        const rows = ledgerRows(list[i]);
        if (!rows) continue;

        return {
            rows,
            threads: sortThreads(normalizeThreads(rows)),
            index: i,
            turn: i + 1,
            carried: i !== index,
        };
    }

    return null;
}
