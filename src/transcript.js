/**
 * The reading pane and the log drawer.
 *
 * The pane shows one message at a time: the latest by default, or whichever
 * message was picked from the log, and it can step back and forward through the
 * chat one answer at a time. Everything is read from SillyTavern's chat on
 * demand; nothing is copied or stored, so swipes, edits, deletes and chat
 * switches are correct the moment SillyTavern reports them.
 */

import { branchChat, chatMessages, checkpointChat, copyMessage, ctx, currentChatId, on, setPromptHidden, swipeMessage, swipeSupported, swipingAllowed } from './st.js';
import { renderInto, toHtml } from './prose.js';
import { icon } from './icons.js';

const FOLLOW = null;

/** Small system events — commentaries and the like — are not part of the scene. */
function visible(message) {
    return !!message && !message.extra?.isSmallSys;
}

function speakerOf(message) {
    if (message.is_user) return ctx()?.name1 || 'You';
    return message.name || ctx()?.name2 || 'Narrator';
}

/**
 * @param {object} parts
 * @param {HTMLElement} parts.frame
 * @param {() => boolean} parts.isOpen
 * @param {HTMLElement} parts.speaker
 * @param {HTMLElement} parts.meta
 * @param {HTMLElement} parts.prose
 * @param {HTMLElement} parts.logPanel
 * @param {HTMLElement} parts.logList
 * @param {HTMLElement} parts.logButton
 * @param {HTMLElement} parts.logClose
 * @param {HTMLButtonElement} [parts.prevButton]
 * @param {HTMLButtonElement} [parts.nextButton]
 * @param {HTMLButtonElement} [parts.latestButton]
 * @param {HTMLButtonElement} [parts.branchButton] any turn, the latest one included
 * @param {HTMLButtonElement} [parts.copyButton] copies the shown turn
 * @param {HTMLButtonElement} [parts.checkpointButton] checkpoints the chat at the shown turn
 * @param {HTMLButtonElement} [parts.togglePromptButton] excludes the shown turn from prompts, or includes it again
 * @param {HTMLElement} [parts.swipeBar] the swipe footer, the chat's last character turn only
 * @param {HTMLButtonElement} [parts.swipePrev]
 * @param {HTMLButtonElement} [parts.swipeNext]
 * @param {HTMLElement} [parts.swipeCount]
 */
export function createTranscript({
    frame, isOpen, speaker, meta, prose, logPanel, logList, logButton, logClose,
    prevButton, nextButton, latestButton, branchButton,
    copyButton, checkpointButton, togglePromptButton,
    swipeBar, swipePrev, swipeNext, swipeCount,
}) {
    // null follows the newest message; a number pins that index in the chat.
    let selected = FOLLOW;
    let shown = [];
    let chatId = currentChatId();
    let logDirty = true;
    let queued = false;

    function currentEntry() {
        if (!shown.length) return null;
        if (selected === FOLLOW) return shown[shown.length - 1];
        return shown.find(entry => entry.index === selected) ?? shown[shown.length - 1];
    }

    function position() {
        const entry = currentEntry();
        return entry ? shown.indexOf(entry) : -1;
    }

    function fillProse(element, message, index, { waiting = false } = {}) {
        const html = toHtml(message, index);
        if (html) {
            renderInto(element, html);
            return;
        }

        const empty = document.createElement('p');
        empty.className = waiting ? 'mz-prose-wait' : 'mz-prose-empty';
        empty.textContent = waiting
            ? '\u2026'
            : (message ? 'This message has no text.' : 'The scene begins when you write.');
        element.replaceChildren(empty);
    }

    /** A reply that has not started streaming yet is not an empty message. */
    function isWaitingForFirstToken(entry) {
        if (!entry || entry !== shown[shown.length - 1]) return false;
        if (typeof entry.message.mes === 'string' && entry.message.mes.trim()) return false;
        return frame.classList.contains('is-generating');
    }

    function updateControls() {
        const at = position();
        const last = shown.length - 1;
        if (prevButton) prevButton.disabled = at <= 0;
        if (nextButton) nextButton.disabled = at < 0 || at >= last;
        if (latestButton) latestButton.disabled = selected === FOLLOW || at < 0;

        // the eye mirrors the shown turn's prompt state
        const hidden = !!currentEntry()?.message?.is_system;
        if (togglePromptButton) {
            togglePromptButton.title = hidden
                ? 'Include message in prompts' : 'Exclude message from prompts';
            togglePromptButton.setAttribute('aria-label', togglePromptButton.title);
            togglePromptButton.replaceChildren(icon(hidden ? 'mz-i-eye-off' : 'mz-i-eye'));
        }
    }

    /**
     * The swipe footer follows SillyTavern's own chevrons: it belongs to the
     * chat's last message when that message is the character's, and only
     * while SillyTavern allows swiping at all. Past the last swipe the right
     * chevron makes SillyTavern write a new reply; nothing here switches or
     * saves by itself.
     */
    function updateSwipeBar(entry) {
        if (!swipeBar) return;

        const message = entry?.message;
        const lastTurn = !!message && entry.index === chatMessages().length - 1;
        const characterTurn = lastTurn
            && !message.is_user
            && !message.extra?.isSmallSys
            && message.extra?.swipeable !== false;
        const open = characterTurn
            && !frame.classList.contains('is-generating')
            && swipeSupported()
            && swipingAllowed();

        swipeBar.hidden = !open;
        if (!open) return;

        const count = Array.isArray(message.swipes) && message.swipes.length > 0
            ? message.swipes.length : 1;
        const at = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;

        if (swipeCount) {
            swipeCount.textContent = `${at + 1}/${count}`;
            swipeCount.setAttribute('aria-label', `Swipe ${at + 1} of ${count}`);
        }
        if (swipePrev) swipePrev.hidden = count <= 1;
    }

    function drawPane({ stick = false } = {}) {
        const entry = currentEntry();

        if (!entry) {
            speaker.textContent = '';
            meta.textContent = '';
            fillProse(prose, null, -1);
        } else {
            speaker.textContent = speakerOf(entry.message);
            meta.textContent = `turn ${position() + 1} of ${shown.length}`;
            fillProse(prose, entry.message, entry.index, { waiting: isWaitingForFirstToken(entry) });
        }

        // a turn excluded from the prompts stays, dimmed, like ST's ghost
        prose.classList.toggle('is-prompt-hidden', !!entry?.message?.is_system);

        prose.scrollTop = stick ? prose.scrollHeight : 0;
        updateControls();
        updateSwipeBar(entry);
    }

    /** Rebuilds the log list, every message in full, and marks the one being read. */
    function renderLog() {
        const scroll = logList.scrollTop;
        logDirty = false;
        logList.replaceChildren();

        if (!shown.length) {
            const empty = document.createElement('li');
            empty.className = 'mz-log-empty';
            empty.textContent = chatId ? 'Nothing has been said yet.' : 'No chat is open.';
            logList.append(empty);
            return;
        }

        const active = currentEntry();
        const fragment = document.createDocumentFragment();

        shown.forEach(({ index, message }, at) => {
            const item = document.createElement('li');
            item.className = 'mz-log-entry';
            if (message.is_user) item.classList.add('is-user');
            if (message.is_system) item.classList.add('is-prompt-hidden');
            item.dataset.mzLog = String(index);

            const head = document.createElement('header');
            head.className = 'mz-log-meta';

            const who = document.createElement('span');
            who.className = 'mz-log-who';
            who.textContent = speakerOf(message);

            const turn = document.createElement('span');
            turn.className = 'mz-log-turn';
            turn.textContent = `turn ${at + 1}`;

            const jump = document.createElement('button');
            jump.type = 'button';
            jump.className = 'mz-log-jump';
            jump.dataset.mzLog = String(index);
            jump.textContent = 'Jump';
            jump.setAttribute('aria-label', `Jump to ${speakerOf(message)}, turn ${at + 1}`);

            const branch = document.createElement('button');
            branch.type = 'button';
            branch.className = 'mz-log-branch';
            branch.dataset.mzBranch = String(index);
            branch.title = 'Branch from this turn';
            branch.setAttribute('aria-label', `Branch from ${speakerOf(message)}, turn ${at + 1}`);
            branch.append(icon('mz-i-branch'));

            head.append(who, turn, jump, branch);

            const body = document.createElement('div');
            body.className = 'mz-prose mz-log-prose';
            fillProse(body, message, index);

            item.append(head, body);

            if (active && active.index === index) {
                item.classList.add('is-on');
                jump.setAttribute('aria-current', 'true');
            }

            fragment.append(item);
        });

        logList.append(fragment);
        logList.scrollTop = scroll;
    }

    /** Reads the chat and draws whichever message is being shown. */
    function refresh({ followLatest = false, stick = false } = {}) {
        const nextChat = currentChatId();
        if (nextChat !== chatId || followLatest) {
            chatId = nextChat;
            selected = FOLLOW;
        }

        shown = chatMessages()
            .map((message, index) => ({ message, index }))
            .filter(entry => visible(entry.message));

        if (selected !== FOLLOW && !shown.some(entry => entry.index === selected)) {
            selected = FOLLOW;
        }

        drawPane({ stick });

        logDirty = true;
        if (isLogOpen()) renderLog();
    }

    /** Streaming sends a token per frame; redraw once per frame, not per token. */
    function queueRefresh() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            if (isOpen()) refresh({ stick: true });
        });
    }

    /* ---------- moving through the scene ---------- */

    function goTo(at) {
        if (!shown.length) return;
        const last = shown.length - 1;
        const clamped = Math.max(0, Math.min(last, at));
        selected = clamped === last ? FOLLOW : shown[clamped].index;
        refresh();
    }

    function step(direction) {
        const at = position();
        if (at < 0) return;
        goTo(at + direction);
    }

    function latest() {
        selected = FOLLOW;
        refresh();
    }

    /* ---------- the log drawer ---------- */

    function isLogOpen() {
        return frame.classList.contains('is-log-open');
    }

    function openLog() {
        if (logDirty) renderLog();
        frame.classList.add('is-log-open');
        logPanel.setAttribute('aria-hidden', 'false');
        logButton.setAttribute('aria-expanded', 'true');

        logList.querySelector('.mz-log-entry.is-on')?.scrollIntoView({ block: 'nearest' });
        logClose.focus({ preventScroll: true });
    }

    function closeLog(focus = true) {
        frame.classList.remove('is-log-open');
        logPanel.setAttribute('aria-hidden', 'true');
        logButton.setAttribute('aria-expanded', 'false');
        if (focus) logButton.focus({ preventScroll: true });
    }

    /** Jumps to a turn picked in the log, then gets the log out of the way. */
    function show(index) {
        const at = shown.findIndex(entry => entry.index === index);
        if (at >= 0) goTo(at);
        else latest();
        closeLog();
    }

    /* ---------- branching ---------- */

    /**
     * Forks the chat at a message. SillyTavern copies every message up to and
     * including that turn into a new chat file and opens it; CHAT_CHANGED
     * lands us in it. The log closes so a chat that no longer exists does not
     * linger on screen. Mid-generation the fork is refused.
     */
    async function branchFrom(index) {
        if (!Number.isInteger(index) || index < 0) return null;
        if (frame.classList.contains('is-generating')) return null;

        const name = await branchChat(index);
        if (name) closeLog(false);
        return name;
    }

    /** Branches from whichever message the pane is reading. */
    function branchHere() {
        const entry = currentEntry();
        return entry ? branchFrom(entry.index) : Promise.resolve(null);
    }

    /* ---------- message actions ---------- */

    /**
     * Copies the shown turn, through SillyTavern's own handler: it brings
     * the toast, and the clipboard.
     */
    function copyShownTurn() {
        const entry = currentEntry();
        return entry ? copyMessage(entry.index) : Promise.resolve(false);
    }

    /**
     * Checkpoints the chat at the shown turn. The chat stays open; the
     * checkpoint is linked to the message.
     */
    function checkpointShownTurn() {
        const entry = currentEntry();
        if (!entry || frame.classList.contains('is-generating')) return Promise.resolve(null);
        return checkpointChat(entry.index);
    }

    /**
     * Excludes the shown turn from the prompts, or includes it again,
     * through SillyTavern's own handler. SillyTavern reports no event for
     * this, so the pane is refreshed here: the turn dims or clears, the eye
     * flips, and the footer rethinks the last reply's overswipe.
     */
    async function togglePromptHidden() {
        const entry = currentEntry();
        if (!entry) return false;

        const hidden = await setPromptHidden(entry.index, !entry.message.is_system);
        if (hidden) refresh();
        return hidden;
    }

    /* ---------- swipes ---------- */

    /**
     * Swipes the turn being read, through SillyTavern's own engine. The pane
     * catches the new swipe on MESSAGE_SWIPED; the redraw after the await
     * brings the footer back once SillyTavern's mid-swipe state has cleared.
     */
    async function swipeShownTurn(direction) {
        const entry = currentEntry();
        if (!entry || frame.classList.contains('is-generating')) return false;

        const handed = await swipeMessage(direction, entry.index);
        if (handed) refresh();
        return handed;
    }

    /* ---------- wiring ---------- */

    logList.addEventListener('click', event => {
        // a link in the prose is a link, not a jump
        if (event.target.closest('a')) return;

        // the branch icon forks; it must not fall through to the jump
        const branch = event.target.closest('[data-mz-branch]');
        if (branch) {
            branchFrom(Number(branch.dataset.mzBranch));
            return;
        }

        const target = event.target.closest('[data-mz-log]');
        if (!target) return;
        show(Number(target.dataset.mzLog));
    });

    const events = [
        'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_CREATED', 'CHAT_DELETED', 'CHAT_RENAMED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
        'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED',
        'GENERATION_ENDED', 'GENERATION_STOPPED',
    ];

    for (const name of events) {
        on(name, () => {
            if (isOpen()) refresh();
        });
    }

    on('STREAM_TOKEN_RECEIVED', () => {
        if (isOpen()) queueRefresh();
    });

    return { refresh, openLog, closeLog, isLogOpen, step, latest, show, branchHere, swipeShownTurn, copyShownTurn, checkpointShownTurn, togglePromptHidden };
}
