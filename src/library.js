/**
 * The Character Library: the characters the user has SAVED by name - a
 * portrait each and expression sprites through SillyTavern's own sprite
 * folders - available in every chat, instead of re-casting every session.
 *
 * Two halves, like music.js: the pure core (records, sprite payload reads,
 * portrait resolution) and its stage (the library window, the upload and
 * delete flows). Nothing here auto-adds: a record exists only because the
 * user said "Add to Character Library" on a poster. The library never
 * touches the chat file - records live in extensionSettings, sprites live
 * in SillyTavern's own folders, and the two never shadow each other.
 *
 * One naming rule runs through everything: records key on the `castKey`
 * fold (so "Mara Vane" and "mara vane" are one person) while the SPRITE
 * FOLDER is the record's display name - every sprite call passes
 * `record.name`, never the folded key.
 */

import { icon } from './icons.js';
import { castKey, chatMessages, imageSource, personaName, spriteDelete, spriteList, spriteUpload, spriteUploadZip, uploadImage } from './st.js';
import { libraryEntries, libraryEntry, removeLibraryEntry, setLibraryEntry } from './settings.js';
import { notify } from './notify.js';
import { hueOf, initials, seenNames } from './scene.js';
import { imageFileName, prepareImage } from './imageprep.js';

/* ---------- the pure core ---------- */

/**
 * The labels SillyTavern's own expression system suggests - its
 * `DEFAULT_EXPRESSIONS`, the GoEmotions set. Suggested on upload, never
 * enforced: the true label set of a character is their folder's file names.
 */
export const SUGGESTED_LABELS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring',
    'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval',
    'disgust', 'embarrassment', 'excitement', 'fear', 'gratitude', 'grief',
    'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization',
    'relief', 'remorse', 'sadness', 'surprise', 'neutral',
];

/** A library record with every field in its right shape. */
export function normalizeLibraryRecord(raw = {}) {
    return {
        name: String(raw?.name ?? '').trim(),
        portrait: String(raw?.portrait ?? '').trim(),
        addedAt: String(raw?.addedAt ?? '').trim() || new Date().toISOString(),
    };
}

/**
 * A sprite label made safe for the folder: trimmed, folded to lower case,
 * with dashes and dots gone. The server derives labels from file names at
 * the first dash or dot and wants the file to start with its label, so a
 * label may carry spaces but never those two marks.
 */
export function cleanSpriteLabel(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[-.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The file name's base as `/api/sprites/get` reports it: 'joy-1.png?t=1' → 'joy-1'. */
export function spriteNameFromPath(path) {
    const clean = String(path ?? '').split(/[?#]/)[0];
    const file = clean.slice(clean.lastIndexOf('/') + 1);
    let decoded = file;
    try {
        decoded = decodeURIComponent(file);
    } catch {
        decoded = file;
    }
    return decoded.replace(/\.[^.]+$/, '');
}

/**
 * The server's sprite listing as tidy rows - one per FILE (`joy.png` and
 * `joy-1.png` are two rows wearing the label 'joy'), sorted by label then
 * file name, so 'joy' comes before 'joy-1'. A payload that is not a list
 * answers an empty one; a malformed entry is skipped, never guessed at.
 */
export function spriteRowsFromPayload(payload) {
    if (!Array.isArray(payload)) return [];

    const rows = [];
    for (const item of payload) {
        const label = String(item?.label ?? '').trim().toLowerCase();
        const path = String(item?.path ?? '').trim();
        if (!label || !path) continue;
        rows.push({ label, spriteName: spriteNameFromPath(path), path });
    }

    rows.sort((a, b) => {
        if (a.label !== b.label) return a.label < b.label ? -1 : 1;
        return a.spriteName < b.spriteName ? -1 : a.spriteName > b.spriteName ? 1 : 0;
    });

    return rows;
}

/**
 * The first row of each label - the sprite a label resolves to when one
 * picture per expression is wanted (the later expression engine's read;
 * the window shows every row). Sorted input, so 'joy.png' beats 'joy-1.png'.
 */
export function spriteLabelMap(rows) {
    const map = new Map();
    for (const row of rows || []) {
        if (row?.label && !map.has(row.label)) map.set(row.label, row);
    }
    return map;
}

/**
 * The portrait a poster wears: the chat's own portrait when it has one,
 * then the library's, then none (the initials plate). Per-chat wins -
 * a chat that casts someone differently keeps its own face.
 */
export function resolveLibraryPortrait(key, chatImages, library) {
    const chat = chatImages?.[key];
    if (typeof chat === 'string' && chat.trim()) return chat.trim();

    const portrait = library?.[key]?.portrait;
    return typeof portrait === 'string' ? portrait.trim() : '';
}

/**
 * The records one filter view shows: 'all' is the whole library, 'chat'
 * the names any scene tag of this chat ever carried, 'scene' the ones on
 * stage right now - and the query narrows by name within whichever.
 * Sets arrive already folded to library keys; records only, name-sorted.
 */
export function visibleLibrary(entries, { query = '', filter = 'all', chatKeys = null, sceneKeys = null } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    const rows = [];

    for (const [key, record] of Object.entries(entries || {})) {
        if (!record || typeof record !== 'object') continue;
        if (filter === 'chat' && !chatKeys?.has(key)) continue;
        if (filter === 'scene' && !sceneKeys?.has(key)) continue;
        if (needle && !String(record.name ?? '').toLowerCase().includes(needle)) continue;
        rows.push(record);
    }

    rows.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));
    return rows;
}

/** The folded keys of a name list - the same fold the library keys on. */
function foldSet(names) {
    const set = new Set();
    for (const name of names || []) {
        const key = castKey(name);
        if (key) set.add(key);
    }
    return set;
}

/* ---------- the library store's one door ---------- */

const changeListeners = new Set();

/** Subscribes to library changes (records or portraits); returns the unsubscribe. */
export function onLibraryChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
}

function notifyLibraryChange() {
    for (const fn of changeListeners) {
        try {
            fn();
        } catch (error) {
            console.warn('[Meziverse] a library listener failed', error);
        }
    }
}

/**
 * Saves a character to the library - the ONLY way records are born. An
 * existing record is returned untouched (re-adding never overwrites).
 */
export function ensureInLibrary(name, portrait = '') {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return null;

    const existing = libraryEntry(trimmed);
    if (existing) return existing;

    const record = setLibraryEntry(trimmed, normalizeLibraryRecord({ name: trimmed, portrait }));
    notifyLibraryChange();
    return record;
}

function setPortrait(name, portrait) {
    setLibraryEntry(name, { portrait: String(portrait ?? '').trim() });
    notifyLibraryChange();
}

function forgetRecord(name) {
    if (removeLibraryEntry(name)) notifyLibraryChange();
}

/* ---------- sprite cache ---------- */

const SPRITE_TTL = 10 * 60 * 1000;
const spriteCache = new Map();

/** A character's sprite rows (cached briefly); [] when they have none. */
async function fetchSprites(name, force = false) {
    const key = String(name ?? '').trim();
    if (!key) return [];

    const cached = spriteCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < SPRITE_TTL) return cached.rows;

    const payload = await spriteList(key);
    if (payload === null) return cached?.rows || [];

    const rows = spriteRowsFromPayload(payload);
    spriteCache.set(key, { rows, fetchedAt: Date.now() });
    return rows;
}

function invalidateSprites(name) {
    spriteCache.delete(String(name ?? '').trim());
}

/* ---------- the window ---------- */

const WIN_HTML = `
    <header class="mz-libwin-head">
        <span class="mz-libwin-mark" aria-hidden="true"></span>
        <h2>Character Library</h2>
        <span class="mz-libwin-sum" data-mz-lib-sum></span>
        <input class="mz-select mz-lib-search" type="search" data-mz-lib-search placeholder="Search characters" aria-label="Search characters" spellcheck="false">
        <button class="mz-ibtn mz-libwin-close" type="button" data-mz-lib-close title="Close" aria-label="Close"></button>
    </header>
    <div class="mz-libwin-body">
        <div class="mz-lib-filters" role="group" aria-label="Filter characters" data-mz-lib-filters>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="all">All</button>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="chat">This chat</button>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="scene">In scene</button>
        </div>
        <div class="mz-lib-grid" data-mz-lib-grid></div>
        <div class="mz-lib-detail" data-mz-lib-detail hidden></div>
    </div>`;

let frameEl = null;
let win = null;
let els = null;
let lastFocus = null;

// What the window shows: the grid of saved characters, or one of them.
let view = { kind: 'grid' };
// The grid's search and filter, reset whenever the window opens.
let query = '';
let filter = 'all';
// The scene's present names, handed in by the scene that mounts us.
let presentNames = () => [];
// The detail's sprite rows and the staged removal, reset per character.
let detailRows = [];
let removeStage = 'idle';
// One upload in flight at a time, per window.
let busy = false;
// Row-delete arming: spriteName → timer, so a stray click never eats art.
const armTimers = new Map();

/**
 * Builds the library window where the scene keeps it: one child of the
 * frame, shown and hidden like the map window. `presentNames` hands the
 * window the scene's cast - the "In scene" filter and marks read it live.
 *
 * @param {{frame:Element, presentNames?:() => string[]}} parts
 */
export function mountLibrary({ frame, presentNames: getPresent = null } = {}) {
    if (win || !frame) return;
    frameEl = frame;
    if (typeof getPresent === 'function') presentNames = getPresent;

    win = document.createElement('section');
    win.className = 'mz-libwin';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-label', 'Character Library');
    win.setAttribute('aria-hidden', 'true');
    win.hidden = true;
    win.innerHTML = WIN_HTML;
    frame.append(win);

    els = {
        sum: win.querySelector('[data-mz-lib-sum]'),
        search: win.querySelector('[data-mz-lib-search]'),
        filters: win.querySelector('[data-mz-lib-filters]'),
        grid: win.querySelector('[data-mz-lib-grid]'),
        detail: win.querySelector('[data-mz-lib-detail]'),
    };

    win.querySelector('.mz-libwin-mark').append(icon('mz-i-library'));
    win.querySelector('.mz-libwin-close').append(icon('mz-i-close'));

    win.addEventListener('click', onClick);

    // Typing in the search leaves a character's page for the grid it
    // filters - searching from anywhere lands somewhere honest.
    els.search.addEventListener('input', () => {
        query = els.search.value;
        if (view.kind === 'detail') {
            view = { kind: 'grid' };
            resetDetail();
        }
        renderWin();
    });

    // The pickers live with the window; each remembers what it was for.
    win.append(picker('portrait', 'image/*'), picker('sprite', 'image/*'), picker('pack', '.zip,application/zip'));
}

function picker(kind, accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    input.dataset.mzLibPicker = kind;
    input.addEventListener('change', () => onFileChosen(kind, input));
    return input;
}

/** Whether the library window is on screen. */
export function isLibraryOpen() {
    return !!win && !win.hidden;
}

/**
 * Opens the library - the whole grid, or one character's page when a name
 * is given (a poster's "In library" door).
 */
export function openLibrary(name = null) {
    if (!win) return;

    const record = name ? libraryEntry(name) : null;
    view = record ? { kind: 'detail', name: record.name } : { kind: 'grid' };
    query = '';
    filter = 'all';
    if (els?.search) els.search.value = '';
    resetDetail();

    lastFocus = document.activeElement;
    win.hidden = false;
    win.setAttribute('aria-hidden', 'false');
    frameEl?.classList.add('is-libwin-open');
    renderWin();
    win.querySelector('[data-mz-lib-close]')?.focus({ preventScroll: true });
}

/** Closes the window and returns focus where it came from. */
export function closeLibrary() {
    if (!win || win.hidden) return;
    win.hidden = true;
    win.setAttribute('aria-hidden', 'true');
    frameEl?.classList.remove('is-libwin-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
}

/** The scene closed: the library window goes away whole. */
export function libraryUiClosed() {
    closeLibrary();
}

/**
 * The shown scene changed under an open window: the counts, the "In scene"
 * marks and the filters read the scene live, so they get re-read. A closed
 * window says nothing - it recomputes when it opens.
 */
export function refreshLibrary() {
    if (isLibraryOpen()) renderWin();
}

function resetDetail() {
    detailRows = [];
    removeStage = 'idle';
    for (const timer of armTimers.values()) clearTimeout(timer);
    armTimers.clear();
}

/* ---------- rendering ---------- */

function renderWin() {
    if (!win) return;

    const entries = libraryEntries();
    const keys = Object.keys(entries);
    const sceneKeys = foldSet(presentNames());
    const inScene = keys.filter(key => sceneKeys.has(key)).length;
    els.sum.textContent = keys.length ? `${keys.length} saved \u00b7 ${inScene} in scene` : '';

    const detail = view.kind === 'detail' ? libraryEntry(view.name) : null;
    if (view.kind === 'detail' && !detail) view = { kind: 'grid' };

    const showingDetail = view.kind === 'detail';
    els.grid.hidden = showingDetail;
    els.detail.hidden = !showingDetail;
    els.filters.hidden = showingDetail;

    for (const chip of win.querySelectorAll('[data-mz-lib-filter]')) {
        const on = chip.dataset.mzLibFilter === filter;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
    }

    if (showingDetail) renderDetail(detail);
    else renderGrid();
}

function renderGrid() {
    const chatKeys = foldSet(seenNames(chatMessages(), personaName()));
    const sceneKeys = foldSet(presentNames());
    const rows = visibleLibrary(libraryEntries(), { query, filter, chatKeys, sceneKeys });

    const fragment = document.createDocumentFragment();
    if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'mz-lib-empty';
        empty.textContent = query || filter !== 'all'
            ? 'No saved characters match.'
            : 'No characters yet \u2014 save one from a poster on the cast strip.';
        fragment.append(empty);
    }

    for (const record of rows) {
        fragment.append(tile(record, sceneKeys.has(castKey(record.name))));
    }

    els.grid.replaceChildren(fragment);
}

function tile(record, inScene) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-lib-tile' + (inScene ? ' is-scene' : '');
    button.dataset.mzLibName = record.name;
    button.style.setProperty('--h', `${hueOf(record.name)}deg`);

    button.append(face(record));

    if (inScene) {
        const dot = document.createElement('span');
        dot.className = 'mz-lib-dot';
        dot.title = 'In the scene now';
        dot.setAttribute('aria-hidden', 'true');
        button.append(dot);
    }

    const name = document.createElement('span');
    name.className = 'mz-lib-name';
    name.textContent = record.name;
    button.append(name);
    return button;
}

/** The portrait plate shared by tiles and the detail hero. */
function face(record) {
    const plate = document.createElement('span');
    plate.className = 'mz-lib-face';
    plate.setAttribute('aria-hidden', 'true');

    const source = imageSource(record.portrait || '');
    if (source) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.loading = 'lazy';
        image.src = source;
        image.addEventListener('error', () => {
            // The path outlived its file: fall back to the plate.
            image.remove();
            plate.classList.add('is-empty');
        });
        plate.append(image);
    } else {
        plate.classList.add('is-empty');
    }

    const monogram = document.createElement('span');
    monogram.className = 'mz-lib-initial';
    monogram.textContent = initials(record.name);
    plate.append(monogram);
    return plate;
}

function renderDetail(record) {
    const fragment = document.createDocumentFragment();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mz-lib-back';
    back.dataset.mzLibBack = '';
    back.textContent = '\u2190 All characters';
    fragment.append(back);

    const hero = document.createElement('div');
    hero.className = 'mz-lib-hero';
    hero.style.setProperty('--h', `${hueOf(record.name)}deg`);
    hero.append(face(record));

    const tools = document.createElement('div');
    tools.className = 'mz-lib-hero-tools';

    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'mz-btn-ghost';
    change.dataset.mzLibPortrait = 'change';
    change.textContent = record.portrait ? 'Change portrait' : 'Add portrait';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mz-btn-ghost is-danger';
    remove.dataset.mzLibPortrait = 'remove';
    remove.textContent = 'Remove portrait';
    remove.hidden = !record.portrait;

    tools.append(change, remove);
    hero.append(tools);
    fragment.append(hero);

    const title = document.createElement('h3');
    title.className = 'mz-lib-title';
    title.textContent = record.name;
    fragment.append(title);

    fragment.append(spritesSection(record));
    fragment.append(footSection(record));

    els.detail.replaceChildren(fragment);
    renderSpriteRows(record);
}

function spritesSection(record) {
    const section = document.createElement('section');
    section.className = 'mz-lib-sec';

    const head = document.createElement('div');
    head.className = 'mz-lib-sec-head';

    const heading = document.createElement('h4');
    heading.textContent = 'Expression sprites';

    const count = document.createElement('span');
    count.className = 'mz-lib-count';
    count.dataset.mzLibCount = '';

    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'mz-btn-ghost';
    pack.dataset.mzLibSprite = 'pack';
    pack.textContent = 'Upload pack';

    head.append(heading, count, pack);

    const bar = document.createElement('div');
    bar.className = 'mz-lib-bar';

    const select = document.createElement('select');
    select.className = 'mz-select';
    select.dataset.mzLibLabel = '';
    select.setAttribute('aria-label', 'Expression label');
    for (const label of SUGGESTED_LABELS) {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        select.append(option);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom\u2026';
    select.append(custom);

    const input = document.createElement('input');
    input.className = 'mz-select mz-lib-custom';
    input.type = 'text';
    input.dataset.mzLibCustomLabel = '';
    input.placeholder = 'label';
    input.setAttribute('aria-label', 'Custom expression label');
    input.hidden = true;
    input.spellcheck = false;

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mz-btn-ghost';
    add.dataset.mzLibSprite = 'add';
    add.textContent = 'Add sprite';

    bar.append(select, input, add);
    section.append(head, bar);

    const rows = document.createElement('div');
    rows.className = 'mz-lib-sprites';
    rows.dataset.mzLibSprites = '';
    section.append(rows);

    // The custom label's door: "Custom…" on the select.
    select.addEventListener('change', () => {
        input.hidden = select.value !== 'custom';
        if (!input.hidden) input.focus();
    });

    return section;
}

function footSection(record) {
    const foot = document.createElement('div');
    foot.className = 'mz-lib-foot';

    if (removeStage === 'idle') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mz-btn-ghost is-danger';
        remove.dataset.mzLibRemove = '';
        remove.textContent = 'Remove from library';
        foot.append(remove);
        return foot;
    }

    const ask = document.createElement('p');
    ask.className = 'mz-lib-ask';
    ask.textContent = removeStage === 'confirm'
        ? `Remove ${record.name} from the library?`
        : `Delete their ${detailRows.length} sprite${detailRows.length === 1 ? '' : 's'} too?`;

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'mz-btn-ghost is-danger';
    yes.dataset.mzLibRemove = removeStage === 'confirm' ? 'yes' : 'yes-sprites';
    yes.textContent = removeStage === 'confirm' ? 'Remove' : 'Yes, delete sprites';

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'mz-btn-ghost';
    no.dataset.mzLibRemove = removeStage === 'confirm' ? 'cancel' : 'no-sprites';
    no.textContent = removeStage === 'confirm' ? 'Cancel' : 'No, keep them';

    foot.append(ask, yes, no);
    return foot;
}

function renderSpriteRows(record) {
    const holder = els.detail.querySelector('[data-mz-lib-sprites]');
    const count = els.detail.querySelector('[data-mz-lib-count]');
    if (!holder) return;

    fetchSprites(record.name).then(rows => {
        // The window may have moved on while the listing was in flight.
        if (!win || win.hidden || view.kind !== 'detail' || view.name !== record.name) return;
        detailRows = rows;

        if (count) {
            count.textContent = rows.length
                ? `${rows.length} sprite${rows.length === 1 ? '' : 's'}`
                : 'none yet';
        }

        const fragment = document.createDocumentFragment();
        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'mz-lib-empty';
            empty.textContent = 'No sprites yet \u2014 add one, or upload a whole pack.';
            fragment.append(empty);
        }

        for (const row of rows) fragment.append(spriteRow(row));
        fragment.append(addTile());
        holder.replaceChildren(fragment);
    });
}

/**
 * One sprite as a gallery cell: the art fills the tile, the label rides
 * on it, and the delete arms on hover. The file name is the cell's title.
 */
function spriteRow(row) {
    const item = document.createElement('div');
    item.className = 'mz-lib-sprite';
    item.dataset.mzLibSpriteName = row.spriteName;
    item.title = row.spriteName;

    const image = document.createElement('img');
    image.alt = row.label;
    image.decoding = 'async';
    image.loading = 'lazy';
    image.src = imageSource(row.path);

    const label = document.createElement('span');
    label.className = 'mz-lib-sprite-label';
    label.textContent = row.label;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mz-ibtn mz-lib-sprite-del is-danger';
    del.dataset.mzLibSpriteDel = row.spriteName;
    del.title = 'Delete sprite';
    del.setAttribute('aria-label', `Delete sprite ${row.spriteName}`);
    del.append(icon('mz-i-trash'));

    item.append(image, label, del);
    return item;
}

/** The gallery's add tile - the one-by-one door, same as "Add sprite". */
function addTile() {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mz-lib-add';
    add.dataset.mzLibSprite = 'add';
    add.title = 'Add a sprite';
    add.setAttribute('aria-label', 'Add a sprite');
    add.textContent = '+';
    return add;
}

/* ---------- interaction ---------- */

function onClick(event) {
    if (!event.isTrusted) return;

    if (event.target.closest('[data-mz-lib-close]')) {
        closeLibrary();
        return;
    }

    if (event.target.closest('[data-mz-lib-back]')) {
        view = { kind: 'grid' };
        resetDetail();
        renderWin();
        return;
    }

    const chip = event.target.closest('[data-mz-lib-filter]');
    if (chip) {
        const next = chip.dataset.mzLibFilter;
        filter = next === 'chat' || next === 'scene' ? next : 'all';
        if (view.kind === 'detail') {
            view = { kind: 'grid' };
            resetDetail();
        }
        renderWin();
        return;
    }

    const tile = event.target.closest('[data-mz-lib-name]');
    if (tile) {
        const record = libraryEntry(tile.dataset.mzLibName);
        if (record) {
            view = { kind: 'detail', name: record.name };
            resetDetail();
            renderWin();
        }
        return;
    }

    const portrait = event.target.closest('[data-mz-lib-portrait]');
    if (portrait) {
        if (portrait.dataset.mzLibPortrait === 'change') openPicker('portrait');
        else if (view.kind === 'detail') {
            setPortrait(view.name, '');
            notify(`Portrait removed for ${view.name} in the library.`, 'info');
            renderWin();
        }
        return;
    }

    const sprite = event.target.closest('[data-mz-lib-sprite]');
    if (sprite) {
        if (sprite.dataset.mzLibSprite === 'add') addSpritePressed();
        else openPicker('pack');
        return;
    }

    const del = event.target.closest('[data-mz-lib-sprite-del]');
    if (del) {
        spriteDeletePressed(del.dataset.mzLibSpriteDel, del);
        return;
    }

    const remove = event.target.closest('[data-mz-lib-remove]');
    if (remove) {
        removePressed(remove.dataset.mzLibRemove || 'start');
    }
}

function openPicker(kind) {
    const input = win.querySelector(`[data-mz-lib-picker="${kind}"]`);
    if (input) {
        input.value = '';
        input.click();
    }
}

function addSpritePressed() {
    if (view.kind !== 'detail' || busy) return;

    const select = els.detail.querySelector('[data-mz-lib-label]');
    const custom = els.detail.querySelector('[data-mz-lib-custom-label]');
    const raw = select?.value === 'custom' ? custom?.value : select?.value;
    const label = cleanSpriteLabel(raw);

    if (!label) {
        notify('That sprite needs a label.', 'warning');
        return;
    }

    win.dataset.mzLibPendingLabel = label;
    openPicker('sprite');
}

async function onFileChosen(kind, input) {
    const file = input?.files?.[0] || null;
    input.value = '';
    if (!file || view.kind !== 'detail' || busy) return;

    const record = libraryEntry(view.name);
    if (!record) return;

    busy = true;

    try {
        if (kind === 'portrait') {
            const prepared = await prepareImage(file);
            const path = await uploadImage({
                image: prepared.image,
                format: prepared.format,
                filename: imageFileName(record.name, prepared.format),
            });
            if (!path) throw new Error('no path returned');
            setPortrait(record.name, path);
            notify(`Portrait saved for ${record.name}.`, 'success');
            renderWin();
        } else if (kind === 'sprite') {
            const label = cleanSpriteLabel(win.dataset.mzLibPendingLabel || '');
            delete win.dataset.mzLibPendingLabel;
            if (!label) throw new Error('no label chosen');

            const result = await spriteUpload({ name: record.name, label, spriteName: label, file });
            if (!result.ok) throw new Error(result.error || 'the sprite was refused');
            invalidateSprites(record.name);
            notify(`Sprite "${label}" saved for ${record.name}.`, 'success');
            renderWin();
        } else if (kind === 'pack') {
            const result = await spriteUploadZip({ name: record.name, file });
            if (!result.ok) throw new Error(result.error || 'the pack was refused');
            invalidateSprites(record.name);
            notify(result.count
                ? `Uploaded ${result.count} sprite${result.count === 1 ? '' : 's'} for ${record.name}.`
                : 'The pack held no images.', result.count ? 'success' : 'warning');
            renderWin();
        }
    } catch (error) {
        console.warn('[Meziverse] the library upload failed', error);
        notify(`Could not save that for ${record.name}.`, 'error');
    } finally {
        busy = false;
    }
}

/**
 * Sprite deletion is armed twice: one press arms the button ("Delete?"),
 * a second within a few seconds deletes. A stray click never eats art.
 */
function spriteDeletePressed(spriteName, button) {
    if (view.kind !== 'detail' || busy) return;

    if (armTimers.has(spriteName)) {
        clearTimeout(armTimers.get(spriteName));
        armTimers.delete(spriteName);
    } else {
        button.classList.add('is-armed');
        button.title = 'Press again to delete';
        armTimers.set(spriteName, setTimeout(() => {
            armTimers.delete(spriteName);
            button.classList.remove('is-armed');
            button.title = 'Delete sprite';
        }, 4000));
        return;
    }

    const record = libraryEntry(view.name);
    if (!record) return;

    busy = true;
    spriteDelete({ name: record.name, label: '', spriteName }).then(result => {
        busy = false;
        if (!result.ok) {
            notify('Could not delete that sprite.', 'error');
            return;
        }
        invalidateSprites(record.name);
        notify('Sprite deleted.', 'info');
        renderWin();
    });
}

/** The staged removal: idle → confirm → (sprites?) → gone. */
function removePressed(step) {
    if (view.kind !== 'detail') return;
    const record = libraryEntry(view.name);
    if (!record) return;

    if (step === 'cancel') {
        removeStage = 'idle';
        renderWin();
        return;
    }

    if (step === 'start') {
        removeStage = 'confirm';
        renderWin();
        return;
    }

    if (step === 'yes') {
        // The character goes; their sprites are offered next when they
        // have any, and left exactly as they are otherwise.
        if (detailRows.length) {
            removeStage = 'sprites';
            renderWin();
            return;
        }
        forgetRecord(record.name);
        notify(`${record.name} removed from the library.`, 'info');
        leaveDetail();
        return;
    }

    if (step === 'yes-sprites') {
        const rows = [...detailRows];
        forgetRecord(record.name);
        notify(`${record.name} removed from the library.`, 'info');
        leaveDetail();
        for (const row of rows) {
            spriteDelete({ name: record.name, label: row.label, spriteName: row.spriteName }).catch(() => {});
        }
        return;
    }

    if (step === 'no-sprites') {
        forgetRecord(record.name);
        notify(`${record.name} removed from the library. Their sprites were left as they are.`, 'info');
        leaveDetail();
    }
}

function leaveDetail() {
    view = { kind: 'grid' };
    resetDetail();
    renderWin();
}
