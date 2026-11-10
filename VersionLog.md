# Meziverse — version log

## 2.9.0 — 2026-11-10

The places of the story find their chart: the map arrives — a contour atlas of every scene tag, drawn as territories, picture pins and the journeys between them.

### The map
- A **minimap window** in the corner crops the chart around where the story is now, and a **full map window** opens from it: pan and zoom over the same world, a text index, a place card, a cartouche, journey/flag layers and Fit/Now. The chart is generated from the scene tags alone — territories as soft land, places as picture pins wearing the picture last drawn there, journeys as dotted legs with a glyph for how they went (car, boat, rail, air, cart, rocket).
- **En Route is a journey, not a place.** `En Route | <vehicle>` places nothing at or above the keyword: one moving node per vehicle, its trips as legs between the places around it, parked stops as spots of wherever it rests. A story ending mid-travel draws an open stub.
- **Only the selected swipe variant maps** — unselected swipes are branch material and never touch the map; flipping the selection flips the map by itself.
- **Pictures follow the backgrounds' contract**: one picture per response, belonging to the scene the narration STOPPED at. A place passed through mid-reply never borrows it: passed places draw as **smaller flat dots** and grow into picture pins the moment a response ends there.

### Windows the user shapes
- Both windows drag by any empty spot, resize by a corner grip and **remember their box**; the minimap also zooms (buttons or wheel). The place index is a tree folded to the story's own branch, and the place card is one Seen block (timeline, the visits with their Turn buttons), Who and Journeys — no scrollbar, no image space where no scene ended.
- A tiny click/drag lesson worth keeping: pointer capture engages only once a drag IS one — capturing on pointerdown retargets the click and quietly kills every button under the pointer.

### Notes
- The version rides beside the wordmark ("Meziverse v2.9.0"); `manifest.json` matches.
- Map flags (possible duplicates, ambiguous names, mobile-suspects) are display only for now: the map curator arrives as Part B, its verdicts keyed per chat with Undo, default Off.
- The synthetic suite stands at 254 tests.

## 2.8.2 — 2026-11-08

Music comes to the scene: the story's own soundtrack plays in the corner — asked for by tag, or chosen by feel.

### The music player
- A YouTube player lives in the scene header as a **docked pill** — title, channel, transport, volume — undockable into a free-floating card on wide screens and dragged wherever it likes; a narrow window docks it again by itself. YouTube's own chrome is hidden: the widget is the control surface, and the embed runs YouTube's privacy-enhanced `youtube-nocookie.com`.
- **`<music>` is the story's own request** — a link or video ID plays as written, a song name runs a search and plays the top fit. **Story requests** gates the tag, the player itself lives whenever music is on, and volume, mute, dock and the card's spot are remembered.
- A blocked or gone video never ends the evening: it falls through to the next candidate with its own title and channel, quietly — only an exhausted list speaks, with a "Watch on YouTube" link beside it. A fresh pick never repeats the track playing or the five just heard.

### Song search, on your own key
- Searches run on the **user's own free YouTube Data API key**, in the browser — the referrer pinned, so a referrer-restricted key is the right lock. Shorts, memes and reactions are filtered out, long-form is favored, and candidates are verified embeddable before any frame loads.

### The Music DJ
- A watcher of its own — its own switch, pace, prompt and call — that reads the story after each reply and answers one playback intent (`play` / `volume` / `none`) with a mood and a search query. The story rides as **raw chat turns, tags and all**, cleaned only by the user's own SillyTavern prompt regexes: presets hide story cues in tags, and the DJ needs mood and plot.
- **Pick style** chooses the reach: **Orchestra** — an instrumental score, never vocal songs — or **Songs** — one specific real song as "Artist - Title", the official or artist upload preferred. Both take the genre from the story itself: a Wild West tale, a sci-fi tale and a medieval one never sound alike. **Fresh pick** on the player asks again, with the order to choose differently; a `<music>` tag the story already cued is never overruled.

### The background watcher is its own agent
- The two watchers are **different modules with different logic**, and stay that way. The background watcher reads **environment only**: the last reply grouped by its scene tags with every other tag stripped, plus the current background, the library and the places timeline — the same fixed context on every call, whatever the trigger or the pace. The DJ reads mood and plot, raw. (A brief rewrite in the v2.8 line sent the background watcher raw turns too; v2.8.0's design is restored whole — only the answer-length cap is gone, since some providers count it against the prompt budget.)
- Neither watcher requests structured output: some connections reject it outright (422), and both answers are read from the text.

### Notes
- The version rides beside the wordmark ("Meziverse v2.8.2"); `manifest.json` matches.
- The synthetic suite stands at 213 tests.

## 2.7.0 — 2026-11-06

The spoken word finds its shape: every line said aloud wears a bubble, and the settings learn to make room.

### Speech bubbles
- Every `<speech character tone>` line a reply carries shows in the reading pane as a quiet bubble: **the speaker's name above it** — with the cast's portrait riding the label when avatars hold one for that name — the words inside, and **the tone said in**, a tiny italic after it, like a dialogue tag the model never had to write.
- **The bubble is the quoting**: the quote marks the format asks the model to write are lifted inside it, and come back untouched whenever the words fall to plain prose — the log drawer, or the switch off.
- The name is the contract: the same one word in `present` and `speech character` maps the speaker to their portrait. Narration runs around the bubble; the paragraph never breaks.
- A **Speech bubbles** switch in Features (on by default). Untagged quotes keep their speech color, as always.
- The display form is the quick one, on purpose — the presentation modes (what a bubble does when the speaker wears an avatar) are designed next.

### The settings make room
- The **Images tab is Features** now — four folds: Avatars, Backgrounds, Weather, Speech. The images were never the point.
- **Every header is a fold, closed by default**, and opening one closes the rest: the sheet stays short however much lands in it.

### Notes
- The scene and dialogue instructions still live in the author's note — the extension will carry them itself, fixed and hidden, once testing and tuning are done.
- The synthetic suite stands at 168 tests.

## 2.6.1 — 2026-11-06

The stage is never black, the pictures have a master switch, and the room turns out to be alive.

### The stage is never black
- A chat with no picture of its own opens on **SillyTavern's own background**, and the fall-through is total: the chat's picture, else SillyTavern's default, else the procedural scene. Black is no longer possible.
- The root cause was one worth keeping: the mirror's values land in our own stylesheet, where a **relative** url resolves against the extension's folder and quietly 404s — SillyTavern's default background always ships as one. The mirror now speaks absolute urls.

### The background master switch
- **Background images** in Image Settings: off means the watcher never runs — the brush and the auto pill included — and the generation rows step aside. The stage keeps whatever it shows; weather and indoor effects play on regardless.
- The pill speaks plainly now: **Auto BG: On / Off** — it is about automation, not about backgrounds.

### Weather, polished
- The **storm rains hard**: the downpour reserves wake (twice the drops, longer streaks) and nothing slows them. A blizzard wakes its own reserves of snow.
- The **sun sweeps the sky**: five brighter beams crossing the whole frame on a slow, visible sweep — the light passes across the scene instead of standing still. Night hours keep the rays, dimmed to a faint cool whisper.
- **Overcast is built as cloud shadows** now: dark masses crossing, a whisper of lit fringe. A bright day goes visibly grey; a night stays night.

### The room is alive
- Indoor scenes carry their own quiet mood — **candlelight**, **a hearth** with embers rising, **window light** with dust turning inside it, **still dust**, **a lamp pool**. No tag names it: the place itself is born with its mood (seeded — the same room always shows the same one), and the window's light follows the scene's clock.
- Its own switch in Image Settings, independent of the weather switch and of image generation.

### Notes
- The watcher prompts now ask for the world: architecture, materials, vegetation, culture and era follow the region the location chain names — a suburb of Las Vegas is never a suburb of Pyongyang. Press "Restore default" on the prompt rows to pick the new text up.
- The synthetic suite stands at 162 tests.

## 2.6.0 — 2026-11-06

The weather arrives: rain on the glass, sun across the floor, and the scene tag learns the clock.

### The scene tag grows
- **`weatherTag` names the weather** from an exact list — Clear / Sunny / Rain / Storm / Snow / Fog / Overcast / Wind — and **`locationTag`** (`Indoor` / `Outdoor`) gates it: effects play outdoors only, strictly, so it never rains inside the house. Replies that spell things their own way fold quietly (drizzle, thunder, blizzard, mist, cloudy…), and anything unknown shows nothing.
- **`time="(HH:MM)"` becomes its own field.** The clock is too load-bearing to live in free text: the light's place in the sky reads it, and older tags still work — a clock buried in `date`, or day words like "Early Evening", still speak.
- The location chain keeps its four named levels — the world it names (a Vegas suburb is not a Pyongyang suburb is not a village in a fantasy realm) sets the art direction of every generated picture — and now **reads like a path** in the UI: `Japan › Suburban neighborhood › Jammie's house › Kitchen window`, the model's own `|` kept in the tooltip.

### Weather on the background stage
- One layer where the tint stood — over the background, behind the cast, rails and narration pane. **Rain** falls as a leaning curtain of streaks; **storm** brings the downpour and cold lightning that double-strikes on co-prime cycles so the beat never repeats; **snow** drifts with sway; **fog** slides in soft banks; **overcast** moves as cloud you notice; **wind** carries streaks, leaves and dust; **blizzard** is snow on the wind.
- **The sun sits where the story's clock says** — the same clock that lit the painted backdrop, so the light and the picture agree. Its beams fan across the whole stage and sweep slowly; night hours dim the set to a faint cool whisper.
- The free-text weather's tone words — heavy, light, drizzle, thick — tune how hard each effect reads, in three tiers.
- A **Weather** switch in Image Settings (on by default). Reduced motion freezes every particle where its desynced clock stands — a still photograph of the weather — and lightning never fires. The mindscape lets it fade with the pane.

### Notes
- The background shows **clean**: the dark wash over images is commented out, waiting — it may return as the daycycle (day/night) layer.
- The synthetic suite stands at 157 tests.

## 2.5.3 — 2026-11-05

The scene stays lit, and the glass keeps its hands to itself.

### The scene behind the glass
- The background mirror speaks only in **authored urls**. It used to copy the browser's computed style — which Chrome hands back as `cross-fade(...)` machinery while a background transition runs — and one such value in the mirror's CSS variable blanked the whole scene to black. The probe now reads the inline value, every candidate is vetted, and a stranger is dropped: the last good picture stays.
- The glass reads **our own scene**, never the page behind: one scene in two layers — the sharp read across the frame, and the soft twin (the pane blur slider drives it) living in the narration pane's box alone — its blur edge IS the pane's border line, and nothing bleeds beside it. Not one `backdrop-filter` remains in the extension: Firefox's compositor sampled those wrong and washed the grey of SillyTavern's theme over the whole UI on screen (screenshots stayed correct — the tell). SillyTavern's own "no blur" toggle confirmed the cause.
- Chrome and Firefox now show the same scene at the same time. The background ordering oddities — a picture lagging one turn behind, turns going black — were the same mirror, caught mid-fall.

### When the watcher wakes
- The watcher comes for **new turns only**. Opening a chat draws nothing — the recorded picture for the shown turn comes back at once, or SillyTavern's own background when nothing was recorded — and waiting for images to render before the first word is typed is over. An opening that wants a picture presses the brush.
- Swiping draws nothing either: a resolved variant brings its own picture back, an unseen one keeps the picture it swiped from.

### Notes
- Exiting hands the chat's background back as a **picture, never a hole** — an empty baseline falls to SillyTavern's own unlock instead of painting nothing.
- Hand-reviewed in Chrome and Firefox before release.
- The synthetic suite stands at 147 tests.

## 2.5.2 — 2026-11-05

The watcher speaks in names again, and the settings drawers got tidied.

### The watcher's question
- Every place is labeled **`short name [Full/world/map location: ...]`** — the short name (the location chain's last segment, "Unit 4B - Bedroom") is the place to paint; the chain before it (city, district, street) is context for a better prompt, never its subject. The model no longer mistakes the chain for the place, and the prompt rules say outright: "prompt" is never a location, a place name or received text.
- Descriptions arrive **whole** — the 200-character cut is gone — and the style suffix is appended once, never stacked on its own echo. The author's-note bracket echo (`[...]`) is stripped wherever it had leaked through.
- A reply without a scene tag still runs the plain-prose fallback at the pace, and says so with one notice per chat.

### Settings
- **Images** (was "Image generation") with two foldable sections, both closed by default: **Avatars** and **Backgrounds**. "Avatars On/Off" steps the cast strip aside — the background alone on stage — while the narration pane's height stays its own.
- **Pane blur**, under Pane transparency: 0 to 24 px, clean or cloudy as you like.
- The mode switch moves into Settings > Meziverse mode as its header row — out of the main UI, where it is not meant to be flipped mid-chat. A `DEV_EXTRAS` release flag hides the whole tab and keeps the extras inert: a release ships the base extension alone.

### Notes
- The version rides beside the wordmark ("Meziverse v2.5.2"); `manifest.json` matches.
- The windowed-mode stacking fix was deliberately deferred to v2.5.3 — with browser-vs-browser research, it needs its own room.
- The synthetic suite stands at 146 tests.

## 2.5.1 — 2026-11-04

The master switch. Everything the extension does lives inside the extension, and nothing runs unless the Meziverse scene is open: closed or never opened, the chain sits idle — no watcher call, no image drawn, no metadata touched.

- The scene's open state gates the whole background chain — every event handler, every run — and the prompt injection to come rides the same gate. Opening catches the chat up: the shown turn's picture re-asserted for free, the chat's end resolved once as if its reply had just arrived (a stamped end costs nothing; at most one image per open). Closing hands the chat's background back.
- The **takeover baseline** remembers what SillyTavern had on screen before the chain's first write — its lock and its shown image — so exiting restores the pair exactly as found. A background the user took back (unlocked, or locked their own) is theirs: exiting stands down. A chat change while the scene is closed hands that chat back the same way — off means off in every chat.

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
