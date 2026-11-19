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
import { hueOf, initials, seenNameCounts } from './scene.js';
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

/**
 * The same 28 labels, regrouped into families so a board of slots is
 * scannable: Core is what the stage falls back on (label → neutral →
 * portrait), Warm and Tense are the feeling clusters, Mind the small
 * thinking set. Anything outside these 28 is a character's own custom
 * label and lives in its own family.
 */
export const EXPRESSION_FAMILIES = [
    {
        id: 'core',
        name: 'Core',
        note: 'what the stage falls back on',
        labels: ['neutral', 'joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'love'],
    },
    {
        id: 'warm',
        name: 'Warm',
        labels: ['admiration', 'amusement', 'approval', 'caring', 'desire', 'excitement', 'gratitude', 'optimism', 'pride', 'relief'],
    },
    {
        id: 'tense',
        name: 'Tense',
        labels: ['annoyance', 'disappointment', 'disapproval', 'embarrassment', 'grief', 'nervousness', 'remorse'],
    },
    {
        id: 'mind',
        name: 'Mind',
        labels: ['confusion', 'curiosity', 'realization'],
    },
];

/** The fallback family - the slots that matter most when they are empty. */
export const CORE_LABELS = EXPRESSION_FAMILIES[0].labels;

/** The family a label belongs to: 'core' | 'warm' | 'tense' | 'mind' | 'custom'. */
export function labelFamily(label) {
    const folded = cleanSpriteLabel(label);
    for (const family of EXPRESSION_FAMILIES) {
        if (family.labels.includes(folded)) return family.id;
    }
    return 'custom';
}

/**
 * The slot a dropped file's name asks for: `joy.png` → joy,
 * `sadness-2.png` (or `Sadness_2.png`) → a second sadness. The match is
 * the `cleanSpriteLabel` fold plus stripping a trailing number - the
 * number names the file, not the feeling. A name that cannot be placed
 * answers null and the file waits in the tray for the user's word.
 *
 * @param {string} fileName
 * @param {string[]} knownLabels the 28 plus any custom labels already in the folder
 * @returns {{label: string, extraIndex: number}|null} extraIndex is the
 *   trailing number (0 when none) - a second file for a label
 */
export function matchLabel(fileName, knownLabels) {
    const known = new Set();
    for (const label of knownLabels || []) {
        const folded = cleanSpriteLabel(label);
        if (folded) known.add(folded);
    }
    if (!known.size) return null;

    let base = String(fileName ?? '').split(/[?#]/)[0];
    base = base.slice(base.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    try {
        base = decodeURIComponent(base);
    } catch {
        // A name that does not decode is matched as it stands.
    }

    const numbered = base.match(/^(.*?)[-\s_]?(\d+)$/);
    const stem = (numbered ? numbered[1] : base).replace(/_/g, ' ');
    const extraIndex = numbered ? Number(numbered[2]) : 0;

    const label = cleanSpriteLabel(stem);
    return known.has(label) ? { label, extraIndex } : null;
}

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
 * How much of the 28 a sprite set covers - the numbers the cards and the
 * board's ring wear. `count` is labels among the 28 (custom labels do not
 * pad it), `core` among the fallback eight, `extra` the files beyond the
 * counted ones (a second joy, or a custom label's picture).
 */
export function spriteCoverage(rows) {
    const list = rows || [];
    const set = new Set();
    for (const row of list) {
        if (row?.label) set.add(row.label);
    }

    let count = 0;
    for (const label of SUGGESTED_LABELS) if (set.has(label)) count += 1;

    let core = 0;
    for (const label of CORE_LABELS) if (set.has(label)) core += 1;

    return { count, core, files: list.length, extra: list.length - count, set };
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
 * stage right now, 'incomplete' the ones still missing sprites - and the
 * query narrows by name within whichever. Sets arrive already folded to
 * library keys; records only, name-sorted.
 */
export function visibleLibrary(entries, { query = '', filter = 'all', chatKeys = null, sceneKeys = null, needsKeys = null } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    const rows = [];

    for (const [key, record] of Object.entries(entries || {})) {
        if (!record || typeof record !== 'object') continue;
        if (filter === 'chat' && !chatKeys?.has(key)) continue;
        if (filter === 'scene' && !sceneKeys?.has(key)) continue;
        if (filter === 'incomplete' && !needsKeys?.has(key)) continue;
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
        <div class="mz-libwin-head-mid" data-mz-lib-head></div>
        <button class="mz-ibtn mz-libwin-close" type="button" data-mz-lib-close title="Close" aria-label="Close"></button>
    </header>
    <div class="mz-libwin-body">
        <div class="mz-lib-toolbar" role="group" aria-label="Filter characters" data-mz-lib-filters>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="all">All</button>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="chat">This chat</button>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="scene">In scene</button>
            <button type="button" class="mz-lib-chip" data-mz-lib-filter="incomplete">Needs sprites</button>
        </div>
        <div class="mz-lib-grid" data-mz-lib-grid></div>
        <div class="mz-lib-detail" data-mz-lib-detail hidden></div>
    </div>`;

let frameEl = null;
let win = null;
let els = null;
let lastFocus = null;

// What the window shows: the grid of saved characters, or one of them.
// A detail view also carries the page's own state: the looked-at slot
// ({label, spriteName} or null), the board's filter, the thumbnail crop
// and whether the `…` menu is open.
let view = { kind: 'grid' };
// The grid's search and filter, reset whenever the window opens.
let query = '';
let filter = 'all';
// The new-character sheet's draft while it is open, or null.
let newDraft = null;
// Who the portrait picker is filling: 'sheet' or a record's name.
let portraitTarget = '';
// The label a picker press already knows, and the file it replaces.
let pendingLabel = '';
let pendingSpriteName = '';
// The scene's present names, handed in by the scene that mounts us.
let presentNames = () => [];
// The detail's sprite rows and the staged removal, reset per character.
let detailRows = [];
let detailLoaded = false;
let removeStage = 'idle';
// Files the names could not place: {id, file, name, url} each.
let trayItems = [];
// One upload in flight at a time, per window.
let busy = false;
// Row-delete arming: spriteName → timer, so a stray click never eats art.
const armTimers = new Map();
// Coverage fetches the grid kicked, so a card asks only once.
const coveragePending = new Set();

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
        head: win.querySelector('[data-mz-lib-head]'),
        body: win.querySelector('.mz-libwin-body'),
        filters: win.querySelector('[data-mz-lib-filters]'),
        grid: win.querySelector('[data-mz-lib-grid]'),
        detail: win.querySelector('[data-mz-lib-detail]'),
        sum: null,
        search: null,
    };

    win.querySelector('.mz-libwin-mark').append(icon('mz-i-library'));
    win.querySelector('.mz-libwin-close').append(icon('mz-i-close'));

    win.addEventListener('click', onClick);

    // Typing in the search leaves a character's page for the grid it
    // filters - searching from anywhere lands somewhere honest.
    win.addEventListener('input', event => {
        if (!event.target.closest('[data-mz-lib-search]')) return;
        query = event.target.value;
        if (view.kind === 'detail') {
            view = { kind: 'grid' };
            resetDetail();
            renderWin();
            return;
        }
        renderGrid();
    });

    // Escape closes the topmost thing first - the `…` menu, then the
    // new-character sheet. The scene's own Esc chain gets the event only
    // when nothing inside the window wants it.
    win.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (view.kind === 'detail' && view.menu) {
            event.stopPropagation();
            view.menu = false;
            win.querySelector('.mz-lib-menu')?.remove();
            return;
        }
        if (newDraft) {
            event.stopPropagation();
            newDraft = null;
            renderSheet();
        }
    });

    // The pickers live with the window; each remembers what it was for.
    win.append(picker('portrait', 'image/*'), picker('sprite', 'image/*', true), picker('pack', '.zip,application/zip'));

    // Files dragged over the board: one honest veil, and the drop does the
    // placing. Filenames pick the slot, a drop ON a slot forces it, and
    // whatever cannot be placed waits in the tray.
    win.addEventListener('dragover', event => {
        if (view.kind !== 'detail' || !hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        showDropVeil(true);
    });

    win.addEventListener('dragleave', event => {
        if (!win.contains(event.relatedTarget)) showDropVeil(false);
    });

    win.addEventListener('drop', event => {
        if (view.kind !== 'detail' || !hasFiles(event)) return;
        event.preventDefault();
        showDropVeil(false);
        for (const slot of win.querySelectorAll('.mz-lib-slot.is-over')) slot.classList.remove('is-over');
        dropPressed(event);
    });

    // A slot the file hovers lights up - the drop will go to it.
    els.detail.addEventListener('dragover', event => {
        const slot = event.target.closest?.('[data-mz-lib-slot]');
        if (!slot || !hasFiles(event)) return;
        event.preventDefault();
        for (const other of els.detail.querySelectorAll('.mz-lib-slot.is-over')) {
            if (other !== slot) other.classList.remove('is-over');
        }
        slot.classList.add('is-over');
    });
}

function picker(kind, accept, multiple = false) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
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
    view = record ? detailView(record.name) : { kind: 'grid' };
    query = '';
    filter = 'all';
    newDraft = null;
    renderSheet();
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

function detailView(name) {
    return { kind: 'detail', name, sel: null, boardFilter: 'all', fit: 'face', menu: false };
}

function resetDetail() {
    detailRows = [];
    detailLoaded = false;
    removeStage = 'idle';
    for (const timer of armTimers.values()) clearTimeout(timer);
    armTimers.clear();
    for (const item of trayItems) URL.revokeObjectURL(item.url);
    trayItems = [];
    pendingLabel = '';
    pendingSpriteName = '';
}

/* ---------- rendering ---------- */

function renderWin() {
    if (!win) return;

    const detail = view.kind === 'detail' ? libraryEntry(view.name) : null;
    if (view.kind === 'detail' && !detail) view = { kind: 'grid' };

    const showingDetail = view.kind === 'detail';
    els.grid.hidden = showingDetail;
    els.detail.hidden = !showingDetail;
    els.filters.hidden = showingDetail;
    els.body.classList.toggle('is-detail', showingDetail);

    renderHead();

    for (const chip of win.querySelectorAll('[data-mz-lib-filter]')) {
        const on = chip.dataset.mzLibFilter === filter;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
    }

    win.querySelector('.mz-lib-menu')?.remove();
    if (showingDetail) {
        renderDetail(detail);
        if (view.menu) renderMenu();
    } else {
        renderGrid();
    }
}

/**
 * The head follows the view: the grid's title with its search box, or the
 * breadcrumb whose first half is the way back.
 */
function renderHead() {
    if (view.kind !== 'detail') {
        const entries = libraryEntries();
        const keys = Object.keys(entries);
        const sceneKeys = foldSet(presentNames());
        const inScene = keys.filter(key => sceneKeys.has(key)).length;

        els.head.innerHTML =
            `<h2>Character Library</h2>
            <span class="mz-libwin-sum"></span>
            <input class="mz-select mz-lib-search" type="search" data-mz-lib-search placeholder="Search characters" aria-label="Search characters" spellcheck="false">`;

        els.sum = els.head.querySelector('.mz-libwin-sum');
        els.search = els.head.querySelector('[data-mz-lib-search]');
        els.sum.textContent = keys.length ? `${keys.length} saved \u00b7 ${inScene} in scene` : '';
        els.search.value = query;
        return;
    }

    els.head.innerHTML =
        `<div class="mz-libwin-crumb"><button type="button" data-mz-lib-back>Character Library</button><i>/</i><b></b></div>
        <span class="mz-libwin-sum"></span>
        <button class="mz-ibtn mz-libwin-menu" type="button" data-mz-lib-menu title="More" aria-label="More"></button>`;

    els.head.querySelector('.mz-libwin-crumb b').textContent = String(view.name ?? '');
    els.head.querySelector('[data-mz-lib-menu]').append(icon('mz-i-dots'));
    els.sum = els.head.querySelector('.mz-libwin-sum');
    els.search = null;
}

/** The header's quiet overflow: removal lives here, not in the page's foot. */
function renderMenu() {
    const menu = document.createElement('div');
    menu.className = 'mz-lib-menu';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.mzLibMenuItem = 'copy';
    copy.append(icon('mz-i-copy'), document.createTextNode('Copy name for scene tags'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'is-danger';
    remove.dataset.mzLibMenuItem = 'remove';
    remove.append(icon('mz-i-trash'), document.createTextNode('Remove from library\u2026'));

    menu.append(copy, remove);
    win.append(menu);
}

function renderGrid() {
    const entries = libraryEntries();
    const sceneKeys = foldSet(presentNames());
    const counts = seenNameCounts(chatMessages(), personaName());
    const chatKeys = foldSet(counts.map(row => row.name));

    // Coverage the cache knows now; the rest arrives and patches its card.
    const needsKeys = new Set();
    for (const [key, record] of Object.entries(entries)) {
        const rows = peekSprites(record.name);
        if (rows === null) {
            ensureCoverage(record.name);
            needsKeys.add(key);
            continue;
        }
        if (spriteCoverage(rows).count < SUGGESTED_LABELS.length) needsKeys.add(key);
    }

    const rows = visibleLibrary(entries, { query, filter, chatKeys, sceneKeys, needsKeys });
    const inScene = [];
    const rest = [];
    for (const record of rows) {
        (sceneKeys.has(castKey(record.name)) ? inScene : rest).push(record);
    }

    const needle = query.trim();
    const plain = !needle && filter === 'all';
    const showSeen = (filter === 'all' || filter === 'chat') && !needle
        ? counts.filter(row => !libraryEntry(row.name))
        : [];

    const fragment = document.createDocumentFragment();

    if (inScene.length) {
        fragment.append(shelf('In the scene', String(inScene.length), cardGrid(inScene, sceneKeys)));
    }

    if (rest.length || plain) {
        const grid = cardGrid(rest, sceneKeys);
        if (plain) grid.append(newCard());
        fragment.append(shelf('Library', String(rest.length), grid));
    }

    if (showSeen.length) {
        const seen = document.createElement('div');
        seen.className = 'mz-lib-seen';
        for (const row of showSeen) seen.append(seenRow(row));
        fragment.append(shelf('Seen in this chat \u00b7 not saved', String(showSeen.length), seen));
    }

    if (!inScene.length && !rest.length && !showSeen.length) {
        const empty = document.createElement('p');
        empty.className = 'mz-lib-empty';
        empty.textContent = filter === 'incomplete'
            ? 'No one is missing sprites.'
            : needle || filter !== 'all'
                ? 'No saved characters match.'
                : 'No characters yet \u2014 save one from a poster, or make one here.';
        fragment.append(empty);
    }

    els.grid.replaceChildren(fragment);
}

function shelf(title, count, content) {
    const section = document.createElement('section');
    section.className = 'mz-lib-shelf';

    const head = document.createElement('div');
    head.className = 'mz-lib-shelf-head';

    const heading = document.createElement('h4');
    heading.textContent = title;

    const number = document.createElement('span');
    number.textContent = count;

    head.append(heading, number);
    section.append(head, content);
    return section;
}

function cardGrid(records, sceneKeys) {
    const grid = document.createElement('div');
    grid.className = 'mz-lib-grid';
    for (const record of records) {
        grid.append(card(record, sceneKeys.has(castKey(record.name))));
    }
    return grid;
}

/** One card: the portrait fills it, the name and coverage ride the scrim. */
function card(record, inScene) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-lib-card';
    button.dataset.mzLibName = record.name;
    button.style.setProperty('--h', `${hueOf(record.name)}deg`);
    button.append(face(record));

    if (inScene) {
        const live = document.createElement('span');
        live.className = 'mz-lib-live';
        live.textContent = 'In scene';
        button.append(live);
    }

    const info = document.createElement('span');
    info.className = 'mz-lib-card-info';

    const name = document.createElement('span');
    name.className = 'mz-lib-card-name';
    name.textContent = record.name;

    info.append(name, cardMeta(record.name));
    button.append(info);
    return button;
}

/** The coverage line a card wears: "9/28" and its bar, or "No sprites yet". */
function cardMeta(name) {
    const meta = document.createElement('span');
    meta.className = 'mz-lib-card-meta';
    meta.dataset.mzLibMeta = name;
    paintMeta(meta, peekSprites(name));
    return meta;
}

function paintMeta(meta, rows) {
    meta.replaceChildren();
    if (rows === null) {
        meta.textContent = '\u2026';
        return;
    }

    const coverage = spriteCoverage(rows);
    if (!coverage.files) {
        meta.classList.add('is-none');
        meta.textContent = 'No sprites yet';
        return;
    }

    meta.classList.remove('is-none');
    const count = document.createElement('span');
    count.textContent = `${coverage.count}/28`;

    const bar = document.createElement('span');
    bar.className = 'mz-lib-bar-mini';
    bar.style.setProperty('--fill', `${(coverage.count / SUGGESTED_LABELS.length) * 100}%`);
    bar.append(document.createElement('i'));

    meta.append(count, bar);
}

/** The sprite rows the cache already holds, or null when unheard-of. */
function peekSprites(name) {
    const cached = spriteCache.get(String(name ?? '').trim());
    return cached ? cached.rows : null;
}

function hasFiles(event) {
    return [...(event.dataTransfer?.types || [])].includes('Files');
}

/** The veil a dragged file wears over the board: one dashed sheet. */
function showDropVeil(on) {
    const existing = win.querySelector('.mz-lib-dropveil');
    if (!on) {
        existing?.remove();
        return;
    }
    if (existing) return;

    const veil = document.createElement('div');
    veil.className = 'mz-lib-dropveil';
    veil.innerHTML = '<b>Drop to add sprites</b><span>Filenames pick the slot \u2014 joy.png, sadness-2.png. A .zip works too.</span>';
    win.append(veil);
}

/** A drop on the board: zips unpack, images find their slot. */
function dropPressed(event) {
    if (view.kind !== 'detail') return;
    const record = libraryEntry(view.name);
    if (!record) return;

    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;

    const zips = files.filter(file => /\.zip$/i.test(file.name));
    const images = files.filter(file => !/\.zip$/i.test(file.name));
    const slot = event.target?.closest?.('[data-mz-lib-slot]');

    busy = true;
    const work = [];

    if (zips.length) {
        work.push(spriteUploadZip({ name: record.name, file: zips[0] }).then(result => {
            if (!result.ok) throw new Error(result.error || 'the pack was refused');
            invalidateSprites(record.name);
            notify(result.count
                ? `Uploaded ${result.count} sprite${result.count === 1 ? '' : 's'} for ${record.name}.`
                : 'The pack held no images.', result.count ? 'success' : 'warning');
        }));
    }

    if (images.length) {
        work.push(uploadSpriteFiles(record, images, slot?.dataset?.mzLibSlot || '', ''));
    }

    Promise.all(work)
        .catch(error => {
            console.warn('[Meziverse] the library drop failed', error);
            notify(`Could not save that for ${record.name}.`, 'error');
        })
        .then(() => {
            busy = false;
            renderWin();
        });
}

/**
 * The grid's quiet bookkeeping: a card asks for its coverage once, and
 * the number lands on the card when the listing answers. The "Needs
 * sprites" filter re-renders whole - a card can leave it.
 */
function ensureCoverage(name) {
    const key = String(name ?? '').trim();
    if (!key || coveragePending.has(key)) return;
    coveragePending.add(key);

    fetchSprites(key).then(() => {
        coveragePending.delete(key);
        if (!win || win.hidden || view.kind !== 'grid') return;

        if (filter === 'incomplete') {
            renderGrid();
            return;
        }
        for (const meta of win.querySelectorAll('[data-mz-lib-meta]')) {
            if (meta.dataset.mzLibMeta === key) paintMeta(meta, peekSprites(key));
        }
    });
}

/** One "seen in this chat" row: the name, its turns, one-tap Save. */
function seenRow(entry) {
    const row = document.createElement('div');
    row.className = 'mz-lib-seen-row';
    row.style.setProperty('--h', `${hueOf(entry.name)}deg`);
    row.append(face({ name: entry.name, portrait: '' }));

    const who = document.createElement('b');
    who.textContent = entry.name;
    const turns = document.createElement('small');
    turns.textContent = `named in ${entry.count} turn${entry.count === 1 ? '' : 's'}`;
    who.append(turns);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mz-btn-ghost';
    save.dataset.mzLibSeenSave = entry.name;
    save.textContent = 'Save';

    row.append(who, save);
    return row;
}

/** The "new character" card - the way in that is not a poster. */
function newCard() {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mz-lib-new';
    add.dataset.mzLibNew = '';
    add.append(icon('mz-i-plus'));

    const label = document.createElement('span');
    label.textContent = 'New character';
    add.append(label);
    return add;
}

/**
 * The new-character sheet: a name, an optional photo, Create. The face
 * plate IS the photo door.
 */
function renderSheet() {
    win?.querySelector('.mz-lib-scrim')?.remove();
    if (!win || !newDraft) return;

    const scrim = document.createElement('div');
    scrim.className = 'mz-lib-scrim';

    const sheet = document.createElement('div');
    sheet.className = 'mz-lib-sheet';

    const photo = document.createElement('button');
    photo.type = 'button';
    photo.className = 'mz-lib-sheet-photo';
    photo.dataset.mzLibSheet = 'photo';
    photo.title = 'Add a photo';
    const plate = face({ name: newDraft.name || '', portrait: newDraft.portrait });
    if (!newDraft.portrait) {
        plate.classList.add('is-empty');
        plate.querySelector('.mz-lib-initial').textContent = '+ photo';
    }
    photo.append(plate);

    const body = document.createElement('div');

    const title = document.createElement('h3');
    title.textContent = 'New character';

    const note = document.createElement('p');
    note.textContent = 'Saved by name. Whenever a scene tag says this name, the library knows them.';

    const label = document.createElement('label');
    label.textContent = 'Name';
    const input = document.createElement('input');
    input.className = 'mz-select';
    input.dataset.mzLibSheetName = '';
    input.value = newDraft.name;
    input.setAttribute('aria-label', 'Character name');
    input.spellcheck = false;
    input.addEventListener('input', () => { newDraft.name = input.value; });
    label.append(input);

    const actions = document.createElement('div');
    actions.className = 'mz-lib-sheet-act';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mz-btn-ghost';
    cancel.dataset.mzLibSheet = 'cancel';
    cancel.textContent = 'Cancel';

    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'mz-lib-primary';
    create.dataset.mzLibSheet = 'create';
    create.textContent = 'Create';

    actions.append(cancel, create);
    body.append(title, note, label, actions);
    sheet.append(photo, body);
    scrim.append(sheet);
    win.append(scrim);

    // The scrim behind the sheet is the Cancel door too.
    scrim.addEventListener('click', event => {
        if (event.target !== scrim) return;
        newDraft = null;
        renderSheet();
    });

    input.focus();
}

function createPressed() {
    const name = String(newDraft?.name ?? '').trim();
    if (!name) {
        notify('A character needs a name.', 'warning');
        return;
    }

    const record = ensureInLibrary(name, newDraft.portrait);
    newDraft = null;
    renderSheet();
    if (!record) return;

    notify(`${record.name} saved to the library.`, 'success');
    view = { kind: 'detail', name: record.name };
    resetDetail();
    renderWin();
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

/* ---------- one character's page: the stage and the board ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function savedLine(iso) {
    const date = new Date(String(iso ?? ''));
    if (Number.isNaN(date.getTime())) return '';
    return `Saved ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The row the stage is showing: the selected sprite, or the portrait. */
function selectedRow() {
    if (!view.sel) return null;
    return detailRows.find(row => row.label === view.sel.label && row.spriteName === view.sel.spriteName) || null;
}

function renderDetail(record) {
    els.detail.style.setProperty('--h', `${hueOf(record.name)}deg`);
    els.detail.replaceChildren(buildStage(record), buildBoard(record));
    loadDetailRows(record);
}

/** The page's left: the big preview, the name, the tools - the stage. */
function buildStage(record) {
    const stage = document.createElement('aside');
    stage.className = 'mz-lib-stage';

    const row = selectedRow();

    const preview = document.createElement('div');
    preview.className = 'mz-lib-preview';
    const source = row ? imageSource(row.path) : imageSource(record.portrait || '');
    if (source) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.src = source;
        image.addEventListener('error', () => {
            // The path outlived its file: fall back to the plate.
            image.remove();
            preview.classList.add('is-empty');
        });
        preview.append(image);
    } else {
        preview.classList.add('is-empty');
    }

    const monogram = document.createElement('span');
    monogram.className = 'mz-lib-initial';
    monogram.textContent = initials(record.name);
    preview.append(monogram);

    const tag = document.createElement('span');
    tag.className = 'mz-lib-preview-tag' + (row ? ' is-label' : '');
    tag.textContent = row ? row.label : 'Portrait';
    preview.append(tag);

    const who = document.createElement('div');
    who.className = 'mz-lib-who';

    const title = document.createElement('h3');
    title.className = 'mz-lib-title';
    title.textContent = record.name;

    const meta = document.createElement('div');
    meta.className = 'mz-lib-who-meta';
    if (foldSet(presentNames()).has(castKey(record.name))) {
        const live = document.createElement('span');
        live.className = 'is-live';
        live.textContent = 'In the scene now';
        meta.append(live);
    }
    const saved = document.createElement('span');
    saved.textContent = savedLine(record.addedAt);
    meta.append(saved);
    who.append(title, meta);

    const tools = document.createElement('div');
    tools.className = 'mz-lib-stage-tools';
    if (row) {
        tools.append(
            toolButton('sprite-replace', 'mz-i-swap', 'Replace'),
            toolButton('sprite-portrait', 'mz-i-face', 'Use as portrait'),
            toolButton('sprite-delete', 'mz-i-trash', 'Delete', 'is-danger'),
        );
    } else {
        tools.append(toolButton('portrait-change', 'mz-i-camera', record.portrait ? 'Change portrait' : 'Add portrait'));
        if (record.portrait) tools.append(toolButton('portrait-remove', 'mz-i-trash', 'Remove portrait', 'is-danger'));
    }

    const note = document.createElement('p');
    note.className = 'mz-lib-stage-note';
    note.textContent = row
        ? `Stored as ${row.spriteName}. Click another slot to compare.`
        : 'Click any slot to look at it here.';

    stage.append(preview, who, tools, note);
    if (removeStage !== 'idle') stage.append(removeBox(record));
    return stage;
}

function toolButton(action, glyph, label, extra = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-btn-ghost' + (extra ? ` ${extra}` : '');
    button.dataset.mzLibTool = action;
    button.append(icon(glyph), document.createTextNode(label));
    return button;
}

/** The staged removal, kept out of the page's foot: idle → confirm → (sprites?) → gone. */
function removeBox(record) {
    const box = document.createElement('div');
    box.className = 'mz-lib-stage-ask';

    const ask = document.createElement('p');
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

    box.append(ask, yes, no);
    return box;
}

/** The page's right: the expression board - every label, filled or empty. */
function buildBoard(record) {
    const board = document.createElement('div');
    board.className = 'mz-lib-board';
    board.dataset.fit = view.fit;

    board.append(boardHead(record), boardBar());

    const scroll = document.createElement('div');
    scroll.className = 'mz-lib-boardscroll';
    scroll.dataset.mzLibScroll = '';
    board.append(scroll);

    fillBoard(scroll, record);
    return board;
}

function boardHead(record) {
    const head = document.createElement('div');
    head.className = 'mz-lib-boardhead';

    const coverage = spriteCoverage(detailRows);
    const circ = 2 * Math.PI * 19;

    const ring = document.createElement('div');
    ring.className = 'mz-lib-ring';
    ring.innerHTML = `<svg viewBox="0 0 46 46" aria-hidden="true"><circle class="t" cx="23" cy="23" r="19"/><circle class="f" cx="23" cy="23" r="19" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - coverage.count / SUGGESTED_LABELS.length)).toFixed(1)}"/></svg>`;
    const number = document.createElement('b');
    number.textContent = String(coverage.count);
    ring.append(number);

    const cover = document.createElement('div');
    cover.className = 'mz-lib-cover';
    const heading = document.createElement('h3');
    heading.textContent = 'Expressions';
    const line = document.createElement('p');
    const of = document.createElement('span');
    of.textContent = `${coverage.count} of ${SUGGESTED_LABELS.length} \u00b7 `;
    const core = document.createElement('em');
    core.textContent = `core ${coverage.core} of ${CORE_LABELS.length}`;
    line.append(of, core);
    if (coverage.extra > 0) {
        line.append(document.createTextNode(` \u00b7 ${coverage.extra} extra file${coverage.extra === 1 ? '' : 's'}`));
    }
    cover.append(heading, line);

    const tools = document.createElement('div');
    tools.className = 'mz-lib-boardtools';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mz-btn-ghost';
    add.dataset.mzLibSprite = 'add';
    add.append(icon('mz-i-image'), document.createTextNode('Add files'));
    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'mz-btn-ghost';
    pack.dataset.mzLibSprite = 'pack';
    pack.append(icon('mz-i-upload'), document.createTextNode('Upload .zip'));
    tools.append(add, pack);

    head.append(ring, cover, tools);
    return head;
}

function boardBar() {
    const bar = document.createElement('div');
    bar.className = 'mz-lib-bar2';

    const seg = document.createElement('div');
    seg.className = 'mz-lib-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Filter slots');
    const coverage = spriteCoverage(detailRows);
    const total = SUGGESTED_LABELS.length;
    for (const [key, label] of [['all', `All ${total}`], ['missing', `Missing ${total - coverage.count}`], ['filled', `Filled ${coverage.count}`]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mzLibBoardFilter = key;
        button.textContent = label;
        button.classList.toggle('is-on', view.boardFilter === key);
        seg.append(button);
    }

    const spacer = document.createElement('span');
    spacer.className = 'mz-lib-spacer';

    const hint = document.createElement('span');
    hint.className = 'mz-lib-hint';
    hint.textContent = 'Drop files anywhere on the board';

    const fit = document.createElement('div');
    fit.className = 'mz-lib-seg';
    fit.setAttribute('role', 'group');
    fit.setAttribute('aria-label', 'Thumbnail crop');
    for (const key of ['face', 'full']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mzLibFit = key;
        button.textContent = key === 'face' ? 'Face' : 'Full';
        button.classList.toggle('is-on', view.fit === key);
        fit.append(button);
    }

    bar.append(seg, spacer, hint, fit);
    return bar;
}

/**
 * The board's scroll: the tray first (files the names could not place),
 * then the drop panel when the set is empty, then the families of slots.
 */
function fillBoard(scroll, record) {
    const fragment = document.createDocumentFragment();

    if (trayItems.length) fragment.append(trayBox());
    if (!detailRows.length && detailLoaded) fragment.append(dropPanel());

    const custom = [...new Set(detailRows.map(row => row.label))]
        .filter(label => labelFamily(label) === 'custom')
        .sort();

    const families = [...EXPRESSION_FAMILIES];
    if (custom.length) families.push({ id: 'custom', name: 'Custom', labels: custom });

    const coverage = spriteCoverage(detailRows);
    for (const family of families) {
        const labels = family.labels.filter(label => {
            const has = coverage.set.has(label);
            return view.boardFilter === 'all' || (view.boardFilter === 'missing' ? !has : has);
        });
        if (!labels.length) continue;
        fragment.append(famSection(family, labels, coverage));
    }

    scroll.replaceChildren(fragment);
}

function famSection(family, labels, coverage) {
    const section = document.createElement('div');
    section.className = 'mz-lib-fam';

    const head = document.createElement('div');
    head.className = 'mz-lib-fam-head';

    const name = document.createElement('h5');
    name.textContent = family.name;

    const have = family.labels.filter(label => coverage.set.has(label)).length;
    const count = document.createElement('span');
    count.textContent = `${have}/${family.labels.length}`;
    count.classList.toggle('is-full', have === family.labels.length);

    const note = document.createElement('p');
    note.textContent = family.note || '';

    head.append(name, count, note);

    const slots = document.createElement('div');
    slots.className = 'mz-lib-slots';
    for (const label of labels) slots.append(slotCell(label, family.id === 'core'));
    if (family.id === 'custom' && view.boardFilter !== 'filled') slots.append(customTile());

    section.append(head, slots);
    return section;
}

/**
 * One slot: the face when the label has a picture, a dashed outline that
 * waits when it does not. Clicking a filled slot looks at it on the stage
 * (again to cycle its files); clicking a missing one opens the picker
 * with the label already set.
 */
function slotCell(label, core) {
    const mine = detailRows.filter(row => row.label === label);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mzLibSlot = label;

    if (!mine.length) {
        button.className = 'mz-lib-slot is-missing' + (core ? ' is-core' : '');
        button.title = `Add ${label}`;
        button.setAttribute('aria-label', `Add a sprite for ${label}`);
        button.innerHTML = '<svg class="mz-lib-ghost" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
        const name = document.createElement('span');
        name.className = 'mz-lib-slot-label';
        name.textContent = label;
        button.append(name);
        return button;
    }

    button.className = 'mz-lib-slot is-filled' + (view.sel?.label === label ? ' is-sel' : '');
    button.title = mine.map(row => row.spriteName).join(', ');
    button.setAttribute('aria-label', `Look at ${label}`);

    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    const shown = view.sel?.label === label
        ? mine.find(row => row.spriteName === view.sel.spriteName) || mine[0]
        : mine[0];
    image.src = imageSource(shown.path);
    button.append(image);

    if (mine.length > 1) {
        const stack = document.createElement('span');
        stack.className = 'mz-lib-stack';
        stack.textContent = `\u00d7${mine.length}`;
        button.append(stack);
    }

    const name = document.createElement('span');
    name.className = 'mz-lib-slot-label';
    name.textContent = label;
    button.append(name);
    return button;
}

/** The custom family's own door: name a label outside the 28. */
function customTile() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mz-lib-slot is-missing';
    button.dataset.mzLibCustom = '';
    button.title = 'Add a custom label';
    button.setAttribute('aria-label', 'Add a custom label');
    button.innerHTML = '<svg class="mz-lib-ghost" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const name = document.createElement('span');
    name.className = 'mz-lib-slot-label';
    name.textContent = 'custom\u2026';
    button.append(name);
    return button;
}

/**
 * The page's rows arrive from the listing; when they land, the board
 * repaints. The window may have moved on while the listing was in flight.
 */
function loadDetailRows(record) {
    detailLoaded = peekSprites(record.name) !== null;
    detailRows = peekSprites(record.name) || [];

    fetchSprites(record.name).then(rows => {
        if (!win || win.hidden || view.kind !== 'detail' || view.name !== record.name) return;
        detailRows = rows;
        detailLoaded = true;

        // A selection can outlive its file.
        if (view.sel && !rows.some(row => row.spriteName === view.sel.spriteName)) view.sel = null;

        renderDetail(record);
    });
}

/** Files the names could not place: a thumb, the name, one label picker each. */
function trayBox() {
    const box = document.createElement('div');
    box.className = 'mz-lib-tray';

    const head = document.createElement('div');
    head.className = 'mz-lib-tray-head';

    const title = document.createElement('b');
    title.textContent = `${trayItems.length} file${trayItems.length === 1 ? '' : 's'} need${trayItems.length === 1 ? 's' : ''} a label`;

    const note = document.createElement('span');
    note.textContent = 'Pick one, or drag the picture onto a slot.';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'mz-btn-ghost';
    dismiss.dataset.mzLibTrayDismiss = '';
    dismiss.textContent = 'Dismiss';

    head.append(title, note, dismiss);

    const row = document.createElement('div');
    row.className = 'mz-lib-tray-row';
    for (const item of trayItems) row.append(trayItem(item));

    box.append(head, row);
    return box;
}

function trayItem(item) {
    const wrap = document.createElement('div');
    wrap.className = 'mz-lib-tray-item';

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const image = document.createElement('img');
    image.alt = '';
    image.src = item.url;
    thumb.append(image);

    const side = document.createElement('div');
    const name = document.createElement('small');
    name.textContent = item.name;

    const select = document.createElement('select');
    select.className = 'mz-select';
    select.dataset.mzLibTrayPick = item.id;
    select.setAttribute('aria-label', `Label for ${item.name}`);
    const choose = document.createElement('option');
    choose.value = '';
    choose.textContent = 'Choose label\u2026';
    select.append(choose);
    for (const label of SUGGESTED_LABELS) {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        select.append(option);
    }
    const other = document.createElement('option');
    other.value = 'custom';
    other.textContent = 'Custom\u2026';
    select.append(other);

    select.addEventListener('change', () => {
        if (select.value === 'custom') {
            // A custom label: a small input replaces the picker.
            const input = document.createElement('input');
            input.className = 'mz-select mz-lib-custom';
            input.type = 'text';
            input.placeholder = 'label';
            input.setAttribute('aria-label', `Custom label for ${item.name}`);
            input.spellcheck = false;
            select.replaceWith(input);
            input.focus();
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                trayLabelChosen(item.id, cleanSpriteLabel(input.value));
            });
            return;
        }
        if (select.value) trayLabelChosen(item.id, select.value);
    });

    side.append(name, select);
    wrap.append(thumb, side);
    return wrap;
}

/** The empty set's door: one big panel that explains the naming rule. */
function dropPanel() {
    const panel = document.createElement('div');
    panel.className = 'mz-lib-drop';
    panel.innerHTML =
        `<b>Drop the sprites here</b>
        <p>Images or a .zip. Filenames pick the slot: <code>joy.png</code> \u2192 joy, <code>sadness-2.png</code> \u2192 a second sadness. Anything the names can't place waits for you to choose.</p>`;

    panel.prepend(icon('mz-i-upload'));

    const tools = document.createElement('div');
    tools.className = 'mz-lib-drop-tools';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mz-btn-ghost';
    add.dataset.mzLibSprite = 'add';
    add.textContent = 'Add files\u2026';
    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'mz-btn-ghost';
    pack.dataset.mzLibSprite = 'pack';
    pack.textContent = 'Upload .zip';
    tools.append(add, pack);
    panel.append(tools);

    return panel;
}

/* ---------- interaction ---------- */

function onClick(event) {
    if (!event.isTrusted) return;

    if (event.target.closest('[data-mz-lib-close]')) {
        closeLibrary();
        return;
    }

    // The `…` menu closes on any click outside it - and the click still
    // lands on whatever was pressed.
    const menuButton = event.target.closest('[data-mz-lib-menu]');
    const inMenu = event.target.closest('.mz-lib-menu');
    if (view.kind === 'detail' && view.menu && !menuButton && !inMenu) {
        view.menu = false;
        win.querySelector('.mz-lib-menu')?.remove();
    }

    if (menuButton) {
        view.menu = !view.menu;
        if (view.menu) renderMenu();
        else win.querySelector('.mz-lib-menu')?.remove();
        return;
    }

    const menuItem = event.target.closest('[data-mz-lib-menu-item]');
    if (menuItem) {
        view.menu = false;
        win.querySelector('.mz-lib-menu')?.remove();
        if (menuItem.dataset.mzLibMenuItem === 'copy') {
            const name = String(view.name ?? '');
            navigator.clipboard?.writeText(name).then(
                () => notify(`"${name}" copied - paste it into a scene tag.`, 'success'),
                () => notify('Could not reach the clipboard.', 'warning'),
            );
        } else {
            removePressed('start');
        }
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
        filter = next === 'chat' || next === 'scene' || next === 'incomplete' ? next : 'all';
        if (view.kind === 'detail') {
            view = { kind: 'grid' };
            resetDetail();
        }
        renderWin();
        return;
    }

    const sheet = event.target.closest('[data-mz-lib-sheet]');
    if (sheet) {
        const step = sheet.dataset.mzLibSheet;
        if (step === 'cancel') {
            newDraft = null;
            renderSheet();
        } else if (step === 'photo') {
            portraitTarget = 'sheet';
            openPicker('portrait');
        } else if (step === 'create') {
            createPressed();
        }
        return;
    }

    const seen = event.target.closest('[data-mz-lib-seen-save]');
    if (seen) {
        const record = ensureInLibrary(seen.dataset.mzLibSeenSave);
        if (record) notify(`${record.name} saved to the library.`, 'success');
        renderWin();
        return;
    }

    if (event.target.closest('[data-mz-lib-new]')) {
        newDraft = { name: '', portrait: '' };
        renderSheet();
        return;
    }

    const tile = event.target.closest('[data-mz-lib-name]');
    if (tile) {
        const record = libraryEntry(tile.dataset.mzLibName);
        if (record) {
            view = detailView(record.name);
            resetDetail();
            renderWin();
        }
        return;
    }

    const tool = event.target.closest('[data-mz-lib-tool]');
    if (tool) {
        toolPressed(tool.dataset.mzLibTool);
        return;
    }

    const slot = event.target.closest('[data-mz-lib-slot]');
    if (slot) {
        slotPressed(slot.dataset.mzLibSlot);
        return;
    }

    const custom = event.target.closest('[data-mz-lib-custom]');
    if (custom) {
        customPressed(custom);
        return;
    }

    const boardFilter = event.target.closest('[data-mz-lib-board-filter]');
    if (boardFilter) {
        view.boardFilter = boardFilter.dataset.mzLibBoardFilter;
        renderWin();
        return;
    }

    const fit = event.target.closest('[data-mz-lib-fit]');
    if (fit) {
        view.fit = fit.dataset.mzLibFit;
        renderWin();
        return;
    }

    const dismiss = event.target.closest('[data-mz-lib-tray-dismiss]');
    if (dismiss) {
        for (const item of trayItems) URL.revokeObjectURL(item.url);
        trayItems = [];
        renderWin();
        return;
    }

    const sprite = event.target.closest('[data-mz-lib-sprite]');
    if (sprite) {
        if (sprite.dataset.mzLibSprite === 'add') {
            pendingLabel = '';
            pendingSpriteName = '';
            openPicker('sprite');
        } else {
            openPicker('pack');
        }
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

/** A sprite path with its cache-buster gone - safe to store as a portrait. */
function cleanPath(path) {
    return String(path ?? '').split(/[?#]/)[0];
}

function toolPressed(action) {
    if (view.kind !== 'detail') return;
    const record = libraryEntry(view.name);
    if (!record) return;

    if (action === 'portrait-change') {
        portraitTarget = '';
        openPicker('portrait');
    } else if (action === 'portrait-remove') {
        setPortrait(record.name, '');
        notify(`Portrait removed for ${record.name} in the library.`, 'info');
        renderWin();
    } else if (action === 'sprite-replace') {
        const row = selectedRow();
        if (!row) return;
        pendingLabel = row.label;
        pendingSpriteName = row.spriteName;
        openPicker('sprite');
    } else if (action === 'sprite-portrait') {
        const row = selectedRow();
        if (!row) return;
        setPortrait(record.name, cleanPath(row.path));
        notify(`"${row.label}" is now ${record.name}'s portrait.`, 'success');
        renderWin();
    } else if (action === 'sprite-delete') {
        spriteDeletePressed();
    }
}

/**
 * Clicking a slot looks at it on the stage; clicking again steps through
 * its files, and after the last one goes back to the portrait. A missing
 * slot opens the picker with its label already set - no dropdown.
 */
function slotPressed(label) {
    if (view.kind !== 'detail') return;

    const mine = detailRows.filter(row => row.label === label);
    if (!mine.length) {
        pendingLabel = label;
        pendingSpriteName = '';
        openPicker('sprite');
        return;
    }

    if (view.sel?.label !== label) {
        view.sel = { label, spriteName: mine[0].spriteName };
    } else {
        const index = mine.findIndex(row => row.spriteName === view.sel.spriteName);
        view.sel = index < mine.length - 1
            ? { label, spriteName: mine[index + 1].spriteName }
            : null;
    }
    renderWin();
}

/** The custom door: name a label outside the 28, then pick its picture. */
function customPressed(button) {
    const input = document.createElement('input');
    input.className = 'mz-select mz-lib-custom';
    input.type = 'text';
    input.placeholder = 'label';
    input.setAttribute('aria-label', 'Custom expression label');
    input.spellcheck = false;
    button.replaceWith(input);
    input.focus();

    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const label = cleanSpriteLabel(input.value);
        if (label) {
            pendingLabel = label;
            pendingSpriteName = '';
            openPicker('sprite');
        } else {
            renderWin();
        }
    };

    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
    });
    input.addEventListener('blur', commit);
}

async function onFileChosen(kind, input) {
    const files = [...(input?.files || [])];
    input.value = '';
    if (!files.length || busy) return;

    const forSheet = kind === 'portrait' && portraitTarget === 'sheet';
    const record = forSheet ? null : (view.kind === 'detail' ? libraryEntry(view.name) : null);
    if (!forSheet && !record) return;

    busy = true;

    try {
        if (kind === 'portrait') {
            const prepared = await prepareImage(files[0]);
            const path = await uploadImage({
                image: prepared.image,
                format: prepared.format,
                filename: imageFileName(forSheet ? (newDraft?.name || 'character') : record.name, prepared.format),
            });
            if (!path) throw new Error('no path returned');

            if (forSheet) {
                newDraft.portrait = path;
                renderSheet();
            } else {
                setPortrait(record.name, path);
                notify(`Portrait saved for ${record.name}.`, 'success');
                renderWin();
            }
        } else if (kind === 'sprite') {
            const forced = pendingLabel;
            const replace = pendingSpriteName;
            pendingLabel = '';
            pendingSpriteName = '';
            await uploadSpriteFiles(record, files, forced, replace);
            renderWin();
        } else if (kind === 'pack') {
            const result = await spriteUploadZip({ name: record.name, file: files[0] });
            if (!result.ok) throw new Error(result.error || 'the pack was refused');
            invalidateSprites(record.name);
            notify(result.count
                ? `Uploaded ${result.count} sprite${result.count === 1 ? '' : 's'} for ${record.name}.`
                : 'The pack held no images.', result.count ? 'success' : 'warning');
            renderWin();
        }
    } catch (error) {
        console.warn('[Meziverse] the library upload failed', error);
        notify(`Could not save that for ${record.name || 'the library'}.`, 'error');
    } finally {
        busy = false;
    }
}

/**
 * The 0-step path: filenames pick their slot (`joy.png` → joy,
 * `sadness-2.png` → a second sadness), a forced label overrides the name,
 * and whatever cannot be placed waits in the tray. One label, one file -
 * a second file for a label is numbered.
 */
async function uploadSpriteFiles(record, files, forcedLabel = '', forcedSpriteName = '') {
    const known = [...SUGGESTED_LABELS];
    for (const row of detailRows) {
        if (!known.includes(row.label)) known.push(row.label);
    }

    const batch = new Set();
    let placed = 0;

    for (const file of files) {
        const match = forcedLabel
            ? { label: forcedLabel, extraIndex: 0 }
            : matchLabel(file.name, known);
        if (!match) {
            trayItems.push({
                id: `${Date.now()}-${trayItems.length}`,
                file,
                name: file.name,
                url: URL.createObjectURL(file),
            });
            continue;
        }

        let spriteName = match.extraIndex > 0 ? `${match.label}-${match.extraIndex}` : match.label;
        if (forcedSpriteName && files.length === 1) spriteName = forcedSpriteName;

        // Within one batch the name is one file's alone.
        if (batch.has(spriteName)) {
            let n = 2;
            while (batch.has(`${match.label}-${n}`)) n += 1;
            spriteName = `${match.label}-${n}`;
        }
        batch.add(spriteName);

        const result = await spriteUpload({ name: record.name, label: match.label, spriteName, file });
        if (result.ok) placed += 1;
        else notify(`Could not save ${file.name}.`, 'error');
    }

    if (placed) {
        invalidateSprites(record.name);
        notify(`${placed} sprite${placed === 1 ? '' : 's'} saved for ${record.name}.`, 'success');
    }
}

/** A tray file got its label - up it goes, out of the tray. */
function trayLabelChosen(id, label) {
    const index = trayItems.findIndex(item => item.id === id);
    if (index < 0) return;

    const [item] = trayItems.splice(index, 1);
    URL.revokeObjectURL(item.url);

    const record = view.kind === 'detail' ? libraryEntry(view.name) : null;
    if (!record || !label) {
        renderWin();
        return;
    }

    busy = true;
    uploadSpriteFiles(record, [item.file], label, '').then(() => {
        busy = false;
        renderWin();
    });
}

/**
 * Sprite deletion is armed twice: one press arms the button ("Delete?"),
 * a second within a few seconds deletes. A stray click never eats art.
 */
function spriteDeletePressed() {
    const row = selectedRow();
    if (!row || busy) return;

    const button = els.detail.querySelector('[data-mz-lib-tool="sprite-delete"]');
    const key = `sel:${row.spriteName}`;

    if (armTimers.has(key)) {
        clearTimeout(armTimers.get(key));
        armTimers.delete(key);
    } else {
        button?.classList.add('is-armed');
        if (button) button.title = 'Press again to delete';
        armTimers.set(key, setTimeout(() => {
            armTimers.delete(key);
            button?.classList.remove('is-armed');
            if (button) button.title = 'Delete';
        }, 4000));
        return;
    }

    const record = libraryEntry(view.name);
    if (!record) return;

    busy = true;
    spriteDelete({ name: record.name, label: row.label, spriteName: row.spriteName }).then(result => {
        busy = false;
        if (!result.ok) {
            notify('Could not delete that sprite.', 'error');
            return;
        }
        invalidateSprites(record.name);
        notify('Sprite deleted.', 'info');
        view.sel = null;
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
        view.menu = false;
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
