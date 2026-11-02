/**
 * The cast strip: one 3:5 poster for each name in the governing scene.
 *
 * Portraits belong to the chat, not the card or the extension, so their paths
 * live in `chatMetadata.meziverse.cast` and every chat can cast the same person
 * differently. Uploading goes through SillyTavern's own image endpoint; this
 * file only prepares a small WebP and then hands it over.
 */

import { castImages, castKey, currentChatId, removeCastImage, setCastImage, uploadImage } from './st.js';
import { initials } from './scene.js';
import { icon } from './icons.js';
import { notify } from './notify.js';
import { entryOn, modeOn } from './settings.js';

const MAX_EDGE = 1024;
const QUALITY = 0.85;
const FALLBACK_FLOOR = 180;
const FALLBACK_CEILING = 500;

/* The headroom the cast track keeps for thought bubbles above the
   posters. The pane's maximum yields the same amount while thoughts
   are on stage (overlay's paneLimits), so the two never fight over
   a short window. */
export const BUBBLE_ROOM = 72;

let host = null;
let track = null;
let picker = null;
let observer = null;

let names = [];
let lastScene = null;
let lastSignature = '';
let lastNames = '';
let lastThoughts = [];
let lastTells = [];
let busyName = '';
let busyChat = null;
let pending = null;

/** Mounts the strip inside the frame's cast region. Idempotent. */
export function mountCast(element) {
    if (!element || host === element) return;
    host = element;

    track = document.createElement('div');
    track.className = 'mz-cast-track';

    picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.hidden = true;
    picker.setAttribute('aria-hidden', 'true');

    host.append(track, picker);
    host.hidden = true;

    host.addEventListener('click', onClick);
    picker.addEventListener('change', onFileChosen);

    if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => refreshCastSizing());
        observer.observe(host);
    }

    window.addEventListener('resize', refreshCastSizing);
}

/**
 * Draws the cast of one scene. Reuses every poster while the names and images
 * are unchanged, so streaming frames do not reload portraits.
 *
 * @param {{present?: string[]}|null} scene
 */
export function renderCast(scene) {
    if (!host) return;

    // The cast is a scene feature: with Meziverse mode off there is nothing
    // to cast from and no place this strip belongs.
    if (!modeOn()) scene = null;

    lastScene = scene && Array.isArray(scene.present) ? scene : null;
    names = lastScene ? lastScene.present.filter(Boolean) : [];

    const signature = castSignature();
    if (signature === lastSignature) {
        refreshCastSizing();
        return;
    }

    lastSignature = signature;
    const joined = names.join('\u0001');
    const resetScroll = joined !== lastNames;
    lastNames = joined;

    host.hidden = names.length === 0;
    host.setAttribute('aria-label', names.length ? `Cast: ${names.join(', ')}` : 'Cast');

    if (!names.length) {
        track.replaceChildren();
        return;
    }

    const images = castImages();
    const fragment = document.createDocumentFragment();

    for (const name of names) {
        fragment.append(poster(name, images[castKey(name)] || ''));
    }

    track.replaceChildren(fragment);
    if (resetScroll) track.scrollLeft = 0;

    applyThoughts();
    applyTells();
    refreshCastSizing();
    requestAnimationFrame(refreshCastSizing);
}

/**
 * One person's avatar as the rails draw it: the chat's own portrait image
 * when the chat has one, and just the initial letters when it has not.
 *
 * @param {string} name
 * @returns {{src:string, initial:string}}
 */
export function castAvatar(name) {
    return {
        src: imageSource(castImages()[castKey(name)] || ''),
        initial: initials(name),
    };
}

/**
 * Attaches the ledger's private thoughts to their posters — one thought
 * bubble per avatar, matched by the simple, consistent name both sides
 * carry. Reapplied whenever the ledger or the cast changes; a thought
 * with no matching avatar simply stays unspoken.
 *
 * @param {object[]} profiles
 */
export function renderThoughts(profiles) {
    lastThoughts = Array.isArray(profiles) ? profiles : [];
    applyThoughts();
}

/* Thoughts hidden by their avatar's own toggle. Session-only, like the
   rails' snapped boxes: the future mode-features menu owns persistence. */
const hiddenThoughts = new Set();

function applyThoughts() {
    if (!host || !track) return;

    const shown = modeOn() && entryOn('profiles');
    const byName = new Map();

    if (shown) {
        for (const profile of lastThoughts) {
            const key = textOf(profile.character).trim().toLowerCase();
            if (key && profile.thought && !byName.has(key)) byName.set(key, profile.thought);
        }
    }

    let anyBubble = false;

    for (const figure of track.querySelectorAll('.mz-port')) {
        const key = textOf(figure.dataset.name).trim().toLowerCase();
        const thought = byName.get(key) || '';
        const bubble = figure.querySelector('.mz-thought-bub');
        const toggle = figure.querySelector('.mz-thought-btn');

        // A thought with no matching avatar stays unspoken: no bubble
        // and no toggle to bring one back.
        if (!thought) {
            bubble?.remove();
            toggle?.remove();
            continue;
        }

        const button = toggle || thoughtToggle(key);
        if (!toggle) figure.append(button);

        const hidden = hiddenThoughts.has(key);
        button.classList.toggle('is-off', hidden);
        button.title = hidden ? 'Show thought' : 'Hide thought';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(!hidden));

        if (hidden) {
            bubble?.remove();
        } else {
            const target = bubble || thoughtBubble();
            if (target.textContent !== thought) target.textContent = thought;
            if (!bubble) figure.append(target);
            anyBubble = true;
        }
    }

    // The bubbles are content: when any is on stage the track makes room
    // above the posters so its own scroll never clips them.
    track.style.setProperty('--mz-bubble-room', anyBubble ? `${BUBBLE_ROOM}px` : '0px');
    refreshCastSizing();
}

function thoughtToggle(key) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-thought-btn';
    button.dataset.mzThought = key;
    button.append(icon('mz-i-thought'));
    return button;
}

function thoughtBubble() {
    const bubble = document.createElement('div');
    bubble.className = 'mz-thought-bub';
    bubble.title = 'Click to read in full';
    return bubble;
}

function textOf(value) {
    return typeof value === 'string' ? value : '';
}

/* ---------- told lies ---------- */

// The hairline crack over a liar's portrait. It is a bonus: the mark in
// the prose carries the tell on its own.
const FRACTURE = '<svg class="mz-fracture" viewBox="0 0 100 166" preserveAspectRatio="none" aria-hidden="true">'
    + '<path d="M64 0 L56 17 L67 33 L52 52 L61 70 L46 88 L55 104 L42 124 L49 142 L40 166"/>'
    + '<path d="M52 52 L36 60 L30 76"/>'
    + '<path d="M55 104 L70 112 L74 128"/>'
    + '</svg>';

/**
 * Cracks the portraits of everyone the shown turn caught in a lie — one
 * crack per liar, whoever is on the stage. A liar who is not in the scene's
 * present keeps the mark in the prose alone. Reapplied whenever the cast
 * is redrawn.
 *
 * @param {string[]} characters
 */
export function renderTells(characters) {
    lastTells = Array.isArray(characters) ? characters : [];
    applyTells();
}

/** Lights the crack while that liar's mark has its popover open. */
export function tellTold(name, on) {
    if (!host || !track) return;

    const key = textOf(name).trim().toLowerCase();
    if (!key) return;

    for (const figure of track.querySelectorAll('.mz-port')) {
        if (textOf(figure.dataset.name).trim().toLowerCase() === key) {
            figure.classList.toggle('is-told', !!on);
        }
    }
}

function applyTells() {
    if (!host || !track) return;

    const told = new Set();
    if (modeOn()) {
        for (const name of lastTells) {
            const key = textOf(name).trim().toLowerCase();
            if (key) told.add(key);
        }
    }

    for (const figure of track.querySelectorAll('.mz-port')) {
        const key = textOf(figure.dataset.name).trim().toLowerCase();
        const has = told.has(key);
        figure.classList.toggle('has-tell', has);

        const crack = figure.querySelector('.mz-fracture');
        if (has && !crack) figure.insertAdjacentHTML('beforeend', FRACTURE);
        if (!has && crack) crack.remove();
    }
}

/** Fits poster height to the space above the pane and the available width. */
export function refreshCastSizing() {
    if (!host || host.hidden || !track || !names.length) return;

    const trackStyle = getComputedStyle(track);

    // The track reserves the pane's height at its foot, so its own inner box
    // is the only honest measure of the stage left for posters.
    const paddingTop = number(trackStyle.paddingTop);
    const paddingBottom = number(trackStyle.paddingBottom);
    const availableHeight = track.clientHeight - paddingTop - paddingBottom;

    const paddingLeft = number(trackStyle.paddingLeft);
    const paddingRight = number(trackStyle.paddingRight);
    const availableWidth = track.clientWidth - paddingLeft - paddingRight;

    const gap = number(trackStyle.columnGap) || 20;
    const count = Math.max(1, names.length);

    // Both tokens already follow the small-screen media query.
    const floor = length('--mz-port-min-h', FALLBACK_FLOOR);
    const ceiling = length('--mz-port-max-h', FALLBACK_CEILING);

    const fromHeight = Math.max(0, availableHeight - 2);
    const fromWidth = availableWidth > 0
        ? (availableWidth - gap * (count - 1)) / count / 0.6
        : ceiling;

    const height = Math.max(floor, Math.min(ceiling, fromHeight, fromWidth));
    track.style.setProperty('--mz-port-h', `${Math.round(height)}px`);

    host.classList.toggle('is-scroll', track.scrollWidth > track.clientWidth + 1);
}

/* ---------- building one poster ---------- */

function poster(name, path) {
    const figure = document.createElement('figure');
    figure.className = 'mz-port mz-port--cast';
    figure.dataset.name = name;
    figure.style.setProperty('--h', `${hueOf(name)}deg`);

    const plate = document.createElement('div');
    plate.className = 'mz-port-plate';
    plate.setAttribute('aria-hidden', 'true');

    const monogram = document.createElement('span');
    monogram.className = 'mz-port-initial';
    monogram.textContent = initials(name);

    plate.append(monogram);

    const source = imageSource(path);
    let image = null;

    if (source) {
        figure.classList.add('has-image');

        image = document.createElement('img');
        image.className = 'mz-port-img';
        image.alt = '';
        image.decoding = 'async';
        image.loading = 'lazy';
        image.src = source;
        image.addEventListener('load', () => {
            figure.classList.add('is-loaded');
            refreshCastSizing();
        });
        image.addEventListener('error', () => {
            // The path outlived its file: show the plate and offer to replace it.
            image.hidden = true;
            figure.classList.remove('has-image', 'is-loaded');
            figure.classList.add('is-empty');
        });
    } else {
        figure.classList.add('is-empty');
    }

    const scrim = document.createElement('div');
    scrim.className = 'mz-port-scrim';
    scrim.setAttribute('aria-hidden', 'true');

    const caption = document.createElement('figcaption');
    caption.className = 'mz-port-tag';
    caption.textContent = name;

    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'mz-port-attach';
    attach.dataset.mzCastAttach = name;
    attach.title = `Add ${name}'s portrait`;
    attach.setAttribute('aria-label', `Add portrait for ${name}`);

    const attachLabel = document.createElement('span');
    attachLabel.className = 'mz-port-attach-label';
    attachLabel.append(icon('mz-i-camera'));

    const attachText = document.createElement('span');
    attachText.className = 'mz-port-attach-text';
    attachText.textContent = 'Add portrait';
    attachLabel.append(attachText);

    attach.append(attachLabel);

    figure.append(plate);
    if (image) figure.append(image);
    figure.append(scrim, caption, attach);

    if (source) {
        const tools = document.createElement('div');
        tools.className = 'mz-port-tools';

        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'mz-port-tool';
        change.dataset.mzCastAttach = name;
        change.title = `Change ${name}'s portrait`;
        change.setAttribute('aria-label', `Change portrait for ${name}`);
        change.append(icon('mz-i-camera'));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mz-port-tool is-danger';
        remove.dataset.mzCastRemove = name;
        remove.title = `Remove ${name}'s portrait`;
        remove.setAttribute('aria-label', `Remove portrait for ${name}`);
        remove.append(icon('mz-i-trash'));

        tools.append(change, remove);
        figure.append(tools);
    }

    if (busyName === name && busyChat === currentChatId()) {
        figure.classList.add('is-busy');
        const busy = document.createElement('span');
        busy.className = 'mz-port-busy';
        busy.textContent = 'Adding\u2026';
        figure.append(busy);
    }

    return figure;
}

/* ---------- attaching a portrait ---------- */

function onClick(event) {
    const toggle = event.target.closest('[data-mz-thought]');
    if (toggle) {
        const key = toggle.dataset.mzThought;
        if (hiddenThoughts.has(key)) hiddenThoughts.delete(key);
        else hiddenThoughts.add(key);
        applyThoughts();
        return;
    }

    const bubble = event.target.closest('.mz-thought-bub');
    if (bubble) {
        bubble.classList.toggle('is-open');
        return;
    }

    const attach = event.target.closest('[data-mz-cast-attach]');
    if (attach) {
        event.preventDefault();
        choose(attach.dataset.mzCastAttach);
        return;
    }

    const remove = event.target.closest('[data-mz-cast-remove]');
    if (remove) {
        event.preventDefault();
        forget(remove.dataset.mzCastRemove);
    }
}

function choose(name) {
    if (!picker || busyName) return;
    pending = { name, chatId: currentChatId() };
    picker.value = '';
    picker.click();
}

async function onFileChosen() {
    const file = picker?.files?.[0] || null;
    const request = pending;

    pending = null;
    if (picker) picker.value = '';
    if (!file || !request) return;

    if (currentChatId() !== request.chatId) {
        notify('The chat changed before the portrait was added.', 'warning');
        return;
    }

    if (!file.type.startsWith('image/')) {
        notify('That file is not an image.', 'error');
        return;
    }

    busyName = request.name;
    busyChat = request.chatId;
    lastSignature = '';
    renderCast(lastScene);

    try {
        const prepared = await prepareImage(file);

        if (currentChatId() !== request.chatId) {
            notify('The chat changed before the portrait was added.', 'warning');
            return;
        }

        const path = await uploadImage({
            image: prepared.image,
            format: prepared.format,
            filename: fileName(request.name, prepared.format),
        });

        if (!path) throw new Error('no path returned');

        if (currentChatId() !== request.chatId) {
            notify('The chat changed before the portrait was added.', 'warning');
            return;
        }

        const status = setCastImage(request.name, path);
        announceAdded(request.name, status);
    } catch (error) {
        console.warn('[Meziverse] could not attach the portrait', error);
        notify(`Could not add a portrait for ${request.name}.`, 'error');
    } finally {
        busyName = '';
        busyChat = null;
        lastSignature = '';
        renderCast(lastScene);
    }
}

function forget(name) {
    if (!name || busyName) return;

    const status = removeCastImage(name);
    if (status === 'failed') return;

    notify(`Portrait removed for ${name}.`, 'info');
    lastSignature = '';
    renderCast(lastScene);
}

/* ---------- image preparation ---------- */

async function prepareImage(file) {
    const source = await loadImage(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) throw new Error('the image has no size');

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('the canvas is unavailable');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, outWidth, outHeight);
    source.close?.();

    const data = canvas.toDataURL('image/webp', QUALITY);
    const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(data);
    if (!match) throw new Error('the image could not be encoded');

    return {
        image: match[2],
        format: match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase(),
    };
}

function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file).catch(() => loadFromElement(file));
    }

    return loadFromElement(file);
}

function loadFromElement(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(file);

        image.addEventListener('load', () => {
            URL.revokeObjectURL(url);
            resolve(image);
        }, { once: true });

        image.addEventListener('error', () => {
            URL.revokeObjectURL(url);
            reject(new Error('the image could not be read'));
        }, { once: true });

        image.src = url;
    });
}

/* ---------- small helpers ---------- */

/**
 * Says how attaching a portrait went. The one case worth calling out is a
 * portrait stored only in memory: it is on screen now, but SillyTavern could
 * not be asked to write the chat, so it will be gone on reload.
 */
function announceAdded(name, status) {
    if (status === 'saved') {
        notify(`Portrait added for ${name}.`, 'success');
        return;
    }

    if (status === 'memory-only') {
        notify(`Portrait added for ${name}, but it could not be saved and will be lost on reload.`, 'warning');
        return;
    }

    notify(`Could not add a portrait for ${name}.`, 'error');
}

function castSignature() {
    const images = castImages();
    const chat = currentChatId() || '';
    const busy = busyName && busyChat === chat ? busyName : '';
    const cast = names
        .map(name => `${name}\u0002${images[castKey(name)] || ''}`)
        .join('\u0001');

    return `${chat}\u0003${busy}\u0003${cast}`;
}

function imageSource(path) {
    const value = typeof path === 'string' ? path.trim() : '';
    if (!value) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) return value;
    return `/${value}`;
}

function fileName(name, format) {
    const base = String(name)
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'portrait';

    return `${base}-${Date.now().toString(36)}.${format}`;
}

function hueOf(name) {
    let hash = 2166136261;

    for (const char of String(name)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }

    return Math.abs(hash) % 360;
}

function number(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function length(token, fallback) {
    const raw = getComputedStyle(host).getPropertyValue(token).trim();
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
}
