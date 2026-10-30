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

/**
 * Collapses runs of spaces and tabs inside a line, the way a browser would
 * render them. Newlines are not touched here: they carry the line structure.
 */
function tidy(text) {
    return text.replace(SPACE, ' ').trim();
}

/**
 * Splits a message into plain-text paragraphs.
 *
 * A single newline is a line break inside a paragraph, because that is how
 * these messages are written: one beat per line. A blank line, or a block
 * element, starts a new paragraph. Lines are kept joined by "\n" and drawn
 * with `white-space: pre-wrap`.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function toParagraphs(html) {
    if (typeof html !== 'string' || !html.trim()) return [];

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(DROP).forEach(node => node.remove());

    const paragraphs = [];
    let lines = [];
    let current = '';

    const add = text => {
        if (!text) return;
        current += current ? ` ${text}` : text;
    };

    const endParagraph = () => {
        if (lines.length) paragraphs.push(lines.join('\n'));
        lines = [];
    };

    /** Ends the current line; an empty line ends the paragraph too. */
    const endLine = () => {
        const text = tidy(current);
        current = '';
        if (text) lines.push(text);
        else endParagraph();
    };

    const walk = parent => {
        for (const child of parent.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                const parts = child.nodeValue.split(/\r\n|\r|\n/);
                parts.forEach((part, index) => {
                    add(tidy(part));
                    if (index < parts.length - 1) endLine();
                });
                continue;
            }

            if (child.nodeType !== Node.ELEMENT_NODE) continue;

            if (child.tagName === 'BR') {
                endLine();
                continue;
            }

            if (BLOCK.has(child.tagName)) {
                endLine();
                endParagraph();
                walk(child);
                endLine();
                endParagraph();
                continue;
            }

            walk(child);
        }
    };

    walk(doc.body);
    endLine();
    endParagraph();

    return paragraphs;
}

/** One line of a message, for the log's previews. */
export function toPlain(html) {
    return toParagraphs(html).join(' ').replace(/\s+/g, ' ').trim();
}

/** The first `limit` characters of a message, with an ellipsis if cut. */
export function toSnippet(html, limit = 140) {
    const text = toPlain(html);
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}\u2026` : text;
}
