//! The tiles of the open island: a grid of squares, one for each plugin that has a tile (a phone's widgets). They are always
//! there while the plugin is on; the user may take one out, change its size, and put each one wherever they like in the grid.
//! All of that is done in the settings window; the island only shows it.
//!
//! What a tile shows comes from its plugin (the `tile` of its manifest, and its cards: ui/tiles.js draws it). What is kept here
//! is only what the user chose: where each tile is, the sizes, and which tiles they took out. It is the page's own document (like the
//! head's, see head.rs), kept in `%APPDATA%\\NADI\\tiles.json`.

use crate::IslandState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const SIZES: [&str; 3] = ["small", "wide", "large"];
const MAX_TILES: usize = 64;
const MAX_COLS: u32 = 16;
const MAX_ROWS: u32 = 64;
/// the order sizes are listed in, whatever the order a plugin wrote them in
const MAX_GAP: u32 = 16;
const ORDER: [&str; 3] = ["small", "wide", "large"];

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Layout {
    /// where the user put each tile (plugin id): its column and its row, counted from 1. A tile with no place takes the first free
    /// one that fits (ui/tilegrid.js); what no longer fits (the island got narrower) moves the same way.
    pub positions: BTreeMap<String, Pos>,
    /// the size the user chose, by plugin id
    pub sizes: BTreeMap<String, String>,
    /// the tiles the user took out
    pub removed: Vec<String>,
    /// whether the tiles of a row are put in the middle of it when there is room left at its sides (the island only: the places above
    /// are what is kept)
    pub center: bool,
    /// px between the tiles (0..=16); none is the standard (6)
    pub gap: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Pos {
    pub col: u32,
    pub row: u32,
}

fn path() -> Option<std::path::PathBuf> {
    Some(crate::settings::data_dir()?.join("tiles.json"))
}

fn saved() -> &'static Mutex<Layout> {
    static SAVED: OnceLock<Mutex<Layout>> = OnceLock::new();
    SAVED.get_or_init(|| Mutex::new(path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()))
}

fn write(l: &Layout) {
    if let (Some(p), Ok(json)) = (path(), serde_json::to_string_pretty(l)) {
        let _ = std::fs::write(p, json);
    }
}

/// An id as the island knows it: plain characters (what comes from a page is not trusted).
fn plain(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// What the user sent, made safe: known sizes, plain ids, places on a grid that is not absurd, no repeats, not too many.
fn clean(mut l: Layout) -> Layout {
    l.positions.retain(|id, p| plain(id) && (1..=MAX_COLS).contains(&p.col) && (1..=MAX_ROWS).contains(&p.row));
    while l.positions.len() > MAX_TILES {
        let Some(last) = l.positions.keys().next_back().cloned() else { break };
        l.positions.remove(&last);
    }
    l.sizes.retain(|id, size| plain(id) && SIZES.contains(&size.as_str()));
    let mut gone = Vec::new();
    l.removed.retain(|id| plain(id) && !gone.contains(id) && {
        gone.push(id.clone());
        true
    });
    l.removed.truncate(MAX_TILES);
    l.gap = l.gap.map(|g| g.min(MAX_GAP));
    l
}

/// A picture of a plugin's folder as an address the page can draw (a file name only, a raster, not too big), or nothing.
fn picture_of(dir: &std::path::Path, file: &str) -> String {
    use base64::Engine;
    let mime = match file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("gif") => "image/gif",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => return String::new(),
    };
    if !plain(file) || file.len() > 64 {
        return String::new();
    }
    match std::fs::read(dir.join(file)) {
        Ok(bytes) if bytes.len() <= 512 * 1024 => format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
        _ => String::new(),
    }
}

/// The tiles of the plugins that are on, and what the user chose.
pub fn view(state: &IslandState) -> Value {
    let layout = saved().lock().unwrap().clone();
    let tiles: Vec<Value> = state
        .plugins
        .tiles()
        .into_iter()
        .map(|(id, plugin_name, t, dir)| {
            // (the first the plugin lists is where it starts; the list is always small, wide, large)
            let start = t.sizes.iter().find(|s| SIZES.contains(&s.as_str())).cloned().unwrap_or_else(|| "small".into());
            let mut sizes: Vec<String> = ORDER.iter().filter(|z| t.sizes.iter().any(|s| s == *z)).map(|z| z.to_string()).collect();
            if sizes.is_empty() {
                sizes.push("small".into());
            }
            json!({
                "id": id,
                "name": if t.name.is_empty() { plugin_name } else { t.name },
                "icon": if t.icon.is_empty() { "dot".to_string() } else { t.icon },
                "tint": t.tint,
                "sizes": sizes,
                "start": start,
                "idle": t.idle,
                "widget": t.widget,
                "look": t.look,
                "picture": picture_of(&dir, &t.picture),
            })
        })
        .collect();
    json!({ "tiles": tiles, "layout": layout })
}

#[tauri::command]
pub fn tiles_get(window: tauri::WebviewWindow) -> Value {
    view(window.state::<Arc<IslandState>>().inner())
}

/// Keep what the user chose; the island (and the settings window) is told.
#[tauri::command]
pub fn tiles_set(app: AppHandle, layout: Layout) {
    let layout = clean(layout);
    {
        let mut s = saved().lock().unwrap();
        *s = layout;
        write(&s);
    }
    let _ = app.emit("tiles-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_comes_from_a_page_is_made_plain() {
        let mut sizes = BTreeMap::new();
        sizes.insert("games".to_string(), "large".to_string());
        sizes.insert("work".to_string(), "huge".to_string());
        sizes.insert("<b>".to_string(), "small".to_string());
        let mut positions = BTreeMap::new();
        positions.insert("games".to_string(), Pos { col: 2, row: 1 });
        positions.insert("<x>".to_string(), Pos { col: 1, row: 1 });
        positions.insert("work".to_string(), Pos { col: 0, row: 3 });
        positions.insert("claude".to_string(), Pos { col: 99, row: 1 });
        let l = clean(Layout { positions, sizes, removed: vec!["a b".into(), "claude".into(), "claude".into()], center: false, gap: Some(99) });
        assert_eq!(l.positions.len(), 1);
        assert_eq!(l.positions.get("games"), Some(&Pos { col: 2, row: 1 }));
        assert_eq!(l.sizes.len(), 1);
        assert_eq!(l.sizes.get("games").map(String::as_str), Some("large"));
        assert_eq!(l.removed, vec!["claude".to_string()]);
        assert_eq!(l.gap, Some(MAX_GAP));
    }

    #[test]
    fn a_picture_is_a_plain_file_name_of_the_folder_and_a_raster() {
        let dir = std::env::temp_dir().join(format!("nadi-tile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.gif"), b"GIF89a").unwrap();
        std::fs::write(dir.join("b.svg"), b"<svg/>").unwrap();
        assert!(picture_of(&dir, "a.gif").starts_with("data:image/gif;base64,"));
        // (not a raster, not a plain name, not there)
        assert_eq!(picture_of(&dir, "b.svg"), "");
        assert_eq!(picture_of(&dir, "../a.gif"), "");
        assert_eq!(picture_of(&dir, "nope.gif"), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_layout_is_kept_as_it_was_written() {
        let l = Layout { positions: BTreeMap::from([("a".to_string(), Pos { col: 1, row: 2 })]), sizes: BTreeMap::from([("a".to_string(), "wide".to_string())]), removed: vec!["c".into()], center: true, gap: Some(10) };
        let back: Layout = serde_json::from_str(&serde_json::to_string(&l).unwrap()).unwrap();
        assert_eq!(back, l);
        assert_eq!(clean(l.clone()), l);
        // (what an older file kept, the order, is not read any more)
        let old: Layout = serde_json::from_str(r#"{ "order": ["a", "b"], "removed": ["c"] }"#).unwrap();
        assert!(old.positions.is_empty());
    }
}
