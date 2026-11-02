/**
 * Turning a SillyTavern message into the prose shown in the pane and the log.
 *
 * SillyTavern does the formatting, so regex scripts, Markdown, quotes, rules
 * and every display extension behave exactly as they do in the native chat.
 * The only work here is removing Meziverse's own tags and putting an inline
 * scene row at every complete `<scene>` and an inline mark at every `lie` or
 * `filter`.
 */

import { formatMessage, say } from './st.js';
import { splitCues, stripTags } from './tags.js';
import { describeScene, isUsableScene } from './scene.js';
import { iconHtml } from './icons.js';
import { modeOn } from './settings.js';

const OPENING_BREAKS = /^(?:\s|<br\s*\/?>)+/i;
const CLOSING_BREAKS = /(?:\s|<br\s*\/?>)+$/i;

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Drops the blank lines SillyTavern leaves at the top and bottom. */
function tidy(html) {
    return html
        .replace(/<p>(?:\s|<br\s*\/?>)+/gi, '<p>')
        .replace(/(?:\s|<br\s*\/?>)+<\/p>/gi, '</p>')
        .replace(/<p>\s*<\/p>/gi, '')
        .replace(OPENING_BREAKS, '')
        .replace(CLOSING_BREAKS, '')
        .trim();
}

/** One scene as a quiet band of its own, at the point it appeared. */
function sceneRow(tag, { compact, persona }) {
    if (!isUsableScene(tag)) return '';

    const scene = describeScene(tag, { persona });
    const when = [];

    if (scene.date) when.push(`<span class="mz-scene-date">${escapeHtml(scene.date)}</span>`);
    if (scene.time) when.push(`<b class="mz-scene-time">${escapeHtml(scene.time)}</b>`);

    // The location is shown exactly as the scene wrote it: re-joining the
    // levels with our own separator only hid the model's own `|` from view.
    const place = scene.placeFull ? escapeHtml(scene.placeFull) : '';
    const present = scene.present.map(name => escapeHtml(name)).join(', ');

    return `<aside class="mz-scene${compact ? ' is-compact' : ''}" aria-label="Scene">`
        + '<span class="mz-scene-orn" aria-hidden="true"></span>'
        + '<div class="mz-scene-main">'
        + (when.length
            ? `<span class="mz-scene-when">${when.join('<span class="mz-scene-dot" aria-hidden="true">\u00b7</span>')}</span>`
            : '')
        + (scene.weather ? `<span class="mz-scene-weather">${escapeHtml(scene.weather)}</span>` : '')
        + (place ? `<span class="mz-scene-place">${place}</span>` : '')
        + '</div>'
        + (present ? `<span class="mz-scene-cast">${present}</span>` : '')
        + '</aside>';
}

/* ---------- inline marks ---------- */

// A private-use slot stands in for a mark inside the text SillyTavern
// formats; the mark's own markup is swapped in afterwards.
const SLOT_OPEN = String.fromCharCode(0xe100);
const SLOT_CLOSE = String.fromCharCode(0xe101);
const SLOT_RE = new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, 'g');

function slot(number) {
    return SLOT_OPEN + number + SLOT_CLOSE;
}

/** A lie's kind: the glyph tells them apart, the popover tells the truth. */
const LIE_KINDS = {
    lying: { icon: 'mz-i-crack', word: 'lying', verb: 'is lying' },
    deceiving: { icon: 'mz-i-mask', word: 'deceiving', verb: 'is deceiving' },
    omitting: { icon: 'mz-i-gap', word: 'omitting', verb: 'is omitting' },
};

function attr(name, value) {
    return value ? ` ${name}="${escapeHtml(String(value))}"` : '';
}

/** One inline cue as the small mark it leaves in the prose. */
function markHtml(tag) {
    if (!tag) return '';

    const data = tag.attrs || {};

    if (tag.name === 'lie') {
        const kind = LIE_KINDS[String(data.type || '').trim().toLowerCase()] || LIE_KINDS.lying;
        const who = say(data.character || '').trim();
        const label = `${who || 'Someone'} ${kind.verb}`;

        return '<button class="mz-mark" type="button" data-cue="lie"'
            + ` data-mz-type="${kind.word}"`
            + attr('data-mz-character', say(data.character))
            + attr('data-mz-truth', say(data.truth))
            + attr('data-mz-reason', say(data.reason))
            + ` aria-expanded="false" aria-label="${escapeHtml(label)}">${iconHtml(kind.icon)}</button>`;
    }

    if (tag.name === 'filter') {
        return '<button class="mz-mark" type="button" data-cue="blind"'
            + attr('data-mz-event', say(data.event))
            + attr('data-mz-reason', say(data.reason))
            + ' aria-expanded="false" aria-label="Something you cannot perceive">'
            + iconHtml('mz-i-eye-off')
            + '</button>';
    }

    if (tag.name === 'flashback') {
        const who = say(data.character || '').trim();

        return '<button class="mz-dream" type="button" data-cue="mem"'
            + attr('data-mz-character', say(data.character))
            + attr('data-mz-when', say(data.when))
            + attr('data-mz-trigger', say(data.trigger))
            + attr('data-mz-cascade', say(data.cascade))
            + attr('data-mz-body', tag.body ?? '')
            + ` aria-label="${escapeHtml(`${who || 'Someone'} remembers`)}">`
            + iconHtml('mz-i-dream')
            + escapeHtml(who)
            + '</button>';
    }

    return '';
}

/**
 * The message as SillyTavern would draw it, with Meziverse's own scene rows
 * and inline marks.
 *
 * @param {object} message
 * @param {number} index its index in the chat, which regex scripts may use
 * @param {{compact?: boolean, persona?: string}} [options]
 * @returns {string} HTML, already sanitised by SillyTavern
 */
export function toHtml(message, index, { compact = false, persona = '' } = {}) {
    const raw = typeof message?.mes === 'string' ? message.mes : '';
    if (!raw.trim()) return '';

    const parts = [];
    let run = '';
    let marks = [];

    // One formatMessage call per run of prose, so a mark in the middle of a
    // paragraph does not break the paragraph: its slot rides through the
    // formatting and is swapped for the mark afterwards.
    const flushRun = () => {
        if (!run.trim()) {
            run = '';
            marks = [];
            return;
        }

        const formatted = tidy(formatMessage({ ...message, mes: run }, index));
        const html = formatted || escapeHtml(run).replace(/\r\n|\r|\n/g, '<br>');
        if (html.trim()) {
            parts.push(html.replace(SLOT_RE, (all, n) => markHtml(marks[Number(n)])));
        }

        run = '';
        marks = [];
    };

    for (const cue of splitCues(raw)) {
        if (cue.type === 'scene') {
            flushRun();
            // The tag vanishes from the prose either way; the row is a
            // Meziverse feature and only appears while mode is on.
            const row = modeOn() ? sceneRow(cue.tag, { compact, persona }) : '';
            if (row) parts.push(row);
            continue;
        }

        if (cue.type === 'mark') {
            if (!modeOn()) continue;
            run += slot(marks.length);
            marks.push(cue.tag);
            continue;
        }

        run += cue.text;
    }

    flushRun();
    return parts.join('');
}

/** Puts formatted prose into an element. */
export function renderInto(element, html) {
    element.innerHTML = html;
}

/** The message's text with no markup at all, for labels and titles. */
export function toPlain(mes) {
    const text = stripTags(mes);
    if (!text.trim()) return '';

    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script,style,noscript,template').forEach(node => node.remove());

    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}
