# Meziverse — version log

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
