//! System meters: the CPU, memory and graphics rings in the head of the expanded island (a plugin, see native.rs). The
//! rings are widgets drawn by the page (`ui/plugins/system-meters.js`) from `get_sys_stats` and `get_gpu_pct`; this is
//! the plugin's switch.

use crate::native::{manifest_of, Adopted, Native};
use crate::plugins::Manifest;
use serde_json::Value;

/// what the plugin is, as the island's list shows it
pub fn manifest() -> Manifest {
    manifest_of(include_str!("system_meters.json"))
}

/// The rings used to be part of the island: an install that has run before keeps them on, a new one starts blank.
pub fn adopted(old: &Value, default_on: bool) -> Adopted {
    let had_run = old.as_object().map_or(false, |o| !o.is_empty());
    Adopted { on: had_run || default_on, values: Default::default() }
}

pub struct SystemMeters;

impl Native for SystemMeters {
    fn manifest(&self) -> Manifest {
        manifest()
    }

    fn adopt(&self, old: &Value, default_on: bool) -> Adopted {
        adopted(old, default_on)
    }
}
