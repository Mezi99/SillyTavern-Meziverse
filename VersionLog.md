# Meziverse — version log

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
