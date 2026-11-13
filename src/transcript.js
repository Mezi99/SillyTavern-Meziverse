/**
 * The reading pane and the log drawer.
 *
 * The pane shows one message at a time: the latest by default, or whichever
 * message was picked from the log, and it can step back and forward through the
 * chat one answer at a time. Everything is read from SillyTavern's chat on
 * demand; nothing is copied or stored, so swipes, edits, deletes and chat
 * switches are correct the moment SillyTavern reports them.
 */

import { acceptEdit, branchChat, cancelEdit, chatMessages, copyMessage, ctx, currentChatId, deleteEditedMessage, editMessage, editorTextarea, on, personaName, setPromptHidden, swipeMessage, swipeSupported, swipingAllowed } from './st.js';
import { editSceneAttrs, sceneTagAt } from './tags.js';
import { reasoningHtml, reasoningOf, renderInto, thoughtLabel, toHtml } from './prose.js';
import { closePopover } from './cues.js';
import { resolveScene } from './scene.js';
import { reasoningOn } from './settings.js';
import { fa } from './icons.js';

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
 * @param {HTMLButtonElement} [parts.togglePromptButton] excludes the shown turn from prompts, or includes it again
 * @param {HTMLButtonElement} [parts.editButton] opens SillyTavern's editor on the shown turn
 * @param {HTMLElement} [parts.actionsRow] the message-action row, replaced by the edit bar while editing
 * @param {HTMLElement} [parts.editBar] the edit bar: accept, delete, discard
 * @param {HTMLButtonElement} [parts.reasonButton] shows the reasoning block in the pane, or hides it
 * @param {HTMLButtonElement} [parts.editAccept]
 * @param {HTMLButtonElement} [parts.editDelete]
 * @param {HTMLButtonElement} [parts.editCancel]
 * @param {HTMLTextAreaElement} [parts.edit] the pane's mirror of SillyTavern's editor textarea
 * @param {HTMLElement} [parts.swipeBar] the swipe footer, the chat's last character turn only
 * @param {HTMLButtonElement} [parts.swipePrev]
 * @param {HTMLButtonElement} [parts.swipeNext]
 * @param {HTMLElement} [parts.swipeCount]
 * @param {(state: {entry: object|null, scene: object|null}) => void} [parts.onShown] tells the chrome which turn, and which scene, is on screen
 */
export function createTranscript({
    frame, isOpen, speaker, meta, prose, logPanel, logList, logButton, logClose,
    prevButton, nextButton, latestButton, branchButton,
    copyButton, togglePromptButton, reasonButton,
    editButton, actionsRow, editBar, editAccept, editDelete, editCancel, edit,
    swipeBar, swipePrev, swipeNext, swipeCount,
    onShown,
}) {
    // null follows the newest message; a number pins that index in the chat.
    let selected = FOLLOW;
    let shown = [];
    let chatId = currentChatId();
    let logDirty = true;
    let queued = false;
    // The reasoning block's one open/closed state, shared by every turn the
    // pane draws: stepping between turns and redrawing mid-stream follow it,
    // so a block the reader opened never snaps shut on the next frame.
    let reasoningOpen = false;
    // the message index SillyTavern's editor is open on, or null
    let editingIndex = null;
    // The scene ribbon's own edit: which turn and which scene tag, and the
    // location levels being typed. It rides redraws (the ribbon is rebuilt
    // and the editor re-attaches) until it is saved or discarded.
    let sceneEdit = null;
    // While a scene save drives SillyTavern's editor, the edit watch must
    // not adopt it as a message edit of its own.
    let sceneSaving = false;
    // guard so our own textarea sync is not echoed back to SillyTavern's
    let syncing = false;

    function currentEntry() {
        if (!shown.length) return null;
        if (selected === FOLLOW) return shown[shown.length - 1];
        return shown.find(entry => entry.index === selected) ?? shown[shown.length - 1];
    }

    /** The turn on screen right now - the brush reads it at click time. */
    function shownIndex() {
        return currentEntry()?.index ?? null;
    }

    function position() {
        const entry = currentEntry();
        return entry ? shown.indexOf(entry) : -1;
    }

    function fillProse(element, message, index, { waiting = false, compact = false, streaming = false } = {}) {
        // The marks the popover hangs on are about to be replaced.
        closePopover();

        const html = toHtml(message, index, { compact, persona: personaName() });
        if (html) {
            renderInto(element, html);
            prependReasoning(element, message, index, { compact, streaming });
            return;
        }

        const empty = document.createElement('p');
        empty.className = waiting ? 'mz-prose-wait' : 'mz-prose-empty';
        empty.textContent = waiting
            ? '\u2026'
            : (message ? 'This message has no text.' : 'The scene begins when you write.');
        element.replaceChildren(empty);
        prependReasoning(element, message, index, { compact, streaming });
    }

    /**
     * The reasoning block, above the turn's prose. The reading pane's own -
     * the log never draws one - and only while the display says so. No
     * reasoning, no block: a turn without one reads exactly as it always did.
     */
    function prependReasoning(element, message, index, { compact = false, streaming = false } = {}) {
        if (compact || !reasoningOn()) return;

        const text = reasoningOf(message);
        if (!text) return;

        element.insertAdjacentHTML('afterbegin', reasoningHtml(message, index, text, {
            open: reasoningOpen,
            label: thoughtLabel(message, streaming),
        }));
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
        const locked = editingIndex !== null;
        if (prevButton) prevButton.disabled = locked || at <= 0;
        if (nextButton) nextButton.disabled = locked || at < 0 || at >= last;
        if (latestButton) latestButton.disabled = locked || selected === FOLLOW || at < 0;
        if (editButton) editButton.disabled = locked;

        // the eye mirrors the shown turn's prompt state, in ST's own glyphs
        const hidden = !!currentEntry()?.message?.is_system;
        if (togglePromptButton) {
            togglePromptButton.title = hidden
                ? 'Include message in prompts' : 'Exclude message from prompts';
            togglePromptButton.setAttribute('aria-label', togglePromptButton.title);
            togglePromptButton.replaceChildren(fa(hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'));
        }

        // the reasoning toggle mirrors the pane-wide display choice
        if (reasonButton) {
            const display = reasoningOn();
            reasonButton.setAttribute('aria-pressed', String(display));
            reasonButton.classList.toggle('is-on', display);
            reasonButton.title = display ? 'Hide reasoning from the pane' : 'Show reasoning in the pane';
            reasonButton.setAttribute('aria-label', reasonButton.title);
        }
    }

    /* ---------- editing ---------- */

    /** Brings the pane to editing state, or back out of it. */
    function drawEditState() {
        const onEdit = editingIndex !== null;

        if (edit) edit.hidden = !onEdit;
        if (prose) prose.hidden = onEdit;
        if (actionsRow) actionsRow.hidden = onEdit;
        if (editBar) editBar.hidden = !onEdit;

        // while editing, everything else in the header and footer stands down
        if (onEdit) {
            if (swipeBar) swipeBar.hidden = true;
        }
    }

    /**
     * Mirrors SillyTavern's editor textarea in the pane. SillyTavern's copy
     * is the one its accept handler reads, so ours only ever feeds it.
     */
    function syncFromSt() {
        const st = editingIndex !== null ? editorTextarea(editingIndex) : null;
        if (!st || !edit) return;

        if (edit.value !== st.value && !syncing) {
            edit.value = st.value;
        }
    }

    /** Opens editing on the shown turn, through SillyTavern's own editor. */
    async function editShownTurn() {
        const entry = currentEntry();
        if (!entry || frame.classList.contains('is-generating')) return false;
        if (editingIndex !== null) return false;

        // ST's editor is one editor: the ribbon's own edit stands down first
        if (sceneEdit) cancelSceneEdit();

        const opened = await editMessage(entry.index);
        if (!opened) return false;

        editingIndex = entry.index;
        const st = editorTextarea(entry.index);
        if (edit) {
            edit.value = st?.value ?? entry.message.mes ?? '';
        }

        drawEditState();
        updateControls();

        // the cursor belongs to our textarea, so typing starts at once
        if (edit) {
            edit.focus({ preventScroll: true });
            edit.setSelectionRange(edit.value.length, edit.value.length);
        }
        return true;
    }

    /**
     * Presses one of SillyTavern's own edit buttons — accept, delete or
     * discard — on the message being edited. SillyTavern does the work: the
     * save, the delete-or-swipe popup, the re-render. Its editor closes on
     * its own async schedule, so the watch — not this — ends our editing
     * state, by watching for the editor to disappear.
     */
    async function pressEditButton(press) {
        if (editingIndex === null) return false;
        return press();
    }

    function acceptShownEdit() {
        return pressEditButton(acceptEdit);
    }

    function deleteShownEdit() {
        return pressEditButton(deleteEditedMessage);
    }

    function cancelShownEdit() {
        return pressEditButton(cancelEdit);
    }

    /** Leaves editing state without touching SillyTavern's editor. */
    function exitEdit() {
        editingIndex = null;
        drawEditState();
        updateControls();
    }

    /** Whether SillyTavern's editor is open on the shown turn. */
    function isEditing() {
        return editingIndex !== null;
    }

    /* ---------- the scene ribbon's own edit ---------- */

    /** The ribbon's location, as the edit rows read it: one row per level. */
    function sceneLevels(mes, at) {
        const raw = String(sceneTagAt(mes, at)?.attrs?.location ?? '');
        const levels = raw.split('|').map(level => level.trim()).filter(Boolean);
        return levels.length ? levels : [''];
    }

    /** Whether the draft can be saved: the chain keeps at least one level. */
    function sceneSavable() {
        return !!sceneEdit && sceneEdit.levels.some(level => level.trim());
    }

    /** Greys the save seat out while the chain would save nothing. */
    function syncSceneSave() {
        const save = prose.querySelector('[data-mz-action="scene-save"]');
        if (save) save.disabled = !sceneSavable();
    }

    /** Builds one edit row: the level's input and its remove seat. */
    function sceneRowEditor() {
        const rows = document.createElement('div');
        rows.className = 'mz-loc-edit';

        sceneEdit.levels.forEach((value, at) => {
            const step = document.createElement('span');
            step.className = 'mz-loc-step';

            const field = document.createElement('input');
            field.className = 'mz-loc-lvl';
            field.type = 'text';
            field.value = value;
            field.dataset.mzLoc = String(at);
            field.spellcheck = false;
            field.setAttribute('aria-label', `Location level ${at + 1}`);

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'mz-ibtn mz-loc-del';
            del.dataset.mzAction = 'scene-lvl-del';
            del.dataset.mzSceneLvl = String(at);
            del.title = 'Remove this level';
            del.setAttribute('aria-label', 'Remove this level');
            del.append(fa('fa-solid fa-xmark'));

            step.append(field, del);
            rows.append(step);

            if (at < sceneEdit.levels.length - 1) {
                const sep = document.createElement('span');
                sep.className = 'mz-scene-sep';
                sep.textContent = '\u203a';
                sep.setAttribute('aria-hidden', 'true');
                rows.append(sep);
            }
        });

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'mz-ibtn mz-loc-add';
        add.dataset.mzAction = 'scene-lvl-add';
        add.title = 'Add a location level';
        add.setAttribute('aria-label', 'Add a location level');
        add.append(fa('fa-solid fa-plus'));
        rows.append(add);

        return rows;
    }

    /** Re-renders the level rows in place, keeping the draft as written. */
    function redrawSceneRows(focusAt = null) {
        const rows = prose.querySelector('.mz-loc-edit');
        if (!rows) return;

        rows.replaceWith(sceneRowEditor());
        syncSceneSave();

        const aim = focusAt === null ? null : prose.querySelector(`[data-mz-loc="${Number(focusAt)}"]`);
        (aim ?? prose.querySelector('[data-mz-loc="0"]'))?.focus({ preventScroll: true });
    }

    /**
     * Brings the ribbon to its own edit state, or back out of it. The place
     * becomes level rows and the pencil stands down for save / cancel - the
     * date, time, weather and cast stay, read-only, as the tag wrote them.
     */
    function drawSceneEdit() {
        if (!prose) return;

        const aside = sceneEdit
            ? prose.querySelector(`aside[data-mz-scene-at="${Number(sceneEdit.at)}"]`)
            : null;

        // A redraw can lose the ribbon (another turn, a swipe, a delete):
        // the edit ends with it, and a dropped draft follows nothing home.
        if (sceneEdit && (!aside || editingIndex !== null)) {
            sceneEdit = null;
            return;
        }

        prose.classList.toggle('is-scene-edit', !!sceneEdit);
        if (!aside || aside.querySelector('.mz-loc-edit')) return;

        const place = aside.querySelector('.mz-scene-place');
        if (place) {
            place.hidden = true;
            // The simple band runs its fields in one flex row: the rows take
            // a line of their own beneath it. The other wardrobes - column
            // already - place them right where the place stood.
            const host = aside.querySelector('.mz-scene-main') || place;
            host.insertAdjacentElement('afterend', sceneRowEditor());
        }

        // the pencils stand down for save and cancel
        for (const pencil of aside.querySelectorAll('.mz-scene-pencil')) pencil.hidden = true;

        const tools = aside.querySelector('.mz-scene-tools');
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'mz-ibtn mz-scene-save';
        save.dataset.mzAction = 'scene-save';
        save.title = 'Save this scene';
        save.setAttribute('aria-label', 'Save this scene');
        save.append(fa('fa-solid fa-check'));

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'mz-ibtn mz-scene-cancel';
        cancel.dataset.mzAction = 'scene-cancel';
        cancel.title = 'Discard changes';
        cancel.setAttribute('aria-label', 'Discard changes');
        cancel.append(fa('fa-solid fa-xmark'));

        tools?.append(save, cancel);
        syncSceneSave();
        prose.querySelector(`[data-mz-loc="${Number(sceneEdit.aim ?? 0)}"]`)?.focus({ preventScroll: true });
    }

    /** Opens the location rows on one ribbon of the shown turn. */
    function startSceneEdit(at) {
        const entry = currentEntry();
        if (!entry || sceneEdit || editingIndex !== null) return false;
        if (frame.classList.contains('is-generating')) return false;
        if (!Number.isInteger(at) || at < 0) return false;

        sceneEdit = { index: entry.index, at, levels: sceneLevels(entry.message.mes, at), aim: 0 };
        drawSceneEdit();
        return true;
    }

    /** Leaves the ribbon's edit without touching anything. */
    function cancelSceneEdit() {
        if (!sceneEdit) return false;
        sceneEdit = null;
        drawPane();
        return true;
    }

    /**
     * Saves the draft: only the scene tag's `location` attribute is rewritten
     * in the raw message - the prose, the trackers and every other tag stay
     * byte for byte - and the write goes through SillyTavern's own editor, so
     * it does the save, the re-render and the events (the map and the
     * background chain re-derive from `MESSAGE_EDITED` by themselves).
     */
    async function saveSceneEdit() {
        const draft = sceneEdit;
        if (!draft) return false;

        const levels = draft.levels.map(level => level.trim()).filter(Boolean);
        if (!levels.length) return false;

        const message = chatMessages()[draft.index];
        const before = typeof message?.mes === 'string' ? message.mes : '';
        const next = editSceneAttrs(before, draft.at, { location: levels.join(' | ') });

        sceneEdit = null;
        if (next === before) {
            drawPane();
            return true;
        }

        sceneSaving = true;
        try {
            const opened = await editMessage(draft.index);
            const st = opened ? editorTextarea(draft.index) : null;
            if (!st) {
                drawPane();
                return false;
            }

            st.value = next;
            await acceptEdit();
        } finally {
            sceneSaving = false;
        }

        return true;
    }

    /** The ribbon edit's buttons, by their action name. */
    function sceneAction(name, button) {
        if (name === 'scene-edit') {
            if (!sceneEdit) startSceneEdit(Number(button.dataset.mzSceneAt));
            return;
        }
        if (!sceneEdit) return;

        if (name === 'scene-save') {
            saveSceneEdit();
            return;
        }
        if (name === 'scene-cancel') {
            cancelSceneEdit();
            return;
        }
        if (name === 'scene-lvl-add') {
            sceneEdit.levels.push('');
            redrawSceneRows(sceneEdit.levels.length - 1);
            return;
        }
        if (name === 'scene-lvl-del') {
            const at = Number(button.dataset.mzSceneLvl);
            if (Number.isInteger(at)) sceneEdit.levels.splice(at, 1);
            if (!sceneEdit.levels.length) sceneEdit.levels = [''];
            redrawSceneRows();
        }
    }

    /**
     * Watches for SillyTavern's editor to appear on another message (ST
     * allows one editor; opening it elsewhere auto-accepts ours), to close
     * unexpectedly, and heals the pane after deletes.
     */
    function watchEdit() {
        if (editingIndex === null) {
            // a scene save driving ST's editor is no message edit of its own
            if (sceneSaving) return;
            const st = editorTextarea();
            if (st) {
                // ST opened an editor on its own (or auto-accepted ours and
                // moved); follow the message it belongs to.
                const host = st.closest('.mes');
                const mesid = Number(host?.getAttribute('mesid'));
                const entry = shown.find(e => e.index === mesid);
                if (entry) {
                    selected = entry.index === shown[shown.length - 1].index ? FOLLOW : entry.index;
                    editingIndex = entry.index;
                    if (edit) edit.value = st.value;
                    drawEditState();
                    updateControls();
                    if (edit) edit.focus({ preventScroll: true });
                }
            }
            return;
        }

        const st = editorTextarea(editingIndex);
        if (!st) {
            // the editor closed: accept, cancel, delete, or a stray click.
            // before leaving, an editor may have moved to another message —
            // SillyTavern allows one — and that is a follow, not an exit.
            const moved = editorTextarea();
            if (moved) {
                const host = moved.closest('.mes');
                const mesid = Number(host?.getAttribute('mesid'));
                const entry = shown.find(e => e.index === mesid);
                if (entry) {
                    selected = entry.index === shown[shown.length - 1].index ? FOLLOW : entry.index;
                    editingIndex = entry.index;
                    if (edit) edit.value = moved.value;
                    drawEditState();
                    updateControls();
                    if (edit) edit.focus({ preventScroll: true });
                    return;
                }
            }

            exitEdit();
            refresh();
            return;
        }

        syncFromSt();
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
        if (editingIndex !== null) {
            swipeBar.hidden = true;
            return;
        }

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
            const streaming = entry === shown[shown.length - 1] && frame.classList.contains('is-generating');
            fillProse(prose, entry.message, entry.index, { waiting: isWaitingForFirstToken(entry), streaming });
        }

        // a turn excluded from the prompts stays, dimmed, like ST's ghost
        prose.classList.toggle('is-prompt-hidden', !!entry?.message?.is_system);

        // while editing, our textarea shows the turn, not the prose
        if (editingIndex !== null && entry && entry.index === editingIndex && edit) {
            edit.value = edit.value || entry.message.mes || '';
        }

        // the ribbon's own edit rides redraws on its own turn and dies with
        // any other turn, without ever moving a draft somewhere new
        if (sceneEdit && (!entry || entry.index !== sceneEdit.index)) sceneEdit = null;
        drawSceneEdit();

        prose.scrollTop = stick ? prose.scrollHeight : 0;
        updateControls();
        updateSwipeBar(entry);

        // the chrome reads the same turn: its last usable scene, or the most
        // recent earlier one when this message has none.
        const scene = entry
            ? resolveScene(chatMessages(), entry.index, { persona: personaName() })
            : null;
        onShown?.({ entry, scene });
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
            branch.append(fa('fa-regular fa-code-branch'));

            head.append(who, turn, jump, branch);

            const body = document.createElement('div');
            body.className = 'mz-prose mz-log-prose';
            fillProse(body, message, index, { compact: true });

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

        // the edited message may be gone (deleted, or its chat switched)
        if (editingIndex !== null && !shown.some(entry => entry.index === editingIndex)) {
            editingIndex = null;
            drawEditState();
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

    // our textarea feeds SillyTavern's; the guard stops the echo back
    if (edit) {
        edit.addEventListener('input', () => {
            if (editingIndex === null) return;
            const st = editorTextarea(editingIndex);
            if (!st) return;

            syncing = true;
            st.value = edit.value;
            st.dispatchEvent(new Event('input', { bubbles: true }));
            syncing = false;
        });
    }

    // the edit state is watched, not evented: SillyTavern reports no event
    // for its editor opening or closing, and the pane must follow anyway
    setInterval(() => {
        if (isOpen()) watchEdit();
    }, 400);

    // The reasoning block opens and closes in the pane's one remembered
    // state, so stepping between turns - and every redraw mid-stream -
    // follows whatever the reader last chose.
    prose.addEventListener('click', event => {
        // the ribbon's own edit buttons come first: they never open a
        // reasoning block under them
        const seat = event.target.closest('[data-mz-action^="scene-"]');
        if (seat) {
            sceneAction(seat.dataset.mzAction, seat);
            return;
        }

        const head = event.target.closest('.mz-reason-head');
        if (!head) return;

        reasoningOpen = !reasoningOpen;
        for (const block of prose.querySelectorAll('.mz-reason')) {
            block.classList.toggle('is-open', reasoningOpen);
            block.querySelector('.mz-reason-head')?.setAttribute('aria-expanded', String(reasoningOpen));
        }
    });

    // the draft is kept as it is typed - a redraw rebuilds the rows from it
    prose.addEventListener('input', event => {
        const field = event.target.closest('[data-mz-loc]');
        if (!field || !sceneEdit) return;

        sceneEdit.levels[Number(field.dataset.mzLoc)] = field.value;
        sceneEdit.aim = Number(field.dataset.mzLoc);
        syncSceneSave();
    });

    prose.addEventListener('keydown', event => {
        if (!sceneEdit) return;

        if (event.key === 'Escape') {
            // Esc belongs to this edit: the scene's own chain waits behind it
            event.preventDefault();
            event.stopPropagation();
            cancelSceneEdit();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const field = event.target.closest('[data-mz-loc]');
            const at = field ? Number(field.dataset.mzLoc) : -1;
            if (at >= 0 && at < sceneEdit.levels.length - 1) {
                prose.querySelector(`[data-mz-loc="${at + 1}"]`)?.focus({ preventScroll: true });
            } else {
                saveSceneEdit();
            }
        }
    });

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

    // the parts carry their own state from the first moment
    updateControls();

    return { refresh, openLog, closeLog, isLogOpen, isEditing, shownIndex, step, latest, show, branchHere, swipeShownTurn, copyShownTurn, togglePromptHidden, editShownTurn, acceptShownEdit, deleteShownEdit, cancelShownEdit };
}
