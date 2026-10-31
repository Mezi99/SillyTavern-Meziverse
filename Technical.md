# Meziverse — how it works

Technical notes for version 2.1. Written for whoever picks this up next — including future us.

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
  settings.js        defaults + read/write of extensionSettings.meziverse + modeOn()
  notify.js          notify() helper + toastr interception while the scene is open
  tags.js            tolerant tag tokenizer + stripTags (pure: no DOM, no ST)
  scene.js           scene resolution: last-usable rule, date/time split, location levels, cast names
  prose.js           message text → styled prose + inline scene rows
  cast.js            the cast strip: posters, per-chat portraits, upload
  icons.js           inline SVG sprite (mz-i-* symbols)
test/
  tags.test.js       synthetic tokenizer tests
  scene.test.js      synthetic scene tests
css/
  00-primitives.css  colours, fonts, sizes, timings, motion — raw variables
  10-semantics.css   semantic tokens; one block per theme (ink-jade / ink-amber / ink-rose)
  20-shell.css       all chrome: frame, headers, pane, log, composer, menus, toasts, settings
  30-story.css       scene features: scene rows, cast strip, portrait plates
style.css            @imports the four sheets (manifest points here)
```

`st.js` is the seam: every touch of ST internals is supposed to live there (`ctx()`, `whenReady()`, event wiring, and wrappers like `clickComposerControl`, `clickOptionsMenu`, `stComposer`, the edit/swipe/branch/copy/hide wrappers). When ST changes an internal, there is one place to fix.

## The scene

- **Mount once, open/close by class.** `#mz-root` is built at boot and hidden; `open()` adds `is-open` (and `body.mz-open`), `close()` removes them. Exit always returns to ST.
- **Two headers.** Meziverse header (34 px): "Meziverse" + the version, the mode switch, chat file name, settings + exit. Chat header (48 px): the scene cluster (date, time, place, weather chip) + log button; the cast strip rides just below it, flush on the reading pane.
- **Reading pane** shows the newest message as prose; a drag handle resizes it (persisted in settings). The **log** is a floating, stretchable window listing earlier turns, with per-turn actions and its own remembered size.
- **Message actions** replicate ST's message-header menu as flat icon buttons — no dropdowns — on ALL turns: copy, branch, hide-from-prompt (eye), edit, swipe, download-earlier. Edit opens ST's own `.mes_edit` editor (the pane mirrors `#curEditTextarea` one-way) with an edit bar ✓ / 🗑 / ✕; a 400 ms watch owns edit-state exit, and Esc defers to ST while its editor is open.

## Scene info (the first feature family)

The model already emits the state of the story as in-band tags (`scene`, `LEDGER`, the guides — see the plan doc's tag catalogue). Meziverse reads them; it never invents or writes them.

- **Parsing.** `tags.js` tokenizes a copy of `message.mes` with a tolerant grammar: tag names case-insensitive, attribute order free, single or double quotes, optional closing slash, unknown names are not tags (so card-written HTML passes through). `stripTags()` yields clean prose, and `prose.js` hands that to ST's formatter — so regex scripts, Markdown, quotes and every display extension behave exactly as in native ST. Tags are stripped in both modes; only decoration is gated.
- **The last-usable rule.** `scene.js` resolves the governing scene: the last complete `scene` with at least one of date / location / present; a turn without one inherits the latest earlier scene, walking backwards through the chat. Every complete scene still renders as an inline row at its place in the prose — rows live in the pane and the log only, never in ST's native chat (the chat file is never touched).
- **Cast.** Names come from `present`, minus the persona, deduped case-insensitively in order. Portraits are per chat — paths in `chatMetadata.meziverse.cast`, keyed by normalised name — uploaded through ST's own `/api/images/upload` as a small WebP. Nothing is auto-deleted. A loaded portrait is clean (no plate, halo or scrim — the name rides a text shadow); those appear only on an empty or broken image.
- **Chat bar and header** read the same scene: date and time (the last time-like piece splits from the date), the whole location string as written, a weather chip when present.

## Meziverse mode

One `mode` flag in `settings.js` (default on) behind a single `modeOn()` accessor — the umbrella every feature family checks (`prose.js` rows, `cast.js` strip, `overlay.js` chrome). Off means a non-Meziverse preset is in play: tags are still stripped from the prose, but no decoration is drawn, the scene cluster, rows and cast step aside, and the chat-bar is left empty — placeholders would promise scene info that can never arrive.

The switch rides in the header beside the wordmark as a small pill; flipping it redraws the turn at once and persists in extension settings. Phase 5 binds `modeOn()` to the owned preset — only what feeds the accessor changes, never a feature file.

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
- Tests: `npm test` (plain `node --test`) over `test/*.test.js`. Synthetic strings only — never a line of real story text from a live chat.
- Before shipping: `node --check` every `src/*.js` (copy to temp, rename `.mjs`), brace-balance the CSS, then push → `git pull` in the deployment clone → reload the tab and confirm the served file actually changed (a reload can silently fail in an embedded browser).
- ST formatter output to expect: `<p>` wrapper, `<br>` newlines, `<q>`, `<em>`, `<strong>`.

## The next layer (not built yet)

The **M-series** trackers — Story, Hooks, Threads, People, Shifts, Standing & Plans — arrive next as the **ledger panels**, rendered from the `LEDGER` block the model already emits (full state per reply, parsed, never accumulated). They ride the same principle: state in `chatMetadata.meziverse` (per chat, saved by ST), later injected into the prompt via `ctx().setExtensionPrompt('meziverse_state', …)` — though prompt work stays out until the preset phase. The phone is the intended UI, and its buttons are placeholders for now. See `LocalHelpFiles/Frame VN Tracker Extension (Design Spec v0.1).md` — that spec is authoritative for the M-series.
