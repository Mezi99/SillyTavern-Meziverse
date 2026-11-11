# Meziverse

A fullscreen visual-novel scene for SillyTavern — built for one character card at a time.

Meziverse is an extension, not a fork. SillyTavern stays the engine and the storage: the same chat, the same character, the same generation. Open the scene from the wand menu or the Extensions panel, step back out whenever you like.

 ## What you need
 Nothing extra, just SillyTavern! Load you  favorite preset and card, open Meziverse and play!
 
 <img width="1919" height="1079" alt="Screenshot 2026-11-11 at 10-54-44 SillyTavern" src="https://github.com/user-attachments/assets/6654ebea-9eaf-4292-8756-7651226bcd25" />

 
 ## What it does

- **The scene** — a fullscreen frame with a reading pane showing the newest message as plain prose, and a stretchable log window for everything earlier.
- **Scene info** — the model's in-band `scene` tags come alive: quiet scene rows at their place in the prose, and a chat bar with date, time, place, weather and a cast strip of posters (portraits attached per chat).
- **Backgrounds that follow the story** — the scene behind the pane changes with the story's place: each reply carries its picture (a watcher LLM call, cached per place), and scrolling back brings each turn's own scene. The brush redraws a place by hand, the pane blur slider sets how softly the scene reads through the narration pane, and the watcher comes for new turns only.
- **Weather that lives in the scene** — rain, storm, snow, fog, overcast, sun and wind play over the background when the scene tag says Outdoor: the sun sits where the story's clock says, lightning double-strikes on its own irregular beat, and a switch in Features turns it all off. Indoors, the room turns out to be alive — candlelight, a hearth, window light, dust or a lamp pool, seeded by the place — with its own switch.
- **Speech that shows** — every spoken line the model wraps in a `speech` tag wears a quiet bubble in the reading pane: the speaker's name (with their portrait when the cast holds one), the words, and the tone said in, quietly after. A switch in Features turns the bubbles off and the words fall back to plain prose.
- **Backgrounds, your call** — a master switch decides whether pictures are generated at all: off and no watcher ever runs, while the stage shows your own SillyTavern background (never black — a chat without a picture opens on it) and the weather plays on.
- **Meziverse mode** — one switch (Settings > Meziverse mode) gates every feature. Off means clean prose and an empty chat-bar, whatever preset is running; tags are stripped either way.
- **Every message action rides SillyTavern's own handlers** — copy, branch from any turn, hide from prompt, edit (with ✓ / 🗑 / ✕), swipe, regenerate, stop.
- **A composer that is SillyTavern's composer** — a growing textarea mirrored with ST's own input box, plus a ☰ menu (start new chat, back to parent chat) and impersonate / continue / send buttons that click ST's own controls. Empty sends, busy gates and drafts behave exactly as in native ST.
- **Theming** — ink + one metal (jade, amber or rose), Newsreader prose / Inter interface, adjustable narration size, interface scale, reduced motion, custom prose colours, optional ST background.
- **Notices** — ST's toastr toasts re-render as Meziverse toasts while the scene is open.
- **Ledger rails** — the story trackers the model writes into each reply (`LEDGER` rows, parsed and never accumulated): threads, plans, hooks, lore and story so far on the right; standing, profiles and shifts on the left. Each entry sits behind its own icon, glance cards run down the frame, and a click opens the full record beside its own rail — full-profile cards with the private thought included. On narrow screens the glyphs ride a slim second chat-bar line and popups open as bottom sheets.
- **Inline narration cues** — the model's `lie`, `filter`, `flashback` and `meanwhile` tags leave quiet marks in the prose: a round glyph whose popover tells the truth behind a lie or a blind spot (with a hairline crack on the liar's portrait), a dream pill that opens the memory as a drifting mindscape, and a meanwhile box that grows in place. With Meziverse mode off, the tags vanish entirely.

The phone is still a placeholder and its buttons do nothing yet.

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
