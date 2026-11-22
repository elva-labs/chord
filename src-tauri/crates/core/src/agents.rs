//! Agents: a title and a description a session is told to work by, and
//! what it runs on.
//!
//! The description's first line says in a few words what the agent does,
//! and is what menus show; the rest is what the session is told. An agent
//! may name a model on one harness, an effort, and whether it only reads.
//! A session keeps its own for each one the agent leaves out.
//!
//! The settings file holds the user's own agents. The agents Chord ships
//! are the window's and are never stored; their titles are here so no
//! agent of the user's takes one. The agents installed for a harness are
//! the harness's own, and are read here, never written.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use toml_edit::{DocumentMut, TableLike};

use crate::workflow::AGENTS as HARNESSES;

/// How many agents the settings may hold, how long a title may be, how
/// long a description, and how long a model's name or an effort.
pub const MOST_AGENTS: usize = 32;
pub const LONGEST_TITLE: usize = 40;
pub const LONGEST_DESCRIPTION: usize = 8000;
const LONGEST_WORD: usize = 40;

/// The titles of the agents Chord ships.
pub const SHIPPED_TITLES: &[&str] = &[
    "Researcher",
    "Developer",
    "Debugger",
    "Tester",
    "Reviewer",
    "Security reviewer",
    "Cloud architect",
    "Docs writer",
];

/// A model on one harness. A field this version does not know is kept as
/// written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentModel {
    pub harness: String,
    pub model: String,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

/// One of the user's own agents. A field this version does not know is
/// kept as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub model: Option<AgentModel>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub reads_only: bool,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

/// An agent in the settings file that does not read or keep the rules,
/// with the rule it breaks, its title where it has one, and where it
/// stands in the file's list.
#[derive(Debug, Clone, PartialEq)]
pub struct SetAside {
    pub at: usize,
    pub title: String,
    pub reason: String,
    pub entry: Value,
}

const SHAPE: &str = "agents is a list of agents";
const ONE_SHAPE: &str =
    "an agent is a title, a description, a model or none, an effort or none, and whether it reads only";

/// A model's name or an effort: one word, short, with nothing unprintable.
fn is_word(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= LONGEST_WORD
        && !text.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn check(agent: &Agent) -> Result<(), String> {
    let title = agent.title.trim();
    if title.is_empty()
        || title.chars().count() > LONGEST_TITLE
        || title.chars().any(char::is_control)
    {
        return Err(format!(
            "an agent's title is a few words, {LONGEST_TITLE} characters at most, not {:?}",
            agent.title
        ));
    }
    if SHIPPED_TITLES
        .iter()
        .any(|shipped| shipped.eq_ignore_ascii_case(title))
    {
        return Err(format!(
            "{title} is an agent Chord ships, so no agent of your own can be called that"
        ));
    }
    let description = agent.description.trim();
    if description.is_empty() || description.chars().count() > LONGEST_DESCRIPTION {
        return Err(format!(
            "{title} needs a description, {LONGEST_DESCRIPTION} characters at most, whose first line says what it does"
        ));
    }
    if let Some(model) = &agent.model {
        if !HARNESSES.contains(&model.harness.as_str()) {
            return Err(format!(
                "{title} names the harness {:?}, which is one of {}",
                model.harness,
                HARNESSES.join(", ")
            ));
        }
        if !is_word(&model.model) {
            return Err(format!(
                "{title} names a model that is one word, {LONGEST_WORD} characters at most, not {:?}",
                model.model
            ));
        }
    }
    if let Some(effort) = &agent.effort {
        if !is_word(effort) {
            return Err(format!(
                "{title} names an effort that is one word, not {effort:?}"
            ));
        }
    }
    Ok(())
}

/// The agent an entry holds, its title and description trimmed, or the
/// reason it will not do beside the agents read before it. Titles are
/// unique, ignoring case.
fn one(entry: &Value, earlier: &[Agent]) -> Result<Agent, String> {
    let mut agent: Agent = serde_json::from_value(entry.clone()).map_err(|_| ONE_SHAPE)?;
    check(&agent)?;
    agent.title = agent.title.trim().to_string();
    agent.description = agent.description.trim().to_string();
    if earlier
        .iter()
        .any(|kept| kept.title.eq_ignore_ascii_case(&agent.title))
    {
        return Err(format!("there is already an agent called {}", agent.title));
    }
    Ok(agent)
}

/// The agents a value holds, or the reason one will not do. A change sets
/// the agents this way, whole or not at all.
pub fn read(value: &Value) -> Result<Vec<Agent>, String> {
    let list = value.as_array().ok_or(SHAPE)?;
    if list.len() > MOST_AGENTS {
        return Err(format!("the settings hold {MOST_AGENTS} agents at most"));
    }
    let mut agents: Vec<Agent> = Vec::with_capacity(list.len());
    for entry in list {
        let agent = one(entry, &agents)?;
        agents.push(agent);
    }
    Ok(agents)
}

/// The agents a settings file's list holds, read one at a time: each one
/// that does not read or keep the rules, one whose title an earlier one
/// has and one past the most the settings hold is set aside with the
/// reason, and the rest are used.
pub fn read_lenient(list: &[Value]) -> (Vec<Agent>, Vec<SetAside>) {
    let mut agents: Vec<Agent> = Vec::new();
    let mut aside = Vec::new();
    for (at, entry) in list.iter().enumerate() {
        let reason = match one(entry, &agents) {
            Ok(agent) if agents.len() < MOST_AGENTS => {
                agents.push(agent);
                continue;
            }
            Ok(_) => format!("the settings hold {MOST_AGENTS} agents at most"),
            Err(reason) => reason,
        };
        let title = entry.get("title").and_then(Value::as_str).unwrap_or("");
        aside.push(SetAside {
            at,
            title: title.trim().to_string(),
            reason,
            entry: entry.clone(),
        });
    }
    (agents, aside)
}

/// Where an installed agent comes from: Claude Code's own folder under the
/// account, the project's, or Codex's configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Claude,
    Project,
    Codex,
}

/// An agent the user installed for a harness, as Chord reads it. The
/// harness keeps it; Chord lists it and never writes it. `text` is what a
/// session is told, and `path` the file it was read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub source: Source,
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub reads_only: bool,
    pub text: String,
    pub path: PathBuf,
}

/// How many installed agents are read from each place, and the largest
/// file read for one.
const MOST_INSTALLED: usize = 64;
const LARGEST_FILE: u64 = 256 * 1024;

/// The tools that change files. A Claude Code agent whose tools leave all
/// of them out reads only.
const CHANGING_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// The agents installed for each harness, in the order a list shows them:
/// Claude Code's own under `claude_dir`, the project's, then Codex's roles
/// under `codex_home`, each by name. `home` is the user's, for a path
/// written with `~`. What cannot be read is left out.
pub fn installed(
    home: &Path,
    project: &Path,
    claude_dir: &Path,
    codex_home: &Path,
) -> Vec<InstalledAgent> {
    let mut agents = claude_agents(&claude_dir.join("agents"), Source::Claude, None);
    agents.extend(claude_agents(
        &project.join(".claude").join("agents"),
        Source::Project,
        Some(project),
    ));
    agents.extend(codex_agents(home, codex_home));
    agents
}

fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > LARGEST_FILE {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Whether a file, its links followed, is inside a folder.
fn lies_within(path: &Path, folder: &Path) -> bool {
    match (fs::canonicalize(path), fs::canonicalize(folder)) {
        (Ok(path), Ok(folder)) => path.starts_with(folder),
        _ => false,
    }
}

/// Claude Code's agents in a folder: each a Markdown file whose
/// frontmatter names it and says what it does, and whose body is what the
/// session is told. Of files that give the same name, ignoring case, the
/// first by path is read. A file that links out of `within`, where one is
/// given, is left out.
fn claude_agents(dir: &Path, source: Source, within: Option<&Path>) -> Vec<InstalledAgent> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    paths.sort();
    let mut agents: Vec<InstalledAgent> = Vec::new();
    for path in paths {
        if agents.len() == MOST_INSTALLED {
            break;
        }
        if within.is_some_and(|folder| !lies_within(&path, folder)) {
            continue;
        }
        let Some(agent) = claude_agent(path, source) else {
            continue;
        };
        if agents
            .iter()
            .any(|kept| kept.name.eq_ignore_ascii_case(&agent.name))
        {
            continue;
        }
        agents.push(agent);
    }
    agents.sort_by_key(|agent| agent.name.to_lowercase());
    agents
}

fn claude_agent(path: PathBuf, source: Source) -> Option<InstalledAgent> {
    let file = read_small(&path)?;
    let (fields, body) = frontmatter(&file)?;
    let text_of = |key: &str| {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .and_then(|(_, value)| match value {
                Field::Text(text) => Some(text.trim().to_string()),
                Field::List(_) => None,
            })
            .filter(|text| !text.is_empty())
    };
    let name = text_of("name")?;
    let description = text_of("description")?;
    let model = text_of("model").filter(|model| model != "inherit");
    let tools: Option<Vec<String>> =
        fields
            .iter()
            .find(|(name, _)| name == "tools")
            .map(|(_, value)| match value {
                Field::Text(text) => text
                    .split(',')
                    .map(|tool| tool.trim().to_string())
                    .collect(),
                Field::List(list) => list.clone(),
            });
    let reads_only = tools.is_some_and(|tools| {
        !tools.iter().any(|tool| {
            tool == "*"
                || CHANGING_TOOLS
                    .iter()
                    .any(|changing| tool == changing || tool.starts_with(&format!("{changing}(")))
        })
    });
    Some(InstalledAgent {
        source,
        name,
        description,
        model,
        effort: None,
        reads_only,
        text: body.trim().to_string(),
        path,
    })
}

/// A value in a file's frontmatter: one piece of text, or a list of them.
#[derive(Debug, PartialEq)]
enum Field {
    Text(String),
    List(Vec<String>),
}

/// The top-level fields of a Markdown file's frontmatter and the body after
/// it, or None for a file with none. This reads the part of YAML an agent's
/// frontmatter uses: plain, quoted and block text, and lists written either
/// way. Anything else under a key is skipped.
fn frontmatter(file: &str) -> Option<(Vec<(String, Field)>, &str)> {
    let file = file.strip_prefix('\u{feff}').unwrap_or(file);
    let rest = file
        .strip_prefix("---\n")
        .or_else(|| file.strip_prefix("---\r\n"))?;
    let mut lines: Vec<&str> = Vec::new();
    let mut body = "";
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        at += line.len();
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare == "---" {
            body = &rest[at..];
            break;
        }
        lines.push(bare);
        if at == rest.len() {
            return None;
        }
    }
    if at == 0 {
        return None;
    }
    let mut fields = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.starts_with([' ', '\t', '#']) || line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        let mut following: Vec<&str> = Vec::new();
        while index < lines.len()
            && (lines[index].starts_with([' ', '\t']) || lines[index].trim().is_empty())
        {
            following.push(lines[index]);
            index += 1;
        }
        while following.last().is_some_and(|line| line.trim().is_empty()) {
            following.pop();
        }
        if let Some(field) = field(value, &following) {
            fields.push((key, field));
        }
    }
    Some((fields, body))
}

fn field(value: &str, following: &[&str]) -> Option<Field> {
    if value.starts_with(['|', '>']) {
        let lines = unindent(following);
        let text = if value.starts_with('|') {
            lines.join("\n")
        } else {
            fold(&lines)
        };
        return Some(Field::Text(text));
    }
    if value.is_empty() {
        let items: Vec<String> = following
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .map(|line| line.strip_prefix('-').map(|item| unquote(item.trim())))
            .collect::<Option<_>>()?;
        return (!items.is_empty()).then_some(Field::List(items));
    }
    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        return Some(Field::List(
            inner
                .split(',')
                .map(|item| unquote(item.trim()))
                .filter(|item| !item.is_empty())
                .collect(),
        ));
    }
    if value.starts_with(['"', '\'']) {
        let mut whole = value.to_string();
        for line in following {
            whole.push(' ');
            whole.push_str(line.trim());
        }
        return Some(Field::Text(unquote(&whole)));
    }
    let plain = match value.find(" #") {
        Some(at) => &value[..at],
        None => value,
    };
    let mut text = plain.trim().to_string();
    for line in following {
        text.push(' ');
        text.push_str(line.trim());
    }
    Some(Field::Text(text))
}

/// Block text's lines with the indent of its first line taken off.
fn unindent(lines: &[&str]) -> Vec<String> {
    let indent = lines
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end().to_string())
        .collect()
}

/// Folded block text: lines joined by a space, a blank line a break.
fn fold(lines: &[String]) -> String {
    let mut text = String::new();
    let mut fresh = true;
    for line in lines {
        if line.is_empty() {
            text.push('\n');
            fresh = true;
        } else {
            if !fresh {
                text.push(' ');
            }
            text.push_str(line);
            fresh = false;
        }
    }
    text
}

/// Text that may be quoted, without its quotes. Double quotes take the
/// escapes an agent's text uses; single quotes take a doubled quote.
fn unquote(text: &str) -> String {
    if let Some(inner) = text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            }
        }
        return out;
    }
    if let Some(inner) = text.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')) {
        return inner.replace("''", "'");
    }
    text.to_string()
}

/// Codex's roles: each an `[agents.<name>]` table in its configuration,
/// with a description and a file of its own, which holds what the session
/// is told, its model, its effort and its sandbox. Read only means the
/// sandbox is read-only.
fn codex_agents(home: &Path, codex_home: &Path) -> Vec<InstalledAgent> {
    let config = codex_home.join("config.toml");
    let Some(document) = read_small(&config).and_then(|text| text.parse::<DocumentMut>().ok())
    else {
        return Vec::new();
    };
    let Some(roles) = document.get("agents").and_then(|item| item.as_table_like()) else {
        return Vec::new();
    };
    let text_in = |table: &dyn TableLike, key: &str| {
        table
            .get(key)
            .and_then(|item| item.as_str())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    };
    let mut agents = Vec::new();
    for (name, item) in roles.iter() {
        let Some(role) = item.as_table_like() else {
            continue;
        };
        let file = text_in(role, "config_file").map(|file| {
            let file = Path::new(&file);
            if file.starts_with("~") {
                crate::account::expand(home, &file.to_string_lossy())
            } else {
                codex_home.join(file)
            }
        });
        let own = file
            .as_deref()
            .and_then(read_small)
            .and_then(|text| text.parse::<DocumentMut>().ok());
        let own_text = |key: &str| own.as_ref().and_then(|own| text_in(own.as_table(), key));
        let description = text_in(role, "description").unwrap_or_default();
        let text = own_text("developer_instructions").unwrap_or_default();
        if description.is_empty() && text.is_empty() {
            continue;
        }
        agents.push(InstalledAgent {
            source: Source::Codex,
            name: name.to_string(),
            description,
            model: own_text("model"),
            effort: own_text("model_reasoning_effort"),
            reads_only: own_text("sandbox_mode").as_deref() == Some("read-only"),
            text,
            path: if own.is_some() {
                file.unwrap_or(config.clone())
            } else {
                config.clone()
            },
        });
        if agents.len() == MOST_INSTALLED {
            break;
        }
    }
    agents.sort_by_key(|agent| agent.name.to_lowercase());
    agents
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn one(fields: Value) -> Result<Vec<Agent>, String> {
        read(&json!([fields]))
    }

    #[test]
    fn an_agent_is_a_title_and_a_description_and_the_rest_may_be_left_out() {
        let read = one(json!({ "title": " Migrations ", "description": "Checks migrations.\n\nYou read them.\n" })).unwrap();
        assert_eq!(read[0].title, "Migrations");
        assert_eq!(read[0].description, "Checks migrations.\n\nYou read them.");
        assert_eq!(read[0].model, None);
        assert_eq!(read[0].effort, None);
        assert!(!read[0].reads_only);
        let full = one(json!({
            "title": "Migrations",
            "description": "Checks migrations.",
            "model": { "harness": "codex", "model": "gpt-5.5" },
            "effort": "high",
            "readsOnly": true,
        }))
        .unwrap();
        assert_eq!(full[0].model.as_ref().unwrap().harness, "codex");
        assert_eq!(full[0].effort.as_deref(), Some("high"));
        assert!(full[0].reads_only);
        assert_eq!(
            serde_json::to_value(&full[0]).unwrap(),
            json!({
                "title": "Migrations",
                "description": "Checks migrations.",
                "model": { "harness": "codex", "model": "gpt-5.5" },
                "effort": "high",
                "readsOnly": true,
            })
        );
    }

    #[test]
    fn an_agent_that_will_not_do_says_why() {
        let base = || json!({ "title": "Migrations", "description": "Checks migrations." });
        let with = |field: &str, value: Value| {
            let mut fields = base();
            fields[field] = value;
            one(fields).unwrap_err()
        };
        assert!(with("title", json!("  ")).contains("title"));
        assert!(with("title", json!("x".repeat(LONGEST_TITLE + 1))).contains("title"));
        assert!(with("title", json!("a\nb")).contains("title"));
        assert!(with("title", json!("reviewer")).contains("Chord ships"));
        assert!(with("description", json!(" \n ")).contains("description"));
        assert!(
            with("description", json!("x".repeat(LONGEST_DESCRIPTION + 1))).contains("description")
        );
        assert!(
            with("model", json!({ "harness": "gemini", "model": "pro" }))
                .contains("claude-code, codex")
        );
        assert!(
            with("model", json!({ "harness": "codex", "model": "two words" })).contains("one word")
        );
        assert!(with("model", json!({ "agent": "codex", "model": "gpt" })).contains("an agent is"));
        assert!(with("effort", json!("very high")).contains("effort"));
        assert!(with("readsOnly", json!("yes")).contains("an agent is"));
        assert!(read(&json!({ "Migrations": {} }))
            .unwrap_err()
            .contains("agents is a list"));
    }

    #[test]
    fn a_field_a_later_version_adds_is_kept_as_written() {
        let written = json!({
            "title": "Migrations",
            "description": "Checks migrations.",
            "model": { "harness": "codex", "model": "gpt-5.5", "profile": "fast" },
            "effort": null,
            "readsOnly": false,
            "colour": "red",
        });
        let read = one(written.clone()).unwrap();
        assert_eq!(read[0].later["colour"], json!("red"));
        assert_eq!(
            read[0].model.as_ref().unwrap().later["profile"],
            json!("fast")
        );
        assert_eq!(serde_json::to_value(&read[0]).unwrap(), written);
    }

    #[test]
    fn a_files_agents_are_read_one_at_a_time_and_the_rest_set_aside() {
        let agent = |title: &str| json!({ "title": title, "description": "Does it." });
        let mut list = vec![
            agent("Migrations"),
            json!({ "title": "Broken", "description": "Does it.", "model": "opus" }),
            agent("Tester"),
            agent("migrations"),
            json!(7),
        ];
        list.extend((0..MOST_AGENTS).map(|n| agent(&format!("Agent {n}"))));
        let (kept, aside) = read_lenient(&list);
        assert_eq!(kept.len(), MOST_AGENTS);
        assert_eq!(kept[0].title, "Migrations");
        assert_eq!(
            kept[MOST_AGENTS - 1].title,
            format!("Agent {}", MOST_AGENTS - 2)
        );
        let set: Vec<(usize, &str)> = aside
            .iter()
            .map(|entry| (entry.at, entry.title.as_str()))
            .collect();
        assert_eq!(
            set,
            [
                (1, "Broken"),
                (2, "Tester"),
                (3, "migrations"),
                (4, ""),
                (list.len() - 1, &*format!("Agent {}", MOST_AGENTS - 1)),
            ]
        );
        assert!(aside[0].reason.contains("an agent is"));
        assert!(aside[1].reason.contains("Chord ships"));
        assert!(aside[2].reason.contains("already"));
        assert!(aside[4].reason.contains("at most"));
        assert_eq!(aside[0].entry, list[1]);
    }

    #[test]
    fn titles_are_unique_ignoring_case_and_the_list_has_a_limit() {
        let agent = |title: &str| json!({ "title": title, "description": "Does it." });
        let twice = read(&json!([agent("Migrations"), agent("migrations ")])).unwrap_err();
        assert!(twice.contains("already"), "{twice}");
        let most: Vec<Value> = (0..MOST_AGENTS)
            .map(|n| agent(&format!("Agent {n}")))
            .collect();
        assert_eq!(
            read(&Value::Array(most.clone())).unwrap().len(),
            MOST_AGENTS
        );
        let mut over = most;
        over.push(agent("One more"));
        assert!(read(&Value::Array(over)).unwrap_err().contains("at most"));
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn claude_codes_agents_are_read_from_the_account_and_the_project() {
        let home = crate::scratch::Scratch::new("agents-home");
        let project = crate::scratch::Scratch::new("agents-project");
        let claude = home.join(".claude");
        write(
            &claude.join("agents").join("reviewer.md"),
            "---\nname: code-reviewer\ndescription: \"Reviews code.\\nUse after a change.\"\ntools: Read, Grep, Glob\nmodel: opus\n---\n\nYou review code.\n",
        );
        write(
            &claude.join("agents").join("builder.md"),
            "---\nname: builder\ndescription: >\n  Builds things\n  end to end.\ntools:\n  - Read\n  - Edit\nmodel: inherit\ncolor: blue\n---\nYou build.\n",
        );
        write(&claude.join("agents").join("notes.txt"), "not an agent");
        write(
            &claude.join("agents").join("bare.md"),
            "No frontmatter here.\n",
        );
        write(
            &claude.join("agents").join("nameless.md"),
            "---\ndescription: Has no name.\n---\nBody.\n",
        );
        write(
            &project.join(".claude").join("agents").join("migrations.md"),
            "---\nname: migrations\ndescription: Checks migrations for locks.\n---\nYou read migrations.\n",
        );
        let agents = installed(&home, &project, &claude, &home.join(".codex"));
        let names: Vec<(&str, Source)> = agents
            .iter()
            .map(|agent| (agent.name.as_str(), agent.source))
            .collect();
        assert_eq!(
            names,
            [
                ("builder", Source::Claude),
                ("code-reviewer", Source::Claude),
                ("migrations", Source::Project),
            ]
        );
        let reviewer = &agents[1];
        assert_eq!(reviewer.description, "Reviews code.\nUse after a change.");
        assert_eq!(reviewer.model.as_deref(), Some("opus"));
        assert_eq!(reviewer.effort, None);
        assert!(reviewer.reads_only);
        assert_eq!(reviewer.text, "You review code.");
        assert_eq!(reviewer.path, claude.join("agents").join("reviewer.md"));
        let builder = &agents[0];
        assert_eq!(builder.description, "Builds things end to end.");
        assert_eq!(builder.model, None);
        assert!(!builder.reads_only);
        assert!(
            !agents[2].reads_only,
            "an agent with every tool changes files"
        );
        assert_eq!(
            serde_json::to_value(&agents[2]).unwrap()["source"],
            json!("project")
        );
    }

    #[test]
    fn the_installed_agents_of_a_place_are_bounded_and_unique_by_name() {
        let home = crate::scratch::Scratch::new("agents-bounds-home");
        let claude = home.join(".claude");
        let place = claude.join("agents");
        let agent = |name: &str, body: &str| {
            format!("---\nname: {name}\ndescription: Does it.\n---\n{body}\n")
        };
        for n in 0..=MOST_INSTALLED {
            write(
                &place.join(format!("agent-{n:03}.md")),
                &agent(&format!("agent-{n:03}"), "First."),
            );
        }
        // Read after agent-000.md by path, so the first of the name stands.
        write(&place.join("agent-000x.md"), &agent("Agent-000", "Copy."));
        write(
            &place.join("aaa-large.md"),
            &agent("large", &"x".repeat(LARGEST_FILE as usize)),
        );
        let agents = installed(&home, &home.join("project"), &claude, &home.join("none"));
        assert_eq!(agents.len(), MOST_INSTALLED);
        assert_eq!(agents[0].name, "agent-000");
        assert_eq!(agents[0].text, "First.");
        assert_eq!(
            agents[MOST_INSTALLED - 1].name,
            format!("agent-{:03}", MOST_INSTALLED - 1)
        );
        assert!(agents.iter().all(|agent| agent.name != "large"));
    }

    #[cfg(unix)]
    #[test]
    fn a_project_agent_that_links_out_of_the_project_is_left_out() {
        use std::os::unix::fs::symlink;
        let home = crate::scratch::Scratch::new("agents-links-home");
        let project = home.join("project");
        let place = project.join(".claude").join("agents");
        let agent = |name: &str| format!("---\nname: {name}\ndescription: Does it.\n---\nBody.\n");
        write(&home.join("outside.md"), &agent("outside"));
        write(&project.join("docs").join("inside.md"), &agent("inside"));
        write(&place.join("plain.md"), &agent("plain"));
        symlink(home.join("outside.md"), place.join("outside.md")).unwrap();
        symlink(
            project.join("docs").join("inside.md"),
            place.join("inside.md"),
        )
        .unwrap();
        let claude = home.join(".claude");
        fs::create_dir_all(claude.join("agents")).unwrap();
        symlink(
            home.join("outside.md"),
            claude.join("agents").join("mine.md"),
        )
        .unwrap();
        let names: Vec<(String, Source)> = installed(&home, &project, &claude, &home.join("none"))
            .into_iter()
            .map(|agent| (agent.name, agent.source))
            .collect();
        assert_eq!(
            names,
            [
                ("outside".to_string(), Source::Claude),
                ("inside".to_string(), Source::Project),
                ("plain".to_string(), Source::Project),
            ]
        );
    }

    #[test]
    fn codexs_roles_are_read_from_its_configuration_and_each_roles_file() {
        let home = crate::scratch::Scratch::new("agents-codex-home");
        let codex = home.join(".codex");
        write(
            &codex.join("config.toml"),
            "model = \"gpt-5.5\"\n\n[agents]\nmax_threads = 4\n\n[agents.explorer]\ndescription = \"Reads the code base.\"\nconfig_file = \"agents/explorer.toml\"\nnickname_candidates = [\"Scout\"]\n\n[agents.fixer]\ndescription = \"Fixes failing tests.\"\nconfig_file = \"agents/missing.toml\"\n\n[agents.empty]\n",
        );
        write(
            &codex.join("agents").join("explorer.toml"),
            "model = \"gpt-5.5-mini\"\nmodel_reasoning_effort = \"low\"\nsandbox_mode = \"read-only\"\ndeveloper_instructions = \"\"\"\nYou explore; you change nothing.\n\"\"\"\n",
        );
        let agents = installed(&home, &home.join("project"), &home.join(".claude"), &codex);
        assert_eq!(agents.len(), 2);
        let explorer = &agents[0];
        assert_eq!(explorer.name, "explorer");
        assert_eq!(explorer.source, Source::Codex);
        assert_eq!(explorer.description, "Reads the code base.");
        assert_eq!(explorer.model.as_deref(), Some("gpt-5.5-mini"));
        assert_eq!(explorer.effort.as_deref(), Some("low"));
        assert!(explorer.reads_only);
        assert_eq!(explorer.text, "You explore; you change nothing.");
        assert_eq!(explorer.path, codex.join("agents").join("explorer.toml"));
        let fixer = &agents[1];
        assert_eq!(fixer.name, "fixer");
        assert_eq!(fixer.text, "");
        assert!(!fixer.reads_only);
        assert_eq!(fixer.path, codex.join("config.toml"));
        assert!(installed(&home, &home, &home.join("none"), &home.join("none")).is_empty());
    }

    #[test]
    fn frontmatter_reads_the_yaml_an_agent_uses() {
        let (fields, body) = frontmatter(
            "---\nname: 'it''s'\ntools: [Read, \"Grep\"]\nnote: plain # a comment\ntext: |\n  one\n    two\n\n  three\nempty:\n---\nBody\n",
        )
        .unwrap();
        assert_eq!(body, "Body\n");
        let get = |key: &str| fields.iter().find(|(name, _)| name == key).map(|(_, f)| f);
        assert_eq!(get("name"), Some(&Field::Text("it's".into())));
        assert_eq!(
            get("tools"),
            Some(&Field::List(vec!["Read".into(), "Grep".into()]))
        );
        assert_eq!(get("note"), Some(&Field::Text("plain".into())));
        assert_eq!(
            get("text"),
            Some(&Field::Text("one\n  two\n\nthree".into()))
        );
        assert_eq!(get("empty"), None);
        assert!(frontmatter("---\nname: open\n").is_none());
        assert!(frontmatter("name: none\n").is_none());
    }
}
