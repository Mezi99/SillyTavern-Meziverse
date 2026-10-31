# Meziverse

A fullscreen visual-novel scene for SillyTavern — built for one character card at a time.

Meziverse is an extension, not a fork. SillyTavern stays the engine and the storage: the same chat, the same character, the same generation. Open the scene from the wand menu or the Extensions panel, step back out whenever you like.

## What it does

- **The scene** — a fullscreen frame with a reading pane showing the newest message as plain prose, and a stretchable log window for everything earlier.
- **Every message action rides SillyTavern's own handlers** — copy, branch from any turn, hide from prompt, edit (with ✓ / 🗑 / ✕), swipe, regenerate, stop.
- **A composer that is SillyTavern's composer** — a growing textarea mirrored with ST's own input box, plus a ☰ menu (start new chat, back to parent chat) and impersonate / continue / send buttons that click ST's own controls. Empty sends, busy gates and drafts behave exactly as in native ST.
- **Theming** — ink + one metal (jade, amber or rose), Newsreader prose / Inter interface, adjustable narration size, interface scale, reduced motion, custom prose colours, optional ST background.
- **Notices** — ST's toastr toasts re-render as Meziverse toasts while the scene is open.

The phone and the story trackers (Scene, Profiles, Shifts, Threads, Plans) are planned; the buttons are placeholders for now.

## Install

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/Mezi99/SillyTavern-Meziverse
```

Then reload SillyTavern. Meziverse appears in the wand menu (the magic-wand icon next to the message box) and in **Extensions**.

## Docs

- [Technical.md](Technical.md) — how it works, for future maintainers.
- [VersionLog.md](VersionLog.md) — release history.

## Design

Meziverse has a visual language of its own: ink and one metal, Newsreader for prose and Inter for the interface. Themes, sizes and timings are variables — primitives, then semantic tokens, then one block per theme — so a component never names a colour directly.

Nothing in `css/` or `src/` is shared with other extensions, and SillyTavern's own styles are left untouched outside `#mz-root`.

## Licence

AGPL-3.0. See [LICENSE](LICENSE).
