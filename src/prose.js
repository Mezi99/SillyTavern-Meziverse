/**
 * Turning a SillyTavern message into paragraphs.
 *
 * Messages can contain markup from the model, from formatting extensions, or
 * from SillyTavern's own display pipeline. None of it is trusted: we read text
 * nodes only, never innerHTML, so nothing in a message can add elements,
 * styles, handlers or ids to Meziverse.
 *
 * Block elements end a paragraph, <br> starts a new line, and a blank line in
 * plain text does the same as a paragraph break.
 */

const DROP = 'script,style,noscript,template,iframe,object,embed,svg,math,form,input,button,select,textarea,link,meta';

const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

const SPACE = /[\s\u00a0\u200b\u200c\u200d\ufeff]+/g;

/** Collapses runs of whitespace, the way a browser would render them. */
function tidy(text) {
    return text.replace(SPACE, ' ').trim();
}

/**
 * Splits a message into plain-text paragraphs.
 * @param {string} html
 * @returns {string[]}
 */
export function toParagraphs(html) {
    if (typeof html !== 'string' || !html.trim()) return [];

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(DROP).forEach(node => node.remove());

    const paragraphs = [];
    let current = '';
    let pendingBreak = false;

    const flush = () => {
        const text = tidy(current);
        if (text) paragraphs.push(text);
        current = '';
        pendingBreak = false;
    };

    const add = text => {
        if (pendingBreak) flush();
        if (!text) return;
        current += current ? ` ${text}` : text;
    };

    const walk = parent => {
        for (const child of parent.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                // A blank line in the text is a paragraph break; a single
                // newline is just a wrap in the source.
                const parts = child.nodeValue.split(/\r?\n[ \t]*\r?\n/);
                parts.forEach((part, index) => {
                    if (index > 0) flush();
                    add(tidy(part));
                });
                continue;
            }

            if (child.nodeType !== Node.ELEMENT_NODE) continue;

            if (child.tagName === 'BR') {
                flush();
                continue;
            }

            if (BLOCK.has(child.tagName)) {
                flush();
                walk(child);
                flush();
                continue;
            }

            walk(child);
        }
    };

    walk(doc.body);
    flush();

    return paragraphs;
}

/** One line of a message, for the log's previews. */
export function toPlain(html) {
    return toParagraphs(html).join(' ');
}

/** The first `limit` characters of a message, with an ellipsis if cut. */
export function toSnippet(html, limit = 140) {
    const text = toPlain(html);
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}\u2026` : text;
}
