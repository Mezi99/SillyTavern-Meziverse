/**
 * How a memory body becomes the rows that surface one by one in the
 * mindscape. Pure: no DOM, no SillyTavern.
 *
 * The rule is mechanical, with no word lists behind it: sentences split
 * at their own ends — never inside quotation marks — and a sentence that
 * speaks in quotes takes the single one after it into its row. Dialogue
 * therefore leads each row with what follows it, plain narration stands
 * alone, and short sentences fill the screen instead of scattering.
 * Blank lines split hard.
 */

/* Names that swallow the dot after them. */
const ABBREVIATIONS = /^(?:mrs|mr|ms|dr|prof|st|sr|jr|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$/i;

const OPEN_DOUBLE = '\u201c';
const CLOSE_DOUBLE = '\u201d';
const OPEN_SINGLE = '\u2018';
const CLOSE_SINGLE = '\u2019';

/**
 * Splits a memory body into its rows: one per thought, each quoted line
 * with the sentence that follows it.
 *
 * @param {string} body
 * @returns {string[]} trimmed rows, in order
 */
export function splitMemory(body) {
    const text = typeof body === 'string' ? body : '';

    const rows = [];
    for (const paragraph of text.split(/\n[ \t]*\n+/)) {
        if (!paragraph.trim()) continue;
        rows.push(...groupSentences(paragraph));
    }

    return rows.filter(row => row.trim());
}

/* ---------- one paragraph ---------- */

function groupSentences(paragraph) {
    const units = unitsOf(paragraph);
    const rows = [];

    for (let at = 0; at < units.length; at += 1) {
        const unit = units[at];
        let end = unit.end;

        // A sentence that speaks in quotes takes the one after it.
        if (unit.quoted && at + 1 < units.length) {
            at += 1;
            end = units[at].end;
        }

        rows.push(paragraph.slice(unit.start, end).trim());
    }

    return rows;
}

/**
 * The paragraph's sentences, each marked with whether it speaks in
 * quotes. A sentence ends at its own punctuation — or at the closing
 * quote of a quote that ends in punctuation. Nothing inside a quote
 * ever ends anything.
 */
function unitsOf(paragraph) {
    const units = [];
    let start = 0;
    let quoted = false;
    let quote = '';

    const push = end => {
        if (end > start) units.push({ start, end, quoted });
        start = end;
        quoted = false;
    };

    for (let i = 0; i < paragraph.length; i += 1) {
        const char = paragraph[i];

        if (quote) {
            if (closesQuote(char, quote)) {
                quote = '';
                const before = paragraph[i - 1] || '';
                const rest = paragraph.slice(i + 1);
                if (('.!?'.includes(before) || before === '\u2026') && (!rest || /^\s/.test(rest))) {
                    push(i + 1);
                }
            }
            continue;
        }

        if (opensQuote(paragraph, i)) {
            quote = char === "'" ? "'" : '"';
            quoted = true;
            continue;
        }

        if (!'.!?'.includes(char) && char !== '\u2026') continue;

        // A run of terminators ends the sentence; anything else — a
        // single initial, an abbreviation, a word like "3.5" — does not.
        let end = i;
        while (end < paragraph.length && '.!?'.includes(paragraph[end])) end += 1;

        const after = paragraph.slice(end);
        if (after && !/^\s/.test(after)) {
            i = end - 1;
            continue;
        }

        const word = paragraph.slice(paragraph.lastIndexOf(' ', i) + 1, i + 1);
        if (char === '.' && (ABBREVIATIONS.test(word) || /^[A-Z]\.$/.test(word))) continue;

        push(end);
        i = end - 1;
    }

    push(paragraph.length);
    return units;
}

function opensQuote(text, at) {
    const char = text[at];
    if (char === '"' || char === OPEN_DOUBLE) return true;
    if (char !== "'" && char !== OPEN_SINGLE) return false;

    // An apostrophe between letters is not a quote.
    const before = text[at - 1] || '';
    const after = text[at + 1] || '';
    return !(/\w/.test(before) && /\w/.test(after));
}

function closesQuote(char, quote) {
    return quote === '"' ? (char === '"' || char === CLOSE_DOUBLE) : (char === "'" || char === CLOSE_SINGLE);
}
