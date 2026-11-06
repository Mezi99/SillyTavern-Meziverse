/**
 * The Music DJ: a quiet watcher that reads each new reply and picks music to
 * match its mood.
 *
 * Deliberately independent from the background watcher: its own switch, its
 * own pace, its own editable prompt, its own LLM call - so backgrounds and
 * music can be on and off in any combination, and a later build may give
 * each its own model without touching the other.
 *
 * The protocol is Marinara's YouTube DJ contract in our own words: one JSON
 * intent (`play` / `volume` / `none`) with a mood and a search query - the
 * app searches and plays the top candidate, so the DJ never invents video
 * ids. The prompt core is the user's to edit; the answer format is appended
 * by code, so no edit can break parsing.
 *
 * Pure: the prompt assembly, the story excerpt and the answer parse have no
 * DOM and no side effects. The watcher call and the pacing below are the
 * runtime, and the player is reached only through the controller handed in.
 */

import { chatMessages, generateRaw } from './st.js';
import { stripTags } from './tags.js';

const LOG = '[Meziverse music dj]';

/* ---------- the protocol (pure) ---------- */

/**
 * The DJ's rules - the creative core the user may edit. The answer format is
 * appended by `djSystemPrompt`, never part of this text.
 */
export const DEFAULT_DJ_PROMPT = `You are the scene's music DJ. Read the latest story turn and answer with a playback intent that fits its mood, setting, pace, and genre. You have no tools: the app searches YouTube and plays the top result for your searchQuery.

Rules:
- Keep the current track with action "none" while it still clearly fits.
- Change only on a clear mood shift, or when the question marks a forced fresh pick, which needs a different, fitting choice.
- Prefer specific known pieces when they are apt; otherwise write a precise vibe query. Favor instrumental, ambient, soundtrack, OST, official audio, extended, mix, or no-copyright terms for immersion.
- Never target Shorts, memes, reaction videos, compilations, or joke clips.
- Use volume 20-40 for quiet scenes and 60-85 for action; answer "volume" alone when only loudness should change.`;

const ANSWER_FORMAT = [
    'Answer with one JSON object and nothing else:',
    '{"action":"play"|"volume"|"none","mood":"brief detected mood","searchQuery":"YouTube search query or null","volume":number|null}',
].join('\n');

/**
 * The DJ's whole system prompt: the core (the user's) with the answer format
 * appended by code.
 *
 * @param {{core?:string}} [options]
 */
export function djSystemPrompt({ core = DEFAULT_DJ_PROMPT } = {}) {
    const base = typeof core === 'string' && core.trim() ? core.trim() : DEFAULT_DJ_PROMPT;
    return `${base}\n\n${ANSWER_FORMAT}`;
}

/**
 * The story the DJ reads: the last few replies with every tag stripped - the
 * narration the reading pane shows and nothing else - from the end.
 *
 * @param {Array<{mes?:string, is_user?:boolean}>} messages
 * @param {{turns?:number, maxChars?:number}} [options]
 */
export function djStory(messages, { turns = 2, maxChars = 2000 } = {}) {
    const replies = (Array.isArray(messages) ? messages : [])
        .filter(message => message && !message.is_user)
        .slice(-Math.max(1, turns))
        .map(message => stripTags(typeof message.mes === 'string' ? message.mes : '').trim())
        .filter(Boolean);

    return replies.join('\n\n').slice(-maxChars);
}

/**
 * The DJ's question: what is playing, the story, and - on a manual retry -
 * the order to choose differently.
 *
 * @param {{story:string, playing?:{title?:string, channel?:string}, forceFreshPick?:boolean}} parts
 */
export function djQuestion({ story, playing = null, forceFreshPick = false } = {}) {
    const lines = [];

    lines.push(playing?.title
        ? `CURRENTLY PLAYING: ${playing.title}${playing.channel ? ` - ${playing.channel}` : ''}`
        : 'CURRENTLY PLAYING: nothing');
    if (forceFreshPick) {
        lines.push('FORCED FRESH PICK: the current track is rejected - choose a different, fitting one.');
    }
    lines.push('');
    lines.push('LATEST STORY:');
    lines.push(story || '(the story is just beginning)');

    return lines.join('\n');
}

/**
 * The DJ's answer, from whatever shape it came in: the JSON object found in
 * the text (fences and chatter tolerated), normalized to the one intent the
 * player understands. Anything unreadable is "none" - the DJ failing must
 * never stop the music that is already playing.
 *
 * @param {string} text
 * @returns {{action:'play'|'volume'|'none', mood:string|null, searchQuery:string|null, volume:number|null}}
 */
export function parseDjAnswer(text) {
    const intent = { action: 'none', mood: null, searchQuery: null, volume: null };

    const json = extractObject(typeof text === 'string' ? text : '');
    if (!json) return intent;

    const action = String(json.action ?? '').trim().toLowerCase();
    intent.action = action === 'play' || action === 'volume' ? action : 'none';

    const mood = typeof json.mood === 'string' ? json.mood.trim() : '';
    intent.mood = mood || null;

    const query = typeof json.searchQuery === 'string' ? json.searchQuery.trim() : '';
    intent.searchQuery = query || null;

    const volume = Number(json.volume);
    intent.volume = Number.isFinite(volume) && json.volume !== null && json.volume !== ''
        ? Math.max(0, Math.min(100, Math.round(volume)))
        : null;

    // A play with nothing to search is not a play.
    if (intent.action === 'play' && !intent.searchQuery) intent.action = 'none';
    // A volume with no number is not a volume.
    if (intent.action === 'volume' && intent.volume === null) intent.action = 'none';

    return intent;
}

/** The first JSON object in a string - code fences and chatter tolerated. */
function extractObject(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;

    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/* ---------- the watcher (runtime) ---------- */

let uiIsOpen = () => true;
let controller = null;
let sinceDj = 0;
let lastDjRequest = null;

/**
 * Wires the DJ to the story through the player's controller. The DJ only
 * ever asks and applies: it plays through `controller.play` and turns the
 * volume through `controller.setVolume`, and reads the settings it needs
 * through the same door.
 *
 * @param {{isOpen?:() => boolean, controller:object}} parts
 */
export function initMusicDj({ isOpen, controller: player } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;
    controller = player ?? null;
}

/** A chat change forgets the pace - each chat counts its own replies. */
export function resetMusicDjPacing() {
    sinceDj = 0;
}

/**
 * One finished reply arrived: at the set pace - at most one call every N
 * replies - ask the DJ what the scene should sound like. A reply whose
 * `<music>` tag already cued a track never gets here (music.js decides).
 */
export function musicDjArrived() {
    if (!controller?.enabled?.() || !uiIsOpen()) return;

    sinceDj += 1;
    const everyN = Math.max(1, Number(controller.everyN?.()) || 1);
    if (sinceDj < everyN) return;
    sinceDj = 0;

    askDj().catch(error => {
        console.warn(`${LOG} the pick failed`, error);
    });
}

/** The manual retry: the same question, with the order to choose differently. */
export async function musicDjFreshPick() {
    if (!controller?.enabled?.()) return null;
    return askDj({ forceFreshPick: true });
}

/** The last question verbatim - for the settings panel. */
export function getLastDjRequest() {
    return lastDjRequest;
}

/** Asks the DJ and applies its one intent. */
async function askDj({ forceFreshPick = false } = {}) {
    const request = {
        systemPrompt: djSystemPrompt({ core: controller?.promptCore?.() }),
        prompt: djQuestion({
            story: djStory(chatMessages()),
            playing: controller?.current?.() ?? null,
            forceFreshPick,
        }),
        // Deliberately no responseLength: on providers that count the prompt
        // against the budget, any cap this request can afford starves the
        // answer to nothing ("No message generated"). The global response
        // length is used instead, and `parseDjAnswer` extracts the JSON
        // whatever else comes with it.
    };
    lastDjRequest = request;

    const answer = await generateRaw(request);
    if (!answer.ok) {
        console.warn(`${LOG} the watcher call failed`, answer.error);
        return null;
    }

    const intent = parseDjAnswer(answer.text);

    if (intent.action === 'volume' && intent.volume !== null) {
        controller?.setVolume?.(intent.volume);
    }
    if (intent.action === 'play' && intent.searchQuery) {
        controller?.play?.(intent.searchQuery, { mood: intent.mood });
    }

    return intent;
}
