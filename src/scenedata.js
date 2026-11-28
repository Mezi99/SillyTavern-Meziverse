/**
 * Scene review data: the pure half of the window.
 *
 * scenereview.js owns the DOM; this file only reads the chat and answers
 * questions about it. Every row keeps two ordinals on purpose: `at` counts all
 * complete scene tags (the number `sceneTagAt` and `editSceneAttrs` write by)
 * while `tagIndex` counts only usable scenes (the number `describeScenes` and
 * the map's observations speak in). Conflating the two writes the wrong tag.
 *
 * Nothing here is stored. The flags are derived from the story every rebuild,
 * and the only write product is a plan of whole-message edits for the UI to
 * run through SillyTavern's own editor, one message at a time.
 */

import {
    buildAtlas,
    extractObservations,
    foldSegment,
    sourceOf,
} from './mapdata.js';
import { describeScene, describeScenes, isUsableScene } from './scene.js';
import { editSceneAttrs, parseMessage } from './tags.js';

const digitsFolded = value => String(value ?? '').replace(/\d+/g, '#');

const locationKey = levels => levels.join(' | ');

/** A prefix key that cannot collide when a name itself contains a slash. */
const pathKey = folds => (folds.length ? folds.map(fold => encodeURIComponent(fold)).join('/') : '~empty');

/** Levenshtein distance over two short strings. */
function editDistance(a, b) {
    const left = String(a ?? '');
    const right = String(b ?? '');
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;

    let prior = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
        const row = [i];
        for (let j = 1; j <= right.length; j += 1) {
            row[j] = Math.min(
                prior[j] + 1,
                row[j - 1] + 1,
                prior[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
        }
        prior = row;
    }
    return prior[right.length];
}

function addFlag(row, flag) {
    if (row.flags.some(held => held.key === flag.key)) return;
    row.flags.push(flag);
}

/**
 * Every usable scene of the open chat, in story order, with the flags the
 * review window shows. Only each message's selected swipe is read - the same
 * source the map draws - so an unselected variant never becomes editable.
 *
 * @param {object[]} messages SillyTavern's chat array
 * @param {{persona?: string}} [options]
 * @returns {{rows:object[], summary:object}}
 */
export function buildReview(messages, { persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const rows = [];

    list.forEach((message, msgIndex) => {
        const source = sourceOf(message);
        const scenes = describeScenes(source, { persona });
        if (!scenes.length) return;

        // Every complete scene tag, including the ones too thin to show.
        // parseMessage is the cache describeScenes itself reads, so the tag
        // objects here are the same identities even with the tag/scene caches
        // in play. `at` counts all of them, the way sceneTagAt and
        // editSceneAttrs do - not just the usable ones describeScenes shows.
        const complete = parseMessage(source).tags.filter(tag => tag.name === 'scene' && tag.closed);

        scenes.forEach(({ tag, scene }, tagIndex) => {
            const at = complete.indexOf(tag);
            const levels = (Array.isArray(scene.levels) ? scene.levels : []).map(level => String(level).trim()).filter(Boolean);
            const row = {
                id: `${msgIndex}:${at < 0 ? tagIndex : at}`,
                msgIndex,
                at: at < 0 ? tagIndex : at,
                tagIndex,
                of: scenes.length,
                before: typeof source?.mes === 'string' ? source.mes : '',
                levels,
                placeKey: locationKey(levels),
                date: scene.date || '',
                time: scene.time || '',
                hour: Number.isFinite(scene.hour) ? scene.hour : null,
                weather: scene.weather || '',
                weatherTag: scene.weatherTag || '',
                present: Array.isArray(scene.present) ? scene.present : [],
                flags: [],
                fix: null,
                hard: false,
            };
            rows.push(row);
        });
    });

    attachMapFlags(rows, list, persona);
    attachStoryFlags(rows);

    rows.forEach(row => {
        row.hard = row.flags.some(flag => flag.hard);
    });

    const places = new Set(rows.filter(row => row.placeKey).map(row => row.placeKey));
    return {
        rows,
        summary: {
            scenes: rows.length,
            messages: new Set(rows.map(row => row.msgIndex)).size,
            places: places.size,
            flagged: rows.filter(row => row.flags.length).length,
            hard: rows.filter(row => row.hard).length,
        },
    };
}

/** Flags the atlas already raised on the map, attached to their rows. */
function attachMapFlags(rows, messages, persona) {
    const observations = extractObservations(messages, { persona });
    if (!observations.length) return;

    const atlas = buildAtlas(observations);
    const byScene = new Map();
    rows.forEach(row => byScene.set(`${row.msgIndex}:${row.tagIndex}`, row));

    const sameOf = new Map();
    (atlas.flags.same || []).forEach(pair => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        const [a, b] = pair;
        sameOf.set(a, b);
        sameOf.set(b, a);
    });
    atlas.observations.forEach(obs => {
        const row = byScene.get(`${obs.at.msgIndex}:${obs.at.tagIndex}`);
        if (!row || !sameOf.has(obs.nodeId)) return;
        const other = atlas.nodes[sameOf.get(obs.nodeId)];
        addFlag(row, {
            key: 'map-same',
            kind: 'similar',
            hard: true,
            label: `Looks like: ${other?.name || 'another place'}`,
        });
    });

    const ambiguous = new Set(atlas.flags.ambiguous || []);
    const mobile = new Set(atlas.flags.mobilePending || []);
    if (!ambiguous.size && !mobile.size) return;

    rows.forEach(row => {
        row.levels.forEach(level => {
            const fold = foldSegment(level);
            if (ambiguous.has(fold)) {
                addFlag(row, {
                    key: `map-ambiguous:${fold}`,
                    kind: 'ambiguous',
                    hard: true,
                    label: 'Name lives in more than one place',
                });
            }
            if (mobile.has(fold)) {
                addFlag(row, {
                    key: `map-mobile:${fold}`,
                    kind: 'mobile',
                    hard: true,
                    label: 'May be a moving place',
                });
            }
        });
    });
}

/** The guide's own checks: spelling drift, missing parents, missing metadata. */
function attachStoryFlags(rows) {
    const counts = new Map();
    rows.forEach(row => {
        if (!row.placeKey) return;
        const held = counts.get(row.placeKey) || { levels: row.levels, count: 0 };
        held.count += 1;
        counts.set(row.placeKey, held);
    });

    const leaves = new Map();
    counts.forEach(info => {
        const leaf = foldSegment(info.levels[info.levels.length - 1] || '');
        if (!leaf) return;
        const held = leaves.get(leaf) || [];
        held.push(info);
        leaves.set(leaf, held);
    });

    rows.forEach(row => {
        if (row.placeKey) {
            const current = counts.get(row.placeKey);
            const here = digitsFolded(row.placeKey.toLowerCase());
            let best = null;

            counts.forEach((info, key) => {
                if (key === row.placeKey || info.count <= current.count) return;
                if (info.levels.length !== row.levels.length) return;
                if (digitsFolded(key.toLowerCase()) === here) return;

                const distance = editDistance(row.placeKey.toLowerCase(), key.toLowerCase());
                if (distance > 2 || (distance === 0 && key === row.placeKey)) return;
                if (!best || distance < best.distance || (distance === best.distance && info.count > best.info.count)) {
                    best = { distance, info };
                }
            });

            if (best) {
                const to = best.info.levels;
                const at = row.levels.findIndex((level, i) => level !== to[i]);
                const from = row.levels[at < 0 ? row.levels.length - 1 : at];
                const target = to[at < 0 ? to.length - 1 : at];
                addFlag(row, {
                    key: 'typo',
                    kind: 'typo',
                    hard: true,
                    from: from || '?',
                    to: target || '?',
                    label: `${from || '?'} → ${target || '?'}`,
                });
                row.fix = {
                    kind: 'typo',
                    levels: [...to],
                    from: from || '?',
                    to: target || '?',
                    label: `${from || '?'} → ${target || '?'}`,
                };
            } else if (row.levels.length) {
                const leaf = foldSegment(row.levels[row.levels.length - 1]);
                let deep = null;
                for (const info of leaves.get(leaf) || []) {
                    if (info.levels.length <= row.levels.length) continue;
                    if (!deep || info.levels.length > deep.levels.length
                        || (info.levels.length === deep.levels.length && info.count > deep.count)) {
                        deep = info;
                    }
                }
                if (deep) {
                    const parents = deep.levels.slice(0, -1).join(' › ');
                    addFlag(row, {
                        key: 'parents',
                        kind: 'parents',
                        hard: true,
                        parents,
                        label: `Parents missing → ${parents} …`,
                    });
                    row.fix = {
                        kind: 'parents',
                        levels: [...deep.levels],
                        label: `Use ${deep.levels.join(' › ')}`,
                    };
                }
            }
        }

        if (!row.time) {
            addFlag(row, { key: 'soft-time', kind: 'gap', hard: false, label: 'no time' });
        }
        if (!row.weather && !row.weatherTag) {
            addFlag(row, { key: 'soft-weather', kind: 'gap', hard: false, label: 'no weather' });
        }
    });
}

/**
 * The by-place tree: one node per folded level identity, so a spelling drift
 * folds into its neighbours instead of making a twin branch. Nodes carry both
 * their exact rows (ending here) and every row underneath, which is what a
 * rename writes.
 *
 * @param {object[]} rows
 * @returns {{roots:object[], byKey:Map<string,object>}}
 */
export function buildPlaceTree(rows) {
    const byKey = new Map();
    const makeNode = (folds, name, depth) => {
        const key = pathKey(folds);
        let node = byKey.get(key);
        if (node) return node;

        node = {
            key,
            depth,
            name,
            displays: new Map(),
            rows: [],
            all: [],
            children: new Map(),
        };
        byKey.set(key, node);
        return node;
    };

    const root = { key: '', depth: -1, name: '', displays: new Map(), rows: [], all: [], children: new Map() };

    rows.forEach(row => {
        root.all.push(row);
        if (!row.levels.length) {
            const node = makeNode([], 'No place', 0);
            root.children.set(node.key, node);
            node.displays.set('No place', (node.displays.get('No place') || 0) + 1);
            node.all.push(row);
            node.rows.push(row);
            return;
        }

        const folds = [];
        row.levels.forEach((level, depth) => {
            folds.push(foldSegment(level));
            const node = makeNode([...folds], level, depth);
            const parent = depth === 0 ? root : byKey.get(pathKey(folds.slice(0, -1)));
            parent.children.set(node.key, node);
            node.displays.set(level, (node.displays.get(level) || 0) + 1);
            node.all.push(row);
            if (depth === row.levels.length - 1) node.rows.push(row);
        });
    });

    const finish = node => {
        const [name] = [...node.displays.entries()].sort((a, b) => b[1] - a[1]);
        node.name = name ? name[0] : node.name;
        delete node.displays;
        node.children = [...node.children.values()];
        node.children.forEach(finish);
        return node;
    };

    return {
        roots: [...root.children.values()].map(finish),
        byKey,
    };
}

/** Search covers place levels, cast, date, time, weather and message number. */
export function matchesRow(row, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;

    const haystack = [
        ...row.levels,
        ...row.present,
        row.date,
        row.time,
        row.weather,
        row.weatherTag,
        String(row.msgIndex + 1),
        `#${row.msgIndex + 1}`,
        `${row.tagIndex + 1}/${row.of}`,
    ].join(' ').toLowerCase();
    return haystack.includes(q);
}

/**
 * Turns row edits into one whole-message write per message. Several tags in
 * one message are folded into a single edit/accept round-trip, applied in tag
 * order to the latest text so none overwrites the last. No-op edits vanish.
 *
 * @param {object[]} rows the current review rows
 * @param {Array<{id:string|number, levels:string[]}>} targets
 * @returns {Array<{msgIndex:number, before:string, after:string, edits:number}>}
 */
export function planEdits(rows, targets) {
    const byId = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row.id), row]));
    const grouped = new Map();

    for (const target of Array.isArray(targets) ? targets : []) {
        const id = String(target?.id ?? '');
        const row = byId.get(id);
        if (!row) continue;

        const levels = (Array.isArray(target.levels) ? target.levels : row.levels)
            .map(level => String(level ?? '').trim()).filter(Boolean);
        if (!levels.length) continue;

        const location = locationKey(levels);
        if (location === row.placeKey) continue;

        const edits = grouped.get(row.msgIndex) || new Map();
        edits.set(row.at, location);
        grouped.set(row.msgIndex, edits);
    }

    const writes = [];
    for (const [msgIndex, edits] of grouped) {
        const first = [...byId.values()].find(row => row.msgIndex === msgIndex);
        let after = typeof first?.before === 'string' ? first.before : '';
        const before = after;
        let applied = 0;

        for (const [at, location] of [...edits].sort((a, b) => a[0] - b[0])) {
            const next = editSceneAttrs(after, at, { location });
            if (next === after) continue;
            after = next;
            applied += 1;
        }

        if (applied && after !== before) writes.push({ msgIndex, before, after, edits: applied });
    }
    return writes;
}

/** All rows at one row's exact (unfolded) location, including the row itself. */
export function exactRows(rows, row) {
    if (!row) return [];
    return rows.filter(candidate => candidate.placeKey === row.placeKey);
}

/** Rename changes for every row under a folded tree node. */
export function renameChanges(rows, node, name) {
    if (!node || node.depth < 0) return [];
    const value = String(name ?? '').trim();
    if (!value) return [];

    return node.all.map(row => {
        const levels = [...row.levels];
        while (levels.length <= node.depth) levels.push('');
        levels[node.depth] = value;
        return { id: row.id, levels };
    });
}
