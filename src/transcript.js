/**
 * The reading pane and the log drawer.
 *
 * The pane shows one message at a time: the latest by default, or whichever
 * message was picked from the log. Everything is read from SillyTavern's chat
 * on demand; nothing is copied or stored, so swipes, edits, deletes and chat
 * switches are correct the moment SillyTavern reports them.
 */

import { chatMessages, ctx, currentChatId, on } from './st.js';
import { toParagraphs, toSnippet } from './prose.js';

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
 */
export function createTranscript({ frame, isOpen, speaker, meta, prose, logPanel, logList, logButton, logClose }) {
    // null follows the newest message; a number pins that index in the chat.
    let selected = FOLLOW;
    let shown = [];
    let chatId = currentChatId();
    let logDirty = true;

    function fillProse(paragraphs, message) {
        prose.replaceChildren();

        if (!paragraphs.length) {
            const empty = document.createElement('p');
            empty.className = 'mz-prose-empty';
            empty.textContent = message ? 'This message has no text.' : 'The scene begins when you write.';
            prose.append(empty);
            return;
        }

        for (const text of paragraphs) {
            const p = document.createElement('p');
            p.textContent = text;
            prose.append(p);
        }

        prose.scrollTop = 0;
    }

    /** Rebuilds the log list and marks the message being read. */
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

        const fragment = document.createDocumentFragment();

        for (const { index, message } of shown) {
            const item = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mz-log-item';
            button.dataset.mzLog = String(index);
            button.setAttribute('aria-label', `${speakerOf(message)}, turn ${index + 1}`);

            const who = document.createElement('span');
            who.className = 'mz-log-who';
            who.textContent = speakerOf(message);

            const turn = document.createElement('span');
            turn.className = 'mz-log-turn';
            turn.textContent = String(index + 1);

            const what = document.createElement('span');
            what.className = 'mz-log-what';
            what.textContent = toSnippet(message.mes, 160) || '\u2014';

            button.append(who, turn, what);

            const isOn = selected === index || (selected === FOLLOW && index === shown[shown.length - 1].index);
            if (isOn) {
                button.classList.add('is-on');
                button.setAttribute('aria-current', 'true');
            }

            item.append(button);
            fragment.append(item);
        }

        logList.append(fragment);
        logList.scrollTop = scroll;
    }

    /** Reads the chat and draws whichever message is being shown. */
    function refresh({ followLatest = false } = {}) {
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

        const entry = selected === FOLLOW
            ? shown[shown.length - 1]
            : shown.find(item => item.index === selected);

        if (!entry) {
            speaker.textContent = '';
            meta.textContent = '';
            fillProse([], null);
        } else {
            speaker.textContent = speakerOf(entry.message);
            meta.textContent = `turn ${entry.index + 1}`;
            fillProse(toParagraphs(entry.message.mes), entry.message);
        }

        logDirty = true;
        if (isLogOpen()) renderLog();
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

        logList.querySelector('.mz-log-item.is-on')?.scrollIntoView({ block: 'nearest' });
        logClose.focus({ preventScroll: true });
    }

    function closeLog(focus = true) {
        frame.classList.remove('is-log-open');
        logPanel.setAttribute('aria-hidden', 'true');
        logButton.setAttribute('aria-expanded', 'false');
        if (focus) logButton.focus({ preventScroll: true });
    }

    function show(index) {
        if (index === shown[shown.length - 1]?.index) {
            selected = FOLLOW;
        } else {
            selected = index;
        }
        refresh();
        closeLog();
    }

    /* ---------- wiring ---------- */

    logList.addEventListener('click', event => {
        const button = event.target.closest('[data-mz-log]');
        if (!button) return;
        show(Number(button.dataset.mzLog));
    });

    const events = [
        'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_CREATED', 'CHAT_DELETED', 'CHAT_RENAMED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
        'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED',
    ];

    for (const name of events) {
        on(name, () => {
            if (isOpen()) refresh();
        });
    }

    return { refresh, openLog, closeLog, isLogOpen };
}
