//! The settings window: a window of its own, not a pane of the hub. It runs the island's page (`index.html?settings=1`),
//! which draws only the settings then (see ui/main.js), so the forms, the plugin list and what they call are the same code
//! as ever. Opened from the tray menu (and from a plugin's own link, to its page); one at a time, it comes forward when it is
//! asked for again. Where it was left, and how big, is kept for the next time.
//!
//! The island is told when a setting changes (`settings-changed`), and when a plugin is switched (`plugins-changed`): it is
//! another window now, so what the island shows has to follow.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "settings";
const PAGES: [&str; 7] = ["general", "size", "resting", "expanded", "look", "plugins", "about"];

/// where the window was left (physical px)
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Placed {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

fn path() -> Option<std::path::PathBuf> {
    Some(crate::settings::data_dir()?.join("settings-window.json"))
}

fn load() -> Option<Placed> {
    serde_json::from_str(&std::fs::read_to_string(path()?).ok()?).ok()
}

fn save(w: &WebviewWindow) {
    let (Some(p), Ok(pos), Ok(size)) = (path(), w.outer_position(), w.inner_size()) else { return };
    // (a window that is minimized sits far off the screen: not where it was left)
    if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) || size.width < 200 || size.height < 200 {
        return;
    }
    let placed = Placed { x: pos.x, y: pos.y, w: size.width, h: size.height };
    if let Ok(json) = serde_json::to_string(&placed) {
        let _ = std::fs::write(p, json);
    }
}

/// Whether a place is still on a screen that is there (the monitor it was on may be gone).
fn on_a_screen(app: &AppHandle, p: &Placed) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let (mp, ms) = (m.position(), m.size());
        // (the title bar, a little inside the screen: it can be grabbed)
        let (cx, cy) = (p.x + 80, p.y + 20);
        cx >= mp.x && cx < mp.x + ms.width as i32 && cy >= mp.y && cy < mp.y + ms.height as i32
    })
}

/// Open the settings window (on `page`, when it is named), or bring it forward when it is open.
pub fn open(app: &AppHandle, page: Option<&str>) {
    let page = page.filter(|p| PAGES.contains(p));
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(p) = page {
            let _ = app.emit_to(LABEL, "settings-page", p);
        }
        return;
    }
    let url = match page {
        Some(p) => format!("index.html?settings=1&page={p}"),
        None => "index.html?settings=1".to_string(),
    };
    // (a window is not made on the thread that asked: from the tray's menu that is the one that runs the windows, and it waits for itself)
    let app = app.clone();
    std::thread::spawn(move || build(&app, url));
}

fn build(app: &AppHandle, url: String) {
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("NADI Settings")
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .inner_size(920.0, 700.0)
        .min_inner_size(600.0, 460.0)
        .center()
        .focused(true)
        .build();
    let Ok(w) = built else { return };
    crate::lock_down_webview(&w);
    if let Some(p) = load().filter(|p| on_a_screen(app, p)) {
        let _ = w.set_size(PhysicalSize::new(p.w.max(600), p.h.max(460)));
        let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
    }
    let watched = w.clone();
    let handle = app.clone();
    let maximized = std::sync::atomic::AtomicBool::new(false);
    w.on_window_event(move |e| match e {
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => save(&watched),
        // (the button's glyph follows the window: it is maximized by the bar's double click and by the keys too)
        WindowEvent::Resized(_) => {
            let now = watched.is_maximized().unwrap_or(false);
            if maximized.swap(now, std::sync::atomic::Ordering::Relaxed) != now {
                let _ = handle.emit_to(LABEL, "settings-maximized", now);
            }
        }
        _ => {}
    });
}

#[tauri::command]
pub fn open_settings(app: AppHandle, page: Option<String>) {
    open(&app, page.as_deref());
}

/// What the window's own buttons do (the window has no frame of its own to carry them).
#[tauri::command]
pub fn settings_window(window: WebviewWindow, action: String) -> bool {
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "maximize" => {
            let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
        }
        "close" => {
            save(&window);
            let _ = window.close();
        }
        _ => {}
    }
    window.is_maximized().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_is_kept_as_it_was() {
        let p = Placed { x: -20, y: 40, w: 920, h: 700 };
        let back: Placed = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn only_a_page_of_the_window_can_be_asked_for() {
        assert!(PAGES.contains(&"plugins"));
        assert!(!PAGES.contains(&"../x"));
    }
}
