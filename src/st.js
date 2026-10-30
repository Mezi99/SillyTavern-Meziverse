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
