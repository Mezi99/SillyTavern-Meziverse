/**
 * The fullscreen scene: mounting, opening and closing it, the settings sheet,
 * and the reading pane's drag handle.
 *
 * The transcript itself lives in transcript.js and is wired in here; this file
 * only owns the chrome around it.
 */

import { currentChatId, on, sendUserMessage, stopGeneration, clickComposerControl, clickOptionsMenu, hasParentChat, stComposer } from './st.js';
import { settings, saveSettings } from './settings.js';
import { injectSprite } from './icons.js';
import { createTranscript } from './transcript.js';
import { mountCast, refreshCastSizing, renderCast } from './cast.js';
import { interceptToastr } from './notify.js';

const VERSION = '0.7.0';
const PANE_DEFAULT = 300;
const LOG_W_DEFAULT = 720;
const LOG_H_SHARE = 0.7;
const UI_STEPS = [0.9, 0.95, 1, 1.05, 1.1, 1.2];
const NARR_STEPS = [12, 13, 14, 15, 16, 17, 18, 18.5, 19, 20, 21, 22, 24];

/* The prose inks, as tokens on #mz-root and as keys in settings(). */
const PROSE_TOKENS = ['plain', 'q', 'em', 'strong'];
const PROSE_KEYS = { plain: 'prosePlain', q: 'proseQ', em: 'proseEm', strong: 'proseStrong' };

const THEMES = [
    { id: 'ink-jade', name: 'Jade', swatch: 'linear-gradient(90deg, #0c0e11 0 56%, #77c2aa 56%)' },
    { id: 'ink-amber', name: 'Amber', swatch: 'linear-gradient(90deg, #0e0d0b 0 56%, #cfaa72 56%)' },
    { id: 'ink-rose', name: 'Rose', swatch: 'linear-gradient(90deg, #0d0c10 0 56%, #c8929c 56%)' },
];

/* "theme" leaves the face the theme chose; the rest override it. */
const NARR_FONTS = {
    theme: null,
    newsreader: '"Newsreader", Georgia, "Times New Roman", serif',
    spectral: '"Spectral", "Newsreader", Georgia, serif',
    lora: '"Lora", "Newsreader", Georgia, serif',
    'source-serif': '"Source Serif 4", Georgia, "Times New Roman", serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    system: 'Georgia, "Times New Roman", serif',
};

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

const FRAME_HTML = `
<div class="mz-frame" role="dialog" aria-modal="true" aria-label="Meziverse">
    <div class="mz-bg" aria-hidden="true"></div>
    <div class="mz-scrim" aria-hidden="true"></div>

    <header class="mz-header">
        <div class="mz-brand"><b>Meziverse</b></div>
        <div class="mz-chatname" data-mz="chatname"><b class="is-empty">No chat open</b></div>
        <div class="mz-header-tools">
            <button class="mz-ibtn" type="button" title="Full screen" aria-label="Full screen" data-mz-action="fullscreen">${svg('expand')}</button>
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
            <button class="mz-ibtn" type="button" title="Chat log" aria-label="Chat log" aria-expanded="false" data-mz-action="log">${svg('list')}</button>
        </div>
    </header>

    <div class="mz-cast" role="group" aria-label="Cast"></div>

    <section class="mz-dlg" aria-label="Reading pane">
        <div class="mz-grip" role="separator" aria-orientation="horizontal" aria-label="Resize reading pane" tabindex="0"></div>
        <header class="mz-dlg-head">
            <span class="mz-speaker" data-mz="speaker"></span>
            <span class="mz-dlg-nav">
                <button class="mz-ibtn" type="button" title="Previous turn" aria-label="Previous turn" data-mz-action="prev">${svg('prev')}</button>
                <span class="mz-dlg-meta" data-mz="meta"></span>
                <button class="mz-ibtn" type="button" title="Next turn" aria-label="Next turn" data-mz-action="next">${svg('next')}</button>
                <button class="mz-ibtn" type="button" title="Latest turn" aria-label="Latest turn" data-mz-action="latest">${svg('latest')}</button>
            </span>
            <span class="mz-dlg-actions">
                <button class="mz-ibtn" type="button" title="Copy" aria-label="Copy" data-mz-action="copy">${svg('copy')}</button>
                <button class="mz-ibtn" type="button" title="Branch from this turn" aria-label="Branch from this turn" data-mz-action="branch">${svg('branch')}</button>
                <button class="mz-ibtn" type="button" title="Exclude message from prompts" aria-label="Exclude message from prompts" data-mz-action="toggle-prompt">${svg('eye')}</button>
                <button class="mz-ibtn" type="button" title="Edit this turn" aria-label="Edit this turn" data-mz-action="edit">${svg('pencil')}</button>
            </span>
            <span class="mz-dlg-actions mz-dlg-editbar" hidden>
                <button class="mz-ibtn" type="button" title="Accept changes" aria-label="Accept changes" data-mz-action="edit-accept">${svg('check')}</button>
                <button class="mz-ibtn" type="button" title="Delete message" aria-label="Delete message" data-mz-action="edit-delete">${svg('trash')}</button>
                <button class="mz-ibtn" type="button" title="Discard changes" aria-label="Discard changes" data-mz-action="edit-cancel">${svg('close')}</button>
            </span>
        </header>
        <div class="mz-prose" data-mz="prose">
            <p class="mz-prose-empty">The scene begins when you write.</p>
        </div>
        <textarea class="mz-edit" data-mz="edit" hidden spellcheck="true" aria-label="Edit this turn"></textarea>
        <div class="mz-swipebar" data-mz="swipebar" hidden>
            <button class="mz-swipebtn" type="button" title="Previous swipe" aria-label="Previous swipe" data-mz-action="swipe-prev">${svg('prev')}</button>
            <span class="mz-swipe-count" data-mz="swipe-count"></span>
            <button class="mz-swipebtn" type="button" title="Next swipe" aria-label="Next swipe" data-mz-action="swipe-next">${svg('next')}</button>
        </div>
        <div class="mz-composer">
            <div class="mz-composer-box">
                <button class="mz-ibtn mz-menu-btn" type="button" title="Chat options" aria-label="Chat options" aria-haspopup="true" aria-expanded="false" data-mz-action="menu">${svg('menu')}</button>
                <div class="mz-menu" role="menu" aria-label="Chat options" hidden>
                    <button class="mz-menu-item" type="button" role="menuitem" data-mz-action="new-chat">${svg('chat-new')}<span>Start new chat</span></button>
                    <button class="mz-menu-item" type="button" role="menuitem" data-mz-action="back-to-parent">${svg('chat-parent')}<span>Back to parent chat</span></button>
                </div>
                <textarea class="mz-input" data-mz="input" rows="1" placeholder="Write your line\u2026" autocomplete="off" spellcheck="true" aria-label="Your line"></textarea>
            </div>
            <span class="mz-composer-tools">
                <button class="mz-ibtn mz-sendbtn" type="button" title="Impersonate" aria-label="Impersonate" data-mz-action="impersonate">${svg('impersonate')}</button>
                <button class="mz-ibtn mz-sendbtn" type="button" title="Continue" aria-label="Continue" data-mz-action="continue">${svg('continue')}</button>
                <button class="mz-ibtn mz-sendbtn" type="button" title="Send" aria-label="Send" data-mz-action="send">${svg('send')}</button>
            </span>
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
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Pane transparency</b><small>How much of the background shows through the reading pane.</small></span>
                <div class="mz-range">
                    <input type="range" min="20" max="100" step="5" data-mz="pane-opacity" aria-label="Pane transparency">
                    <span data-mz="pane-opacity-value">90%</span>
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
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Narration font</b><small>The face the story is set in.</small></span>
                <select class="mz-select" data-mz="font" aria-label="Narration font">
                    <option value="theme">Theme default</option>
                    <option value="newsreader">Newsreader</option>
                    <option value="spectral">Spectral</option>
                    <option value="lora">Lora</option>
                    <option value="source-serif">Source Serif 4</option>
                    <option value="inter">Inter</option>
                    <option value="system">System serif</option>
                </select>
            </div>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Prose colors</b><small>Plain, speech, emphasis, strong — pane and log.</small></span>
                <div class="mz-seg" role="group" aria-label="Prose colors">
                    <button type="button" data-mz-pick-prose="theme">Theme</button>
                    <button type="button" data-mz-pick-prose="st">SillyTavern</button>
                    <button type="button" data-mz-pick-prose="custom">Custom</button>
                </div>
            </div>
            <div class="mz-set-row mz-set-row--colors" data-mz="prose-pickers" hidden>
                <span class="mz-set-label"><b>Pick your inks</b><small>Plain text, speech, emphasis, strong.</small></span>
                <div class="mz-colors">
                    <label class="mz-color"><input type="color" data-mz-color="plain" aria-label="Plain color"><span>Plain</span></label>
                    <label class="mz-color"><input type="color" data-mz-color="q" aria-label="Speech color"><span>Speech</span></label>
                    <label class="mz-color"><input type="color" data-mz-color="em" aria-label="Emphasis color"><span>Emphasis</span></label>
                    <label class="mz-color"><input type="color" data-mz-color="strong" aria-label="Strong color"><span>Strong</span></label>
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

    <aside class="mz-log" aria-hidden="true" aria-label="Chat log">
        <div class="mz-log-grip mz-log-grip-h" role="separator" aria-orientation="horizontal" aria-label="Resize chat log height" tabindex="0"></div>
        <div class="mz-log-grip mz-log-grip-w" role="separator" aria-orientation="vertical" aria-label="Resize chat log width" tabindex="0"></div>
        <header class="mz-log-head">
            <h2>Chat log</h2>
            <button class="mz-ibtn" type="button" title="Close log" aria-label="Close log" data-mz-action="close-log">${svg('close')}</button>
        </header>
        <ol class="mz-log-list" data-mz="log-list"></ol>
    </aside>
</div>`;

let root = null;
let frame = null;
let els = {};
let transcript = null;
let lastFocus = null;
let previousOverflow = null;
let restoreToastr = null;
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
        date: root.querySelector('[data-mz="date"]'),
        time: root.querySelector('[data-mz="time"]'),
        place: root.querySelector('[data-mz="place"]'),
        weather: root.querySelector('[data-mz="weather"]'),
        cast: root.querySelector('.mz-cast'),
        prose: root.querySelector('[data-mz="prose"]'),
        speaker: root.querySelector('[data-mz="speaker"]'),
        meta: root.querySelector('[data-mz="meta"]'),
        input: root.querySelector('[data-mz="input"]'),
        sendButton: root.querySelector('[data-mz-action="send"]'),
        impersonateButton: root.querySelector('[data-mz-action="impersonate"]'),
        continueButton: root.querySelector('[data-mz-action="continue"]'),
        menuButton: root.querySelector('[data-mz-action="menu"]'),
        menu: root.querySelector('.mz-menu'),
        menuNewChat: root.querySelector('[data-mz-action="new-chat"]'),
        menuBackToParent: root.querySelector('[data-mz-action="back-to-parent"]'),
        grip: root.querySelector('.mz-grip'),
        sheet: root.querySelector('.mz-sheet'),
        motion: root.querySelector('[data-mz-action="motion"]'),
        uiValue: root.querySelector('[data-mz="ui-value"]'),
        narrValue: root.querySelector('[data-mz="narr-value"]'),
        fontSelect: root.querySelector('[data-mz="font"]'),
        paneOpacity: root.querySelector('[data-mz="pane-opacity"]'),
        paneOpacityValue: root.querySelector('[data-mz="pane-opacity-value"]'),
        prosePickers: root.querySelector('[data-mz="prose-pickers"]'),
        colorInputs: [...root.querySelectorAll('[data-mz-color]')],
        fullscreenButton: root.querySelector('[data-mz-action="fullscreen"]'),
        prevButton: root.querySelector('[data-mz-action="prev"]'),
        nextButton: root.querySelector('[data-mz-action="next"]'),
        latestButton: root.querySelector('[data-mz-action="latest"]'),
        branchButton: root.querySelector('[data-mz-action="branch"]'),
        copyButton: root.querySelector('[data-mz-action="copy"]'),
        togglePromptButton: root.querySelector('[data-mz-action="toggle-prompt"]'),
        editButton: root.querySelector('[data-mz-action="edit"]'),
        actionsRow: root.querySelector('.mz-dlg-actions:not(.mz-dlg-editbar)'),
        editBar: root.querySelector('.mz-dlg-editbar'),
        editAccept: root.querySelector('[data-mz-action="edit-accept"]'),
        editDelete: root.querySelector('[data-mz-action="edit-delete"]'),
        editCancel: root.querySelector('[data-mz-action="edit-cancel"]'),
        edit: root.querySelector('[data-mz="edit"]'),
        swipeBar: root.querySelector('[data-mz="swipebar"]'),
        swipePrev: root.querySelector('[data-mz-action="swipe-prev"]'),
        swipeNext: root.querySelector('[data-mz-action="swipe-next"]'),
        swipeCount: root.querySelector('[data-mz="swipe-count"]'),
        logPanel: root.querySelector('.mz-log'),
        logGripH: root.querySelector('.mz-log-grip-h'),
        logGripW: root.querySelector('.mz-log-grip-w'),
        logList: root.querySelector('[data-mz="log-list"]'),
        logButton: root.querySelector('[data-mz-action="log"]'),
        logClose: root.querySelector('[data-mz-action="close-log"]'),
    };

    mountCast(els.cast);

    transcript = createTranscript({
        frame,
        isOpen,
        speaker: els.speaker,
        meta: els.meta,
        prose: els.prose,
        logPanel: els.logPanel,
        logList: els.logList,
        logButton: els.logButton,
        logClose: els.logClose,
        prevButton: els.prevButton,
        nextButton: els.nextButton,
        latestButton: els.latestButton,
        branchButton: els.branchButton,
        copyButton: els.copyButton,
        togglePromptButton: els.togglePromptButton,
        editButton: els.editButton,
        actionsRow: els.actionsRow,
        editBar: els.editBar,
        editAccept: els.editAccept,
        editDelete: els.editDelete,
        editCancel: els.editCancel,
        edit: els.edit,
        swipeBar: els.swipeBar,
        swipePrev: els.swipePrev,
        swipeNext: els.swipeNext,
        swipeCount: els.swipeCount,
        onShown: ({ scene }) => applyScene(scene),
    });

    desiredPane = Number(settings().paneHeight) || PANE_DEFAULT;

    applyTheme();
    applyMotion();
    applyScale();
    applyNarration();
    applyNarrationFont();
    applyProseColors();
    applyPaneOpacity();
    applyLogWidth(Number(settings().logWidth) || LOG_W_DEFAULT);

    wireActions();
    wireMenu();
    wireComposer();
    wirePane();
    wireLog();
    wireFullscreen();
    wireKeys();
    wireEvents();

    window.addEventListener('resize', () => {
        if (!isOpen() || resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            applyPaneHeight(desiredPane);
            applyLogWidth(Number(settings().logWidth) || LOG_W_DEFAULT);
            if (Number(settings().logHeight) > 0) applyLogHeight(settings().logHeight);
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
    // SillyTavern's own popups are dialogs and climb above the scene, but its
    // toastr notices do not; while the scene is open they are re-rendered
    // as Meziverse notices instead.
    restoreToastr = interceptToastr();
    frame.classList.remove('is-settings-open', 'is-log-open', 'is-dragging');
    els.sheet.setAttribute('aria-hidden', 'true');
    els.logPanel.setAttribute('aria-hidden', 'true');
    els.logButton.setAttribute('aria-expanded', 'false');

    refreshChatName();
    applyBackground();
    applyProseColors();
    applyPaneOpacity();
    applyLogWidth(Number(settings().logWidth) || LOG_W_DEFAULT);
    if (Number(settings().logHeight) > 0) applyLogHeight(settings().logHeight);
    setGenerating(stGenerating(), { force: true });
    if (stGenerating()) startWatch();
    enterFullscreen();
    transcript.refresh({ followLatest: true });
    desiredPane = Number(settings().paneHeight) || PANE_DEFAULT;
    applyPaneHeight(desiredPane);
    measureChatbar();
    requestAnimationFrame(refreshCastSizing);

    els.input?.focus({ preventScroll: true });
    syncFromSt();
    refreshMenu();
    closeMenu();
}

/** Hides the scene and hands the page back to SillyTavern. */
export function close() {
    if (!isOpen()) return;

    if (frame.contains(document.activeElement)) document.activeElement.blur();

    leaveFullscreen();

    root.classList.remove('is-open', 'is-settings-open');
    root.setAttribute('aria-hidden', 'true');
    restoreToastr?.();
    restoreToastr = null;
    els.sheet.setAttribute('aria-hidden', 'true');
    frame.classList.remove('is-dragging', 'is-log-open');
    els.logPanel.setAttribute('aria-hidden', 'true');
    els.logButton.setAttribute('aria-expanded', 'false');

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

function applyNarrationFont() {
    const stored = settings().narrFont;
    const key = Object.prototype.hasOwnProperty.call(NARR_FONTS, stored) ? stored : 'theme';
    const stack = NARR_FONTS[key];

    // No inline value means the theme's own face, from 10-semantics.css.
    if (stack) root.style.setProperty('--mz-font-prose', stack);
    else root.style.removeProperty('--mz-font-prose');

    if (els.fontSelect) els.fontSelect.value = key;
}

/* The reading pane's own see-through-ness, as a fraction the CSS multiplies
   into both of its background stops. Only the pane; the scene behind it is
   never touched. */
function applyPaneOpacity() {
    const raw = Number(settings().paneOpacity);
    const percent = Number.isFinite(raw) ? Math.min(100, Math.max(20, raw)) : 90;

    root.style.setProperty('--mz-pane-alpha', String(percent / 100));

    if (els.paneOpacity) els.paneOpacity.value = String(percent);
    if (els.paneOpacityValue) els.paneOpacityValue.textContent = `${percent}%`;
}

/* Reads the prose inks SillyTavern's chat has right now. A hidden probe
   rides inside #chat for one tick — long enough for getComputedStyle to see
   what .mes_text would show — and is removed before anything can observe it. */
function sampleStProse() {
    const chat = document.getElementById('chat');
    if (!chat) return null;

    const probe = document.createElement('div');
    probe.className = 'mes';
    probe.style.display = 'none';
    probe.innerHTML = '<div class="mes_text">plain<q>speech</q><em>em</em><strong>strong</strong></div>';
    chat.append(probe);

    const text = probe.querySelector('.mes_text');
    const inks = {
        plain: getComputedStyle(text).color,
        q: getComputedStyle(text.querySelector('q')).color,
        em: getComputedStyle(text.querySelector('em')).color,
        strong: getComputedStyle(text.querySelector('strong')).color,
    };

    probe.remove();
    return inks;
}

function applyProseColors() {
    const mode = settings().proseColors;

    // The segmented control mirrors the chosen mode.
    root.querySelectorAll('[data-mz-pick-prose]').forEach(button => {
        const isOn = button.dataset.mzPickProse === mode;
        button.classList.toggle('is-on', isOn);
        button.setAttribute('aria-pressed', String(isOn));
    });

    // Custom pickers only make sense in Custom mode.
    if (els.prosePickers) els.prosePickers.hidden = mode !== 'custom';
    els.colorInputs.forEach(input => { input.value = settings()[PROSE_KEYS[input.dataset.mzColor]] || '#000000'; });

    // Theme mode: drop every override so the theme tokens cascade.
    if (mode === 'theme') {
        PROSE_TOKENS.forEach(token => root.style.removeProperty(`--mz-prose-${token}`));
        root.style.removeProperty('--mz-prose-log-plain');
        return;
    }

    // Both other modes set the four inks inline; only the source differs.
    const inks = mode === 'st'
        ? sampleStProse()
        : PROSE_TOKENS.reduce((carry, token) => {
            carry[token] = settings()[PROSE_KEYS[token]];
            return carry;
        }, {});

    const applied = {};
    for (const token of PROSE_TOKENS) {
        const value = typeof inks[token] === 'string' ? inks[token].trim() : '';
        if (value) {
            root.style.setProperty(`--mz-prose-${token}`, value);
            applied[token] = value;
        } else {
            root.style.removeProperty(`--mz-prose-${token}`);
        }
    }

    // The log keeps its muted recap tint in Theme mode; elsewhere it follows
    // the chosen plain ink.
    if (applied.plain) root.style.setProperty('--mz-prose-log-plain', applied.plain);
    else root.style.removeProperty('--mz-prose-log-plain');
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

/* ---------- full screen ---------- */

function enterFullscreen() {
    if (document.fullscreenElement || typeof root.requestFullscreen !== 'function') return;

    // The browser needs a gesture; opening the overlay from a click is one.
    try {
        root.requestFullscreen({ navigationUI: 'hide' })?.catch?.(() => {});
    } catch {
        // Refused: the overlay still fills the window, just with browser chrome.
    }
}

function leaveFullscreen() {
    if (document.fullscreenElement !== root || typeof document.exitFullscreen !== 'function') return;
    document.exitFullscreen()?.catch?.(() => {});
}

function syncFullscreen() {
    const on = document.fullscreenElement === root;

    els.fullscreenButton.innerHTML = svg(on ? 'collapse' : 'expand');
    const label = on ? 'Leave full screen' : 'Full screen';
    els.fullscreenButton.title = label;
    els.fullscreenButton.setAttribute('aria-label', label);
}

function wireFullscreen() {
    document.addEventListener('fullscreenchange', syncFullscreen);
    syncFullscreen();
}

/* ---------- chat name ---------- */

function refreshChatName() {
    const id = currentChatId();
    const label = id || 'No chat open';
    els.chatNameText.textContent = label;
    els.chatNameText.classList.toggle('is-empty', !id);
    els.chatName.title = label;
}

/* ---------- scene header and cast ---------- */

/**
 * Publishes the chat-bar's real height as `--mz-chatbar-real`. The bar grows
 * to two lines when a scene's place is long, and the cast stage anchors to its
 * underside, so the fixed design height is only a floor. Remeasure whenever
 * the header text changes or the window resizes.
 */
function measureChatbar() {
    const bar = root.querySelector('.mz-chatbar');
    if (!bar) return;

    const height = Math.round(bar.getBoundingClientRect().height);
    if (height > 0) root.style.setProperty('--mz-chatbar-real', `${height}px`);
}

/**
 * Puts the governing scene into the chrome: the clock, the place, the weather
 * chip and the cast strip. `record` is transcript's `{tag, index, scene}` for
 * the turn on screen, or null when the chat has no usable scene yet.
 */
function applyScene(record) {
    const scene = record?.scene || null;

    els.date.textContent = scene?.date || '\u2014';
    els.date.title = scene?.dateRaw || '';
    els.time.textContent = scene ? scene.time : '--:--';
    els.time.title = scene?.time || '';
    els.place.textContent = scene?.placeFull || '\u2014';
    els.place.title = scene?.placeFull || '';

    if (scene?.weather) {
        els.weather.textContent = scene.weather;
        els.weather.hidden = false;
    } else {
        els.weather.textContent = '';
        els.weather.hidden = true;
    }

    measureChatbar();
    renderCast(scene);
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

    refreshCastSizing();
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

/* ---------- sending ---------- */

/**
 * SillyTavern's own generating state: it shows the stop button only for real
 * generations. Dry runs (another extension assembling a prompt) and finished
 * runs never show it, so this is the truth our UI must agree with.
 */
function stGenerating() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

let generating = false;
let generatingDirty = false;
let watchTimer = null;

/**
 * Brings the UI to the state asked for, skipping the DOM writes when nothing
 * changed: the composer must never miss the flip back to "send".
 *
 * @param {boolean} on
 * @param {{ force?: boolean }} [options]
 */
function setGenerating(on, { force = false } = {}) {
    const busy = !!on;
    generating = busy;
    if (busy === frame.classList.contains('is-generating') && !force) return;

    frame.classList.toggle('is-generating', busy);
    els.sendButton.innerHTML = svg(busy ? 'stop' : 'send');

    const label = busy ? 'Stop generating' : 'Send';
    els.sendButton.title = label;
    els.sendButton.setAttribute('aria-label', label);

    els.input.readOnly = busy;
    els.input.placeholder = busy ? 'Generating\u2026' : 'Write your line\u2026';

    // impersonate and continue sit beside send; SillyTavern gates them with
    // is_send_press, so grey them for exactly as long as the send flips.
    els.impersonateButton.disabled = busy;
    els.continueButton.disabled = busy;

    generatingDirty = busy;

    // the swipe footer lives and dies with this state; redraw once it flips
    transcript?.refresh();
}

/**
 * While we believe a generation runs, keep asking SillyTavern. Extensions can
 * start dry-run generations that never emit GENERATION_ENDED, and any missed
 * event would leave the composer locked; this heals the state within a beat.
 */
function startWatch() {
    if (watchTimer !== null) return;

    watchTimer = setInterval(() => {
        if (!generating) {
            clearInterval(watchTimer);
            watchTimer = null;
            return;
        }

        if (!stGenerating()) {
            setGenerating(false);
        }
    }, 500);
}

/* ---------- log geometry ---------- */

function applyLogWidth(width, persist = false) {
    if (!frame.clientWidth) return;

    const min = cssPx('--mz-log-w-min', 320);
    const max = Math.max(min, frame.clientWidth - 24);
    const clamped = Math.round(Math.min(max, Math.max(min, Number(width) || LOG_W_DEFAULT)));

    frame.style.setProperty('--mz-log-w', `${clamped}px`);
    els.logGripW.setAttribute('aria-valuemin', String(Math.round(min)));
    els.logGripW.setAttribute('aria-valuemax', String(max));
    els.logGripW.setAttribute('aria-valuenow', String(clamped));

    if (persist) {
        settings().logWidth = clamped;
        saveSettings();
    }
}

function applyLogHeight(height, persist = false) {
    if (!frame.clientHeight) return;

    const min = Math.round(frame.clientHeight * 0.35);
    const max = Math.max(min, frame.clientHeight - 44);
    const clamped = Math.round(Math.min(max, Math.max(min, Number(height) || min)));

    frame.style.setProperty('--mz-log-h', `${clamped}px`);
    els.logGripH.setAttribute('aria-valuemin', String(min));
    els.logGripH.setAttribute('aria-valuemax', String(max));
    els.logGripH.setAttribute('aria-valuenow', String(clamped));

    if (persist) {
        settings().logHeight = clamped;
        saveSettings();
    }
}

/**
 * Wires one resizing grip. The window stays centered while it resizes, so a
 * dragged edge must travel twice the pointer's distance to keep tracking it.
 */
function wireGrip(grip, apply, measure, { axis, resetTo }) {
    let start = null;

    grip.addEventListener('pointerdown', event => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        start = { from: event[axis], size: measure() };
        frame.classList.add('is-log-resizing');
        try { grip.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
    });

    grip.addEventListener('pointermove', event => {
        if (!start) return;
        apply(start.size + (start.from - event[axis]) * 2);
    });

    const endDrag = event => {
        if (!start) return;
        start = null;
        frame.classList.remove('is-log-resizing');
        try { grip.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        apply(measure(), true);
    };

    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);

    grip.addEventListener('keydown', event => {
        const growKey = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
        const shrinkKey = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
        const step = axis === 'y' ? 24 : 48;

        if (event.key === growKey) {
            event.preventDefault();
            apply(measure() + step, true);
        } else if (event.key === shrinkKey) {
            event.preventDefault();
            apply(measure() - step, true);
        } else if (event.key === 'Home') {
            event.preventDefault();
            apply(resetTo(), true);
        }
    });
}

function wireLog() {
    wireGrip(els.logGripH, applyLogHeight, () => els.logPanel.offsetHeight, {
        axis: 'y',
        resetTo: () => Math.round(frame.clientHeight * LOG_H_SHARE),
    });
    wireGrip(els.logGripW, applyLogWidth, () => els.logPanel.offsetWidth, {
        axis: 'x',
        resetTo: () => LOG_W_DEFAULT,
    });
}

/* ---------- three-lines menu ---------- */

/** Brings the menu's items in line with what SillyTavern allows right now. */
function refreshMenu() {
    const hasParent = hasParentChat();
    els.menuBackToParent.hidden = !hasParent;
    els.menuBackToParent.disabled = !hasParent;
}

function openMenu() {
    refreshMenu();
    els.menu.hidden = false;
    els.menuButton.setAttribute('aria-expanded', 'true');
    els.menuButton.classList.add('is-on');
}

function closeMenu() {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    els.menuButton.setAttribute('aria-expanded', 'false');
    els.menuButton.classList.remove('is-on');
}

function toggleMenu() {
    if (els.menu.hidden) openMenu();
    else closeMenu();
}

/**
 * Both items ride SillyTavern's own menu options: the new-chat confirm
 * dialog and the parent-chat switch are its, and CHAT_CHANGED carries the
 * transcript across.
 */
function runMenuOption(optionId) {
    const fired = clickOptionsMenu(optionId);
    closeMenu();
    if (!fired) els.input.focus({ preventScroll: true });
}

function wireMenu() {
    els.menuButton.addEventListener('click', event => {
        event.stopPropagation();
        toggleMenu();
    });

    els.menu.addEventListener('click', event => {
        const item = event.target.closest('[data-mz-action]');
        if (!item || !els.menu.contains(item)) return;

        event.stopPropagation();
        switch (item.dataset.mzAction) {
            case 'new-chat':
                runMenuOption('option_start_new_chat');
                break;
            case 'back-to-parent':
                runMenuOption('option_back_to_main');
                break;
            default:
                break;
        }
    });

    // a click anywhere else, or leaving the pane, puts the menu away
    frame.addEventListener('click', event => {
        if (els.menu.hidden) return;
        if (event.target.closest('.mz-composer-box')) return;
        closeMenu();
    });

    frame.addEventListener('focusin', event => {
        if (els.menu.hidden) return;
        if (event.target.closest('.mz-composer-box')) return;
        closeMenu();
    });

    els.menu.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        els.menuButton.focus({ preventScroll: true });
    });
}

/* ---------- composer ---------- */

/**
 * Keeps our box and SillyTavern's in step while the scene is open.
 * SillyTavern's textarea is the one its send handler reads, and the one
 * impersonation drops its draft into; ours is the face the user sees.
 */
function syncFromSt() {
    const st = stComposer();
    if (!st || !isOpen()) return;
    if (st.value === els.input.value) return;

    els.input.value = st.value;
    // impersonate drafts can be long; make sure the grown box is visible
    if (document.activeElement !== els.input && st.value) {
        els.input.setSelectionRange(st.value.length, st.value.length);
    }
}

function wireComposer() {
    // SillyTavern writes impersonation drafts into its own box; mirror them.
    const st = stComposer();
    st?.addEventListener('input', syncFromSt);

    els.input.addEventListener('input', () => {
        const box = stComposer();
        if (!box || box.value === els.input.value) return;
        box.value = els.input.value;
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });

    els.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            if (!frame.classList.contains('is-generating')) submitLine();
        }
    });
}

/* ---------- actions ---------- */

function openSettings() {
    transcript.closeLog(false);
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
    if (frame.classList.contains('is-generating')) {
        stopGeneration();
        return;
    }

    const text = els.input.value.trim();

    // An empty box sends exactly as SillyTavern's own: with "Continue on
    // send" on it continues the last reply, otherwise the AI simply responds.
    if (!text) {
        // keep SillyTavern's own box empty so its semantics decide
        const st = stComposer();
        if (st) {
            st.value = '';
            st.dispatchEvent(new Event('input', { bubbles: true }));
        }
        clickComposerControl('send_but');
        return;
    }

    // ST's own composer does the sending, so the native pipeline runs.
    if (!sendUserMessage(text)) {
        els.input.focus();
        return;
    }

    els.input.value = '';
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

        const prosePick = event.target.closest('[data-mz-pick-prose]');
        if (prosePick) {
            settings().proseColors = prosePick.dataset.mzPickProse;
            applyProseColors();
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
            case 'log':
                if (frame.classList.contains('is-settings-open')) closeSettings();
                transcript.openLog();
                break;
            case 'close-log':
                transcript.closeLog();
                break;
            case 'prev':
                transcript.step(-1);
                break;
            case 'next':
                transcript.step(1);
                break;
            case 'latest':
                transcript.latest();
                break;
            case 'swipe-prev':
                transcript.swipeShownTurn('left');
                break;
            case 'swipe-next':
                transcript.swipeShownTurn('right');
                break;
            case 'copy':
                transcript.copyShownTurn();
                break;
            case 'toggle-prompt':
                transcript.togglePromptHidden();
                break;
            case 'edit':
                transcript.editShownTurn();
                break;
            case 'edit-accept':
                transcript.acceptShownEdit();
                break;
            case 'edit-delete':
                transcript.deleteShownEdit();
                break;
            case 'edit-cancel':
                transcript.cancelShownEdit();
                break;
            case 'branch':
                transcript.branchHere();
                break;
            case 'fullscreen':
                if (document.fullscreenElement === root) leaveFullscreen();
                else enterFullscreen();
                break;
            case 'dismiss':
                if (transcript.isLogOpen()) transcript.closeLog();
                else closeSettings();
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
            case 'impersonate':
                if (!frame.classList.contains('is-generating')) clickComposerControl('mes_impersonate');
                break;
            case 'continue':
                if (!frame.classList.contains('is-generating')) clickComposerControl('mes_continue');
                break;
            case 'menu':
                toggleMenu();
                break;
            case 'exit':
                close();
                break;
            default:
                break;
        }
    });

    els.fontSelect?.addEventListener('change', () => {
        settings().narrFont = els.fontSelect.value;
        applyNarrationFont();
        saveSettings();
    });

    els.paneOpacity?.addEventListener('input', () => {
        settings().paneOpacity = Number(els.paneOpacity.value);
        applyPaneOpacity();
        saveSettings();
    });

    els.colorInputs.forEach(input => {
        input.addEventListener('input', () => {
            settings()[PROSE_KEYS[input.dataset.mzColor]] = input.value;
            applyProseColors();
            saveSettings();
        });
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
            // In full screen the first Esc belongs to the browser.
            if (document.fullscreenElement) return;

            // While SillyTavern's editor is open, Esc belongs to it: ST's own
            // handler accepts or cancels per its auto-save setting. Our watch
            // follows the editor closing either way.
            if (document.querySelector('#chat .mes .edit_textarea')) return;

            event.preventDefault();
            event.stopPropagation();
            if (transcript?.isLogOpen()) transcript.closeLog();
            else if (frame.classList.contains('is-settings-open')) closeSettings();
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

    // A resize can wrap the place onto two lines, which moves the cast stage.
    window.addEventListener('resize', () => {
        measureChatbar();
        refreshCastSizing();
    });

    on('CHAT_CHANGED', () => {
        if (isOpen()) {
            refresh();
            refreshMenu();
            closeMenu();
        }
    });
    on('CHAT_CREATED', () => {
        if (isOpen()) {
            refresh();
            refreshMenu();
            closeMenu();
        }
    });
    on('CHAT_RENAMED', () => {
        if (isOpen()) refresh();
    });
    on('FORCE_SET_BACKGROUND', () => {
        if (isOpen()) applyBackground();
    });

    // Dry runs (another extension assembling its prompt) never reach the chat:
    // following them would wedge the composer, since no GENERATION_ENDED comes.
    on('GENERATION_STARTED', (type, _options, dryRun) => {
        if (dryRun) return;
        setGenerating(true);
        startWatch();
    });
    on('GENERATION_ENDED', () => setGenerating(false));
    on('GENERATION_STOPPED', () => setGenerating(false));
    on('GROUP_WRAPPER_FINISHED', () => setGenerating(false));
}
