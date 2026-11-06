# Meziverse — how it works

Technical notes for version 2.4.0. Written for whoever picks this up next — including future us.

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
  overlay.js        the fullscreen chrome: headers, settings sheet, composer, menus, toasts
  transcript.js     the reading pane + log window: rendering, edit state machine, message actions
  st.js             the ONLY file that talks to SillyTavern (see below)
  settings.js       defaults + read/write of extensionSettings.meziverse + modeOn() / entryOn()
  notify.js         notify() helper + toastr interception while the scene is open
  tags.js           tolerant tag tokenizer + stripTags (pure: no DOM, no ST)
  scene.js          scene resolution: last-usable rule, date/time split, location levels, cast names
  prose.js          message text → styled prose + inline scene rows
  ledger.js         LEDGER parsing: row normalizers, full-state resolution, deltas (pure)
  dock.js           the ledger rails: icon menus, glance columns, popups, cards, meters
  cast.js           the cast strip: posters, per-chat portraits, thought bubbles, upload
  memory.js         the flashback row splitter: sentences at their own ends (pure)
  cues.js           the inline cues: marks + popover, the mindscape, meanwhile boxes
  floats.js         one floating thing at a time: the registry behind the Esc chain
  backgrounds.js    the background store, per-response stamps, the watcher's question and answer (pure)
  bgchain.js        the background chain: targets, queue, decide, ask, draw, stamp; stage notices, triggers
  icons.js          inline SVG sprite (mz-i-* symbols)
test/
  tags.test.js      synthetic tokenizer tests
  scene.test.js     synthetic scene tests
  ledger.test.js    synthetic ledger tests
  memory.test.js    synthetic splitter tests
  backgrounds.test.js  synthetic store/watcher tests
  st.test.js        synthetic error-text tests
css/
  00-primitives.css  colours, fonts, sizes, timings, motion — raw variables
  10-semantics.css   semantic tokens; one block per theme (ink-jade / ink-amber / ink-rose)
  20-shell.css       all chrome: frame, headers, pane, log, composer, menus, toasts, settings
  30-story.css       scene features: scene rows, cast strip, portrait plates, thought bubbles
  40-dock.css        the ledger rails: menus, glance columns, popups, cards, meters
  50-cues.css        the inline cues: marks, popovers, mindscape, meanwhile boxes
style.css            @imports the six sheets (manifest points here)
```

`st.js` is the seam: every touch of ST internals is supposed to live there (`ctx()`, `whenReady()`, event wiring, and wrappers like `clickComposerControl`, `clickOptionsMenu`, `stComposer`, the edit/swipe/branch/copy/hide wrappers). When ST changes an internal, there is one place to fix.

## The scene

- **Mount once, open/close by class.** `#mz-root` is built at boot and hidden; `open()` adds `is-open` (and `body.mz-open`), `close()` removes them. Exit always returns to ST.
- **Two headers.** Meziverse header (34 px): "Meziverse" + the version, the background pill and the brush, chat file name, settings + exit. Chat header (48 px): the scene cluster (date, time, place, weather chip) + log button; the cast strip rides just below it, flush on the reading pane (Settings > Images > Avatars switches it off; the pane's height never depends on it).
- **Reading pane** shows the newest message as prose; a drag handle resizes it (persisted in settings). The **log** is a floating, stretchable window listing earlier turns, with per-turn actions and its own remembered size.
- **Message actions** replicate ST's message-header menu as flat icon buttons — no dropdowns — on ALL turns: copy, branch, hide-from-prompt (eye), edit, swipe, download-earlier. Edit opens ST's own `.mes_edit` editor (the pane mirrors `#curEditTextarea` one-way) with an edit bar ✓ / 🗑 / ✕; a 400 ms watch owns edit-state exit, and Esc defers to ST while its editor is open.

## Scene info (the first feature family)

The model already emits the state of the story as in-band tags (`scene`, `LEDGER`, the guides — see the plan doc's tag catalogue). Meziverse reads them; it never invents or writes them.

- **Parsing.** `tags.js` tokenizes a copy of `message.mes` with a tolerant grammar: tag names case-insensitive, attribute order free, single or double quotes, optional closing slash, unknown names are not tags (so card-written HTML passes through). `stripTags()` yields clean prose, and `prose.js` hands that to ST's formatter — so regex scripts, Markdown, quotes and every display extension behave exactly as in native ST. Tags are stripped in both modes; only decoration is gated.
- **The last-usable rule.** `scene.js` resolves the governing scene: the last complete `scene` with at least one of date / location / present; a turn without one inherits the latest earlier scene, walking backwards through the chat. Every complete scene still renders as an inline row at its place in the prose — rows live in the pane and the log only, never in ST's native chat (the chat file is never touched).
- **Cast.** Names come from `present`, minus the persona, deduped case-insensitively in order. Portraits are per chat — paths in `chatMetadata.meziverse.cast`, keyed by normalised name — uploaded through ST's own `/api/images/upload` as a small WebP. Nothing is auto-deleted. A loaded portrait is clean (no plate, halo or scrim — the name rides a text shadow); those appear only on an empty or broken image.
- **Chat bar and header** read the same scene: date and time (the last time-like piece splits from the date), the whole location string as written, a weather chip when present.

## Meziverse mode

One `mode` flag in `settings.js` (default on) behind a single `modeOn()` accessor — but it is an umbrella for the **extras only**: the ledger rails, the inline cue marks and boxes, the mindscape, the thought bubbles. The base extension never consults it. Off means a non-Meziverse preset is in play: tags are still stripped from the prose and the scene keeps working — cluster, rows, cast and the whole image chain are driven by the `scene` tag contract alone — while the Meziverse.json extras step aside.

The switch is the Settings > Meziverse mode tab's header row, well away from the main UI - it is not meant to be flipped mid-chat; flipping it redraws the turn at once and persists in extension settings. Settings → Meziverse mode carries the **Tracker entries** menu — standing, profiles, shifts, threads, plans, hooks, lore, story so far — each flipping `settings().entries` live (`entryOn(key)`), so mode-on with individual entries off is a first-class state. Phase 5 binds `modeOn()` to the owned preset — only what feeds the accessor changes, never a feature file.

A release build turns the extras off from the source: `DEV_EXTRAS` in `settings.js` is the release switch. True keeps the mode tab and the extras in play; false hides the tab whole (the switch, Tracker entries and Cues) and makes `modeOn()` answer false whatever the stored setting says - the base extension alone ships.

## The ledger rails (the second feature family)

Each reply may close with a `LEDGER` block — the model's full story state as row tags (`recap`, `lore`, `hook`, `thread`, `goals`, `profile`, `shift`, `standing`, `plan`; see the plan doc's tag catalogue). Meziverse only reads it; the model writes it.

- **Parsing is pure and full-state.** `ledger.js` resolves the governing ledger per turn: the last complete `LEDGER` block of the shown message; a turn without one inherits the latest earlier block, labelled "from turn N". A block still streaming is not a block — it falls back rather than showing half its rows. Rows are normalized per catalogue, trimmed and never rewritten, in the tag's own order, and **no row limits are enforced** (display caps are slicing only). `goals` rows are collected and never rendered.
- **Deltas are derived, not remembered.** Standing levels compare against the previous ledger block (`withStandingDeltas`), so each block's signed chips are correct when scrolling back through the chat and nothing accumulates. Shift deltas are different: the tag writes this turn's movement itself (`delta` / `ddelta`), so they are read as written. The shift meters are uncapped (no ceiling, no floor), and each bar's scale is the pair's own recent widest — the total and the one before it — rounded up to the next hundred (`meterMax`), so 101 reads as 101 / 200.
- **The rails** (`dock.js`) are one icon menu per side plus glance columns down the frame: right = threads and a single bordered PLANS card (hooks, lore and story so far are popup-only), left = the chat log first (chrome), then standing, profiles and shifts. An `ENTRIES` registry carries each entry's title, side, box cap and renderers. Nothing draws unless `modeOn() && entryOn(key)` and the entry has rows — no rows, no cards, no placeholder promises. But the **space is always reserved**: at desktop widths the narration pane keeps its width and the columns' icon menus stay on stage whatever the content — only the glance cards are content-driven, so toggling entries or switching chats never shifts the layout. The Tracker entries menu (Settings → Meziverse mode) flips the switches in `settings().entries` live.
- **Popups ride over the narration pane** and open beside their own rail — people left, story right. The fly holds every record of one entry; a profile opens as a full card (the avatar image as head backdrop, every field, the private thought; a reserved foot for relevant shifts later). Esc closes card → popup → log → settings.
- **Text is display text**: `{{user}}` renders as the persona's name; every other value shows exactly as written, with no normalizers on free-text fields. Numbers wear signed tabular numerals; every tone comes from theme tokens.
- **Mobile** (< 760 px): glance columns hide, every glyph rides a slim second chat-bar line under location/date, and popups open as bottom sheets.

Prompt work — pushing this state back at the model — stays out until the preset phase.

## The inline cues (the third feature family)

Four in-band tags decorate the prose itself: `lie`, `filter`, `flashback`, `meanwhile` (`speech` keeps its words in the prose, untouched). Everything else about tags is unchanged — stripped in every mode, decoration gated on `modeOn()`.

- **Parsing is one scanner** (`tags.js`): `parseTags` finds catalogue tags only (card-written HTML passes through; fenced and inline code is never parsed), `stripTags` gives the plain text, and `splitCues` splits a message into prose runs, scene rows, meanwhile boxes and inline marks — so a swipe, edit or stream frame is correct the moment the text changes.
- **Marks travel as slots.** A mark's private-use placeholder rides through SillyTavern's formatter inside its prose run and is swapped for the markup afterwards, so paragraphs and quotes never break. Placement: the mark sits at the end of the text before its tag; a tag on a line of its own joins the previous paragraph's end; marks stack in reading order. A tag not yet closed draws nothing and hides its tail.
- **One shared popover** (a frame child, fixed-positioned and clamped) serves the lie and blind-spot marks: hover opens on pointer devices after 90 ms, a tap or click pins, focus-visible opens, one at a time. The liar's portrait additionally wears a hairline crack (`renderTells`) that flickers while its popover is open — a bonus echo, never the only carrier.
- **The flashback** leaves a dream pill carrying the body out of the prose and the log; a click opens the mindscape (`cues.js`) — paced fragments on a warmed, blurred stage. The rows come from the mechanical splitter in `memory.js`: sentences split at their own ends, never inside quotation marks, and a sentence that speaks in quotes takes the single one after it. No word lists. Closing the memory fires its cascade on the character's thought overlay until the next turn.
- **The meanwhile box** renders closed and grows in place (`grid-template-rows`), numbered "n / N" when several stack in one reply. Boxes toggle independently and reset closed on every re-render.
- **Floats** (`floats.js`): one `placeFloat` / `closeFloats` registry keeps the popover and the thought overlays to one floating thing at a time. Esc chain: floats → memory → card → dock → log → settings.
- **Settings** (Cues group): Popovers (hover and tap / tap only), Memories (pill / open on arrival), Meanwhile (closed / latest one open). The last two fire once per arrival, on the latest turn, after generation settles.
- **Mobile** (< 760 px): the cue popover stays anchored to its mark — a deliberate deviation from the bottom-sheet rule; the meanwhile box drops its inner indent; the mindscape clamps to the frame.

## The story backgrounds (the fourth feature family)

The chat's background follows the story's place. The decision layer is pure (`backgrounds.js`), the choreography is `bgchain.js`, and every call into SillyTavern stays at the seam (`st.js`).

- **The store** lives in `chatMetadata.meziverse.bg` beside the cast portraits, saved through ST's own `saveChatMetadata()`: one record per drawn place (id, place name, prompt, image path), `currentKey` for the image on screen, ids never recycled. `locationKey` folds case, whitespace and location levels so a place keeps one record whatever the spelling, and a place the watcher calls "same" has its new spelling aliased onto the image already up — the cache grows by meaning, not by string.
- **Every reply remembers its own picture.** The record in effect for a reply is stamped on it — `extra.meziverse.bg`, mirrored into that swipe variant's own `swipe_info[i].extra` slot (ST's per-swipe home) — so it rides the message through swipes, deletions and branches untouched. Resolution at any point in the chat walks: the variant's own stamp, then the nearest stamped variant of the same message (a fresh swipe taken from another variant keeps that variant's picture), then back over earlier messages. User turns are never stamped — a user turn, or a reply that drew nothing, inherits the previous reply's picture exactly that way. Stamps point at records, never image paths: one canonical image per place, and the brush replaces the record **in place** (`storeRecord(overwrite)`), so each manual retry wins over the last everywhere that place appears.
- **The skip-gate is a string compare, never the change-detector.** `decide()` answers three ways about one reply: it already carries this picture → nothing; the place is known → swap in the cached image; anything else → ask the watcher. The baseline is the picture **the reply carried in** — its own stamp when re-resolving, the story's carried picture otherwise — so a run landing late reasons about its own turn, never the chat's end. Spelling drift ("Pier 9" vs "Pier No9") deliberately falls through, and the watcher verifies sameness **by meaning**.
- **The watcher** is the chat LLM through `ctx.generateRaw` — only what we pass, nothing of ST's prompt plumbing. `buildWatcherRequest` assembles the question: CURRENT BACKGROUND (the place and image description **the reply carried in**), KNOWN BACKGROUNDS (the newest twelve, each description whole - nothing is ever cut), RECENT PLACES, and the LATEST STORY — grouped by scene blocks when the reply carries scene tags (the last block is where the story is), plain prose when it doesn't: `tagged` picks both the prompt core and the story formatting from **tag presence**, never from the mode switch. Every place is labeled `short name [Full/world/map location: ...]` - the short name (the chain's last segment, "Unit 4B - Bedroom") names the picture and the chain is context - so the watcher answers with a visual description, never a location string; the style suffix is appended once, never stacked on its own echo. The question is scoped to the reply being resolved (`at`): its story is the story **up to that reply**, never the chat's end, and only the reply's final location counts — mid-reply hops are ignored. Answers parse as one JSON object (`same` / `known` + id / `new` + place + image prompt) with a plain-text fallback (`SAME`, `KNOWN <id>`, `NEW`…); the JSON format is appended to the system prompt **by code**, so user edits to the prompt cores cannot break parsing. `getLastWatcherRequest()` keeps the last question verbatim for the settings panel.
- **The prompt cores are editable** (`bgPromptOn` / `bgPromptOff`, defaults `DEFAULT_BG_PROMPT_ON/OFF`): 40–90 words of comma-separated visual phrases, the place as the subject — no characters, no names, no actions, no quality tags; lighting and sky anchored on the story's time of day and weather.
- **Drawing rides ST's Image Generation** (`sd`, declared `optional` in `manifest.json`): the `/imagine` callback invoked with `quiet:'true', gallery:'false', extend:'false'` — no chat message, no sd rewrite or review window. Quiet discards the prompt, so we keep our own record. The image comes back as a path and becomes the background by emitting `FORCE_SET_BACKGROUND {url, path}` — ST then locks, registers and persists it (Backgrounds → Chat). `imageGenerationStatus()` turns the missing/unconfigured case into words, not a stack trace.
- **The scene mirror speaks only in authored urls.** Our `FORCE_SET_BACKGROUND` listener may run before ST's own handler repaints `#bg1` (registration order), so the payload's `url()` is applied directly, with one deferred re-read as insurance. Every probe reads the INLINE value only: `getComputedStyle` reports a running `background-image` transition as `cross-fade(...)` machine syntax (Chrome interpolates that transition, Firefox flips it discretely - which is why the same code behaved so differently across browsers), and that syntax is poison in a custom property: one substitution kills the declaration and blanks the scene. `sceneUrl()` vets every candidate; an unusable stranger is dropped and the last good picture stays.
- **Weather lives on the background stage.** One `.mz-weather` layer at the tint's old slot: over the background and its soft twin, behind the cast, rails and narration pane. The scene tag's `weatherTag` names the state (aliases fold, unknown shows nothing) and `locationTag` gates it strictly to outdoor; the free-text weather's tone words tune its strength in three tiers. Particles are spawned once with desynced clocks and only cross-fade between states (`data-mz-wx` / `data-mz-wx-int` on the frame) - no DOM churn, no per-frame JS, transform and opacity only. The sun's place comes from `scene.time`'s hour on a 6h-20h arc - the same clock that lit the painted backdrop - and night hours dim the set to a cool whisper. Reduced motion freezes every particle mid-fall (a still photograph) and lightning never fires. The dark wash over images is commented out in `20-shell.css` - it may return as the daycycle (day/night) layer. Indoors the layer plays the quiet twin: effects seeded per place (candlelight, hearth, window light, dust, lamp), the window's light colored by the clock.
- **The glass reads our own scene, never the page behind.** One scene in two layers: the base reads sharp across the frame, and the soft twin (the pane blur slider's var, `saturate(140%) blur(...)`) lives in the narration pane's box alone - clipped to the pane's own geometry (`clip-path: inset(... )` built from the pane's height, gutters and radius), so the blur edge IS the pane's border line, corners included, and nothing bleeds beside it. The blur is the pane's read and nowhere else: the chrome, the rails and the stage read sharp through their tints. No `backdrop-filter` anywhere in the extension: Firefox's compositor samples those wrong when filtered pages sit behind the glass, washing the grey of ST's theme over the whole UI on screen while screenshots stay correct (ST's own `no-blur` toggle, which kills every backdrop filter, confirms the cause). The mirror feeds both layers through `--mz-st-bg`.
- **One job per reply, one at a time.** Work is target-scoped — one reply, one swipe variant — and queued: an image in flight is never doubled, a newer job for the same reply replaces the older (force beats re-resolving beats arriving), and a chat change cancels everything. Every run reports a status: `off | unchanged | cached | generated | superseded | cancelled | unavailable | error`. Every landing stamps the reply, saves the chat, and re-asserts the **shown turn** — so a result landing late updates its own reply's history and never yanks the picture out from under whatever turn is being read. Triggers: `GENERATION_ENDED/STOPPED`, `GROUP_WRAPPER_FINISHED` re-resolve the chat's end; `MESSAGE_EDITED` re-resolves the edited reply; `MESSAGE_SWIPED` draws nothing - a stamped variant's picture comes back by swap, an unseen one keeps the picture it swiped from, and a genuinely new place wants the brush; `CHAT_CHANGED` cancels, resets the generation pace, and re-derives the current key from the background ST itself restored. The watcher is for new turns only. One plan table (`planResolution`, pure and tested) branches every run on tag presence: `scene` present runs the decide chain (free outcomes — a skip's "none", a cached swap — always run at any pace, so stamps stay truthful); no tag falls to the plain-prose watcher at pace, keeping the last picture between fires and flagging the miss with one notice per chat. **The chain follows the chat only while the scene is open — the master switch.** Closed or never opened, every handler above and `requestBackground` itself return without a call, a write or a fetch (the injection to come rides the same gate). Opening catches the chat up - metadata re-derived, the shown turn's recorded picture re-asserted (swap-only) - and draws nothing: the watcher is for new turns, and a chat whose opening wants a picture presses the brush. Closing kills work in flight, resets the pace, and hands the chat's background back to what the chain found before it took over — the **takeover baseline** recorded once per chat (`store.baseline`: the lock and the shown image at the chain's first write), or SillyTavern's own `/unlockbg` for a chat drawn before the baseline existed - a baseline of nothing to hand back takes the unlock too, so the screen gets a picture back, never a hole. A background the user took back while we ran (unlocked, or locked their own) is theirs: exiting stands down. A chat change while the scene is closed hands that chat back the same way, so no chat ever shows a Meziverse picture with the extension off.
- **The shown turn owns the screen.** Scrolling the transcript hands the chain the shown turn (`setShownTurn`), and the swap (`syncShownBackground`) is read-only: the stamped picture comes back — shuffle back through the turns and the pictures shuffle with them — never asking, never drawing. Chats without history fall back to the cached picture of the shown place; a user turn inherits the nearest reply's picture before it. Closing the scene hands the chain the chat's end again.
- **Stage notices** ride the toastr interception as sticky notices (`timeOut: 0`): "Envisioning the location…" while the watcher answers, "Painting {place}…" while the image draws — dropped when their stage ends — then a brief "Background set: {place}". Every error seam goes through `errorText()` (`st.js`), which unwraps throwables: never "[object Object]".
- **Settings** (Images tab, Backgrounds section): auto follow, the **Background generation pace** (shared by both modes, default 1 = every AI response; only AI turns count — user turns never — and swipes and edits do; the brush never waits or counts), size (landscape / square), style, negative, the two prompts — "Watcher prompt · Scene tags" and "· Plain prose", each picked by the reply's tag presence — with "Restore default" and "Show last request", and "Draw one now" — the brush, which runs the chain with `force` on the place the **shown turn** carries (the nearest reply at or before it that owns a picture; user turns own none): a fresh image whatever the watcher answers, the place's record replaced in place — each retry wins — no review window.

Known limits, by design for now: the tagged skip-gate never consults the watcher when the location string is unchanged (a radically reimagined same-name place needs the brush); the no-tag path is deliberately basic — a fixed pace, keeping the last picture between fires.

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

The settings sheet is three tabs: **General** — theme, background (none = navy-teal gradient, or ST's current), interface scale, pane transparency and blur, narration size, narration font, reduced motion, prose colour mode (theme / ST / custom with four colour pickers); **Images** — the Avatars and Backgrounds sections; **Meziverse mode** — Tracker entries and Cues. The open tab sticks for the session, and so do the Images tab's section folds (both closed by default).

## Notices

While the scene is open, ST's `toastr` is intercepted — but its contract survives. The wrapper calls the **real** toastr and returns its real toast element (ST's own consumers keep that element and hand it back to `toastr.clear`, so it must stay intact), while each toast is mirrored as a Meziverse notice dropping from under the header, tinted by kind (success = accent, info = neutral, warning/error = warn/bad tokens). `clear` / `clearAll` dismiss the mirrors too, and `timeOut: 0` means sticky — the background chain's stage notices ride that convention. Message text follows one rule at every seam: never "[object Object]". On close, ST's toastr is restored untouched.

## Events we listen to

`CHAT_CHANGED/LOADED/CREATED/DELETED/RENAMED`, `MESSAGE_SENT/RECEIVED/SWIPED/SWIPE_DELETED/EDITED/DELETED/UPDATED`, `MORE_MESSAGES_LOADED`, `GENERATION_ENDED/STOPPED` → full refresh; `STREAM_TOKEN_RECEIVED` → queued refresh. `GENERATION_STARTED/ENDED/STOPPED` and `GROUP_WRAPPER_FINISHED` → `is-generating` on the frame (send → stop, inputs readonly). `FORCE_SET_BACKGROUND` → the scene's background mirror. The background chain listens to `CHAT_CHANGED` (cancel + re-derive) and `GENERATION_ENDED/STOPPED`, `GROUP_WRAPPER_FINISHED`, `MESSAGE_EDITED` (run once); `MESSAGE_SWIPED` only re-asserts the shown picture. Every listener is master-switch gated: with the scene closed, the extension sits idle — nothing runs, nothing is fetched, nothing is written.

## Conventions worth keeping

- No bundler; plain ES modules at repo root. `manifest.json`: `js: index.js`, `css: style.css`.
- All selectors/ids/classes prefixed `mz-` / `--mz-*` / `#mz-root`.
- Tests: `npm test` (plain `node --test`) over `test/*.test.js`. Synthetic strings only — never a line of real story text from a live chat.
- Before shipping: `node --check` every `src/*.js` (copy to temp, rename `.mjs`), brace-balance the CSS, then push → `git pull` in the deployment clone → reload the tab and confirm the served file actually changed (a reload can silently fail in an embedded browser).
- ST formatter output to expect: `<p>` wrapper, `<br>` newlines, `<q>`, `<em>`, `<strong>`.

## What comes next (not built yet)

The **speech bubbles** — the one inline piece left, with `speech` still reading as plain prose — then the preset phase: mode ownership, trim, Features/Style, and the prompt work (`ctx().setExtensionPrompt('meziverse_state', …)`) where the state Meziverse already parses gets pushed back at the model — with the automatic prompt injection riding the same gate as everything else (the scene open, or nothing). The v2.6.1 batch landed the fixes and the room - the never-black fall-through to SillyTavern's own background (a relative url in the mirror resolved against the extension's folder and 404'd; the mirror now speaks absolute urls), the background master switch, the storm's downpour, the sun's sweep, overcast as shadows, the watcher prompts' eye for world and setting, and the indoor effects seeded per place - and waits on the user's Chrome and Firefox review before merging as `v2.6.1`. Richer no-tag detection and general polish/bugs follow (the kept background candidates — the prompt-review popup on the brush among them; the same-name deep check and the per-place regenerate UI were dropped deliberately, the per-response stamps covering regenerate at the data level — the plan doc remembers them). Milestone firing (`shift` totals crossing ±100) is deliberately unimplemented: the idea is to detect the crossing in the extension and fire it from there rather than trust prompt memory. The phone is the intended UI, and its buttons are placeholders for now. See `LocalHelpFiles/Frame VN Tracker Extension (Design Spec v0.1).md` — that spec is authoritative for the M-series.
