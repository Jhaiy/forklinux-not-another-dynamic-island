//! The resting island: what the collapsed island shows when nothing else does. It is always three sections, left, center and
//! right, with one widget in each. The user fills them (`mine`); a plugin may offer a resting island of its own (the `rests` of its
//! manifest) for while it has something going on, which its module announces in its reply (`rest`). It is what the plugin's pill
//! became: it takes the pill's place, so the user may turn it off (nothing shows then) or change what is in its sections.
//!
//! What is kept here is only what the user chose: which widget is in which section of their own island, and for each island a
//! plugin offers, whether it is off and which sections they changed. The page puts the widgets there (ui/rest.js): which island
//! is shown now follows from this, from what the plugins say is on, and from their priority.

use crate::plugins::RestSpec;
use crate::IslandState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// A widget for each section, by id (`plugin:widget`). `None`: not chosen (what the plugin shipped, or the default); `Some("")`: nothing.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Layout {
    pub left: Option<String>,
    pub center: Option<String>,
    pub right: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
struct Pref {
    /// the user does not want this island (it is on until they say so: it is what the plugin's pill used to be, so it takes the
    /// pill's place, and with it off nothing shows for the plugin)
    off: bool,
    custom: Layout,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
struct Saved {
    /// the user's own island; until it is edited, the default stands (the eyes in the center, for whoever has them)
    mine: Layout,
    edited: bool,
    /// by `plugin:island`
    islands: BTreeMap<String, Pref>,
    /// the order the user put the islands in (`plugin:island`, first wins); the ones not in it follow, by priority
    order: Vec<String>,
}

fn path() -> Option<std::path::PathBuf> {
    Some(crate::settings::data_dir()?.join("rest.json"))
}

fn saved() -> &'static Mutex<Saved> {
    static SAVED: OnceLock<Mutex<Saved>> = OnceLock::new();
    SAVED.get_or_init(|| Mutex::new(path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()))
}

fn write(s: &Saved) {
    if let (Some(p), Ok(json)) = (path(), serde_json::to_string_pretty(s)) {
        let _ = std::fs::write(p, json);
    }
}

/// A widget id as the island knows it: `plugin:widget`, plain characters (what comes from a page is not trusted).
fn clean_id(v: &Option<String>) -> Option<String> {
    v.as_ref().map(|s| {
        let ok = s.len() <= 90 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'));
        if ok { s.clone() } else { String::new() }
    })
}

fn clean(l: Layout) -> Layout {
    Layout { left: clean_id(&l.left), center: clean_id(&l.center), right: clean_id(&l.right) }
}

/// The widget a section of an island of `plugin` names: `widget` of its own, or `plugin:widget`.
pub fn widget_of(plugin: &str, spec: &str) -> String {
    if spec.is_empty() || spec.contains(':') { spec.to_string() } else { format!("{plugin}:{spec}") }
}

fn island_json(plugin: &str, plugin_name: &str, r: &RestSpec, pref: &Pref) -> Value {
    json!({
        "key": format!("{plugin}:{}", r.id),
        "plugin": plugin,
        "plugin_name": plugin_name,
        "id": r.id,
        "name": if r.name.is_empty() { plugin_name.to_string() } else { r.name.clone() },
        "description": r.description,
        "when": r.when,
        "priority": r.priority,
        "on": !pref.off,
        "shipped": { "left": widget_of(plugin, &r.left), "center": widget_of(plugin, &r.center), "right": widget_of(plugin, &r.right) },
        "custom": pref.custom,
    })
}

/// The islands the plugins that are on offer, first the one that wins: the user's order, then the priority the plugin gave.
fn offered(state: &IslandState, order: &[String]) -> Vec<(String, String, RestSpec)> {
    let mut all = state.plugins.rests();
    all.sort_by_key(|(p, _, r)| {
        let key = format!("{p}:{}", r.id);
        (order.iter().position(|k| *k == key).unwrap_or(usize::MAX), -r.priority)
    });
    all
}

/// What the page needs to know: the user's island, and the ones the plugins that are on offer (the winning one first).
pub fn view(state: &IslandState) -> Value {
    let s = saved().lock().unwrap().clone();
    let mut islands: Vec<Value> = Vec::new();
    for (plugin, name, r) in offered(state, &s.order) {
        let pref = s.islands.get(&format!("{plugin}:{}", r.id)).cloned().unwrap_or_default();
        islands.push(island_json(&plugin, &name, &r, &pref));
    }
    json!({ "mine": s.mine, "edited": s.edited, "islands": islands })
}

#[tauri::command]
pub fn rest_get(window: tauri::WebviewWindow) -> Value {
    view(window.state::<Arc<IslandState>>().inner())
}

#[tauri::command]
pub fn rest_set_mine(window: tauri::WebviewWindow, layout: Layout) {
    {
        let mut s = saved().lock().unwrap();
        s.mine = clean(layout);
        s.edited = true;
        write(&s);
    }
    let _ = window.emit("rest-changed", ());
}

/// An island of a plugin: switch it on (or off), change what is in its sections, or put it back as the plugin shipped it.
#[tauri::command]
pub fn rest_set_island(window: tauri::WebviewWindow, key: String, on: Option<bool>, custom: Option<Layout>, reset: Option<bool>) {
    if key.len() > 100 || !key.contains(':') {
        return;
    }
    {
        let mut s = saved().lock().unwrap();
        let pref = s.islands.entry(key.clone()).or_default();
        if reset == Some(true) {
            pref.custom = Layout::default();
        }
        if let Some(o) = on {
            pref.off = !o;
        }
        if let Some(c) = custom {
            pref.custom = clean(c);
        }
        if *pref == Pref::default() {
            s.islands.remove(&key);
        }
        write(&s);
    }
    let _ = window.emit("rest-changed", ());
}

/// Move an island one place up (it wins over the one above) or down.
#[tauri::command]
pub fn rest_move_island(window: tauri::WebviewWindow, key: String, up: bool) {
    {
        let state = window.state::<Arc<IslandState>>();
        let mut s = saved().lock().unwrap();
        let mut keys: Vec<String> = offered(state.inner(), &s.order).iter().map(|(p, _, r)| format!("{p}:{}", r.id)).collect();
        let Some(i) = keys.iter().position(|k| *k == key) else { return };
        let j = if up { i.checked_sub(1) } else { (i + 1 < keys.len()).then_some(i + 1) };
        let Some(j) = j else { return };
        keys.swap(i, j);
        // (the ones that are off, or whose plugin is off, keep the places they had)
        let rest: Vec<String> = s.order.iter().filter(|k| !keys.contains(k)).cloned().collect();
        s.order = keys.into_iter().chain(rest).collect();
        write(&s);
    }
    let _ = window.emit("rest-changed", ());
}

/// The plugins that are on tell the page when what they offer changes (a plugin is switched, a module says an island is on).
pub fn changed(app: &AppHandle) {
    let _ = app.emit("rest-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_widget_of_the_plugin_is_named_with_the_plugin() {
        assert_eq!(widget_of("now-playing", "song"), "now-playing:song");
        assert_eq!(widget_of("now-playing", "eyes:head"), "eyes:head");
        assert_eq!(widget_of("now-playing", ""), "");
    }

    #[test]
    fn what_comes_from_a_page_is_made_plain() {
        let l = clean(Layout { left: Some("time:clock".into()), center: Some("<b>".into()), right: None });
        assert_eq!((l.left.as_deref(), l.center.as_deref(), l.right), (Some("time:clock"), Some(""), None));
    }

    #[test]
    fn an_island_is_on_until_the_user_turns_it_off() {
        let pref = Pref::default();
        assert!(!pref.off);
        let json = island_json("work", "Work", &RestSpec::default(), &pref);
        assert_eq!(json["on"], true);
        let json = island_json("work", "Work", &RestSpec::default(), &Pref { off: true, ..Pref::default() });
        assert_eq!(json["on"], false);
    }

    #[test]
    fn an_island_nobody_changed_is_not_kept() {
        let mut s = Saved::default();
        let pref = s.islands.entry("a:b".into()).or_default();
        assert_eq!(*pref, Pref::default());
    }
}
