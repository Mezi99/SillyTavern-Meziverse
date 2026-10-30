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
