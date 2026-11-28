//! Sessions Codex CLI has already had in a project.
//!
//! Codex keeps an index of its threads in a SQLite database under its home,
//! `state_<n>.sqlite`, with the rollout files beside it. The index is what its
//! own picker reads, and it carries what the pane needs: id, directory, the
//! name the user gave a thread, the title Codex gave it, and when it moved.
//!
//! The schema is Codex's own and moves with its versions, which is why every
//! query lives here and every failure is an empty answer rather than an
//! error: a picker with nothing to show beats a pane that will not open.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::transcripts::{epoch_seconds, last_in_tail, tidy, Transcript};

/// The newest state database by schema number: Codex bumps the number when
/// the schema moves, and leaves the old file behind.
fn state_db(codex_home: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(codex_home).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let number = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((number, entry.path()))
        })
        .max_by_key(|(number, _)| *number)
        .map(|(_, path)| path)
}

fn open(codex_home: &Path) -> Option<Connection> {
    let path = state_db(codex_home)?;
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// A thread as listed. Sessions run non-interactively (`codex exec`) are left
/// out, as Codex's own picker leaves them out; so are archived ones.
/// The project's own threads and those run anywhere under it, a worktree
/// most of all.
const LIST: &str = "SELECT id, name, title, first_user_message, updated_at, tokens_used, cwd, rollout_path \
                    FROM threads WHERE (cwd = ?1 OR cwd LIKE ?2) AND archived = 0 AND source <> 'exec' \
                    ORDER BY updated_at DESC";

/// The same listing from an index that does not say where a thread's rollout
/// is: its threads are listed all the same, dated by the index alone.
const LIST_WITHOUT_ROLLOUT: &str = "SELECT id, name, title, first_user_message, updated_at, tokens_used, cwd, NULL \
                    FROM threads WHERE (cwd = ?1 OR cwd LIKE ?2) AND archived = 0 AND source <> 'exec' \
                    ORDER BY updated_at DESC";

/// Newest first. A project Codex has never been used in has none.
pub fn list(codex_home: &Path, project: &Path) -> Vec<Transcript> {
    list_many(codex_home, &[project.to_path_buf()])
        .pop()
        .unwrap_or_default()
}

/// The threads of every project given, in the order given, from one opening
/// of the index.
pub fn list_many(codex_home: &Path, projects: &[PathBuf]) -> Vec<Vec<Transcript>> {
    let Some(connection) = open(codex_home) else {
        return vec![Vec::new(); projects.len()];
    };
    let Ok(mut statement) = connection
        .prepare(LIST)
        .or_else(|_| connection.prepare(LIST_WITHOUT_ROLLOUT))
    else {
        return vec![Vec::new(); projects.len()];
    };
    projects
        .iter()
        .map(|project| {
            let root = project.to_string_lossy().to_string();
            let under = format!("{root}/%");
            let rows = statement.query_map([root.clone(), under], |row| {
                let cwd: String = row.get(6)?;
                Ok(Transcript {
                    id: row.get(0)?,
                    title: name_of(row.get(1)?, row.get(2)?, row.get(3)?),
                    modified: row.get::<_, i64>(4).map(|s| s.max(0) as u64)?,
                    active: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|path| last_message_at(Path::new(&path))),
                    size: row.get::<_, i64>(5).map(|s| s.max(0) as u64)?,
                    cwd: (cwd != root).then_some(cwd),
                })
            });
            match rows {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => Vec::new(),
            }
        })
        .collect()
}

/// When the last message of the user or the agent was written to a rollout,
/// read from its end: the records after it, such as settings, token counts
/// and the end of a turn, are not the session being used. None where the
/// rollout is not there or holds no message in its last megabyte.
fn last_message_at(path: &Path) -> Option<u64> {
    let stamp = std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.len(), meta.modified().ok()));
    let key = (path.to_path_buf(), stamp?);
    if let Some(known) = messages().lock().ok().and_then(|m| m.get(&key).copied()) {
        return known;
    }
    let found = last_in_tail(path, message_at);
    if let Ok(mut kept) = messages().lock() {
        kept.insert(key, found);
    }
    found
}

type MessageKey = (PathBuf, (u64, Option<std::time::SystemTime>));

fn messages() -> &'static std::sync::Mutex<std::collections::HashMap<MessageKey, Option<u64>>> {
    static KEPT: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<MessageKey, Option<u64>>>,
    > = std::sync::OnceLock::new();
    KEPT.get_or_init(Default::default)
}

/// The time of the last line of the text that records a message of the user
/// or the agent, as Codex writes it either way.
fn message_at(tail: &str) -> Option<u64> {
    tail.lines().rev().find_map(|line| {
        if !line.contains("message") {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        let payload = value.get("payload")?;
        let counts = match value.get("type")?.as_str()? {
            "response_item" => {
                payload.get("type")?.as_str()? == "message"
                    && matches!(payload.get("role")?.as_str()?, "user" | "assistant")
            }
            "event_msg" => matches!(
                payload.get("type")?.as_str()?,
                "user_message" | "agent_message"
            ),
            _ => false,
        };
        counts.then(|| epoch_seconds(value.get("timestamp")?.as_str()?))?
    })
}

/// What a thread is called: the name the user gave it, else the title Codex
/// gave it, else what the user first said. Empty is what a fresh thread has.
fn name_of(name: Option<String>, title: Option<String>, first: Option<String>) -> Option<String> {
    [name, title, first]
        .into_iter()
        .flatten()
        .map(|text| text.trim().to_string())
        .find(|text| !text.is_empty())
        .map(|text| tidy(&text))
}

/// A thread that started in the project at or after a moment, newest first:
/// the one a `codex` just spawned there is about to create. Codex mints its
/// own ids, so this is how the workbench learns the id of what it started.
pub fn started_since(
    codex_home: &Path,
    project: &Path,
    since: u64,
) -> Option<(String, Option<String>)> {
    let connection = open(codex_home)?;
    let cwd = project.to_string_lossy().to_string();
    connection
        .query_row(
            "SELECT id, name, title, first_user_message FROM threads \
             WHERE cwd = ?1 AND created_at >= ?2 ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![cwd, since as i64],
            |row| Ok((row.get(0)?, name_of(row.get(1)?, row.get(2)?, row.get(3)?))),
        )
        .ok()
}

/// What a thread is called now. None for a thread that is not there.
pub fn title_of(codex_home: &Path, id: &str) -> Option<String> {
    let connection = open(codex_home)?;
    connection
        .query_row(
            "SELECT name, title, first_user_message FROM threads WHERE id = ?1",
            [id],
            |row| Ok(name_of(row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
        .flatten()
}

/// Where Codex writes a thread, by the thread index. None where the
/// index or the thread is not there.
pub fn rollout_path(codex_home: &Path, id: &str) -> Option<PathBuf> {
    open(codex_home)?
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0).map(PathBuf::from),
        )
        .ok()
}

/// Whether no conversation is stored under the id: Codex's index holds no
/// such thread or the rollout it names is not on disk, and no rollout of
/// it lies in the account's sessions folder, which Codex itself looks
/// through where its index falls behind, or in its archived sessions
/// folder. False where the index or either folder cannot be read, which
/// says nothing either way; an archive folder Codex has not made yet holds
/// nothing.
pub fn thread_missing(codex_home: &Path, id: &str) -> bool {
    let Some(db) = open(codex_home) else {
        return false;
    };
    let indexed = match db.query_row(
        "SELECT rollout_path FROM threads WHERE id = ?1",
        [id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(path) => Path::new(&path).is_file(),
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(_) => return false,
    };
    if indexed {
        return false;
    }
    // Codex makes the archive folder only once a thread is archived.
    let archived = match stored_rollout(&codex_home.join("archived_sessions"), id, 0) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        archived => archived,
    };
    matches!(archived, Ok(false))
        && matches!(
            stored_rollout(&codex_home.join("sessions"), id, 0),
            Ok(false)
        )
}

/// How deep the sessions folder nests rollouts: year, month and day.
const SESSIONS_DEPTH: usize = 3;

/// Whether a rollout of the thread lies in the folder or one nested under
/// it as Codex files them. An error where a folder could not be read.
fn stored_rollout(dir: &Path, id: &str, depth: usize) -> std::io::Result<bool> {
    let ending = format!("-{id}.jsonl");
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if depth < SESSIONS_DEPTH && stored_rollout(&entry.path(), id, depth + 1)? {
                return Ok(true);
            }
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("rollout-") && name.ends_with(&ending) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Reads complete turn events, retaining the byte offset across polls.
/// A resumed conversation starts at its current end, without replaying history.
pub struct Activity {
    id: Option<String>,
    path: Option<PathBuf>,
    offset: u64,
    /// The model the latest turn read runs on, as the user's `/model`
    /// or the configuration left it. None until a turn has begun.
    model: Option<String>,
}

impl Activity {
    pub fn new(home: &Path, id: Option<String>) -> Self {
        let path = id.as_ref().and_then(|id| rollout_path(home, id));
        let offset = path
            .as_ref()
            .and_then(|path| path.metadata().ok())
            .map(|meta| meta.len())
            .unwrap_or(0);
        Self {
            id,
            path,
            offset,
            model: None,
        }
    }

    fn poll(&mut self, home: &Path) -> Option<&'static str> {
        if self.path.is_none() {
            self.path = rollout_path(home, self.id.as_deref()?);
        }
        let (lines, offset) = crate::activity::read_new(self.path.as_ref()?, self.offset);
        self.offset = offset;
        if let Some(model) = lines.iter().rev().find_map(|line| turn_model(line)) {
            self.model = Some(model);
        }
        lines.iter().rev().find_map(|line| turn_event(line))
    }
}

/// The longest model a turn is taken to run on. A longer one, or one with
/// a space or a control character in it, is not a model's id, and the model
/// heard before it stands.
const LONGEST_MODEL: usize = 128;

/// The model a turn runs on, from the context Codex writes as the turn
/// begins, just after the turn's start.
fn turn_model(line: &str) -> Option<String> {
    if !line.contains("\"turn_context\"") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "turn_context" {
        return None;
    }
    let model = value.get("payload")?.get("model")?.as_str()?.trim();
    let named = !model.is_empty()
        && model.chars().count() <= LONGEST_MODEL
        && !model.chars().any(|c| c.is_control() || c.is_whitespace());
    named.then(|| model.to_string())
}

fn turn_event(line: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    match value.get("payload")?.get("type")?.as_str()? {
        "task_started" => Some("prompt"),
        "task_complete" => Some("stop"),
        "turn_aborted" => Some(CUT),
        _ => None,
    }
}

/// A turn the user cut short, which the window hears as a stop that says
/// so.
const CUT: &str = "cut";

/// Follows the running PTY's identity and turn events on its own machine.
pub fn observe(
    sink: std::sync::Arc<dyn crate::events::Sink>,
    sessions: std::sync::Arc<crate::pty::Sessions>,
    home: PathBuf,
    project: PathBuf,
    started: u64,
    pty_id: String,
    mut activity: Activity,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if !sessions.holds(&pty_id) {
            return;
        }
        if activity.id.is_none() {
            if let Some((id, title)) = started_since(&home, &project, started.saturating_sub(1)) {
                crate::events::emit(
                    &sink,
                    crate::api::SESSION_IDENTIFIED,
                    &crate::api::SessionIdentified {
                        pty_id: pty_id.clone(),
                        session_id: id.clone(),
                        title,
                    },
                );
                activity.id = Some(id);
            }
        }
        if let Some(kind) = activity.poll(&home) {
            let cut = kind == CUT;
            crate::events::emit(
                &sink,
                crate::activity::SESSION_EVENT,
                &crate::activity::SessionEvent {
                    session_id: activity.id.clone().unwrap(),
                    kind: if cut { "stop" } else { kind }.to_string(),
                    note: None,
                    cut,
                    error: None,
                    background: Vec::new(),
                    mode: None,
                    model: activity.model.clone(),
                },
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    #[test]
    fn activity_reads_complete_turns_and_ignores_redraw_unrelated_events() {
        use std::io::Write;
        let home = codex_home("activity");
        let path = home.join("rollout.jsonl");
        let start = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let stop = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        std::fs::write(&path, format!("{start}\n")).unwrap();
        let mut activity = Activity {
            id: Some("id".into()),
            path: Some(path.clone()),
            offset: 0,
            model: None,
        };
        assert_eq!(activity.poll(&home), Some("prompt"));
        assert_eq!(activity.poll(&home), None);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{stop}").unwrap();
        assert_eq!(activity.poll(&home), None, "partial lines wait");
        writeln!(file).unwrap();
        assert_eq!(activity.poll(&home), Some("stop"));
        writeln!(file, "{start}\n{stop}").unwrap();
        assert_eq!(activity.poll(&home), Some("stop"), "latest transition wins");
        std::fs::write(&path, format!("{start}\n")).unwrap();
        assert_eq!(
            activity.poll(&home),
            Some("prompt"),
            "truncation resets the offset"
        );
        assert_eq!(
            turn_event(r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#),
            Some(CUT),
            "a turn the user cut short says so"
        );
        assert_eq!(
            turn_event(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#),
            None
        );
        assert_eq!(
            turn_event(r#"{"type":"response_item","payload":{"type":"task_started"}}"#),
            None
        );
        assert_eq!(turn_event("invalid"), None);
    }

    #[test]
    fn activity_keeps_the_model_the_latest_turn_runs_on() {
        use std::io::Write;
        let home = codex_home("activity-model");
        let path = home.join("rollout.jsonl");
        let start = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let context = |model: &str| {
            format!(
                r#"{{"type":"turn_context","payload":{{"turn_id":"t","model":"{model}","effort":"high"}}}}"#
            )
        };
        std::fs::write(&path, format!("{start}\n")).unwrap();
        let mut activity = Activity {
            id: Some("id".into()),
            path: Some(path.clone()),
            offset: 0,
            model: None,
        };
        assert_eq!(activity.poll(&home), Some("prompt"));
        assert_eq!(activity.model, None, "no turn has said its model yet");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        // The configured model, where the session was started with none.
        writeln!(file, "{}", context("gpt-6.1-sol")).unwrap();
        assert_eq!(activity.poll(&home), None);
        assert_eq!(activity.model.as_deref(), Some("gpt-6.1-sol"));
        // The user's /model, which the next turn runs on.
        writeln!(file, "{start}\n{}", context("gpt-6.2-sol")).unwrap();
        assert_eq!(activity.poll(&home), Some("prompt"));
        assert_eq!(activity.model.as_deref(), Some("gpt-6.2-sol"));
        writeln!(
            file,
            r#"{{"type":"event_msg","payload":{{"type":"task_complete"}}}}"#
        )
        .unwrap();
        assert_eq!(activity.poll(&home), Some("stop"));
        assert_eq!(
            activity.model.as_deref(),
            Some("gpt-6.2-sol"),
            "kept between turns"
        );
        assert_eq!(
            turn_model(r#"{"type":"response_item","payload":{"model":"x","t":"turn_context"}}"#),
            None
        );
        assert_eq!(
            turn_model(r#"{"type":"turn_context","payload":{"model":""}}"#),
            None
        );
        // A line that names no model's id leaves the one before it.
        let long = "m".repeat(129);
        let bell = r#"{"type":"turn_context","payload":{"model":"gpt\u0007bell"}}"#;
        writeln!(
            file,
            "{start}\n{}\n{bell}\n{}",
            context(&long),
            context("two words")
        )
        .unwrap();
        assert_eq!(activity.poll(&home), Some("prompt"));
        assert_eq!(activity.model.as_deref(), Some("gpt-6.2-sol"));
        assert_eq!(
            turn_model(&context(&"m".repeat(128))).map(|model| model.len()),
            Some(128)
        );
    }

    #[test]
    fn resumed_activity_skips_history_and_retries_a_missing_rollout() {
        use std::io::Write;
        let home = codex_home("activity-resume");
        let path = home.join("rollout.jsonl");
        let start = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        std::fs::write(&path, format!("{start}\n")).unwrap();
        let db = Connection::open(home.join("state_1.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
            .unwrap();
        db.execute(
            "INSERT INTO threads VALUES ('id', ?1)",
            [path.to_str().unwrap()],
        )
        .unwrap();
        let mut activity = Activity::new(&home, Some("id".into()));
        assert_eq!(activity.poll(&home), None);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{start}").unwrap();
        assert_eq!(activity.poll(&home), Some("prompt"));
        let mut fresh = Activity::new(&home, None);
        fresh.id = Some("later".into());
        assert_eq!(fresh.poll(&home), None);
        db.execute(
            "INSERT INTO threads VALUES ('later', ?1)",
            [path.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(fresh.poll(&home), Some("prompt"));
    }

    fn codex_home(name: &str) -> Scratch {
        let dir = Scratch::new(&format!("codex-{name}"));
        dir
    }

    /// One thread as Codex would record it: id, cwd, name, title, first
    /// message, created, updated, archived, source.
    type Row<'a> = (
        &'a str,
        &'a str,
        &'a str,
        &'a str,
        &'a str,
        i64,
        i64,
        i64,
        &'a str,
    );

    /// The columns the queries touch, with Codex's own names and types.
    fn seed(dir: &Path, version: u32, rows: &[Row]) {
        let connection = Connection::open(dir.join(format!("state_{version}.sqlite"))).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT, \
                 title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, \
                 archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, \
                 tokens_used INTEGER NOT NULL DEFAULT 0, rollout_path TEXT)",
            )
            .unwrap();
        for (id, cwd, name, title, first, created, updated, archived, source) in rows {
            connection
                .execute(
                    "INSERT INTO threads (id, cwd, name, title, first_user_message, created_at, \
                     updated_at, archived, source, tokens_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 42)",
                    rusqlite::params![id, cwd, (!name.is_empty()).then_some(*name), title, first, created, updated, archived, source],
                )
                .unwrap();
        }
    }

    const P: &str = "/home/ada/dev/demo";

    #[test]
    fn a_home_with_no_state_has_no_sessions() {
        let dir = codex_home("empty");
        assert!(list(&dir, Path::new(P)).is_empty());
        assert_eq!(title_of(&dir, "x"), None);
    }

    #[test]
    fn lists_the_project_threads_newest_first_under_their_names() {
        let dir = codex_home("list");
        seed(
            &dir,
            5,
            &[
                (
                    "a",
                    P,
                    "",
                    "Refactor billing",
                    "refactor the billing module",
                    10,
                    20,
                    0,
                    "cli",
                ),
                ("b", P, "given name", "Something", "hello", 11, 30, 0, "cli"),
                ("c", P, "", "", "just a prompt", 12, 25, 0, "cli"),
                (
                    "d",
                    "/elsewhere",
                    "",
                    "other project",
                    "x",
                    13,
                    40,
                    0,
                    "cli",
                ),
                ("e", P, "", "archived", "x", 14, 50, 1, "cli"),
                ("f", P, "", "exec run", "x", 15, 60, 0, "exec"),
                ("g", P, "", "", "", 16, 70, 0, "cli"),
            ],
        );
        let found = list(&dir, Path::new(P));
        let ids: Vec<&str> = found.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["g", "b", "c", "a"]);
        assert_eq!(found[1].title.as_deref(), Some("given name"));
        assert_eq!(found[2].title.as_deref(), Some("just a prompt"));
        assert_eq!(found[3].title.as_deref(), Some("Refactor billing"));
        assert_eq!(found[0].title, None, "a fresh thread has no name yet");
        assert_eq!(found[3].modified, 20);
        assert_eq!(found[3].size, 42);
    }

    #[test]
    fn dates_a_thread_by_the_last_message_in_its_rollout() {
        let dir = codex_home("active");
        seed(
            &dir,
            5,
            &[
                ("a", P, "", "t", "x", 10, 9_000_000_000, 0, "cli"),
                ("b", P, "", "t", "x", 11, 9_000_000_001, 0, "cli"),
            ],
        );
        let rollout = dir.join("rollout-a.jsonl");
        let line = |time: &str, kind: &str, payload: &str| {
            format!("{{\"timestamp\":\"{time}\",\"type\":\"{kind}\",\"payload\":{payload}}}\n")
        };
        let mut body = line(
            "2026-11-01T08:00:00.000Z",
            "response_item",
            r#"{"type":"message","role":"user"}"#,
        );
        body.push_str(&line(
            "2026-11-01T08:00:05.000Z",
            "response_item",
            r#"{"type":"message","role":"assistant"}"#,
        ));
        body.push_str(&line(
            "2026-11-01T08:00:06.000Z",
            "response_item",
            r#"{"type":"message","role":"developer"}"#,
        ));
        for kind in ["thread_settings_applied", "token_count", "task_complete"] {
            body.push_str(&line(
                "2026-11-20T10:00:00.000Z",
                "event_msg",
                &format!("{{\"type\":\"{kind}\"}}"),
            ));
        }
        std::fs::write(&rollout, body).unwrap();
        Connection::open(dir.join("state_5.sqlite"))
            .unwrap()
            .execute(
                "UPDATE threads SET rollout_path = ?1 WHERE id = 'a'",
                [rollout.to_str().unwrap()],
            )
            .unwrap();
        let found = list(&dir, Path::new(P));
        let a = found.iter().find(|t| t.id == "a").unwrap();
        assert_eq!(a.active, epoch_seconds("2026-11-01T08:00:05Z"));
        let b = found.iter().find(|t| t.id == "b").unwrap();
        assert_eq!(b.active, None);
    }

    #[test]
    fn many_projects_are_listed_from_one_opening_in_the_order_asked() {
        let dir = codex_home("many");
        seed(
            &dir,
            5,
            &[
                ("a", P, "", "mine", "x", 1, 20, 0, "cli"),
                ("b", "/elsewhere", "", "theirs", "x", 2, 30, 0, "cli"),
                ("c", "/elsewhere/tree", "", "nested", "x", 3, 40, 0, "cli"),
            ],
        );
        let projects = vec![
            PathBuf::from("/elsewhere"),
            PathBuf::from("/nowhere"),
            PathBuf::from(P),
        ];
        let found = list_many(&dir, &projects);
        let ids = |list: &Vec<Transcript>| list.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&found[0]), ["c", "b"]);
        assert!(found[1].is_empty());
        assert_eq!(ids(&found[2]), ["a"]);

        let nothing = list_many(&codex_home("many-empty"), &projects);
        assert_eq!(nothing.len(), 3);
        assert!(nothing.iter().all(Vec::is_empty));
    }

    #[test]
    fn reads_the_newest_schema_when_several_are_left_behind() {
        let dir = codex_home("versions");
        seed(&dir, 4, &[("old", P, "", "old", "x", 1, 1, 0, "cli")]);
        seed(&dir, 12, &[("new", P, "", "new", "x", 1, 1, 0, "cli")]);
        let ids: Vec<String> = list(&dir, Path::new(P)).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["new"]);
    }

    #[test]
    fn finds_the_thread_a_spawn_just_created() {
        let dir = codex_home("since");
        seed(
            &dir,
            5,
            &[
                ("before", P, "", "earlier", "x", 100, 100, 0, "cli"),
                ("after", P, "", "", "", 205, 205, 0, "cli"),
            ],
        );
        assert_eq!(
            started_since(&dir, Path::new(P), 200),
            Some(("after".to_string(), None))
        );
        assert_eq!(started_since(&dir, Path::new(P), 300), None);
        assert_eq!(started_since(&dir, Path::new("/nope"), 0), None);
    }

    #[test]
    fn reports_what_a_thread_is_called_now() {
        let dir = codex_home("title");
        seed(&dir, 5, &[("a", P, "", "", "first words", 1, 1, 0, "cli")]);
        assert_eq!(title_of(&dir, "a").as_deref(), Some("first words"));
        assert_eq!(title_of(&dir, "missing"), None);
    }

    // The schema is Codex's to change. A table that is not there is no
    // history, never a broken pane.
    #[test]
    fn a_schema_it_does_not_recognise_is_no_history() {
        let dir = codex_home("schema");
        let connection = Connection::open(dir.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch("CREATE TABLE sessions (id TEXT)")
            .unwrap();
        assert!(list(&dir, Path::new(P)).is_empty());
        assert_eq!(started_since(&dir, Path::new(P), 0), None);
    }
}
