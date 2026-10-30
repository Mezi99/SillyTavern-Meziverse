/**
 * The only file that talks to SillyTavern.
 *
 * Everything else imports from here, so when SillyTavern changes an internal,
 * there is one place to fix. Nothing in here reads or writes chat data on its
 * own: it hands the context over and lets the caller decide.
 */

let cached = null;

/** SillyTavern's own context object, or null while the app is still loading. */
export function ctx() {
    if (cached) return cached;

    const st = globalThis.SillyTavern;
    if (st && typeof st.getContext === 'function') {
        try {
            cached = st.getContext();
        } catch {
            cached = null;
        }
    }

    return cached;
}

/**
 * Resolves once SillyTavern has finished starting: the extension menu and the
 * Extensions panel are in the page. Safe to call whether this script ran before
 * or after the app_ready event.
 */
export function whenReady() {
    return new Promise(resolve => {
        const menuReady = () => !!document.getElementById('extensionsMenu');

        if (menuReady()) {
            resolve();
            return;
        }

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            resolve();
        };

        const context = ctx();
        context?.eventSource?.once?.(context.eventTypes.APP_READY, done);

        // app_ready can already have fired (extension toggled on later), so also
        // watch for the menu itself. Cheap: it stops as soon as either arrives.
        const poll = setInterval(() => {
            if (menuReady()) done();
        }, 200);
    });
}

/** Subscribe to a SillyTavern event by name, e.g. 'CHAT_CHANGED'. */
export function on(eventName, handler) {
    const context = ctx();
    const type = context?.eventTypes?.[eventName];
    if (!context?.eventSource || !type) return false;
    context.eventSource.on(type, handler);
    return true;
}

/** The open chat's file id, or null when no chat is open. */
export function currentChatId() {
    const context = ctx();
    if (!context || typeof context.getCurrentChatId !== 'function') return null;
    try {
        return context.getCurrentChatId() || null;
    } catch {
        return null;
    }
}

/** The active chat's messages. Always an array, never undefined. */
export function chatMessages() {
    const messages = ctx()?.chat;
    return Array.isArray(messages) ? messages : [];
}

/**
 * A message rendered the way SillyTavern renders it.
 *
 * This is the whole point of borrowing ST's formatter: regex scripts, Markdown,
 * quotes, rules, lists, colour spans and any other display extension behave
 * exactly as they do in the native chat. The result is already sanitised by ST.
 *
 * @param {object} message
 * @param {number} index its index in the chat, used by regex scripts
 * @returns {string} HTML, or '' when SillyTavern cannot format it
 */
export function formatMessage(message, index) {
    const context = ctx();
    const text = typeof message?.mes === 'string' ? message.mes : '';
    if (!context || !text) return '';

    const name = message.name || '';
    const isSystem = !!message.is_system;
    const isUser = !!message.is_user;

    try {
        if (typeof context.messageFormatting === 'function') {
            return String(context.messageFormatting(text, name, isSystem, isUser, index) ?? '');
        }
        if (typeof context.messageFormatter?.format === 'function') {
            return String(context.messageFormatter.format({
                mes: text,
                ch_name: name,
                isSystem,
                isUser,
                messageId: index,
            }) ?? '');
        }
    } catch (error) {
        console.warn('[Meziverse] could not format a message', error);
    }

    return '';
}

/**
 * Sends a line through SillyTavern's own composer, so generation, streaming,
 * extensions and regex all run exactly as in the native chat.
 *
 * @param {string} text
 * @returns {boolean} whether the composer was found and clicked
 */
export function sendUserMessage(text) {
    const input = document.getElementById('send_textarea');
    const button = document.getElementById('send_but');
    if (!(input instanceof HTMLTextAreaElement) || !button) return false;

    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button.click();
    return true;
}

/* ---------- composer actions ---------- */

/**
 * Clicks one of SillyTavern's own textbox-area controls. All its rules —
 * busy gates, empty-input semantics, impersonate filling the box, continue
 * extending the last reply — live in the handlers behind these elements.
 *
 * @param {string} id the element id, e.g. 'send_but'
 * @returns {boolean} whether the element was found and clicked
 */
export function clickComposerControl(id) {
    const control = document.getElementById(id);
    if (!(control instanceof Element)) return false;

    control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    control.click();
    return true;
}

/**
 * Clicks one of SillyTavern's own three-lines menu options. Both the new
 * chat confirm and the parent-chat switch run through its handlers.
 *
 * @param {string} id option id, e.g. 'option_start_new_chat'
 * @returns {boolean} whether the option was found and clicked
 */
export function clickOptionsMenu(id) {
    const option = document.getElementById(id);
    if (!(option instanceof Element)) return false;

    // The menu itself may be display:none — ST's own handlers run regardless.
    option.click();
    return true;
}

/**
 * Whether SillyTavern currently shows "Back to parent chat" in its menu.
 * SillyTavern itself decides this (bookmarks.js): it appears only in a
 * chat that was branched off another.
 *
 * @returns {boolean}
 */
export function hasParentChat() {
    try {
        return !!ctx()?.chatMetadata?.main_chat;
    } catch {
        return false;
    }
}

/** SillyTavern's own composer textarea — the input our box mirrors. */
export function stComposer() {
    const textarea = document.getElementById('send_textarea');
    return textarea instanceof HTMLTextAreaElement ? textarea : null;
}

/** Stops the generation SillyTavern is running. */
export function stopGeneration() {
    const context = ctx();
    if (typeof context?.stopGeneration !== 'function') return false;
    try {
        context.stopGeneration();
        return true;
    } catch {
        return false;
    }
}

/* ---------- swipes ---------- */

/** Whether SillyTavern's swipe engine can be reached at all. */
export function swipeSupported() {
    return typeof ctx()?.swipe?.right === 'function';
}

/**
 * SillyTavern's own gate for swiping: the setting is on, nothing is
 * generating and no swipe is mid-flight. When it cannot be asked, swiping
 * is assumed fine — SillyTavern still guards the swipe itself.
 */
export function swipingAllowed() {
    const api = ctx()?.swipe;
    if (typeof api?.isAllowed !== 'function') return true;
    try {
        return !!api.isAllowed();
    } catch {
        return false;
    }
}

/**
 * Swipes a message through SillyTavern's own engine, so a switch within the
 * swipes, the wrap-around and the new reply past the last swipe all run
 * exactly as they do behind SillyTavern's own chevrons — including the save.
 *
 * @param {('left'|'right')} direction
 * @param {number} index the message's index in the chat
 * @returns {Promise<boolean>} whether the swipe was handed over
 */
export async function swipeMessage(direction, index) {
    const api = ctx()?.swipe;
    if (direction !== 'left' && direction !== 'right') return false;
    if (typeof api?.[direction] !== 'function') return false;

    const message = chatMessages()[Number(index)];
    if (!message) return false;

    try {
        await api[direction](null, { message });
        return true;
    } catch (error) {
        console.warn('[Meziverse] could not swipe the message', error);
        return false;
    }
}

/* ---------- message actions ---------- */

/**
 * Clicks one of SillyTavern's own per-message buttons in its copy of the
 * chat, so the handler that knows the rules does the work.
 *
 * @param {string} selector a `.mes`-child button selector, e.g. '.mes_copy'
 * @param {number} index the message's index in the chat
 * @returns {Promise<boolean>} whether the button was found and pressed
 */
async function pressMessageButton(selector, index) {
    const button = document.querySelector(`#chat .mes[mesid="${Number(index)}"] ${selector}`);
    if (!(button instanceof Element)) return false;

    // ST binds .mes_copy on pointerup, the rest on click; send both.
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    button.click();
    return true;
}

/**
 * Copies a message's text through SillyTavern's own handler, which brings
 * its "Copied!" toast.
 *
 * @param {number} index the message's index in the chat
 * @returns {Promise<boolean>}
 */
export async function copyMessage(index) {
    return pressMessageButton('.mes_copy', index);
}

/* ---------- editing ---------- */

/**
 * Opens SillyTavern's editor on a message: its textarea appears in its own
 * chat DOM, its rules run (one editor at a time; a previous edit elsewhere
 * is auto-accepted), and accept/cancel/delete become reachable there.
 *
 * @param {number} index the message's index in the chat
 * @returns {Promise<boolean>} whether the edit button was found and pressed
 */
export async function editMessage(index) {
    return pressMessageButton('.mes_edit', index);
}

/**
 * SillyTavern's own editor textarea for the message being edited, if one is
 * open on that message. The textarea lives in ST's chat DOM and is the text
 * its accept/cancel handlers act on, so the pane must mirror this element.
 *
 * @param {number} [index] when given, the editor must belong to that message
 * @returns {HTMLTextAreaElement|null}
 */
export function editorTextarea(index) {
    const textarea = document.querySelector('#chat .mes .edit_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    if (index === undefined) return textarea;

    const host = textarea.closest('.mes');
    return host && host.getAttribute('mesid') === String(Number(index)) ? textarea : null;
}

/**
 * Accepts the open edit through SillyTavern's own handler: it reads its
 * textarea, updates the chat, saves and re-renders.
 *
 * @returns {Promise<boolean>}
 */
export async function acceptEdit() {
    const textarea = editorTextarea();
    if (!textarea) return false;

    const done = textarea.closest('.mes')?.querySelector('.mes_edit_done');
    if (!(done instanceof Element)) return false;

    done.click();
    return true;
}

/**
 * Discards the open edit through SillyTavern's own handler: the original
 * text is restored, nothing is saved.
 *
 * @returns {Promise<boolean>}
 */
export async function cancelEdit() {
    const textarea = editorTextarea();
    if (!textarea) return false;

    const cancel = textarea.closest('.mes')?.querySelector('.mes_edit_cancel');
    if (!(cancel instanceof Element)) return false;

    cancel.click();
    return true;
}

/**
 * Deletes the message being edited through SillyTavern's own handler. When
 * the message can lose a swipe instead, SillyTavern's own popup asks which.
 *
 * @returns {Promise<boolean>}
 */
export async function deleteEditedMessage() {
    const textarea = editorTextarea();
    if (!textarea) return false;

    const del = textarea.closest('.mes')?.querySelector('.mes_edit_delete');
    if (!(del instanceof Element)) return false;

    del.click();
    return true;
}

/**
 * Includes a message in the prompts again, or excludes it from them, through
 * SillyTavern's own handler: it flips is_system, keeps its chat in sync and
 * saves. It reports no event, so the caller must refresh the pane itself.
 *
 * @param {number} index the message's index in the chat
 * @param {boolean} hidden true to exclude, false to include again
 * @returns {Promise<boolean>}
 */
export async function setPromptHidden(index, hidden) {
    const message = chatMessages()[Number(index)];
    if (!message) return false;

    const already = !!message.is_system;
    if (already === !!hidden) return true;

    return pressMessageButton(hidden ? '.mes_hide' : '.mes_unhide', index);
}

/**
 * Branches the chat at a message, through SillyTavern's own /branch-create.
 * The copy holds every message up to and including the pinned turn, and
 * SillyTavern opens it at once — CHAT_CHANGED carries the rest.
 *
 * @param {number} mesId index in the chat of the turn to branch from
 * @returns {Promise<string|null>} the new chat's file name, or null on failure
 */
export async function branchChat(mesId) {
    const context = ctx();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') return null;

    try {
        const result = await context.executeSlashCommandsWithOptions(`/branch-create ${Number(mesId)}`);
        // newer ST returns a closure result whose pipe is the branch name
        const name = typeof result === 'string' ? result : result?.pipe;
        return typeof name === 'string' && name ? name : null;
    } catch (error) {
        console.warn('[Meziverse] could not branch the chat', error);
        return null;
    }
}
