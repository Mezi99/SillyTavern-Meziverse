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
const LINGER = 3200;

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
 * Shows a notice: it drops in from above, lingers, then fades.
 *
 * @param {string} text the message, plain text
 * @param {('success'|'info'|'warning'|'error')} [kind] the accent it carries
 */
export function notify(text, kind = 'info') {
    const host = ensureStack();
    if (!host) return;

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

    timer += 1;
    const seat = timer;
    setTimeout(() => {
        // many at once would march down; they hold their seats
        if (note.isConnected) dismiss();
    }, LINGER + seat * 0);
}

/**
 * Wraps SillyTavern's toastr for as long as the scene is open, so its
 * notices are seen. Its message text is kept; its look becomes ours.
 * Returns a function that restores toastr exactly as it was.
 */
export function interceptToastr() {
    const toastr = globalThis.toastr;
    if (!toastr) return () => {};

    const methods = ['success', 'info', 'warning', 'error'];
    const saved = new Map();

    for (const name of methods) {
        if (typeof toastr[name] !== 'function') continue;

        saved.set(name, toastr[name]);
        toastr[name] = (message => {
            // toastr is called with (message, title, overrides); the message
            // is what matters, and it may arrive as a jQuery-ish object.
            const text = typeof message === 'string'
                ? message
                : (message && String(message)) || '';
            notify(text, name);
        });
    }

    return () => {
        for (const [name, original] of saved) toastr[name] = original;
    };
}
