/**
 * The inline cues: the small marks `lie` and `filter` leave in the prose,
 * and the one popover that reveals their hidden text.
 *
 * The marks are buttons the prose builds, carrying their text as data.
 * Everything here is behaviour: one popover on the frame serves both kinds
 * of mark, so the reading pane's own scrolling or clipping never cuts it.
 * The weight stays hidden until the reader reaches for a mark.
 */

import { settings } from './settings.js';
import { icon } from './icons.js';
import { tellTold } from './cast.js';

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
let current = null;
let pinned = false;
let toldName = '';
let timer = 0;

/**
 * Wires the cues to the frame's prose. Idempotent. The popover element
 * itself comes with the frame.
 */
export function mountCues(element) {
    if (!element || frame === element) return;
    frame = element;
    pop = frame.querySelector('.mz-pop');

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
    current = mark;
    pinned = !!pin;
    mark.setAttribute('aria-expanded', 'true');

    fill(mark);
    place(mark);
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

        const who = document.createElement('span');
        who.textContent = mark.dataset.mzCharacter || '';
        head.append(who);
        pop.append(head);

        pop.append(rows([
            ['Truth', mark.dataset.mzTruth, ''],
            ['Why', mark.dataset.mzReason, 'is-why'],
        ]));
        return;
    }

    // A blind spot says what happened and why it was missed — no title,
    // no "you", so it fits any person and any pair of characters.
    pop.append(rows([
        ['', mark.dataset.mzEvent, 'is-lead'],
        ['Missed because', mark.dataset.mzReason, 'is-why'],
    ]));
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

/**
 * Sits the popover beside its mark: centred on it, preferring to float
 * above and flipping below when there is no room. The small notch keeps
 * pointing at the mark either way. Both edges clamp to the window, so a
 * mark still below the pane's own scroll cannot throw the popover away.
 */
function place(mark) {
    const anchor = mark.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;

    const left = Math.max(12, Math.min(innerWidth - width - 12, anchor.left + anchor.width / 2 - width / 2));
    const above = anchor.top - height - 14 > 8;

    const top = above
        ? anchor.top - height - 11
        : anchor.bottom + 11;

    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
    pop.classList.toggle('is-below', !above);
    pop.style.setProperty('--nx', `${Math.max(14, Math.min(width - 14, anchor.left + anchor.width / 2 - left))}px`);
}
