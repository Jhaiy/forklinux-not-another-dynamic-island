//! Plugins: a feature that is a folder with a `manifest.json`, not code in the app.
//!
//! The island is a window manager for cards; a plugin hands it data and the core draws it from a few building
//! blocks (progress, bars, list, facts, text, badge, buttons, image). A plugin never draws pixels and never reaches
//! Windows or the network by itself: it says in its manifest what it may see, the user switches it on, and the host
//! enforces it.
//!
//! Two kinds. A declarative plugin names a source (an address that is polled: JSON, or a calendar), and its card, its
//! pill, its rings and its attention rule are written as templates over what the source answers: no plugin code runs.
//! A module plugin is a WebAssembly file that the host calls with events (what is playing, the calendar, which programs
//! are open, a file that changed, a button that was pressed) and that answers with what the island is to do (`Out`: a
//! card, a pill, rings, banners, events for the calendar); it is run by `pluginwasm.rs`, has no network, and is cut off
//! when it is slow.
//!
//! Where they live: `%APPDATA%\NADI\plugins\<id>\manifest.json`. What is switched on, each plugin's settings, who
//! is muted and do not disturb are kept in `%APPDATA%\NADI\plugins.json`. A plugin that was just dropped in is off
//! until the user turns it on.
//!
//! Budgets (so a plugin cannot make the island lag): one request at a time per plugin, a 5 s time limit, at most 1 MB
//! of answer, no redirects, a poll no faster than every second, and polling only while a card could be seen (the hub
//! is open, or a card floats). A request that fails keeps the last good card on screen.

use crate::IslandState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MAX_ANSWER: u64 = 1_000_000;
const MIN_EVERY: Duration = Duration::from_secs(1);
const DEFAULT_EVERY: Duration = Duration::from_secs(30);
const TIME_LIMIT: Duration = Duration::from_secs(5);
const MAX_ROWS: usize = 12;
const MAX_BARS: usize = 32;
const MAX_GRAPH: usize = 120;
const MAX_TEXT: usize = 200;
/// a live card, a pill or a ring goes to the screen at most this often
const LIVE_GAP: Duration = Duration::from_millis(50);

// ------------------------------------------------------------------------------------------------- the manifest

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// "declarative" (this file is all there is) or "wasm" (a module too)
    pub kind: String,
    /// a module plugin: its file, in the plugin's folder
    pub module: String,
    /// a bundle (`"kind": "bundle"`): one plugin in the list, made of modules that each have the permissions of their own. What
    /// sees this PC and what reaches a host are kept apart that way: a part that reaches a host sees nothing of the PC.
    pub parts: Vec<PartSpec>,
    /// plugins of the same repository that this one takes the place of (two plugins that became one): installing it removes them,
    /// and it is on when one of them was
    pub replaces: Vec<String>,
    /// the plugin a part belongs to (set by the host; a part has no folder of its own)
    #[serde(skip)]
    pub parent: String,
    pub permissions: Permissions,
    pub source: Source,
    pub card: CardSpec,
    pub attention: Option<AttentionSpec>,
    /// what the user can set (shown in Settings > Plugins; read by the templates and the module as `settings`)
    pub settings: BTreeMap<String, SettingSpec>,
    /// a module plugin: how often it is called with nothing else to say ("5s"); 0 = only when something happens
    pub tick: String,
    /// a module plugin: its card is sent to the screen as it changes (up to about 20 times a second), for a meter
    pub live: bool,
    pub budget: Budget,
    /// it starts switched on in a new install
    pub default_on: bool,
    /// it says things in banners (so there is something to mute)
    pub banners: bool,
    /// buttons that go in the plugin's settings (a module is told by an `action` event)
    pub actions: Vec<ActionSpec>,
    /// a declarative plugin: the pill it shows while its `when` holds (templates over the data)
    pub pill: Option<PillTpl>,
    /// a declarative plugin: rings in the hub (templates over the data)
    pub rings: Vec<RingTpl>,
    /// a declarative plugin: a line about how it is doing, shown under its name (a template over the data)
    pub status: String,
    /// a declarative plugin: settings that must be filled in before it asks anything, and what to say until then
    pub needs: Vec<String>,
    pub setup: String,
    /// a module plugin: widgets for the head (what they show comes in its replies)
    pub widgets: Vec<WidgetSpec>,
    /// a plugin that draws for itself: scripts that run in frames the island gives them
    pub faces: Vec<FaceSpec>,
    /// resting islands it offers: the three sections of the collapsed island, filled its own way, for when it has something going on
    pub rests: Vec<RestSpec>,
    /// its tile in the open island's grid (a plugin that has cards or something to glance at has one; see tiles.rs)
    pub tile: Option<TileSpec>,
}

/// A tile that a plugin has in the open island: a square (a phone's widget) that is always there, with what the plugin is doing
/// in it, and the plugin's cards as its page when it is pressed. Its face is drawn from the plugin's first card (the `glance` of
/// it, or its title and its second line), or, with no card, from `idle`.
#[derive(Deserialize, Serialize, Clone, Default, Debug, PartialEq)]
#[serde(default)]
pub struct TileSpec {
    /// the name it goes by (the plugin's, when none)
    pub name: String,
    /// a line icon of the island's
    pub icon: String,
    /// `#rrggbb`: the colour of its icon while something is going on
    pub tint: String,
    /// what it can be drawn as: "small" (1 x 1), "wide" (a full row), "large" (2 x 2); the first is where it starts
    pub sizes: Vec<String>,
    /// what it says while nothing is going on ("nothing playing")
    pub idle: String,
    /// a widget of the plugin whose picture is its face, for a wide or a large tile with no card (the system's rings)
    pub widget: String,
    /// "date": the face has the date as a block (a calendar); none: the plain face
    pub look: String,
    /// a picture in the plugin's folder (a png, gif, webp or jpeg of 512 KB at most): the face of the tile while something is going on, where the card has
    /// no picture of its own (an animated gif moves)
    pub picture: String,
}

/// A resting island that a plugin offers (see rest.rs). The collapsed island always has three sections, one widget in each; a plugin
/// says what goes in them while it has something going on (its module says when, in its reply: `rest`), and the user may change it.
#[derive(Deserialize, Serialize, Clone, Default, Debug, PartialEq)]
#[serde(default)]
pub struct RestSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    /// the line that tells the user when it is on ("While something plays")
    pub when: String,
    /// when two want the island, the higher one wins
    pub priority: i32,
    /// a widget for each section: `widget` of this plugin, or `plugin:widget` of another; empty for none
    pub left: String,
    pub center: String,
    pub right: String,
}

/// A face a plugin brings: a script of its own that draws in a frame the island gives it (see `ui/faces.js`). The frame is
/// sandboxed: no network, no way into the island's page; what reaches it is what the plugin's permissions allow.
#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct FaceSpec {
    pub id: String,
    /// "backdrop" (behind what the island shows, and a little outside it), "island" (over the collapsed island and the
    /// head of the hub), "widget" (a widget of the head) or "card" (a card in the hub)
    pub slot: String,
    /// the script, in the plugin's folder
    pub file: String,
    /// a widget's or a card's name, place ("left", "center", "right"), rank, width and height (logical px)
    pub name: String,
    pub place: String,
    pub rank: i32,
    pub width: f64,
    pub height: f64,
    pub start: Option<bool>,
    /// a widget with no frame of its own: it is a place in the head, and the plugin's `island` face draws there (a frame is a
    /// process of its own: one face for what is drawn over the island, wherever it is)
    pub shared: bool,
}

/// A widget a module offers for the head (see `Reply::widget` in the SDK): the island lists it in the tray of edit mode and
/// draws what the module sends for it, as blocks.
#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(default)]
pub struct WidgetSpec {
    /// the part of a bundle that draws it (empty: the first)
    pub part: String,
    pub id: String,
    pub name: String,
    /// "left", "center" or "right"
    pub place: String,
    pub rank: i32,
    /// logical px
    pub width: f64,
    /// it can be pressed: the module is told by an `action` event, `action == "widget"`, `args == { "id" }`
    pub interactive: bool,
    /// it is in the head as soon as the plugin is on (false: only from the tray)
    pub start: Option<bool>,
}

/// What a module has drawn outside its card: one set of blocks for each of its widgets, and a pane.
#[derive(Default, Clone, PartialEq)]
pub struct Surface {
    pub widgets: serde_json::Map<String, Value>,
    pub pane: Option<Value>,
    /// the resting islands (ids from its manifest) that it says are on now
    pub rest: Vec<String>,
}

/// The pill of a declarative plugin: shown while `when` is true (any text but "", "0" and "false").
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct PillTpl {
    pub when: String,
    pub icon: String,
    pub title: String,
    pub sub: String,
    pub right: String,
    pub progress: String,
    pub rank: i32,
    pub w: f64,
    pub h: f64,
}

/// A ring in the hub (next to the CPU and memory ones) of a declarative plugin.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct RingTpl {
    pub id: String,
    pub color: String,
    /// 0 to 100 (a template that gives a number); a ring with none is not shown
    pub pct: String,
    pub tip: String,
}

/// One module of a bundle: its own file, permissions and budget.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct PartSpec {
    /// a name that is only the part's (letters, digits, `-`): it makes the part's id, `<plugin>-<part>`
    pub id: String,
    pub module: String,
    /// the crate that makes the module, for the build script of the plugins repository
    #[serde(rename = "crate")]
    pub krate: String,
    pub permissions: Permissions,
    pub budget: Budget,
    pub live: bool,
    pub tick: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct ActionSpec {
    /// the part of a bundle that answers it (empty: the first)
    pub part: String,
    pub id: String,
    pub label: String,
    /// the action needs a word from the user (a code to paste): this is what the field asks, and `then` is the call
    /// that takes it (as `{"text": ...}`) once the action itself has run
    pub ask: String,
    pub then: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct OptionSpec {
    pub value: Value,
    pub label: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct SettingSpec {
    pub label: String,
    /// "text", "number", "toggle", "choice" or "range"
    #[serde(rename = "type")]
    pub kind: String,
    pub default: Value,
    /// "choice": what it is one of
    pub options: Vec<OptionSpec>,
    /// "range": the ends, the step and the unit written after the number
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub unit: String,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Budget {
    /// the time one call into a module may take (default 4 ms, most 20)
    pub call_ms: u64,
    /// the memory a module may have (default 8 MB, most 64)
    pub memory_mb: u64,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Permissions {
    /// hosts a declarative plugin may ask (`host` or `host:port`), and nothing else
    pub net: Vec<String>,
    /// a module may hear what is playing (levels and bands, never the sound)
    pub audio: bool,
    /// a module may see which programs have a window, and which is in front
    pub processes: bool,
    /// ... and the titles of those windows
    pub titles: bool,
    /// a module may read these files when they change (`~` and `%VARIABLES%` are filled in)
    pub files: Vec<String>,
    /// a module may read the events of the island's calendar (whoever brought them)
    pub calendar: bool,
    /// ... and the events that ended this many days ago, too (a month view looks back; 0 is the ones not over yet)
    pub calendar_past_days: u32,
    /// a module may see what is playing (title, artist, position; never the picture)
    pub media: bool,
    /// ... and the cover picture
    pub media_art: bool,
    /// ... and press play, pause, next and previous for it, jump, set the speed, and bring the player to the front
    pub media_control: bool,
    /// a module may read how busy the CPU and the memory are
    pub system: bool,
    /// a face may know where the cursor is (never what it clicks)
    pub cursor: bool,
    /// a module may read what other apps notify (the app, the title and the text of each)
    pub notifications: bool,
    /// a module may know how long it has been since the keyboard or the mouse was used (never what was typed)
    pub idle: bool,
    /// a module may see the full path, the name and the icon of the programs that have a window
    pub programs: bool,
    /// a module may keep a small file of its own (up to 64 KB)
    pub storage: bool,
    /// a module may watch up to four programs (by the `watch` of its reply) and be told what each uses: CPU, memory, graphics,
    /// video memory, frames per second
    pub usage: bool,
    /// a module may be told what the browsers, Steam and qBittorrent are downloading (names and progress), and have a finished
    /// one shown in its folder
    pub downloads: bool,
    /// a module may be told what the Claude Code sessions on this PC are doing (their titles, folders, prompts and tool calls)
    pub claude: bool,
    /// a module may be told what the pages open in the browsers are (through the NADI browser extension), and have a button pressed
    /// or a tab sent to another page of its site
    pub browser: bool,
    /// command lines a module may have run, each as its manifest writes it (`git -C * status`: `*` is one argument it picks)
    pub run: Vec<String>,
    /// a module may have a banner open a link that starts with one of these (`viber://`, `https://discord.com/`)
    pub open: Vec<String>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Source {
    pub http: String,
    /// "2s", "500ms", "15m"
    pub every: String,
    /// where in the answer the data is (dotted), when it is not the whole answer
    pub pick: String,
    /// "visible" (the default: only while a card could be seen) or "always"
    pub when: String,
    /// what the address answers: "json" (the default) or "ics" (a calendar: its events go to the island's calendar)
    pub format: String,
    /// the most the answer may be, in KB (1000 by default, 8000 at most)
    pub max_kb: u64,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct CardSpec {
    pub icon: String,
    /// where the card sits among the others (a lower number comes first; 70 by default)
    pub rank: i32,
    pub title: String,
    pub sub: String,
    /// what the collapsed card says at its right
    pub peek: String,
    pub body: Vec<Value>,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct AttentionSpec {
    /// a list in the data to watch, by the field that tells its items apart (`id`); without `list`, one value
    pub list: String,
    pub id: String,
    pub field: String,
    /// the field reached this number (a progress that got to 1)
    pub reaches: Option<f64>,
    /// the field became this text
    pub becomes: Option<String>,
    pub priority: i32,
    pub banner: String,
}

// ------------------------------------------------------------------------------------------------ what it draws

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Block {
    Progress { value: f64 },
    /// a row of meters, each 0 to 1 (a level, the bands of a sound)
    Bars { values: Vec<f64> },
    /// a paragraph; with a `label` it opens with that in bold ("Prompt")
    Text {
        text: String,
        #[serde(default)]
        label: String,
    },
    Badge { text: String },
    /// rows with a line icon and a short text; the one that is `now` is lit (what a session is doing, and what it did)
    Lines { rows: Vec<Line> },
    /// a label, a bar, and what it says (`color` is `#rrggbb`)
    Meter { label: String, value: f64, text: String, color: String },
    /// a few numbers, each with its name under it
    Stats { items: Vec<Stat> },
    /// a picture the browser extension sent (a page's main picture), by its id: the island fetches it itself (only for a plugin
    /// that may see the browser)
    Picture { id: u64 },
    /// a guide laid out to be read, by its key (see `browsersensor`): the island fetches the words itself and draws the contents,
    /// a search, the size of the text, and the buttons to the sections before and after (they call the plugin back with `go`).
    /// `image` is the page's main picture, which the reader places beside the text.
    Reader {
        key: String,
        #[serde(default)]
        image: Option<u64>,
    },
    Facts { rows: Vec<(String, String)> },
    List { rows: Vec<Row> },
    /// buttons: each one calls the plugin back (`action`)
    Buttons { items: Vec<Button> },
    /// a picture (a `data:` address of a png, jpeg, webp or gif; nothing else is drawn)
    Image { src: String },
    /// a thin bar you can press: `value` is how far (0 to 1), and a press calls the plugin back (`action`, with the
    /// place pressed as `fraction`, 0 to 1)
    /// `before` and `after` are buttons at its sides (the player's jump back and forward, its speed)
    Seek {
        value: f64,
        action: String,
        #[serde(default)]
        before: Vec<Button>,
        #[serde(default)]
        after: Vec<Button>,
    },
    /// a line through numbers, oldest first (frame times, a speed): drawn from `0` to `max`, with a faint line at each of `marks`
    Graph { values: Vec<f64>, max: f64, marks: Vec<f64> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Line {
    pub icon: String,
    pub text: String,
    pub now: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Stat {
    pub value: String,
    pub label: String,
}

/// A tile of a letter or a word in a colour, with a ring around it (how full something is): what a card, a pill or a brief
/// shows in place of an icon.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Tile {
    /// one or two letters
    pub text: String,
    /// `#rrggbb`
    pub color: String,
    /// 0 to 1: how far the ring goes round (none: no ring)
    pub ring: Option<f64>,
    /// `#rrggbb`
    pub ring_color: String,
}

/// A small icon at the right of a header, with what it says when hovered.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Badge {
    pub icon: String,
    pub tip: String,
}

/// A row of a pill that shows how far something is: a label, a bar and its number. The bar moves when the number does.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct PillRow {
    pub label: String,
    /// 0 to 1
    pub value: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Row {
    pub title: String,
    pub sub: String,
    pub progress: Option<f64>,
}

/// A button on a card or a pill. Pressing it tells the plugin (an `action` event for a module).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Button {
    pub label: String,
    /// one of the island's line icons (shown instead of the label when there is one; the label stays as its tooltip)
    pub icon: String,
    pub action: String,
}

/// What the island lists for a plugin.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct CardOut {
    pub plugin: String,
    /// which of the plugin's cards (a plugin may have several: its first has none)
    pub id: String,
    pub name: String,
    pub icon: String,
    /// where the card sits among the others (a lower number comes first)
    pub rank: i32,
    pub title: String,
    pub sub: String,
    pub peek: String,
    /// a picture for the card's tile (a `data:` raster), or "keep": the one it had
    pub image: String,
    /// buttons in the header, at the right (a player's previous, play and next): up to 3
    pub controls: Vec<Button>,
    /// a letter in a colour, with a ring, in place of the icon
    pub tile: Option<Tile>,
    /// a line icon before the second line (what it is doing)
    pub sub_icon: String,
    /// how it stands: "", "waiting" (it needs you), "working", "finished" or "idle". The card is marked for it, and its icon is at the right.
    pub tone: String,
    /// small icons at the right of the header
    pub badges: Vec<Badge>,
    /// an action the plugin is called with when the card's icon is pressed (go to the thing the card is about)
    pub focus: String,
    /// what its tile says at a glance: a big word or number and a few words under it
    pub glance: Option<Glance>,
    pub body: Vec<Block>,
}

/// What a card's tile says at a glance ("1" and "needs you", "144" and "fps").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Glance {
    pub big: String,
    pub caption: String,
}

/// The pill a plugin offers while something is going on (what is playing, a game, a timer). The collapsed island shows
/// the highest `rank` of what the plugins offer, unless a banner or the hub has it. It is the plugin's to take back.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct PillOut {
    pub plugin: String,
    pub name: String,
    /// a line icon
    pub icon: String,
    /// a picture for the pill's tile (a `data:` raster), or "keep": the one it had
    pub image: String,
    pub title: String,
    pub sub: String,
    /// a short text at the right (a time, a count)
    pub right: String,
    /// a thin bar under the text, 0 to 1
    pub progress: Option<f64>,
    /// a row of meters at the right, each 0 to 1
    pub bars: Vec<f64>,
    pub buttons: Vec<Button>,
    /// who wins when several plugins offer a pill (0 to 99; the island's own views are in between)
    pub rank: i32,
    /// the size at the standard width (260): 200 to 360 wide, 32 to 72 high
    pub w: f64,
    pub h: f64,
    /// "" or "big" (large light digits, as the time is shown)
    pub look: String,
    /// it comes by itself and is looked at, like a banner: the island drops down for it, and it can outrank the others (up to 100)
    pub brief: bool,
    /// rows of a label, a bar and a number (a limit that moved), in place of the text
    pub rows: Vec<PillRow>,
    pub tile: Option<Tile>,
}

/// A ring a plugin adds to the hub's top right.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct RingOut {
    pub id: String,
    /// 0 to 100
    pub pct: f64,
    pub tip: String,
    /// `#rrggbb`
    pub color: String,
    /// it is in the head as soon as it shows (false: only from the tray of edit mode)
    #[serde(default = "yes")]
    pub start: bool,
}

fn yes() -> bool {
    true
}

// -------------------------------------------------------------------------------------------------- templates

/// Look a dotted path up (`a.b.0.c`).
fn lookup<'a>(ctx: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = ctx;
    for seg in path.split('.').map(str::trim).filter(|s| !s.is_empty()) {
        cur = match cur {
            Value::Object(m) => m.get(seg)?,
            Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(*b as u8 as f64),
        _ => None,
    }
}

fn fmt_num(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    let s = format!("{:.2}", n);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn text_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(fmt_num).unwrap_or_default(),
        Value::Array(a) => a.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Object(_) => String::new(),
    }
}

fn operand(s: &str, ctx: &Value) -> Value {
    let s = s.trim();
    if let Ok(n) = s.parse::<f64>() {
        return json!(n);
    }
    if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        return Value::String(s[1..s.len() - 1].to_string());
    }
    lookup(ctx, s).cloned().unwrap_or(Value::Null)
}

/// One operator between two operands (`position / duration`), or just an operand.
fn arith(s: &str, ctx: &Value) -> Value {
    for op in [" + ", " - ", " * ", " / "] {
        if let Some(i) = s.find(op) {
            let (l, r) = (num(&operand(&s[..i], ctx)), num(&operand(&s[i + op.len()..], ctx)));
            return match (l, r) {
                (Some(a), Some(b)) => {
                    let v = match op.trim() {
                        "+" => a + b,
                        "-" => a - b,
                        "*" => a * b,
                        _ => {
                            if b == 0.0 {
                                return Value::Null;
                            }
                            a / b
                        }
                    };
                    json!(v)
                }
                _ => Value::Null,
            };
        }
    }
    operand(s, ctx)
}

fn bytes_text(n: f64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n.max(0.0);
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 || v >= 100.0 {
        format!("{:.0} {}", v, units[i])
    } else {
        format!("{:.1} {}", v, units[i])
    }
}

fn duration_text(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    match (s / 3600, (s % 3600) / 60) {
        (0, 0) => format!("{s}s"),
        (0, m) => format!("{m}m"),
        (h, m) => format!("{h}h {m}m"),
    }
}

fn filter(spec: &str, v: Value) -> Value {
    let (name, arg) = match spec.split_once(':') {
        Some((n, a)) => (n.trim(), a.trim().trim_matches(|c| c == '"' || c == '\'')),
        None => (spec.trim(), ""),
    };
    match name {
        "percent" => num(&v).map(|n| Value::String(format!("{}%", (n * 100.0).round() as i64))).unwrap_or(Value::Null),
        "round" => {
            let d: i32 = arg.parse().unwrap_or(0);
            num(&v).map(|n| json!((n * 10f64.powi(d)).round() / 10f64.powi(d))).unwrap_or(Value::Null)
        }
        "bytes" => num(&v).map(|n| Value::String(bytes_text(n))).unwrap_or(Value::Null),
        "speed" => num(&v).map(|n| Value::String(format!("{}/s", bytes_text(n)))).unwrap_or(Value::Null),
        "duration" => num(&v).map(|n| Value::String(duration_text(n))).unwrap_or(Value::Null),
        "upper" => Value::String(text_of(&v).to_uppercase()),
        "lower" => Value::String(text_of(&v).to_lowercase()),
        "trim" => Value::String(text_of(&v).trim().to_string()),
        "len" => match &v {
            Value::Array(a) => json!(a.len()),
            other => json!(text_of(other).chars().count()),
        },
        "join" => match &v {
            Value::Array(a) => Value::String(a.iter().map(text_of).collect::<Vec<_>>().join(if arg.is_empty() { ", " } else { arg })),
            other => other.clone(),
        },
        "truncate" => {
            let n: usize = arg.parse().unwrap_or(40);
            let t = text_of(&v);
            if t.chars().count() > n {
                Value::String(t.chars().take(n.saturating_sub(1)).collect::<String>() + "…")
            } else {
                Value::String(t)
            }
        }
        "default" => {
            if matches!(v, Value::Null) || text_of(&v).is_empty() {
                Value::String(arg.to_string())
            } else {
                v
            }
        }
        _ => v,
    }
}

/// `path | filter | filter:arg`, or `a / b`.
fn eval(expr: &str, ctx: &Value) -> Value {
    let mut parts = expr.split('|');
    let mut v = arith(parts.next().unwrap_or("").trim(), ctx);
    for f in parts {
        v = filter(f, v);
    }
    v
}

/// A text with `{{expr}}` holes in it.
pub fn render(tpl: &str, ctx: &Value) -> String {
    let mut out = String::new();
    let mut rest = tpl;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i + 2..].find("}}") else {
            out.push_str(&rest[i..]);
            return out;
        };
        out.push_str(&text_of(&eval(&rest[i + 2..i + 2 + j], ctx)));
        rest = &rest[i + 2 + j + 2..];
    }
    out.push_str(rest);
    out
}

/// A template that is only one hole, as the value it has (a number stays a number).
fn value_of(tpl: &str, ctx: &Value) -> Value {
    let t = tpl.trim();
    if t.starts_with("{{") && t.ends_with("}}") && t[2..t.len() - 2].find("{{").is_none() {
        return eval(&t[2..t.len() - 2], ctx);
    }
    Value::String(render(tpl, ctx))
}

// ----------------------------------------------------------------------------------------------------- the card

/// What the templates read: the data picked out of the answer. A list becomes `items`, with `count` and `first`.
fn context_of(root: &Value, pick: &str) -> Value {
    let data = if pick.trim().is_empty() { Some(root) } else { lookup(root, pick) };
    match data {
        Some(Value::Array(a)) => json!({ "items": a, "count": a.len(), "first": a.first().cloned().unwrap_or(Value::Null) }),
        Some(Value::Object(m)) => {
            let mut m = m.clone();
            // (a field named `items` that is a list also gets its count and first, unless the data has them)
            if let Some(Value::Array(a)) = m.get("items").cloned() {
                m.entry("count").or_insert(json!(a.len()));
                m.entry("first").or_insert(a.first().cloned().unwrap_or(Value::Null));
            }
            Value::Object(m)
        }
        Some(other) => json!({ "value": other }),
        None => Value::Null,
    }
}

fn item_ctx(item: &Value, index: usize) -> Value {
    let mut m = match item {
        Value::Object(m) => m.clone(),
        other => {
            let mut m = serde_json::Map::new();
            m.insert("value".into(), other.clone());
            m
        }
    };
    m.insert("index".into(), json!(index + 1));
    Value::Object(m)
}

fn progress_of(v: &Value) -> Option<f64> {
    num(v).map(|n| n.clamp(0.0, 1.0))
}

fn block_of(spec: &Value, ctx: &Value) -> Option<Block> {
    let o = spec.as_object()?;
    if let Some(t) = o.get("progress").and_then(|x| x.as_str()) {
        return Some(Block::Progress { value: progress_of(&value_of(t, ctx))? });
    }
    if let Some(t) = o.get("bars").and_then(|x| x.as_str()) {
        let v = value_of(t, ctx);
        let values: Vec<f64> = v.as_array()?.iter().filter_map(num).map(|n| n.clamp(0.0, 1.0)).take(MAX_BARS).collect();
        return (!values.is_empty()).then_some(Block::Bars { values });
    }
    if let Some(t) = o.get("text").and_then(|x| x.as_str()) {
        let text = render(t, ctx);
        return (!text.trim().is_empty()).then_some(Block::Text { text, label: String::new() });
    }
    if let Some(t) = o.get("badge").and_then(|x| x.as_str()) {
        let text = render(t, ctx);
        return (!text.trim().is_empty()).then_some(Block::Badge { text });
    }
    if let Some(rows) = o.get("facts").and_then(|x| x.as_array()) {
        let rows: Vec<(String, String)> = rows
            .iter()
            .filter_map(|r| {
                let r = r.as_array()?;
                let (k, v) = (r.first()?.as_str()?, r.get(1)?.as_str()?);
                let v = render(v, ctx);
                (!v.trim().is_empty()).then(|| (k.to_string(), v))
            })
            .take(MAX_ROWS)
            .collect();
        return (!rows.is_empty()).then_some(Block::Facts { rows });
    }
    if let Some(t) = o.get("image").and_then(|x| x.as_str()) {
        let src = render(t, ctx);
        return image_ok(&src).then_some(Block::Image { src });
    }
    if let Some(path) = o.get("list").and_then(|x| x.as_str()) {
        let items = lookup(ctx, path)?.as_array()?;
        let row = o.get("row")?.as_object()?;
        let limit = o.get("limit").and_then(|x| x.as_u64()).unwrap_or(6).min(MAX_ROWS as u64) as usize;
        let get = |k: &str| row.get(k).and_then(|x| x.as_str());
        let rows: Vec<Row> = items
            .iter()
            .take(limit)
            .enumerate()
            .map(|(i, it)| {
                let c = item_ctx(it, i);
                Row {
                    title: get("title").map(|t| render(t, &c)).unwrap_or_default(),
                    sub: get("sub").map(|t| render(t, &c)).unwrap_or_default(),
                    progress: get("progress").and_then(|t| progress_of(&value_of(t, &c))),
                }
            })
            .collect();
        return (!rows.is_empty()).then_some(Block::List { rows });
    }
    None
}

const DEFAULT_CARD_RANK: i32 = 70;
const MAX_IMAGE: usize = 200_000;

/// A picture the island will draw: a `data:` address of a raster image, not too big. (Never an address to fetch, never
/// an svg: a plugin cannot make the island ask the network, or run a script.)
fn image_ok(src: &str) -> bool {
    src.len() <= MAX_IMAGE && ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"].iter().any(|p| src.starts_with(p))
}

/// A widget that says its picture is "keep" shows the one it showed last (a picture is sent once, not with every reply).
fn keep_tiles(new: &mut Value, old: Option<&Value>) {
    let was = old.and_then(|o| o.get("blocks")).and_then(|b| b.as_array()).and_then(|a| a.iter().find_map(|b| b.get("item").and_then(|i| i.get("tile")).and_then(|t| t.as_str()))).unwrap_or("").to_string();
    if let Some(blocks) = new.get_mut("blocks").and_then(|b| b.as_array_mut()) {
        for b in blocks {
            if let Some(t) = b.get_mut("item").and_then(|i| i.get_mut("tile")) {
                if t.as_str() == Some("keep") {
                    *t = json!(was);
                }
            }
        }
    }
}

fn cut_text(s: &mut String) {
    if s.chars().count() > MAX_TEXT {
        *s = s.chars().take(MAX_TEXT - 1).collect::<String>() + "…";
    }
}

fn unit(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn card_of(m: &Manifest, ctx: &Value) -> CardOut {
    CardOut {
        plugin: m.id.clone(),
        id: String::new(),
        name: m.name.clone(),
        icon: if m.card.icon.is_empty() { "dot".into() } else { m.card.icon.clone() },
        rank: if m.card.rank == 0 { DEFAULT_CARD_RANK } else { m.card.rank.clamp(1, 100) },
        title: render(&m.card.title, ctx),
        sub: render(&m.card.sub, ctx),
        peek: render(&m.card.peek, ctx),
        image: String::new(),
        controls: Vec::new(),
        tile: None,
        sub_icon: String::new(),
        tone: String::new(),
        badges: Vec::new(),
        focus: String::new(),
        glance: None,
        body: m.card.body.iter().filter_map(|b| block_of(b, ctx)).collect(),
    }
}

/// What a module answered as its card, kept to what the island draws: short texts, a few rows, numbers in range.
pub fn clean_card(m: &Manifest, v: &Value) -> Option<CardOut> {
    let mut c: CardOut = serde_json::from_value(v.clone()).ok()?;
    let cut = cut_text;
    c.plugin = m.id.clone();
    c.name = m.name.clone();
    if c.icon.is_empty() {
        c.icon = "dot".into();
    }
    c.rank = if c.rank == 0 { DEFAULT_CARD_RANK } else { c.rank.clamp(1, 100) };
    for s in [&mut c.icon, &mut c.title, &mut c.sub, &mut c.peek] {
        cut(s);
    }
    if c.image != "keep" && !image_ok(&c.image) {
        c.image.clear();
    }
    clean_buttons(&mut c.controls);
    c.controls.truncate(3);
    clean_tile(&mut c.tile);
    clean_badges(&mut c.badges);
    c.focus.truncate(64);
    c.sub_icon.truncate(24);
    if let Some(g) = c.glance.as_mut() {
        g.big = g.big.chars().take(12).collect();
        g.caption = g.caption.chars().take(40).collect();
    }
    if !matches!(c.tone.as_str(), "waiting" | "working" | "finished" | "idle") {
        c.tone.clear();
    }
    c.body.truncate(8);
    for b in c.body.iter_mut() {
        match b {
            Block::Progress { value } => *value = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 },
            Block::Seek { value, action, before, after } => {
                *value = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
                action.truncate(64);
                clean_buttons(before);
                clean_buttons(after);
                before.truncate(2);
                after.truncate(3);
            }
            Block::Graph { values, max, marks } => {
                values.truncate(MAX_GRAPH);
                for v in values.iter_mut() {
                    *v = if v.is_finite() { v.max(0.0) } else { 0.0 };
                }
                *max = if max.is_finite() && *max > 0.0 { *max } else { values.iter().copied().fold(1.0, f64::max) };
                marks.truncate(4);
                marks.retain(|m| m.is_finite() && *m >= 0.0);
            }
            Block::Bars { values } => {
                values.truncate(MAX_BARS);
                for v in values.iter_mut() {
                    *v = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
                }
            }
            Block::Text { text, label } => {
                cut(text);
                cut(label);
            }
            Block::Badge { text } => cut(text),
            Block::Lines { rows } => {
                rows.truncate(8);
                for r in rows.iter_mut() {
                    cut(&mut r.text);
                    r.icon.truncate(24);
                }
            }
            Block::Meter { label, value, text, color } => {
                cut(label);
                cut(text);
                *value = unit(*value);
                if !hex_ok(color) {
                    *color = String::new();
                }
            }
            Block::Picture { .. } => {}
            Block::Reader { key, .. } => key.retain(|c| c.is_ascii_alphanumeric()),
            Block::Stats { items } => {
                items.truncate(6);
                for s in items.iter_mut() {
                    cut(&mut s.value);
                    cut(&mut s.label);
                }
            }
            Block::Facts { rows } => {
                rows.truncate(MAX_ROWS);
                for (k, v) in rows.iter_mut() {
                    cut(k);
                    cut(v);
                }
            }
            Block::List { rows } => {
                rows.truncate(MAX_ROWS);
                for r in rows.iter_mut() {
                    cut(&mut r.title);
                    cut(&mut r.sub);
                    r.progress = r.progress.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 1.0));
                }
            }
            Block::Buttons { items } => clean_buttons(items),
            Block::Image { src } => {
                if !image_ok(src) {
                    src.clear();
                }
            }
        }
    }
    // (a picture that is not one is left out; what the browser sent is for a plugin that may see the browser)
    c.body.retain(|b| !matches!(b, Block::Image { src } if src.is_empty()));
    c.body.retain(|b| m.permissions.browser || !matches!(b, Block::Picture { .. } | Block::Reader { .. }));
    c.body.retain(|b| !matches!(b, Block::Reader { key, .. } if key.is_empty()));
    c.body.retain(|b| !matches!(b, Block::Buttons { items } if items.is_empty()));
    Some(c)
}

/// `#rrggbb` (a colour goes into a style, so nothing else may)
pub(crate) fn hex_ok(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

pub(crate) fn clean_tile(t: &mut Option<Tile>) {
    if let Some(x) = t.as_mut() {
        x.text = x.text.chars().take(2).collect();
        if !hex_ok(&x.color) {
            x.color = "#9a9aa2".into();
        }
        x.ring = x.ring.filter(|r| r.is_finite()).map(unit);
        if !hex_ok(&x.ring_color) {
            x.ring_color = "#5ac88c".into();
        }
    }
}

pub(crate) fn clean_badges(b: &mut Vec<Badge>) {
    b.truncate(4);
    for x in b.iter_mut() {
        x.icon.truncate(24);
        cut_text(&mut x.tip);
    }
}

fn clean_buttons(items: &mut Vec<Button>) {
    items.retain(|b| !b.action.trim().is_empty() && b.action.len() <= 64);
    items.truncate(6);
    for b in items.iter_mut() {
        cut_text(&mut b.label);
        b.icon.truncate(24);
    }
}

/// What a module answered as its pill, kept to what the island draws.
pub fn clean_pill(m: &Manifest, v: &Value) -> Option<PillOut> {
    let mut p: PillOut = serde_json::from_value(v.clone()).ok()?;
    p.plugin = m.id.clone();
    p.name = m.name.clone();
    for s in [&mut p.icon, &mut p.title, &mut p.sub, &mut p.right] {
        cut_text(s);
    }
    if p.icon.is_empty() {
        p.icon = "dot".into();
    }
    if p.image != "keep" && !image_ok(&p.image) {
        p.image.clear();
    }
    // (below the games and the like, never above a peek that has to be seen)
    p.rank = p.rank.clamp(0, if p.brief { 100 } else { 99 });
    p.rows.truncate(3);
    for r in p.rows.iter_mut() {
        cut_text(&mut r.label);
        cut_text(&mut r.text);
        r.value = unit(r.value);
    }
    clean_tile(&mut p.tile);
    p.w = if p.w > 0.0 { p.w.clamp(200.0, 360.0) } else { 260.0 };
    p.h = if p.h > 0.0 { p.h.clamp(32.0, 72.0) } else if p.sub.is_empty() { 40.0 } else { 48.0 };
    p.progress = p.progress.filter(|x| x.is_finite()).map(unit);
    p.bars.truncate(MAX_BARS);
    for b in p.bars.iter_mut() {
        *b = unit(*b);
    }
    clean_buttons(&mut p.buttons);
    p.buttons.truncate(3);
    if p.look != "big" {
        p.look.clear();
    }
    Some(p)
}

/// What a module answered as its rings (at most three, each with a name of its own).
pub fn clean_rings(v: &Value) -> Vec<RingOut> {
    let mut out: Vec<RingOut> = serde_json::from_value(v.clone()).unwrap_or_default();
    out.retain(|r| valid_id(&r.id));
    out.truncate(3);
    for r in out.iter_mut() {
        r.pct = if r.pct.is_finite() { r.pct.clamp(0.0, 100.0) } else { 0.0 };
        cut_text(&mut r.tip);
        // (a colour is `#rrggbb`: it goes into a style)
        let ok = r.color.len() == 7 && r.color.starts_with('#') && r.color[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !ok {
            r.color = "#9a9aa2".into();
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------- attention

/// What the plugin watches between two answers, so it can say when something happened.
#[derive(Default)]
struct Watch {
    started: bool,
    numbers: HashMap<String, f64>,
    text: Option<String>,
}

/// The banners an answer calls for (the first answer after the plugin was switched on never does).
fn attention(spec: &AttentionSpec, ctx: &Value, watch: &mut Watch) -> Vec<String> {
    let mut out = Vec::new();
    let was = watch.started;
    watch.started = true;
    if !spec.list.is_empty() {
        let Some(items) = lookup(ctx, &spec.list).and_then(|v| v.as_array()) else { return out };
        let mut seen: HashMap<String, f64> = HashMap::new();
        for (i, it) in items.iter().enumerate() {
            let c = item_ctx(it, i);
            let id = lookup(&c, &spec.id).map(text_of).unwrap_or_else(|| i.to_string());
            let Some(now) = lookup(&c, &spec.field).and_then(num) else { continue };
            if was {
                if let (Some(goal), Some(before)) = (spec.reaches, watch.numbers.get(&id)) {
                    if *before < goal && now >= goal {
                        out.push(render(&spec.banner, &c));
                    }
                }
            }
            seen.insert(id, now);
        }
        watch.numbers = seen;
    } else {
        let now = lookup(ctx, &spec.field).map(text_of);
        if was {
            if let (Some(before), Some(now)) = (&watch.text, &now) {
                let arrived = match &spec.becomes {
                    Some(goal) => now == goal && before != goal,
                    None => now != before,
                };
                if arrived {
                    out.push(render(&spec.banner, ctx));
                }
            }
        }
        watch.text = now;
    }
    out
}

// ------------------------------------------------------------------------------------------------------ fetch

pub fn parse_every(s: &str) -> Duration {
    let s = s.trim().to_lowercase();
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(s.len()));
    let Ok(n) = n.parse::<f64>() else { return DEFAULT_EVERY };
    let secs = match unit.trim() {
        "ms" => n / 1000.0,
        "s" | "" => n,
        "m" | "min" => n * 60.0,
        "h" => n * 3600.0,
        _ => return DEFAULT_EVERY,
    };
    Duration::from_secs_f64(secs.max(0.0)).max(MIN_EVERY)
}

/// `host` or `host:port` of an address, lower case.
fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let hp = &rest[..end];
    let hp = hp.rsplit_once('@').map(|x| x.1).unwrap_or(hp);
    (!hp.is_empty()).then(|| hp.to_lowercase())
}

/// The address may be asked: it is on the manifest's list (a listed `host` stands for any port of it), and it is
/// https, or plain http to this PC only.
pub fn allowed(url: &str, net: &[String]) -> Result<(), String> {
    let hp = host_of(url).ok_or("The address is not valid.")?;
    let host = hp.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|x| x.0).unwrap_or(&hp).to_string();
    let local = host == "127.0.0.1" || host == "localhost" || host == "[::1]";
    if !(url.starts_with("https://") || (url.starts_with("http://") && local)) {
        return Err("Only https (or http to this PC) may be asked.".into());
    }
    if net.iter().any(|n| {
        let n = n.trim().to_lowercase();
        n == hp || n == host
    }) {
        Ok(())
    } else {
        Err(format!("{hp} is not on the list of hosts this plugin may ask."))
    }
}

const MAX_REDIRECTS: usize = 3;
/// the longest answer a source may be allowed (`source.max_kb`)
const MAX_ANSWER_CAP: u64 = 8_000_000;
/// a source that is not on this PC is not asked more often than this (it is somebody's server)
const REMOTE_MIN_EVERY: Duration = Duration::from_secs(30);

fn is_local(url: &str) -> bool {
    host_of(url).map_or(false, |hp| {
        let host = hp.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|x| x.0).unwrap_or(&hp).to_string();
        host == "127.0.0.1" || host == "localhost" || host == "[::1]"
    })
}

/// The address a redirect points to (it may be relative).
fn resolve(from: &str, location: &str) -> Option<String> {
    let loc = location.trim();
    if loc.contains("://") {
        return Some(loc.to_string());
    }
    let scheme_end = from.find("://")? + 3;
    let host_end = from[scheme_end..].find('/').map(|i| i + scheme_end).unwrap_or(from.len());
    if let Some(path) = loc.strip_prefix('/') {
        return Some(format!("{}/{}", &from[..host_end], path));
    }
    None
}

/// Ask the address. A redirect is followed (up to three times) only to an address that is on the manifest's list too: it
/// can lead nowhere the plugin could not have gone.
fn fetch_text(m: &Manifest, url: &str, net: &[String]) -> Result<String, String> {
    let limit = if m.source.max_kb == 0 { MAX_ANSWER } else { (m.source.max_kb * 1000).min(MAX_ANSWER_CAP) };
    let timeout = if m.source.format == "ics" { Duration::from_secs(15) } else { TIME_LIMIT };
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(timeout).user_agent("NADI-plugin").build();
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        allowed(&url, net)?;
        let resp = agent.get(&url).call().map_err(|e| match e {
            ureq::Error::Status(c, _) => format!("The server said {c}."),
            ureq::Error::Transport(t) => format!("No answer ({}).", t.kind()),
        })?;
        if (300..400).contains(&resp.status()) {
            let next = resp.header("location").and_then(|l| resolve(&url, l)).ok_or("The server sent the plugin somewhere else, and not to an address it could follow.")?;
            url = next;
            continue;
        }
        let mut text = String::new();
        resp.into_reader().take(limit).read_to_string(&mut text).map_err(|_| "The answer could not be read.".to_string())?;
        return Ok(text);
    }
    Err("Too many redirects.".into())
}

/// What the address answered, as the data the templates read: JSON as it is, or a calendar as its events. A calendar's events
/// also come back as events for the island's calendar.
fn fetch(m: &Manifest, url: &str, net: &[String]) -> Result<(Value, Option<Vec<crate::calendar::CalendarEvent>>), String> {
    let text = fetch_text(m, url, net)?;
    if m.source.format == "ics" {
        let events = crate::formats::parse_ics(&text);
        let data = json!({ "events": events, "items": events, "count": events.len() });
        return Ok((data, Some(events)));
    }
    serde_json::from_str(&text).map(|v| (v, None)).map_err(|_| "The answer is not JSON.".to_string())
}

fn truthy(s: &str) -> bool {
    !matches!(s.trim().to_lowercase().as_str(), "" | "0" | "false" | "null" | "no")
}

/// The pill a declarative plugin shows now, from its `pill` templates (none while `when` does not hold).
fn pill_of(m: &Manifest, tpl: &PillTpl, ctx: &Value) -> Option<PillOut> {
    if !tpl.when.trim().is_empty() && !truthy(&render(&tpl.when, ctx)) {
        return None;
    }
    let raw = PillOut {
        icon: tpl.icon.clone(),
        title: render(&tpl.title, ctx),
        sub: render(&tpl.sub, ctx),
        right: render(&tpl.right, ctx),
        progress: if tpl.progress.trim().is_empty() { None } else { progress_of(&value_of(&tpl.progress, ctx)) },
        rank: tpl.rank,
        w: tpl.w,
        h: tpl.h,
        ..Default::default()
    };
    clean_pill(m, &serde_json::to_value(raw).ok()?)
}

fn rings_of(tpls: &[RingTpl], ctx: &Value) -> Vec<RingOut> {
    let list: Vec<RingOut> = tpls
        .iter()
        .filter_map(|t| {
            let pct = num(&value_of(&t.pct, ctx))?;
            Some(RingOut { id: t.id.clone(), pct, tip: render(&t.tip, ctx), color: t.color.clone(), start: true })
        })
        .collect();
    clean_rings(&serde_json::to_value(list).unwrap_or(Value::Null))
}

// ------------------------------------------------------------------------------------------------------- host

pub struct Plugin {
    pub manifest: Manifest,
    /// the folder it was read from
    pub dir: PathBuf,
    /// why it cannot run (a manifest that is wrong, a module that is missing)
    pub problem: Option<String>,
    card: Mutex<Option<CardOut>>,
    pill: Mutex<Option<PillOut>>,
    rings: Mutex<Vec<RingOut>>,
    surface: Mutex<Surface>,
    /// the picture of its pill that the page was last sent
    image_sent: Mutex<String>,
    /// its cards after the first (see `Out::more`)
    more: Mutex<Vec<CardOut>>,
    /// what the commands it asked for printed, until it is told
    pub results: Mutex<Vec<Value>>,
    error: Mutex<Option<String>>,
    /// a line about how it is doing (a declarative plugin's `status`)
    note: Mutex<Option<String>>,
    due: Mutex<Instant>,
    busy: AtomicBool,
    watch: Mutex<Watch>,
    /// what the module cost: calls made, microseconds spent in them
    pub calls: AtomicU64,
    pub spent_us: AtomicU64,
    /// the last time a live card was sent to the screen
    pub sent: Mutex<Instant>,
    /// what the screen has not been told yet (a pill or rings that changed), and when it was last told
    pub dirty: AtomicBool,
    pub pushed: Mutex<Instant>,
    /// buttons the user pressed, for a module to be told (see `Host::act`)
    pub actions: Mutex<std::collections::VecDeque<(String, Value)>>,
}

/// What is kept between runs: what is on, the settings of each plugin, who is muted, do not disturb.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub(crate) struct Saved {
    pub(crate) on: Vec<String>,
    pub(crate) muted: Vec<String>,
    pub(crate) dnd: bool,
    pub(crate) values: HashMap<String, HashMap<String, Value>>,
    /// the question about the plugins that moved out of the app (Time, Calendar) was answered
    pub(crate) moved_asked: bool,
}

impl Plugin {

    pub(crate) fn new(manifest: Manifest, dir: PathBuf, problem: Option<String>) -> Plugin {
        Plugin {
            manifest,
            dir,
            problem,
            card: Mutex::new(None),
            pill: Mutex::new(None),
            rings: Mutex::new(Vec::new()),
            surface: Mutex::new(Surface::default()),
            image_sent: Mutex::new(String::new()),
            more: Mutex::new(Vec::new()),
            results: Mutex::new(Vec::new()),
            error: Mutex::new(None),
            note: Mutex::new(None),
            due: Mutex::new(Instant::now()),
            busy: AtomicBool::new(false),
            watch: Mutex::new(Watch::default()),
            calls: AtomicU64::new(0),
            spent_us: AtomicU64::new(0),
            sent: Mutex::new(Instant::now()),
            dirty: AtomicBool::new(false),
            pushed: Mutex::new(Instant::now()),
            actions: Mutex::new(Default::default()),
        }
    }

    pub fn set_note(&self, n: Option<String>) {
        *self.note.lock().unwrap() = n;
    }

    pub fn set_error(&self, e: Option<String>) {
        *self.error.lock().unwrap() = e;
    }
}

#[derive(Default)]
pub struct Host {
    pub(crate) plugins: Mutex<Vec<Arc<Plugin>>>,
    pub(crate) saved: Mutex<Saved>,
    loaded: AtomicBool,
    /// the loopback audio, for the plugins that may hear it (see pluginwasm.rs)
    pub audio: crate::pluginwasm::AudioBus,
    /// the pill each plugin offers right now
    pub(crate) offers: Mutex<HashMap<String, Offer>>,
    /// plugins that ask the island to stay out of the way (a game is on the screen)
    pub(crate) quiet: Mutex<std::collections::HashSet<String>>,
    /// the plugins that brought events to the calendar (so they can be taken back when a plugin is switched off)
    cal_sources: Mutex<std::collections::HashSet<String>>,
}

/// A pill a plugin asks for: the island shows the highest one while nothing outranks it (a banner, the hub).
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub id: String,
    pub w: f64,
    pub h: f64,
    pub rank: i32,
    pub brief: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Perm {
    pub name: String,
    /// what it is of: the host, the file, the command
    pub detail: String,
    pub why: String,
}

fn perm(name: &str, detail: impl Into<String>) -> Perm {
    let detail = detail.into();
    Perm { why: crate::permissions::grants(name, &detail).unwrap_or_default(), name: name.into(), detail }
}

/// What a plugin asks for, as the permissions the app knows (and what each grants, in the app's words).
pub fn permissions_of(m: &Manifest) -> Vec<Perm> {
    // (a bundle asks for what its parts ask for, each told: it is one plugin to switch on)
    if m.kind == "bundle" {
        let mut all: Vec<Perm> = Vec::new();
        for part in parts_of(m) {
            for p in permissions_of(&part) {
                if !all.iter().any(|x| x.name == p.name && x.detail == p.detail) {
                    all.push(p);
                }
            }
        }
        return all;
    }
    let mut out: Vec<Perm> = Vec::new();
    for h in &m.permissions.net {
        // (a host that is a setting: it is the address the user gave, under that setting's name)
        let setting = h.strip_prefix("{{settings.").and_then(|r| r.strip_suffix("}}")).map(str::trim).and_then(|k| m.settings.get(k));
        match setting {
            Some(s) => out.push(perm("network", format!("the address you give it (\"{}\")", s.label))),
            None => out.push(perm("network", h.clone())),
        }
    }
    for (on, name) in [
        (m.permissions.calendar, "calendar"),
        (m.permissions.media, "media"),
        (m.permissions.media_art, "media pictures"),
        (m.permissions.media_control, "media control"),
        (m.permissions.system, "system"),
        (m.permissions.audio, "audio"),
        (m.permissions.processes, "processes"),
        (m.permissions.titles, "titles"),
        (m.permissions.cursor, "cursor position"),
        (m.permissions.notifications, "notifications"),
        (m.permissions.idle, "idle time"),
        (m.permissions.programs, "program details"),
        (m.permissions.storage, "storage"),
        (m.permissions.usage, "performance"),
        (m.permissions.downloads, "downloads"),
        (m.permissions.claude, "claude sessions"),
        (m.permissions.browser, "browser extension"),
    ] {
        if on {
            out.push(perm(name, ""));
        }
    }
    for f in &m.permissions.files {
        out.push(perm("read files and folders", f.clone()));
    }
    for o in &m.permissions.open {
        out.push(perm("open links", o.clone()));
    }
    for r in &m.permissions.run {
        out.push(perm("use CLI", r.clone()));
    }
    out
}

#[derive(Serialize)]
pub struct SettingInfo {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Value,
    pub options: Vec<Value>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub unit: String,
}

#[derive(Serialize)]
pub struct ActionSpec2 {
    pub id: String,
    pub label: String,
    pub ask: String,
    pub then: String,
    /// its field has something kept (see `Native::filled`)
    pub filled: bool,
}

#[derive(Serialize)]
pub struct Info {
    /// a part of a bundle: it is not a plugin of the list (the bundle is), but the head and the faces need to know it
    pub hidden: bool,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub kind: String,
    pub enabled: bool,
    pub muted: bool,
    pub permissions: Vec<Perm>,
    pub settings: Vec<SettingInfo>,
    pub actions: Vec<ActionSpec2>,
    /// it can say things in banners: the mute button has something to do
    pub banners: bool,
    /// what the module costs when it runs ("0.4 ms a call")
    pub cost: Option<String>,
    pub error: Option<String>,
    /// a plugin's line about how it is doing ("waiting for the browser extension")
    pub note: Option<String>,
    /// the repository it was installed from, and the version of it ("Llyme/nadi-plugins v1.2.0": see `repo.rs`)
    pub from: Option<String>,
    /// the widgets it offers for the head
    pub widgets: Vec<WidgetSpec>,
    /// the faces it draws with
    pub faces: Vec<FaceSpec>,
    /// the resting islands it offers
    pub rests: Vec<RestSpec>,
    pub tile: Option<TileSpec>,
}

#[derive(Serialize)]
pub struct Listing {
    pub plugins: Vec<Info>,
    pub dnd: bool,
    /// plugins that were on when the app still carried them, and are not here now: (id, name)
    pub moved: Vec<(String, String)>,
}

/// The plugins the app used to carry inside it, and now come from the repository.
pub const MOVED: [(&str, &str); 12] = [("page-reader", "Page Reader"), ("claude", "Claude"), ("games", "Games"), ("downloads", "Downloads"), ("ics-calendar", "Calendar"), ("time", "Time"), ("system-meters", "System meters"), ("sound-light", "Sound light"), ("now-playing", "Now playing"), ("eyes", "Eyes"), ("toasts", "Notification mirror"), ("work", "Work")];

/// Was this plugin on before it left the app? (The usage rings were a part of Claude Code: whoever had that has this too.)
fn was_on(on: &[String], id: &str) -> bool {
    let id = if id == "claude" { "claude-code" } else { id };
    on.iter().any(|x| x == id)
}

pub(crate) fn dir() -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("plugins"))
}

fn state_path() -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("plugins.json"))
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
}

/// The settings a plugin has: what its manifest gives, over which what was saved.
pub(crate) fn values_of(m: &Manifest, saved: &Saved) -> Value {
    let mut out = serde_json::Map::new();
    for (k, spec) in &m.settings {
        out.insert(k.clone(), spec.default.clone());
    }
    if let Some(v) = saved.values.get(if m.parent.is_empty() { &m.id } else { &m.parent }) {
        for (k, val) in v {
            if m.settings.contains_key(k) {
                out.insert(k.clone(), val.clone());
            }
        }
    }
    Value::Object(out)
}

fn with_settings(mut ctx: Value, values: &Value) -> Value {
    match &mut ctx {
        Value::Object(m) => {
            m.insert("settings".into(), values.clone());
            ctx
        }
        _ => json!({ "settings": values }),
    }
}

fn check(m: &Manifest, dir: &std::path::Path) -> Option<String> {
    if !valid_id(&m.id) {
        return Some("The id must be lower case letters, digits, '.', '-' or '_'.".into());
    }
    if m.name.trim().is_empty() {
        return Some("The manifest has no name.".into());
    }
    let sees_the_pc = m.permissions.audio
        || m.permissions.processes
        || m.permissions.titles
        || !m.permissions.files.is_empty()
        || m.permissions.calendar
        || m.permissions.media
        || m.permissions.media_control
        || m.permissions.system
        || m.permissions.cursor
        || m.permissions.notifications
        || m.permissions.idle
        || m.permissions.programs
        || m.permissions.usage
        || m.permissions.downloads
        || m.permissions.claude
        || m.permissions.browser
        || !m.permissions.run.is_empty();
    match m.kind.as_str() {
        "wasm" => {
            let f = m.module.trim();
            if f.is_empty() || f.contains(['/', '\\']) || !f.ends_with(".wasm") {
                return Some("A module plugin names its file (\"module\": \"name.wasm\"), in its own folder.".into());
            }
            if !dir.join(f).is_file() {
                return Some(format!("The module {f} is not in the folder."));
            }
            if let Some(p) = check_faces(m, dir) {
                return Some(p);
            }
            if m.permissions.media_control && !m.permissions.media {
                return Some("To control what is playing, a module must also be allowed to see it (\"media\").".into());
            }
            if brings_a_calendar(m) {
                // (the island reads the link for the module and hands the events to the calendar: the module itself still
                // has no network, and never sees anything but events)
                if m.source.format != "ics" {
                    return Some("A module may name a source only for a calendar (\"format\": \"ics\").".into());
                }
                for k in &m.needs {
                    if !m.settings.contains_key(k) {
                        return Some(format!("\"needs\" names the setting {k}, which the manifest does not have."));
                    }
                }
                let defaults = values_of(m, &Saved::default());
                let probe = render(&m.source.http, &json!({ "settings": defaults }));
                if !m.needs.is_empty() && !probe.contains("://") {
                    return None;
                }
                return allowed(&probe, &net_hosts(m, &defaults)).err();
            }
            if !m.permissions.net.is_empty() && sees_the_pc {
                // (what a module sees stays on this PC: one that reaches a host sees nothing of it, so it has nothing to carry out)
                return Some("A module that reaches the network cannot also see this PC. Split it in two.".into());
            }
            None
        }
        "bundle" => {
            if m.parts.is_empty() {
                return Some("A bundle lists its parts (\"parts\": [...]).".into());
            }
            let mut ids: Vec<&str> = Vec::new();
            for (part, child) in m.parts.iter().zip(parts_of(m)) {
                if part.id.is_empty() || !part.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') || ids.contains(&part.id.as_str()) {
                    return Some("Each part of a bundle has a name of its own (lower case letters, digits, '-').".into());
                }
                ids.push(&part.id);
                // (each part is a module of its own: the one that reaches a host sees nothing of this PC)
                if let Some(p) = check(&child, dir) {
                    return Some(format!("The part {}: {p}", part.id));
                }
            }
            None
        }
        "face" => {
            if m.faces.is_empty() {
                return Some("A face plugin lists its faces (\"faces\": [...]).".into());
            }
            if !m.permissions.net.is_empty() {
                return Some("A face cannot ask the network.".into());
            }
            check_faces(m, dir)
        }
        "declarative" | "" => {
            if sees_the_pc {
                return Some("Only a module can listen to the PC. A declarative plugin asks the network.".into());
            }
            if m.source.http.trim().is_empty() {
                return Some("The manifest names no source.".into());
            }
            if !matches!(m.source.format.as_str(), "" | "json" | "ics") {
                return Some(format!("Unknown source format \"{}\".", m.source.format));
            }
            for k in &m.needs {
                if !m.settings.contains_key(k) {
                    return Some(format!("\"needs\" names the setting {k}, which the manifest does not have."));
                }
            }
            // (a source can hold settings: it is looked at again, filled in, each time it is asked; one that is not
            // filled in yet is waited for, see `needs`)
            let defaults = values_of(m, &Saved::default());
            let probe = render(&m.source.http, &json!({ "settings": defaults }));
            if !m.needs.is_empty() && !probe.contains("://") {
                // (the address is a setting that is not filled in yet)
                return None;
            }
            allowed(&probe, &net_hosts(m, &defaults)).err()
        }
        other => Some(format!("Unknown kind \"{other}\".")),
    }
}

/// The faces a plugin lists: a name each, a slot the island has, and a script that is in its folder.
fn check_faces(m: &Manifest, dir: &std::path::Path) -> Option<String> {
    for f in &m.faces {
        if !valid_id(&f.id) {
            return Some("A face has a name of letters, digits, '.', '-' or '_'.".into());
        }
        if !matches!(f.slot.as_str(), "backdrop" | "island" | "widget" | "card") {
            return Some(format!("The face {} is for a slot the island does not have (\"{}\").", f.id, f.slot));
        }
        let file = f.file.trim();
        if file.is_empty() || file.contains(['/', '\\']) || !file.ends_with(".js") {
            return Some(format!("The face {} names its script (\"file\": \"name.js\"), in the plugin's own folder.", f.id));
        }
        if !dir.join(file).is_file() {
            return Some(format!("The script {file} is not in the folder."));
        }
    }
    None
}

/// A module that names an address: the island reads it (a calendar) and brings the events to the calendar, for the module.
fn brings_a_calendar(m: &Manifest) -> bool {
    m.kind == "wasm" && !m.source.http.trim().is_empty()
}

/// The hosts a plugin may ask: what its manifest lists. An entry may be a template over the settings (`{{settings.url}}`
/// is the address the user pastes: its host is the one allowed); one that comes out empty allows nothing.
pub fn net_hosts(m: &Manifest, values: &Value) -> Vec<String> {
    let ctx = json!({ "settings": values });
    m.permissions
        .net
        .iter()
        .filter_map(|n| {
            if !n.contains("{{") {
                return Some(n.clone());
            }
            let t = render(n, &ctx);
            let t = t.trim();
            if t.is_empty() {
                None
            } else if t.contains("://") {
                host_of(t)
            } else {
                Some(t.to_lowercase())
            }
        })
        .collect()
}

/// A plugin's folder, read and checked as it is when the app looks at its plugins folder (a folder of a repository that is
/// being looked at, see `repo.rs`): its manifest, and what is wrong with it.
pub(crate) fn inspect(folder: &std::path::Path) -> Option<(Manifest, Option<String>)> {
    let p = read_one(&folder.join("manifest.json"))?;
    Some((p.manifest, p.problem))
}

/// The parts of a bundle, each as the module plugin it is for the host: the bundle's name, settings and switch, its own file,
/// permissions, widgets and actions. They are not listed; the head, the cards and the sensors know them by their ids.
pub(crate) fn parts_of(m: &Manifest) -> Vec<Manifest> {
    let first = m.parts.first().map(|p| p.id.clone()).unwrap_or_default();
    m.parts
        .iter()
        .map(|p| Manifest {
            id: format!("{}-{}", m.id, p.id),
            name: m.name.clone(),
            description: m.description.clone(),
            version: m.version.clone(),
            kind: "wasm".into(),
            module: p.module.clone(),
            permissions: p.permissions.clone(),
            budget: p.budget.clone(),
            live: p.live,
            tick: p.tick.clone(),
            source: Source { when: "always".into(), ..Default::default() },
            settings: m.settings.clone(),
            banners: true,
            widgets: m.widgets.iter().filter(|w| w.part == p.id || (w.part.is_empty() && p.id == first)).cloned().collect(),
            actions: m.actions.iter().filter(|a| a.part == p.id || (a.part.is_empty() && p.id == first)).cloned().collect(),
            // (the islands are the bundle's, and a part may say that one is on: the replies are checked against them)
            rests: m.rests.clone(),
            parent: m.id.clone(),
            ..Default::default()
        })
        .collect()
}

/// A plugin's folder, read: the plugin, and the parts it is made of when it is a bundle.
fn read_all(path: &std::path::Path) -> Vec<Plugin> {
    let Some(p) = read_one(path) else { return Vec::new() };
    let parts: Vec<Plugin> = if p.problem.is_none() && p.manifest.kind == "bundle" { parts_of(&p.manifest).into_iter().map(|m| Plugin::new(m, p.dir.clone(), None)).collect() } else { Vec::new() };
    let mut out = vec![p];
    out.extend(parts);
    out
}

fn read_one(path: &std::path::Path) -> Option<Plugin> {
    let text = std::fs::read_to_string(path).ok()?;
    let folder = path.parent()?;
    let fallback = folder.file_name()?.to_string_lossy().to_string();
    let (manifest, problem) = match serde_json::from_str::<Manifest>(&text) {
        Ok(mut m) => {
            if m.id.is_empty() {
                m.id = fallback;
            }
            let p = check(&m, folder);
            (m, p)
        }
        Err(e) => (Manifest { id: fallback.clone(), name: fallback, ..Default::default() }, Some(format!("The manifest is not valid: {e}."))),
    };
    Some(Plugin::new(manifest, folder.to_path_buf(), problem))
}

impl Host {
    /// Read the plugins folder and what is switched on.
    pub fn rescan(&self) {
        let Some(root) = dir() else { return };
        if !self.loaded.swap(true, Ordering::Relaxed) {
            if let Some(text) = state_path().and_then(|p| std::fs::read_to_string(p).ok()) {
                // (the first version kept only the list of what is on)
                if let Ok(s) = serde_json::from_str::<Saved>(&text) {
                    *self.saved.lock().unwrap() = s;
                } else if let Ok(list) = serde_json::from_str::<Vec<String>>(&text) {
                    self.saved.lock().unwrap().on = list;
                }
            }
        }
        let mut all: Vec<Arc<Plugin>> = Vec::new();
        let mut found: Vec<Arc<Plugin>> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let read = read_all(&e.path().join("manifest.json"));
                // (a plugin and its parts come in together, or not at all: one with an id that is taken waits)
                if !read.is_empty() && !read.iter().any(|r| found.iter().any(|x| x.manifest.id == r.manifest.id)) {
                    found.extend(read.into_iter().map(Arc::new));
                }
            }
        }
        found.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
        all.extend(found);
        // (a plugin that is still there keeps what it has drawn)
        {
            let old = self.plugins.lock().unwrap();
            for p in all.iter() {
                if let Some(o) = old.iter().find(|o| o.manifest.id == p.manifest.id) {
                    if o.manifest.source.http == p.manifest.source.http && o.manifest.module == p.manifest.module {
                        *p.card.lock().unwrap() = o.card.lock().unwrap().clone();
                        *p.more.lock().unwrap() = o.more.lock().unwrap().clone();
                        *p.pill.lock().unwrap() = o.pill.lock().unwrap().clone();
                        *p.rings.lock().unwrap() = o.rings.lock().unwrap().clone();
                        *p.surface.lock().unwrap() = o.surface.lock().unwrap().clone();
                        *p.note.lock().unwrap() = o.note.lock().unwrap().clone();
                    }
                }
            }
        }
        *self.plugins.lock().unwrap() = all;
        // (what a plugin offered that is gone is gone with it)
        let ids: Vec<String> = self.plugins.lock().unwrap().iter().map(|p| p.manifest.id.clone()).collect();
        self.offers.lock().unwrap().retain(|id, _| ids.contains(id));
    }

    pub(crate) fn save(&self) {
        let Some(p) = state_path() else { return };
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Ok(t) = serde_json::to_string_pretty(&*self.saved.lock().unwrap()) {
            let _ = std::fs::write(p, t);
        }
    }

    pub(crate) fn reset(p: &Plugin) {
        *p.card.lock().unwrap() = None;
        p.more.lock().unwrap().clear();
        *p.pill.lock().unwrap() = None;
        p.rings.lock().unwrap().clear();
        *p.note.lock().unwrap() = None;
        p.actions.lock().unwrap().clear();
        p.dirty.store(true, Ordering::Relaxed);
        *p.error.lock().unwrap() = None;
        *p.watch.lock().unwrap() = Watch::default();
        *p.due.lock().unwrap() = Instant::now();
        p.calls.store(0, Ordering::Relaxed);
        p.spent_us.store(0, Ordering::Relaxed);
    }

    pub fn set(&self, id: &str, on: bool) {
        {
            let mut s = self.saved.lock().unwrap();
            s.on.retain(|x| x != id);
            if on {
                s.on.push(id.to_string());
            }
        }
        // (on again later it starts over: no stale card, no banner for what happened meanwhile; a bundle's parts with it)
        let mine = |p: &Arc<Plugin>| p.manifest.id == id || p.manifest.parent == id;
        let ids: Vec<String> = self.plugins.lock().unwrap().iter().filter(|p| mine(p)).map(|p| p.manifest.id.clone()).collect();
        for p in self.plugins.lock().unwrap().iter().filter(|p| mine(p)) {
            Self::reset(p);
        }
        self.save();
        if !on {
            for i in &ids {
                self.offers.lock().unwrap().remove(i);
                self.quiet.lock().unwrap().remove(i);
            }
        }
    }

    /// A plugin and, when it is a bundle, its parts: the ids that draw for it.
    pub fn family(&self, id: &str) -> Vec<String> {
        self.plugins.lock().unwrap().iter().filter(|p| p.manifest.id == id || p.manifest.parent == id).map(|p| p.manifest.id.clone()).collect()
    }

    pub fn set_value(&self, id: &str, key: &str, value: Value) {
        let known = self.plugins.lock().unwrap().iter().any(|p| p.manifest.id == id && p.manifest.settings.contains_key(key));
        if !known {
            return;
        }
        self.saved.lock().unwrap().values.entry(id.to_string()).or_default().insert(key.to_string(), value);
        // (the source may hold it: ask again soon)
        for p in self.plugins.lock().unwrap().iter().filter(|p| p.manifest.id == id) {
            *p.due.lock().unwrap() = Instant::now();
        }
        self.save();
    }

    pub fn set_muted(&self, id: &str, muted: bool) {
        {
            let mut s = self.saved.lock().unwrap();
            s.muted.retain(|x| x != id);
            if muted {
                s.muted.push(id.to_string());
            }
        }
        self.save();
    }

    pub fn set_dnd(&self, on: bool) {
        self.saved.lock().unwrap().dnd = on;
        self.save();
    }

    pub(crate) fn is_on(&self, p: &Plugin) -> bool {
        // (a part is on when its bundle is)
        let id = if p.manifest.parent.is_empty() { &p.manifest.id } else { &p.manifest.parent };
        p.problem.is_none() && self.saved.lock().unwrap().on.contains(id)
    }

    /// The settings of a plugin, as its templates and its module read them.
    pub fn values(&self, p: &Plugin) -> Value {
        values_of(&p.manifest, &self.saved.lock().unwrap())
    }

    /// Some module that is on listens to the audio (so the capture has to run).
    /// Some module that is on may see what is playing (so the media sensor keeps a copy of it).
    pub fn needs_media(&self) -> bool {
        self.plugins.lock().unwrap().iter().any(|p| self.is_on(p) && matches!(p.manifest.kind.as_str(), "wasm" | "face") && p.manifest.permissions.media)
    }

    /// Some plugin that is on may read what other apps notify (so the listener has to run).
    pub fn needs_notifications(&self) -> bool {
        self.plugins.lock().unwrap().iter().any(|p| self.is_on(p) && p.manifest.kind == "wasm" && p.manifest.permissions.notifications)
    }

    /// Is this address one that a plugin that is on may have a banner open?
    pub fn may_open(&self, url: &str) -> bool {
        let ok = url.len() <= 300 && !url.chars().any(|c| c.is_control() || c == ' ');
        let low = url.to_lowercase();
        ok && self.plugins.lock().unwrap().iter().any(|p| self.is_on(p) && p.manifest.permissions.open.iter().any(|o| !o.is_empty() && low.starts_with(&o.to_lowercase())))
    }

    /// Some module that is on may see the cover pictures.
    pub fn needs_media_art(&self) -> bool {
        self.plugins.lock().unwrap().iter().any(|p| self.is_on(p) && p.manifest.kind == "wasm" && p.manifest.permissions.media_art)
    }

    pub fn needs_audio(&self) -> bool {
        self.plugins.lock().unwrap().iter().any(|p| self.is_on(p) && matches!(p.manifest.kind.as_str(), "wasm" | "face") && p.manifest.permissions.audio)
    }

    pub fn wasm_plugins(&self) -> Vec<Arc<Plugin>> {
        self.plugins.lock().unwrap().iter().filter(|p| self.is_on(p) && p.manifest.kind == "wasm").cloned().collect()
    }

    /// The resting islands the plugins that are on offer: (the plugin, its name, the island).
    /// The tiles of the plugins that are on: `(plugin id, plugin name, its tile, its folder)`.
    pub fn tiles(&self) -> Vec<(String, String, TileSpec, PathBuf)> {
        let all = self.plugins.lock().unwrap().clone();
        all.iter()
            .filter(|p| self.is_on(p) && p.problem.is_none() && p.manifest.parent.is_empty())
            .filter_map(|p| p.manifest.tile.clone().map(|t| (p.manifest.id.clone(), p.manifest.name.clone(), t, p.dir.clone())))
            .collect()
    }

    pub fn rests(&self) -> Vec<(String, String, RestSpec)> {
        let all = self.plugins.lock().unwrap().clone();
        let mut out = Vec::new();
        for p in all.iter().filter(|p| self.is_on(p) && p.problem.is_none() && p.manifest.parent.is_empty()) {
            for r in &p.manifest.rests {
                if !r.id.is_empty() {
                    out.push((p.manifest.id.clone(), p.manifest.name.clone(), r.clone()));
                }
            }
        }
        out
    }

    /// What the plugins that are on have drawn outside their cards (widgets and panes), for a page that has just opened.
    pub fn surfaces(&self) -> Value {
        let all = self.plugins.lock().unwrap().clone();
        let mut out = serde_json::Map::new();
        for p in all.iter().filter(|p| self.is_on(p)) {
            let s = p.surface.lock().unwrap().clone();
            if !s.widgets.is_empty() || s.pane.is_some() || !s.rest.is_empty() {
                out.insert(p.manifest.id.clone(), json!({ "widgets": s.widgets, "pane": s.pane, "rest": s.rest }));
            }
        }
        Value::Object(out)
    }

    /// A plugin that was switched off draws nothing: its widgets and pane are taken away.
    pub fn clear_surface(&self, app: &AppHandle, id: &str) {
        if let Some(p) = self.plugin(id) {
            if *p.surface.lock().unwrap() != Surface::default() {
                *p.surface.lock().unwrap() = Surface::default();
                let _ = app.emit("plugin-surface", json!({ "plugin": id, "widgets": {}, "pane": null, "rest": [], "open": false }));
            }
        }
    }

    pub fn listing(&self) -> Listing {
        let saved = self.saved.lock().unwrap().clone();
        // (a copy of the list: the notes ask the host about the plugins, which must not find the list locked)
        let all = self.plugins.lock().unwrap().clone();
        let plugins = all
            .iter()
            .map(|p| {
                let m = &p.manifest;
                let vals = values_of(m, &saved);
                let permissions = permissions_of(m);
                let bundle = m.kind == "bundle";
                // (a bundle says for its parts: what they cost, how they do, what went wrong with one)
                let parts: Vec<&Arc<Plugin>> = if bundle { all.iter().filter(|c| c.manifest.parent == m.id).collect() } else { vec![p] };
                let calls: u64 = parts.iter().map(|c| c.calls.load(Ordering::Relaxed)).sum();
                let spent: u64 = parts.iter().map(|c| c.spent_us.load(Ordering::Relaxed)).sum();
                let cost = (calls > 0).then(|| format!("{:.2} ms a call", spent as f64 / calls as f64 / 1000.0));
                let on_id = if m.parent.is_empty() { &m.id } else { &m.parent };
                Info {
                    hidden: !m.parent.is_empty(),
                    id: m.id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    version: m.version.clone(),
                    kind: if m.kind.is_empty() { "declarative".into() } else if bundle { "wasm".into() } else { m.kind.clone() },
                    enabled: saved.on.contains(on_id),
                    muted: saved.muted.contains(&m.id),
                    permissions,
                    settings: m
                        .settings
                        .iter()
                        .map(|(k, s)| SettingInfo {
                            key: k.clone(),
                            label: if s.label.is_empty() { k.clone() } else { s.label.clone() },
                            kind: if s.kind.is_empty() { "text".into() } else { s.kind.clone() },
                            value: vals.get(k).cloned().unwrap_or(Value::Null),
                            options: s.options.iter().map(|o| json!({ "value": o.value, "label": o.label })).collect(),
                            min: s.min,
                            max: s.max,
                            step: s.step,
                            unit: s.unit.clone(),
                        })
                        .collect(),
                    actions: m.actions.iter().map(|a| ActionSpec2 { id: a.id.clone(), label: a.label.clone(), ask: a.ask.clone(), then: a.then.clone(), filled: false }).collect(),
                    banners: m.banners || m.kind == "wasm" || m.attention.is_some(),
                    cost,
                    error: p.problem.clone().or_else(|| parts.iter().find_map(|c| c.error.lock().unwrap().clone())),
                    note: if saved.on.contains(on_id) { parts.iter().find_map(|c| c.note.lock().unwrap().clone()) } else { None },
                    from: crate::repo::source_of(&p.dir),
                    widgets: if bundle { Vec::new() } else { m.widgets.clone() },
                    faces: m.faces.clone(),
                    rests: if bundle { Vec::new() } else { m.rests.clone() },
                    tile: m.tile.clone(),
                }
            })
            .collect();
        let moved = if saved.moved_asked {
            Vec::new()
        } else {
            MOVED.iter().filter(|(id, _)| was_on(&saved.on, id) && !all.iter().any(|p| p.manifest.id == *id)).map(|(id, name)| (id.to_string(), name.to_string())).collect()
        };
        Listing { plugins, dnd: saved.dnd, moved }
    }

    /// The cards of the plugins that are on, in the list's order.
    pub fn cards(&self) -> Vec<CardOut> {
        self.plugins.lock().unwrap().iter().filter(|p| self.is_on(p)).flat_map(|p| p.card.lock().unwrap().clone().into_iter().chain(p.more.lock().unwrap().clone())).collect()
    }

    fn due(&self, seen: bool) -> Vec<Arc<Plugin>> {
        let now = Instant::now();
        self.plugins
            .lock()
            .unwrap()
            .iter()
            .filter(|p| self.is_on(p) && p.manifest.kind != "face" && (p.manifest.kind != "wasm" || brings_a_calendar(&p.manifest)))
            .filter(|p| seen || p.manifest.source.when == "always")
            .filter(|p| *p.due.lock().unwrap() <= now && !p.busy.load(Ordering::Relaxed))
            .cloned()
            .collect()
    }

    /// A banner with what a module said of it: its own title, a link to open, a group.
    fn say_banner(&self, app: &AppHandle, state: &IslandState, p: &Plugin, s: &Say, force: bool) {
        let (muted, dnd) = {
            let sv = self.saved.lock().unwrap();
            (sv.muted.contains(if p.manifest.parent.is_empty() { &p.manifest.id } else { &p.manifest.parent }), sv.dnd)
        };
        if muted && !force {
            return;
        }
        let title = if s.title.is_empty() { p.manifest.name.clone() } else { s.title.clone() };
        let held = dnd && s.priority < 90 && !force;
        let open = (!s.open.is_empty() && !held && self.may_open_for(p, &s.open)).then(|| format!("open:{}", s.open));
        let history = {
            let mut notif = state.notif.lock().unwrap();
            if open.is_some() {
                notif.push_grouped(title, s.text.clone(), open, Some(s.group.clone()).filter(|g| !g.is_empty()));
            } else {
                notif.push_priority(title, s.text.clone(), s.priority.clamp(0, 100), held);
            }
            notif.history()
        };
        let _ = app.emit("notification-history-tick", history);
    }

    /// May this plugin have a banner open this address?
    fn may_open_for(&self, p: &Plugin, url: &str) -> bool {
        let low = url.to_lowercase();
        url.len() <= 300 && !url.chars().any(|c| c.is_control() || c == ' ') && p.manifest.permissions.open.iter().any(|o| !o.is_empty() && low.starts_with(&o.to_lowercase()))
    }

    /// What one answer of a plugin does to the island (see `Out`). `by_user`: it answers a button the user pressed, so what
    /// it says is shown whatever mute, do not disturb and a busy screen say.
    pub fn apply(&self, app: &AppHandle, state: &IslandState, p: &Arc<Plugin>, mut out: Out, by_user: bool) {
        let id = p.manifest.id.clone();
        if let Some(mut card) = out.card {
            if let Some(c) = card.as_mut().filter(|c| c.image == "keep") {
                c.image = p.card.lock().unwrap().as_ref().map(|o| o.image.clone()).unwrap_or_default();
            }
            let changed = *p.card.lock().unwrap() != card;
            *p.card.lock().unwrap() = card.clone();
            // a live card goes to the screen as it changes, not when the screen next asks
            if let (true, true, Some(card)) = (p.manifest.live, changed, card) {
                if p.sent.lock().unwrap().elapsed() >= LIVE_GAP {
                    *p.sent.lock().unwrap() = Instant::now();
                    let _ = app.emit("plugin-frame", &card);
                }
            }
        }
        if let Some(mut pill) = out.pill {
            if let Some(x) = pill.as_mut().filter(|x| x.image == "keep") {
                x.image = p.pill.lock().unwrap().as_ref().map(|o| o.image.clone()).unwrap_or_default();
            }
            if *p.pill.lock().unwrap() != pill {
                *p.pill.lock().unwrap() = pill.clone();
                p.dirty.store(true, Ordering::Relaxed);
            }
            match pill {
                Some(pl) => {
                    // (the page hears what the pill says before the island moves to it)
                    self.flush(app);
                    let o = Offer { id: pill_node(&id), w: pl.w, h: pl.h, rank: pl.rank, brief: pl.brief };
                    self.offers.lock().unwrap().insert(id.clone(), o);
                }
                None => {
                    self.offers.lock().unwrap().remove(&id);
                }
            }
        }
        if let Some(list) = out.more {
            *p.more.lock().unwrap() = list;
        }
        // (commands: each runs on a thread of its own, and its answer is waiting for the module's next call)
        for (rid, line) in out.run {
            let p = p.clone();
            std::thread::spawn(move || {
                let r = crate::pluginrun::run(&rid, &line);
                let mut q = p.results.lock().unwrap();
                q.push(r);
                if q.len() > 16 {
                    q.remove(0);
                }
            });
        }
        // (requests: each goes on a thread of its own, and its answer waits for the module's next call)
        for req in out.fetch {
            let p = p.clone();
            let hosts = p.manifest.permissions.net.clone();
            std::thread::spawn(move || {
                let r = crate::pluginrun::fetch(&hosts, &req);
                let mut q = p.results.lock().unwrap();
                q.push(r);
                if q.len() > 16 {
                    q.remove(0);
                }
            });
        }
        if let Some(url) = out.open {
            if self.may_open_for(p, &url) {
                crate::winutil::open_url(&url);
            }
        }
        if let Some((exe, title)) = out.focus {
            crate::focus::focus_source(exe, title, None);
        }
        if let Some(v) = out.store {
            crate::pluginrun::keep(&id, &v);
        }
        if let Some(modal) = out.modal {
            crate::modal::from_plugin(app, &p.manifest.id, &p.manifest.name, modal);
        }
        if out.widgets.is_some() || out.pane.is_some() || out.rest.is_some() {
            let (mut widgets, mut pane, mut rest) = { let s = p.surface.lock().unwrap(); (s.widgets.clone(), s.pane.clone(), s.rest.clone()) };
            if let Some(r) = out.rest.take() {
                rest = r;
            }
            if let Some(w) = out.widgets {
                for (k, mut v) in w {
                    keep_tiles(&mut v, widgets.get(&k));
                    widgets.insert(k, v);
                }
            }
            let open = out.pane.as_ref().and_then(|x| x.as_ref()).and_then(|x| x.get("open")).and_then(|x| x.as_bool()).unwrap_or(false);
            if let Some(next) = out.pane {
                pane = next;
            }
            let now = Surface { widgets, pane, rest };
            if *p.surface.lock().unwrap() != now || open {
                *p.surface.lock().unwrap() = now.clone();
                let _ = app.emit("plugin-surface", json!({ "plugin": id, "widgets": now.widgets, "pane": now.pane, "rest": now.rest, "open": open }));
            }
        }
        if let Some(rings) = out.rings {
            if *p.rings.lock().unwrap() != rings {
                *p.rings.lock().unwrap() = rings;
                p.dirty.store(true, Ordering::Relaxed);
            }
        }
        // the calendar is the island's; a plugin may bring events to it (`null` takes them away again)
        match out.events {
            Some(Some(events)) => {
                crate::calendar::set_source(app, state, &format!("plugin:{id}"), Ok(events));
                self.track_calendar(&id);
            }
            Some(None) => {
                crate::calendar::drop_source(app, state, &format!("plugin:{id}"));
                self.cal_sources.lock().unwrap().remove(&id);
            }
            None => {}
        }
        if let Some(note) = out.note {
            p.set_note(note);
        }
        if let Some(q) = out.quiet {
            let mut quiet = self.quiet.lock().unwrap();
            if q {
                quiet.insert(id.clone());
            } else {
                quiet.remove(&id);
            }
        }
        if let Some((action, source, value)) = out.media {
            if p.manifest.permissions.media_control {
                let id = Some(source).filter(|s| !s.is_empty());
                match action.as_str() {
                    "play_pause" => crate::media::media_play_pause(id),
                    "next" => crate::media::media_next(id),
                    "previous" => crate::media::media_previous(id),
                    "seek" => crate::media::media_seek(value.max(0.0), id),
                    "seek_by" => crate::media::media_seek_by(value.clamp(-3600.0, 3600.0), id),
                    "set_rate" => {
                        crate::media::media_set_rate(value, id);
                    }
                    "focus" => {
                        crate::focus::focus_source(None, None, id);
                    }
                    _ => {}
                }
            }
        }
        for key in out.cancel {
            state.notif.lock().unwrap().cancel_brief(&format!("plugin:{id}:{key}"));
        }
        for s in out.say {
            // (ambient: only when nothing fills the screen: not over the hub, not while a game is on)
            if s.ambient && !by_user && (state.hub_is_open() || self.quiet()) {
                continue;
            }
            match s.pill {
                None => self.say_banner(app, state, p, &s, by_user),
                Some(pill) => {
                    if !by_user && self.gate(&id, s.priority) != crate::plugincalls::Gate::Open {
                        continue;
                    }
                    let (mut tile, mut badges) = (pill.tile, pill.badges);
                    clean_tile(&mut tile);
                    clean_badges(&mut badges);
                    let brief = crate::notify::Brief {
                        id: if pill.key.is_empty() { format!("plugin:{id}") } else { format!("plugin:{id}:{}", pill.key) },
                        state: "plugin",
                        host_icon: pill.icon,
                        project: pill.right,
                        look: if pill.look == "big" { "big" } else { "" },
                        dwell_ms: pill.ms,
                        plugin: id.clone(),
                        tile,
                        badges,
                        tone: pill.tone,
                        press: pill.press,
                        ..Default::default()
                    };
                    state.notif.lock().unwrap().push_brief_priority(s.text, brief, s.priority.clamp(0, 100));
                }
            }
        }
    }

    pub(crate) fn track_calendar(&self, id: &str) {
        self.cal_sources.lock().unwrap().insert(id.to_string());
    }

    /// What a plugin that is switched off (or gone) left behind is taken away: its events in the calendar.
    pub fn reconcile(&self, app: &AppHandle, state: &IslandState) {
        let stale: Vec<String> = {
            let tracked = self.cal_sources.lock().unwrap();
            tracked.iter().filter(|id| !self.is_on_id(id)).cloned().collect()
        };
        for id in stale {
            crate::calendar::drop_source(app, state, &format!("plugin:{id}"));
            self.cal_sources.lock().unwrap().remove(&id);
        }
    }

    /// Tell the screen what changed in the pills and the rings (at most about 20 times a second for one plugin).
    pub fn flush(&self, app: &AppHandle) {
        let all = self.plugins.lock().unwrap().clone();
        for p in all.iter().filter(|p| p.dirty.load(Ordering::Relaxed)) {
            if p.pushed.lock().unwrap().elapsed() < LIVE_GAP {
                continue;
            }
            *p.pushed.lock().unwrap() = Instant::now();
            p.dirty.store(false, Ordering::Relaxed);
            let on = self.is_on(p);
            let mut pill = if on { p.pill.lock().unwrap().clone() } else { None };
            // (a picture is a lot to send each second: the same one is not sent again, the page keeps it)
            if let Some(pl) = pill.as_mut() {
                let mut sent = p.image_sent.lock().unwrap();
                if !pl.image.is_empty() && *sent == pl.image {
                    pl.image = "keep".into();
                } else {
                    *sent = pl.image.clone();
                }
            } else {
                p.image_sent.lock().unwrap().clear();
            }
            let rings = if on { p.rings.lock().unwrap().clone() } else { Vec::new() };
            let _ = app.emit("plugin-pill", json!({ "plugin": p.manifest.id, "pill": pill }));
            let _ = app.emit("plugin-rings", json!({ "plugin": p.manifest.id, "rings": rings }));
        }
    }

    /// The pills plugins offer now, and the rings they show (for a page that has just opened).
    pub fn pills_and_rings(&self) -> (Vec<PillOut>, serde_json::Map<String, Value>) {
        let all = self.plugins.lock().unwrap().clone();
        let mut pills = Vec::new();
        let mut rings = serde_json::Map::new();
        for p in all.iter().filter(|p| self.is_on(p)) {
            if let Some(pl) = p.pill.lock().unwrap().clone() {
                pills.push(pl);
            }
            let r = p.rings.lock().unwrap().clone();
            if !r.is_empty() {
                rings.insert(p.manifest.id.clone(), serde_json::to_value(r).unwrap_or(Value::Null));
            }
        }
        (pills, rings)
    }

    /// A button the user pressed on a plugin's card or pill: a module is told by an `action` event.
    /// (An action a plugin does not know is ignored by it.)
    pub fn act(&self, id: &str, action: &str, args: Value) -> Result<Value, String> {
        let mut p = self.plugin(id).ok_or_else(|| format!("no plugin {id}"))?;
        if !self.is_on(&p) {
            return Err(format!("{id} is off"));
        }
        // (a bundle: the part that answers the action, by what its manifest says of it; else the first)
        if p.manifest.kind == "bundle" {
            let parts = parts_of(&p.manifest);
            let name = parts.iter().find(|c| c.actions.iter().any(|a| a.id == action || a.then == action)).or(parts.first()).map(|c| c.id.clone());
            p = name.and_then(|n| self.plugin(&n)).ok_or_else(|| format!("{id} has no part to answer"))?;
        }
        if p.manifest.kind == "wasm" {
            let mut q = p.actions.lock().unwrap();
            if q.len() < 16 {
                q.push_back((action.chars().take(64).collect(), args));
            }
            return Ok(Value::Null);
        }
        Err(format!("{id} takes no actions"))
    }
}

// ------------------------------------------------------------------------------------------ what an answer does

/// A banner a plugin says, and the pill it may come with.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Say {
    pub text: String,
    pub priority: i32,
    /// shown as a pill (the text is its title) instead of a banner
    pub pill: Option<SayPill>,
    /// only when nothing fills the screen: not over the hub, not while a game is on
    pub ambient: bool,
    /// the banner's title, when it is not the plugin's name
    pub title: String,
    /// a link that pressing the banner opens (it must start with one the plugin may open)
    pub open: String,
    /// an app whose banners pile up: too many in a row become one that counts them
    pub group: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SayPill {
    pub icon: String,
    /// a short text at its right
    pub right: String,
    /// "" or "big" (large light digits, as the time is shown)
    pub look: String,
    /// how long it stays, ms (0 for the usual)
    pub ms: u64,
    /// a name of its own: a brief with the same key replaces the one that waits, and `cancel` takes it away
    pub key: String,
    pub tile: Option<Tile>,
    pub badges: Vec<Badge>,
    /// "" or "waiting" or "finished" (the glow and the icon at the right)
    pub tone: String,
    /// what pressing it asks of the module (an `action` event)
    pub press: String,
}

/// What one answer of a plugin asks of the island, from a module's reply or from a declarative plugin's data run through
/// its templates. Everything is optional: what an answer does not mention stays as it was.
#[derive(Default)]
pub struct Out {
    pub card: Option<Option<CardOut>>,
    pub pill: Option<Option<PillOut>>,
    pub rings: Option<Vec<RingOut>>,
    pub events: Option<Option<Vec<crate::calendar::CalendarEvent>>>,
    pub say: Vec<Say>,
    pub quiet: Option<bool>,
    /// a line about how the plugin is doing, shown under its name in Settings > Plugins (`Some(None)` takes it away)
    pub note: Option<Option<String>>,
    /// a module wants to be called again after this many ms (it keeps time by it)
    pub wake_ms: Option<u64>,
    /// a button of the player, for a module that may control it: (what, which player, a number for what takes one)
    pub media: Option<(String, String, f64)>,
    /// a window for the plugin (see `modal.rs`): `Some(Null)` closes the one it has open
    pub modal: Option<Value>,
    /// its cards after the first: they replace the ones it had (an empty list takes them away)
    pub more: Option<Vec<CardOut>>,
    /// what its widgets show now, by widget id (only the ones its manifest lists)
    pub widgets: Option<serde_json::Map<String, Value>>,
    /// its pane (a view that replaces the cards): `Some(None)` takes it away
    pub pane: Option<Option<Value>>,
    /// commands to run: (an id of its own, the command line, program first)
    pub run: Vec<(String, Vec<String>)>,
    /// what it keeps (`permissions.storage`)
    pub store: Option<Value>,
    /// the programs it wants to watch (`permissions.usage`): their process ids, up to four
    pub watch: Option<Vec<u32>>,
    /// a file the downloads sensor told it of, to be shown in its folder (`permissions.downloads`)
    pub reveal: Option<String>,
    /// which of its resting islands are on now (its manifest's ids; an empty list: none)
    pub rest: Option<Vec<String>>,
    /// what it asks of the browser extension (`permissions.browser`): `config`, `watch`, `press`, `go`
    pub browser: Option<Value>,
    /// the briefs (by their `key`) that are not needed any more
    pub cancel: Vec<String>,
    /// requests to the hosts its manifest names (`permissions.net`): each answers with a `fetched` event
    pub fetch: Vec<Value>,
    /// a link to open now, one that starts with what `permissions.open` lists
    pub open: Option<String>,
    /// bring a window to the front (`permissions.programs`): (the program's path, a word of its title)
    pub focus: Option<(Option<String>, Option<String>)>,
}

/// the name the page gives a plugin's pill (`#pg-<id>`)
pub fn pill_node(id: &str) -> String {
    format!("pg-{id}")
}

const MAX_WAKE_MS: u64 = 86_400_000;

/// A module's reply, kept to what the island does: short texts, few rows, numbers in range.
pub fn out_of(m: &Manifest, reply: &Value) -> Out {
    let mut out = Out::default();
    let Some(o) = reply.as_object() else { return out };
    if let Some(c) = o.get("card") {
        out.card = if c.is_null() { Some(None) } else { clean_card(m, c).map(Some) };
    }
    if let Some(p) = o.get("pill") {
        out.pill = if p.is_null() { Some(None) } else { clean_pill(m, p).map(Some) };
    }
    if let Some(r) = o.get("rings") {
        out.rings = Some(if r.is_null() { Vec::new() } else { clean_rings(r) });
    }
    if let Some(e) = o.get("events") {
        out.events = Some(if e.is_null() { None } else { Some(crate::calendar::events_from_json(e)) });
    }
    if let Some(say) = o.get("say").and_then(|s| s.as_array()) {
        for s in say.iter().take(3) {
            let text = s.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
            if text.is_empty() || text.chars().count() > MAX_TEXT {
                continue;
            }
            let get = |k: &str| s.get("pill").and_then(|p| p.get(k)).and_then(|v| v.as_str()).unwrap_or("").chars().take(MAX_TEXT).collect::<String>();
            let pill = s.get("pill").filter(|p| p.is_object()).map(|p| SayPill {
                icon: get("icon").chars().take(24).collect(),
                right: get("right"),
                look: get("look"),
                ms: p.get("ms").and_then(|v| v.as_u64()).unwrap_or(0),
                key: p.get("key").and_then(|v| v.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')).take(60).collect(),
                tile: p.get("tile").and_then(|t| serde_json::from_value::<Tile>(t.clone()).ok()),
                badges: p.get("badges").and_then(|b| serde_json::from_value::<Vec<Badge>>(b.clone()).ok()).unwrap_or_default(),
                tone: p.get("tone").and_then(|v| v.as_str()).filter(|t| matches!(*t, "waiting" | "finished")).unwrap_or("").to_string(),
                press: p.get("press").and_then(|v| v.as_str()).unwrap_or("").chars().take(64).collect(),
            });
            out.say.push(Say {
                text,
                priority: s.get("priority").and_then(|x| x.as_i64()).unwrap_or(0).clamp(0, 100) as i32,
                pill,
                ambient: s.get("ambient").and_then(|b| b.as_bool()).unwrap_or(false),
                title: s.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().chars().take(80).collect(),
                open: s.get("open").and_then(|t| t.as_str()).unwrap_or("").trim().chars().take(300).collect(),
                group: s.get("group").and_then(|t| t.as_str()).unwrap_or("").trim().chars().take(40).collect(),
            });
        }
    }
    out.quiet = o.get("quiet").and_then(|b| b.as_bool());
    if let Some(n) = o.get("note") {
        out.note = Some(n.as_str().map(|t| t.trim().chars().take(MAX_TEXT).collect::<String>()).filter(|t| !t.is_empty()));
    }
    if let Some(md) = o.get("modal") {
        out.modal = if md.is_null() { Some(Value::Null) } else { clean_modal(md) };
    }
    if let Some(w) = o.get("widgets").and_then(|w| w.as_object()) {
        let mut map = serde_json::Map::new();
        for (k, v) in w.iter().take(8) {
            if m.widgets.iter().any(|s| &s.id == k) {
                map.insert(k.clone(), json!({ "blocks": clean_blocks(v.get("blocks")), "tip": clean_blocks(v.get("tip")) }));
            }
        }
        out.widgets = Some(map);
    }
    if let Some(r) = o.get("rest").and_then(|r| r.as_array()) {
        // (only the islands its manifest lists)
        out.rest = Some(r.iter().filter_map(|x| x.as_str()).filter(|x| m.rests.iter().any(|s| s.id == *x)).take(8).map(str::to_string).collect());
    }
    if let Some(pane) = o.get("pane") {
        out.pane = Some(pane.as_object().map(|p| {
            let t = |k: &str, n: usize| p.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            json!({ "title": t("title", 60), "blocks": clean_blocks(p.get("blocks")), "open": p.get("open").and_then(|b| b.as_bool()).unwrap_or(false) })
        }));
    }
    if let Some(list) = o.get("cards_more") {
        let mut cards: Vec<CardOut> = Vec::new();
        for (i, c) in list.as_array().map(|a| &a[..a.len().min(7)]).unwrap_or(&[]).iter().enumerate() {
            if let Some(mut card) = clean_card(m, c) {
                // (each has a name of its own: the one it says, or its place in the list)
                let id: String = c.get("id").and_then(|v| v.as_str()).unwrap_or("").chars().filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')).take(24).collect();
                card.id = if id.is_empty() { format!("c{}", i + 1) } else { id };
                cards.push(card);
            }
        }
        out.more = Some(cards);
    }
    if let Some(list) = o.get("run").and_then(|r| r.as_array()) {
        for r in list.iter().take(4) {
            let id: String = r.get("id").and_then(|i| i.as_str()).unwrap_or("").chars().take(40).collect();
            let line: Vec<String> = r.get("line").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if !id.is_empty() && crate::pluginrun::allowed(&m.permissions.run, &line) {
                out.run.push((id, line));
            }
        }
    }
    if m.kind == "wasm" && !m.permissions.net.is_empty() {
        for r in o.get("fetch").and_then(|f| f.as_array()).map(|a| &a[..a.len().min(2)]).unwrap_or(&[]) {
            let url = r.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let id: String = r.get("id").and_then(|i| i.as_str()).unwrap_or("").chars().take(40).collect();
            if !id.is_empty() && crate::pluginrun::net_allows(&m.permissions.net, url) {
                out.fetch.push(json!({ "id": id, "method": r.get("method").cloned().unwrap_or(Value::Null), "url": url, "headers": r.get("headers").cloned().unwrap_or(Value::Null), "body": r.get("body").cloned().unwrap_or(Value::Null) }));
            }
        }
    }
    if m.permissions.browser {
        out.browser = o.get("browser").filter(|b| b.is_object()).map(|b| {
            let s = |v: Option<&Value>, n: usize| v.and_then(|x| x.as_str()).unwrap_or("").chars().take(n).collect::<String>();
            let mut clean = serde_json::Map::new();
            if let Some(c) = b.get("config").filter(|c| c.is_object()) {
                clean.insert("config".into(), c.clone());
            }
            if let Some(w) = b.get("watch").and_then(|w| w.as_array()) {
                let list: Vec<Value> = w.iter().take(8).filter_map(|p| Some(json!([s(p.get(0), 40), s(p.get(1), 300)]))).collect();
                clean.insert("watch".into(), Value::Array(list));
            }
            if let Some(p) = b.get("press").filter(|p| p.is_object()) {
                clean.insert("press".into(), json!({ "id": s(p.get("id"), 40), "browser": s(p.get("browser"), 40), "label": s(p.get("label"), 60) }));
            }
            if let Some(g) = b.get("go").filter(|g| g.is_object()) {
                clean.insert("go".into(), json!({ "id": s(g.get("id"), 40), "browser": s(g.get("browser"), 40), "title": s(g.get("title"), 300), "url": s(g.get("url"), 1000) }));
            }
            Value::Object(clean)
        });
    }
    out.cancel = o.get("cancel").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).take(8).map(|k| k.chars().take(60).collect()).collect()).unwrap_or_default();
    out.open = o.get("open").and_then(|u| u.as_str()).map(|u| u.trim().chars().take(300).collect::<String>()).filter(|u| !u.is_empty());
    if m.permissions.programs {
        if let Some(f) = o.get("focus").and_then(|f| f.as_object()) {
            let s = |k: &str| f.get(k).and_then(|v| v.as_str()).map(|v| v.chars().take(260).collect::<String>()).filter(|v| !v.is_empty());
            out.focus = Some((s("exe"), s("title")));
        }
    }
    if m.permissions.storage {
        out.store = o.get("store").cloned().filter(|v| !v.is_null());
    }
    if m.permissions.usage {
        out.watch = o.get("watch").and_then(|w| w.as_array()).map(|a| a.iter().filter_map(|p| p.as_u64().map(|p| p as u32)).filter(|p| *p != 0).take(4).collect());
    }
    if m.permissions.downloads {
        out.reveal = o.get("reveal").and_then(|r| r.as_str()).map(|r| r.chars().take(520).collect::<String>()).filter(|r| !r.is_empty());
    }
    out.wake_ms = o.get("wake_ms").and_then(|v| v.as_u64()).map(|n| n.clamp(50, MAX_WAKE_MS));
    if let Some(mc) = o.get("media").and_then(|v| v.as_object()) {
        let s = |k: &str| mc.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(200).collect::<String>();
        out.media = Some((s("action"), s("source"), mc.get("value").and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(0.0)));
    }
    out
}

/// The meters of a `bars` or a `rings` block: a label, how much of it (0 to 1), a colour, and words at its side and under it.
fn clean_meters(list: &[Value]) -> Vec<Value> {
    let s = |x: Option<&Value>, n: usize| x.and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    list.iter()
        .take(6)
        .map(|x| {
            let color = s(x.get("color"), 7);
            let ok = color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit());
            json!({ "label": s(x.get("label"), 12), "part": x.get("part").and_then(|p| p.as_f64()).unwrap_or(0.0).clamp(0.0, 1.0), "color": if ok { color } else { "#9a9aa2".to_string() }, "text": s(x.get("text"), 40), "sub": s(x.get("sub"), 60) })
        })
        .collect()
}

/// The blocks of a widget, its tip and a pane, kept to what the island draws: short texts, a few rows, ids a press can name.
/// A block is one of `text`, `clock`, `bar`, `bars`, `rings`, `head`, `grid`, `rows` and `buttons`; any other is left out.
pub fn clean_blocks(v: Option<&Value>) -> Vec<Value> {
    let s = |x: Option<&Value>, n: usize| x.and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    let flag = |x: Option<&Value>| x.and_then(|v| v.as_bool()).unwrap_or(false);
    let one_of = |x: String, list: &[&str]| if list.contains(&x.as_str()) { x } else { String::new() };
    let mut out = Vec::new();
    for b in v.and_then(|b| b.as_array()).map(|a| &a[..a.len().min(24)]).unwrap_or(&[]) {
        let Some(b) = b.as_object() else { continue };
        let one = if b.contains_key("text") {
            json!({ "text": s(b.get("text"), 400), "kind": one_of(s(b.get("kind"), 8), &["title", "big", "small", "muted", "note", "warn"]) })
        } else if b.contains_key("clock") {
            json!({ "clock": one_of(s(b.get("clock"), 8), &["time", "date"]), "h24": flag(b.get("h24")) })
        } else if b.contains_key("bar") {
            json!({ "bar": b.get("bar").and_then(|p| p.as_f64()).unwrap_or(0.0).clamp(0.0, 1.0), "text": s(b.get("text"), 40) })
        } else if let Some(list) = b.get("bars").and_then(|l| l.as_array()) {
            json!({ "bars": clean_meters(list) })
        } else if let Some(list) = b.get("rings").and_then(|l| l.as_array()) {
            // (the same meters, drawn as circles)
            json!({ "rings": clean_meters(list) })
        } else if b.contains_key("head") {
            json!({ "head": s(b.get("head"), 60), "prev": s(b.get("prev"), 40), "next": s(b.get("next"), 40), "press": s(b.get("press"), 40) })
        } else if let Some(g) = b.get("grid").and_then(|g| g.as_object()) {
            let cells: Vec<Value> = g
                .get("cells")
                .and_then(|c| c.as_array())
                .map(|a| {
                    a.iter()
                        .take(49)
                        .map(|c| json!({ "t": s(c.get("t"), 6), "id": s(c.get("id"), 40), "state": one_of(s(c.get("state"), 6), &["today", "sel", "other"]), "sel": flag(c.get("sel")), "dots": c.get("dots").and_then(|d| d.as_u64()).unwrap_or(0).min(3) }))
                        .collect()
                })
                .unwrap_or_default();
            let labels: Vec<Value> = g.get("labels").and_then(|l| l.as_array()).map(|a| a.iter().take(7).map(|l| json!(s(Some(l), 6))).collect()).unwrap_or_default();
            json!({ "grid": { "cols": g.get("cols").and_then(|c| c.as_u64()).unwrap_or(7).clamp(1, 7), "labels": labels, "cells": cells } })
        } else if b.contains_key("rows") {
            let rows: Vec<Value> = b
                .get("rows")
                .and_then(|r| r.as_array())
                .map(|a| a.iter().take(30).map(|r| json!({ "title": s(r.get("title"), 120), "sub": s(r.get("sub"), 120), "time": s(r.get("time"), 40), "past": flag(r.get("past")) })).collect())
                .unwrap_or_default();
            json!({ "rows": rows, "empty": s(b.get("empty"), 200) })
        } else if let Some(i) = b.get("item").and_then(|i| i.as_object()) {
            let tile = s(i.get("tile"), MAX_IMAGE + 40);
            json!({ "item": { "tile": if tile == "keep" || image_ok(&tile) { tile } else { String::new() }, "icon": s(i.get("icon"), 20), "text": s(i.get("text"), 120), "sub": s(i.get("sub"), 120) } })
        } else if let Some(i) = b.get("icon_button").and_then(|i| i.as_object()) {
            json!({ "icon_button": { "icon": s(i.get("icon"), 20), "press": s(i.get("press"), 40), "label": s(i.get("label"), 40) } })
        } else if b.contains_key("buttons") {
            let items: Vec<Value> = b.get("buttons").and_then(|r| r.as_array()).map(|a| a.iter().take(4).map(|x| json!({ "id": s(x.get("id"), 40), "label": s(x.get("label"), 30) })).collect()).unwrap_or_default();
            json!({ "buttons": items })
        } else {
            continue;
        };
        out.push(one);
    }
    out
}

/// A module's modal, kept to what the island draws for it: a few kinds of block, short texts, three buttons. What it cannot
/// say it does not get: who it is (the island puts the plugin's name on the bar), where it is remembered, its icon.
pub fn clean_modal(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let s = |x: Option<&Value>, n: usize| x.and_then(|v| v.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    let mut blocks: Vec<Value> = Vec::new();
    for b in o.get("blocks").and_then(|b| b.as_array()).map(|a| &a[..a.len().min(24)]).unwrap_or(&[]) {
        let Some(b) = b.as_object() else { continue };
        let one = if b.contains_key("text") {
            let kind = s(b.get("kind"), 8);
            json!({ "text": s(b.get("text"), 1200), "kind": if ["title", "muted", "note", "warn"].contains(&kind.as_str()) { kind } else { String::new() } })
        } else if b.contains_key("facts") {
            let items: Vec<Value> = b.get("facts").and_then(|f| f.as_array()).map(|a| a.iter().take(20).map(|f| json!({ "title": s(f.get("title"), 120), "text": s(f.get("text"), 400) })).collect()).unwrap_or_default();
            json!({ "facts": items })
        } else if b.contains_key("field") {
            json!({ "field": s(b.get("field"), 40), "label": s(b.get("label"), 80), "value": s(b.get("value"), 400), "placeholder": s(b.get("placeholder"), 80), "focus": b.get("focus").and_then(|x| x.as_bool()).unwrap_or(false) })
        } else if b.contains_key("choice") {
            let opts: Vec<Value> = b.get("options").and_then(|f| f.as_array()).map(|a| a.iter().take(8).map(|o| json!({ "id": s(o.get("id"), 60), "label": s(o.get("label"), 40) })).collect()).unwrap_or_default();
            json!({ "choice": s(b.get("choice"), 40), "options": opts, "value": s(b.get("value"), 60) })
        } else if b.contains_key("list") {
            let items: Vec<Value> = b.get("items").and_then(|f| f.as_array()).map(|a| a.iter().take(100).map(|i| json!({ "id": s(i.get("id"), 120), "label": s(i.get("label"), 120), "sub": s(i.get("sub"), 120) })).collect()).unwrap_or_default();
            json!({ "list": s(b.get("list"), 40), "items": items, "value": s(b.get("value"), 120) })
        } else if b.contains_key("progress") {
            json!({ "progress": b.get("progress").and_then(|p| p.as_f64()).map(|p| p.clamp(0.0, 1.0)), "text": s(b.get("text"), 200) })
        } else {
            continue;
        };
        blocks.push(one);
    }
    let buttons: Vec<Value> = o
        .get("buttons")
        .and_then(|b| b.as_array())
        .map(|a| {
            a.iter()
                .take(3)
                .filter(|b| b.is_object())
                .map(|b| {
                    let flag = |k: &str| b.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
                    json!({ "id": s(b.get("id"), 40), "label": s(b.get("label"), 40), "primary": flag("primary"), "danger": flag("danger"), "stay": flag("stay") })
                })
                .collect()
        })
        .unwrap_or_default();
    let at = match o.get("at") {
        Some(Value::String(a)) => Value::String(a.chars().take(16).collect()),
        Some(Value::Object(p)) => json!({ "x": p.get("x").and_then(|x| x.as_f64()).unwrap_or(0.5).clamp(0.0, 1.0), "y": p.get("y").and_then(|y| y.as_f64()).unwrap_or(0.5).clamp(0.0, 1.0) }),
        _ => Value::Null,
    };
    Some(json!({
        "title": s(o.get("title"), 80),
        "width": o.get("width").and_then(|w| w.as_f64()).map(|w| w.clamp(280.0, 520.0)),
        "at": at,
        "busy": s(o.get("busy"), 120),
        "blocks": blocks,
        "buttons": buttons,
    }))
}

/// The settings the manifest says must be filled in, and are not.
fn missing(m: &Manifest, values: &Value) -> bool {
    m.needs.iter().any(|k| values.get(k).map_or(true, |v| text_of(v).trim().is_empty()))
}

pub(crate) fn has_card(m: &Manifest) -> bool {
    !(m.card.title.trim().is_empty() && m.card.sub.trim().is_empty() && m.card.body.is_empty())
}

fn poll(p: Arc<Plugin>, app: AppHandle, state: Arc<IslandState>) {
    let m = &p.manifest;
    let values = state.plugins.values(&p);
    let sctx = json!({ "settings": values });
    let mut every = parse_every(&render(&m.source.every, &sctx));
    let id = p.manifest.id.clone();
    if missing(m, &values) {
        // (not set up yet: it asks nothing, and says what is left to do)
        *p.error.lock().unwrap() = None;
        p.set_note(Some(if m.setup.is_empty() { "Fill in its settings below.".to_string() } else { m.setup.clone() }));
        // (a calendar that is switched on and has no link yet is an empty calendar, not a missing one)
        // (a module draws its own card: only the calendar is emptied)
        let own = m.kind != "wasm";
        state.plugins.apply(&app, &state, &p, Out { card: own.then_some(None), pill: own.then_some(None), rings: own.then(Vec::new), events: m.source.format.eq("ics").then_some(Some(Vec::new())), ..Default::default() }, false);
        *p.due.lock().unwrap() = Instant::now() + Duration::from_secs(5);
        p.busy.store(false, Ordering::Relaxed);
        return;
    }
    let url = render(&m.source.http, &sctx);
    if !is_local(&url) {
        every = every.max(REMOTE_MIN_EVERY);
    }
    match fetch(m, &url, &net_hosts(m, &values)) {
        Ok((root, events)) => {
            let ctx = with_settings(context_of(&root, &m.source.pick), &values);
            let mut out = Out::default();
            if has_card(m) {
                out.card = Some(Some(card_of(m, &ctx)));
            }
            if let Some(tpl) = &m.pill {
                out.pill = Some(pill_of(m, tpl, &ctx));
            }
            if !m.rings.is_empty() {
                out.rings = Some(rings_of(&m.rings, &ctx));
            }
            if let Some(events) = events {
                out.events = Some(Some(events));
            }
            *p.error.lock().unwrap() = None;
            p.set_note(if m.status.is_empty() { None } else { Some(render(&m.status, &ctx)) });
            if let Some(spec) = &m.attention {
                let said = attention(spec, &ctx, &mut p.watch.lock().unwrap());
                out.say = said.into_iter().map(|text| Say { text, priority: spec.priority, ..Default::default() }).collect();
            }
            state.plugins.apply(&app, &state, &p, out, false);
        }
        // (the card it had stays; a calendar's month view hears that its source is down)
        Err(e) => {
            if m.source.format == "ics" {
                crate::calendar::set_source(&app, &state, &format!("plugin:{id}"), Err(e.clone()));
                state.plugins.track_calendar(&id);
            }
            *p.error.lock().unwrap() = Some(e);
        }
    }
    *p.due.lock().unwrap() = Instant::now() + every;
    p.busy.store(false, Ordering::Relaxed);
}

/// A card could be seen: the hub is open, the island is showing, or a card floats on the screen.
pub fn card_visible(state: &IslandState) -> bool {
    state.shown.load(Ordering::Relaxed) || state.floats.any()
}

/// The audio capture runs for the plugins that show the sound (the eyes, the sound light) and for a module that listens.
pub fn sync_audio(state: &IslandState) {
    // (whatever plugin hears the sound, a module or a face, is on)
    let want = state.plugins.needs_audio();
    state.audio_enabled.store(want, Ordering::Relaxed);
    state.plugins.audio.wanted.store(state.plugins.needs_audio(), Ordering::Relaxed);
}

pub fn spawn(app: AppHandle, state: Arc<IslandState>) {
    state.plugins.rescan();
    sync_audio(&state);
    crate::pluginwasm::spawn(app.clone(), state.clone());
    std::thread::spawn(move || {
        // background work: never compete with the UI for CPU
        unsafe {
            let _ = windows::Win32::System::Threading::SetThreadPriority(
                windows::Win32::System::Threading::GetCurrentThread(),
                windows::Win32::System::Threading::THREAD_PRIORITY_BELOW_NORMAL,
            );
        }
        loop {
            std::thread::sleep(Duration::from_millis(500));
            state.plugins.reconcile(&app, &state);
            state.plugins.flush(&app);
            for p in state.plugins.due(card_visible(&state)) {
                // one request at a time for a plugin; each runs on its own short-lived thread
                if p.busy.swap(true, Ordering::Relaxed) {
                    continue;
                }
                let (app, state) = (app.clone(), state.clone());
                std::thread::spawn(move || poll(p, app, state));
            }
        }
    });
}

// ----------------------------------------------------------------------------------------------- commands

#[tauri::command]
pub fn plugin_list(window: tauri::WebviewWindow) -> Listing {
    use tauri::Manager;
    window.state::<Arc<IslandState>>().plugins.listing()
}

/// The question about the plugins that moved out of the app was answered. Not installed: what was on is let go (a plugin
/// installed later asks its own question, as any other).
#[tauri::command]
pub fn plugin_moved_done(window: tauri::WebviewWindow, install: bool) {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    {
        let mut s = state.plugins.saved.lock().unwrap();
        s.moved_asked = true;
        if !install {
            s.on.retain(|x| !MOVED.iter().any(|(id, _)| id == x));
        }
    }
    state.plugins.save();
}

/// What a card of a plugin that may see the browser asks for by name, from the island's own page: a guide's words (`guide`, by
/// its `key`), a picture inside it (`picture`: `key`, `no`, `max`) and a page's main picture (`image`: `id`). They are too big to
/// go through a module. The plugin has to be on and to have `permissions.browser`.
#[tauri::command]
pub async fn browser_get(window: tauri::WebviewWindow, plugin: String, what: String, args: Option<Value>) -> Result<Value, String> {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>().inner().clone();
    let p = state.plugins.plugin(&plugin).ok_or("no such plugin")?;
    if !state.plugins.is_on(&p) || !p.manifest.permissions.browser {
        return Err("that plugin may not see the browser".into());
    }
    let args = args.unwrap_or(Value::Null);
    tauri::async_runtime::spawn_blocking(move || {
        let ext = crate::browsersensor::state();
        let text = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let num = |k: &str| args.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        Ok(match what.as_str() {
            "guide" => serde_json::to_value(ext.guide(&text("key"))).unwrap_or(Value::Null),
            "picture" => json!(ext.guide_picture(&text("key"), num("no") as u32, num("max") as u32)),
            "image" => json!(ext.image(num("id"))),
            _ => return Err(format!("no such thing: {what}")),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the plugins' widgets and panes show now.
#[tauri::command]
pub fn plugin_surface(window: tauri::WebviewWindow) -> Value {
    use tauri::Manager;
    window.state::<Arc<IslandState>>().plugins.surfaces()
}

#[tauri::command]
pub fn plugin_set(window: tauri::WebviewWindow, id: String, on: bool) {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    state.plugins.set(&id, on);
    sync_audio(&state);
    // (a plugin that is switched off has no window open)
    if !on {
        for who in state.plugins.family(&id) {
            crate::modal::from_plugin(window.app_handle(), &who, "", Value::Null);
            state.plugins.clear_surface(window.app_handle(), &who);
        }
    }
    // (the head's widgets are the plugins' that are on: it lays itself out again)
    let _ = tauri::Emitter::emit(&window, "plugins-changed", ());
}

/// Take a plugin away: it is switched off, and its folder is deleted (what it kept, its settings and its place in the island, stay
/// for when it is put back).
#[tauri::command]
pub fn plugin_remove(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    use tauri::Manager;
    if !valid_id(&id) {
        return Err("That is not a plugin.".into());
    }
    let folder = dir().ok_or("There is no plugins folder.")?.join(&id);
    if !folder.join("manifest.json").is_file() {
        return Err("That plugin is not in the plugins folder.".into());
    }
    plugin_set(window.clone(), id, false);
    std::fs::remove_dir_all(&folder).map_err(|e| e.to_string())?;
    let state = window.state::<Arc<IslandState>>();
    state.plugins.rescan();
    sync_audio(&state);
    let _ = tauri::Emitter::emit(&window, "plugins-changed", ());
    Ok(())
}

#[tauri::command]
pub fn plugin_value(window: tauri::WebviewWindow, id: String, key: String, value: Value) {
    use tauri::Manager;
    window.state::<Arc<IslandState>>().plugins.set_value(&id, &key, value.clone());
    let _ = tauri::Emitter::emit(&window, "plugin-setting", json!({ "plugin": id, "key": key, "value": value }));
}

/// The script of one of a plugin's faces (the frame runs it; nothing else of the folder is handed out).
#[tauri::command]
pub fn plugin_face(window: tauri::WebviewWindow, id: String, file: String) -> Result<String, String> {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    let p = state.plugins.plugin(&id).ok_or("no such plugin")?;
    if !p.manifest.faces.iter().any(|f| f.file == file) {
        return Err("not a face of it".into());
    }
    let path = p.dir.join(&file);
    let meta = std::fs::metadata(&path).map_err(|_| "the script is gone".to_string())?;
    if meta.len() > 600 * 1024 {
        return Err("the script is too big".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_mute(window: tauri::WebviewWindow, id: String, muted: bool) {
    use tauri::Manager;
    window.state::<Arc<IslandState>>().plugins.set_muted(&id, muted);
}

#[tauri::command]
pub fn plugin_dnd(window: tauri::WebviewWindow, on: bool) {
    use tauri::Manager;
    window.state::<Arc<IslandState>>().plugins.set_dnd(on);
}

#[tauri::command]
pub fn plugin_rescan(window: tauri::WebviewWindow) -> Listing {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    state.plugins.rescan();
    sync_audio(&state);
    state.plugins.listing()
}

/// Open the plugins folder in Explorer (made first if it is not there).
#[tauri::command]
pub fn plugin_folder() {
    if let Some(d) = dir() {
        let _ = std::fs::create_dir_all(&d);
        let _ = std::process::Command::new("explorer").arg(d).spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_modules_widgets_and_pane_are_kept_to_the_blocks_the_island_draws() {
        let m = Manifest { id: "x".into(), name: "X".into(), kind: "wasm".into(), widgets: vec![WidgetSpec { id: "date".into(), name: "Date".into(), ..Default::default() }], ..Default::default() };
        let reply = json!({
            "widgets": {
                "date": { "blocks": [{ "clock": "time", "h24": true }, { "clock": "date" }, { "html": "<b>no</b>" }, { "text": "hi", "kind": "weird" }], "tip": [{ "text": "next" }] },
                "other": { "blocks": [{ "text": "not in the manifest" }] }
            },
            "pane": {
                "title": "Calendar", "open": true,
                "blocks": [
                    { "head": "October 2026", "prev": "prev", "next": "next", "press": "today" },
                    { "grid": { "cols": 99, "labels": ["S", "M"], "cells": [{ "t": "14", "id": "d:1", "state": "today", "dots": 9 }, { "t": "15", "state": "evil" }] } },
                    { "rows": [{ "title": "Standup", "time": "10:00 AM", "past": true }], "empty": "" },
                    { "buttons": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }, { "id": "c", "label": "C" }, { "id": "d", "label": "D" }, { "id": "e", "label": "E" }] }
                ]
            }
        });
        let out = out_of(&m, &reply);
        let w = out.widgets.expect("widgets");
        assert!(w.contains_key("date") && !w.contains_key("other"), "only the widgets its manifest lists");
        let blocks = w["date"]["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 3, "a block the island does not draw is left out");
        assert_eq!((blocks[0]["clock"].as_str(), blocks[0]["h24"].as_bool()), (Some("time"), Some(true)));
        assert_eq!(blocks[2]["kind"], "", "a kind that is not one of the island's is dropped");
        assert_eq!(w["date"]["tip"][0]["text"], "next");
        let pane = out.pane.unwrap().unwrap();
        assert_eq!((pane["title"].as_str(), pane["open"].as_bool()), (Some("Calendar"), Some(true)));
        let b = pane["blocks"].as_array().unwrap();
        assert_eq!(b[0]["prev"], "prev");
        assert_eq!(b[1]["grid"]["cols"], 7);
        assert_eq!(b[1]["grid"]["cells"][0]["dots"], 3);
        assert_eq!(b[1]["grid"]["cells"][1]["state"], "");
        assert_eq!(b[2]["rows"][0]["past"], true);
        assert_eq!(b[3]["buttons"].as_array().unwrap().len(), 4);
        // null takes the pane away; nothing said, nothing done
        assert_eq!(out_of(&m, &json!({ "pane": null })).pane, Some(None));
        assert!(out_of(&m, &json!({})).pane.is_none() && out_of(&m, &json!({})).widgets.is_none());
    }

    #[test]
    fn a_graph_is_kept_to_numbers_in_range_and_watching_and_revealing_need_their_permissions() {
        let mut m = Manifest { id: "g".into(), name: "G".into(), kind: "wasm".into(), ..Default::default() };
        let reply = json!({
            "card": { "title": "T", "body": [{ "kind": "graph", "values": [1.0, -5.0, 3.0], "max": 0.0, "marks": [1.0, 2.0, 3.0, 4.0, 5.0, -1.0] }] },
            "watch": [4, 0, 5, 6, 7, 8],
            "reveal": "C:/Users/me/Downloads/a.zip"
        });
        let out = out_of(&m, &reply);
        let Block::Graph { values, max, marks } = &out.card.unwrap().unwrap().body[0] else { panic!("a graph") };
        assert_eq!(values, &vec![1.0, 0.0, 3.0], "a number below zero is zero");
        assert_eq!(*max, 3.0, "no top given: the highest number");
        assert_eq!(marks.len(), 4);
        // without the permissions, neither is done
        assert!(out_of(&m, &reply).watch.is_none() && out_of(&m, &reply).reveal.is_none());
        m.permissions.usage = true;
        m.permissions.downloads = true;
        let out = out_of(&m, &reply);
        assert_eq!(out.watch, Some(vec![4, 5, 6, 7]), "at most four programs, never process 0");
        assert!(out.reveal.unwrap().ends_with("a.zip"));
        assert_eq!(out_of(&m, &json!({ "watch": [] })).watch, Some(vec![]));
        assert!(out_of(&m, &json!({})).watch.is_none());
    }

    #[test]
    fn a_module_says_which_of_its_resting_islands_are_on_and_what_a_widget_may_show() {
        let m = Manifest {
            id: "np".into(),
            name: "NP".into(),
            kind: "wasm".into(),
            widgets: vec![WidgetSpec { id: "song".into(), ..Default::default() }],
            rests: vec![RestSpec { id: "playing".into(), left: "song".into(), ..Default::default() }],
            ..Default::default()
        };
        // only the islands its manifest lists; none said at all leaves what was
        let out = out_of(&m, &json!({ "rest": ["playing", "made-up"] }));
        assert_eq!(out.rest, Some(vec!["playing".to_string()]));
        assert_eq!(out_of(&m, &json!({ "rest": [] })).rest, Some(vec![]));
        assert!(out_of(&m, &json!({})).rest.is_none());
        // a picture with words, and a button: kept to what the island draws; a picture must be a raster, or "keep"
        let reply = json!({ "widgets": { "song": { "blocks": [
            { "item": { "tile": "https://x/y.png", "icon": "music", "text": "Midnight Drive", "sub": "Artist" } },
            { "icon_button": { "icon": "pause", "press": "playpause", "label": "Pause" } }
        ] } } });
        let w = out_of(&m, &reply).widgets.unwrap();
        let blocks = w["song"]["blocks"].as_array().unwrap();
        assert_eq!(blocks[0]["item"]["tile"], "");
        assert_eq!(blocks[0]["item"]["text"], "Midnight Drive");
        assert_eq!(blocks[1]["icon_button"]["press"], "playpause");
        // "keep" shows the picture the widget showed last
        let mut next = json!({ "blocks": [{ "item": { "tile": "keep", "icon": "", "text": "Next", "sub": "" } }] });
        let was = json!({ "blocks": [{ "item": { "tile": "data:image/png;base64,AAAA", "icon": "", "text": "Last", "sub": "" } }] });
        keep_tiles(&mut next, Some(&was));
        assert_eq!(next["blocks"][0]["item"]["tile"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn a_plugin_may_have_a_tile_and_a_card_may_say_what_the_tile_says() {
        let m: Manifest = serde_json::from_str(r##"{ "id": "games", "name": "Games", "kind": "wasm", "tile": { "name": "Games", "icon": "gamepad", "tint": "#3ea66f", "sizes": ["small", "wide"], "idle": "no game running" } }"##).unwrap();
        let t = m.tile.unwrap();
        assert_eq!((t.icon.as_str(), t.sizes.len(), t.idle.as_str()), ("gamepad", 2, "no game running"));
        // (a plugin with no tile has none)
        assert!(serde_json::from_str::<Manifest>(r#"{ "id": "x", "name": "X", "kind": "wasm" }"#).unwrap().tile.is_none());
        // a card's glance is cut to what a tile can hold
        let m = Manifest { id: "games".into(), name: "Games".into(), kind: "wasm".into(), ..Default::default() };
        let c = clean_card(&m, &json!({ "title": "Elden Ring", "glance": { "big": "144144144144144", "caption": "fps" } })).unwrap();
        assert_eq!(c.glance.unwrap().big.chars().count(), 12);
    }

    #[test]
    fn meters_may_be_drawn_as_bars_or_as_rings_and_are_kept_to_a_few_plain_ones() {
        let meters = json!([
            { "label": "CPU", "part": 1.7, "color": "#5AC8E6", "text": "34%" },
            { "label": "RAM", "part": 0.5, "color": "red; background:url(x)" },
        ]);
        let rings = clean_blocks(Some(&json!([{ "rings": meters }])));
        assert_eq!(rings[0]["rings"][0]["part"], 1.0);
        assert_eq!(rings[0]["rings"][0]["color"], "#5AC8E6");
        // (a colour that is not #rrggbb is made plain)
        assert_eq!(rings[0]["rings"][1]["color"], "#9a9aa2");
        let bars = clean_blocks(Some(&json!([{ "bars": meters }])));
        assert_eq!(bars[0]["bars"][0]["label"], "CPU");
        assert!(bars[0].get("rings").is_none());
    }

    #[test]
    fn requests_links_and_windows_need_their_permissions() {
        let mut m = Manifest { id: "x".into(), name: "X".into(), kind: "wasm".into(), ..Default::default() };
        let reply = json!({
            "fetch": [{ "id": "u", "method": "GET", "url": "https://api.anthropic.com/a" }, { "id": "bad", "url": "https://evil.example.com/" }, { "id": "c", "url": "https://api.anthropic.com/c" }, { "id": "d", "url": "https://api.anthropic.com/d" }],
            "open": "https://claude.ai/oauth/authorize?x=1",
            "focus": { "exe": "C:/Program Files/Microsoft VS Code/Code.exe", "title": "nadi" }
        });
        let out = out_of(&m, &reply);
        assert!(out.fetch.is_empty() && out.focus.is_none(), "no host named, no program permission");
        m.permissions.net = vec!["api.anthropic.com".into()];
        m.permissions.programs = true;
        let out = out_of(&m, &reply);
        assert_eq!(out.fetch.len(), 1, "the first two asked for are looked at, and only one is to a host it names");
        assert_eq!(out.fetch[0]["id"], "u");
        assert_eq!(out.focus, Some((Some("C:/Program Files/Microsoft VS Code/Code.exe".into()), Some("nadi".into()))));
        assert_eq!(out.open.as_deref(), Some("https://claude.ai/oauth/authorize?x=1"), "(whether it may open it is the host's to say, by `permissions.open`)");
    }

    #[test]
    fn a_modules_modal_is_kept_to_what_the_island_draws() {
        let m = Manifest { id: "x".into(), name: "X".into(), kind: "wasm".into(), ..Default::default() };
        let reply = json!({
            "modal": {
                "title": "Hello",
                "width": 9000,
                "at": "top-right",
                "owner": "The Island",
                "icon": { "letter": "!" },
                "remember": "something-else",
                "blocks": [
                    { "text": "A paragraph", "kind": "warn" },
                    { "html": "<b>no</b>" },
                    { "field": "city", "value": "Man", "placeholder": "a city" },
                    { "checks": "pick", "items": [] },
                    { "choice": "for", "options": [{ "id": "a", "label": "A" }], "value": "a" }
                ],
                "buttons": [
                    { "id": "1", "label": "One" }, { "id": "2", "label": "Two", "primary": true },
                    { "id": "3", "label": "Three", "danger": true }, { "id": "4", "label": "Four" }
                ]
            }
        });
        let out = out_of(&m, &reply);
        let md = out.modal.expect("a modal");
        assert_eq!(md["title"], "Hello");
        // (the width stays in range; who it is, its icon and where it is kept are the island's to say, not the module's)
        assert_eq!(md["width"], 520.0);
        assert_eq!(md["at"], "top-right");
        assert!(md.get("owner").is_none() && md.get("icon").is_none() && md.get("remember").is_none());
        // (a block the island does not draw is left out; a card-style list of checks is not a module's)
        let kinds: Vec<String> = md["blocks"].as_array().unwrap().iter().map(|b| b.as_object().unwrap().keys().next().unwrap().clone()).collect();
        assert_eq!(kinds.len(), 3, "{kinds:?}");
        assert_eq!(md["blocks"][0]["kind"], "warn");
        assert_eq!(md["buttons"].as_array().unwrap().len(), 3);
        assert_eq!(md["buttons"][1]["primary"], true);
        // null closes the one it has open
        assert_eq!(out_of(&m, &json!({ "modal": null })).modal, Some(Value::Null));
        // nothing said, nothing done
        assert!(out_of(&m, &json!({})).modal.is_none());
    }

    fn ctx() -> Value {
        context_of(
            &json!([
                { "hash": "a", "name": "fedora.iso", "progress": 0.61, "size": 2147483648u64 },
                { "hash": "b", "name": "notes.zip", "progress": 0.18, "size": 5000 }
            ]),
            "",
        )
    }

    #[test]
    fn templates_read_paths_and_filters() {
        let c = ctx();
        assert_eq!(render("{{count}} downloading", &c), "2 downloading");
        assert_eq!(render("{{first.name}} · {{first.progress | percent}}", &c), "fedora.iso · 61%");
        assert_eq!(render("{{first.size | bytes}}", &c), "2.0 GB");
        assert_eq!(render("{{items.1.name | upper}}", &c), "NOTES.ZIP");
        assert_eq!(render("{{missing | default:none}}", &c), "none");
        assert_eq!(render("no holes", &c), "no holes");
        assert_eq!(render("open {{ hole", &c), "open {{ hole");
    }

    #[test]
    fn arithmetic_and_numbers_stay_numbers() {
        let c = json!({ "position": 30, "duration": 120, "t": 27.34 });
        assert_eq!(value_of("{{position / duration}}", &c), json!(0.25));
        assert_eq!(render("{{t | round}}", &c), "27");
        assert_eq!(render("{{t | round:1}}", &c), "27.3");
        assert_eq!(render("{{position / 0}}", &c), "");
    }

    #[test]
    fn the_card_is_made_from_blocks() {
        let m: Manifest = serde_json::from_value(json!({
            "id": "t", "name": "T",
            "card": {
                "icon": "download", "title": "{{count}} downloading", "sub": "{{first.name}}",
                "body": [
                    { "progress": "{{first.progress}}" },
                    { "list": "items", "limit": 1, "row": { "title": "{{name}}", "sub": "{{size | bytes}}", "progress": "{{progress}}" } },
                    { "facts": [["First", "{{first.name}}"], ["Nothing", "{{nope}}"]] },
                    { "text": "{{nope}}" }
                ]
            }
        }))
        .unwrap();
        let card = card_of(&m, &ctx());
        assert_eq!(card.title, "2 downloading");
        assert_eq!(card.body.len(), 3, "an empty text is left out, and so is a fact with no value");
        assert_eq!(card.body[0], Block::Progress { value: 0.61 });
        assert_eq!(card.body[2], Block::Facts { rows: vec![("First".into(), "fedora.iso".into())] });
        match &card.body[1] {
            Block::List { rows } => {
                assert_eq!(rows.len(), 1);
                assert_eq!((rows[0].title.as_str(), rows[0].sub.as_str()), ("fedora.iso", "2.0 GB"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn attention_comes_when_a_progress_arrives_not_before() {
        let spec = AttentionSpec { list: "items".into(), id: "hash".into(), field: "progress".into(), reaches: Some(1.0), priority: 50, banner: "Finished: {{name}}".into(), ..Default::default() };
        let mut w = Watch::default();
        let at = |p: f64| context_of(&json!([{ "hash": "a", "name": "fedora.iso", "progress": p }]), "");
        assert!(attention(&spec, &at(0.9), &mut w).is_empty(), "the first answer says nothing");
        assert!(attention(&spec, &at(0.95), &mut w).is_empty());
        assert_eq!(attention(&spec, &at(1.0), &mut w), vec!["Finished: fedora.iso".to_string()]);
        assert!(attention(&spec, &at(1.0), &mut w).is_empty(), "once");
        // one that was finished when the plugin started never speaks
        let mut w = Watch::default();
        assert!(attention(&spec, &at(1.0), &mut w).is_empty());
        assert!(attention(&spec, &at(1.0), &mut w).is_empty());
    }

    #[test]
    fn a_value_that_becomes_something() {
        let spec = AttentionSpec { field: "status".into(), becomes: Some("down".into()), banner: "{{name}} is down".into(), priority: 70, ..Default::default() };
        let mut w = Watch::default();
        let at = |s: &str| json!({ "name": "site", "status": s });
        assert!(attention(&spec, &at("up"), &mut w).is_empty());
        assert_eq!(attention(&spec, &at("down"), &mut w), vec!["site is down".to_string()]);
        assert!(attention(&spec, &at("down"), &mut w).is_empty());
        assert!(attention(&spec, &at("up"), &mut w).is_empty());
    }

    #[test]
    fn a_plugin_may_only_ask_what_it_listed() {
        let net = vec!["api.open-meteo.com".to_string(), "127.0.0.1:8080".to_string()];
        assert!(allowed("https://api.open-meteo.com/v1/forecast?x=1", &net).is_ok());
        assert!(allowed("http://127.0.0.1:8080/api", &net).is_ok());
        assert!(allowed("http://127.0.0.1:9090/api", &net).is_err(), "another port");
        assert!(allowed("https://evil.example.com/", &net).is_err());
        assert!(allowed("http://api.open-meteo.com/", &net).is_err(), "plain http to another machine");
        assert!(allowed("https://api.open-meteo.com@evil.example.com/", &net).is_err(), "a user name is not the host");
        assert!(allowed("ftp://api.open-meteo.com/", &net).is_err());
    }

    #[test]
    fn manifests_are_checked() {
        let m = |v: Value| serde_json::from_value::<Manifest>(v).unwrap();
        let ok = json!({ "id": "a-b", "name": "A", "permissions": { "net": ["x.com"] }, "source": { "http": "https://x.com/a" } });
        let here = std::path::Path::new(".");
        assert!(check(&m(ok.clone()), here).is_none());
        let mut bad = ok.clone();
        bad["id"] = json!("Bad Id!");
        assert!(check(&m(bad), here).is_some());
        let mut wasm = ok.clone();
        wasm["kind"] = json!("wasm");
        assert!(check(&m(wasm), here).unwrap().contains("names its file"));
        let mut far = ok.clone();
        far["source"]["http"] = json!("https://y.com/a");
        assert!(check(&m(far), here).unwrap().contains("not on the list"));
        // a declarative plugin cannot listen to the PC
        let mut ears = ok;
        ears["permissions"]["audio"] = json!(true);
        assert!(check(&m(ears), here).unwrap().contains("Only a module"));
    }

    fn manifest_of_json(v: Value) -> Manifest {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_reply_is_read_into_what_the_island_does() {
        let m = manifest_of_json(json!({ "id": "p", "name": "P", "kind": "wasm" }));
        let out = out_of(
            &m,
            &json!({
                "card": { "icon": "clock", "title": "T", "body": [
                    { "kind": "buttons", "items": [{ "label": "Pause", "action": "pause" }, { "label": "No action" }] },
                    { "kind": "image", "src": "https://evil.example/x.png" },
                    { "kind": "image", "src": "data:image/png;base64,AAAA" }
                ] },
                "pill": { "icon": "music", "title": "Song", "rank": 500, "w": 9000.0, "h": 1.0, "bars": [2.0, -1.0], "look": "huge" },
                "rings": [{ "id": "disk", "pct": 140.0, "tip": "Disk", "color": "red" }, { "id": "Bad Id", "pct": 1.0 }],
                "say": [{ "text": "3:30 PM", "priority": 500, "pill": { "icon": "clock", "right": "Fri", "look": "big", "ms": 4000 }, "ambient": true }, { "text": "" }],
                "events": null, "quiet": true, "note": " Connected ", "wake_ms": 5, "media": { "action": "next", "source": "spotify" }
            }),
        );
        let card = out.card.unwrap().unwrap();
        assert_eq!(card.rank, 70, "a card with no rank sits at 70");
        // a button with no action and a picture that is not a data: raster are left out
        assert_eq!(card.body.len(), 2);
        assert_eq!(card.body[0], Block::Buttons { items: vec![Button { label: "Pause".into(), icon: "".into(), action: "pause".into() }] });
        assert_eq!(card.body[1], Block::Image { src: "data:image/png;base64,AAAA".into() });
        let pill = out.pill.unwrap().unwrap();
        assert_eq!((pill.rank, pill.w, pill.h, pill.look.as_str()), (99, 360.0, 32.0, ""));
        assert_eq!(pill.bars, vec![1.0, 0.0]);
        let rings = out.rings.unwrap();
        assert_eq!(rings.len(), 1, "a ring needs a valid id");
        assert_eq!((rings[0].pct, rings[0].color.as_str()), (100.0, "#9a9aa2"));
        assert_eq!(out.say.len(), 1);
        assert_eq!(out.say[0].priority, 100);
        assert!(out.say[0].ambient);
        let sp = out.say[0].pill.as_ref().unwrap();
        assert_eq!((sp.icon.as_str(), sp.right.as_str(), sp.look.as_str(), sp.ms), ("clock", "Fri", "big", 4000));
        assert!(matches!(out.events, Some(None)));
        assert_eq!(out.quiet, Some(true));
        assert_eq!(out.note, Some(Some("Connected".to_string())));
        assert_eq!(out.wake_ms, Some(50), "never faster than 50 ms");
        assert_eq!(out.media, Some(("next".into(), "spotify".into(), 0.0)));
        // a reply that says nothing changes nothing
        let nothing = out_of(&m, &json!({ "say": [] }));
        assert!(nothing.card.is_none() && nothing.pill.is_none() && nothing.rings.is_none() && nothing.events.is_none());
        assert!(nothing.quiet.is_none() && nothing.wake_ms.is_none() && nothing.media.is_none());
        // ... and `null` takes a thing away
        let gone = out_of(&m, &json!({ "card": null, "pill": null, "rings": null }));
        assert!(gone.card == Some(None) && gone.pill == Some(None) && gone.rings == Some(vec![]));
    }

    #[test]
    fn a_picture_is_a_data_raster_and_nothing_else() {
        assert!(image_ok("data:image/png;base64,AAAA"));
        assert!(image_ok("data:image/jpeg;base64,AAAA"));
        assert!(!image_ok("data:image/svg+xml;base64,AAAA"), "an svg can carry a script");
        assert!(!image_ok("https://example.com/a.png"), "the island does not fetch for a plugin");
        assert!(!image_ok("file:///C:/Users/a.png"));
        assert!(!image_ok(&format!("data:image/png;base64,{}", "A".repeat(MAX_IMAGE))));
    }

    #[test]
    fn a_host_can_be_a_setting() {
        let m = manifest_of_json(json!({ "id": "c", "name": "C", "permissions": { "net": ["{{settings.url}}", "api.example.com"] } }));
        let none = net_hosts(&m, &json!({ "url": "" }));
        assert_eq!(none, vec!["api.example.com".to_string()], "a setting that is empty allows nothing");
        let some = net_hosts(&m, &json!({ "url": "https://Calendar.Google.com:443/ical/x/basic.ics?a=b" }));
        assert!(some.contains(&"calendar.google.com:443".to_string()));
        assert!(allowed("https://calendar.google.com:443/ical/x/basic.ics", &some).is_ok());
        assert!(allowed("https://evil.example.com/", &some).is_err(), "the address the user gave is the only one");
    }

    #[test]
    fn a_redirect_may_be_relative_and_is_checked_like_any_address() {
        assert_eq!(resolve("https://a.example.com/x/y.ics", "/z.ics"), Some("https://a.example.com/z.ics".into()));
        assert_eq!(resolve("https://a.example.com/x", "https://b.example.com/q"), Some("https://b.example.com/q".into()));
        assert_eq!(resolve("https://a.example.com/x", "q.ics"), None);
        // (the answer to a redirect to somewhere not on the list is the same refusal as for any other address)
        assert!(allowed("https://b.example.com/q", &["a.example.com".into()]).is_err());
        assert!(is_local("http://127.0.0.1:8080/api") && is_local("http://localhost/x") && !is_local("https://example.com"));
    }

    #[test]
    fn a_declarative_pill_and_rings_come_from_templates() {
        let m = manifest_of_json(json!({ "id": "q", "name": "Q", "pill": { "when": "{{count}}", "icon": "download", "title": "{{count}} downloading", "right": "{{first.progress | percent}}", "progress": "{{first.progress}}", "rank": 40 },
            "rings": [{ "id": "disk", "color": "#ff8800", "pct": "{{first.progress * 100}}", "tip": "Disk {{first.progress | percent}}" }, { "id": "none", "color": "#fff", "pct": "{{nope}}" }] }));
        let c = ctx();
        let pill = pill_of(&m, m.pill.as_ref().unwrap(), &c).unwrap();
        assert_eq!((pill.title.as_str(), pill.right.as_str(), pill.progress, pill.rank), ("2 downloading", "61%", Some(0.61), 40));
        let rings = rings_of(&m.rings, &c);
        assert_eq!(rings.len(), 1, "a ring with no number is not shown");
        assert_eq!((rings[0].pct, rings[0].tip.as_str(), rings[0].color.as_str()), (61.0, "Disk 61%", "#ff8800"));
        // while `when` does not hold there is no pill
        let none = context_of(&json!([]), "");
        assert!(pill_of(&m, m.pill.as_ref().unwrap(), &none).is_none());
        assert!(truthy("yes") && !truthy("0") && !truthy(" false ") && !truthy(""));
    }

    /// `check`, with a folder that holds the module file
    fn check_manifest(m: &Manifest) -> Option<String> {
        let dir = std::env::temp_dir().join(format!("nadi-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(&m.module), b"\0asm").unwrap();
        check(m, &dir)
    }

    #[test]
    fn a_module_that_brings_a_calendar_names_only_its_own_link() {
        let m: Manifest = serde_json::from_value(json!({
            "id": "ics-calendar", "name": "Calendar", "kind": "wasm", "module": "ics-calendar.wasm",
            "permissions": { "calendar": true, "net": ["{{settings.url}}"] },
            "source": { "http": "{{settings.url}}", "every": "{{settings.poll_min}}m", "format": "ics", "when": "always", "max_kb": 8000 },
            "needs": ["url"],
            "settings": { "url": { "type": "text", "default": "" }, "poll_min": { "type": "number", "default": 10 } }
        }))
        .unwrap();
        assert!(brings_a_calendar(&m));
        // switched on with no link yet: waiting for the link is not a fault
        assert!(check_manifest(&m).is_none());
        assert!(missing(&m, &json!({ "url": "  " })) && !missing(&m, &json!({ "url": "https://x.example/a.ics" })));
        // with a link, the only host it may ask is the link's
        let v = json!({ "url": "https://calendar.google.com/calendar/ical/x/basic.ics", "poll_min": 10 });
        let hosts = net_hosts(&m, &v);
        assert_eq!(hosts, vec!["calendar.google.com".to_string()]);
        assert_eq!(render(&m.source.every, &json!({ "settings": v })), "10m");
        assert!(allowed(&render(&m.source.http, &json!({ "settings": v })), &hosts).is_ok());
        // a module may name only a calendar, and only an address on its own list
        let mut json_source = m.clone();
        json_source.source.format = "json".into();
        assert!(check_manifest(&json_source).unwrap().contains("only for a calendar"));
        let mut elsewhere = m.clone();
        elsewhere.needs.clear();
        elsewhere.source.http = "https://evil.example.com/a.ics".into();
        assert!(check_manifest(&elsewhere).is_some());
        // without an address, a module still has no network
        let mut net_only = m.clone();
        net_only.source.http.clear();
        assert!(check_manifest(&net_only).unwrap().contains("cannot also see this PC"));
    }

    #[test]
    fn a_bundle_is_one_plugin_made_of_parts_that_each_keep_their_own_permissions() {
        let dir = std::env::temp_dir().join(format!("nadi-bundle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.wasm"), b" asm").unwrap();
        std::fs::write(dir.join("b.wasm"), b" asm").unwrap();
        let m: Manifest = serde_json::from_value(json!({
            "id": "claude", "name": "Claude", "kind": "bundle",
            "settings": { "alerts": { "label": "A", "type": "toggle", "default": true } },
            "actions": [{ "part": "usage", "id": "login", "label": "Sign in", "ask": "Code", "then": "finish" }],
            "widgets": [{ "part": "usage", "id": "bars", "name": "Bars" }],
            "parts": [
                { "id": "sessions", "module": "a.wasm", "permissions": { "claude": true, "processes": true } },
                { "id": "usage", "module": "b.wasm", "permissions": { "net": ["api.anthropic.com"], "storage": true } }
            ]
        }))
        .unwrap();
        assert!(check(&m, &dir).is_none());
        let parts = parts_of(&m);
        assert_eq!(parts.iter().map(|p| (p.id.as_str(), p.parent.as_str(), p.kind.as_str())).collect::<Vec<_>>(), [("claude-sessions", "claude", "wasm"), ("claude-usage", "claude", "wasm")]);
        // the part that answers an action has it, and the widget goes to its part; the settings are the bundle's
        assert!(parts[0].actions.is_empty() && parts[0].widgets.is_empty());
        assert_eq!((parts[1].actions[0].id.as_str(), parts[1].widgets[0].id.as_str()), ("login", "bars"));
        assert!(parts[0].settings.contains_key("alerts"));
        // what is asked is what the parts ask, each once
        let names: Vec<String> = permissions_of(&m).into_iter().map(|p| p.name).collect();
        assert!(names.contains(&"claude sessions".to_string()) && names.contains(&"network".to_string()) && names.contains(&"storage".to_string()));
        // a part that reaches a host and sees the PC is refused, as a module is
        let mut bad = m.clone();
        bad.parts[1].permissions.processes = true;
        assert!(check(&bad, &dir).unwrap().contains("cannot also see this PC"));
        let mut none = m.clone();
        none.parts.clear();
        assert!(check(&none, &dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_module_that_reaches_a_host_sees_nothing_of_this_pc() {
        let dir = std::env::temp_dir().join(format!("nadi-net-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("u.wasm"), b" asm").unwrap();
        let mut m = Manifest { id: "usage".into(), name: "Usage".into(), kind: "wasm".into(), module: "u.wasm".into(), ..Default::default() };
        m.permissions.net = vec!["api.anthropic.com".into()];
        m.permissions.storage = true;
        m.permissions.open = vec!["https://claude.ai/".into()];
        assert!(check(&m, &dir).is_none(), "a host, its own file and a link to open");
        for (name, set) in [
            ("claude", (|p: &mut Permissions| p.claude = true) as fn(&mut Permissions)),
            ("processes", |p| p.processes = true),
            ("programs", |p| p.programs = true),
            ("run", |p| p.run = vec!["git status".into()]),
            ("downloads", |p| p.downloads = true),
        ] {
            let mut bad = m.clone();
            set(&mut bad.permissions);
            assert!(check(&bad, &dir).unwrap_or_default().contains("cannot also see this PC"), "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn intervals() {
        assert_eq!(parse_every("2s"), Duration::from_secs(2));
        assert_eq!(parse_every("15m"), Duration::from_secs(900));
        assert_eq!(parse_every("100ms"), MIN_EVERY, "never faster than a second");
        assert_eq!(parse_every("soon"), DEFAULT_EVERY);
        assert_eq!(parse_every(""), DEFAULT_EVERY);
    }
}
