/**
 * The Meziverse tag grammar, read straight from a message's source text.
 *
 * Pure: no DOM, no SillyTavern, no side effects. SillyTavern only ever stores
 * the source (`message.mes`); everything Meziverse shows is derived here, so a
 * swipe, edit or stream frame is correct the moment the text changes.
 *
 * The scanner is deliberately forgiving. Only the catalogue names below are
 * tags, so card-written HTML (`<div>`, `<b>`, `<option>`) passes through
 * untouched. Tags inside fenced or inline code are not tags either; the model
 * is allowed to talk about them.
 */

/* Catalogue names that are always self-closing. */
const SELF = new Set([
    'scene', 'meanwhile', 'filter', 'lie',
    'recap', 'lore', 'hook', 'thread', 'profile', 'shift', 'milestone',
    'standing', 'plan', 'goals',
]);

/* Body tags whose words are prose, so only the wrapper goes. */
const KEEP = new Set(['speech', 'flashback']);

/* Body tags whose words are private: strip wrapper and body together. */
const HIDDEN = new Set(['think', 'ledger', 'playerguide', 'directorguide', 'vkit']);

const NAMES = new Set([...SELF, ...KEEP, ...HIDDEN]);

const OPEN = /<([A-Za-z][A-Za-z0-9_-]*)/y;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const parseCache = new WeakMap();

/**
 * Finds every catalogue tag in a raw message.
 *
 * @param {string} mes
 * @returns {Array<{name:string, attrs:Record<string,string>, body:string|null, selfClosing:boolean, closed:boolean, start:number, end:number}>}
 */
export function parseTags(mes) {
    const text = typeof mes === 'string' ? mes : '';
    const inCode = rangeCheck(codeRanges(text));

    const tags = [];
    let cursor = 0;

    while (cursor < text.length) {
        const open = findOpen(text, cursor, inCode);
        if (!open) break;

        const tag = readTag(text, open, inCode);
        tags.push(tag);

        // A half tag ends the message for our purposes. Nothing after it can
        // be trusted until the next frame writes the rest.
        if (!tag.closed) break;
        cursor = Math.max(tag.end, open.index + 1);
    }

    return tags;
}

/** Tags for one message, cached on identity and re-read when `mes` changes. */
export function parseMessage(message) {
    if (!message || typeof message !== 'object') return { mes: '', tags: [] };

    const mes = typeof message.mes === 'string' ? message.mes : '';
    const hit = parseCache.get(message);
    if (hit && hit.mes === mes) return hit;

    const record = { mes, tags: parseTags(mes) };
    parseCache.set(message, record);
    return record;
}

/**
 * The message with every catalogue tag removed.
 *
 * Streaming-safe: an unclosed hidden tag hides its tail; an unclosed `speech`
 * or `flashback` keeps its partial body because those words are prose.
 */
export function stripTags(mes) {
    const text = typeof mes === 'string' ? mes : '';
    const tags = parseTags(text);

    let out = '';
    let cursor = 0;

    for (const tag of tags) {
        if (tag.start < cursor) continue;
        out += text.slice(cursor, tag.start);

        if (HIDDEN.has(tag.name)) {
            if (!tag.closed) {
                cursor = text.length;
                break;
            }
            cursor = tag.end;
            continue;
        }

        if (KEEP.has(tag.name)) {
            out += tag.body ?? '';
            cursor = tag.end;
            continue;
        }

        cursor = tag.end;
        if (!tag.closed) {
            cursor = text.length;
            break;
        }
    }

    out += text.slice(cursor);
    return out;
}

/** Every complete `<scene>` tag, in the order it appears. */
export function scenesOf(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.filter(tag => tag.name === 'scene' && tag.closed);
}

/**
 * Splits a message at complete scene tags, so prose and inline scene rows can
 * be interleaved. Non-scene tags are stripped exactly as in `stripTags`.
 *
 * @param {string} mes
 * @returns {Array<{type:'text', text:string}|{type:'scene', tag:object}>}
 */
export function splitCues(mes) {
    const text = typeof mes === 'string' ? mes : '';
    const tags = parseTags(text);

    const cues = [];
    let prose = '';
    let cursor = 0;

    const flush = () => {
        if (!prose) return;
        cues.push({ type: 'text', text: prose });
        prose = '';
    };

    for (const tag of tags) {
        if (tag.start < cursor) continue;
        prose += text.slice(cursor, tag.start);

        if (tag.name === 'scene' && tag.closed) {
            flush();
            cues.push({ type: 'scene', tag });
            cursor = tag.end;
            continue;
        }

        if (HIDDEN.has(tag.name)) {
            if (!tag.closed) {
                cursor = text.length;
                break;
            }
            cursor = tag.end;
            continue;
        }

        if (KEEP.has(tag.name)) {
            prose += tag.body ?? '';
            cursor = tag.end;
            continue;
        }

        cursor = tag.end;
        if (!tag.closed) {
            cursor = text.length;
            break;
        }
    }

    prose += text.slice(cursor);
    flush();
    return cues;
}

/* ---------- scanning ---------- */

function findOpen(text, from, inCode) {
    let cursor = from;

    while (cursor < text.length) {
        const at = text.indexOf('<', cursor);
        if (at < 0) return null;

        if (inCode(at)) {
            cursor = at + 1;
            continue;
        }

        OPEN.lastIndex = at;
        const match = OPEN.exec(text);
        if (!match) {
            cursor = at + 1;
            continue;
        }

        const name = match[1].toLowerCase();
        if (!NAMES.has(name)) {
            cursor = at + match[0].length;
            continue;
        }

        return { index: at, name, nameEnd: at + match[0].length };
    }

    return null;
}

function readTag(text, open, inCode) {
    let cursor = open.nameEnd;
    let quote = null;
    let close = -1;

    for (; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            close = cursor;
            break;
        }
    }

    const innerEnd = close >= 0 ? close : text.length;
    const inner = text.slice(open.nameEnd, innerEnd);
    const attrs = parseAttributes(inner);

    const slash = /\/\s*$/.test(inner);
    const selfClosing = SELF.has(open.name) || slash;

    if (selfClosing) {
        return {
            name: open.name,
            attrs,
            body: null,
            selfClosing: true,
            closed: close >= 0,
            start: open.index,
            end: close >= 0 ? close + 1 : text.length,
        };
    }

    if (close < 0) {
        return {
            name: open.name,
            attrs,
            body: text.slice(open.nameEnd),
            selfClosing: false,
            closed: false,
            start: open.index,
            end: text.length,
        };
    }

    const bodyStart = close + 1;
    const closing = new RegExp(`<\\s*/\\s*${open.name}\\s*>`, 'ig');
    closing.lastIndex = bodyStart;

    let match;
    while ((match = closing.exec(text))) {
        // A closing tag quoted as an example is not a closing tag.
        if (inCode(match.index)) {
            closing.lastIndex = match.index + 1;
            continue;
        }

        return {
            name: open.name,
            attrs,
            body: text.slice(bodyStart, match.index),
            selfClosing: false,
            closed: true,
            start: open.index,
            end: match.index + match[0].length,
        };
    }

    return {
        name: open.name,
        attrs,
        body: text.slice(bodyStart),
        selfClosing: false,
        closed: false,
        start: open.index,
        end: text.length,
    };
}

function parseAttributes(inner) {
    const attrs = {};
    ATTRIBUTE.lastIndex = 0;

    let match;
    while ((match = ATTRIBUTE.exec(inner))) {
        const name = match[1].toLowerCase();
        if (match[2] !== undefined) attrs[name] = match[2];
        else attrs[name] = match[3] ?? '';
    }

    return attrs;
}

/* ---------- code spans ---------- */

/** Keeps the scanner out of fenced blocks and inline code spans. */
function codeRanges(text) {
    const ranges = [];

    let fence = null;
    let lineStart = 0;

    while (lineStart < text.length) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);

        if (!fence && marker) {
            fence = { char: marker[1][0], length: marker[1].length, start: lineStart };
        } else if (fence && marker && marker[1][0] === fence.char && marker[1].length >= fence.length) {
            ranges.push([fence.start, newline < 0 ? text.length : newline + 1]);
            fence = null;
        }

        if (newline < 0) break;
        lineStart = newline + 1;
    }

    if (fence) ranges.push([fence.start, text.length]);

    let cursor = 0;
    while (cursor < text.length) {
        if (inside(ranges, cursor)) {
            cursor = nextAfter(ranges, cursor);
            continue;
        }

        if (text[cursor] !== '`') {
            cursor += 1;
            continue;
        }

        let run = 1;
        while (text[cursor + run] === '`') run += 1;

        let probe = cursor + run;
        let found = -1;

        while (probe < text.length) {
            if (inside(ranges, probe)) break;

            if (text[probe] === '`') {
                let length = 1;
                while (text[probe + length] === '`') length += 1;
                if (length === run) {
                    found = probe;
                    break;
                }
                probe += length;
            } else {
                probe += 1;
            }
        }

        if (found < 0) {
            cursor += run;
            continue;
        }

        ranges.push([cursor, found + run]);
        cursor = found + run;
    }

    ranges.sort((a, b) => a[0] - b[0]);
    return ranges;
}

function inside(ranges, position) {
    for (const [start, end] of ranges) {
        if (position < start) return false;
        if (position < end) return true;
    }
    return false;
}

function nextAfter(ranges, position) {
    for (const [, end] of ranges) {
        if (position < end) return end;
    }
    return position + 1;
}

/** A cheap monotonic membership test for positions read left to right. */
function rangeCheck(ranges) {
    let index = 0;
    return position => {
        while (index < ranges.length && ranges[index][1] <= position) index += 1;
        return index < ranges.length
            && ranges[index][0] <= position
            && position < ranges[index][1];
    };
}
