# Plugins

A plugin is a folder with a `manifest.json`. It hands the island data, and the island draws it from a few building
blocks. A plugin never draws pixels, and it cannot reach the network, the audio, your programs or your files unless
its manifest says so and you switch it on (you are shown what it asks to see first).

The island itself is a window manager for cards: the pill, the hub, the banners, the floating cards, the calendar, the eyes and
the sensors (the sound, what is playing, which programs have a window). Everything it shows beyond that comes from a plugin,
and its own features are no exception.

There are three kinds (a face is a fourth, for a plugin that draws):

* **Declarative**: the manifest names an address to poll (JSON, or a calendar), and the card, the pill, the rings and the banner
  are written as templates over what the address answers. No plugin code runs.
* **Module**: a WebAssembly file for a plugin that needs real logic (audio, games, files, the calendar, what is playing). The
  island calls it with what it may see; it answers with what the island is to do. It has **no network of its own**: one that sees this PC reaches nothing, and one that reaches a host (`permissions.net`)
  sees nothing of this PC. It has only the sensors its manifest lists, a time budget for each call, and a memory cap. It is written in any language that makes
  WebAssembly; there is a Rust SDK and there are plugins to read in [nadi-plugins](https://github.com/Llyme/nadi-plugins).

**The island starts as a blank slate.** Nothing ships inside it: every plugin is a folder, and is off until you switch it on. They come from [nadi-plugins](https://github.com/Llyme/nadi-plugins) (Settings > Plugins >
`+`, or *Get plugins* on a fresh list) or from any repository or folder you point it at: *Time* and *Calendar* are two of them. The
host knows none of them by name.

## What a plugin can do

| | declarative | module |
|---|:-:|:-:|
| a **card** in the hub (and floating) | templates | blocks |
| a **pill** on the collapsed island, while something is going on | templates | `pill` |
| a pill that **comes by itself** for a moment, like the time | | `say` with a `pill` |
| **rings** in the hub, next to CPU and memory | templates | `rings` |
| a **banner** (with a priority; mute and Do not disturb apply) | `attention` | `say` |
| **buttons** that call the plugin back | | `buttons`, `action` events |
| a picture | `image` | `image` |
| **events for the calendar** | `format: "ics"` | `events` |
| read the calendar | | `calendar` |
| see what is playing, press play / next | | `media`, `media_control` |
| see how busy the CPU and memory are | | `system` |
| hear the sound (levels and bands) | | `audio` |
| see which programs have a window | | `processes`, `titles`, `programs` |
| know how long the keyboard and the mouse were left alone | | `idle` |
| read what other apps notify | | `notifications` |
| run a command (`git`...), in the shape the manifest lists | | `run` |
| keep a small file between runs (sealed for this Windows user) | | `storage` |
| see the Claude Code sessions | | `claude` |
| see the pages open in the browsers (through the NADI extension), press a button of one | | `browser` |
| open a link, bring a window to the front | | `open`, `focus` |
| read a file when it changes | | `files` |
| ask the network | listed hosts | `fetch`, to the hosts it lists, and then it sees nothing of this PC |
| keep time without being polled | `every` | `wake_in` |
| ask the others to be quiet (a game is on the screen) | | `quiet` |
| a line about how it is doing, in Settings | `status` | `note` |

## Where they live

```
%APPDATA%\NADI\plugins\<id>\manifest.json
```

Settings > Plugins lists them, shows what each one asks to see, has the switches, each plugin's settings, a button to
mute its banners, and **Do not disturb**. A plugin you drop in is **off** until you turn it on, and switching it on
asks first. "Open the plugins folder" opens the folder; "Look again" reads it again. The app puts nothing in the
folder: the plugins come from a repository (see below) or from you.

## What ships with the app

Nothing: every plugin of NADI is a folder, and the official ones are in [nadi-plugins](https://github.com/Llyme/nadi-plugins) (Time,
Calendar, Games, Downloads, Work, Now playing, Notification mirror, System meters, Eyes, Sound light, Claude, Page Reader). **A new install starts blank**: the expanded island says so, with a button to the plugin list. An install that has
run before is asked once whether to get the plugins it had from there, and keeps their settings.

### What stays in the island

* **The windows**: the pill (and the order its views take: a banner, then the highest pill a plugin offers, then what the island
  shows by itself), the hub, the banners with their priority and do not disturb, the floating cards.
* **The head** and **foot** of the hub, which are rows (see below). Settings are opened from the tray icon's menu.
* **The store of calendar events**, which is only plumbing: whoever has events brings them (the Calendar plugin does; so can a
  module, see `events` below), and whoever works from them takes them (the card and reminders of Calendar do). The month view is
  the Calendar plugin's page.
* **The sensors** the plugins read: the sound, the media session, the list of windows. A plugin sees one only after you allowed it.
* The notification list.

### The head, its widgets and its pages

The top of the expanded island is **rows**, and so can be its bottom, under the cards. Every row has a left, a center and a right place, and the plugins fill them with
**widgets**: the eyes (a widget of the Eyes plugin), the date and the time (of Calendar), three thin bars for the CPU, the memory
and the GPU (of System meters), two labelled bars for the Claude limits (of Claude usage), and the rings any plugin adds. A plugin
may offer **as many widgets as it likes**: System meters and Claude usage also offer a ring for each number. The ones that
`start` are in the head the first time; the rest wait in the tray of Settings > Expanded Island. Widgets start at the top; the bottom is empty
until you drop a widget there.

* Every widget is shown. When they do not fit in the first row, the head grows another, as many as it takes.
* The center of a row is at its dead center. The two sides share what is left of it, equally, and a side only grows up to that
  half, so the center never moves for a side. A row with nothing in the center has none, and the two sides share the whole row.
* **Settings > Expanded Island** lets you arrange it: drag a widget to the left, center or right of any row
  (it is refused, in red, when there is no room; the rows of the bottom of the island are under the cards), or drag it onto the
  tray to take it out. The **tray** lists every widget of the plugins that are on, by plugin: drag one onto a place
  (or press it, and it goes to its own place of the first row). It keeps one height and scrolls inside itself; a group folds
  (the first two start open), a search cuts it down by the widget's or the plugin's name, and "Hide in use" folds away what is
  placed already. Add a row, or Reset (which puts back only the widgets that start in the head). What you arranged is kept in
  `%APPDATA%\NADI\head.json`; a widget that starts, and that a plugin adds later, takes its own place, and one whose plugin is
  off is not drawn.
* A widget may open a **page** (a *pane*): the date of the Calendar plugin opens the month view in place of the cards, and pressing it again brings the cards back.

## Modals, and plugins from a repository

### A modal

A **modal** is a small window the island opens: you move it by its bar, it snaps to the edges of the screen and to other modals, and it
says whose it is. It lives on the same layer as the floating cards (so it never takes the focus of a game, except while you type in
one of its fields, and over a fullscreen game it lets the clicks through until you hold the Fullscreen Guard's key). Nobody draws a
modal but the island: the one who asks describes it (a **spec**) and gets the answer back as an event.

A spec has a `title`, `blocks` and up to three `buttons`; it may have a `width` (280 to 520 px), a `busy` line (the buttons wait), and
`at`, where it opens the first time: `"center"` (the default: the middle of the screen the island is on), `"island"` (beside it),
`"cursor"`, an edge or a corner (`"top"`, `"bottom-right"`...), or `{ "x": 0.5, "y": 0.3 }` (where its middle goes, as a part of the
screen). After you have moved a modal, one of its kind opens where you left it.

| block | what it is | what comes back |
|---|---|---|
| `{ "text": "...", "kind": "title" \| "muted" \| "note" \| "warn" }` | a paragraph | |
| `{ "facts": [{ "title", "text" }] }` | a title in a face of its own, and what it means | |
| `{ "field": "name", "label", "value", "placeholder", "focus" }` | one line of text | `values.name` |
| `{ "choice": "name", "options": [{ "id", "label" }], "value" }` | a few options, one picked | `values.name`: its id |
| `{ "list": "name", "items": [{ "id", "label", "sub" }], "value" }` | rows, one picked | `values.name`: its id |
| `{ "progress": 0.4, "text": "..." }` | a bar (`null`: moving) | |

A button is `{ "id", "label", "primary", "danger", "stay" }`: pressing it closes the modal, unless it `stay`s (the one who asked answers
with the next step, which replaces the window).

**A module** answers a call with `"modal": { ... }` (the same spec; `null` closes it), and is told what was pressed by an `action` event
with `action == "modal"` and `args == { "button", "values", "closed" }`. It has one modal at a time. Its blocks are `text`, `facts`,
`field`, `choice`, `list` and `progress`; the island puts the plugin's name on the bar, so a plugin cannot pass for the island or for
another plugin, and a plugin that is switched off loses its modal. A modal asks for no permission: it only shows words and takes
answers. In Rust: `Reply::modal(Modal::new("Snooze").text("For how long?").choice(...).primary("snooze", "Snooze"))` (see
`busy-meter` in nadi-plugins).

### Plugins from a repository

Settings > Plugins has a `+`: *Add plugins from GitHub*. Paste `owner/repo` (or the repository's address, or a link to a release or a
branch) and NADI looks in it: it downloads it once from github.com (a release's `nadi-plugins.tar.gz` when it has one, else the archive
of its latest release, else of its default branch; at most 20 MB, over https, and nothing else is asked), reads it in memory and shows
every plugin in it, what each asks for, and what is wrong with the ones that cannot be installed. You tick what you want; they are
installed **switched off** (the same question as for any plugin comes when you switch one on), with a note of where they came from, and
sit together in the list under the repository's name. *Check for updates* looks in the repository again.

A repository needs no special file. **Every folder with a `manifest.json`, up to three folders down, is one plugin**, with the files
directly in it. A module needs its built `.wasm` beside the manifest: NADI never builds anything, so a repository builds them (a
workflow) and attaches `nadi-plugins.tar.gz` to a release, or commits them. An optional `nadi-plugins.json` at the top gives the list a
`name` and an `about`, an `order` (ids that come first) and `hidden` (ids kept out); it can never add a permission or an address, those
come from each manifest. A plugin whose id is one of the app's, or one that is already on the PC from somewhere else, is shown and left
alone.

## Faces

A plugin may draw for itself. A **face** is a script (`face.js`, in the plugin's folder) that the island runs in a frame it gives it:
the aura behind the island, the eyes, a card of its own. A plugin that is only faces has `"kind": "face"`; a module may have faces
too. The manifest lists them:

```json
"faces": [
  { "id": "aura", "slot": "backdrop", "file": "face.js" },
  { "id": "head", "slot": "widget", "file": "face.js", "name": "Eyes", "place": "center", "rank": 20, "width": 72 }
]
```

| slot | where the frame is |
|---|---|
| `backdrop` | behind what the island shows (role `inside`), and over the window's margin around it (role `outside`: light that spills) |
| `island` | over the island: the collapsed island, and the hub's head and cards |
| `widget` | a widget of the head (`name`, `place`, `rank`, `width`, `height`: the row's height when it says none) |
| `card` | a card of the hub (`height`) |

The frame is **sandboxed**: no network, no storage, no way into the island's page, a script of at most 600 KB. All it can do is paint
in its frame and press. What reaches it is what the plugin's permissions allow (`audio`: the sound, already understood; `cursor`:
where the cursor is, never what it clicks) and what the island is doing. The script has a small `nadi`:

* `nadi.on("frame", fn)`: once for every frame the page draws, while the frame is shown, with `{ now, dt, view, island: { w, h, x, y,
  r, pad }, win: { w, h }, rect: { x, y, w, h } (this frame, in the window), peers (where the plugin's widgets are, in the island's
  pixels), audio, cursor: { x, y, dx, dy, speed, hover, seq } }`. It paints; it needs no timer of its own.
* `nadi.on("event", fn)`: `{ name, data }` for `view`, `hub-open`, `blip`, `boop` and `beat` (a hit of the bass: `{ strength, pan }`).
* `nadi.on("resize", fn)`; `nadi.settings` (the plugin's settings, kept up to date); `nadi.role`, `nadi.face`, `nadi.plugin`.
* `nadi.press(id, args)`: tells the plugin's module, if it has one (an `action` event with `action == "face"`).

## The manifest (declarative)

```json
{
  "id": "downloads-local",
  "name": "Downloads (qBittorrent)",
  "description": "What qBittorrent is downloading.",
  "version": "1.0.0",
  "kind": "declarative",
  "permissions": { "net": ["127.0.0.1:8080"] },
  "source": {
    "http": "http://127.0.0.1:8080/api/v2/torrents/info?filter=downloading",
    "every": "2s"
  },
  "card": {
    "icon": "download",
    "title": "{{count}} downloading",
    "sub": "{{first.name}} · {{first.progress | percent}}",
    "peek": "{{first.progress | percent}}",
    "body": [
      { "progress": "{{first.progress}}" },
      { "list": "items", "limit": 5,
        "row": { "title": "{{name}}", "sub": "{{size | bytes}}", "progress": "{{progress}}" } }
    ]
  },
  "pill": { "when": "{{count}}", "icon": "download", "title": "{{count}} downloading",
            "right": "{{first.progress | percent}}", "progress": "{{first.progress}}", "rank": 12 },
  "rings": [{ "id": "dl", "color": "#5ac88c", "pct": "{{first.progress * 100}}", "tip": "Download · {{first.progress | percent}}" }],
  "attention": {
    "list": "items", "id": "hash", "field": "progress", "reaches": 1,
    "priority": 50, "banner": "Finished: {{name}}"
  }
}
```

| field | meaning |
|---|---|
| `id` | lower case letters, digits, `.`, `-`, `_` (up to 48) |
| `permissions.net` | the hosts it may ask: `host` (any port) or `host:port`. Nothing else is reachable. An entry may be a setting: `"{{settings.url}}"` allows the host of the address the user pastes there, and the question before it is switched on says so. |
| `source.http` | the address to `GET` (templates over the settings are filled in). It must be `https` (or `http` to this PC). A redirect is followed up to three times, and only to an address that is on the list too. |
| `source.every` | `500ms`, `2s`, `15m`, `1h`; a template over the settings works too (`"{{settings.poll_min}}m"`). Never faster than every second, and never faster than every 30 seconds for a host that is not this PC. Default 30 s. |
| `source.format` | what the address answers: `json` (the default), or `ics` (a calendar: its events go to the island's calendar, and `count` and `items` are there for the templates) |
| `source.max_kb` | the most the answer may be (1000 by default, 8000 at most) |
| `source.pick` | where in the answer the data is (dotted), if not the whole answer |
| `source.when` | `visible` (default: poll only while a card could be seen) or `always` (for a calendar, or what says something while the island is hidden) |
| `needs` | settings that must be filled in before it asks anything (`["url"]`); until then it says `setup` under its name |
| `status` | a template for the line under the plugin's name in Settings (`"{{count}} events read."`) |
| `card.icon` | one of the island's line icons (`download`, `sun`, `calendar`, `music`, `globe`, `clock`, `bell`...) |
| `card.rank` | where the card sits among the others (lower comes first, 70 by default) |
| `card.title`, `card.sub`, `card.peek` | templates. `peek` is what the closed card says at its right. |
| `card.body` | building blocks, below |
| `pill` | the pill it shows while `when` holds: `icon`, `title`, `sub`, `right`, `progress` (0 to 1), `rank`, `w`, `h` (see [The pill](#the-pill)) |
| `rings` | rings in the hub: `id`, `color` (`#rrggbb`), `pct` (a template that gives 0 to 100; a ring with no number is not shown), `tip` |
| `attention` | when to drop a banner, below |

### What the templates read

The data picked from the answer. A list becomes `items`, with `count` and `first`; an object is read as it is.
`{{path.to.value}}` (dots and list positions: `items.0.name`). One operator is allowed between two values
(`{{position / duration}}`). Filters follow a `|`:

`percent` (0.61 → 61%), `round` / `round:1`, `bytes`, `speed`, `duration` (seconds → 1h 12m), `upper`, `lower`,
`trim`, `len`, `join:, `, `truncate:40`, `default:text`.

### Building blocks

| block | draws |
|---|---|
| `{ "progress": "{{x}}" }` | a bar, 0 to 1 |
| `{ "text": "..." }` | a line of text |
| `{ "badge": "..." }` | a small pill |
| `{ "facts": [["Label", "{{value}}"], ...] }` | label and value rows |
| `{ "list": "items", "limit": 6, "row": { "title", "sub", "progress" } }` | a row for each item (inside a row, `{{name}}` reads the item) |
| `{ "image": "{{art}}" }` | a picture; the text must be a `data:image/png;base64,...` address (png, jpeg, webp, gif; up to 200 KB). Never a link: the island does not fetch for a plugin. |

A block with nothing to say (an empty text, a fact with no value) is left out. A module has the same blocks as JSON
(`{ "kind": "progress", "value": 0.4 }`...), and these: `bars` (a row of meters), `buttons`, `seek` (a thin bar you can press, with `before` and `after` buttons at its sides), `graph` (a line through numbers, oldest first: `values`, `max` for the top of the graph, and up to four `marks` for faint lines across it), `lines` (rows of an icon and a text, the one that is `now` lit), `meter` (`label`, `value`, `text`, `color`), `stats` (`items` of a `value` and a `label`) and `text` with a `label` (a paragraph that opens in bold). `picture` (a page's main picture, by its id) and `reader` (a guide laid out to be read, by its key: the island fetches the words and the pictures itself, from its own link to the browser extension) are for a plugin that has `browser`. A card may also have `controls` (buttons in its header), a `tile` (a letter in a colour, with a `ring` around it), a `sub_icon` and a `tone` (`waiting`, `working`, `finished` or `idle`: the card is marked, and its icon sits at the right), and `badges` (small icons at the right, with a tooltip). A pill may have a `tile`, `rows` (a label, a bar and a number: a peek) and `brief` (it comes by itself, and its `rank` may be up to 100).

### A moment inside a text

Any text of a card, a pill or a ring (a title, a line, a row) may hold `{when:1760000000000}` (a time, in milliseconds since
1970) or `{when:1760000000000:day}` (a day only). The island writes it the way the viewer reads a moment (*Today 3:00 PM*,
*Tomorrow*, *Fri, Oct 9*) and writes it again at midnight without another call. The SDK's `when(ms, all_day)` makes it.

### Attention (banners)

`attention` watches the data between two answers and drops a banner when something *happens* (never for what was
already true when the plugin was switched on):

* a list: `list`, `id` (the field that tells items apart), `field`, `reaches` (a number the field got to)
* one value: `field`, `becomes` (the text it changed to; leave it out for any change)

`priority` (1 to 100) says who goes first when several banners wait. A session that needs you is 90; a plain
notification is 0. `banner` is a template (inside a list, over the item).

## The pill

The collapsed island shows one pill at a time: the highest of what it has. A banner or the hub has it first; then the highest
`rank` among the pills the plugins offer (Work 10, Games 20, Now playing 30, the usage peek 100; a plugin's
own is 0 to 99), then the eyes. A pill is offered while something is going on and taken back when it is over (a module says
`pill: null`; a declarative plugin's `when` stops holding); switching the plugin off takes it back too.

```json
{ "icon": "music", "title": "Song", "sub": "Artist", "right": "3:21", "progress": 0.4,
  "bars": [0.1, 0.8], "buttons": [{ "icon": "pause", "label": "Pause", "action": "pause" }],
  "rank": 25, "w": 260, "h": 48, "look": "" }
```

It draws an icon tile, the title with a line under it, a short text at the right (or meters), a thin bar along the bottom, and up
to three buttons. `w` is 200 to 360 and `h` is 32 to 72 at the standard width (260; the setting scales it). `"look": "big"` is
only large light digits, as the time is shown.

A pill that comes **by itself** for a moment (the time, a reminder) is a `say` that has a `pill`: it waits in the queue with the
banners, by priority, and mute and Do not disturb apply to it (below 90, a pill is held back in Do not disturb).

```json
{ "say": [{ "text": "3:30 PM", "priority": 10, "ambient": true, "pill": { "icon": "clock", "right": "Fri, Oct 9", "look": "big", "ms": 4000 } }] }
```

`ambient` means only when nothing fills the screen: not over the hub, not while a game is on (`quiet`). What a plugin says as the
answer to a button the user pressed is always shown.

## Icons

An `icon` (a card, a pill, a button) is one of the island's line icons, one stroke style coloured by the text around it:
`plug`, `island`, `palette`, `reset`, `gamepad`, `briefcase`, `lock`, `unlock`, `shrink`, `term`, `search`, `phone`, `moon`, `chevron`, `download`, `up`, `repost`, `heart`, `eye`, `eyeoff`, `power`, `cursor`, `sq`, `focus`, `follow`, `wave`, `timer`, `hourglass`, `image`, `expand`, `contrast`, `calendar`, `bell`, `link`, `code`, `pen`, `sun`, `sparkle`, `mail`, `music`, `globe`, `dot`, `plus`, `minus`, `x`, `clock`, `sliders`, `file`, `check`, `pillshape`, `steps`, `book`, `news`, `pot`, `ask`, `tag`, `play`, `pause`, `prev`, `next`, `branch`, `chat`, `shield`.
An unknown name draws a dot.

## Settings

A manifest can list what the user may set. They appear under the plugin in Settings > Plugins, and are read as
`{{settings.key}}` by the templates (also inside `source.http`) and sent to a module with every event.

```json
"settings": {
  "latitude": { "label": "Latitude", "type": "number", "default": 25.03 },
  "show_bpm": { "label": "Show the tempo", "type": "toggle", "default": true },
  "every": { "label": "Every", "type": "choice", "default": 60, "options": [{ "value": 30, "label": "30 minutes" }, { "value": 60, "label": "Hour" }] }
}
```

`type` is `text`, `number`, `toggle`, `choice` or `range` (a slider: `min`, `max`, `step` and the `unit` written after the number). `"actions": [{ "id": "preview", "label": "Show it now" }]` puts buttons in the
plugin's settings; a module is sent an `action` event when one is pressed. An action that needs a word from the user (a code to
paste) says `"ask": "what the field asks"` and `"then": "the-call"`: the field comes under the buttons, and what is typed goes
to that call as `{ "text": ... }`.

## What the host does for you (and to you)

* One request at a time, 5 seconds at most (15 for a calendar), 1 MB of answer at most (`source.max_kb`).
* Redirects only to a host on the list, no other host than the ones listed, no plain `http` to another machine.
* Polling only while a card could be seen (the hub is open, the island is showing, or a card floats), unless
  `"when": "always"`.
* A request that fails keeps the last good card on screen, and the error shows in Settings > Plugins.
* A plugin that is switched off is not polled at all, and what it brought (a pill, rings, events) goes with it.

## Module plugins

```json
{
  "id": "example-audio-meter",
  "name": "Audio meter",
  "kind": "wasm",
  "module": "audio-meter.wasm",
  "permissions": { "audio": true },
  "live": true,
  "budget": { "call_ms": 4, "memory_mb": 8 }
}
```

| field | meaning |
|---|---|
| `module` | the `.wasm` file, in the plugin's folder |
| `permissions.audio` | hear what is playing, as a level and 16 bands (about 20 times a second; `bands` is the scale of the island's lights and fills up on loud music, `spectrum` keeps its range, for a meter). Never the sound. |
| `permissions.processes` | see which programs have a window, and which is in front (every 2 s) |
| `permissions.titles` | ... and the titles of those windows (a browser's title is its page), and the popups that have no button in the task bar; each window has an `id`, a size, and `tool` |
| `permissions.programs` | ... and, for each, where the program is (`path`), its name, its icon (a `data:` address, told the first time only), and `full`: it covers its whole screen and has no title bar, as a game does |
| `permissions.idle` | `idle_s` in the `processes` event: seconds since the keyboard or the mouse was last used (never what was typed) |
| `permissions.notifications` | an event with the title and the text of what other apps notify (Windows' toasts), once for each; Windows asks the user once |
| `permissions.run` | command lines it may have run, each as written: `"git -C * status --porcelain"` (`*` is one argument the module chooses, never one that starts with `-`). The island runs it without a window, for up to 8 seconds, and tells the module what it printed. |
| `permissions.storage` | a small file of its own (up to 64 KB), told with the start and written when a reply says `store` |
| `permissions.usage` | watch up to four programs (a reply says `watch`, with their process ids) and be told, each second, what each uses: CPU, memory, graphics card, video memory, and frames per second (counted only while it watches; Windows lets only an administrator count them) |
| `permissions.browser` | the pages open in the browsers, as the NADI browser extension reads them (`browser` event, about every second when something changed, for the pages the module `watch`es): headings, short paragraphs, buttons and links with where they sit, the page's metadata, its video. The module says in `browser.config` which sites are never read and which buttons are safe to press; the extension reads nothing until it is told. A reply may ask for a button to be pressed or a tab to be sent to another page of its site (`browser.press`, `browser.go`; `browser_done` says it was done). |
| `permissions.claude` | the Claude Code sessions on this PC, every 2 s (`claude` in the event): the title, the folder, the prompt, the latest tool calls, how full the context is, what it cost, the window it runs in |
| `permissions.net` | the hosts it may ask (`api.anthropic.com`), always over https; a reply says `fetch` and the answer comes as a `fetched` event. A module that has this sees nothing of this PC (none of the sensors above), so what it sees cannot be carried out. Every event of such a module has `rand`, 32 random bytes as hex, to sign in with. |
| `permissions.open` | links it may open: a banner's `open`, or a reply's `open` (the link starts with one of them) |
| `permissions.downloads` | what the browsers, Steam and qBittorrent are downloading (names and progress, every 1.5 s), and have a finished one shown in its folder |
| `permissions.files` | files it may read when they change (`~` and `%VARIABLES%` are filled in; the last 256 KB) |
| `permissions.calendar` | the events of the island's calendar that are not over yet (an hour of grace), when they change |
| `permissions.media` | what is playing: a session for each player, with the title, the artist and the position (every second while it plays). Never the picture. |
| `permissions.media_control` | ... and press play / pause, next and previous for a player (needs `media`) |
| `permissions.system` | how busy the CPU and the memory are (every 2 s) |
| `tick` | call it with nothing else to say every so often (`"5s"`), if it keeps time. (Better: ask for `wake_in` in a reply.) |
| `live` | its card goes to the screen as it changes (up to 20 times a second), for a meter. Otherwise the screen asks once a second. |
| `source.when` | `"always"` to keep running while the island is hidden (to say something, to offer a pill); the default runs only while a card could be seen |
| `budget.call_ms` | the time one call may take: 4 by default, 20 at most |
| `budget.memory_mb` | memory: 8 by default, 64 at most |

A module that lists `net` sees nothing of the PC (none of the sensors, no commands): nothing that hears or sees the PC can also
reach the network, so what it sees cannot be carried out. (*Claude* is one plugin made of two parts, see [Bundles](#bundles): the part
that reaches Anthropic sees nothing of the PC, and the part that sees the sessions reaches nothing.) The one exception to "no network for what sees" sends nothing out: a
module may name a calendar link (`source.http` with `"format": "ics"`, the address a `{{settings.url}}` setting holds, and `net` for
that host only). The island reads the link with a plain request to that one address and brings its events to the calendar; the
module makes no request, and gets only the events. This is how *Calendar* works.

### The interface

The module exports `memory`, `nadi_alloc(len) -> ptr` (where the host writes the event), `nadi_call(ptr, len) -> i64`
(the answer: its pointer in the high 32 bits, its length in the low 32), and optionally `nadi_free(ptr, len)`. It may
import nothing. The event and the answer are JSON.

```json
// in (every event has event, now, tz_offset and settings)
{ "event": "start", "now": 1760000000000, "tz_offset": 540, "settings": { "show_bpm": true } }   // the first call, and again when the plugin is switched on
{ "event": "tick", "wake": true, ... }                  // the manifest's `tick`, or its own `wake_in` came due
{ "event": "audio", "audio": { "level": 0.5, "bands": [ ...16 numbers 0..1 ], "spectrum": [ ...16 numbers 0..1 ], "beat": true, "kick": false, "hit": 0.4,
                               "kind": "music", "voice": 0.1, "bpm": 123.4, "energy": 0.6, "pan": 0.0 }, ... }
{ "event": "processes", "windows": [ { "exe": "endfield.exe", "pid": 4120, "title": "", "front": true } ], "idle_s": 3.2, ... }
{ "event": "file", "path": "C:/Users/me/x.log", "text": "...", ... }
{ "event": "calendar", "events": [ { "uid": "a", "summary": "Standup", "start_ms": ..., "end_ms": ..., "all_day": false } ], ... }
{ "event": "media", "sessions": [ { "source": "Spotify.exe", "title": "...", "artist": "...", "playing": true, "position": 31, "duration": 214, "can_previous": true, "can_next": true } ], ... }
{ "event": "system", "system": { "cpu": 12.5, "ram": 49.0, "ram_used_gb": 13.6, "ram_total_gb": 27.6 }, ... }
{ "event": "notifications", "notifications": [ { "seq": 7, "app": "Discord", "title": "Sam", "body": "are you there?" } ], ... }
{ "event": "command", "id": "branch", "code": 0, "stdout": "main", ... }   // the answer of a command it asked for
{ "event": "usage", "usage": [ { "pid": 4120, "alive": true, "cpu": 12.4, "ram_gb": 6.2, "ram": 20, "gpu": 73, "vram_gb": 4.1, "fps": 144, "low_fps": 98, "frame_ms": [6.9, 7.1] } ], ... }
{ "event": "downloads", "observed": [ { "id": "chrome.exe:7", "source": "Chrome", "kind": "browser", "name": "a.zip", "received": 5000, "total": 90000, "speed": null } ], "ended": [ { "id": "chrome.exe:6", "finished": true, "path": "C:/Users/me/Downloads/b.zip" } ], ... }
{ "event": "action", "action": "snooze", "args": null, ... }   // a button was pressed (on a card, a pill, or in the plugin's settings)

// out (everything optional; a thing the answer does not mention stays as it was; null takes it away)
{ "card": { "icon": "wave", "title": "Audio", "sub": "Music · 123 bpm", "peek": "50%", "rank": 60,
            "body": [ { "kind": "bars", "values": [0.1, 0.9] }, { "kind": "progress", "value": 0.4 },
                      { "kind": "text", "text": "..." }, { "kind": "badge", "text": "..." },
                      { "kind": "facts", "rows": [["Session", "1h 2m"]] },
                      { "kind": "list", "rows": [{ "title": "...", "sub": "...", "progress": 0.5 }] },
                      { "kind": "buttons", "items": [{ "label": "Pause", "icon": "pause", "action": "pause" }] },
                      { "kind": "image", "src": "data:image/png;base64,..." } ] },
  "pill": { "icon": "timer", "title": "...", "sub": "...", "right": "92%", "rank": 5, "buttons": [ ... ] },
  "rings": [ { "id": "busy", "pct": 61, "tip": "Busy · 61%", "color": "#e8b04a" } ],
  "say": [ { "text": "You have been playing for 2h", "priority": 40 },
           { "text": "3:30 PM", "priority": 10, "ambient": true, "pill": { "icon": "clock", "right": "Fri", "look": "big", "ms": 4000 } } ],
  "events": [ { "uid": "raid-1", "summary": "Raid night", "start_ms": 1760000000000, "end_ms": 1760003600000, "all_day": false } ],
  "quiet": true,
  "note": "Connected",
  "wake_ms": 15000,
  "media": { "action": "play_pause", "source": "" } }
```

* `tz_offset` is how far this PC's clock is from UTC, in minutes: a module has no time zone, and `now` is UTC. (The SDK's
  `ev.local()` gives the date and the time of day.)
* `events` brings events to the island's calendar (the month view, and the *Calendar* card and reminders work from it too). A module that
  says `events` again replaces what it brought; `"events": null` takes them away; they go with the module when it is switched off.
  At most 500 events, each with a summary of up to 200 characters.
* `wake_ms` asks to be called again after that long (50 ms to a day): a module that keeps time asks for the next minute and
  needs no `tick`. The last one asked for is the one kept.
* `quiet` asks the other plugins to hold their peace while something fills the screen; `ambient` banners and pills wait for it.
* `media` presses a button of the player (the plugin must have `media_control`): `{ "action": "play_pause" | "next" | "previous" | "focus" | "seek" | "seek_by" | "set_rate", "source", "value" }`.
* `run` asks for commands (`[{ "id": "branch", "line": ["git", "-C", "C:/proj", "rev-parse", "--abbrev-ref", "HEAD"] }]`, up to 4); each answers with a `command` event. `store` keeps a value (see `permissions.storage`).
* `watch` lists the programs to watch (process ids, up to four; `[]` stops it): each second the module is told what they use, in a `usage` event. `reveal` shows a finished download in its folder (the `path` that an `ended` of the `downloads` event gave).
* `fetch` asks the island for an address (`[{ "id", "method": "GET" | "POST", "url", "headers": {}, "body" }]`, up to 2): only a host of `permissions.net`, over https; a redirect is not followed. The answer is a `fetched` event: `{ "id", "status", "body", "error" }` (a `status` of 0 is a network that did not answer; the body is cut at 256 KB). `open` opens a link now (see `permissions.open`), and `focus` brings a window to the front (`{ "exe": the program's path, "title": a word of its title }`, needs `programs`).
* A pill a module says (`say` with a `pill`) may have a `key` (one with the same key replaces the one that waits), a `tile`, `badges`, a `tone` (`waiting` or `finished`: the glow and an icon at the right) and a `press` (an action the module is called with when it is pressed). `cancel` (`["key"]`) takes such a pill back.
* `cards_more` lists cards after the first (up to 5, each with an `id` of its own); they replace the ones it had. A card and a pill may have an `image` (a `data:` raster, or `"keep"`: the one it had), and a card a `seek` block: a thin bar you can press, which calls the module back with `fraction`.
* A banner (`say`) may have a `title` of its own, an `open` link (see `permissions.open`) that pressing it opens, and a `group`: banners of one app pile up, and too many in a row become one that counts them.

* `widgets` draws the widgets its manifest lists, and `pane` a page. A widget is listed in the manifest
  (`"widgets": [{ "id", "name", "place", "rank", "width", "interactive", "start" }]`) and answered with
  `"widgets": { "<id>": { "blocks": [...], "tip": [...] } }`; it is in the tray of the editor like any widget, and in the head
  from the start unless `"start": false`. A pane is `"pane": { "title", "blocks": [...], "open": true }` (`open` brings it up
  now; `"pane": null` takes it away and the cards are back). Both are made of blocks the island draws: `text` (`kind`: title,
  big, small, muted, note, warn), `bars` (thin stacked bars, `label`, `part`, `color`; wide with the number in a tooltip), `rings` (the same meters as small circles with the label inside), `clock` (`"time"` or `"date"`: the island keeps it ticking, so it costs no call), `bar`,
  `item` (a picture or an icon with a line of words: `{ "item": { "tile", "icon", "text", "sub" } }`; `tile` is a `data:` raster, or `"keep"` for the one it showed last), `icon_button` (a round button, `{ "icon_button": { "icon", "press", "label" } }`: a press is an `action` with `"widget"` and `args == { "id": press }`), `head` (a title with `prev` and `next` buttons and a `press` id), `grid` (up to seven columns: the Calendar's month; its `cells`
  carry `t`, `id`, `state`, `dots`), `rows` (title, sub, time, past) and `buttons` (up to four). A press comes back as an
  `action` event: `action == "widget"` with `args == { "id", "pane_open" }`, or `action == "pane"` with `args == { "id" }`. They go
  with the plugin when it is switched off. A module that wants a month view of the calendar asks for `"calendar_past_days"`
  (up to 90) in its permissions to be told of the events that are over, too.

With the Rust SDK this is `fn handle(ev: &Event) -> Reply` and `plugin!(handle);` (see `time`, `ics-calendar` and `busy-meter` in
[nadi-plugins](https://github.com/Llyme/nadi-plugins)). A module is a function from an event to a reply, so its logic is tested as an
ordinary Rust test. Build with `build.ps1` there (needs `rustup target add wasm32-unknown-unknown`).

What the host does: calls it from one low-priority thread, one event at a time; a call is cut off when it has used its
fuel (the budget); a module that fails five calls in a row is switched off; a banner it says is held to one every few
seconds and not repeated within a minute; its text is cut at 200 characters, a list at 12 rows, bars at 32, rings at 3,
buttons at 6 on a card and 3 on a pill; a picture must be a `data:` raster of 200 KB at most.

## Tiles

The open island shows a grid of **tiles**, squares like a phone's widgets, one for each plugin that has one. A tile is always there
while its plugin is on, whether or not anything is going on, and goes only when the user takes it out. A plugin declares its tile in
its manifest:

```json
"tile": { "name": "Games", "icon": "gamepad", "tint": "#3ea66f", "sizes": ["small", "wide"], "idle": "no game running" }
```

`sizes` are the sizes it can be drawn in (the settings list them small, wide, large), and the first you list is where it starts: `small` (1 × 1), `wide` (a full row) and `large`
(2 × 2). `idle` is what it says while there is no card. `widget` (optional) names a widget of the plugin whose picture is the face of a
wide or large tile with no card (System meters draws its rings). The island has as many columns as fit squares of about 90 px.

A tile has no icon in a corner: the picture behind its words is what it is about. That picture is the card's `image` (the icon of a
program, the cover of what is playing), blown up and frosted, with a dark gradient under the words so any icon reads; a card with none
is the plugin's `tint` with its icon drawn large. At rest the picture goes: plain glass, and the icon large and faint. `"look": "date"`
gives a tile the date as a block (a calendar). A small tile never has words or a number (the tooltip has them): a glance that is a percent is a ring that fills, a card with a `done` caption (or the `finished` tone) is a tick, anything else that is going on is the glyph (or the picture) with a small bar under it that slowly breathes. `"look": "water"` makes a small tile fill up like water (waves on top) as far as the glance's percent (full when done, a third when there is no percent); it is the look of Downloads. `"look": "status"` makes a small tile say what the plugin is up to instead of a number: from the card's `tone`, three dots going up and down for `working`, a knock (the picture shakes and a ring goes out from the tile) for `waiting` on the user, a tick for `finished`. `"picture": "claude-code.gif"` names a picture in the plugin's folder (a png, gif, webp or jpeg of 512 KB at most; a gif moves) that is the face while something is going on and the card has none of its own. A tile with no picture at all is bare: no background, only the words. Selected, the picture sharpens and a ring in its own colour goes round the tile.

The face comes from the plugin's first card. A card may say what its tile says at a glance with `Card::glance(big, caption)` (a big
number or word, and a few words under it: "1" and "needs you"); without it the tile shows the card's title and second line, and a
large tile shows the card's picture and buttons. Pressing a tile takes the place of the notifications under the grid with the
plugin's cards (the same cards, which open and are dragged out to float from there), and pressing it again brings the notifications
back. A plugin with cards and no `tile` still gets one for as long as it has cards. The user arranges the tiles in Settings >
Expanded Island > Tiles, and only there (where each one sits on the grid, its size, and which to take out); `%APPDATA%\NADI\tiles.json` keeps it.

## The resting island

The collapsed island, when nothing else is on it, is always **three sections, left, center and right, with one widget in each**.
The user fills them in Settings > Resting Island (the widgets of every plugin that is on can go in; the eyes in the center until they
choose). A plugin may offer a resting island of its own, for while it has something going on: it says in its manifest which widget
is in each section, and its module says in its reply when it is on.

```json
"widgets": [
  { "id": "song", "name": "Song", "place": "left", "rank": 40, "width": 120, "start": false },
  { "id": "playpause", "name": "Play / pause", "place": "right", "rank": 41, "width": 30, "interactive": true, "start": false }
],
"rests": [
  { "id": "playing", "name": "Now playing", "description": "The song at the left, play and pause at the right.",
    "when": "While something plays", "priority": 60, "left": "song", "center": "", "right": "playpause" }
]
```

`left`, `center` and `right` name a widget of the plugin (`song`) or of another (`eyes:head`); empty is none. `when` is the line
the user reads. A module says which of its islands are on in a reply: `"rest": ["playing"]` (`Reply::rest(&["playing"])`; `[]`
says none; the last said stands). The widgets are the head's (`widgets` with blocks, or a face with `"slot": "widget"`), so what a
module draws for the head is what rests in the island too; `"start": false` keeps one out of the head until the user puts it there.
In a section a widget has the height of the island and a width of a third of it: the head's widgets are made smaller to fit.

An island is **what a plugin's pill became**: a plugin that offers one has no pill. The user may switch it off (Settings > Resting Island), and then nothing shows for the plugin.
While it is on (it is, until they switch it off), the one that is highest in their list wins (they move them up and down; until they do, the higher `priority` of the manifests does); when none is, the user's own island shows. In a bundle, a part's widgets are named by the part (`claude-sessions:needs`), and a part may say that an island of its bundle is on.
They may change what is in any of its sections (the plugin's widgets first, then any other). Banners and pills of other plugins
still come over any resting island.

## Bundles

A plugin that needs both a sensor and the network is a **bundle**: one plugin in the list (one switch, one set of settings, one
mute), made of **parts**, each a module with the permissions of its own. The host keeps them apart: a part that lists `net` sees
nothing of the PC, as any module, so what one part sees cannot be carried out by another (they cannot talk to each other).

```json
{
  "id": "claude", "name": "Claude", "kind": "bundle",
  "settings": { "alerts": { "label": "...", "type": "toggle", "default": true }, "usage": { ... } },
  "actions": [{ "part": "usage", "id": "usage_login", "label": "Sign In" }],
  "widgets": [{ "part": "usage", "id": "bars", "name": "Bars" }],
  "parts": [
    { "id": "sessions", "module": "sessions.wasm", "crate": "claude-code", "permissions": { "claude": true, "processes": true } },
    { "id": "usage", "module": "usage.wasm", "crate": "claude-usage", "permissions": { "net": ["api.anthropic.com"], "storage": true } }
  ]
}
```

A part is called `<plugin>-<part>` (`claude-sessions`) for the island: its cards, pills, rings and widgets are its own, and what it
keeps (`storage`) is its own file. The settings are the bundle's, and every part is told them. An action or a widget names the part
that answers it (`part`; the first when it does not say). `crate` is for the build script of the plugins repository. The list of
permissions the user is shown is what all the parts ask for.

A bundle that takes the place of plugins of the same repository (two that became one) lists them: `"replaces": ["claude-code", "claude-usage"]`.
Installing it, or updating the repository, removes those, and the bundle is on when one of them was.
