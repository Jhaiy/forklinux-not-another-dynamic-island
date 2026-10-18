//! What the plugins may ask of the island together: a banner that may be shown (muted, do not disturb), the pill the collapsed island
//! shows (the highest of what the plugins offer), and the calls the island's pages make to a plugin.
//!
//! The island itself is a window manager: the pill, the hub, the banners and the floating cards, the head's rows, and the sensors
//! (audio, the media session, which programs have a window, ...). What it shows beyond that comes from plugins, which are folders:
//! a module, a declarative plugin or a face. They reach the screen only through what the host offers them (see plugins.rs).

use crate::plugins::{Host, Offer, Saved};
use crate::IslandState;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// What a plugin's banner may do (see `Host::gate`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Gate {
    /// the plugin is muted
    Muted,
    /// do not disturb: not now
    Held,
    Open,
}

fn gate_for(saved: &Saved, id: &str, priority: i32) -> Gate {
    if saved.muted.iter().any(|m| m == id) {
        Gate::Muted
    } else if saved.dnd && priority < 90 {
        Gate::Held
    } else {
        Gate::Open
    }
}

/// the pill the island should show: the highest of what the plugins offer
fn highest(offers: &HashMap<String, Offer>) -> Option<Offer> {
    offers.values().max_by_key(|o| o.rank).cloned()
}

impl Host {
    pub(crate) fn plugin(&self, id: &str) -> Option<Arc<crate::plugins::Plugin>> {
        self.plugins.lock().unwrap().iter().find(|p| p.manifest.id == id).cloned()
    }

    pub fn gate(&self, id: &str, priority: i32) -> Gate {
        // (a part of a bundle is muted with its bundle)
        let id = self.plugin(id).map(|p| if p.manifest.parent.is_empty() { p.manifest.id.clone() } else { p.manifest.parent.clone() }).unwrap_or_else(|| id.to_string());
        gate_for(&self.saved.lock().unwrap(), &id, priority)
    }

    pub fn is_on_id(&self, id: &str) -> bool {
        match self.plugin(id) {
            Some(p) => self.is_on(&p),
            None => false,
        }
    }

    /// The pill the island should show now, if a plugin asks for one.
    pub fn pill(&self) -> Option<Offer> {
        let offers = self.offers.lock().unwrap();
        // (a plugin that offers a resting island shows that, never its pill: the island is what a pill became)
        let shown: HashMap<String, Offer> = offers.iter().filter(|(id, _)| !self.island_instead(id)).map(|(k, v)| (k.clone(), v.clone())).collect();
        highest(&shown)
    }

    /// Does this plugin offer a resting island? (Then its pill never shows: with the island off, the user's own island is what
    /// rests, and nothing shows for the plugin. A part of a bundle carries its bundle's islands.)
    fn island_instead(&self, id: &str) -> bool {
        self.plugin(id).is_some_and(|p| !p.manifest.rests.is_empty())
    }

    /// A plugin asks the others to be quiet (a game is on the screen).
    pub fn quiet(&self) -> bool {
        !self.quiet.lock().unwrap().is_empty()
    }

    /// A call of the island's pages to a plugin: a module is told by an `action` event (see `act`).
    pub fn call(&self, id: &str, cmd: &str, args: &Value) -> Result<Value, String> {
        self.act(id, cmd, args.clone())
    }
}

/// What the hub and the floating cards draw: the cards of the plugins (blocks), the rings they show and the pills they offer.
#[derive(Serialize)]
pub struct Snapshot {
    plugins: Vec<crate::plugins::CardOut>,
    /// the rings the plugins show in the hub, by plugin id
    rings: Map<String, Value>,
    /// the pills the plugins offer
    pills: Vec<crate::plugins::PillOut>,
}

#[tauri::command]
pub fn get_activity(window: tauri::WebviewWindow) -> Snapshot {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    let (pills, rings) = state.plugins.pills_and_rings();
    Snapshot { plugins: state.plugins.cards(), rings, pills }
}

/// The pills the plugins offer and the rings they show, for a page that has just opened or a pill that has just come.
#[tauri::command]
pub fn plugin_pills(window: tauri::WebviewWindow) -> Value {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>();
    let (pills, rings) = state.plugins.pills_and_rings();
    json!({ "pills": pills, "rings": rings })
}

/// Run a plugin call off the UI thread: some of them wait for the browser or the disk.
#[tauri::command]
pub async fn plugin_call(window: tauri::WebviewWindow, id: String, cmd: String, args: Option<Value>) -> Result<Value, String> {
    use tauri::Manager;
    let state = window.state::<Arc<IslandState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.plugins.call(&id, &cmd, &args.unwrap_or(json!(null))))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // (no `Host` is made here: it holds what the window code needs, which a test program cannot load)

    fn offer(id: &str, rank: i32, brief: bool) -> Offer {
        Offer { id: id.into(), w: 260.0, h: 40.0, rank, brief }
    }

    #[test]
    fn a_banner_is_muted_or_held_or_open() {
        let mut saved = Saved::default();
        assert_eq!(gate_for(&saved, "a", 0), Gate::Open);
        saved.muted.push("a".into());
        assert_eq!(gate_for(&saved, "a", 100), Gate::Muted);
        assert_eq!(gate_for(&saved, "b", 0), Gate::Open);
        // do not disturb holds back all but what rings (90 and more)
        saved.dnd = true;
        assert_eq!(gate_for(&saved, "b", 89), Gate::Held);
        assert_eq!(gate_for(&saved, "b", 90), Gate::Open);
        // (muted stays muted)
        assert_eq!(gate_for(&saved, "a", 90), Gate::Muted);
    }

    #[test]
    fn the_island_shows_the_highest_pill_offered() {
        let mut offers: HashMap<String, Offer> = HashMap::new();
        assert_eq!(highest(&offers), None);
        offers.insert("work".into(), offer("work", 10, false));
        offers.insert("games".into(), offer("game", 20, false));
        assert_eq!(highest(&offers).map(|o| o.id), Some("game".to_string()));
        offers.insert("claude-code".into(), offer("usage_peek", 100, true));
        assert_eq!(highest(&offers).map(|o| o.id), Some("usage_peek".to_string()));
        assert!(highest(&offers).unwrap().brief);
        offers.remove("claude-code");
        offers.remove("games");
        assert_eq!(highest(&offers).map(|o| o.id), Some("work".to_string()));
    }
}
