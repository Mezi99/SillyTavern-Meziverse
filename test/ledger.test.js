import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerRows, normalizeState, normalizeThreads, parseClock, resolveLedger, sortThreads } from '../src/ledger.js';
import { stripTags } from '../src/tags.js';

const msg = mes => ({ mes });

const LEDGER = (...rows) => `<LEDGER>\n${rows.join('\n')}\n</LEDGER>`;

const THREAD = (name, attrs = '') => `<thread name="${name}" clock="\u25cf\u25cf\u25cf\u25cb\u25cb" outcome="It comes due" state="ticking"${attrs ? ' ' + attrs : ''}/>`;

test('ledgerRows reads the rows of the last complete LEDGER block', () => {
    const message = msg(`${LEDGER(THREAD('Debt'))}\n\n${LEDGER(THREAD('Debt paid'), THREAD('The gala'))}`);
    const rows = ledgerRows(message);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].attrs.name, 'Debt paid');
    assert.equal(rows[1].attrs.name, 'The gala');
});

test('rows outside a LEDGER block are not ledger rows', () => {
    assert.equal(ledgerRows(msg(`<thread name="Debt" clock="\u25cf\u25cb" outcome="x"/>`)), null);
    assert.equal(ledgerRows(msg('plain prose, no tags at all')), null);
});

test('an unclosed LEDGER is not a ledger yet', () => {
    const message = msg(`prose\n<LEDGER>\n${THREAD('Debt')}`);
    assert.equal(ledgerRows(message), null);
});

test('a half row at the end of the block is skipped', () => {
    const rows = ledgerRows(msg(LEDGER(THREAD('Debt'), '<thread name="Gala" clock="\u25cf\u25cb')));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attrs.name, 'Debt');
});

test('goals rows are collected but never reach the threads', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<goals character="Eli" now="present the portfolio" hiding="the sketchbook"/>',
        THREAD('Debt'),
    )));

    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'goals');
    assert.deepEqual(normalizeThreads(rows).map(t => t.name), ['Debt']);
});

test('attribute order, case and quotes are all free', () => {
    const rows = ledgerRows(msg(LEDGER(
        `<THREAD state='ticking' OUTCOME="He\u2019s \u201cnot\u201d coming" clock="\u25cf\u25cf\u25cb\u25cb\u25cb" name="Curly quotes"/>`,
    )));

    assert.equal(rows[0].name, 'thread');
    assert.equal(rows[0].attrs.name, 'Curly quotes');
    assert.equal(rows[0].attrs.outcome, 'He\u2019s \u201cnot\u201d coming');
});

test('unknown attributes are ignored, known ones are kept', () => {
    const rows = ledgerRows(msg(LEDGER(THREAD('Debt', 'add="new" flavour="sour"'))));
    const [thread] = normalizeThreads(rows);

    assert.equal(thread.name, 'Debt');
    assert.equal(rows[0].attrs.add, 'new');
});

test('parseClock reads the pip string, a bare number and N/M', () => {
    assert.deepEqual(parseClock('\u25cf\u25cf\u25cf\u25cb\u25cb'), { fill: 3, total: 5 });
    assert.deepEqual(parseClock('\u25cf\u25cf\u25cf\u25cf\u25cf'), { fill: 5, total: 5 });
    assert.deepEqual(parseClock('\u25cb\u25cb\u25cb'), { fill: 0, total: 3 });
    assert.deepEqual(parseClock('5'), { fill: 5, total: 5 });
    assert.deepEqual(parseClock('3/5'), { fill: 3, total: 5 });
    assert.deepEqual(parseClock(''), { fill: 0, total: 0 });
    assert.deepEqual(parseClock('soon enough'), { fill: 0, total: 0 });
});

test('normalizeState knows the three states and tolerates the rest', () => {
    assert.equal(normalizeState('fires'), 'fires');
    assert.equal(normalizeState(' FIRES '), 'fires');
    assert.equal(normalizeState('resolved'), 'resolved');
    assert.equal(normalizeState('ticking'), 'ticking');
    assert.equal(normalizeState('about to blow up'), 'ticking');
    assert.equal(normalizeState(''), 'ticking');
});

test('normalizeThreads keeps the tag\u2019s words exactly as written', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<thread name="The gala" clock="\u25cf\u25cf\u25cf\u25cf\u25cf" outcome="Hoon offers a contract with strings" state="fires"/>',
    )));
    const [thread] = normalizeThreads(rows);

    assert.deepEqual(thread, {
        name: 'The gala',
        outcome: 'Hoon offers a contract with strings',
        state: 'fires',
        clock: '\u25cf\u25cf\u25cf\u25cf\u25cf',
        fill: 5,
        total: 5,
    });
});

test('a thread without a name still reads, one with neither field is dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<thread clock="\u25cf\u25cb" outcome="Nameless but real"/>',
        '<thread clock="\u25cf\u25cb" state="ticking"/>',
    )));

    assert.equal(rows.length, 2);
    assert.deepEqual(normalizeThreads(rows).map(t => t.outcome), ['Nameless but real']);
});

test('sortThreads: about to fire first, then the fullest clocks', () => {
    const sorted = sortThreads([
        { name: 'quiet', fill: 1, total: 5, state: 'ticking' },
        { name: 'mid', fill: 4, total: 5, state: 'ticking' },
        { name: 'blazing', fill: 2, total: 5, state: 'fires' },
        { name: 'full', fill: 5, total: 5, state: 'ticking' },
        { name: 'done', fill: 5, total: 5, state: 'resolved' },
    ]);

    assert.deepEqual(sorted.map(t => t.name), ['blazing', 'full', 'done', 'mid', 'quiet']);
});

test('resolveLedger reads the shown message first', () => {
    const chat = [
        msg(LEDGER(THREAD('Old thread'))),
        msg(`narration\n${LEDGER(THREAD('Current thread'))}`),
    ];

    const ledger = resolveLedger(chat, 1);
    assert.equal(ledger.turn, 2);
    assert.equal(ledger.carried, false);
    assert.deepEqual(ledger.threads.map(t => t.name), ['Current thread']);
});

test('a turn without a ledger inherits the earlier one, labelled', () => {
    const chat = [
        msg(LEDGER(THREAD('Old thread'))),
        msg('just prose'),
        msg('more prose'),
    ];

    const ledger = resolveLedger(chat, 2);
    assert.equal(ledger.turn, 1);
    assert.equal(ledger.index, 0);
    assert.equal(ledger.carried, true);
    assert.deepEqual(ledger.threads.map(t => t.name), ['Old thread']);
});

test('a complete but empty ledger governs; nothing walks further back', () => {
    const chat = [
        msg(LEDGER(THREAD('Old thread'))),
        msg(LEDGER()),
    ];

    const ledger = resolveLedger(chat, 1);
    assert.equal(ledger.turn, 2);
    assert.equal(ledger.threads.length, 0);
});

test('a chat with no ledger anywhere resolves to nothing', () => {
    assert.equal(resolveLedger([msg('prose'), msg('more prose')], 1), null);
    assert.equal(resolveLedger([], 0), null);
});

test('a streaming LEDGER falls back to the earlier turn', () => {
    const chat = [
        msg(LEDGER(THREAD('Old thread'))),
        msg(`prose\n<LEDGER>\n${THREAD('Half arrived')}`),
    ];

    const ledger = resolveLedger(chat, 1);
    assert.equal(ledger.turn, 1);
    assert.equal(ledger.carried, true);
    assert.deepEqual(ledger.threads.map(t => t.name), ['Old thread']);
});

test('the ledger never leaks into the prose', () => {
    const mes = `The door opened.\n${LEDGER(THREAD('Debt'))}\nHe stepped inside.`;
    const clean = stripTags(mes);

    assert.ok(!clean.includes('<LEDGER'));
    assert.ok(!clean.includes('<thread'));
    assert.ok(!clean.includes('Debt'));
    assert.ok(clean.includes('The door opened.'));
    assert.ok(clean.includes('He stepped inside.'));
});
