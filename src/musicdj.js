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
 * ids. The story arrives as the chat's own recent turns (see history.js):
 * raw, tags and all, with only the user's prompt regexes applied - the DJ
 * judges the story the way the main chat model reads it.
 *
 * The prompt core is the user's to edit; the pick style and the answer
 * format are appended by code, so no edit can break parsing - or take the
 * story's own genre out of the pick.
 *
 * Pure: the prompt assembly and the answer parse have no DOM and no side
 * effects. The watcher call and the pacing below are the runtime, and the
 * player is reached only through the controller handed in.
 */

import { chatMessages, generateRaw } from './st.js';
import { splitStory } from './history.js';

const LOG = '[Meziverse music dj]';

/* ---------- the protocol (pure) ---------- */

/**
 * The DJ's rules - the creative core the user may edit. The pick style and
 * the answer format are appended by `djSystemPrompt`, never part of this
 * text.
 */
export const DEFAULT_DJ_PROMPT = `You are the scene's music DJ. You read the story's recent turns - the latest story turn kept separate at the end - and answer with a playback intent that fits its mood, setting, pace, and genre. You have no tools: the app searches YouTube and plays the top result for your searchQuery.

Rules:
- Let the story's own genre and era decide the sound: a Wild West tale, a science-fiction tale, a medieval tale and a modern tale must never end up sounding alike.
- Keep the current track with action "none" while it still clearly fits.
- Change only on a clear mood shift, or when the question marks a forced fresh pick, which needs a different, fitting choice.
- Never target Shorts, memes, reaction videos, compilations, or joke clips.
- Use volume 20-40 for quiet scenes and 60-85 for action; answer "volume" alone when only loudness should change.`;

/**
 * The default core as v2.8.0 shipped it. A saved settings copy still holding
 * this exact text is not a user's edit - settings.js refreshes it to the
 * current default.
 */
export const LEGACY_DEFAULT_DJ_PROMPT = `You are the scene's music DJ. Read the latest story turn and answer with a playback intent that fits its mood, setting, pace, and genre. You have no tools: the app searches YouTube and plays the top result for your searchQuery.

Rules:
- Keep the current track with action "none" while it still clearly fits.
- Change only on a clear mood shift, or when the question marks a forced fresh pick, which needs a different, fitting choice.
- Prefer specific known pieces when they are apt; otherwise write a precise vibe query. Favor instrumental, ambient, soundtrack, OST, official audio, extended, mix, or no-copyright terms for immersion.
- Never target Shorts, memes, reaction videos, compilations, or joke clips.
- Use volume 20-40 for quiet scenes and 60-85 for action; answer "volume" alone when only loudness should change.`;

/**
 * The pick styles, code-owned so the core stays free of mode plumbing. Both
 * take the genre from the story itself - the whole point is that different
 * worlds sound different - and both fall back to a vibe query rather than
 * invent anything.
 */
export const PICK_MODES = {
    orchestra: 'PICK STYLE - ORCHESTRA: write a precise search query for an INSTRUMENTAL score or instrumental rendition that fits this story\u2019s own genre and era - western guitars and harmonica for a Wild West tale, synth and electronics for science fiction, lute, flute and choir for a medieval one. Never choose vocal songs. Favor OST, soundtrack, ambient, extended, mix, or no-copyright results.',
    songs: 'PICK STYLE - SONGS: name one specific, well-known real song as "Artist - Title" that fits this story\u2019s own genre, era, and mood - the pop and rock its characters would actually know for a modern tale, country and western for a Wild West one. Prefer the official or artist upload; add "official audio" to the query when it helps. If no specific song clearly fits, fall back to a precise vibe query. Never invent songs.',
};

const ANSWER_FORMAT = [
    'Answer with one JSON object and nothing else:',
    '{"action":"play"|"volume"|"none","mood":"brief detected mood","searchQuery":"YouTube search query or null","volume":number|null}',
].join('\n');

/**
 * The DJ's whole system prompt: the core (the user's), then the pick style
 * and the answer format, appended by code.
 *
 * @param {{core?:string, mode?:'orchestra'|'songs'}} [options]
 */
export function djSystemPrompt({ core = DEFAULT_DJ_PROMPT, mode = 'orchestra' } = {}) {
    const base = typeof core === 'string' && core.trim() ? core.trim() : DEFAULT_DJ_PROMPT;
    const style = PICK_MODES[mode] ?? PICK_MODES.orchestra;
    return `${base}\n\n${style}\n\n${ANSWER_FORMAT}`;
}

/**
 * The DJ's question, as chat turns shaped like the main chat: the story's
 * recent turns in their own roles, the latest story turn as its own
 * assistant message (the turn to judge), and one user message carrying what
 * plays and - on a manual retry - the order to choose differently.
 *
 * @param {{history?:Array<{role:string, text:string}>, last?:{role:string, text:string}|null, playing?:{title?:string, channel?:string, mood?:string}|null, forceFreshPick?:boolean}} parts
 * @returns {Array<{role:string, content:string}>}
 */
export function djMessages({ history = [], last = null, playing = null, forceFreshPick = false } = {}) {
    const messages = [];

    for (const turn of history) {
        if (turn?.text) messages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.text });
    }
    if (last?.text) messages.push({ role: last.role === 'user' ? 'user' : 'assistant', content: last.text });

    const lines = [];
    lines.push(playing?.title
        ? `CURRENTLY PLAYING: ${playing.title}${playing.channel ? ` - ${playing.channel}` : ''}${playing.mood ? ` (chosen for mood: ${playing.mood})` : ''}`
        : 'CURRENTLY PLAYING: nothing');
    if (forceFreshPick) {
        lines.push('FORCED FRESH PICK: the current track is rejected - choose a different, fitting one.');
    }
    lines.push('');
    lines.push(last?.text
        ? 'The assistant message just above is the latest story turn. Pick the music for it, weighing it against the recent turns before it.'
        : 'The story is just beginning. Pick the music for it.');
    messages.push({ role: 'user', content: lines.join('\n') });

    return messages;
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

/**
 * How many story turns the DJ reads before the one it judges. Small on
 * purpose - the story is the chat's own words, so one or two turns carry the
 * scene - and tunable for small local models (Show last request shows
 * exactly what a value sends).
 */
const DJ_STORY_TURNS = 2;

let uiIsOpen = () => true;
let controller = null;
let sinceDj = 0;
let lastDjRequest = null;

/**
 * Wires the DJ to the story through the player's controller. The DJ only
 * ever asks and applies: it plays through `controller.play` and turns the
 * volume through `controller.setVolume`, and reads the settings it needs
 * through the same door. `enabled` is the floor (the player and the key);
 * `auto` is the watcher's own switch - Fresh pick works without it.
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
 * The auto watcher's own switch gates this; Fresh pick does not use it.
 */
export function musicDjArrived() {
    if (!controller?.enabled?.() || !controller?.auto?.() || !uiIsOpen()) return;

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
    // The player's loader: from here until the answer is applied (or gone),
    // the widget says "Selecting track..." - in the player, never a toast.
    controller?.picking?.(true);
    try {
        const { history, last } = await splitStory(chatMessages(), { turns: DJ_STORY_TURNS });
        const request = {
            systemPrompt: djSystemPrompt({ core: controller?.promptCore?.(), mode: controller?.pickMode?.() }),
            prompt: djMessages({
                history,
                last,
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

        // The one ride: the controller's own connection (whatever the
        // Connections tab has chosen for the Music Agent), falling back to
        // the plain call when no controller is wired.
        const answer = controller?.ask
            ? await controller.ask(request)
            : await generateRaw(request);
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
    } finally {
        controller?.picking?.(false);
    }
}
