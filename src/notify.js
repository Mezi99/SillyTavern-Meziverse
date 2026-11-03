/**
 * Meziverse's own toast notices.
 *
 * While the scene is on screen, SillyTavern's toastr stack cannot be seen:
 * the overlay holds the fullscreen layer, and nothing outside it is drawn.
 * So the four toastr calls are intercepted for as long as the scene is open
 * and re-rendered here, as notices in our own hand. Anything Meziverse
 * itself wants to say uses the same notify().
 */

const KINDS = new Set(['success', 'info', 'warning', 'error']);
const LINGER = 5000;

let stack = null;
let timer = 0;

/** The toast stack, made on first use inside the frame. */
function ensureStack() {
    if (stack?.isConnected) return stack;

    const frame = document.querySelector('#mz-root .mz-frame');
    if (!frame) return null;

    stack = document.createElement('div');
    stack.className = 'mz-toasts';
    stack.setAttribute('aria-live', 'polite');
    frame.append(stack);
    return stack;
}

/**
 * Shows a notice: it drops in from above, lingers, then fades. With
 * `options.sticky` it stays until its returned handle dismisses it - for
 * stages a long job passes through, where a fading notice would lie about
 * the work being done.
 *
 * @param {string} text the message, plain text
 * @param {('success'|'info'|'warning'|'error')} [kind] the accent it carries
 * @param {{sticky?:boolean}} [options]
 * @returns {{dismiss:() => void}|null}
 */
export function notify(text, kind = 'info', options = {}) {
    const host = ensureStack();
    if (!host) return null;

    const note = document.createElement('div');
    note.className = `mz-toast is-${KINDS.has(kind) ? kind : 'info'}`;
    note.setAttribute('role', 'status');

    const body = document.createElement('span');
    body.className = 'mz-toast-text';
    body.textContent = String(text ?? '');

    note.append(body);
    host.append(note);

    // let the entering transition play from its start
    requestAnimationFrame(() => note.classList.add('is-in'));

    const dismiss = () => {
        note.classList.remove('is-in');
        note.classList.add('is-out');
        setTimeout(() => note.remove(), 350);
    };

    if (!options.sticky) {
        timer += 1;
        const seat = timer;
        setTimeout(() => {
            // many at once would march down; they hold their seats
            if (note.isConnected) dismiss();
        }, LINGER + seat * 0);
    }

    return { dismiss };
}

/**
 * The message as plain text, whatever shape it arrived in. Throwables speak
 * through their message; anything else that would show as "[object Object]"
 * is left for the real toast to render, never mirrored raw.
 */
function messageText(message) {
    if (typeof message === 'string') return message;
    if (!message) return '';
    if (typeof message.message === 'string' && message.message.trim()) return message.message;
    const text = String(message);
    return text === '[object Object]' ? '' : text;
}

/**
 * Wraps SillyTavern's toastr for as long as the scene is open, so its
 * notices are seen: the real toast is still shown - consumers hold its
 * element and hand it back to `toastr.clear` later (the image loader does
 * exactly that), so the contract must survive the mirror - and each toast
 * is re-rendered as a notice of ours inside the scene. Clearing a toast
 * clears its mirror too. Returns a function that restores toastr exactly as
 * it was.
 */
export function interceptToastr() {
    const toastr = globalThis.toastr;
    if (!toastr) return () => {};

    const methods = ['success', 'info', 'warning', 'error'];
    const saved = new Map();
    const mirrors = new Map();

    for (const name of methods) {
        if (typeof toastr[name] !== 'function') continue;

        saved.set(name, toastr[name]);
        toastr[name] = (message, title, overrides) => {
            const element = saved.get(name).call(toastr, message, title, overrides);

            // timeOut: 0 is toastr's own "stay until cleared" - our sticky.
            const note = notify(messageText(message), name, { sticky: overrides?.timeOut === 0 });
            if (element && note) {
                mirrors.set(element, note);
                if (overrides?.timeOut !== 0) {
                    // A fading note outlives nothing; drop its mirror entry.
                    setTimeout(() => mirrors.delete(element), LINGER + 1000);
                }
            }
            return element;
        };
    }

    if (typeof toastr.clear === 'function') {
        saved.set('clear', toastr.clear);
        toastr.clear = (element, options) => {
            const note = mirrors.get(element);
            if (note) {
                note.dismiss();
                mirrors.delete(element);
            }
            return saved.get('clear').call(toastr, element, options);
        };
    }

    if (typeof toastr.clearAll === 'function') {
        saved.set('clearAll', toastr.clearAll);
        toastr.clearAll = () => {
            for (const note of mirrors.values()) note.dismiss();
            mirrors.clear();
            return saved.get('clearAll').call(toastr);
        };
    }

    return () => {
        for (const [name, original] of saved) toastr[name] = original;
        for (const note of mirrors.values()) note.dismiss();
        mirrors.clear();
    };
}
