//! The head of the expanded island: rows with a left, a center and a right place, which plugins fill with widgets (the
//! eyes, the time, the rings...). The page lays the widgets out (`ui/head.js`); the one thing kept here is what the user
//! arranged in edit mode: which widget sits in which place of which row, and which were taken out. It is the page's own
//! document, so the host only keeps it, as it is, in `%APPDATA%\NADI\head.json`.

use std::path::PathBuf;

/// the most the document may hold (a few hundred widgets would not reach it)
const MAX_BYTES: usize = 64 * 1024;

fn path() -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("head.json"))
}

/// What the user arranged (JSON text), or nothing when they never did.
#[tauri::command]
pub fn head_layout_get() -> Option<String> {
    std::fs::read_to_string(path()?).ok().filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok())
}

/// Keep what the user arranged. (`None`: they reset it, and the plugins' own places apply again.)
#[tauri::command]
pub fn head_layout_set(layout: Option<String>) -> Result<(), String> {
    let path = path().ok_or("no data folder")?;
    let Some(text) = layout else {
        let _ = std::fs::remove_file(path);
        return Ok(());
    };
    if text.len() > MAX_BYTES {
        return Err("The head layout is too big.".into());
    }
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| "The head layout is not JSON.".to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layout_that_is_not_json_or_too_big_is_refused() {
        assert!(head_layout_set(Some("{nope".into())).is_err());
        assert!(head_layout_set(Some(format!("\"{}\"", "x".repeat(MAX_BYTES)))).is_err());
    }
}
