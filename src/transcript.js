/**
 * The reading pane and the log drawer.
 *
 * The pane shows one message at a time: the latest by default, or whichever
 * message was picked from the log, and it can step back and forward through the
 * chat one answer at a time. Everything is read from SillyTavern's chat on
 * demand; nothing is copied or stored, so swipes, edits, deletes and chat
 * switches are correct the moment SillyTavern reports them.
 */

import { chatMessages, ctx, currentChatId, on } from './st.js';
import { renderInto, toHtml } from './prose.js';
import { icon } from './icons.js';

const FOLLOW = null;

/** System notes are not part of the scene. */
function visible(message) {
    return !!message && !message.is_system;
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
 */
export function createTranscript({
    frame, isOpen, speaker, meta, prose, logPanel, logList, logButton, logClose,
    prevButton, nextButton, latestButton,
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

        prose.scrollTop = stick ? prose.scrollHeight : 0;
        updateControls();
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
            branch.disabled = true;
            branch.title = 'Branching arrives with the pane\u2019s Branch button';
            branch.setAttribute('aria-label', `Branch from ${speakerOf(message)}, turn ${at + 1} (coming soon)`);
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

    /* ---------- wiring ---------- */

    logList.addEventListener('click', event => {
        // a link in the prose is a link, not a jump
        if (event.target.closest('a')) return;

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

    return { refresh, openLog, closeLog, isLogOpen, step, latest, show };
}
