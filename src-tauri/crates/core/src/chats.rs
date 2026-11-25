//! The folder chats run in: one folder under the workbench's home that
//! every conversation belonging to no project starts in. The agents read
//! their instructions and settings from the folder they run in, so what is
//! in it reaches every chat. The workbench writes only its hooks there,
//! and says what else it finds; it never removes anything.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hook::{CLAUDE_LOCAL, CODEX_CONFIG, CODEX_HOOKS};

/// The chats folder, and the files in it that the workbench did not write
/// and that can change what an agent does there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chats {
    pub dir: String,
    pub foreign: Vec<String>,
}

/// The chats folder in the workbench's directory in the user's home.
pub fn path(home: &Path) -> PathBuf {
    crate::home::dir(home).join("chats")
}

/// The files an agent reads its instructions or its servers from, at the
/// top of the folder it runs in.
const INSTRUCTIONS: [&str; 5] = [
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    "AGENTS.override.md",
    ".mcp.json",
];

/// The agents' own folders, with the one file the hooks write in each
/// besides Codex's config.
const HARNESS: [(&str, &[&str]); 2] = [
    (".claude", &["settings.local.json"]),
    (".codex", &["hooks.json", "config.toml"]),
];

/// Makes the folder where there is none, readable by the user alone. A
/// link, even to a folder, and anything that is not a folder are refused,
/// so the chats never run somewhere the name does not say.
pub fn make(dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!("{} is a link, not a folder", dir.display()));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(format!("{} is not a folder", dir.display()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        Err(error) => return Err(format!("could not read {}: {error}", dir.display())),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not make {} private: {e}", dir.display()))?;
    }
    Ok(())
}

/// The files in the folder, as paths inside it and in order, that can
/// change what an agent does there and that the workbench did not write:
/// an instruction or server file, anything in the agents' own folders
/// other than the files the hooks write, and those files where they hold
/// more than the hooks put in them.
pub fn foreign(home: &Path, dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = INSTRUCTIONS
        .iter()
        .filter(|name| std::fs::symlink_metadata(dir.join(name)).is_ok())
        .map(|name| name.to_string())
        .collect();
    for (folder, own) in HARNESS {
        let Ok(entries) = std::fs::read_dir(dir.join(folder)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if own.contains(&name.as_str()) || is_written(&name) {
                continue;
            }
            found.push(format!("{folder}/{name}"));
        }
    }
    for file in [CLAUDE_LOCAL, CODEX_HOOKS, CODEX_CONFIG] {
        if crate::hook::holds_more_than_ours(home, dir, file) {
            found.push(file.to_string());
        }
    }
    found.sort();
    found
}

/// Whether a name is one the hooks give a file while they write it, before
/// it takes its own name.
fn is_written(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".tmp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    #[test]
    fn the_folder_is_made_where_there_is_none() {
        let home = Scratch::new("chats-make");
        let dir = path(&home);
        make(&dir).unwrap();
        assert!(dir.is_dir());
        make(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = Scratch::new("chats-private");
        let dir = path(&home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        make(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_file_in_its_place_is_refused() {
        let home = Scratch::new("chats-file");
        let dir = path(&home);
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::fs::write(&dir, "").unwrap();
        let error = make(&dir).unwrap_err();
        assert!(error.contains("is not a folder"), "{error}");
        assert!(dir.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_its_place_is_refused_even_to_a_folder() {
        let home = Scratch::new("chats-link");
        let dir = path(&home);
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        let error = make(&dir).unwrap_err();
        assert!(error.contains("is a link"), "{error}");
    }

    #[test]
    fn a_folder_with_only_the_hooks_holds_nothing_foreign() {
        let home = Scratch::new("chats-own");
        let dir = path(&home);
        make(&dir).unwrap();
        let daemon = crate::hook::daemon_path(&home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();
        crate::hook::install(&home, &dir, &[], &Default::default()).unwrap();
        for file in [CLAUDE_LOCAL, CODEX_HOOKS, CODEX_CONFIG] {
            assert!(dir.join(file).is_file(), "{file}");
        }
        std::fs::write(dir.join("notes.txt"), "what a chat wrote").unwrap();
        assert_eq!(foreign(&home, &dir), Vec::<String>::new());
    }

    #[test]
    fn what_claude_code_keeps_of_the_users_answers_is_not_foreign() {
        let home = Scratch::new("chats-permissions");
        let dir = path(&home);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(
            dir.join(CLAUDE_LOCAL),
            r#"{"permissions":{"allow":["WebFetch(domain:example.com)"]}}"#,
        )
        .unwrap();
        assert_eq!(foreign(&home, &dir), Vec::<String>::new());
    }

    #[test]
    fn instructions_settings_and_hooks_not_the_workbenchs_are_named() {
        let home = Scratch::new("chats-foreign");
        let dir = path(&home);
        make(&dir).unwrap();
        crate::hook::install(&home, &dir, &[], &Default::default()).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "be terse").unwrap();
        std::fs::write(dir.join("AGENTS.md"), "be terse").unwrap();
        std::fs::create_dir_all(dir.join(".claude").join("commands")).unwrap();
        std::fs::write(dir.join(".claude").join("settings.json"), "{}").unwrap();
        let mut settings = crate::hook::read_settings(&dir.join(CLAUDE_LOCAL));
        settings["hooks"]["PreToolUse"] =
            serde_json::json!([{ "hooks": [{ "type": "command", "command": "theirs" }] }]);
        std::fs::write(
            dir.join(CLAUDE_LOCAL),
            serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join(CODEX_CONFIG),
            "[mcp_servers.theirs]\ncommand = \"theirs\"\n",
        )
        .unwrap();
        assert_eq!(
            foreign(&home, &dir),
            vec![
                ".claude/commands",
                ".claude/settings.json",
                CLAUDE_LOCAL,
                CODEX_CONFIG,
                "AGENTS.md",
                "CLAUDE.md",
            ]
        );
    }

    #[test]
    fn a_hooks_file_that_cannot_be_read_is_named() {
        let home = Scratch::new("chats-unreadable");
        let dir = path(&home);
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(dir.join(CODEX_HOOKS), "not json").unwrap();
        assert_eq!(foreign(&home, &dir), vec![CODEX_HOOKS]);
    }
}
