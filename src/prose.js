/**
 * Turning a SillyTavern message into the prose shown in the pane and the log.
 *
 * SillyTavern does the formatting, so regex scripts, Markdown, quotes, rules
 * and every display extension behave exactly as they do in the native chat.
 * The only work here is removing Meziverse's own tags and putting an inline
 * scene row at every complete `<scene>`, an inline mark at every `lie` or
 * `filter`, a dream pill at every `flashback`, and a meanwhile box at every
 * `meanwhile`.
 */

import { castImages, castKey, formatMessage, imageSource, say } from './st.js';
import { splitCues, stripTags } from './tags.js';
import { describeScene, describeSpeech, isUsableScene } from './scene.js';
import { iconHtml } from './icons.js';
import { avatarsOn, modeOn, speechFxOn } from './settings.js';

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

/**
 * A location chain as the UI reads it: its levels joined by a quiet chevron
 * instead of the model's `|` - which stays the contract, and stays in the
 * tooltip. Scene rows and the chat bar share this one read.
 */
export function placeHtml(placeFull) {
    const raw = typeof placeFull === 'string' ? placeFull : '';
    if (!raw) return '';

    return raw.split('|')
        .map(level => level.trim())
        .filter(Boolean)
        .map(escapeHtml)
        .join('<span class="mz-scene-sep" aria-hidden="true">\u203a</span>');
}

/** One scene as a quiet band of its own, at the point it appeared. */
function sceneRow(tag, { compact, persona }) {
    if (!isUsableScene(tag)) return '';

    const scene = describeScene(tag, { persona });
    const when = [];

    if (scene.date) when.push(`<span class="mz-scene-date">${escapeHtml(scene.date)}</span>`);
    if (scene.time) when.push(`<b class="mz-scene-time">${escapeHtml(scene.time)}</b>`);

    const place = placeHtml(scene.placeFull);
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

// A private-use slot stands in for a mark or a speech bubble inside the text
// SillyTavern formats; the real markup is swapped in afterwards. A slot holds
// either a mark tag (rendered at swap time) or a whole bubble's HTML.
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

/* ---------- speech bubbles ---------- */

/** One fragment as SillyTavern would draw it, without the paragraph shell. */
function inlineFormat(message, index, source) {
    const text = typeof source === 'string' ? source : '';
    if (!text.trim()) return '';

    const html = tidy(formatMessage({ ...message, mes: text }, index));
    return (html.replace(/^<p[^>]*>/i, '').replace(/<\/p>$/i, '').trim())
        || escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * One spoken line as the pane draws it: the speaker's label - the name, the
 * tone said in as a tiny italic beside it, and the cast's thumbnail when
 * avatars hold a picture for the name (the interlace proof; the real display
 * modes are designed later) - above the words in a quiet bubble. A name with
 * no picture falls back to the label alone.
 */
function bubbleHtml(tag, { message, index }) {
    const speech = describeSpeech(tag);
    if (!speech) return '';

    const who = say(speech.character || '').trim();
    const tone = say(speech.tone || '').trim();
    const face = avatarsOn() && who ? imageSource(castImages()[castKey(who)] || '') : '';

    return '<span class="mz-speech">'
        + '<span class="mz-speech-who">'
        + (face ? `<img class="mz-speech-face" src="${escapeHtml(face)}" alt="">` : '')
        + `<b class="mz-speech-name">${escapeHtml(who || 'Someone')}</b>`
        + (tone ? `<em class="mz-speech-tone">${escapeHtml(tone)}</em>` : '')
        + '</span>'
        + `<span class="mz-speech-bub">${inlineFormat(message, index, speech.words)}</span>`
        + '</span>';
}

/* ---------- the meanwhile box ---------- */

/**
 * One `meanwhile` as its own quiet box in the prose: closed by default,
 * carrying only the cut glyph and the label until it is opened. When a reply
 * holds more than one, each head numbers itself ("2 / 3") so the asides stay
 * countable.
 */
function meanwhileBox(tag, at, total) {
    const data = tag.attrs || {};
    const event = say(data.event || '').trim();
    const importance = say(data.importance || '').trim();

    return '<div class="mz-meanwhile">'
        + '<button class="mz-mw-head" type="button" aria-expanded="false">'
        + `<span class="mz-mw-slash">${iconHtml('mz-i-cut')}</span>`
        + '<span class="mz-mw-label">Meanwhile</span>'
        + (total > 1 ? `<span class="mz-mw-count">${at} / ${total}</span>` : '')
        + iconHtml('mz-i-next', 'mz-mw-chev')
        + '</button>'
        + '<div class="mz-mw-body"><div class="mz-mw-in"><div>'
        + (event ? `<p class="mz-mw-ev">${escapeHtml(event)}</p>` : '')
        + (importance
            ? `<p class="mz-mw-why"><b>Why it matters</b><span>${escapeHtml(importance)}</span></p>`
            : '')
        + '</div></div></div>'
        + '</div>';
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

    const cues = splitCues(raw);
    const total = cues.reduce((n, cue) => n + (cue.type === 'box' ? 1 : 0), 0);

    const parts = [];
    let run = '';
    let slots = [];
    let at = 0;

    // One formatMessage call per run of prose, so a mark or a bubble in the
    // middle of a paragraph does not break the paragraph: its slot rides
    // through the formatting and is swapped for the real markup afterwards.
    const flushRun = () => {
        if (!run.trim()) {
            run = '';
            slots = [];
            return;
        }

        const formatted = tidy(formatMessage({ ...message, mes: run }, index));
        const html = formatted || escapeHtml(run).replace(/\r\n|\r|\n/g, '<br>');
        if (html.trim()) {
            parts.push(html.replace(SLOT_RE, (all, n) => {
                const entry = slots[Number(n)];
                return typeof entry === 'string' ? entry : markHtml(entry);
            }));
        }

        run = '';
        slots = [];
    };

    for (const cue of cues) {
        if (cue.type === 'scene') {
            flushRun();
            // The tag vanishes from the prose either way; the row is scene
            // info and follows the tag in both modes.
            const row = sceneRow(cue.tag, { compact, persona });
            if (row) parts.push(row);
            continue;
        }

        if (cue.type === 'box') {
            flushRun();
            // The box is a Meziverse feature too: the tag vanishes from the
            // prose either way, and the count is render-side.
            at += 1;
            if (modeOn()) parts.push(meanwhileBox(cue.tag, at, total));
            continue;
        }

        if (cue.type === 'mark') {
            if (!modeOn()) continue;
            run += slot(slots.length);
            slots.push(cue.tag);
            continue;
        }

        if (cue.type === 'speech') {
            // Bubbles are the pane's own and ride their switch; the log, and
            // any pane with the switch off, keeps the words exactly as the
            // format asks the model to write them - quote marks and all.
            if (compact || !speechFxOn()) {
                run += cue.tag.body ?? '';
                continue;
            }

            const bubble = bubbleHtml(cue.tag, { message, index });
            if (!bubble) {
                run += cue.tag.body ?? '';
                continue;
            }

            run += slot(slots.length);
            slots.push(bubble);
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
