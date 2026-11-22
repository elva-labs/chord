//! Codex's profiles: the `<name>.config.toml` files in an account's Codex
//! home, each of which `codex --profile <name>` lays over `config.toml`.
//!
//! The window lists them where a Codex session starts, and a session
//! started under one is given the file's settings as `-c` overrides, in a
//! terminal and in an integrated session alike: `codex app-server` takes
//! no profile, and one filter then serves every path.
//!
//! The file is read as untrusted. It is read only up to [`LARGEST_FILE`],
//! and only settings that pass unchanged through any command line are
//! given: a plain dotted key, and a value that is a boolean, a number, or
//! a short string of letters, digits and `-_.:/@+~` that Codex takes as
//! that same string. No quote, space or other character the Windows
//! command interpreter reads reaches a command line, on any platform.
//! Arrays, dates and longer or other strings are left out, as are the
//! settings in [`KEPT`]. A profile's name is only ever one found among the
//! files.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use toml_edit::{Item, TableLike, Value};

/// What ends a profile's file name.
const SUFFIX: &str = ".config.toml";
/// The largest profile file read, in bytes.
const LARGEST_FILE: u64 = 64 * 1024;
/// The most profiles listed from one home, the first by name.
const MOST_PROFILES: usize = 64;
/// The longest profile name taken.
const LONGEST_NAME: usize = 64;
/// The most settings given from one profile, the first in the file.
const MOST_SETTINGS: usize = 64;
/// The longest dotted key given.
const LONGEST_KEY: usize = 128;
/// The longest value given.
const LONGEST_VALUE: usize = 256;

/// The settings no profile gives, each with every key under it: the tool
/// servers, the workbench's among them; the approval and sandbox a session
/// runs in; the instructions and the subagent switches the workbench
/// gives; and the settings that start programs or pick another profile.
const KEPT: &[&str] = &[
    "mcp_servers",
    "approval_policy",
    "approvals_reviewer",
    "auto_review",
    "sandbox_mode",
    "sandbox_workspace_write",
    "default_permissions",
    "permissions",
    "allow_symlinked_codex_home",
    "windows",
    "developer_instructions",
    "features.multi_agent",
    "features.multi_agent_v2",
    "notify",
    "hooks",
    "profile",
    "profiles",
];

/// A profile as the window lists it: its name, and the model, effort and
/// provider its file sets, where the file sets them in a form that would
/// be given.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    pub name: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub provider: Option<String>,
}

/// The profiles in the Codex home `home`, by name. None where it holds
/// none or cannot be read.
pub fn list(home: &Path) -> Vec<Profile> {
    names(home)
        .into_iter()
        .map(|name| {
            let settings = read(home, &name).unwrap_or_default();
            let set = |key: &str| {
                settings.iter().find_map(|setting| {
                    let value = setting.strip_prefix(key)?.strip_prefix('=')?;
                    Some(value.to_string())
                })
            };
            Profile {
                model: set("model"),
                effort: set("model_reasoning_effort"),
                provider: set("model_provider"),
                name,
            }
        })
        .collect()
}

/// The settings of the profile `name` in the Codex home `home`, each a
/// `key=value` for `-c`, in the file's order. An error where the home
/// holds no profile of that name, or its file cannot be read as TOML.
pub fn settings(home: &Path, name: &str) -> Result<Vec<String>, String> {
    let found = names(home)
        .into_iter()
        .find(|found| found == name)
        .ok_or_else(|| format!("there is no Codex profile {name:?} in {}", home.display()))?;
    read(home, &found)
}

/// The names of the profile files in `home`, sorted.
fn names(home: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(home) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().into_string().ok()?;
            let name = file.strip_suffix(SUFFIX)?;
            (plain_name(name) && entry.path().is_file()).then(|| name.to_string())
        })
        .collect();
    names.sort();
    names.truncate(MOST_PROFILES);
    names
}

/// A name Codex takes for `--profile`, no longer than [`LONGEST_NAME`].
fn plain_name(name: &str) -> bool {
    bare(name) && name.len() <= LONGEST_NAME
}

/// Letters, digits, `_` and `-`, at least one, led by other than `-`: a
/// profile name to Codex, and a bare key to TOML that no command line
/// reads as an option.
fn bare(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// The settings the profile file of `name` gives.
fn read(home: &Path, name: &str) -> Result<Vec<String>, String> {
    let path = home.join(format!("{name}{SUFFIX}"));
    let unread = |e: std::io::Error| format!("could not read {}: {e}", path.display());
    let mut text = String::new();
    fs::File::open(&path)
        .map_err(unread)?
        .take(LARGEST_FILE + 1)
        .read_to_string(&mut text)
        .map_err(unread)?;
    if text.len() as u64 > LARGEST_FILE {
        return Err(format!(
            "{} is larger than the {} KiB a profile is read to",
            path.display(),
            LARGEST_FILE / 1024
        ));
    }
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|e| {
        let at = e.span().map_or(0, |span| span.start).min(text.len());
        let line = text.as_bytes()[..at]
            .iter()
            .filter(|&&b| b == b'\n')
            .count()
            + 1;
        format!("{} is not TOML Codex reads, at line {line}", path.display())
    })?;
    let mut settings = Vec::new();
    flatten(document.as_table(), "", &mut settings);
    settings.truncate(MOST_SETTINGS);
    Ok(settings)
}

/// Each setting under `table`, whose key is `prefix`, that a profile
/// gives, as `key=value`.
fn flatten(table: &dyn TableLike, prefix: &str, settings: &mut Vec<String>) {
    for (key, item) in table.iter() {
        if !bare(key) {
            continue;
        }
        let path = match prefix {
            "" => key.to_string(),
            prefix => format!("{prefix}.{key}"),
        };
        if path.len() > LONGEST_KEY || kept(&path) {
            continue;
        }
        match item {
            Item::Table(table) => flatten(table, &path, settings),
            Item::Value(Value::InlineTable(table)) => flatten(table, &path, settings),
            Item::Value(value) => {
                if let Some(text) = plain_value(value) {
                    settings.push(format!("{path}={text}"));
                }
            }
            Item::None | Item::ArrayOfTables(_) => {}
        }
    }
}

/// Whether the key is one of [`KEPT`] or under one.
fn kept(path: &str) -> bool {
    KEPT.iter().any(|kept| {
        path.strip_prefix(kept)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    })
}

/// The value as Codex reads it back from a `-c`, where it is a boolean, a
/// finite number, or a string Codex takes as itself; None otherwise.
fn plain_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::Boolean(flag) => flag.value().to_string(),
        Value::Integer(number) => number.value().to_string(),
        Value::Float(number) if number.value().is_finite() => {
            Value::from(*number.value()).to_string().trim().to_string()
        }
        Value::String(text) => {
            let text = text.value();
            return plain_string(text).then(|| text.clone());
        }
        _ => return None,
    };
    (text.len() <= LONGEST_VALUE && text.chars().all(plain_char)).then_some(text)
}

/// A string Codex takes from a `-c` as that same string: one that starts
/// as no number, date or quote does, holds no character a shell or the
/// command interpreter reads, and does not parse as a TOML value.
fn plain_string(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_alphabetic() || matches!(c, '/' | '~' | '_' | '@'))
        && text.len() <= LONGEST_VALUE
        && text.chars().all(plain_char)
        && format!("_x_ = {text}")
            .parse::<toml_edit::DocumentMut>()
            .is_err()
}

fn plain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '@' | '+' | '~')
}

#[cfg(test)]
#[path = "codex_profiles_tests.rs"]
mod tests;
