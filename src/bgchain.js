/**
 * The chain that keeps the chat background in step with the story's place.
 *
 * One entry - `syncBackgrounds` - answers a single question: does the image on
 * screen still fit where the story is now? It pays for a new image only when
 * the answer is no: the scene tags name a different place (mode ON), the
 * user's every-N-replies pace is due (mode OFF), or the brush button demands
 * a fresh picture outright.
 *
 * The pure parts (deciding, asking, parsing) live in backgrounds.js and the
 * SillyTavern calls in st.js; this file is the choreography between them.
 * Silent on success by design - nothing is toasted or asked, prompts go to the
 * console for debugging, and failures come back as statuses the UI may show.
 * One job at a time: a newer request supersedes the one before it.
 */

import {
    aliasLocation,
    buildWatcherRequest,
    compileBgPrompt,
    currentRecord,
    decide,
    fallbackLocationPrompt,
    locationKey,
    normalizeStore,
    parseWatcherReply,
    recoverCurrentKey,
    resolveRecordId,
    storeRecord,
    LANDSCAPE_SIZE,
} from './backgrounds.js';
import {
    bgStore,
    chatMessages,
    customBackground,
    currentChatId,
    forceSetBackground,
    generateRaw,
    imagine,
    imageGenerationStatus,
    on,
    personaName,
    saveChatMetadata,
} from './st.js';
import { bgAutoOn, modeOn, settings } from './settings.js';
import { resolveScene } from './scene.js';

const LOG = '[Meziverse] bg';

let chainSeq = 0;
let chainAbort = null;
let repliesSinceWatch = 0;

/**
 * Stops whatever the chain is doing now. Anything already in flight becomes
 * stale and its result is discarded, never applied.
 */
export function cancelBackgroundWork() {
    chainSeq += 1;
    if (chainAbort) {
        chainAbort.abort();
        chainAbort = null;
    }
}

/** Forgets the mode OFF pace, e.g. when a chat changes. */
export function resetBackgroundPacing() {
    repliesSinceWatch = 0;
}

/**
 * Wires the chain to the story: every finished reply, swipe or edit runs it
 * once, and a chat change cancels whatever was in flight and re-derives the
 * current place from the background SillyTavern itself restored. The chain
 * follows the chat whether the scene is open or not - the background belongs
 * to the chat, not to the window.
 */
export function initBackgrounds() {
    on('CHAT_CHANGED', () => {
        cancelBackgroundWork();
        resetBackgroundPacing();
        recoverCurrentKey(bgStore(), customBackground());
    });

    const follow = () => {
        syncBackgrounds({ generate: true }).catch?.(error => {
            console.warn(`${LOG} chain failed`, error);
        });
    };

    on('GENERATION_ENDED', follow);
    on('GENERATION_STOPPED', follow);
    on('GROUP_WRAPPER_FINISHED', follow);
    on('MESSAGE_SWIPED', follow);
    on('MESSAGE_EDITED', follow);
}

/**
 * Runs the chain for where the story is now.
 *
 * `generate: false` is the scroll case: a cached image may come back, but
 * nothing is ever drawn or asked. `force` is the brush: a fresh image of the
 * current place whatever the watcher thinks. Without `force` the chain only
 * moves while the `bgAuto` setting is on.
 *
 * @param {{generate?:boolean, force?:boolean}} [options]
 * @returns {Promise<{status:'off'|'unchanged'|'cached'|'generated'|'superseded'|'cancelled'|'unavailable'|'error', record?:object, error?:string}>}
 */
export async function syncBackgrounds({ generate = true, force = false } = {}) {
    if (!force && !bgAutoOn()) return { status: 'off' };
    if (!currentChatId()) {
        return force
            ? { status: 'unavailable', error: 'Open a chat first.' }
            : { status: 'unchanged' };
    }

    const store = bgStore();
    const place = currentPlace();

    if (force) return runWatcherChain({ store, place, force: true });

    if (modeOn()) {
        const step = decide(store, place);
        if (step.action === 'none') return { status: 'unchanged' };

        if (step.action === 'apply') {
            const done = await applyRecord(store, place, step.record);
            return done
                ? { status: 'cached', record: step.record }
                : { status: 'error', error: 'The background could not be set.' };
        }

        return generate
            ? runWatcherChain({ store, place, force: false })
            : { status: 'unchanged' };
    }

    // Mode OFF: no tags to compare, so the watcher is asked at the user's pace.
    if (!generate) return { status: 'unchanged' };
    repliesSinceWatch += 1;
    const every = Math.max(1, Number(settings().bgEveryN) || 1);
    if (repliesSinceWatch < every) return { status: 'unchanged' };
    repliesSinceWatch = 0;

    return runWatcherChain({ store, place: '', force: false });
}

/**
 * Asks the watcher where the story is, then acts on the answer: "same" folds
 * the spelling onto the image already up, "known" brings back a cached image,
 * "new" draws one.
 */
async function runWatcherChain({ store, place, force }) {
    const ready = imageGenerationStatus();
    if (!ready.ok) return { status: 'unavailable', error: ready.text };

    const my = ++chainSeq;
    if (chainAbort) chainAbort.abort();
    const controller = new AbortController();
    chainAbort = controller;

    const request = buildWatcherRequest({
        store,
        messages: chatMessages(),
        mode: modeOn(),
        count: Math.max(1, Number(settings().bgContextReplies) || 2),
        persona: personaName(),
        force,
    });

    console.debug(`${LOG} asking the watcher`, { place, force });

    const reply = await generateRaw({
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        responseLength: request.responseLength,
        jsonSchema: request.jsonSchema,
    });

    if (my !== chainSeq) return { status: 'superseded' };

    let answer = reply.ok ? parseWatcherReply(reply.text) : null;
    if (!answer) {
        // The watcher failed. Mode ON still knows the place from the tags and
        // draws from the template; mode OFF has nothing to fall back on.
        if (!place) return { status: 'error', error: reply.error || 'The watcher call failed.' };
        answer = { state: 'new', knownId: null, place, prompt: fallbackLocationPrompt(currentScene()) };
    }

    if (force && answer.state !== 'new') {
        answer = {
            state: 'new',
            knownId: null,
            place: answer.place || place,
            prompt: answer.prompt || fallbackLocationPrompt(currentScene()),
        };
    }

    console.debug(`${LOG} watcher answered`, answer);

    if (answer.state === 'same') {
        // The same place, spelled differently: fold the spelling onto the
        // image already up, so the next skip-gate compares equal for free.
        const current = currentRecord(store);
        if (place && current) {
            aliasLocation(store, place, current.id);
            saveChatMetadata();
        }
        return { status: 'unchanged' };
    }

    const target = place || answer.place;

    if (answer.state === 'known') {
        const id = resolveRecordId(store, answer.knownId);
        const record = id ? aliasLocation(store, target || store.records[id].place, id) : null;
        if (record) {
            saveChatMetadata();
            const done = await applyRecord(store, target || record.place, record);
            return done
                ? { status: 'cached', record }
                : { status: 'error', error: 'The background could not be set.' };
        }
        // A stale id (hand-edited or pruned chat data): draw fresh instead,
        // from the watcher's own description when it wrote one.
    }

    return generateBackground({
        store,
        place: target,
        description: answer.prompt || fallbackLocationPrompt(currentScene()),
        force,
        my,
        signal: controller.signal,
    });
}

/** Draws one image for a place and makes it the chat background. */
async function generateBackground({ store, place, description, force, my, signal }) {
    const { bgStyle, bgNegative, bgSize } = settings();
    const prompt = compileBgPrompt(description, bgStyle);
    const size = bgSize === 'landscape' ? LANDSCAPE_SIZE : null;

    console.debug(`${LOG} drawing`, { place, prompt });

    const result = await imagine({
        prompt,
        negative: bgNegative,
        width: size?.width,
        height: size?.height,
        signal,
    });

    if (!result.ok) return { status: result.aborted ? 'cancelled' : 'error', error: result.error };
    if (my !== chainSeq) return { status: 'superseded' };

    const record = storeRecord(store, {
        key: place,
        place,
        prompt,
        path: result.path,
        overwrite: !!force,
    });
    if (!record) return { status: 'error', error: 'The background could not be remembered.' };

    await forceSetBackground(result.path);
    saveChatMetadata();
    console.debug(`${LOG} background set`, { place, path: result.path });

    return { status: 'generated', record };
}

/**
 * Shows a cached image again. The key only moves onto the record once
 * SillyTavern confirms the background - a failed swap stays retryable.
 */
async function applyRecord(store, key, record) {
    const done = await forceSetBackground(record.path);
    if (!done) return false;

    normalizeStore(store).currentKey = locationKey(key) || locationKey(record.place);
    saveChatMetadata();
    return true;
}

/** The scene governing the turn at the end of the chat - where the story is. */
function currentScene() {
    return resolveScene(chatMessages(), undefined, { persona: personaName() })?.scene || null;
}

/** Its place, as the chat bar shows it, or '' when the tags know no place. */
function currentPlace() {
    return currentScene()?.placeFull || '';
}
