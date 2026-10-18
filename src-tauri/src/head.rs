//! The head of the expanded island: rows with a left, a center and a right place, which plugins fill with widgets (the
//! eyes, the time, the rings...). The page lays the widgets out (`ui/head.js`); what is kept here is what the user
//! arranged (in the settings window): which widget sits in which place of which row, and which were taken out. It is the
//! page's own document, so the host only keeps it, as it is, in `%APPDATA%\NADI\head.json`.
//!
//! The widgets themselves live in the island's window, and the arranging is done in the settings window. So the island
//! posts a catalog of what it has (`head-catalog.json`: names, places, the widths it measured), and the settings window
//! reads it; each side is told when the other changed something.

use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// the most a document may hold (a few hundred widgets would not reach it)
const MAX_BYTES: usize = 64 * 1024;

fn path() -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("head.json"))
}

fn catalog_path() -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("head-catalog.json"))
}

/// Check a document and write it to `path`.
fn store(path: Option<PathBuf>, text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("The head layout is too big.".into());
    }
    serde_json::from_str::<serde_json::Value>(text).map_err(|_| "The head layout is not JSON.".to_string())?;
    std::fs::write(path.ok_or("no data folder")?, text).map_err(|e| e.to_string())
}

fn read(path: Option<PathBuf>) -> Option<String> {
    std::fs::read_to_string(path?).ok().filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok())
}

/// What the user arranged (JSON text), or nothing when they never did.
#[tauri::command]
pub fn head_layout_get() -> Option<String> {
    read(path())
}

/// Keep what the user arranged. (`None`: they reset it, and the plugins' own places apply again.) The island is told.
#[tauri::command]
pub fn head_layout_set(app: AppHandle, layout: Option<String>) -> Result<(), String> {
    match layout {
        Some(text) => store(path(), &text)?,
        None => {
            if let Some(p) = path() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let _ = app.emit("head-layout-changed", ());
    Ok(())
}

/// The widgets the island has (JSON text), as it last posted them.
#[tauri::command]
pub fn head_catalog_get() -> Option<String> {
    read(catalog_path())
}

/// The island posts what widgets it has. The settings window is told.
#[tauri::command]
pub fn head_catalog_set(app: AppHandle, catalog: String) -> Result<(), String> {
    // (nothing is written, and nobody told, when it is what is there already)
    if read(catalog_path()).as_deref() == Some(catalog.as_str()) {
        return Ok(());
    }
    store(catalog_path(), &catalog)?;
    let _ = app.emit("head-catalog-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layout_that_is_not_json_or_too_big_is_refused() {
        assert!(store(None, "{nope").is_err());
        assert!(store(None, &format!("\"{}\"", "x".repeat(MAX_BYTES))).is_err());
    }

    #[test]
    fn a_layout_is_kept_as_it_was_written() {
        let file = std::env::temp_dir().join(format!("nadi-head-test-{}.json", std::process::id()));
        store(Some(file.clone()), r#"{"edited":true,"rows":[]}"#).unwrap();
        assert_eq!(read(Some(file.clone())).as_deref(), Some(r#"{"edited":true,"rows":[]}"#));
        let _ = std::fs::remove_file(file);
    }
}
