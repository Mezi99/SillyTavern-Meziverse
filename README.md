# Meziverse

A fullscreen visual-novel scene for SillyTavern — built for one character card at a time.

Meziverse is an extension, not a fork. It sits on top of SillyTavern and treats it as the backend: the same chat, the same character, the same generation. Open it from the wand menu or the Extensions panel, and step back into SillyTavern whenever you like.

## Status

Early. This repository currently holds the shell and the transcript:

- the fullscreen frame, the Meziverse header and the chat header
- the reading pane, showing the newest message as plain prose, with a log drawer for earlier ones
- a drag handle that resizes the pane, remembered across chats
- a settings sheet: theme, background, interface scale, narration size, reduced motion
- the wand-menu entry and the Extensions-panel block

The composer is a textbox that does not reach the chat yet. The phone and the trackers are on their way. Nothing is written to disk beyond a few appearance settings.

## Install

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/Mezi99/SillyTavern-Meziverse
```

Then reload SillyTavern. Meziverse appears in the wand menu (the magic-wand icon next to the message box) and in **Extensions**.

## Design

Meziverse has a visual language of its own: ink and one metal, Newsreader for prose and Inter for the interface. Themes, sizes and timings are variables — primitives, then semantic tokens, then one block per theme — so a component never names a colour directly.

Nothing in `css/` or `src/` is shared with other extensions, and SillyTavern's own styles are left untouched outside `#mz-root`.

## Licence

AGPL-3.0. See [LICENSE](LICENSE).
