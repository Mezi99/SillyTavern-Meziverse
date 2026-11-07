/**
 * The story a watcher reads: the chat's recent turns exactly as they came -
 * tags, scaffolding and all - with only SillyTavern's own prompt regexes
 * applied. We strip nothing: presets hide story cues in tags, and with mode
 * off this extension serves any preset, so what matters in a turn is not
 * ours to decide. The user's regex scripts are the one cleaning pass, and
 * they run per turn, with the turn's depth, just as in the main chat.
 *
 * Shape: a few recent turns (user and AI alike - what the last reply is
 * based on), and the turn to judge - the latest AI reply, or the reply at
 * `at` when a watcher resolves its own - kept whole and separate at the end.
 * Turns are never rewritten or sliced; when the budget overflows the oldest
 * whole turns drop.
 *
 * Pure by injection: `clean` defaults to the SillyTavern seam, but tests
 * pass their own, so nothing here touches the app on its own.
 */

import { promptClean } from './st.js';

/** The story's share of the request, in characters. Oldest turns drop first. */
export const STORY_BUDGET = 8000;

/**
 * The watcher's story, split the way the prompts frame it.
 *
 * @param {Array<{mes?:string, is_user?:boolean, is_system?:boolean}>} messages
 * @param {{turns?:number, budget?:number, clean?:Function, at?:number}} [options]
 *        `turns` history turns before the judged one; `at` names the turn to
 *        judge (a watcher resolving its own reply), else the latest AI reply.
 * @returns {Promise<{history:Array<{role:'user'|'assistant', text:string}>, last:{role:'user'|'assistant', text:string}|null}>}
 */
export async function splitStory(messages, { turns = 2, budget = STORY_BUDGET, clean = promptClean, at } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const usable = [];
    list.forEach((message, index) => {
        if (!message || typeof message !== 'object' || message.is_system) return;
        usable.push({ message, index, at: usable.length });
    });

    const find = wanted => usable.find(entry => entry.index === wanted) ?? null;
    const role = entry => (entry.message.is_user ? 'user' : 'assistant');
    const depth = entry => usable.length - entry.at - 1;
    const read = async entry => ({
        role: role(entry),
        text: (await clean(String(entry.message.mes ?? ''), { isUser: !!entry.message.is_user, depth: depth(entry) })).trim(),
    });

    // The turn to judge: the reply a watcher names, else the latest AI reply.
    const wanted = Number.isInteger(at) ? find(at) : null;
    const judged = wanted ?? [...usable].reverse().find(entry => !entry.message.is_user) ?? null;

    // The history: the non-empty turns just before it, oldest first.
    const before = judged ? usable.slice(0, usable.indexOf(judged)) : usable;
    const picked = [];
    for (let i = before.length - 1; i >= 0 && picked.length < Math.max(1, turns); i -= 1) {
        if (!String(before[i].message.mes ?? '').trim()) continue;
        picked.unshift(before[i]);
    }

    const history = [];
    for (const entry of picked) {
        const turn = await read(entry);
        if (turn.text) history.push(turn);
    }

    const last = judged ? await read(judged) : null;
    if (last && !last.text) {
        // A blank judged turn: the history still stands, but there is
        // nothing to judge - say so with the newest turn instead.
        const fallback = history.pop() ?? null;
        return { history, last: fallback };
    }

    // Whole turns drop from the oldest end when the story outgrows its
    // budget. The judged turn is never one of them: it is the point.
    let size = (last?.text.length ?? 0) + history.reduce((sum, turn) => sum + turn.text.length, 0);
    while (history.length && size > Math.max(500, budget)) {
        size -= history[0].text.length;
        history.shift();
    }

    return { history, last: last ?? null };
}
