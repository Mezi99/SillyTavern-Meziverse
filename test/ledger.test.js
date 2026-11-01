import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerRows, normalizeHookState, normalizeHooks, normalizeLore, normalizePlans, normalizeProfiles, normalizeRecap, normalizeState, normalizeThreads, parseClock, resolveLedger, sortThreads } from '../src/ledger.js';
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
        '<thread name="The gala" plot="The room watches, the glass waits" clock="\u25cf\u25cf\u25cf\u25cf\u25cf" outcome="Hoon offers a contract with strings" state="fires"/>',
    )));
    const [thread] = normalizeThreads(rows);

    assert.deepEqual(thread, {
        name: 'The gala',
        plot: 'The room watches, the glass waits',
        outcome: 'Hoon offers a contract with strings',
        state: 'fires',
        clock: '\u25cf\u25cf\u25cf\u25cf\u25cf',
        fill: 5,
        total: 5,
    });
});

test('plot is optional: the earlier shape still reads', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<thread name="Old shape" clock="\u25cf\u25cb" outcome="No plot on this one" state="ticking"/>',
        '<thread name="Plot only" plot="A quiet room, a loud clock" clock="\u25cf\u25cb" state="ticking"/>',
    )));
    const threads = normalizeThreads(rows);

    assert.equal(threads[0].plot, '');
    assert.equal(threads[1].plot, 'A quiet room, a loud clock');
    assert.equal(threads[1].outcome, '');
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

test('resolveLedger carries the plans of the governing ledger', () => {
    const chat = [msg(LEDGER(
        '<plan name="Goodnight text" what="A promise to text before midnight" due="Tonight" state="pending"/>',
        THREAD('Debt'),
    ))];

    const ledger = resolveLedger(chat, 0);
    assert.deepEqual(ledger.plans.map(p => p.name), ['Goodnight text']);
});

test('normalizePlans reads name, what, due and state in the tag order', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<plan name="Goodnight text" what="A promise to text before midnight" due="Tonight, before midnight" state="pending"/>',
        '<plan name="Bar Friday" what="Friday with the crew" due="Friday, September 15" state="if he skips it, the crew stops asking"/>',
    )));
    const plans = normalizePlans(rows);

    assert.deepEqual(plans[0], {
        name: 'Goodnight text',
        what: 'A promise to text before midnight',
        due: 'Tonight, before midnight',
        state: 'pending',
    });
    assert.deepEqual(plans.map(p => p.name), ['Goodnight text', 'Bar Friday']);
});

test('plans without the name field still read', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<plan what="The old shape keeps working" due="Someday" state="pending"/>',
    )));
    const [plan] = normalizePlans(rows);

    assert.equal(plan.name, '');
    assert.equal(plan.what, 'The old shape keeps working');
});

test('a plan row that names nothing is dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<plan state="pending"/>',
        '<plan name="Only a name"/>',
    )));

    assert.deepEqual(normalizePlans(rows).map(p => p.name), ['Only a name']);
});

test('normalizeHooks reads question, clue and state in the tag order', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<hook question="Who left the lamp lit?" clue="Oil is fresh, someone was there tonight" state="open"/>',
        '<hook question="What is in the shed?" state="warm"/>',
    )));
    const hooks = normalizeHooks(rows);

    assert.deepEqual(hooks[0], {
        question: 'Who left the lamp lit?',
        clue: 'Oil is fresh, someone was there tonight',
        state: 'open',
    });
    assert.equal(hooks[1].clue, '');
    assert.equal(hooks[1].state, 'warm');
});

test('hook state reads warm and answered, anything else is open', () => {
    assert.equal(normalizeHookState('warm'), 'warm');
    assert.equal(normalizeHookState('Answered'), 'answered');
    assert.equal(normalizeHookState(''), 'open');
    assert.equal(normalizeHookState('screaming'), 'open');
});

test('a hook row that questions nothing is dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<hook state="open"/>',
        '<hook question="Who knocked?"/>',
    )));

    assert.deepEqual(normalizeHooks(rows).map(h => h.question), ['Who knocked?']);
});

test('normalizeLore reads kind and idea, in the tag order', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<lore kind="rule" idea="Iron rusts where the old road ran"/>',
        '<lore kind="history" idea="The lighthouse predates the town"/>',
    )));
    const lore = normalizeLore(rows);

    assert.deepEqual(lore[0], { kind: 'rule', idea: 'Iron rusts where the old road ran' });
    assert.deepEqual(lore.map(l => l.kind), ['rule', 'history']);
});

test('a lore row that says nothing is dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<lore/>',
        '<lore idea="Just an idea"/>',
    )));

    assert.deepEqual(normalizeLore(rows).map(l => l.idea), ['Just an idea']);
});

test('normalizeRecap reads era, fact and the optional subtext', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<recap era="Day 1" fact="Arrived on the night ferry" subtext="Ran from something"/>',
        '<recap era="Day 2" fact="Found the lamp still lit"/>',
    )));
    const recap = normalizeRecap(rows);

    assert.deepEqual(recap[0], {
        era: 'Day 1',
        fact: 'Arrived on the night ferry',
        subtext: 'Ran from something',
    });
    assert.equal(recap[1].subtext, '');
});

test('recap rows keep the story order and bare rows are dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<recap era="Day 2" fact="Second"/>',
        '<recap subtext="Only a whisper"/>',
        '<recap era="Day 1" fact="First"/>',
    )));

    assert.deepEqual(normalizeRecap(rows).map(r => r.era), ['Day 2', 'Day 1']);
});

test('resolveLedger carries hooks, lore and recap of the governing ledger', () => {
    const chat = [msg(LEDGER(
        '<recap era="Day 1" fact="Arrived"/>',
        '<lore kind="rule" idea="Iron rusts"/>',
        '<hook question="Who knocked?" state="open"/>',
        THREAD('Debt'),
    ))];

    const ledger = resolveLedger(chat, 0);
    assert.equal(ledger.recap[0].era, 'Day 1');
    assert.equal(ledger.lore[0].kind, 'rule');
    assert.equal(ledger.hooks[0].question, 'Who knocked?');
});

test('normalizeProfiles reads every field as free text', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<profile character="Eli" state="terrified, heart pounding" look="dark green hoodie" secret="sketchbook full of Jin" next="present the portfolio" goal="win the sponsorship" ambition="art college" desire="to be seen as an artist" thought="I am in a museum of cold people."/>',
    )));
    const [profile] = normalizeProfiles(rows);

    assert.deepEqual(profile, {
        character: 'Eli',
        state: 'terrified, heart pounding',
        look: 'dark green hoodie',
        secret: 'sketchbook full of Jin',
        next: 'present the portfolio',
        goal: 'win the sponsorship',
        ambition: 'art college',
        desire: 'to be seen as an artist',
        thought: 'I am in a museum of cold people.',
    });
});

test('profile fields are trimmed but never rewritten', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<profile character="  Eli  " state=" Cold Fury. "/>',
    )));
    const [profile] = normalizeProfiles(rows);

    assert.equal(profile.character, 'Eli');
    assert.equal(profile.state, 'Cold Fury.');
});

test('a profile row that names nothing is dropped', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<profile thought="Only a whisper"/>',
        '<profile look="a green hoodie"/>',
        '<profile character="Eli"/>',
        '<profile state="waiting"/>',
    )));

    assert.deepEqual(normalizeProfiles(rows).map(p => p.character || p.state), ['Eli', 'waiting']);
});

test('profile rows keep the tag order', () => {
    const rows = ledgerRows(msg(LEDGER(
        '<profile character="Mike" state="driving"/>',
        '<profile character="Eli" state="shaking"/>',
        '<profile character="Hoon" state="assessing"/>',
    )));

    assert.deepEqual(normalizeProfiles(rows).map(p => p.character), ['Mike', 'Eli', 'Hoon']);
});

test('resolveLedger carries the profiles of the governing ledger', () => {
    const chat = [msg(LEDGER(
        '<profile character="Eli" state="shaking" thought="Do not faint."/>',
        THREAD('Debt'),
    ))];

    const ledger = resolveLedger(chat, 0);
    assert.equal(ledger.profiles[0].character, 'Eli');
    assert.equal(ledger.profiles[0].thought, 'Do not faint.');
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
