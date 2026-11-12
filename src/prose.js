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
import { readInlineThink, splitCues, stripTags } from './tags.js';
import { describeScene, describeSpeech, isUsableScene } from './scene.js';
import { faHtml, iconHtml } from './icons.js';
import { avatarsOn, modeOn, sceneHeaderStyle, speechFxOn } from './settings.js';

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

    const levels = raw.split('|')
        .map(level => level.trim())
        .filter(Boolean);

    // Levels read as a path: parents quiet, the leaf the header's accent.
    // Unstyled spans elsewhere (chat bar, log) read as plain text.
    return levels
        .map((level, at) => at === levels.length - 1
            ? `<span class="mz-scene-leaf">${escapeHtml(level)}</span>`
            : `<span class="mz-scene-lvl">${escapeHtml(level)}</span>`)
        .join('<span class="mz-scene-sep" aria-hidden="true">\u203a</span>');
}

/** The cast as the scene header reads it. */
function castNames(present) {
    return present.map(name => escapeHtml(name)).join(', ');
}

/* ---------- the scene header's stroke glyphs ---------- */

/* 24x24 stroke icons on a currentColor line, the plan's mockup set. The
   glyph follows the tag's `weatherTag` state - never the free-text weather,
   which prints beside it - and the date-first row's time/people glyphs are
   drawn from the same hand. */

const WEATHER_GLYPHS = {
    sunny: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    clear: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/><path d="M17 3v4M15 5h4"/>',
    rain: '<path d="M7 15a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 8a3.5 3.5 0 0 1 0 7"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    storm: '<path d="M7 14a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 7a3.5 3.5 0 0 1 0 7"/><path d="M12 12l-2 4h3l-2 4"/>',
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.7 4.6L12 6.8l2.3-2.2M9.7 19.4L12 17.2l2.3 2.2"/>',
    fog: '<path d="M5 7h14M3 11h18M6 15h13M9 19h8"/>',
    overcast: '<path d="M8 19a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 18 12a3.5 3.5 0 0 1 0 7Z"/><path d="M9.3 8.4A4 4 0 0 1 16.6 7.2"/>',
    wind: '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
};

const CLOCK_GLYPH = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
const PEOPLE_GLYPH = '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2a5 5 0 0 1 5 5.8"/>';

function glyph(path) {
    return `<svg class="mz-wi" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

/**
 * The icon a scene's weatherTag earns. "Clear" reads as the crescent at
 * night and the sun by day (the plain sun stays "sunny"); an unknown or
 * missing state draws nothing - the free text is never read for a glyph.
 */
export function weatherGlyph(weatherTag, hour = null) {
    const key = String(weatherTag || '').trim().toLowerCase();
    if (!WEATHER_GLYPHS[key]) return '';
    const night = hour !== null && (hour >= 19 || hour < 6);
    if (key === 'clear' && !night) return glyph(WEATHER_GLYPHS.sunny);
    return glyph(WEATHER_GLYPHS[key]);
}

/** One scene as the header the plan drew - four wardrobes, one set of data. */
function sceneRow(tag, { compact, persona, at = -1 }) {
    if (!isUsableScene(tag)) return '';

    const scene = describeScene(tag, { persona });

    // The log drawer keeps its own quiet band, whatever the pane wears.
    if (compact) {
        const when = [];

        if (scene.date) when.push(`<span class="mz-scene-date">${escapeHtml(scene.date)}</span>`);
        if (scene.time) when.push(`<b class="mz-scene-time">${escapeHtml(scene.time)}</b>`);

        const place = placeHtml(scene.placeFull);
        const present = castNames(scene.present);

        return `<aside class="mz-scene is-compact" aria-label="Scene">`
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

    const style = sceneHeaderStyle();
    const place = placeHtml(scene.placeFull);
    const icon = weatherGlyph(scene.weatherTag, scene.hour);
    const weather = scene.weather || icon
        ? `<span class="mz-scene-weather">${icon}${scene.weather ? `<span class="mz-scene-wx">${escapeHtml(scene.weather)}</span>` : ''}</span>`
        : '';
    const cast = scene.present.length ? castNames(scene.present) : '';
    // The edit seat, right of the header: the ribbon's own pencil. The edit
    // flow turns the seat into save/cancel and the place into level rows.
    const tools = '<span class="mz-scene-tools">'
        + `<button class="mz-ibtn mz-scene-pencil" type="button" title="Edit this scene" aria-label="Edit this scene" data-mz-action="scene-edit" data-mz-scene-at="${Number(at)}">${faHtml('fa-solid fa-pencil')}</button>`
        + '</span>';

    if (style === 'date') {
        // Date-first: the date as headline, one row of time / weather / cast,
        // the location last.
        const row = [];
        if (scene.time) row.push(`<span class="mz-scene-t">${glyph(CLOCK_GLYPH)}${escapeHtml(scene.time)}</span>`);
        if (weather) row.push(weather);
        if (cast) row.push(`<span class="mz-scene-ppl">${glyph(PEOPLE_GLYPH)}${cast}</span>`);

        return `<aside class="mz-scene is-date" data-mz-scene-at="${Number(at)}" aria-label="Scene">`
            + '<div class="mz-scene-head">'
            + '<div class="mz-scene-mid">'
            + (scene.date ? `<div class="mz-scene-date">${escapeHtml(scene.date)}</div>` : '')
            + (row.length ? `<div class="mz-scene-row">${row.join('')}</div>` : '')
            + (place ? `<div class="mz-scene-place">${place}</div>` : '')
            + '</div>'
            + tools
            + '</div>'
            + '</aside>';
    }

    // Simple: the band Meziverse first drew - the diamond ornament, the
    // when/weather/place run, the cast line - with the edit seat added.
    if (style === 'simple') {
        const when = [];

        if (scene.date) when.push(`<span class="mz-scene-date">${escapeHtml(scene.date)}</span>`);
        if (scene.time) when.push(`<b class="mz-scene-time">${escapeHtml(scene.time)}</b>`);

        return `<aside class="mz-scene is-simple" data-mz-scene-at="${Number(at)}" aria-label="Scene">`
            + '<span class="mz-scene-orn" aria-hidden="true"></span>'
            + '<div class="mz-scene-main">'
            + (when.length
                ? `<span class="mz-scene-when">${when.join('<span class="mz-scene-dot" aria-hidden="true">\u00b7</span>')}</span>`
                : '')
            + (scene.weather ? `<span class="mz-scene-weather">${escapeHtml(scene.weather)}</span>` : '')
            + (place ? `<span class="mz-scene-place">${place}</span>` : '')
            + '</div>'
            + (cast ? `<span class="mz-scene-cast">${cast}</span>` : '')
            + tools
            + '</aside>';
    }

    // Chapter rule and Quiet share the two-line skeleton: the clock
    // against the date/weather line over the breadcrumb, the cast below.
    const l1 = [];
    if (scene.date) l1.push(`<span class="mz-scene-date">${escapeHtml(scene.date)}</span>`);
    if (weather) l1.push(weather);

    return `<aside class="mz-scene is-${style}" data-mz-scene-at="${Number(at)}" aria-label="Scene">`
        + '<div class="mz-scene-head">'
        + (scene.time ? `<b class="mz-scene-time">${escapeHtml(scene.time)}</b>` : '')
        + '<div class="mz-scene-mid">'
        + (l1.length ? `<div class="mz-scene-l1">${l1.join('<span class="mz-scene-dot" aria-hidden="true">\u00b7</span>')}</div>` : '')
        + (place ? `<div class="mz-scene-place">${place}</div>` : '')
        + '</div>'
        + (style === 'quiet' ? '<span class="mz-scene-fill" aria-hidden="true"></span>' : '')
        + tools
        + '</div>'
        + (cast ? `<div class="mz-scene-cast">With ${cast}</div>` : '')
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

/* ---------- the reasoning block ---------- */

/**
 * The reasoning written for one message variant, or '' when there is none.
 * Read exactly where SillyTavern keeps it - `extra.reasoning`, or its display
 * twin - with the variant's own `swipe_info` slot as the fallback around
 * swipes, and an in-band `think` body as the last resort for chats
 * SillyTavern never moved the reasoning out of. Read-only, like everything
 * here.
 */
export function reasoningOf(message) {
    if (!message || typeof message !== 'object') return '';

    const fromExtra = pickReasoning(message.extra);
    if (fromExtra) return fromExtra;

    const slot = message.swipe_info?.[Number(message.swipe_id ?? 0)];
    const fromSlot = pickReasoning(slot?.extra);
    if (fromSlot) return fromSlot;

    return readInlineThink(message.mes);
}

function pickReasoning(extra) {
    const display = typeof extra?.reasoning_display_text === 'string' ? extra.reasoning_display_text.trim() : '';
    if (display) return display;
    return typeof extra?.reasoning === 'string' ? extra.reasoning.trim() : '';
}

/**
 * The block's head line, as SillyTavern words it: how long the thinking took
 * once that is known, "Thinking…" while the shown turn is still generating,
 * and the plain word otherwise.
 */
export function thoughtLabel(message, streaming = false) {
    const duration = Number(message?.extra?.reasoning_duration);
    if (Number.isFinite(duration) && duration > 0) return `Thought for ${humanSpan(duration)}`;
    return streaming ? 'Thinking\u2026' : 'Reasoning';
}

function humanSpan(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${Math.max(1, seconds)} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * One reasoning block as the pane draws it: an ST-style expandable above the
 * turn's prose - the head carries the label and the chevron, the body rides
 * SillyTavern's own formatter. The open state is passed in: the pane keeps
 * one, so a redraw never flips a block the reader opened.
 */
export function reasoningHtml(message, index, text, { open = false, label = 'Reasoning' } = {}) {
    const source = typeof text === 'string' ? text : '';
    const body = tidy(formatMessage({ ...message, mes: source }, index))
        || escapeHtml(source).replace(/\r\n|\r|\n/g, '<br>');

    return `<div class="mz-reason${open ? ' is-open' : ''}">`
        + `<button class="mz-reason-head" type="button" aria-expanded="${open ? 'true' : 'false'}">`
        + '<span class="mz-reason-glyph">' + iconHtml('mz-i-thought') + '</span>'
        + `<span class="mz-reason-label">${escapeHtml(label)}</span>`
        + iconHtml('mz-i-chevdown', 'mz-reason-chev')
        + '</button>'
        + '<div class="mz-reason-body"><div class="mz-reason-in"><div>'
        + body
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
    let sceneAt = 0;

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
            // info and follows the tag in both modes. Every scene - even one
            // too bare to draw - counts its place, so the ribbon knows which
            // tag its edit pencil belongs to.
            const row = sceneRow(cue.tag, { compact, persona, at: sceneAt });
            sceneAt += 1;
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
