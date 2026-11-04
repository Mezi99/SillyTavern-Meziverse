# Meziverse — version log

## 2.5.0 — 2026-11-04

One scene-tag contract. The base extension — backgrounds, avatars, the scene cluster and rows, the rails frame — now works with any preset in both modes; the mode toggle gates only the Meziverse.json extras (ledger, cues, mindscape, meanwhile, thought bubbles).

### One pipeline for both modes
- A `<scene>` tag in the narration governs — date, weather, location, who is present — and one plan table branches the run on **tag presence**, never on the mode switch. Tag present → the scene's chain (skip → cached swap → watcher). No tag → the plain-prose watcher at the pace, keeping the last picture between fires.
- Free outcomes always run at any pace — a skip stamps its "none", a known place swaps from cache — so per-response stamps stay truthful; only the costly work (the watcher call, the drawing) waits its turn. A genuinely new place between fires keeps the last picture (accepted cost).
- Avatars follow the tag's `present` in both modes; the scene cluster, the inline scene rows and the whole image chain are mode-free. Only the extras read the mode toggle.
- "Context replies" is gone: the watcher always gets the story context it needs — robustness is ours to guarantee, not a knob. The two prompt rows are now "Watcher prompt · Scene tags" and "· Plain prose", each picked by the tag presence of the reply being resolved.
- The pace row reads **Background generation pace**, shared by both modes, default 1 (every AI response). Only AI turns count — user turns never; swipes and edits count; the brush never waits or counts.

### Settings, three tabs
- **General** (Appearance, Type, Motion) · **Image generation** (the whole Backgrounds group) · **Meziverse mode** (Tracker entries + Cues). The open tab sticks for the session.
- The mode-features menu finally exists: Tracker entries carries all eight switches — standing, profiles, shifts, threads, plans, hooks, lore, story so far — each flipping its entry live, so mode-on with individual entries off is a first-class state.

### Rails keep their space
- The narration pane never changes width: at desktop widths the rails' columns are reserved whether or not they carry content, icon menus always on stage — only the glance cards are content-driven. Toggling entries or switching chats no longer shifts the layout.

### Notes
- The version rides beside the wordmark ("Meziverse v2.5.0"); `manifest.json` matches.
- The synthetic suite stands at 140 tests.

## 2.4.1 — 2026-11-03

Every reply remembers its own background. Shuffling back through the messages shuffles the pictures back with the turns — the history level, which also ties each response to its image as data, for the maps and book features to come.

### The stamps
- Each reply — each swipe variant — carries the background record in effect for it: `extra.meziverse.bg`, mirrored into the variant's own `swipe_info` slot (ST's per-swipe home), so stamps ride swipes, deletions and branches untouched. User turns get nothing and inherit the previous reply's image — scrolling onto a user turn shows the reply before it.
- Resolution at any point in the chat: the variant's own stamp, then the nearest stamped variant of the same message (a fresh swipe taken from another variant keeps that variant's picture), then back over earlier messages.
- Stamps point at **records**, never image paths: one canonical image per place. The brush redraws the shown turn's place and replaces the record **in place** — each manual retry wins over the last (`bg_18`, then `bg_19`…) — and every reply at that place shows the newest, everywhere.

### The chain, target-scoped
- Every run resolves ONE reply (a message and a swipe variant of it) and carries its target through: the watcher reads the story **up to that reply** and takes the picture *that reply* carried in as the baseline — so a run landing late writes the prompt that belongs to its own turn, never the chat's end.
- Jobs run one at a time in order (an image in flight is never doubled), a newer job for the same reply replaces the older (force beats re-resolving beats arriving), and a chat change cancels everything. Every landing stamps the reply, saves the chat, and re-asserts the shown turn — a late result never yanks the picture out from under what is being read.
- Swiping resolves only variants this chat has not seen: a variant already stamped brings its own picture back by swap, instantly, with no watcher call.

### Both modes
- The whole image feature set runs in Meziverse mode ON and OFF alike. Mode ON decides by the scene tags; mode OFF resolves at the every-N-replies pace and keeps the last picture between.

### Notes
- Scroll-back is swap-only — never asks, never draws — with a cached-place fallback for chats without history. (The old scroll-back swap resolved the chat's end whatever turn was shown, so this history behaviour is genuinely new.)
- The version rides beside the wordmark ("Meziverse v2.4.1"); `manifest.json` matches.
- The synthetic suite stands at 138 tests.

## 2.4.0 — 2026-11-03

The fourth feature family — the story backgrounds. The chat's backdrop now comes from where the story is: the chat's own LLM reads the reply, decides what place it ends in, and SillyTavern's Image Generation paints it.

### The chain
- Every finished reply, swipe or edit runs one question: **does the image on screen still fit where the story is now?** Only the reply's final location counts — mid-reply hops are ignored — and the baseline is the background currently on screen, not the previous reply.
- Sameness is judged **by meaning, not spelling**: "Pier No9", "Pier 9" and "the ninth pier" are one place. The string compare is only a skip-gate; any drift falls through to the watcher (the chat LLM), whose verdict folds the new spelling onto the image already up.
- A place seen before returns instantly from **this chat's cache** — every drawn place keeps its image, its name and its prompt per chat. A genuinely new place is drawn fresh: the watcher writes the image prompt (the location only — no characters, no names, no actions; lighting anchored on the story's time of day and weather), the image is made by ST's own Image Generation, and it is set as the chat background the ST way. It lands in **Backgrounds → Chat** like a background you'd set by hand. No chat message is ever posted.

### The bar
- `bg · auto` rides beside `mode · on`. On: a new background when the place changes. Off: the chain holds — the brush draws on demand, or your pace does, a fresh background every N replies.
- The brush paints where the story is now, straight through — no prompt-review window.

### Stage notices
- The chain speaks while it works and falls silent when it doesn't: sticky "Envisioning the location…" and "Painting {place}…" notices drop at each stage and go when the stage ends, then a brief "Background set: {place}". Errors read as sentences — never "[object Object]".

### The Backgrounds settings group
- Auto follow, every-N-replies pace, context replies (how much of the story the watcher reads), size (landscape / square), style, negative prompt, and **Draw one now**.
- **Two editable watcher prompts** — the scene-tagged hand (mode ON) and the plain-prose hand (mode OFF) — each with Restore default, and **Show last request** for exactly what was sent to the LLM, footers included. The JSON answer format is appended by code, so no edit can break the answer parsing.

### Notes
- Needs ST's Image Generation (the `sd` extension, declared `optional` in `manifest.json`) enabled and configured; without it the chain explains itself in words instead of failing. Backgrounds follow the chat whether the scene is open or not — the backdrop belongs to the chat, not to the window.
- Known limits, by design for now: the mode-ON skip-gate never consults the watcher when the location string is unchanged (a radically reimagined same-name place needs the brush); mode-OFF detection is deliberately basic — a fixed every-N pace.
- Fixes along the way: the scene mirror now takes the background URL from the `FORCE_SET_BACKGROUND` payload (reading the DOM raced ST's own repaint and copied the previous image), and the toastr interception keeps toastr's full contract — the real element back in hand, clears mirrored — so ST's own consumers keep working behind the scene.
- The version rides beside the wordmark ("Meziverse v2.4.0"); `manifest.json` matches.
- The synthetic suite stands at 132 tests.

## 2.3.0 — 2026-11-02

The third feature family — the inline narration cues. Four tags now leave their mark in the prose itself: a lie, a blind spot, a memory, and the world elsewhere.

### The marks
- `lie` and `filter` leave a small round glyph exactly where the tag stood — at the end of the text before it (a tag on a line of its own joins the previous paragraph's end; marks stack in reading order). The glyph tells the kind apart: crack / mask / gap for lying / deceiving / omitting, a closed eye for the blind spot.
- **One shared popover** serves both marks. Hover opens it on a pointer after 90 ms, a tap or click pins it, focus-visible opens it; Esc, scroll or an outside press puts it away — one at a time. The lie's popover names the kind, the liar ("Who"), the truth and why; the blind spot's is shaped the same way — "Missed" in its own violet ink, then what happened and why.
- The liar's portrait wears a hairline crack — a bonus echo, never the only carrier — that flickers once while the lie's popover is open.

### The memory
- `flashback` leaves a small dream pill (glyph + name) in the prose and carries the body out of both the prose and the log. A click opens the **mindscape**: the stage warms and blurs away, the memory surfaces fragment by fragment ("{character} remembers", when, and the trigger up top; the "And now" cascade at the foot), and click anywhere — except a click that just selected a passage — Return, or Esc brings you back.
- Closing the memory lets its cascade linger on the character's thought bubble until the next turn. The thought bubbles themselves became floating overlays with a three-circle trail, one at a time, closed by default.
- The fragments come from a **mechanical sentence splitter** (`memory.js`), no word lists: sentences split at their own ends, never inside quotation marks, and a sentence that speaks in quotes takes the single one after it into its row. Pinned by synthetic tests.

### The meanwhile box
- `meanwhile` stands as its own quiet box at the point it appeared: closed by default, showing only the cut glyph and the label, and growing in place on click to the event and a hairline "Why it matters". Several in a row stack as one unit, and each head numbers itself ("2 / 3") when a reply holds more than one. It renders in the pane and the log alike.

### The Cues settings group
- **Popovers** (hover and tap / tap only), **Memories** (pill / open on arrival), **Meanwhile** (closed / latest one open). The last two arrive once per turn, after generation settles.

### Notes
- With Meziverse mode off every cue tag vanishes from the prose entirely. A tag still streaming draws nothing and hides its tail.
- The version rides beside the wordmark ("Meziverse v2.3.0"); `manifest.json` matches.
- The synthetic suite stands at 110 tests.

## 2.2.0 — 2026-11-01

The second feature family — the ledger rails. The story trackers the model already writes into each reply now live on two icon menus beside the narration: story on the right, people on the left.

### Ledger state
- A tolerant read of the `LEDGER` block: recap, lore, hooks, threads, profiles, shifts, standing and plans rows, in the tag's own order (`goals` rows are collected and never rendered). The ledger is **full state per reply** — parsed, never accumulated. The last complete block of the shown message governs; a turn without one inherits the latest earlier block, labelled "from turn N". A block still streaming is not a block.
- No row limits are enforced anywhere; display caps are slicing only. Free text is trimmed and never rewritten. `{{user}}` renders as the persona's name.

### The right rail
- **Threads** — glance boxes with the state riding the sub-line; a click opens the fly with every thread's plot, clock and outcome.
- **Plans** — one bordered card, due over name at the name's size in the theme accent; tag order is the board, no date sorting (`due` is free text).
- **Hooks, Lore, Story So Far** — popup-only entries from their glyphs.

### The left rail
- **The chat log** leads the menu as chrome — its glyph is always visible; the log window itself is the base reader's.
- **Standing** — how the world sees you on 0–10 tracks: glance cards (name, `N / 10`, change chip, two-tone level bar) above the profiles, and a fly with both ends of the stakes and what moved each track. Change chips are **derived, not remembered**: each block's levels compare against the previous block, so `+1` / `−1` is exactly the movement since the ledger last spoke — correct when scrolling back, and nothing accumulates. A track new to the board wears a small `new`; an unchanged level wears nothing.
- **Profiles** — mini cards (avatar, name, status) under six; a click opens the full-profile card with the avatar image as head backdrop, every field, and the private thought. Thought bubbles ride one per avatar by name, clamped and click-to-expand, with a per-avatar glyph toggle; a thought with no matching avatar stays unspoken.
- **Shifts** — one line per pair that moved this turn, bond and desire on two meters. The meters are uncapped (no ceiling, no floor) and each bar's scale is the pair's own recent widest rounded up to the next hundred: 96 grows to 101 / 200, and a pair drifting back keeps the wider scale. Tones flip with the sign — bond goes wary yellow below zero, desire goes its own purple. Deltas come from the tag itself.

### Cards, popups, small screens
- Every entry pops up beside its own rail — people left, story right — riding over the narration pane. Esc closes card → popup → log → settings.
- Below 760 px the glance columns hide, every glyph rides a slim second chat-bar line under location/date, and popups open as bottom sheets.

### Notes
- The version rides beside the wordmark ("Meziverse v2.2.0"); `manifest.json` matches.
- Fixes along the way: entry popups open beside their own rail (the fly's side was hard-coded right), and synthetic clicks — SillyTavern fires them on the composer while the pane settles — no longer close an open popup.
- `milestone` rows are ignored for now; the plan doc remembers the idea of firing them from the extension when a meter crosses ±100.
- The synthetic suite stands at 87 tests.

## 2.1 — 2026-10-31

The first Meziverse feature family — scene info — and the umbrella every feature now sits under: Meziverse mode.

### Scene info
- A tolerant parser reads the model's in-band tags (`scene`, `LEDGER`, the guides). Tags are stripped from the prose in every mode; only the decoration is gated.
- Inline scene rows: every complete `<scene>` renders as a quiet band where it appeared — date and time, the location exactly as written, the present cast. Nothing is collapsed or duplicated.
- The chat bar comes alive: date, time, the whole location path (wrapping on narrow screens), a weather chip, and a cast strip of 3:5 posters that shrink with the reading pane. Portraits are attached per chat and kept in `chatMetadata.meziverse.cast`; empty posters show a subtle attach affordance.
- The last usable scene governs the chrome; a turn without one inherits the latest earlier scene.
- A loaded portrait is clean — no plate, halo or scrim behind it; its name rides a text shadow. Those only appear on an empty or broken image. The scene band is tinted from the theme and posters seat flush to the pane.
- A pane transparency slider (20–100 %, default 90) tints the main background only, never the scene band.

### Meziverse mode
- The umbrella: one switch (default on), riding in the header beside the wordmark. Every feature family checks it before it draws. A later version binds it to the owned preset; for now it is flipped by hand and persists.
- With mode off the scene cluster, the scene rows and the cast strip step aside and the chat-bar is left empty — no placeholder promises. Tagged history renders as clean prose.

### Notes
- The version string moved out of the settings sheet and rides beside the wordmark ("Meziverse v2.1").
- `manifest.json` now carries the same version as this log; it had lagged at 0.7.0 through the 1.0 line.

## 1.0 — 2026-10-31

The base extension: a fullscreen VN scene over SillyTavern, feature-complete as a reader and composer. Everything rides ST's own handlers.

### The scene
- Fullscreen frame, opened from the wand menu or the Extensions panel; exit returns to ST.
- Two headers: "Meziverse" + chat file name + settings/exit (34 px); clock/date/place/weather placeholders + log button (48 px).
- Reading pane with the newest message as prose; drag handle resizes it, remembered across chats.
- Floating, stretchable log window for earlier turns, with remembered size.
- Background: "None" (navy-teal gradient) or SillyTavern's current background.
- Settings: theme, background, interface scale, narration size, narration font, reduced motion, prose colours (theme / ST / custom).
- SillyTavern's toastr notices re-render as Meziverse toasts while the scene is open; restored on close.

### Reading and acting on messages
- Message actions on ALL turns, past and user turns included, as flat icon buttons: copy, branch, hide-from-prompt, edit, swipe, download-earlier — all firing SillyTavern's own handlers.
- Branching: any turn, past ones included, via ST's own bookmark flow (the resulting chat switch is followed live).
- Editing opens ST's own editor on any turn; the pane mirrors it with an edit bar (✓ save / 🗑 delete / ✕ discard).
- Swipe footer on the latest reply; dimmed hidden turns stay in place.

### The composer
- A growing textarea (field-sizing like ST's own box) mirrored both ways with ST's `#send_textarea`; Enter sends, Shift+Enter newline; drag-resizable.
- ☰ menu: start new chat, back to parent chat (shown only when ST would show it) — both click ST's own menu options, confirm dialog included.
- Impersonate, continue, send buttons clicking ST's own controls; empty send follows ST's own semantics; send becomes stop while generating.

### Theming
- Ink + one metal: jade (default), amber, rose; Newsreader prose / Inter interface.
- Three-layer variables (primitives → semantics → themes); translucent chrome via `color-mix()` over tokens — no hardcoded rgba.
- Theme switch fades the background in 180 ms.

### Notes
- The phone is a placeholder in this version; its buttons do nothing yet.
- The M-series story trackers (Scene, Profiles, Shifts, Threads, Plans, …) are planned as a switchable mode in a later version; the design spec (kept locally) is authoritative for them.

### Earlier milestones (pre-1.0, on the old 0.x numbering)
- 0.2 — shell: frame, headers, pane, settings, launchers
- 0.3 — log window; branching from any turn
- 0.4 — swipe footer
- 0.5 — action row, dim-and-keep hidden turns, header rearrangement
- 0.6 — edit round: ST's own editor on any turn, mirrored in the pane
- 0.7 — composer round: ☰ menu, impersonate/continue/send, growing mirrored textarea
