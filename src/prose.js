/**
 * Turning a SillyTavern message into the prose shown in the pane and the log.
 *
 * SillyTavern does the formatting, so regex scripts, Markdown, quotes, rules
 * and every display extension behave exactly as they do in the native chat.
 * This file only tidies the edges and offers a plain-text version for labels.
 */

import { formatMessage } from './st.js';

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
 * The message as SillyTavern would draw it.
 *
 * @param {object} message
 * @param {number} index its index in the chat, which regex scripts may use
 * @returns {string} HTML, already sanitised by SillyTavern
 */
export function toHtml(message, index) {
    const text = typeof message?.mes === 'string' ? message.mes : '';
    if (!text.trim()) return '';

    const formatted = tidy(formatMessage(message, index));
    if (formatted) return formatted;

    // ST could not format it: show the words, safely, with their line breaks.
    return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

/** Puts formatted prose into an element. */
export function renderInto(element, html) {
    element.innerHTML = html;
}

/** The message's text with no markup at all, for labels and titles. */
export function toPlain(mes) {
    if (typeof mes !== 'string' || !mes.trim()) return '';

    const doc = new DOMParser().parseFromString(mes, 'text/html');
    doc.querySelectorAll('script,style,noscript,template').forEach(node => node.remove());

    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}
