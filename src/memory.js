/**
 * How a memory body becomes the fragments that surface one by one in the
 * mindscape. Pure: no DOM, no SillyTavern.
 *
 * The model usually writes a memory as one big paragraph, so the split is
 * by sentence — but the quoted dialogue inside it is sacred: a full stop
 * inside quotation marks never splits, and a quote stays glued to the
 * attribution that carries it. Blank lines always split.
 */

/* Names that swallow the dot after them. */
const ABBREVIATIONS = /^(?:mrs|mr|ms|dr|prof|st|sr|jr|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$/i;

/* The words that make a clause an attribution rather than the next
   sentence: the quote before them belongs to the same fragment. */
const ATTRIBUTION = new RegExp(`\\b(?:${[
    'say', 'says', 'said', 'saying', 'tell', 'tells', 'told', 'telling',
    'ask', 'asks', 'asked', 'asking', 'answer', 'answers', 'answered', 'answering',
    'reply', 'replies', 'replied', 'replying', 'respond', 'responds', 'responded',
    'echo', 'echoes', 'echoed', 'repeat', 'repeated', 'continue', 'continues', 'continued',
    'add', 'adds', 'added', 'adding', 'offer', 'offered', 'suggest', 'suggested',
    'insist', 'insisted', 'demand', 'demanded', 'beg', 'begs', 'begged', 'begging',
    'promise', 'promised', 'promising', 'warn', 'warned', 'admit', 'admits', 'admitted', 'admitting',
    'deny', 'denies', 'denied', 'denying', 'lie', 'lies', 'lied', 'lying',
    'joke', 'joked', 'tease', 'teased', 'teasing', 'laugh', 'laughed', 'laughs',
    'smile', 'smiled', 'smiles', 'smiling', 'grin', 'grinned', 'grinning',
    'chuckle', 'chuckled', 'chuckles', 'sigh', 'sighed', 'sighing',
    'snap', 'snapped', 'snapping', 'growl', 'growled', 'hiss', 'hissed',
    'mutter', 'muttered', 'muttering', 'murmur', 'murmured', 'murmuring',
    'whisper', 'whispered', 'whispering', 'shout', 'shouted', 'shouting',
    'yell', 'yelled', 'scream', 'screamed', 'cry', 'cries', 'cried', 'crying',
    'sob', 'sobs', 'sobbed', 'sobbing', 'call', 'calls', 'called', 'calling',
    'announce', 'announced', 'announcing', 'declare', 'declared', 'declaring',
    'agree', 'agreed', 'argue', 'argued', 'arguing', 'complain', 'complained',
    'explain', 'explained', 'explaining', 'note', 'noted', 'noting',
    'observe', 'observed', 'observing', 'remark', 'remarked', 'comment', 'commented', 'commenting',
    'think', 'thinks', 'thinking', 'thought', 'speak', 'speaks', 'spoke', 'speaking', 'spoken',
    'shrug', 'shrugged', 'shrugging', 'nod', 'nodded', 'nodding',
    'wink', 'winked', 'blink', 'blinked', 'freeze', 'freezes', 'froze', 'freezing',
].join('|')})\\b`, 'i');

const OPEN_DOUBLE = '\u201c';
const CLOSE_DOUBLE = '\u201d';
const OPEN_SINGLE = '\u2018';
const CLOSE_SINGLE = '\u2019';

/**
 * Splits a memory body into its fragments: one sentence each, quotes
 * intact, with attributions glued to the quote before them.
 *
 * @param {string} body
 * @returns {string[]} trimmed fragments, in order
 */
export function splitMemory(body) {
    const text = typeof body === 'string' ? body : '';

    const fragments = [];
    for (const paragraph of text.split(/\n[ \t]*\n+/)) {
        if (!paragraph.trim()) continue;
        fragments.push(...splitSentences(paragraph));
    }

    return fragments.filter(fragment => fragment.trim());
}

/* ---------- one paragraph ---------- */

function splitSentences(paragraph) {
    const marks = boundaries(paragraph);
    const fragments = [];
    let from = 0;

    for (const at of marks) {
        fragments.push(paragraph.slice(from, at).trim());
        from = at;
    }

    fragments.push(paragraph.slice(from).trim());
    return fragments;
}

/** Where the paragraph may end a fragment: after each sentence's end. */
function boundaries(paragraph) {
    const marks = [];
    let quote = '';

    for (let i = 0; i < paragraph.length; i += 1) {
        const char = paragraph[i];

        if (quote) {
            if (closesQuote(char, quote)) {
                quote = '';

                // A quote that ends in sentence punctuation can end the
                // fragment too — unless the clause after it is the
                // speaker's attribution, which stays glued to the quote.
                const rest = paragraph.slice(i + 1);
                const next = rest.replace(/^\s+/, '');
                const attributed = next
                    && !/^["\u201c'\u2018]/.test(next)
                    && (CONTINUATION.test(next) || ATTRIBUTION.test(clauseAfter(paragraph, i + 1)));

                if ('.!?'.includes(paragraph[i - 1] || '') || paragraph[i - 1] === '\u2026') {
                    if (/^\s/.test(rest) && !attributed) marks.push(i + 1);
                }
            }
            continue;
        }

        if (opensQuote(paragraph, i)) {
            quote = char === "'" ? "'" : '"';
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

        marks.push(end);
        i = end - 1;
    }

    return marks;
}

/** The clause that follows a candidate boundary, up to its own end. */
function clauseAfter(paragraph, from) {
    const rest = paragraph.slice(from);
    const stop = /[.!?](?:["\u201d\u2019])?\s/.exec(rest);
    return stop ? rest.slice(0, stop.index + stop[0].length) : rest;
}

/* A lowercase connector after a closing quote continues the sentence. */
const CONTINUATION = /^(?:and|but|or|nor|so|yet|then|while|when|as|because|if|though|although|with|after|before|since)\b/;

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
