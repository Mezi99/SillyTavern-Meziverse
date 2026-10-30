/**
 * The fullscreen scene: mounting, opening and closing it, the settings sheet,
 * and the reading pane's drag handle.
 *
 * The transcript itself lives in transcript.js and is wired in here; this file
 * only owns the chrome around it.
 */

import { currentChatId, on } from './st.js';
import { settings, saveSettings } from './settings.js';
import { injectSprite } from './icons.js';

const VERSION = '0.1.0';
const PANE_DEFAULT = 300;
const UI_STEPS = [0.9, 0.95, 1, 1.05, 1.1, 1.2];
const NARR_STEPS = [16, 17, 18, 18.5, 19, 20, 21, 22, 24];

const THEMES = [
    { id: 'ink-jade', name: 'Jade', swatch: 'linear-gradient(90deg, #0c0e11 0 56%, #77c2aa 56%)' },
    { id: 'ink-amber', name: 'Amber', swatch: 'linear-gradient(90deg, #0e0d0b 0 56%, #cfaa72 56%)' },
    { id: 'ink-rose', name: 'Rose', swatch: 'linear-gradient(90deg, #0d0c10 0 56%, #c8929c 56%)' },
];

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

const FRAME_HTML = `
<div class="mz-frame" role="dialog" aria-modal="true" aria-label="Meziverse">
    <div class="mz-bg" aria-hidden="true"></div>
    <div class="mz-scrim" aria-hidden="true"></div>

    <header class="mz-header">
        <div class="mz-brand"><b>Meziverse</b></div>
        <div class="mz-chatname" data-mz="chatname"><b class="is-empty">No chat open</b></div>
        <div class="mz-header-tools">
            <button class="mz-ibtn" type="button" title="Settings" aria-label="Settings" data-mz-action="settings">${svg('gear')}</button>
            <button class="mz-ibtn mz-ibtn--exit" type="button" title="Back to SillyTavern" aria-label="Back to SillyTavern" data-mz-action="exit">${svg('door')}</button>
        </div>
    </header>

    <header class="mz-chatbar">
        <div class="mz-chatbar-left">
            <div class="mz-clock">
                <span class="mz-clock-date" data-mz="date">\u2014</span>
                <b class="mz-clock-time" data-mz="time">--:--</b>
            </div>
            <span class="mz-hair" aria-hidden="true"></span>
            <div class="mz-place">
                <span class="mz-label">Place</span>
                <b data-mz="place">\u2014</b>
            </div>
            <span class="mz-chip" data-mz="weather" hidden></span>
        </div>
        <div class="mz-chatbar-tools">
            <button class="mz-ibtn" type="button" title="Chat log" aria-label="Chat log" data-mz-action="log">${svg('list')}</button>
        </div>
    </header>

    <div class="mz-cast" aria-hidden="true"></div>

    <section class="mz-dlg" aria-label="Reading pane">
        <div class="mz-grip" role="separator" aria-orientation="horizontal" aria-label="Resize reading pane" tabindex="0"></div>
        <header class="mz-dlg-head">
            <span class="mz-speaker" data-mz="speaker"></span>
            <span class="mz-dlg-meta" data-mz="meta"></span>
        </header>
        <div class="mz-prose" data-mz="prose">
            <p class="mz-prose-empty">The scene begins when you write.</p>
        </div>
        <div class="mz-composer">
            <input class="mz-input" data-mz="input" type="text" placeholder="Write your line\u2026" autocomplete="off" spellcheck="true" aria-label="Your line">
            <button class="mz-send" type="button" title="Send" aria-label="Send" data-mz-action="send">${svg('send')}</button>
        </div>
    </section>

    <div class="mz-veil" data-mz-action="dismiss"></div>

    <section class="mz-sheet" role="dialog" aria-modal="false" aria-labelledby="mz-sheet-title" aria-hidden="true">
        <header class="mz-sheet-head">
            <h2 id="mz-sheet-title">Settings</h2>
            <button class="mz-ibtn" type="button" title="Close settings" aria-label="Close settings" data-mz-action="close-settings">${svg('close')}</button>
        </header>

        <div class="mz-set-group">
            <h3>Appearance</h3>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Theme</b><small>Ink and one metal. Everything follows it.</small></span>
                <div class="mz-theme-picks" role="group" aria-label="Theme">
                    ${THEMES.map(theme => `<button class="mz-theme-pick" type="button" data-mz-pick-theme="${theme.id}"><i style="background:${theme.swatch}"></i><span>${theme.name}</span></button>`).join('\n')}
                </div>
            </div>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Background</b><small>A quiet gradient, or the background SillyTavern has now.</small></span>
                <div class="mz-seg" role="group" aria-label="Background">
                    <button type="button" data-mz-pick-bg="none">None</button>
                    <button type="button" data-mz-pick-bg="st">SillyTavern</button>
                </div>
            </div>
        </div>

        <div class="mz-set-group">
            <h3>Type</h3>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Interface scale</b><small>Menus, headers and buttons.</small></span>
                <div class="mz-step">
                    <button type="button" data-mz-step="ui" data-dir="-1" aria-label="Smaller interface">\u2212</button>
                    <span data-mz="ui-value">100%</span>
                    <button type="button" data-mz-step="ui" data-dir="1" aria-label="Larger interface">+</button>
                </div>
            </div>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Narration size</b><small>The prose in the reading pane.</small></span>
                <div class="mz-step">
                    <button type="button" data-mz-step="narr" data-dir="-1" aria-label="Smaller narration">\u2212</button>
                    <span data-mz="narr-value">18.5 px</span>
                    <button type="button" data-mz-step="narr" data-dir="1" aria-label="Larger narration">+</button>
                </div>
            </div>
        </div>

        <div class="mz-set-group">
            <h3>Motion</h3>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Reduced motion</b><small>Fades and slides become instant.</small></span>
                <button class="mz-switch" type="button" role="switch" aria-checked="false" aria-label="Reduced motion" data-mz-action="motion"><i></i></button>
            </div>
        </div>

        <footer class="mz-sheet-foot">
            <button class="mz-btn-ghost" type="button" data-mz-action="reset-pane">Reset pane height</button>
            <span>Meziverse ${VERSION}</span>
        </footer>
    </section>
</div>`;

let root = null;
let frame = null;
let els = {};
let lastFocus = null;
let previousOverflow = null;
let desiredPane = PANE_DEFAULT;
let dragStart = null;
let resizeQueued = false;

/** Builds the hidden root and wires everything that does not need the chat. */
export function mount() {
    if (document.getElementById('mz-root')) return;

    root = document.createElement('div');
    root.id = 'mz-root';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);

    injectSprite(root);
    root.insertAdjacentHTML('beforeend', FRAME_HTML);

    frame = root.querySelector('.mz-frame');
    els = {
        chatName: root.querySelector('[data-mz="chatname"]'),
        chatNameText: root.querySelector('[data-mz="chatname"] b'),
        prose: root.querySelector('[data-mz="prose"]'),
        speaker: root.querySelector('[data-mz="speaker"]'),
        meta: root.querySelector('[data-mz="meta"]'),
        input: root.querySelector('[data-mz="input"]'),
        grip: root.querySelector('.mz-grip'),
        sheet: root.querySelector('.mz-sheet'),
        motion: root.querySelector('[data-mz-action="motion"]'),
        uiValue: root.querySelector('[data-mz="ui-value"]'),
        narrValue: root.querySelector('[data-mz="narr-value"]'),
    };

    desiredPane = Number(settings().paneHeight) || PANE_DEFAULT;

    applyTheme();
    applyMotion();
    applyScale();
    applyNarration();

    wireActions();
    wirePane();
    wireKeys();
    wireEvents();

    window.addEventListener('resize', () => {
        if (!isOpen() || resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            applyPaneHeight(desiredPane);
        });
    });
}

/** Shows the scene. Safe to call more than once. */
export function open() {
    if (!root) mount();
    if (isOpen()) return;

    lastFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    frame.classList.remove('is-settings-open');
    els.sheet.setAttribute('aria-hidden', 'true');
    frame.classList.remove('is-dragging');

    refreshChatName();
    applyBackground();
    desiredPane = Number(settings().paneHeight) || PANE_DEFAULT;
    applyPaneHeight(desiredPane);

    els.input?.focus({ preventScroll: true });
}

/** Hides the scene and hands the page back to SillyTavern. */
export function close() {
    if (!isOpen()) return;

    if (frame.contains(document.activeElement)) document.activeElement.blur();

    root.classList.remove('is-open', 'is-settings-open');
    root.setAttribute('aria-hidden', 'true');
    els.sheet.setAttribute('aria-hidden', 'true');
    frame.classList.remove('is-dragging');

    document.body.style.overflow = previousOverflow ?? '';

    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
}

function isOpen() {
    return !!root && root.classList.contains('is-open');
}

/* ---------- settings ---------- */

function applyTheme() {
    const theme = THEMES.some(t => t.id === settings().theme) ? settings().theme : THEMES[0].id;
    root.dataset.mzTheme = theme;

    root.querySelectorAll('[data-mz-pick-theme]').forEach(button => {
        const isOn = button.dataset.mzPickTheme === theme;
        button.classList.toggle('is-on', isOn);
        button.setAttribute('aria-pressed', String(isOn));
    });
}

function applyMotion() {
    const reduced = !!settings().reducedMotion;
    root.dataset.mzMotion = reduced ? 'reduced' : 'normal';
    els.motion.classList.toggle('is-on', reduced);
    els.motion.setAttribute('aria-checked', String(reduced));
}

function applyScale() {
    const scale = Number(settings().uiScale) || 1;
    root.style.setProperty('--mz-ui-scale', String(scale));
    els.uiValue.textContent = `${Math.round(scale * 100)}%`;
}

function applyNarration() {
    const size = Number(settings().narrSize) || 18.5;
    root.style.setProperty('--mz-narr-size', `${size}px`);
    els.narrValue.textContent = `${size} px`;
}

function stepValue(steps, current, dir) {
    const index = steps.reduce((best, value, at) =>
        Math.abs(value - current) < Math.abs(steps[best] - current) ? at : best, 0);
    return steps[Math.max(0, Math.min(steps.length - 1, index + dir))];
}

function applyBackground() {
    const useSt = settings().background === 'st';
    frame.classList.toggle('is-bg-st', useSt);

    root.querySelectorAll('[data-mz-pick-bg]').forEach(button => {
        const isOn = button.dataset.mzPickBg === (useSt ? 'st' : 'none');
        button.classList.toggle('is-on', isOn);
        button.setAttribute('aria-pressed', String(isOn));
    });

    if (!useSt) {
        frame.style.removeProperty('--mz-st-bg');
        return;
    }

    const source = document.getElementById('bg1');
    let image = source ? getComputedStyle(source).backgroundImage : '';
    if (!image || image === 'none') image = getComputedStyle(document.body).backgroundImage;

    if (image && image !== 'none' && image.includes('url(')) {
        frame.style.setProperty('--mz-st-bg', image);
    } else {
        frame.style.removeProperty('--mz-st-bg');
    }
}

/* ---------- chat name ---------- */

function refreshChatName() {
    const id = currentChatId();
    const label = id || 'No chat open';
    els.chatNameText.textContent = label;
    els.chatNameText.classList.toggle('is-empty', !id);
    els.chatName.title = label;
}

/* ---------- reading pane ---------- */

function cssPx(name, fallback) {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    if (!raw) return fallback;
    if (raw.endsWith('px')) return parseFloat(raw);
    if (raw.startsWith('var(')) return cssPx(raw.slice(4, -1).trim(), fallback);
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
}

function paneLimits() {
    const min = cssPx('--mz-pane-h-min', 220);
    const portMin = cssPx('--mz-port-min-h', 180);
    const header = root.querySelector('.mz-header')?.offsetHeight || 34;
    const chatbar = root.querySelector('.mz-chatbar')?.offsetHeight || 48;
    const max = Math.max(min, frame.clientHeight - header - chatbar - portMin - 28);
    return { min, max };
}

function shownPane() {
    return parseFloat(frame.style.getPropertyValue('--mz-pane-h')) || PANE_DEFAULT;
}

function applyPaneHeight(height, persist = false) {
    if (!frame.clientHeight) return;

    desiredPane = Number(height) || PANE_DEFAULT;
    const { min, max } = paneLimits();
    const clamped = Math.round(Math.min(max, Math.max(min, desiredPane)));

    frame.style.setProperty('--mz-pane-h', `${clamped}px`);
    els.grip.setAttribute('aria-valuemin', String(Math.round(min)));
    els.grip.setAttribute('aria-valuemax', String(Math.round(max)));
    els.grip.setAttribute('aria-valuenow', String(clamped));

    if (persist) {
        desiredPane = clamped;
        settings().paneHeight = clamped;
        saveSettings();
    }
}

function wirePane() {
    els.grip.addEventListener('pointerdown', event => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        dragStart = { y: event.clientY, height: shownPane() };
        frame.classList.add('is-dragging');
        try { els.grip.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
    });

    els.grip.addEventListener('pointermove', event => {
        if (!dragStart) return;
        applyPaneHeight(dragStart.height + (dragStart.y - event.clientY));
    });

    const endDrag = event => {
        if (!dragStart) return;
        dragStart = null;
        frame.classList.remove('is-dragging');
        try { els.grip.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        applyPaneHeight(shownPane(), true);
    };

    els.grip.addEventListener('pointerup', endDrag);
    els.grip.addEventListener('pointercancel', endDrag);

    els.grip.addEventListener('keydown', event => {
        const { max } = paneLimits();
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            applyPaneHeight(shownPane() + 24, true);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            applyPaneHeight(shownPane() - 24, true);
        } else if (event.key === 'Home') {
            event.preventDefault();
            applyPaneHeight(PANE_DEFAULT, true);
        } else if (event.key === 'End') {
            event.preventDefault();
            applyPaneHeight(max, true);
        }
    });
}

/* ---------- actions ---------- */

function openSettings() {
    frame.classList.add('is-settings-open');
    els.sheet.setAttribute('aria-hidden', 'false');
    applyBackground();
    root.querySelector('[data-mz-action="close-settings"]')?.focus({ preventScroll: true });
}

function closeSettings() {
    frame.classList.remove('is-settings-open');
    els.sheet.setAttribute('aria-hidden', 'true');
    root.querySelector('[data-mz-action="settings"]')?.focus({ preventScroll: true });
}

function submitLine() {
    const text = els.input.value.trim();
    if (!text) {
        els.input.focus();
        return;
    }

    // The transcript owns sending; until it exists this is a no-op that keeps
    // the line in the box instead of losing it.
    frame.dispatchEvent(new CustomEvent('mz-send', { detail: { text }, bubbles: true }));
}

function wireActions() {
    frame.addEventListener('click', event => {
        const themePick = event.target.closest('[data-mz-pick-theme]');
        if (themePick) {
            settings().theme = themePick.dataset.mzPickTheme;
            applyTheme();
            saveSettings();
            return;
        }

        const background = event.target.closest('[data-mz-pick-bg]');
        if (background) {
            settings().background = background.dataset.mzPickBg;
            applyBackground();
            saveSettings();
            return;
        }

        const step = event.target.closest('[data-mz-step]');
        if (step) {
            const dir = Number(step.dataset.dir) || 0;
            if (step.dataset.mzStep === 'ui') {
                settings().uiScale = stepValue(UI_STEPS, Number(settings().uiScale) || 1, dir);
                applyScale();
            } else {
                settings().narrSize = stepValue(NARR_STEPS, Number(settings().narrSize) || 18.5, dir);
                applyNarration();
            }
            saveSettings();
            return;
        }

        const action = event.target.closest('[data-mz-action]')?.dataset.mzAction;
        switch (action) {
            case 'settings':
                openSettings();
                break;
            case 'close-settings':
                closeSettings();
                break;
            case 'dismiss':
                closeSettings();
                break;
            case 'motion':
                settings().reducedMotion = !settings().reducedMotion;
                applyMotion();
                saveSettings();
                break;
            case 'reset-pane':
                applyPaneHeight(PANE_DEFAULT, true);
                break;
            case 'send':
                submitLine();
                break;
            case 'exit':
                close();
                break;
            default:
                break;
        }
    });

    els.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submitLine();
        }
    });
}

/* ---------- keys ---------- */

function focusables() {
    return [...frame.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && element.getClientRects().length > 0);
}

function wireKeys() {
    document.addEventListener('keydown', event => {
        if (!isOpen()) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (frame.classList.contains('is-settings-open')) closeSettings();
            else close();
            return;
        }

        if (event.key === 'Tab') {
            const items = focusables();
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }, true);
}

/* ---------- SillyTavern events ---------- */

function wireEvents() {
    const refresh = () => {
        refreshChatName();
        applyBackground();
    };

    on('CHAT_CHANGED', () => {
        if (isOpen()) refresh();
    });
    on('CHAT_CREATED', () => {
        if (isOpen()) refresh();
    });
    on('CHAT_RENAMED', () => {
        if (isOpen()) refresh();
    });
    on('FORCE_SET_BACKGROUND', () => {
        if (isOpen()) applyBackground();
    });
}
