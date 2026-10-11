//! Modals: small windows the island opens, that you can move, and that plugins can open too.
//!
//! A modal is drawn on the floating cards' layer (see `floats.rs`): the same extra window, which is click-through
//! except over the cards and the modals, and never takes the focus from what is under it (a text field in a modal asks
//! for the keyboard while it is in use, as one in a card does). Nobody draws a modal but the island: the one who asks
//! gives a *spec* (a title, blocks of words and fields, buttons; see `ui/modal.js`), and the answer comes back as an event.
//!
//! The island's page and the layer's page do the work; this file only carries between them:
//!   * `modal_open`: a spec goes to the layer (made if need be). A spec with the id of a modal that is open replaces it.
//!   * `modal_close`: the one who asked closes it.
//!   * `modal_result`: the layer says a button was pressed (or the cross), with what the fields held; it goes to
//!     everyone, and whoever opened that modal answers.

use crate::floats;
use crate::IslandState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Show a modal (or replace the one with this id). False when there is no layer to show it on. (Async: a window is made here the first
/// time, which a plain command, run on the main thread, cannot do without freezing.)
#[tauri::command]
pub async fn modal_open(app: AppHandle, spec: Value) -> bool {
    // (only the island's own pages may ask: a plugin's modal comes by `from_plugin`, which says whose it is)
    if spec.get("id").and_then(|v| v.as_str()).map_or(false, |s| s.starts_with("plugin:")) {
        return false;
    }
    open_spec(&app, spec)
}

fn open_spec(app: &AppHandle, mut spec: Value) -> bool {
    let state = app.state::<Arc<IslandState>>().inner().clone();
    // (a spec is a few lines of words: a big one is not a modal)
    if spec.to_string().len() > 64 * 1024 || spec.get("id").and_then(|v| v.as_str()).map_or(true, |s| s.is_empty() || s.len() > 96) {
        return false;
    }
    let Some(layer) = floats::ensure(app) else {
        return false;
    };
    // where the pointer is (physical px from the layer's corner), for a modal that asks to open under it
    let (ox, oy, _, _) = floats::desktop();
    let (cx, cy) = crate::winutil::cursor_pos();
    if let Some(o) = spec.as_object_mut() {
        o.insert("_cursor".into(), serde_json::json!({ "x": cx - ox, "y": cy - oy }));
    }
    if state.floats.ready.load(Ordering::Relaxed) {
        let _ = layer.emit("modal-open", spec);
    } else {
        state.floats.pending_modals.lock().unwrap().push(spec);
    }
    true
}

/// The id of the modal of a plugin (one at a time: the next step of its flow replaces it).
pub fn plugin_modal_id(plugin: &str) -> String {
    format!("plugin:{plugin}")
}

/// A module's modal (already kept to what the island draws, see `plugins::clean_modal`): the island puts the plugin's name on
/// its bar and its first letter in its tile, remembers where you left it by the plugin, and shows it. `Null` closes it.
pub fn from_plugin(app: &AppHandle, plugin: &str, name: &str, spec: Value) {
    let id = plugin_modal_id(plugin);
    if spec.is_null() {
        let state = app.state::<Arc<IslandState>>().inner().clone();
        state.floats.pending_modals.lock().unwrap().retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        if let Some(layer) = app.get_webview_window("floats") {
            let _ = layer.emit("modal-close", serde_json::json!({ "id": id }));
        }
        return;
    }
    let mut spec = spec;
    if let Some(o) = spec.as_object_mut() {
        o.insert("id".into(), Value::String(id));
        o.insert("owner".into(), Value::String(name.chars().take(40).collect()));
        o.insert("remember".into(), Value::String(format!("plugin:{plugin}")));
        let letter: String = name.trim().chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
        o.insert("icon".into(), serde_json::json!({ "letter": letter }));
    }
    open_spec(app, spec);
}

/// Close a modal that someone opened (its answer is the cross: "close").
#[tauri::command]
pub fn modal_close(app: AppHandle, state: tauri::State<'_, Arc<IslandState>>, id: String) {
    state.floats.pending_modals.lock().unwrap().retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    if let Some(layer) = app.get_webview_window("floats") {
        let _ = layer.emit("modal-close", serde_json::json!({ "id": id }));
    }
}

/// A button of a modal was pressed, or its cross. `closed`: the modal is gone now.
#[tauri::command]
pub fn modal_result(app: AppHandle, state: tauri::State<'_, Arc<IslandState>>, id: String, button: String, values: Value, closed: bool) {
    // a plugin's modal: the plugin is told, as it is of a button on its card
    if let Some(plugin) = id.strip_prefix("plugin:") {
        let _ = state.plugins.act(plugin, "modal", serde_json::json!({ "button": button, "values": values, "closed": closed }));
        return;
    }
    let _ = app.emit("modal-result", serde_json::json!({ "id": id, "button": button, "values": values, "closed": closed }));
}
