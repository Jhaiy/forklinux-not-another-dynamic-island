//! What a plugin may run, and what it may keep. A module that asks for `permissions.run` may have the host run a command for it
//! and tell it what it printed; one that asks for `permissions.storage` has a small JSON file of its own.
//!
//! A command is allowed only in the shape its manifest lists: `"run": ["git -C * status --porcelain"]` names the program and
//! every argument, and `*` stands for one argument the module chooses (a folder, a file) that does not start with `-`. So a
//! module can ask `git` about a folder, and cannot give it an option of its own (`-c alias.x=!...` would run anything).

use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const NO_WINDOW: u32 = 0x0800_0000;
const MAX_OUT: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(8);
/// the most a plugin may keep
pub const MAX_STORE: usize = 64 * 1024;

/// Does this command line (program first) fit one of the shapes the manifest allows?
pub fn allowed(templates: &[String], line: &[String]) -> bool {
    if line.is_empty() || line.len() > 24 || line.iter().any(|t| t.len() > 400 || t.chars().any(|c| c == '\0' || c == '\n' || c == '\r')) {
        return false;
    }
    templates.iter().any(|t| {
        let toks: Vec<&str> = t.split_whitespace().collect();
        toks.len() == line.len()
            && toks.iter().zip(line).all(|(want, got)| {
                if *want == "*" {
                    !got.is_empty() && !got.starts_with('-')
                } else {
                    want == got
                }
            })
    })
}

/// Run it (program first) with no window, wait up to a few seconds, and say what came of it.
pub fn run(id: &str, line: &[String]) -> Value {
    let mut cmd = Command::new(&line[0]);
    cmd.args(&line[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return json!({ "id": id, "code": -1, "stdout": "" });
    };
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.take(MAX_OUT as u64).read_to_end(&mut buf);
        }
        buf
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if start.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break -2;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    json!({ "id": id, "code": code, "stdout": String::from_utf8_lossy(&bytes).trim_end().to_string() })
}

fn store_path(id: &str) -> Option<PathBuf> {
    Some(crate::settings::data_dir()?.join("plugin-data").join(format!("{id}.json")))
}

/// What a plugin kept (null when it kept nothing).
pub fn store_of(id: &str) -> Value {
    store_path(id).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// Keep this for a plugin (refused when it is more than it may keep).
pub fn keep(id: &str, value: &Value) {
    let Ok(text) = serde_json::to_string(value) else { return };
    if text.len() > MAX_STORE {
        return;
    }
    if let Some(p) = store_path(id) {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn a_command_must_have_the_shape_the_manifest_lists() {
        let t = vec!["git -C * rev-parse --abbrev-ref HEAD".to_string(), "git -C * diff --numstat HEAD".to_string()];
        assert!(allowed(&t, &line("git -C C:/proj rev-parse --abbrev-ref HEAD")));
        assert!(allowed(&t, &line("git -C C:/proj diff --numstat HEAD")));
        // an option of its own, another subcommand, another program, a longer line
        assert!(!allowed(&t, &line("git -C C:/proj -c alias.x=!calc x")));
        assert!(!allowed(&t, &line("git -C C:/proj push")));
        assert!(!allowed(&t, &line("powershell -C x rev-parse --abbrev-ref HEAD")));
        assert!(!allowed(&t, &line("git -C C:/proj rev-parse --abbrev-ref HEAD --extra")));
        // what stands for the folder cannot be an option
        assert!(!allowed(&t, &line("git -C --upload-pack=calc rev-parse --abbrev-ref HEAD")));
        assert!(!allowed(&[], &line("git status")));
    }

    #[test]
    fn a_command_runs_and_says_what_it_printed() {
        let r = run("a", &["cmd".into(), "/C".into(), "echo".into(), "hello".into()]);
        assert_eq!(r["id"], "a");
        assert_eq!(r["code"], 0);
        assert_eq!(r["stdout"], "hello");
        assert_eq!(run("b", &["definitely-not-a-program-nadi".into()])["code"], -1);
    }
}
