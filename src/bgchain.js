/**
 * The chain that ties each reply to the background its story deserves.
 *
 * One entry - `requestBackground` - resolves ONE reply (a message and the
 * swipe variant of it): does the picture it carries still fit where its story
 * is? A `<scene>` tag answers that outright - any preset can carry one - and
 * the cheap paths act on the answer for free: the reply keeps the picture it
 * carried, or swaps to the one its place already owns. Only a genuinely new
 * place pays for the watcher and an image, and those run at the user's
 * "Background generation pace"; a story without tags gets the plain-prose
 * watcher at the same pace. The brush button draws fresh outright. The
 * result is stamped on the reply itself (`extra.meziverse.bg`), so scrolling
 * back through the chat brings each reply's own picture back, and a run that
 * lands late still resolves - and stamps - its own reply, never the chat's
 * end.
 *
 * The pure parts (stamps, deciding, asking, parsing) live in backgrounds.js
 * and the SillyTavern calls in st.js; this file is the choreography between
 * them. The watcher's LLM call rides its own door (connections.js - the
 * Background Agent on the Connections tab). Jobs run one at a time in order, a newer job for the same reply
 * replaces the older one, and a chat change cancels everything. Failures come
 * back as statuses the UI may show; success is quiet apart from the stage
 * notices.
 */

import {
    aliasLocation,
    brushTargetIndex,
    buildTransportRequest,
    buildWatcherRequest,
    collapseTransports,
    compileBgPrompt,
    decide,
    decideTransport,
    fallbackLocationPrompt,
    fallbackTransportPrompt,
    locationKey,
    noteBaseline,
    parseWatcherReply,
    placeNamesLikelySame,
    placeShortName,
    planResolution,
    pruneStore,
    recoverCurrentKey,
    reconcileRecordPlace,
    resolveRecordId,
    resolveStampId,
    resolveStampRecord,
    restorePlan,
    setStamp,
    stampOf,
    storeRecord,
    parkTransport,
    transportOf,
    LANDSCAPE_SIZE,
} from './backgrounds.js';
import {
    bgStore,
    chatMessages,
    customBackground,
    currentChatId,
    errorText,
    forceSetBackground,
    imagine,
    imageGenerationStatus,
    on,
    personaName,
    restoreBackground,
    saveChatMetadata,
    shownBackground,
    stampMessageBg,
    unlockBackground,
} from './st.js';
import { bgAutoOn, bgImagesOn, settings } from './settings.js';
import { generateOn } from './connections.js';
import { resolveScene } from './scene.js';

const LOG = '[Meziverse] bg';

// The master switch: the scene being open. Everything the chain does - every
// watcher call, every draw, every metadata write - stays inside the extension
// and only runs while the UI is on; closed or never opened, it sits idle. The
// scene hands the gate in at init; the default is off.
let uiIsOpen = () => false;

// A reply without a scene tag says so once per chat - the plain-prose
// fallback still takes it, so the notice is a flag, not an alarm.
let noTagNoticed = false;

let chainSeq = 0;
let chainAbort = null;
let running = null;
let queue = [];
let repliesSinceWatch = 0;
let shownIndex = null;
let lastRequest = null;

/**
 * The exact question the watcher was last asked - system prompt and assembled
 * story blocks - for the settings panel that lets the prompts be tuned.
 */
export function getLastWatcherRequest() {
    return lastRequest;
}

/**
 * The turn on screen, from the transcript. Null while the scene is not
 * showing a turn (closed, or freshly opened): the chain then follows the
 * chat's end, because the background belongs to the chat even with no scene
 * open.
 */
export function setShownTurn(index) {
    shownIndex = Number.isInteger(index) ? index : null;
}

/** The index whose picture the screen should show right now. */
function shownTarget() {
    if (Number.isInteger(shownIndex)) return shownIndex;
    return Math.max(0, chatMessages().length - 1);
}

/**
 * A stage notice the chain holds while it works and drops when the stage
 * ends. It goes through toastr, so the scene shows it as a Meziverse notice
 * while open and SillyTavern shows its own toast when the scene is closed.
 */
function stage(message) {
    const handle = globalThis.toastr?.info?.(message, '', { timeOut: 0 });
    return () => {
        if (typeof handle?.dismiss === 'function') handle.dismiss();
        else if (handle) globalThis.toastr?.clear?.(handle);
    };
}

/**
 * Stops whatever the chain is doing now. Anything already in flight becomes
 * stale and its result is discarded, never applied; queued work is dropped.
 */
export function cancelBackgroundWork() {
    chainSeq += 1;
    for (const job of queue.splice(0)) job.resolve({ status: 'superseded' });
    if (chainAbort) {
        chainAbort.abort();
        chainAbort = null;
    }
}

/** Forgets the generation pace, e.g. when a chat changes. */
export function resetBackgroundPacing() {
    repliesSinceWatch = 0;
}

/**
 * Wires the chain to the story: every finished reply resolves the reply
 * itself, edits re-resolve the edited reply, and a chat change cancels
 * whatever was in flight and re-derives the current picture from the
 * background SillyTavern itself restored. Swipes and openings draw nothing -
 * the watcher is for new turns. The master switch gates it all: the chain
 * follows the chat only while the scene is open - closed or never opened,
 * every handler here and `requestBackground` itself return without a single
 * call, write or fetch.
 *
 * @param {{isOpen?:() => boolean}} [parts] the scene's open-state gate
 */
export function initBackgrounds({ isOpen } = {}) {
    if (typeof isOpen === 'function') uiIsOpen = isOpen;

    on('CHAT_CHANGED', () => {
        noTagNoticed = false;
        if (!uiIsOpen()) {
            // Off means off in every chat: the chat being entered is handed
            // back the same way exiting does.
            standDown();
            return;
        }
        cancelBackgroundWork();
        resetBackgroundPacing();
        setShownTurn(null);
        // The parking lot folds legacy per-chain interiors to one per
        // vehicle before anything reads them.
        if (collapseTransports(bgStore(), chatMessages())) saveChatMetadata();
        recoverCurrentKey(bgStore(), customBackground());
    });

    const refreshed = () => {
        if (!uiIsOpen()) return;
        requestBackground({ index: lastMessageIndex(), refresh: true }).catch?.(error => {
            console.warn(`${LOG} chain failed`, error);
        });
    };

    on('GENERATION_ENDED', refreshed);
    on('GENERATION_STOPPED', refreshed);
    on('GROUP_WRAPPER_FINISHED', refreshed);

    on('MESSAGE_EDITED', mesId => {
        if (!uiIsOpen()) return;
        const index = Number(mesId);

        // A re-spelled location keeps its picture: the record the reply
        // points at is renamed and re-keyed to the edited name, so the scene
        // tag and the library never drift apart. A reply whose place really
        // changed (another spot entirely) falls through to the ordinary
        // re-resolution below - its old picture does not fit the new place.
        const messages = chatMessages();
        const message = messages[index];
        if (message && !message.is_user) {
            const own = stampOf(message, Number(message.swipe_id ?? 0));
            const place = resolveScene(messages, index, { persona: personaName() })?.scene?.placeFull || '';
            const record = own ? bgStore().records?.[own] : null;
            if (record && place && placeNamesLikelySame(place, record.place)) {
                reconcileRecordPlace(bgStore(), own, place);
                saveChatMetadata();
                void syncShownBackground();
                return;
            }
        }

        requestBackground({ index, refresh: true }).catch?.(error => {
            console.warn(`${LOG} chain failed`, error);
        });
    });

    on('MESSAGE_SWIPED', mesId => {
        if (!uiIsOpen()) return;
        // Swiping draws nothing: a variant this chat has already resolved
        // brings its own picture back through the shown-turn swap, and an
        // unseen one keeps the picture it swiped from. A genuinely new place
        // on a swipe wants the brush - the watcher is for new turns.
        const index = Number(mesId);
        const message = chatMessages()[index];
        if (!message) return;
        void syncShownBackground();
    });
}

/**
 * The scene opened: the master switch turns on. Whatever happened while it was
 * closed is caught up - the metadata re-derived from what SillyTavern shows,
 * the shown turn's own picture re-asserted (swap-only, free). Nothing is
 * asked or drawn: the watcher comes for new turns only, and a chat whose
 * opening wants a picture presses the brush.
 */
export async function uiOpened() {
    cancelBackgroundWork();
    resetBackgroundPacing();
    if (collapseTransports(bgStore(), chatMessages())) saveChatMetadata();
    recoverCurrentKey(bgStore(), customBackground());

    try {
        await syncShownBackground();
    } catch (error) {
        console.warn(`${LOG} chain failed`, error);
    }
}

/**
 * The scene closed: the master switch turns off. Anything in flight dies, the
 * pace clock resets, and the chat's background is handed back to what the
 * chain found before it took over - the recorded baseline, or SillyTavern's
 * own unlock for a chat drawn before the baseline existed. A background the
 * user took back while we ran (unlocked, or locked their own) is theirs: it
 * stays.
 */
export function uiClosed() {
    cancelBackgroundWork();
    resetBackgroundPacing();
    standDown();
}

/**
 * Hands the current chat's background back to its pre-chain state - what
 * exiting runs, and what a chat change runs while the scene is closed, so no
 * chat ever shows a Meziverse picture with the extension off.
 */
function standDown() {
    const plan = restorePlan(bgStore(), customBackground());
    if (plan.action === 'restore') restoreBackground(plan.baseline);
    else if (plan.action === 'unlock') unlockBackground();

    recoverCurrentKey(bgStore(), customBackground());
}

/** The last message's index, or -1 in an empty chat. */
function lastMessageIndex() {
    return chatMessages().length - 1;
}

/**
 * The brush button: a fresh image for the place the shown turn carries. The
 * response it was clicked on keeps the new image (the place's record is
 * redrawn in place, so the retry cleans the place up everywhere it recurs).
 * The shown turn arrives from the pane at click time - `at` - so no stale
 * reading of "shown" can ever send the brush to the chat's end; only a click
 * with no shown turn at all falls back to one.
 *
 * @param {number|null} [at] the shown turn's index, straight from the pane
 * @returns {Promise<{status:string, record?:object, error?:string}>}
 */
export async function forceBackground(at = null) {
    const messages = chatMessages();
    if (!currentChatId() || !messages.length) {
        return { status: 'unavailable', error: 'Open a chat first.' };
    }

    const index = brushTargetIndex(messages, Number.isInteger(at) ? at : shownTarget());
    const swipeId = Number(messages[index]?.swipe_id ?? 0);
    return requestBackground({ index, swipeId, force: true });
}

/**
 * The branch button's cleanup: the branched chat keeps only the library its
 * own messages refer to - the pictures that rode along from the parent but
 * belong to replies the branch never had leave the library (their image
 * files stay in SillyTavern's shared gallery). Ids are never recycled.
 */
export function pruneBranch() {
    const store = bgStore();
    if (pruneStore(store, chatMessages())) saveChatMetadata();
}

/**
 * Queues one reply's resolution and returns how it ended. Work runs one job
 * at a time in order - an image in flight is never doubled - and a newer job
 * for the same reply replaces the older one, since its inputs are the fresh
 * ones. Without `force` nothing moves while the auto follow is off; nothing
 * moves at all while the scene is closed.
 *
 * @param {{index:number, swipeId?:number, force?:boolean, refresh?:boolean}} job
 * @returns {Promise<{status:'off'|'unchanged'|'cached'|'generated'|'superseded'|'cancelled'|'unavailable'|'error', record?:object, error?:string}>}
 */
function requestBackground({ index, swipeId, force = false, refresh = false }) {
    // Belt on the suspenders: every caller checks the master switch, and so
    // does the one door in - nothing queues while the scene is closed.
    if (!uiIsOpen()) return Promise.resolve({ status: 'off' });

    // The background master switch: generation off means no watcher ever -
    // the brush included. The stage shows whatever the chat holds or
    // SillyTavern's own background, and the weather plays on.
    if (!bgImagesOn()) return Promise.resolve({ status: 'off' });

    const targetIndex = Number.isInteger(index) ? index : lastMessageIndex();
    const fromMessage = Number(chatMessages()[targetIndex]?.swipe_id ?? 0) || 0;
    const target = {
        index: targetIndex,
        swipeId: swipeId === undefined || swipeId === null ? fromMessage : (Number(swipeId) || 0),
    };

    if (!force && !bgAutoOn()) return Promise.resolve({ status: 'off' });

    const wanted = (force ? 2 : 0) + (refresh ? 1 : 0);

    if (running && !running.stale && running.index === target.index && running.swipeId === target.swipeId) {
        if (strength(running) >= wanted) return running.promise;
        // Its inputs are stale now: drop it and let the fresh job stand in
        // line. Marked so a third request merges into the queued job instead
        // of trusting a dying one.
        running.stale = true;
        cancelRunning();
    }

    const queued = queue.find(job => job.index === target.index && job.swipeId === target.swipeId);
    if (queued) {
        queued.force = queued.force || force;
        queued.refresh = queued.refresh || refresh;
        return queued.promise;
    }

    let resolve;
    const promise = new Promise(done => { resolve = done; });
    queue.push({ ...target, force, refresh, resolve, promise });
    pump();
    return promise;
}

/** How strongly a job wants to run: forcing beats re-resolving beats arriving. */
function strength(job) {
    return (job.force ? 2 : 0) + (job.refresh ? 1 : 0);
}

/** Drops the running job: its result is stale the moment it lands. */
function cancelRunning() {
    chainSeq += 1;
    if (chainAbort) {
        chainAbort.abort();
        chainAbort = null;
    }
}

async function pump() {
    if (running || !queue.length) return;

    const job = queue.shift();
    running = job;
    chainAbort = new AbortController();
    const my = ++chainSeq;

    try {
        job.resolve(await runTarget({ ...job, my, signal: chainAbort.signal }));
    } catch (error) {
        console.warn(`${LOG} chain failed`, error);
        job.resolve({ status: 'error', error: errorText(error) });
    } finally {
        chainAbort = null;
        running = null;
        pump();
    }
}

/**
 * Resolves one reply: the cheap paths first (the reply already carries the
 * right picture, or its place is cached), the watcher and the image only for
 * places this chat has not drawn - and even those at the user's pace.
 */
async function runTarget({ index, swipeId, force, refresh, my, signal }) {
    const messages = chatMessages();
    const message = messages[index];
    if (!message) return { status: 'unchanged' };

    // User turns own no picture: they inherit the previous reply's at read
    // time, and nothing is ever stamped on them.
    if (message.is_user) return { status: 'unchanged' };

    const store = bgStore();
    const persona = personaName();

    // What the reply carried in: its own stamp when re-resolving (an edit or
    // the brush), else the picture the story brought to it - which is how a
    // reply that drew nothing keeps the last picture.
    const own = stampOf(message, swipeId);
    if (own && !force && !refresh) {
        return { status: 'unchanged', record: store.records[own] || undefined };
    }

    // Where this reply is: the scene governing ITS turn (the last usable one
    // at or before it), never the chat's end. Any preset can carry the tag -
    // without one the reply falls to the plain-prose watcher below. A ride
    // (En Route in the chain) is decided differently: the vehicle's parked
    // interior answers it, by code, and the watcher is never asked whether a
    // ride changed.
    const scene = resolveScene(messages, index, { persona })?.scene || null;
    const place = scene?.placeFull || '';
    const ride = scene ? transportOf(place) : null;

    const carried = own ?? resolveStampId(messages, index)?.id ?? null;
    const baseline = (carried && store.records[carried]) || null;

    // A tag names the place outright, so `decide` answers it for free; an
    // untagged reply has no such answer and only the watcher can say.
    if (!scene && !force && !noTagNoticed) {
        // The edge case, said out loud once per chat: the plain-prose
        // fallback still resolves this reply below.
        noTagNoticed = true;
        console.warn(`${LOG} reply ${index} carries no scene tag; the plain-prose fallback takes it`);
        globalThis.toastr?.warning?.('A reply carried no scene tag \u2014 the plain-prose fallback is handling it.', '', { timeOut: 6000 });
    }
    const step = !force && scene
        ? (ride ? decideTransport(store, ride.vehicle, { baseline }) : decide(store, place, { baseline }))
        : null;

    const plan = planResolution({ step, force, counter: repliesSinceWatch, every: settings().bgEveryN });
    repliesSinceWatch = plan.counter;

    if (plan.go === 'unchanged') {
        stampLanded(index, swipeId, plan.record?.id ?? baseline?.id);
        return { status: 'unchanged', record: plan.record || baseline || undefined };
    }

    if (plan.go === 'cached') {
        if (my !== chainSeq) return { status: 'superseded' };
        stampLanded(index, swipeId, plan.record.id);
        return { status: 'cached', record: plan.record };
    }

    if (plan.go === 'keep') {
        // The pace is not due yet: the reply keeps the picture it carried -
        // what slowing the draws down gives up.
        stampLanded(index, swipeId, baseline?.id);
        return { status: 'unchanged', record: baseline || undefined };
    }

    if (ride) {
        return runTransportChain({ store, messages, index, swipeId, ride, scene, baseline, persona, force, my, signal });
    }
    return runWatcherChain({ store, messages, index, swipeId, place, scene, tagged: !!scene, baseline, persona, force, my, signal });
}

/**
 * Asks the watcher about the reply's own story, then acts on the answer:
 * "same" folds the spelling onto the picture the reply carried, "known"
 * brings back a cached image, "new" draws one.
 */
async function runWatcherChain({ store, messages, index, swipeId, place, scene, tagged, baseline, persona, force, my, signal }) {
    const request = buildWatcherRequest({
        store,
        messages,
        tagged,
        at: index,
        persona,
        force,
        systemCore: tagged ? settings().bgPromptOn : settings().bgPromptOff,
        current: baseline,
    });
    lastRequest = { systemPrompt: request.systemPrompt, prompt: request.prompt, at: Date.now() };

    console.debug(`${LOG} asking the watcher`, { index, place, force });

    const plain = () => fallbackLocationPrompt(scene || place);
    const thinking = stage('Envisioning the location\u2026');
    let answer = null;
    let failure = null;
    try {
        // The one ride: the Background Agent's own connection (whatever the
        // Connections tab has chosen), the same `{ok, text, error}` back
        // whatever the door. No jsonSchema: some connections reject
        // structured output outright (422 Unprocessable Entity), and nothing
        // here needs it - parseWatcherReply reads the JSON out of the answer
        // text, plain-text protocol tolerated, same as the music DJ.
        const reply = await generateOn('backgroundAgent', {
            prompt: request.prompt,
            systemPrompt: request.systemPrompt,
        });

        if (my !== chainSeq) return { status: 'superseded' };

        answer = reply.ok ? parseWatcherReply(reply.text) : null;
        if (!answer) {
            // The watcher failed. A tagged reply still knows its place from
            // the tags and draws from the template; without tags there is
            // nothing to fall back on.
            if (!place) {
                failure = reply.error || 'The watcher call failed.';
            } else {
                answer = { state: 'new', knownId: null, place, prompt: plain() };
            }
        }

        // The brush must draw something, and "same" with nothing carried in
        // has nothing to keep - both draw fresh.
        if (answer && (force || (answer.state === 'same' && !baseline)) && answer.state !== 'new') {
            answer = {
                state: 'new',
                knownId: null,
                place: answer.place || place,
                prompt: answer.prompt || plain(),
            };
        }
    } finally {
        thinking();
    }

    if (failure) return { status: 'error', error: failure };

    console.debug(`${LOG} watcher answered`, answer);

    // The tag knows the place; the plain-prose hand leans on the watcher's
    // own naming, and only a nameless answer falls back to its first phrase.
    const target = place || answer.place || firstPhrase(answer.prompt) || 'the story';

    // A "same" or "known" claims the place being drawn is the named record's
    // place under another spelling. The claim is checked before anything
    // folds: a careless answer must never merge two different spots onto one
    // picture - the fold would stick in the keys map and one brush would then
    // repaint both places at once. A rejected claim draws fresh, from the
    // watcher's own description when it wrote one.
    if (answer.state === 'same' && !placeNamesLikelySame(target, baseline?.place || '')) {
        answer = { state: 'new', knownId: null, place: answer.place || place, prompt: answer.prompt || plain() };
    } else if (answer.state === 'known') {
        const claimed = resolveRecordId(store, answer.knownId);
        const claimedRecord = claimed ? store.records[claimed] : null;
        if (!claimedRecord || !placeNamesLikelySame(target, claimedRecord.place)) {
            answer = { state: 'new', knownId: null, place: answer.place || place, prompt: answer.prompt || plain() };
        }
    }

    if (answer.state === 'same') {
        // The same place, spelled differently: fold the spelling onto the
        // picture the reply carried, so the next skip-gate compares equal.
        if (target && baseline) aliasLocation(store, target, baseline.id);
        stampLanded(index, swipeId, baseline?.id);
        return { status: 'unchanged', record: baseline || undefined };
    }

    if (answer.state === 'known') {
        const id = resolveRecordId(store, answer.knownId);
        const record = id ? aliasLocation(store, target || store.records[id].place, id) : null;
        if (record) {
            stampLanded(index, swipeId, record.id);
            globalThis.toastr?.success?.(`Background set: ${placeShortName(record.place)}`);
            return { status: 'cached', record };
        }
        // A stale id (hand-edited or pruned chat data): draw fresh instead,
        // from the watcher's own description when it wrote one.
    }

    return generateBackground({
        store,
        index,
        swipeId,
        place: target,
        description: answer.prompt || plain(),
        force,
        my,
        signal,
    });
}

/**
 * The ride's watcher: asked only about vehicles the parking lot has never
 * seen (or a spelling drift it must recognise) - a parked vehicle answers
 * without a call at all. The lot is the only menu, "known" parks the
 * variant's name onto the interior it matched, "new" draws the interior once
 * and parks it, and "same" is never trusted: a reply boarding from a
 * location must never inherit the place it left.
 */
async function runTransportChain({ store, messages, index, swipeId, ride, scene, baseline, persona, force, my, signal }) {
    const request = buildTransportRequest({
        store,
        messages,
        at: index,
        persona,
        vehicle: ride.vehicle,
        place: scene?.placeFull || '',
        force,
        systemCore: settings().bgPromptTransport,
    });
    lastRequest = { systemPrompt: request.systemPrompt, prompt: request.prompt, at: Date.now() };

    const plain = () => fallbackTransportPrompt(scene || ride.vehicle);
    const thinking = stage(`Envisioning ${placeShortName(ride.vehicle)}\u2026`);
    let answer = null;
    let failure = null;
    try {
        const reply = await generateOn('backgroundAgent', {
            prompt: request.prompt,
            systemPrompt: request.systemPrompt,
        });

        if (my !== chainSeq) return { status: 'superseded' };

        answer = reply.ok ? parseWatcherReply(reply.text) : null;
        if (!answer) {
            failure = reply.error || 'The watcher call failed.';
        } else if (answer.state === 'same' || (force && answer.state !== 'new')) {
            // Identity of a ride is decided here, never by "same" - a reply
            // boarding from a location must never inherit the place it left -
            // and the brush must paint whatever the watcher matches.
            answer = { state: 'new', knownId: null, place: answer.place || ride.vehicle, prompt: answer.prompt || plain() };
        } else if (answer.state === 'known') {
            const id = resolveRecordId(store, answer.knownId);
            const record = id ? store.records[id] : null;
            if (!record || !record.vehicle || !placeNamesLikelySame(ride.vehicle, record.vehicle)) {
                // A stale id, or a location misread as a ride: the interior
                // draws instead, from the watcher's own description.
                answer = { state: 'new', knownId: null, place: answer.place || ride.vehicle, prompt: answer.prompt || plain() };
            }
        }
    } finally {
        thinking();
    }

    if (failure) return { status: 'error', error: failure };
    if (my !== chainSeq) return { status: 'superseded' };

    if (answer.state === 'known') {
        const id = resolveRecordId(store, answer.knownId);
        const record = store.records[id];
        // The spelling drift parks the variant's name onto the interior it
        // matched - the same record under one more name - so the next ride
        // needs no call at all.
        const variantKey = locationKey(ride.vehicle);
        if (variantKey) store.transports[variantKey] = record.id;
        stampLanded(index, swipeId, record.id);
        globalThis.toastr?.success?.(`Background set: ${placeShortName(record.place)}`);
        return { status: 'cached', record };
    }

    return generateBackground({
        store,
        index,
        swipeId,
        place: scene?.placeFull || ride.vehicle,
        description: answer.prompt || plain(),
        force,
        my,
        signal,
        ride,
    });
}

/** Draws one image for a reply's place - or its ride's interior - and makes it that reply's picture. */
async function generateBackground({ store, index, swipeId, place, description, force, my, signal, ride = null }) {
    const ready = imageGenerationStatus();
    if (!ready.ok) return { status: 'unavailable', error: ready.text };

    const { bgStyle, bgNegative, bgSize } = settings();
    const clean = String(description ?? '').trim();
    const prompt = compileBgPrompt(clean, bgStyle);
    const size = bgSize === 'landscape' ? LANDSCAPE_SIZE : null;

    console.debug(`${LOG} drawing`, { place, prompt });

    const painting = stage(ride
        ? `Painting ${placeShortName(ride.vehicle)} interior\u2026`
        : place ? `Painting ${placeShortName(place)}\u2026` : 'Painting the location\u2026');
    let result;
    try {
        result = await imagine({
            prompt,
            negative: bgNegative,
            width: size?.width,
            height: size?.height,
            signal,
        });
    } finally {
        painting();
    }

    if (!result.ok) return { status: result.aborted ? 'cancelled' : 'error', error: result.error };
    if (my !== chainSeq) return { status: 'superseded' };

    // `overwrite` is the brush's "replace it" - the place has one canonical
    // record and the retry redraws it everywhere it recurs, newest wins. The
    // record keeps the description WITHOUT the style suffix: the style rides
    // in at draw time, so the library reads clean. When the place's old
    // record was a fold (shared with other places) the fresh picture takes a
    // record of its own and this place's replies follow it. A ride parks in
    // the lot instead: one record per vehicle, replaced IN PLACE, so every
    // ride of that vehicle repaints together.
    if (ride) {
        const record = parkTransport(store, {
            vehicle: ride.vehicle,
            place,
            prompt: clean,
            path: result.path,
            overwrite: true,
        });
        if (!record) return { status: 'error', error: 'The background could not be remembered.' };

        stampLanded(index, swipeId, record.id);
        console.debug(`${LOG} interior parked`, { vehicle: ride.vehicle, path: result.path });
        globalThis.toastr?.success?.(`Background set: ${placeShortName(ride.vehicle)} interior`);
        return { status: 'generated', record };
    }

    const key = locationKey(place);
    const priorId = store?.keys?.[key] || null;
    const record = storeRecord(store, {
        key: place,
        place,
        prompt: clean,
        path: result.path,
        overwrite: !!force,
    });
    if (!record) return { status: 'error', error: 'The background could not be remembered.' };
    if (priorId && priorId !== record.id) retargetStamps(priorId, record, key);

    stampLanded(index, swipeId, record.id);
    console.debug(`${LOG} background set`, { place, path: result.path });
    globalThis.toastr?.success?.(place ? `Background set: ${placeShortName(place)}` : 'Background set');

    return { status: 'generated', record };
}

/**
 * The fresh picture's half of the fold healing: every reply of THIS place
 * still pointing at the displaced record follows the fresh picture - replies
 * of other places keep the record they knew, folds dying one brush at a time.
 */
function retargetStamps(priorId, record, key) {
    const messages = chatMessages();
    const persona = personaName();

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || message.is_user) continue;
        if (locationKey(resolveScene(messages, index, { persona })?.scene?.placeFull || '') !== key) continue;

        const variants = Math.max(1, Array.isArray(message.swipe_info) ? message.swipe_info.length : 1);
        for (let swipeId = 0; swipeId < variants; swipeId += 1) {
            if (stampOf(message, swipeId) === priorId) setStamp(message, swipeId, record.id);
        }
    }

    saveChatMetadata();
}

/**
 * The landing of every result: the reply keeps its picture, the chat is
 * saved, and the screen is re-asserted to the SHOWN turn - so a chain landing
 * late updates its own reply's history and never yanks the picture out from
 * under whatever turn is being read.
 */
function stampLanded(index, swipeId, recordId) {
    if (recordId) stampMessageBg(index, swipeId, recordId);
    saveChatMetadata();
    void syncShownBackground();
}

/**
 * Puts the background the shown turn carries back on screen - the read path
 * for scrolling through the chat, and the settling point for every landing.
 * Swap-only: nothing is asked or drawn while reading. Chats without history
 * fall back to the cached picture of the shown place; a user turn inherits the
 * nearest reply's picture before it.
 *
 * @returns {Promise<{status:'cached'|'unchanged', record?:object}>}
 */
export async function syncShownBackground() {
    const messages = chatMessages();
    const store = bgStore();
    const index = shownTarget();

    const record = resolveStampRecord(store, messages, index);
    if (record) {
        await showRecord(store, record);
        return { status: 'cached', record };
    }

    // No history at or before here: the cached picture of the shown place -
    // or the shown ride's parked interior - is the best guess, still never a
    // generation.
    const scene = resolveScene(messages, index, { persona: personaName() })?.scene || null;
    const place = scene?.placeFull || '';
    const ride = scene ? transportOf(place) : null;
    const step = ride ? decideTransport(store, ride.vehicle, { baseline: null }) : decide(store, place, { baseline: null });
    if (step.action === 'apply' && step.record) {
        await showRecord(store, step.record);
        return { status: 'cached', record: step.record };
    }

    return { status: 'unchanged' };
}

/**
 * Shows a record's image as the chat background and marks its place current.
 * Idempotent - the same picture is never re-set - and a failed set stays
 * retryable, because the stamp still holds the record.
 */
async function showRecord(store, record) {
    // The takeover moment - the last look at what was on screen before the
    // chain's first write - so exiting can hand it back.
    noteBaseline(store, { lock: customBackground(), shown: shownBackground() });

    await forceSetBackground(record.path);

    // currentKey follows the screen; normalizeStore prunes keys not in the
    // map, so pick one this record is actually registered under.
    const key = Object.entries(store.keys || {}).find(([, id]) => id === record.id)?.[0];
    if (key && store.currentKey !== key) {
        store.currentKey = key;
        saveChatMetadata();
    }
}

/** A place name for an answer that named none: its description's first phrase. */
function firstPhrase(description) {
    const text = String(description ?? '').trim();
    if (!text) return '';
    const cut = text.split(/[.,;]/)[0].trim();
    return cut.length > 60 ? `${cut.slice(0, 57).trim()}...` : cut;
}
