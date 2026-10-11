# Plugins

A plugin is a folder with a `manifest.json`. It hands the island data, and the island draws it from a few building
blocks. A plugin never draws pixels, and it cannot reach the network, the audio, your programs or your files unless
its manifest says so and you switch it on (you are shown what it asks to see first).

The island itself is a window manager for cards: the pill, the hub, the banners, the floating cards, the calendar, the eyes and
the sensors (the sound, what is playing, which programs have a window). Everything it shows beyond that comes from a plugin,
and its own features are no exception.

There are three kinds:

* **Declarative**: the manifest names an address to poll (JSON, or a calendar), and the card, the pill, the rings and the banner
  are written as templates over what the address answers. No plugin code runs.
* **Module**: a WebAssembly file for a plugin that needs real logic (audio, games, files, the calendar, what is playing). The
  island calls it with what it may see; it answers with what the island is to do. It has **no network of its own**, only the
  sensors its manifest lists, a time budget for each call, and a memory cap. It is written in any language that makes
  WebAssembly; there is a Rust SDK (`plugins/sdk`) and examples (`plugins/`).
* **Native**: a plugin written in Rust inside the app, for what a sandbox must not hand out: the list of windows with their
  paths, performance counters, other programs' files and logins, the browser extension. See [The native plugins](#the-native-plugins).

A declarative plugin and a module are the same to the island whether they sit in a folder or are carried by the app: the
*Time* and *Calendar* plugins that come with it are two modules. Nothing in the
host knows them by name. They go through the same checks, the same sandbox, the same list, the same switch and the same
question before they are switched on as a plugin you drop in a folder. The difference is only that the app carries them (an
update brings their new version) and that you can switch them off but not delete them.

## What a plugin can do

| | declarative | module | native |
|---|:-:|:-:|:-:|
| a **card** in the hub (and floating) | templates | blocks | blocks, or its own face |
| a **pill** on the collapsed island, while something is going on | templates | `pill` | yes |
| a pill that **comes by itself** for a moment, like the time | | `say` with a `pill` | yes |
| **rings** in the hub, next to CPU and memory | templates | `rings` | yes |
| a **banner** (with a priority; mute and Do not disturb apply) | `attention` | `say` | yes |
| **buttons** that call the plugin back | | `buttons`, `action` events | yes |
| a picture | `image` | `image` | yes |
| **events for the calendar** | `format: "ics"` | `events` | yes |
| read the calendar | | `calendar` | yes |
| see what is playing, press play / next | | `media`, `media_control` | yes |
| see how busy the CPU and memory are | | `system` | yes |
| hear the sound (levels and bands) | | `audio` | yes |
| see which programs have a window | | `processes`, `titles` | yes |
| read a file when it changes | | `files` | yes |
| ask the network | listed hosts | never | yes |
| keep time without being polled | `every` | `wake_in` | yes |
| ask the others to be quiet (a game is on the screen) | | `quiet` | yes |
| a line about how it is doing, in Settings | `status` | `note` | yes |

## Where they live

```
%APPDATA%\NADI\plugins\<id>\manifest.json
```

Settings > Plugins lists them, shows what each one asks to see, has the switches, each plugin's settings, a button to
mute its banners, and **Do not disturb**. A plugin you drop in is **off** until you turn it on, and switching it on
asks first. "Open the plugins folder" opens the folder; "Look again" reads it again. The app puts nothing in the
folder: the examples (a weather card, an audio meter, a game clock, a busy meter) are in the repository, in `plugins/`, with their
source, to read and to copy from. The plugins the app carries are in the same list, above the ones you install.

## What ships with the app

| plugin | kind | what it does | what it looks at |
|---|---|---|---|
| Games | native | the game you are playing, for how long, and how it runs (FPS, GPU, CPU, memory); a pill | which programs fill a screen with no title bar; Windows' own counters |
| Work | native | what you work on: your editor, your hours; a pill for the session you are in | the window in front and its title, how long since you touched the keyboard, git for the open project |
| Page Reader | native | a card in the expanded island for each page you have open (a walkthrough, a post, an article...; a page of no known kind has none) | the browser windows, and what the NADI browser extension sends (never a private window or a blocked site) |
| Downloads | native | what the browsers, Steam and qBittorrent are downloading | partial files in the download folders, the browsers' history, qBittorrent's own files |
| Claude Code | native | your sessions, and a pill when one needs you or has finished; the 5-hour and 7-day limits as two rings in the hub, with a peek | Claude Code's own session files; for the rings, its own sign-in to Claude (kept encrypted for your Windows user; Claude Code's login is never read), and it asks Anthropic and nothing else |
| Eyes | native | the two eyes of the island, a widget of the head (they blink, follow the cursor, squash and stretch, and can bounce to the beat and send out a ripple for each hit of the bass), and the face of the collapsed island | where the cursor is; the sound levels |
| System meters | native | rings in the head for how busy the CPU, the memory and the graphics card are (a widget each) | Windows' own counters |
| Sound light | native | an aura in the island that dances to what plays (with a most-brightness setting: 0 turns it off), and spills a little outside it | the sound levels |
| Now playing | native | what is playing, with play, skip, seek, speed; a pill | what Windows says is playing |
| Notification mirror | native | other apps' notifications on the island | Windows' notification access; Viber's popup |
| Time | module | the time now and then, in a small pill (`plugins/time`) | the clock |
| Calendar | module | brings the events of a calendar link to the island's calendar, a month view that the date in the head opens, the next ones on a card, and a banner shortly before one (`plugins/ics-calendar`) | the one address you give it; the island's calendar |

Each of them can be switched off, and one that is off does nothing: no thread works, no file is read, nothing is asked of Windows
and its card, its pill and its widgets are gone. **A new install starts blank**: every plugin is off, and the expanded island says
so, with a button to the plugin list. An install that has run before keeps what it had: a plugin takes over what the old
settings file said about it the first time it is seen (a game switch that was off stays off; a calendar link that was set
switches Calendar on, and the agenda it used to be next to is part of it now; the CPU and RAM rings stay on).

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
and the GPU (of System meters), two labelled bars for the Claude limits (of Claude Code), and the rings any plugin adds. A plugin
may offer **as many widgets as it likes**: System meters and Claude Code also offer a ring for each number. The ones that
`start` are in the head the first time; the rest wait in the tray of edit mode. Widgets start at the top; the bottom is empty
until you drop a widget there.

* Every widget is shown. When they do not fit in the first row, the head grows another, as many as it takes.
* The center of a row is at its dead center. The two sides share what is left of it, equally, and a side only grows up to that
  half, so the center never moves for a side. A row with nothing in the center has none, and the two sides share the whole row.
* **Edit mode** (the pencil in the settings' tab row) lets you arrange it: drag a widget to the left, center or right of any row
  (it is refused, in red, when there is no room; the rows of the bottom of the island are under the cards), or drag it off the
  island to put it back in the tray. The **tray** lists every widget of the plugins that are on, by plugin: drag one onto a place
  (or press it, and it goes to its own place of the first row). It keeps one height and scrolls inside itself; a group folds
  (the first two start open), a search cuts it down by the widget's or the plugin's name, and "Hide in use" folds away what is
  placed already. Add a row, or Reset (which puts back only the widgets that start in the head). What you arranged is kept in
  `%APPDATA%\NADI\head.json`; a widget that starts, and that a plugin adds later, takes its own place, and one whose plugin is
  off is not drawn.
* A widget may open a **page**: the date opens the month view in place of the cards, and pressing it again brings the cards back.

For a plugin written in Rust (a native one), a widget is `head.register({ id, plugin, name, place, rank, width, start, preview, build })` in its
file in `ui/plugins/` (see `eyes.js`, `system-meters.js` and `calendar.js`): `start: false` keeps it in the tray until the user
places it, and `preview()` gives the still picture its tile shows. A ring is `addRing(key, color, plugin, rank, start)`.
A widget's tooltip is `host.setTip(el, content)`: a string is a headline with its note under it, and anything else is drawn as it is,
an element or a function that makes one each time the tooltip shows (`tipRows(rows, { title, foot })` in `kit.js` makes a table
of labels, numbers, bars and notes, as the bars of System meters and Claude usage do). A
declarative plugin's `rings` (see below) are widgets of the right side already. Widgets for the other kinds of plugin are not
open yet: they are drawn by the island from the blocks the plugin gives.

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
`plugins/busy-meter`).

**A face** (a native plugin's file in `ui/plugins/`) uses `openModal(spec, onResult)` and `askModal(spec)` from `kit.js`; the blocks
are the same, and `checks` too (rows with a tickbox, a tile, badges and a note: the list of plugins in a repository is one).

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
(`{ "kind": "progress", "value": 0.4 }`...), and two more: `bars` (a row of meters) and `buttons`.

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
| `permissions.titles` | ... and the titles of those windows (a browser's title is its page) |
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

A module cannot list `net`: nothing that hears or sees the PC can also reach the network. One exception, which sends nothing out: a
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
{ "event": "processes", "windows": [ { "exe": "endfield.exe", "pid": 4120, "title": "", "front": true } ], ... }
{ "event": "file", "path": "C:/Users/me/x.log", "text": "...", ... }
{ "event": "calendar", "events": [ { "uid": "a", "summary": "Standup", "start_ms": ..., "end_ms": ..., "all_day": false } ], ... }
{ "event": "media", "sessions": [ { "source": "Spotify.exe", "title": "...", "artist": "...", "playing": true, "position": 31, "duration": 214, "can_previous": true, "can_next": true } ], ... }
{ "event": "system", "system": { "cpu": 12.5, "ram": 49.0, "ram_used_gb": 13.6, "ram_total_gb": 27.6 }, ... }
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
* `media` presses a button of the player (the plugin must have `media_control`).

With the Rust SDK this is `fn handle(ev: &Event) -> Reply` and `plugin!(handle);` (see `plugins/time`, `plugins/ics-calendar`,
`plugins/busy-meter`). A module is a function from an event to a reply, so its logic is tested as an ordinary Rust test. Build with
`plugins/build.ps1` (needs `rustup target add wasm32-unknown-unknown`).

What the host does: calls it from one low-priority thread, one event at a time; a call is cut off when it has used its
fuel (the budget); a module that fails five calls in a row is switched off; a banner it says is held to one every few
seconds and not repeated within a minute; its text is cut at 200 characters, a list at 12 rows, bars at 32, rings at 3,
buttons at 6 on a card and 3 on a pill; a picture must be a `data:` raster of 200 KB at most.

## The native plugins

A native plugin is a Rust file in `src-tauri/src/builtin` with its manifest beside it, a line in `builtin/mod.rs`, and, if it
draws anything its own, a file in `ui/plugins` (listed in `ui/plugins/index.js`). It goes through the same host as the others
(the same list, switch, question, settings, mute and Do not disturb), and may do more because it is Rust: it runs
its own threads and reads what a sandbox must not hand out. It reaches the screen the same way, too: a card (rich ones
are drawn by its own file in `ui/plugins`, plain ones are the blocks above), `ctx.offer_pill` for a pill it declared in
`pills`, `ctx.say` for a banner, `ctx.set_quiet`, `plugin_call` from its own face.

```rust
impl Native for Games {
    fn manifest(&self) -> Manifest { manifest_of(include_str!("games.json")) }
    fn start(&self, ctx: &Ctx) { /* spawn threads; each checks ctx.on() */ }
    fn switched(&self, ctx: &Ctx, on: bool) { /* let go of what it holds when it is off */ }
    fn cards(&self, ctx: &Ctx) -> Option<Value> { /* what the hub and the floating cards draw */ }
    fn call(&self, ctx: &Ctx, cmd: &str, args: &Value) -> Result<Value, String> { /* from its own UI file */ }
    fn adopt(&self, old: &Value, default_on: bool) -> Adopted { /* what the old settings file said */ }
}
```

The manifest of a native plugin is the one of any plugin, with `"permissions": { "sees": [{ "name": "use CLI", "detail": "git" }] }`: the permissions are the app's, picked from its list (`src-tauri/src/permissions.rs`: windows, performance, idle time, read files and folders, network, use CLI, notifications, ...), with what it is of when the permission asks (the hosts, the command). What each permission grants is said in the app's words, the same for every plugin that asks for it: a plugin borrows what the app can do, it does not describe it. The names are checked by a test. Besides that it has
`"default_on"`, `"pills": [{ "id", "w", "h", "rank", "brief" }]`, `"actions": [{ "id", "label", "ask", "then" }]` and settings of the type
`choice`.

Why these stay in Rust: *Games*, *Work* and *Page Reader* read the process list with paths and titles and Windows' counters;
*Downloads* and *Claude Code* read other programs' files (and, for the usage rings, ask Anthropic: a module
that sees the PC cannot reach the network, and the plugin that does cannot see it); *Notification mirror* uses Windows'
notification access. *Now playing* shows the same media sensor a module may read, but has a seek bar, a speed menu and the
album art in its face, which the blocks do not have, and the island's eyes follow what is playing.
