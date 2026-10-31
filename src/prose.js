/**
 * Turning a SillyTavern message into the prose shown in the pane and the log.
 *
 * SillyTavern does the formatting, so regex scripts, Markdown, quotes, rules
 * and every display extension behave exactly as they do in the native chat.
 * The only work here is removing Meziverse's own tags and putting an inline
 * scene row at every complete `<scene>`.
 */

import { formatMessage } from './st.js';
import { splitCues, stripTags } from './tags.js';
import { describeScene, isUsableScene } from './scene.js';

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

    const place = scene.levels.length
        ? scene.levels.map(level => escapeHtml(level)).join('<span class="mz-scene-sep" aria-hidden="true">\u203a</span>')
        : escapeHtml(scene.placeFull);
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

/**
 * The message as SillyTavern would draw it, with Meziverse's own scene rows.
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

    for (const cue of splitCues(raw)) {
        if (cue.type === 'scene') {
            const row = sceneRow(cue.tag, { compact, persona });
            if (row) parts.push(row);
            continue;
        }

        if (!cue.text.trim()) continue;

        const formatted = tidy(formatMessage({ ...message, mes: cue.text }, index));
        const html = formatted || escapeHtml(cue.text).replace(/\r\n|\r|\n/g, '<br>');
        if (html.trim()) parts.push(html);
    }

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
