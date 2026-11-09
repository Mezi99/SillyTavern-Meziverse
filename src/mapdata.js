/**
 * The map's pure core: every scene's location chain untangled into a place
 * atlas.
 *
 * Pure like scene.js and backgrounds.js - the chat is an array of messages, a
 * message is `mes`, and nothing here stores, edits, draws or fetches. The
 * atlas is derived on demand and thrown away: node identity lives in the
 * derivation, and the only persistence the map keeps (curator decisions, UI
 * state) lives outside this file.
 *
 * The tag contract asks for a containment chain ("Region | Area | Place |
 * Spot"), but the model writes two shapes:
 *
 *   Shape 1 - stable prefix, varying tail:
 *     USA | New York City | St. Vincent's High School | Water Polo Locker Room
 *     USA | New York City | St. Vincent's High School | Main Hallway
 *     ...the tail is a spot inside a fixed container. Plain containment.
 *
 *   Shape 2 - stable tail, churning prefix:
 *     USA | New York City | En Route | Jin's Lotus Emira - Interior
 *     USA | New York City | Street | Jin's Lotus Emira - Interior
 *     ...the tail is a MOBILE place (the car). Route context above it is not
 *     a place at all: the En Route rule (`en route`, or a legacy transient
 *     spot above a known vehicle) places nothing at or above the keyword -
 *     the prefix of a leg cannot be trusted - and the level after it is THE
 *     vehicle. One mobile node per vehicle, keyed by name, with a trajectory
 *     of parked positions; the journeys between places are legs (deriveLegs),
 *     not containment.
 *
 * One rule shapes everything below: false splits are cosmetic, false merges
 * corrupt the map. Auto-merge happens only on fold-equality (spelling drift),
 * aspect-stripping ("X - Interior" is X), depth-healing (a bare chain that
 * anchors onto its known subtree) and caller-provided equivalences. Anything
 * resembling but not provably equal becomes a `flags.same` pair for the
 * curator - never a merge.
 */

import { describeScenes } from './scene.js';

/* ---------- chain splitting ---------- */

/* A model reaching for an arrow instead of `|` ("A -> B", "A › B"): the dash
   form is folded into the separator first so no stray hyphen sticks to a
   name. `/` is deliberately NOT a separator - names use it ("Room 3/4"). */
const ARROW = /\s*-{1,3}>\s*/g;
const SEPARATOR = /[|›»>→➔⇒]/;

/**
 * Splits a location chain on `|` and the separators a model may drift to.
 *
 * @param {string} value e.g. 'USA | New York City›Local Cafe Parking Lot | Jin's Lotus Emira'
 * @returns {string[]} the display segments, trimmed, empties dropped
 */
export function splitMapChain(value) {
    const raw = typeof value === 'string' ? value : '';
    return raw
        .replace(ARROW, '|')
        .split(SEPARATOR)
        .map(level => level.trim())
        .filter(Boolean);
}

/* ---------- segments: core name + aspect ---------- */

/* The qualifiers that name the SAME place seen differently - a car's
   "Interior" is the car, not a room inside it. Anything else after a dash or
   in parentheses ("Unit 4B - Bedroom", "Kitchen (back room)") is part of the
   name: two bedrooms are two places. The lexicon is deliberately small. */
const ASPECT_WORDS = /^(?:int(?:erior)?|ext(?:erior)?|inside|outside|(?:interior|exterior)\s+view|from\s+(?:the\s+)?(?:inside|outside)|view|shot)$/i;

const DASH_ASPECT = /\s+[-‐‑‒–—]\s+(.+)$/;
const PAREN_ASPECT = /\s*[[(]\s*([^\])]+)\s*[\])]\s*$/;

/**
 * Splits a segment into its core name and its aspect ("Jin's Lotus Emira -
 * Interior" -> core "Jin's Lotus Emira", aspect "Interior"). An aspect folds
 * away for identity; a qualifier outside the lexicon stays in the name.
 *
 * @param {string} name
 * @returns {{core:string, aspect:string}}
 */
export function splitAspect(name) {
    const raw = (typeof name === 'string' ? name : '').trim();

    const paren = PAREN_ASPECT.exec(raw);
    if (paren && ASPECT_WORDS.test(paren[1].trim())) {
        return { core: raw.slice(0, paren.index).trim(), aspect: paren[1].trim() };
    }

    const dash = DASH_ASPECT.exec(raw);
    if (dash && ASPECT_WORDS.test(dash[1].trim())) {
        return { core: raw.slice(0, dash.index).trim(), aspect: dash[1].trim() };
    }

    return { core: raw, aspect: '' };
}

/* ---------- name folding ---------- */

/**
 * The identity key of a segment's core name.
 *
 * Folds only what is provably the same word: case, curly quotes, apostrophes
 * and periods ("St. Vincent's" = "St Vincents"), hyphens to spaces ("Walk-Up"
 * = "Walk Up"), `&` to "and", and "No9" / "#9" / "no. 9" to "9" ("Pier No9" =
 * "Pier 9"). Number words are NOT folded ("Fifth Street" is a name) and "the"
 * stays ("The Docks" differs from "Docks" - flagged as similar, merged by the
 * curator only).
 *
 * @param {string} name
 * @returns {string}
 */
export function foldSegment(name) {
    let value = typeof name === 'string' ? name : '';
    if (typeof value.normalize === 'function') value = value.normalize('NFC');

    return value
        .replace(/[[\]]/g, ' ')
        .replace(/[‘’ʼ´`]/g, "'")
        .replace(/[“”„‟"]/g, '')
        .replace(/(?:\b(?:no\.?|number)\s*|#)(\d+)/gi, '$1')
        .replace(/['']/g, '')
        .replace(/\./g, '')
        .replace(/&/g, ' and ')
        .replace(/[-‐‑‒–—_]/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/* ---------- the selected swipe variant ---------- */

/**
 * The variant of one message the user chose to continue from: the index in
 * `swipes`, or 0 for a message without swipes. Everything the map derives
 * comes from that variant alone - the unselected ones are branch material
 * for later, never part of the story that happened.
 *
 * @param {object} message
 * @returns {number}
 */
export function activeSwipeId(message) {
    const id = Math.trunc(Number(message?.swipe_id ?? 0));
    return Number.isFinite(id) && id > 0 ? id : 0;
}

/**
 * The selected variant's text: `swipes[swipe_id]` where that variant exists,
 * else `mes` - the message without swipes, or the mirror that is momentarily
 * ahead of its array while a reply streams.
 *
 * @param {object} message
 * @returns {string}
 */
export function activeSwipeText(message) {
    if (!message || typeof message !== 'object') return '';
    const variant = Array.isArray(message.swipes) ? message.swipes[activeSwipeId(message)] : null;
    if (typeof variant === 'string' && variant.length) return variant;
    return typeof message.mes === 'string' ? message.mes : '';
}

/**
 * The stamp the selected variant carries - its own `swipe_info` slot first.
 * The message-level mirror follows whichever variant was stamped last, so
 * after shuffling it can name a variant that is no longer selected; it is
 * only evidence when no variant carries a stamp of its own. An unstamped
 * selected variant has no place at all: inheriting a sibling's stamp would
 * put a discarded branch on the map.
 *
 * @param {object} message
 * @returns {string|null} the background record id
 */
export function activeStamp(message) {
    if (!message || typeof message !== 'object') return null;

    const own = message.swipe_info?.[activeSwipeId(message)]?.extra?.meziverse?.bg;
    if (typeof own === 'string' && own.trim()) return own.trim();

    const slots = Array.isArray(message.swipe_info) ? message.swipe_info : [];
    const anyVariant = slots.some(slot => {
        const id = slot?.extra?.meziverse?.bg;
        return typeof id === 'string' && id.trim();
    });
    if (anyVariant) return null;

    const mirrored = message.extra?.meziverse?.bg;
    return typeof mirrored === 'string' && mirrored.trim() ? mirrored.trim() : null;
}

/* The message whose text the map reads: the selected variant's, patched onto
   a shim when the `mes` mirror lags behind it. One shim per message keeps the
   identity caches in tags.js and scene.js hitting. */
const sourceCache = new WeakMap();

function sourceOf(message) {
    const text = activeSwipeText(message);
    const mirrored = typeof message?.mes === 'string' ? message.mes : '';
    if (text === mirrored) return message;

    let shim = sourceCache.get(message);
    if (!shim || shim.mes !== text) {
        shim = { ...message, mes: text };
        sourceCache.set(message, shim);
    }
    return shim;
}

/* ---------- observations ---------- */

/**
 * Every usable scene tag of the chat as one map observation, in story order -
 * mid-reply hops included, since a reply may carry several scene tags. Only
 * each message's SELECTED swipe variant is read: an unselected swipe is a
 * branch the story did not take, and must never become a scene or a place.
 *
 * @param {object[]} messages SillyTavern's chat array
 * @param {{persona?: string}} [options]
 * @returns {Array<{at:{msgIndex:number, tagIndex:number}, placeFull:string, chain:string[], date:string, time:string, hour:number|null, weather:string, locationTag:string, present:string[]}>}
 */
export function extractObservations(messages, { persona = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];

    list.forEach((message, msgIndex) => {
        describeScenes(sourceOf(message), { persona }).forEach(({ scene }, tagIndex) => {
            const placeFull = typeof scene.placeFull === 'string' ? scene.placeFull : '';
            const chain = splitMapChain(placeFull);
            if (!chain.length) return;

            out.push({
                at: { msgIndex, tagIndex },
                placeFull,
                chain,
                date: scene.date || '',
                time: scene.time || '',
                hour: Number.isFinite(scene.hour) ? scene.hour : null,
                weather: scene.weather || '',
                locationTag: scene.locationTag || '',
                present: scene.present || [],
            });
        });
    });

    return out;
}

/**
 * The flat fallback for a story without scene tags: every stamped reply's
 * background record already names its place (the watcher wrote the name), so
 * the chat's drawn pictures become a simple map of visited places - the
 * Frame spec's original promise. One observation per stamped reply; a reply
 * without a stamp inherits nothing and simply has no place of its own. The
 * stamp is the SELECTED swipe variant's own (`activeStamp`): each variant
 * carries the picture drawn for it, and only the variant the user continued
 * from may name a place.
 *
 * @param {Array<{extra?:object}>} messages SillyTavern's chat array
 * @param {Record<string, {place?:string}>} records the bg store's records
 * @returns {object[]} observations like `extractObservations`, chains of one level
 */
export function extractStampObservations(messages, records = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];

    list.forEach((message, msgIndex) => {
        const id = activeStamp(message);
        const record = id ? records?.[id] : null;
        const place = record && typeof record.place === 'string' ? record.place.trim() : '';
        const chain = splitMapChain(place);
        if (!chain.length) return;

        out.push({
            at: { msgIndex, tagIndex: 0 },
            placeFull: place,
            chain,
            date: '',
            time: '',
            hour: null,
            weather: '',
            locationTag: '',
            present: [],
        });
    });

    return out;
}

/* ---------- transient and vehicle words ---------- */

/* A position like "En Route" or "Downtown Streets" is route context, not an
   atlas place. A fold is transient when EVERY word is generic and at least
   one is strongly so - so "Fifth Street Walk-Up" (a residence) is a place,
   while "Street" and "Downtown Streets" are not. */
const TRANSIENT_STRONG = new Set([
    'en', 'route', 'road', 'roads', 'street', 'streets', 'highway', 'freeway',
    'transit', 'journey', 'way', 'somewhere', 'path', 'downtown', 'uptown', 'midtown',
]);
const TRANSIENT_SOFT = new Set([
    'the', 'a', 'an', 'on', 'in', 'at', 'of', 'some', 'local', 'main', 'side',
    'area', 'district', 'city', 'north', 'south', 'east', 'west', 'central',
    'around', 'near', 'toward', 'towards', 'through', 'via', 'down', 'up', 'out',
    'inside', 'outside', 'towards', 'between',
]);

/**
 * Whether a folded name is route context rather than a place.
 *
 * @param {string} fold
 * @returns {boolean}
 */
export function isTransientFold(fold) {
    const words = String(fold ?? '').split(' ').filter(Boolean);
    if (!words.length) return false;
    return words.every(word => TRANSIENT_STRONG.has(word) || TRANSIENT_SOFT.has(word))
        && words.some(word => TRANSIENT_STRONG.has(word));
}

/* Things that move: one more piece of evidence that a churning tail is a
   mobile place and not two same-named rooms. */
const VEHICLE = /\b(?:car|bus|train|ship|boat|plane|aircraft|taxi|van|truck|motorcycle|bike|scooter|rv|camper|wagon|carriage|subway|ferry|yacht|jet|limo|limousine|vessel|helicopter|tram|trolley|suv|horse|steed|mount|cart|caravan|sled|rickshaw|palanquin|chariot|starship|spaceship|shuttle|rocket|pod|orbiter|freighter|lander|skiff|canoe|barge|galleon|raft|submarine|dirigible|balloon|glider|hovercar|speeder)\b/;

/* ---------- the atlas ---------- */

/**
 * Untangles observations into a place atlas.
 *
 * The atlas holds one node per place identity: containment edges for Shape 1,
 * one free-floating `mobile` node per moving place (with its trajectory of
 * positions) for Shape 2. Everything resembling-but-unproven lands in `flags`
 * for the curator - never merged here.
 *
 * Every node also gets `key`, its folded path ("usa/new york city/choi
 * house/kitchen"; mobiles "~jins lotus emira") - identity that survives a
 * rebuild, so selection, the saved view and the curator's verdicts speak in
 * keys, never in n1..nN. Each observation is annotated with `nodeId` and,
 * when its chain was pure route context (no vehicle after the keyword),
 * `transit: true`.
 *
 * @param {Array<{chain:string[], at?:object, date?:string, time?:string, hour?:number|null, weather?:string, locationTag?:string, present?:string[]}>} observations
 * @param {{equivalences?: Array<[string, string]>}} [options]
 *   `equivalences` are known-same name pairs ("NYC" = "New York City") -
 *   the bg store's alias map and the curator's merges feed this. Raw names or
 *   folds both work.
 * @returns {{nodes:Record<string,object>, order:string[], roots:string[], flags:{same:string[][], mobilePending:string[], ambiguous:string[]}, observations:object[]}}
 */
export function buildAtlas(observations, { equivalences = [] } = {}) {
    const obs = (Array.isArray(observations) ? observations : [])
        .map(entry => processObservation(entry))
        .filter(entry => entry && entry.parts.length);
    obs.forEach((entry, index) => { entry.obsIndex = index; });

    const dsu = makeDsu();
    for (const pair of equivalences) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        dsu.union(foldSegment(pair[0]), foldSegment(pair[1]));
    }
    for (const entry of obs) {
        for (const part of entry.parts) part.fold = dsu.find(part.fold);
    }

    const flags = { same: [], mobilePending: [], ambiguous: [] };

    /* The En Route rule: route context is not a place. A chain with a route
       keyword places nothing at or above it - a flight changes country
       mid-leg, so the prefix cannot be trusted - and the level right after
       the keyword is THE vehicle: one mobile node per folded vehicle name,
       shared by every trip and every parked stop. `en route` is the keyword
       by contract; a legacy transient spot counts only above a known
       vehicle, so "Main Street | Building 5" stays a place. The churn
       analysis remains the evidence for old chats without the keyword. */
    const analysis = analyseChurn(obs);
    flags.mobilePending.push(...analysis.pending);

    const vehicleFolds = new Set(analysis.mobileFolds);
    for (const entry of obs) {
        for (let i = 0; i < entry.parts.length - 1; i += 1) {
            if (entry.parts[i].fold === 'en route') vehicleFolds.add(entry.parts[i + 1].fold);
        }
    }
    for (const entry of obs) {
        const keyword = enRouteKeyword(entry.parts, vehicleFolds);
        if (keyword < 0) continue;
        const vehicle = entry.parts[keyword + 1] || null;
        if (vehicle) vehicleFolds.add(vehicle.fold);
        entry.parts = entry.parts.slice(keyword + 1);
        if (!entry.parts.length) entry.transit = true;
    }

    const mobileFolds = vehicleFolds;

    const nodes = {};
    const order = [];
    const byFold = new Map();
    let seq = 0;

    const makeNode = (part, parent, obsIndex) => {
        const id = `n${++seq}`;
        const node = {
            id,
            fold: part.fold,
            name: part.core || part.display,
            nameCounts: { [part.core || part.display]: 1 },
            aliases: [],
            level: parent && Number.isFinite(parent.level) ? parent.level + 1 : parent ? null : 0,
            kind: 'spot',
            parentId: parent ? parent.id : null,
            children: [],
            trajectory: null,
            visits: [obsIndex],
            aspects: [],
            lastSeen: obsIndex,
        };
        if (part.aspect) node.aspects.push(part.aspect);
        nodes[id] = node;
        order.push(id);
        if (parent) parent.children.push(id);
        else node.level = 0;
        const bucket = byFold.get(part.fold) || [];
        bucket.push(node);
        byFold.set(part.fold, bucket);
        return node;
    };

    const touch = (node, part, obsIndex) => {
        if (node.visits[node.visits.length - 1] !== obsIndex) node.visits.push(obsIndex);
        const key = part.core || part.display;
        node.nameCounts[key] = (node.nameCounts[key] || 0) + 1;
        if (part.aspect && !node.aspects.includes(part.aspect)) node.aspects.push(part.aspect);
        node.lastSeen = obsIndex;
    };

    /* Most recent wins; a fork the next segment resolves is preferred. */
    const pick = (candidates, nextPart) => {
        let pool = candidates;
        if (nextPart) {
            const hits = pool.filter(node => node.children.some(id => nodes[id].fold === nextPart.fold));
            if (hits.length) pool = hits;
        }
        if (pool.length > 1 && !flags.ambiguous.includes(candidates[0].fold)) {
            flags.ambiguous.push(candidates[0].fold);
        }
        return pool.reduce((best, node) => (node.lastSeen > best.lastSeen ? node : best), pool[0]);
    };

    /* One node per mobile fold, free-floating: it travels, so it never hangs
       under a position - its trajectory is its home. */
    const mobileByFold = new Map();
    const getOrCreateMobile = (part, obsIndex) => {
        const hit = mobileByFold.get(part.fold);
        if (hit) return hit;
        const node = makeNode(part, null, obsIndex);
        node.kind = 'mobile';
        node.level = null;
        node.trajectory = [];
        mobileByFold.set(part.fold, node);
        return node;
    };

    /* Find-or-create for one chain: the chain's leading segment anchors
       anywhere (a bare chain heals onto its known subtree), later segments
       match children of the matched context, and a dropped middle level heals
       onto a unique descendant INSIDE that context - the search never leaves
       the matched subtree, so a same-named place elsewhere is never stolen. */
    const place = (entry) => {
        let current = null;

        entry.parts.forEach((part, i) => {
            const next = entry.parts[i + 1] || null;

            if (mobileFolds.has(part.fold)) {
                const node = getOrCreateMobile(part, entry.obsIndex);
                touch(node, part, entry.obsIndex);
                if (!node.trajectory.some(stop => stop.obs === entry.obsIndex)) {
                    node.trajectory.push({ obs: entry.obsIndex, positionId: current ? current.id : null });
                }
                current = node;
                return;
            }

            if (current === null) {
                const bucket = byFold.get(part.fold) || [];
                current = bucket.length ? pick(bucket, next) : makeNode(part, null, entry.obsIndex);
            } else if (current.kind === 'mobile') {
                const hits = current.children.map(id => nodes[id]).filter(node => node.fold === part.fold);
                current = hits.length ? pick(hits, next) : makeNode(part, current, entry.obsIndex);
            } else {
                let hits = current.children.map(id => nodes[id]).filter(node => node.fold === part.fold);
                if (!hits.length) {
                    hits = descendants(current).filter(node => node.fold === part.fold);
                }
                current = hits.length ? pick(hits, next) : makeNode(part, current, entry.obsIndex);
            }

            touch(current, part, entry.obsIndex);
        });

        return current;
    };

    function descendants(node) {
        const out = [];
        const walk = parent => {
            for (const id of parent.children) {
                out.push(nodes[id]);
                walk(nodes[id]);
            }
        };
        walk(node);
        return out;
    }

    obs.forEach(entry => {
        entry.nodeId = place(entry)?.id || null;
    });

    /* Kinds: mobile and transient as detected, leaves as spots, containers by
       level - the tag contract's own Region | Area | Place | Spot reading. A
       generic-looking name only reads as route context when it is a leaf: a
       transient-folded name WITH children ("Main Street | Building 5") is a
       real container whose name merely sounds like one. */
    for (const id of order) {
        const node = nodes[id];
        if (node.kind === 'mobile') continue;
        if (!node.children.length) node.kind = isTransientFold(node.fold) ? 'transient' : 'spot';
        else node.kind = node.level === 0 ? 'region' : node.level === 1 ? 'city' : 'site';
    }

    /* The display name: the most-written spelling of the core. */
    for (const id of order) {
        const node = nodes[id];
        const [best] = Object.entries(node.nameCounts).sort((a, b) => b[1] - a[1]);
        node.name = best ? best[0] : node.name;
        node.aliases = Object.keys(node.nameCounts).filter(name => name !== node.name);
        delete node.nameCounts;
    }

    /* Stable keys: the folded path ("usa/new york city/choi house/kitchen"),
       mobiles by name alone ("~jins lotus emira"). Identity that survives a
       rebuild - selection, the saved view and the curator's verdicts all
       speak in keys, never in n1..nN. */
    const takenKeys = new Set();
    for (const id of order) {
        const node = nodes[id];
        let key;
        if (node.kind === 'mobile') {
            key = `~${node.fold}`;
        } else {
            const path = [];
            for (let at = node; at; at = at.parentId ? nodes[at.parentId] : null) path.unshift(at.fold);
            key = path.join('/');
        }
        const base = key;
        let fork = 2;
        while (takenKeys.has(key)) key = `${base}#${fork++}`;
        takenKeys.add(key);
        node.key = key;
    }

    flagSimilar(nodes, order, flags);

    const roots = order.filter(id => !nodes[id].parentId);
    return { nodes, order, roots, flags, observations: obs };
}

/** One observation's chain as identity-ready parts (empty folds dropped). */
function processObservation(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const chain = Array.isArray(entry.chain) ? entry.chain : splitMapChain(entry.placeFull);
    const parts = chain
        .map(display => {
            const { core, aspect } = splitAspect(display);
            const fold = foldSegment(core);
            return fold ? { display, core, aspect, fold } : null;
        })
        .filter(Boolean);
    if (!parts.length) return null;

    return {
        at: entry.at || null,
        obsIndex: 0,
        placeFull: entry.placeFull || chain.join(' | '),
        parts,
        date: entry.date || '',
        time: entry.time || '',
        hour: Number.isFinite(entry.hour) ? entry.hour : null,
        weather: entry.weather || '',
        locationTag: entry.locationTag || '',
        present: Array.isArray(entry.present) ? entry.present : [],
    };
}

/**
 * The index of a chain's route keyword, or -1 when it has none: `en route`
 * by contract, or a legacy transient spot sitting right above a known
 * vehicle (the old tags churned the position instead of naming the keyword).
 */
function enRouteKeyword(parts, vehicleFolds) {
    for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].fold === 'en route') return i;
        const next = parts[i + 1];
        if (next && isTransientFold(parts[i].fold) && (vehicleFolds.has(next.fold) || next.aspect)) return i;
    }
    return -1;
}

/**
 * Shape 2 detection over the story: for each place, compare its occurrences
 * (by deepest name, consecutive in story order) - a stable tail with churned
 * content above it is churn evidence for the tail. Two churns with two
 * distinct positions make a mobile place when the evidence says "thing that
 * moves" (a transient position, a vehicle word, or an interior/exterior
 * aspect); without that flavour it only raises a flag - same-named rooms in
 * different buildings must never merge.
 */
function analyseChurn(obs) {
    const churn = new Map();
    const positions = new Map();
    const aspectFolds = new Set();

    for (const entry of obs) {
        for (const part of entry.parts) {
            if (part.aspect) aspectFolds.add(part.fold);
        }
    }

    const lastByFold = new Map();
    obs.forEach((entry, i) => {
        const folds = entry.parts.map(part => part.fold);
        const deepest = folds[folds.length - 1];
        const prev = lastByFold.get(deepest);
        lastByFold.set(deepest, i);
        if (prev === undefined) return;

        const a = obs[prev].parts.map(part => part.fold);
        const b = folds;
        let shared = 0;
        while (shared < a.length && shared < b.length && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1;
        if (!shared) return;

        const aboveA = a.slice(0, a.length - shared);
        const aboveB = b.slice(0, b.length - shared);
        if (aboveA.length === aboveB.length && aboveA.every((fold, k) => fold === aboveB[k])) return;

        const tailTop = b[b.length - shared];
        churn.set(tailTop, (churn.get(tailTop) || 0) + 1);

        const spots = positions.get(tailTop) || new Set();
        for (const chain of [a, b]) {
            const position = chain[chain.length - shared - 1];
            if (position) spots.add(position);
        }
        positions.set(tailTop, spots);
    });

    const mobileFolds = new Set();
    const pending = [];
    for (const [fold, count] of churn) {
        if (count < 2) continue;
        const spots = [...(positions.get(fold) || [])];
        if (spots.length < 2) continue;

        const strong = spots.some(fold2 => isTransientFold(fold2))
            || VEHICLE.test(fold)
            || aspectFolds.has(fold);
        if (strong) mobileFolds.add(fold);
        else pending.push(fold);
    }

    return { mobileFolds, pending };
}

/** Union-find over folded names: the identity behind merges. */
function makeDsu() {
    const parent = new Map();

    const find = x => {
        if (!x) return x;
        if (!parent.has(x)) parent.set(x, x);
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(x) !== root) {
            const next = parent.get(x);
            parent.set(x, root);
            x = next;
        }
        return root;
    };

    return {
        find,
        union(a, b) {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        },
    };
}

/* Similarity is a flag, never a merge: two names that merely look alike are
   the curator's call. A digit difference alone never flags ("Pier 9" and
   "Pier 10" are two piers); token overlap or containment does. */
const FLAG_PAIRS_MAX = 50;

function tokens(fold) {
    return new Set(String(fold ?? '').split(/[^a-z0-9]+/).filter(Boolean));
}

function flagSimilar(nodes, order, flags) {
    for (let i = 0; i < order.length && flags.same.length < FLAG_PAIRS_MAX; i += 1) {
        for (let j = i + 1; j < order.length && flags.same.length < FLAG_PAIRS_MAX; j += 1) {
            const a = nodes[order[i]];
            const b = nodes[order[j]];
            if (a.fold === b.fold) continue;
            if (a.fold.replace(/\d+/g, '#') === b.fold.replace(/\d+/g, '#')) continue;

            const ta = tokens(a.fold);
            const tb = tokens(b.fold);
            const shared = [...ta].filter(word => tb.has(word)).length;
            const union = new Set([...ta, ...tb]).size;
            const jaccard = union ? shared / union : 0;

            const shorter = a.fold.length <= b.fold.length ? a.fold : b.fold;
            const longer = shorter === a.fold ? b.fold : a.fold;
            const contained = shorter.length >= 5
                && new RegExp(`(?:^| )${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(longer);

            if (jaccard >= 0.6 || contained) flags.same.push([a.id, b.id]);
        }
    }
}

/* ---------- legs: the story's movement ---------- */

/* How a journey went: the vehicle's name says. Broad-first so a "starship"
   never classifies as a ship; the curator may set a mode later. */
const MODES = [
    [/\b(starship|spaceship|space\s?ship|shuttle|rocket|pod|orbiter|freighter|lander|hovercar|speeder)\b/i, 'rocket', 'by ship'],
    [/\b(plane|jet|flight|aircraft|helicopter|airship|sky|dirigible|balloon|glider|wyvern|dragon|griffin|hawk)\b/i, 'plane', 'by air'],
    [/\b(boat|ferry|yacht|vessel|skiff|canoe|barge|galleon|raft|submarine|ship)\b/i, 'boat', 'by water'],
    [/\b(train|subway|tram|metro|rail|trolley|monorail)\b/i, 'rail', 'by rail'],
    [/\b(horse|steed|mount|carriage|wagon|cart|caravan|sled|rickshaw|palanquin|chariot)\b/i, 'cart', 'by cart'],
    [/\b(car|taxi|cab|van|truck|bus|suv|limo|jeep|motorcycle|bike|scooter|emira)\b/i, 'car', 'by road'],
];

/**
 * How one named vehicle travels - or the generic route glyph for a walk or
 * a name nothing recognises ("the Nightjar" is a ship until the curator says).
 *
 * @param {string} name the vehicle's name
 * @returns {{glyph:string, label:string, name:string}}
 */
export function travelMode(name) {
    const text = String(name ?? '');
    for (const [pattern, glyph, label] of MODES) {
        if (pattern.test(text)) return { glyph, label, name: text };
    }
    return { glyph: 'route', label: 'on the way', name: text };
}

/**
 * The story's movement, read off the atlas in story order: the legs between
 * places and where the story is now.
 *
 * Each observation's LOCATION is: the place a parked vehicle sits at (its
 * trajectory position), pure transit for route context (a chain that was all
 * keyword, or a leaf that still reads as route context), and the node itself
 * otherwise. A located scene somewhere new closes a leg from the last one,
 * carrying the mode seen while in transit (or none: a cut or a teleport).
 * Trips between the same two places pile onto one leg. A move between two
 * spots of one place is not a journey and leaves no leg.
 *
 * @param {object} atlas the `buildAtlas` result
 * @returns {{legs:object[], nowId:string|null, inTransit:boolean, transitMode:object|null, fromId:string|null, present:Record<string, Record<string, number>>}}
 *   each leg is `{a, b, key, count, at[], lastObs, order, dir:[from,to], mode:{glyph,label,name}|null, local}`;
 *   `a`/`b` are the first trip's direction, `dir` the latest
 */
export function deriveLegs(atlas) {
    const nodes = atlas?.nodes || {};
    const obs = Array.isArray(atlas?.observations) ? atlas.observations : [];

    /* Where each scene happens. */
    const loc = obs.map(entry => {
        if (entry.transit) return { transit: true, mode: travelMode('') };

        const node = nodes[entry.nodeId];
        if (!node) return {};

        if (node.kind === 'mobile') {
            const stop = (node.trajectory || []).find(item => item.obs === entry.obsIndex);
            const position = stop && stop.positionId ? nodes[stop.positionId] : null;
            const mode = travelMode(node.name);
            if (position && position.kind !== 'transient') return { id: position.id, vehicle: node.id, mode, parked: true };
            return { transit: true, vehicle: node.id, mode };
        }

        for (let at = node; at; at = at.parentId ? nodes[at.parentId] : null) {
            if (at.kind === 'transient') {
                return { transit: true, mode: at === node ? travelMode('') : travelMode(node.name) };
            }
        }
        return { id: node.id };
    });

    /* Walking the story in order: a located scene somewhere new closes a leg. */
    const legs = [];
    const legByKey = new Map();
    let last = null;
    let pending = null;

    loc.forEach((where, i) => {
        if (where.transit) {
            pending = pending || where.mode;
            if (where.mode && where.mode.glyph !== 'route') pending = where.mode;
            return;
        }
        if (!where.id) return;

        if (last && last.id !== where.id) {
            const key = [last.id, where.id].sort().join('|');
            let leg = legByKey.get(key);
            if (!leg) {
                leg = {
                    a: last.id,
                    b: where.id,
                    key,
                    count: 0,
                    at: [],
                    lastObs: i,
                    order: i,
                    dir: [last.id, where.id],
                    mode: null,
                    local: false,
                };
                legByKey.set(key, leg);
                legs.push(leg);
            }
            leg.count += 1;
            leg.at.push(i);
            leg.dir = [last.id, where.id];
            leg.lastObs = i;
            leg.order = i;
            if (pending) leg.mode = pending;
        }
        last = { id: where.id, i };
        pending = null;
    });

    /* A move between two spots of one place is not a journey. */
    for (let i = legs.length - 1; i >= 0; i -= 1) {
        const leg = legs[i];
        const parentA = nodes[leg.a]?.parentId;
        const parentB = nodes[leg.b]?.parentId;
        leg.local = !!parentA && parentA === parentB && nodes[parentA]?.level >= 2;
        if (leg.local) legs.splice(i, 1);
    }

    /* The story's now: the last scene's place - or the road it is on. */
    const tail = loc[loc.length - 1] || {};
    const present = {};
    loc.forEach((where, i) => {
        if (!where.id) return;
        const bucket = present[where.id] || (present[where.id] = {});
        for (const name of obs[i].present || []) bucket[name] = (bucket[name] || 0) + 1;
    });

    return {
        legs,
        nowId: tail.id || (last && last.id) || null,
        inTransit: !!tail.transit,
        transitMode: tail.transit ? pending || tail.mode : null,
        fromId: (last && last.id) || null,
        present,
    };
}

/* ---------- layout: where things sit on the chart ---------- */

export const PIN_R = 17;
const PLACE_PAD = { plot: 26, city: 44, region: 64 };

/** FNV-1a over the folded name: the seed behind every slot and shape. */
export function hashFold(fold) {
    let h = 2166136261;
    for (const c of String(fold)) {
        h ^= c.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** A tiny deterministic generator - the same seed draws the same chart. */
function randomFrom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Places items around the origin in the order given - story order, never
 * size order. Append-only is what makes the layout grow without moving: an
 * item's slot is computed from its seed and the items that came before it,
 * so a newcomer can only claim a free slot. The ring search starts at a
 * radius independent of the item's own size, too: a plate that grows (a
 * house gains a room) keeps its slot unless the growth truly collides.
 * The ring step is squashed to 0.82 so clusters read wider than tall.
 *
 * @returns {number} the radius enclosing the placed cluster
 */
function pack(items, gap, seed) {
    const rand = randomFrom(seed);
    const placed = [];

    items.forEach((item, i) => {
        if (!i) {
            item.x = 0;
            item.y = 0;
            placed.push(item);
            return;
        }

        const cx = placed.reduce((sum, p) => sum + p.x, 0) / placed.length;
        const cy = placed.reduce((sum, p) => sum + p.y, 0) / placed.length;
        const start = rand() * 6.2832;

        for (let rho = 0; rho < 4000; rho += 5) {
            let best = null;
            let bestDistance = 1e9;
            for (let step = 0; step < 28; step += 1) {
                const angle = start + step * 6.2832 / 28;
                const x = Math.cos(angle) * rho;
                const y = Math.sin(angle) * rho * 0.82;
                if (placed.every(p => Math.hypot(p.x - x, p.y - y) >= p.r + item.r + gap)) {
                    const distance = Math.hypot(x - cx, y - cy);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = { x, y };
                    }
                }
            }
            if (best) {
                item.x = best.x;
                item.y = best.y;
                placed.push(item);
                return;
            }
        }
    });

    return placed.length
        ? Math.max(...placed.map(p => Math.hypot(p.x, p.y) + p.r))
        : 0;
}

/**
 * A stable placement for every visible node: the data has no coordinates, so
 * the chart generates them - deterministically, seeded by the folded name, so
 * a rebuild reproduces the same chart and growing the story never moves the
 * places that are already on it.
 *
 * Visible nodes are everything except mobiles and transient route context. A
 * node is a PIN when it has no visible children or the depth collapsed it;
 * otherwise a TERRITORY: its children packed inside it, its own radius the
 * enclosing one plus a pad (plot 26, city 44, region 64), regions ringed
 * further apart. `anchor(id)` is the nearest pin at or above a node - every
 * journey edge draws to it, so collapsing the depth never loses a leg.
 *
 * @param {object} atlas the `buildAtlas` result
 * @param {{depth?: number}} [options] 2, 3 or 4 levels, or 99 for everything
 * @returns {{items:Record<string,object>, order:object[], roots:object[], bounds:{x0:number,x1:number,y0:number,y1:number}, anchor:(id:string)=>object|null}}
 */
export function layoutAtlas(atlas, { depth = 4 } = {}) {
    const nodes = atlas?.nodes || {};
    const kidsOf = node => (node.children || [])
        .map(id => nodes[id])
        .filter(child => child && child.kind !== 'mobile' && child.kind !== 'transient');

    const expands = node => kidsOf(node).length > 0
        && (depth === 99 || (Number.isFinite(node.level) ? node.level < depth - 1 : true));

    const lay = node => {
        if (!expands(node)) return { n: node, r: PIN_R, pin: true, kids: [] };
        const subs = kidsOf(node).map(lay);
        const inner = pack(subs, node.level >= 2 ? 10 : 22, hashFold(node.fold));
        const pad = node.level === 0 ? PLACE_PAD.region : node.level === 1 ? PLACE_PAD.city : PLACE_PAD.plot;
        return { n: node, r: Math.max(inner + pad, PIN_R + pad), pin: false, kids: subs };
    };

    const roots = (atlas?.roots || [])
        .map(id => nodes[id])
        .filter(node => node && node.kind !== 'mobile' && node.kind !== 'transient')
        .map(lay);
    pack(roots, 90, 7);

    const out = { items: {}, order: [], roots, bounds: null };
    const walk = (item, ox, oy) => {
        item.ax = ox + item.x;
        item.ay = oy + item.y;
        out.items[item.n.id] = item;
        out.order.push(item);
        item.kids.forEach(child => walk(child, item.ax, item.ay));
    };
    roots.forEach(root => walk(root, 0, 0));

    const all = out.order;
    out.bounds = all.length ? {
        x0: Math.min(...all.map(i => i.ax - i.r)),
        x1: Math.max(...all.map(i => i.ax + i.r)),
        y0: Math.min(...all.map(i => i.ay - i.r)),
        y1: Math.max(...all.map(i => i.ay + i.r)),
    } : { x0: 0, x1: 0, y0: 0, y1: 0 };

    out.anchor = id => {
        for (let at = nodes[id]; at; at = at.parentId ? nodes[at.parentId] : null) {
            const item = out.items[at.id];
            if (item && item.pin) return item;
        }
        return out.items[id] || null;
    };

    return out;
}
