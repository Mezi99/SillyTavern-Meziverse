/**
 * The floating overlays that hang off a piece of the scene: the cue
 * popover and the thought bubbles. They live on the frame, never in the
 * layout they annotate, and only one of them is open at a time.
 */

/* The floats' closers, in registration order. */
const floats = new Set();

/** Registers the close() of one float; returns its unregister. */
export function registerFloat(close) {
    floats.add(close);
    return () => floats.delete(close);
}

/**
 * Closes every floating overlay except `except`. True when one was open.
 * Openers pass their own close so switching floats never flickers.
 */
export function closeFloats(except) {
    let closed = false;

    for (const close of floats) {
        if (close === except) continue;
        if (close()) closed = true;
    }

    return closed;
}

/**
 * Sits a floating card against the anchor it belongs to, clamped inside
 * the window so an anchor near an edge cannot throw the card away.
 *
 * `near` centres the card on the anchor and prefers to float above it,
 * flipping below when there is no room (the cue popover). `over` simply
 * covers the anchor's own space (the thought bubbles).
 */
export function placeFloat(card, anchor, { mode = 'near', notch = true } = {}) {
    const box = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;

    const left = Math.max(12, Math.min(innerWidth - width - 12, box.left + box.width / 2 - width / 2));
    const above = box.top - height - 14 > 8;

    const top = mode === 'over'
        ? box.top + (box.height - height) / 2
        : (above ? box.top - height - 11 : box.bottom + 11);

    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
    card.classList.toggle('is-below', !above);

    if (notch) {
        card.style.setProperty('--nx', `${Math.max(14, Math.min(width - 14, box.left + box.width / 2 - left))}px`);
    }
}
