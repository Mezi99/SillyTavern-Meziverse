/**
 * The inline cues: the small marks `lie` and `filter` leave in the prose,
 * and the one popover that reveals their hidden text.
 *
 * The marks are buttons the prose builds, carrying their text as data.
 * Everything here is behaviour: one popover on the frame serves both kinds
 * of mark, so the reading pane's own scrolling or clipping never cuts it.
 * The weight stays hidden until the reader reaches for a mark.
 */

import { formatMessage } from './st.js';
import { settings } from './settings.js';
import { icon } from './icons.js';
import { showCascade, tellTold } from './cast.js';
import { splitMemory } from './memory.js';
import { closeFloats, placeFloat, registerFloat } from './floats.js';

/* Hover is for mice; a tap or a click pins the popover open. */
const HOVER_OPEN = 90;
const HOVER_CLOSE = 200;

/* The lie's kind, as the popover names it. */
const LIE_WORDS = {
    lying: { icon: 'mz-i-crack', word: 'Lying' },
    deceiving: { icon: 'mz-i-mask', word: 'Deceiving' },
    omitting: { icon: 'mz-i-gap', word: 'Omitting' },
};

let frame = null;
let pop = null;
let mind = null;
let memoryMark = null;
let current = null;
let pinned = false;
let toldName = '';
let timer = 0;

/**
 * Wires the cues to the frame's prose. Idempotent. The popover and the
 * mindscape elements themselves come with the frame.
 */
export function mountCues(element) {
    if (!element || frame === element) return;
    frame = element;
    pop = frame.querySelector('.mz-pop');
    mind = frame.querySelector('.mz-mind');
    registerFloat(closePopover);
    seedMotes();

    frame.addEventListener('click', onClick);
    frame.addEventListener('mouseover', onOver);
    frame.addEventListener('mouseout', onOut);
    frame.addEventListener('focusin', onFocusIn);
    frame.addEventListener('focusout', onFocusOut);
    window.addEventListener('scroll', () => closePopover(), true);
}

/** Puts the popover away. True when there was one open. */
export function closePopover() {
    clearTimer();
    if (!current) return false;

    current.setAttribute('aria-expanded', 'false');
    current = null;
    pinned = false;
    pop.classList.remove('is-open');
    if (toldName) tellTold(toldName, false);
    toldName = '';
    return true;
}

/* ---------- behaviour ---------- */

function hoverMode() {
    return settings().cuePopovers !== 'tap'
        && matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = 0;
}

function onClick(event) {
    const dream = event.target.closest?.('.mz-dream');
    if (dream) {
        openMemory(dream);
        return;
    }

    if (event.target.closest?.('[data-mz-mem-close]')) {
        closeMemory();
        return;
    }

    const mark = event.target.closest?.('.mz-mark');
    if (mark) {
        clearTimer();
        if (current === mark && pinned) closePopover();
        else openPop(mark, true);
        return;
    }

    // A real press outside puts a pinned popover away. Scripts fire
    // synthetic clicks and carry no intent to dismiss anything.
    if (current && event.isTrusted && !pop.contains(event.target)) closePopover();
}

function onOver(event) {
    const mark = event.target.closest?.('.mz-mark');
    if (mark) {
        if (current === mark) {
            clearTimer();
            return;
        }
        if (!hoverMode()) return;
        clearTimer();
        timer = setTimeout(() => openPop(mark, false), HOVER_OPEN);
        return;
    }

    if (current && pop.contains(event.target)) clearTimer();
}

function onOut(event) {
    const to = event.relatedTarget;
    if (to && (pop.contains(to) || current?.contains(to))) return;

    if (!current) {
        clearTimer();
        return;
    }

    // Hovering readers get the 200ms of grace to cross into the popover;
    // a pinned one only leaves on a second click, a press, scroll or Esc.
    if (pinned) return;
    clearTimer();
    timer = setTimeout(() => closePopover(), HOVER_CLOSE);
}

function onFocusIn(event) {
    const mark = event.target.closest?.('.mz-mark');
    if (!mark || !mark.matches(':focus-visible')) return;
    clearTimer();
    openPop(mark, false);
}

function onFocusOut() {
    if (!current || pinned) return;
    clearTimer();
    timer = setTimeout(() => closePopover(), HOVER_CLOSE);
}

/* ---------- the popover ---------- */

function openPop(mark, pin) {
    if (!pop) return;

    if (current && current !== mark) {
        current.setAttribute('aria-expanded', 'false');
        if (toldName) tellTold(toldName, false);
        toldName = '';
    }

    clearTimer();
    closeFloats(closePopover);
    current = mark;
    pinned = !!pin;
    mark.setAttribute('aria-expanded', 'true');

    fill(mark);
    placeFloat(pop, mark);
    pop.classList.add('is-open');

    if (mark.dataset.cue === 'lie' && mark.dataset.mzCharacter) {
        toldName = mark.dataset.mzCharacter;
        tellTold(toldName, true);
    }
}

/** One popover, filled from the mark's own data. Both kinds share it. */
function fill(mark) {
    const kind = mark.dataset.cue;
    pop.dataset.cue = kind;
    pop.replaceChildren();

    if (kind === 'lie') {
        const lie = LIE_WORDS[mark.dataset.mzType] || LIE_WORDS.lying;
        const head = document.createElement('div');
        head.className = 'mz-pop-h';
        head.append(icon(lie.icon), lie.word);
        head.append(whoLine(mark.dataset.mzCharacter));
        pop.append(head);

        pop.append(rows([
            ['Truth', mark.dataset.mzTruth, ''],
            ['Why', mark.dataset.mzReason, 'is-why'],
        ]));
        return;
    }

    // A blind spot says what happened and why it was missed — the same
    // shape as the lie's, "Missed" in its own violet ink.
    const head = document.createElement('div');
    head.className = 'mz-pop-h';
    head.append(icon('mz-i-eye-off'), 'Missed');
    pop.append(head);

    pop.append(rows([
        ['What', mark.dataset.mzEvent, ''],
        ['Why', mark.dataset.mzReason, 'is-why'],
    ]));
}

/** The liar's name, labelled so a lie from off stage still reads. */
function whoLine(name) {
    const wrap = document.createElement('span');

    if (name) {
        const label = document.createElement('b');
        label.textContent = 'Who';
        wrap.append(label, ` ${name}`);
    }

    return wrap;
}

function rows(entries) {
    const list = document.createElement('dl');

    for (const [label, value, className] of entries) {
        if (!value) continue;

        const wrap = document.createElement('div');
        if (label) {
            const term = document.createElement('dt');
            term.textContent = label;
            wrap.append(term);
        }

        const detail = document.createElement('dd');
        if (className) detail.className = className;
        detail.textContent = value;
        wrap.append(detail);
        list.append(wrap);
    }

    return list;
}

/* ---------- the mindscape ---------- */

/**
 * Takes the whole frame into one memory: the stage warms and blurs away
 * and the memory surfaces fragment by fragment. The body left the prose
 * when its pill arrived; it is whole here.
 */
function openMemory(mark) {
    if (!mind || !mark) return;

    closeFloats();

    const data = mark.dataset;
    mind.querySelector('[data-mz="mem-who"]').textContent = `${data.mzCharacter || 'Someone'} remembers`;

    const when = mind.querySelector('[data-mz="mem-when"]');
    when.textContent = data.mzWhen || '';
    when.hidden = !data.mzWhen;

    const trigger = mind.querySelector('[data-mz="mem-trigger"]');
    trigger.textContent = data.mzTrigger || '';
    trigger.hidden = !data.mzTrigger;

    const body = mind.querySelector('[data-mz="mem-body"]');
    body.replaceChildren(...splitMemory(data.mzBody || '').map(fragmentNode));

    mind.querySelector('[data-mz="mem-cascade"]').textContent = data.mzCascade || '';
    mind.querySelector('[data-mz="mem-foot"]').hidden = !data.mzCascade;

    mind.querySelector('.mz-mind-scroll').scrollTop = 0;
    memoryMark = mark;
    mind.hidden = false;
    frame.classList.add('is-memory');
}

/** Puts the memory away — and lets its cascade linger on the character. */
export function closeMemory() {
    if (!mind || mind.hidden) return false;

    frame.classList.remove('is-memory');
    mind.hidden = true;

    const character = memoryMark?.dataset.mzCharacter || '';
    const cascade = memoryMark?.dataset.mzCascade || '';
    memoryMark = null;
    if (character && cascade) showCascade(character, cascade);

    return true;
}

/** One surface of the memory, sharpening out of a blur in its own time. */
function fragmentNode(text, at) {
    const wrap = document.createElement('div');
    wrap.className = 'mz-mind-frag';
    wrap.style.animationDelay = `${Math.min(450 + at * 700, 3100)}ms`;

    const html = formatMessage({ mes: text }, 0);
    if (html) wrap.innerHTML = html;
    else wrap.textContent = text;

    return wrap;
}

/** The drifting motes of light behind the memory. */
function seedMotes() {
    const host = mind?.querySelector('.mz-mind-motes');
    if (!host) return;

    for (let i = 0; i < 15; i += 1) {
        const mote = document.createElement('i');
        mote.style.setProperty('--x', `${4 + ((i * 37) % 92)}%`);
        mote.style.setProperty('--s', `${2 + (i % 3)}px`);
        mote.style.setProperty('--t', `${14 + (i % 7) * 2}s`);
        mote.style.setProperty('--d', `${-((i * 3) % 18)}s`);
        mote.style.setProperty('--dx', `${12 + ((i * 11) % 30)}px`);
        host.append(mote);
    }
}
