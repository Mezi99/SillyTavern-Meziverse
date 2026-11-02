/**
 * The only file that talks to SillyTavern.
 *
 * Everything else imports from here, so when SillyTavern changes an internal,
 * there is one place to fix. Nothing in here reads or writes chat data on its
 * own: it hands the context over and lets the caller decide.
 */

import { normalizeStore, toCssBgUrl } from './backgrounds.js';

/**
 * SillyTavern's own context object, or null while the app is still loading.
 *
 * Deliberately never cached. `getContext()` hands back a fresh snapshot each
 * call, and some of what it points at (chatMetadata above all) is *rebound* by
 * SillyTavern as chats load and clear. A cached snapshot keeps pointing at the
 * old object, so writes land somewhere the save never reads. The snapshot is
 * only a small object of references, so rebuilding it per call costs nothing
 * and every read stays live.
 */
export function ctx() {
    const st = globalThis.SillyTavern;
    if (!st || typeof st.getContext !== 'function') return null;

    try {
        return st.getContext();
    } catch {
        return null;
    }
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

/* ---------- chat-scoped cast portraits ---------- */

/**
 * The one key a character's portrait is stored under. Names are compared
 * case-insensitively and with runs of whitespace collapsed.
 *
 * @param {string} name
 * @returns {string}
 */
export function castKey(name) {
    const value = typeof name === 'string' ? name : '';
    const normalised = typeof value.normalize === 'function' ? value.normalize('NFC') : value;
    return normalised.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The open chat's portrait paths, keyed by `castKey`. Never null. */
export function castImages() {
    const cast = ctx()?.chatMetadata?.meziverse?.cast;
    return cast && typeof cast === 'object' && !Array.isArray(cast) ? cast : {};
}

/** Writes one portrait path into the open chat's metadata and persists it. */
export function setCastImage(name, path) {
    const key = castKey(name);
    if (!key || typeof path !== 'string' || !path.trim()) return 'failed';

    const metadata = ctx()?.chatMetadata;
    if (!metadata || typeof metadata !== 'object') return 'failed';

    if (!metadata.meziverse || typeof metadata.meziverse !== 'object') metadata.meziverse = {};
    if (!metadata.meziverse.cast || typeof metadata.meziverse.cast !== 'object') {
        metadata.meziverse.cast = {};
    }

    metadata.meziverse.cast[key] = path.trim();

    // Read the path back through a fresh context. The round trip is the proof
    // the write landed on the object SillyTavern will serialise, not on a
    // snapshot it has since dropped.
    if (castImages()[key] !== path.trim()) return 'failed';

    return saveChatMetadata() ? 'saved' : 'memory-only';
}

/** Removes one portrait path from the open chat's metadata and persists it. */
export function removeCastImage(name) {
    const key = castKey(name);
    if (!key) return 'failed';

    const cast = ctx()?.chatMetadata?.meziverse?.cast;
    if (!cast || typeof cast !== 'object' || !(key in cast)) return 'failed';

    delete cast[key];
    return saveChatMetadata() ? 'saved' : 'memory-only';
}

/**
 * Asks SillyTavern to persist the chat's metadata.
 *
 * Prefers the immediate save over the debounced one: a portrait is attached by
 * hand and then the page may be reloaded at any moment, so waiting out a
 * debounce is how images get lost. Falls back to the debounced call when that
 * is all there is. Never fails quietly — if nothing can persist, say so.
 *
 * @returns {boolean} whether anything was asked to write the chat to disk
 */
export function saveChatMetadata() {
    const context = ctx();
    if (!context) {
        console.warn('[Meziverse] no SillyTavern context: chat metadata cannot be saved');
        return false;
    }

    const attempts = [context.saveMetadata, context.saveMetadataDebounced, context.saveChat];

    for (const attempt of attempts) {
        if (typeof attempt !== 'function') continue;

        try {
            Promise.resolve(attempt.call(context))?.catch?.(error => {
                console.warn('[Meziverse] could not save chat metadata', error);
            });
            return true;
        } catch (error) {
            console.warn('[Meziverse] could not save chat metadata', error);
            return false;
        }
    }

    console.warn('[Meziverse] SillyTavern offers no way to save chat metadata');
    return false;
}

/** The active persona's name, or ''. */
export function personaName() {
    try {
        return String(ctx()?.name1 || '').trim();
    } catch {
        return '';
    }
}

/** Story text as display text: `{{user}}` is the persona's own name. */
export function say(value) {
    const raw = String(value ?? '');
    const name = personaName();
    return name ? raw.replace(/\{\{\s*user\s*\}\}/gi, name) : raw;
}

/**
 * Uploads a prepared image into the chat's portrait folder.
 *
 * SillyTavern does the writing; this only hands it the bytes it already knows
 * how to store. The returned path is the server's own path, without a leading
 * slash; callers add one when they use it as an image source.
 *
 * @param {{image:string, format?:string, filename?:string}} upload base64 without the data-url prefix
 * @returns {Promise<string|null>}
 */
export async function uploadImage({ image, format = 'webp', filename = 'portrait.webp' } = {}) {
    const context = ctx();
    if (!image) return null;

    let headers = {};
    try {
        headers = context?.getRequestHeaders?.() || {};
    } catch {
        headers = {};
    }

    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
        headers = { ...headers, 'Content-Type': 'application/json' };
    }

    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                image,
                format,
                filename,
                ch_name: 'meziverse',
            }),
        });

        if (!response.ok) {
            throw new Error(`upload failed (${response.status})`);
        }

        const data = await response.json();
        const path = typeof data?.path === 'string' ? data.path.trim() : '';
        return path || null;
    } catch (error) {
        console.warn('[Meziverse] could not upload the portrait', error);
        return null;
    }
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

/* ---------- location backgrounds ---------- */

/**
 * The open chat's background store, normalized and live.
 *
 * Mutating it edits `chatMetadata.meziverse.bg` in place - the object
 * SillyTavern serialises - so callers write records and then ask
 * `saveChatMetadata()` to persist. With no chat open the store is detached:
 * writes to it are simply lost, which is right, because there is nothing to
 * save them to. Pure logic lives in backgrounds.js; this only anchors the
 * store to SillyTavern's metadata.
 */
export function bgStore() {
    const metadata = ctx()?.chatMetadata;
    if (!metadata || typeof metadata !== 'object') return normalizeStore();

    if (!metadata.meziverse || typeof metadata.meziverse !== 'object') metadata.meziverse = {};
    if (!metadata.meziverse.bg || typeof metadata.meziverse.bg !== 'object') metadata.meziverse.bg = {};

    return normalizeStore(metadata.meziverse.bg);
}

/**
 * The background SillyTavern has locked to this chat
 * (`chat_metadata.custom_background`), as its raw value, or null.
 */
export function customBackground() {
    const value = ctx()?.chatMetadata?.custom_background;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Makes SillyTavern set a chat background from an image path, the same way
 * its own image-generation "background" mode does: the FORCE_SET_BACKGROUND
 * event locks it to the chat, registers it in the chat's background list and
 * persists the metadata. The scene's own backdrop mirror follows the event.
 *
 * Idempotent: when the image is already the chat's background nothing is
 * emitted. Afterwards the chat's background list is de-duplicated in place -
 * SillyTavern appends every forced background unconditionally, and a re-applied
 * cached image would otherwise pile up copies.
 *
 * @param {string} imagePath the path Image Generation returned
 * @returns {Promise<boolean>} whether the background now shows that image
 */
export async function forceSetBackground(imagePath) {
    const context = ctx();
    const path = String(imagePath ?? '').trim();
    const type = context?.eventTypes?.FORCE_SET_BACKGROUND;
    if (!path || !context?.eventSource || !type) return false;

    const url = toCssBgUrl(path);
    if (customBackground() === url) return true;

    try {
        await context.eventSource.emit(type, { url, path });
    } catch (error) {
        console.warn('[Meziverse] could not set the chat background', error);
        return false;
    }

    dedupeChatBackgrounds();
    return true;
}

/** Collapses duplicates SillyTavern appended to the chat's background list. */
function dedupeChatBackgrounds() {
    const list = ctx()?.chatMetadata?.chat_backgrounds;
    if (!Array.isArray(list)) return;

    const seen = new Set();
    const unique = list.filter(item => {
        const key = String(item ?? '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    if (unique.length === list.length) return;

    // In place: the metadata object keeps its identity across the save.
    list.length = 0;
    list.push(...unique);
}

/* ---------- image generation ---------- */

/**
 * Whether SillyTavern's own Image Generation is set up well enough to draw
 * backgrounds: its settings exist and its /imagine command is registered.
 * The extension does the API keys, sources and models; we only need this gate.
 *
 * @returns {{ok:boolean, text:string}} what to tell the user
 */
export function imageGenerationStatus() {
    const context = ctx();
    const sd = context?.extensionSettings?.sd ?? context?.extension_settings?.sd;

    if (!sd) {
        return { ok: false, text: 'Image Generation settings not found. Enable the Image Generation extension.' };
    }
    if (typeof context?.SlashCommandParser?.commands?.imagine?.callback !== 'function') {
        return { ok: false, text: 'The /imagine command is not registered. Enable the Image Generation extension.' };
    }

    const source = sd.source ? String(sd.source) : 'unknown source';
    const model = sd.model ? String(sd.model) : 'default model';
    return { ok: true, text: `SillyTavern Image Generation: ${source} - ${model}` };
}

/**
 * Generates one image through SillyTavern's own /imagine command.
 *
 * The command is invoked the way the chat invokes it, with the differences
 * that make it ours: `quiet` keeps the image out of the chat entirely (the
 * prompt is then discarded by SillyTavern - callers keep their own copy),
 * and `extend` is off so the prompt reaches the image model verbatim, with
 * no rewrite pass and no review popup in the way. SillyTavern saves the file
 * and returns its path.
 *
 * @param {{prompt:string, negative?:string, width?:number|string, height?:number|string, signal?:AbortSignal}} request
 * @returns {Promise<{ok:true, path:string}|{ok:false, error:string, aborted:boolean}>}
 */
export async function imagine({ prompt, negative, width, height, signal } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, error: 'The image prompt is empty.', aborted: false };

    const callback = ctx()?.SlashCommandParser?.commands?.imagine?.callback;
    if (typeof callback !== 'function') {
        return {
            ok: false,
            error: 'Image Generation is not available. Enable the Image Generation extension and set an API.',
            aborted: false,
        };
    }

    const controller = new AbortController();
    if (signal) {
        if (signal.aborted) return { ok: false, error: 'The generation was cancelled.', aborted: true };
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const args = {
        quiet: 'true',
        gallery: 'false',
        extend: 'false',
        _abortController: controller,
    };
    const cleanNegative = String(negative ?? '').trim();
    if (cleanNegative) args.negative = cleanNegative;
    if (width && height) {
        args.width = String(width);
        args.height = String(height);
    }

    try {
        const path = String(await callback(args, text) ?? '').trim();
        if (signal?.aborted || controller.signal.aborted) {
            return { ok: false, error: 'The generation was cancelled.', aborted: true };
        }
        if (!path) {
            return {
                ok: false,
                error: 'Image Generation returned nothing. Check its source, model and API key.',
                aborted: false,
            };
        }
        return { ok: true, path };
    } catch (error) {
        if (signal?.aborted || controller.signal.aborted) {
            return { ok: false, error: 'The generation was cancelled.', aborted: true };
        }
        console.warn('[Meziverse] Image Generation failed', error);
        return {
            ok: false,
            error: `Image Generation failed: ${error?.message || error}`,
            aborted: false,
        };
    }
}

/**
 * One quiet call to the main connection's LLM - the watcher's question about
 * where the story is now. Only what we pass goes over the wire: no card, no
 * chat history, so the caller decides exactly what the LLM sees. Structured
 * output is requested with a schema when the caller has one.
 *
 * There is no abort signal to give: SillyTavern's own stop button governs
 * raw generation, same as its other quiet calls.
 *
 * @param {{prompt:string, systemPrompt?:string, responseLength?:number, jsonSchema?:object}} request
 * @returns {Promise<{ok:boolean, text:string, error:string}>}
 */
export async function generateRaw({ prompt, systemPrompt, responseLength, jsonSchema } = {}) {
    const context = ctx();
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, text: '', error: 'The watcher prompt is empty.' };

    if (typeof context?.generateRaw !== 'function') {
        return { ok: false, text: '', error: 'SillyTavern offers no raw generation here.' };
    }

    try {
        const result = await context.generateRaw({
            prompt: text,
            systemPrompt: String(systemPrompt ?? ''),
            responseLength: Number.isFinite(Number(responseLength)) ? Number(responseLength) : undefined,
            jsonSchema,
            trimNames: false,
        });
        return { ok: true, text: String(result ?? '').trim(), error: '' };
    } catch (error) {
        console.warn('[Meziverse] the watcher call failed', error);
        return { ok: false, text: '', error: `The watcher call failed: ${error?.message || error}` };
    }
}
