# Meziverse — how it works

Technical notes for version 1.0. Written for whoever picks this up next — including future us.

## The one rule: Ride SillyTavern

Meziverse never reimplements SillyTavern and never touches the chat file behind its back. SillyTavern stays the engine, the UI state and the storage; Meziverse is a scene rendered on top, where **every action is ST's own action, clicked**.

Concretely:

- **Generation, sending, swipes, edits, branches, copy, hide-from-prompt** all click or call ST's own controls and handlers, so every rule ST has (busy gates, empty-input semantics, swipe behaviour, edit autosave) applies unchanged.
- **The chat file is only ever written by ST.** We listen to ST's events; we never write chat data ourselves.
- **Settings** live in ST's `extensionSettings.meziverse`, saved through ST's own `saveSettingsDebounced`. Nothing of ours touches disk.

The single deliberate exception: `body.mz-open .popup` gets a z-lift so ST's own popups (e.g. the new-chat confirm) render above our fullscreen scene. Everything else is scoped to `#mz-root`.

## Layout

```
index.js            entry point; waits for ST, mounts the scene, adds the two ways in
src/
  launcher.js       wand-menu item + Extensions-panel block
  overlay.js         the fullscreen chrome: headers, settings sheet, composer, menus, toasts
  transcript.js     the reading pane + log window: rendering, edit state machine, message actions
  st.js              the ONLY file that talks to SillyTavern (see below)
  settings.js        defaults + read/write of extensionSettings.meziverse
  notify.js          notify() helper + toastr interception while the scene is open
  prose.js           message text → styled prose (ST's formatter output, re-skinned)
  icons.js           inline SVG sprite (mz-i-* symbols)
css/
  00-primitives.css  colours, fonts, sizes, timings, motion — raw variables
  10-semantics.css   semantic tokens; one block per theme (ink-jade / ink-amber / ink-rose)
  20-shell.css       all chrome: frame, headers, pane, log, composer, menus, toasts, settings
style.css            @imports the three sheets (manifest points here)
```

`st.js` is the seam: every touch of ST internals is supposed to live there (`ctx()`, `whenReady()`, event wiring, and wrappers like `clickComposerControl`, `clickOptionsMenu`, `stComposer`, the edit/swipe/branch/copy/hide wrappers). When ST changes an internal, there is one place to fix.

## The scene

- **Mount once, open/close by class.** `#mz-root` is built at boot and hidden; `open()` adds `is-open` (and `body.mz-open`), `close()` removes them. Exit always returns to ST.
- **Two headers.** Meziverse header (34 px): "Meziverse", chat file name, settings + exit. Chat header (48 px): clock/date/place/weather placeholders + log button.
- **Reading pane** shows the newest message as prose; a drag handle resizes it (persisted in settings). The **log** is a floating, stretchable window listing earlier turns, with per-turn actions and its own remembered size.
- **Message actions** replicate ST's message-header menu as flat icon buttons — no dropdowns — on ALL turns: copy, branch, hide-from-prompt (eye), edit, swipe, download-earlier. Edit opens ST's own `.mes_edit` editor (the pane mirrors `#curEditTextarea` one-way) with an edit bar ✓ / 🗑 / ✕; a 400 ms watch owns edit-state exit, and Esc defers to ST while its editor is open.

## The composer

Our textarea and ST's `#send_textarea` stay **mirrored both ways** while the scene is open:

- Our input events write into ST's box (dispatching a real `input` event, so ST's auto-fit, draft save/restore and slash-command processing all run).
- ST's box's input events mirror into ours — which is how an **impersonate draft** (ST writes the result into its own box) lands in our composer and stretches it.

Buttons, all clicking ST's own elements:

- **☰ menu** → `#option_start_new_chat` / `#option_back_to_main` (handlers are bound cold; the hidden ST menu never needs to open). Back-to-parent visibility reads `chatMetadata.main_chat` — the same field ST's own `showBookmarksButtons` uses. ST's OK/Cancel confirm renders above the scene via the z-lift.
- **Impersonate / continue** → `#mes_impersonate` / `#mes_continue`, disabled while generating.
- **Send** → non-empty: fills ST's box and sends through it; empty: clears ST's box and clicks `#send_but`, so **ST's own empty-send semantics decide** (plain AI response, or continue when "Continue on send" is on).
- While generating, send becomes the red **stop** (`stopGeneration()`).

Enter sends, Shift+Enter is a newline. The box grows with content via `field-sizing: content` (same CSS as ST's own box, capped at 50 dvh) and is drag-resizable (`resize: vertical`).

## Theming

Three layers of variables: primitives (raw hex, font names, px, ms) → semantics (`--mz-bg`, `--mz-text`, `--mz-accent`, …) → one block per theme on `#mz-root` (`data-theme="ink-jade|ink-amber|ink-rose"`). Components only ever use semantic tokens; translucent chrome is built with `color-mix()` over those tokens, never hardcoded rgba — that was a bug class we fixed once and never want again.

Settings: theme, background (none = navy-teal gradient, or ST's current), interface scale, narration size, narration font, reduced motion, prose colour mode (theme / ST / custom with four colour pickers).

## Notices

While the scene is open, ST's `toastr` is intercepted: `notify.js` swaps in functions that render Meziverse-style toasts dropping from under the header, tinted by kind (success = accent, info = neutral, warning/error = warn/bad tokens), lingering 5 s. On close, ST's toastr is restored untouched.

## Events we listen to

`CHAT_CHANGED/LOADED/CREATED/DELETED/RENAMED`, `MESSAGE_SENT/RECEIVED/SWIPED/SWIPE_DELETED/EDITED/DELETED/UPDATED`, `MORE_MESSAGES_LOADED`, `GENERATION_ENDED/STOPPED` → full refresh; `STREAM_TOKEN_RECEIVED` → queued refresh. `is-generating` on the frame (send → stop, inputs readonly) tracks generation state.

## Conventions worth keeping

- No bundler; plain ES modules at repo root. `manifest.json`: `js: index.js`, `css: style.css`.
- All selectors/ids/classes prefixed `mz-` / `--mz-*` / `#mz-root`.
- Before shipping: `node --check` every `src/*.js` (copy to temp, rename `.mjs`), brace-balance the CSS, then push → `git pull` in the deployment clone → reload the tab and confirm the served file actually changed (a reload can silently fail in an embedded browser).
- ST formatter output to expect: `<p>` wrapper, `<br>` newlines, `<q>`, `<em>`, `<strong>`.

## The next layer (not built yet)

The **M-series** trackers — Scene, Profiles, Shifts, Threads, Plans, later Standing/Hooks/Lore/Chronicle — will ride the same principle: state in `chatMetadata.meziverse` (per chat, saved by ST), injected into the prompt via `ctx().setExtensionPrompt('meziverse_state', …)`, exchanged with the model as in-band JSON tags. The phone is the intended UI, and its buttons are placeholders in v1. See `LocalHelpFiles/Frame VN Tracker Extension (Design Spec v0.1).md` — that spec is authoritative for the M-series.
