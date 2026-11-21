//! What a Codex rollout says of how its conversation stands and of what
//! was said in it, for taking the conversation up again. A rollout is the
//! file Codex writes a thread to, a line of JSON for each thing that
//! happened, each with its time; a resumed thread is written on at its end.

use std::path::Path;

use serde_json::Value;

use crate::claude_history::{
    last_exchanges, lines, millis, Quoted, Span, Standing, HEAD_KEEP, TAIL_KEEP,
};

/// How much of a line's start is searched for its kind, which Codex writes
/// ahead of the rest.
const LINE_HEAD: usize = 512;

/// The kinds of line the standing is read from, as each names itself
/// within its head: a count of a request's tokens, a turn's start, end and
/// abort, and a compaction.
const MARKS: [&[u8]; 7] = [
    b"\"type\":\"token_count\"",
    b"\"type\":\"task_started\"",
    b"\"type\":\"task_complete\"",
    b"\"type\":\"turn_aborted\"",
    b"\"type\":\"compacted\"",
    b"\"type\":\"context_compacted\"",
    b"\"type\":\"ContextCompaction\"",
];

/// What a line says of how the conversation stands.
enum Mark {
    /// A request ended, its context holding these tokens.
    Count(u64),
    /// A turn started, ended or was cut off.
    Turn,
    /// The conversation compacted.
    Compaction,
}

/// How the conversation stands at the end of its rollout: the tokens of
/// context its last request held, by the last count of them Codex wrote,
/// and when its last request ended. None where the end of the rollout
/// holds no count, or a compaction comes after the last one, which then no
/// longer says what the context is.
///
/// Codex writes a count as each request ends, and a line as each turn
/// starts, ends or is cut off: the conversation rested from the last of
/// these on. A turn's start counts too, so a turn cut off before its first
/// count rests from when it began at the earliest. The lines Codex writes
/// when a thread is opened or its settings change mark no request, and nor
/// does any other line. Codex writes down nothing of how long its prompt
/// cache lasts, so the cautious reading is taken: it lasts an hour, longer
/// than the half hour its provider holds a cache at least. A line counts
/// once it is whole, so one cut off as it was written says nothing.
pub fn standing(rollout: &Path) -> Option<Standing> {
    let length = std::fs::metadata(rollout).ok()?.len();
    let span = Span {
        start: length.saturating_sub(TAIL_KEEP),
        end: length,
    };
    let mut context = None;
    let mut at = None;
    lines(rollout, Some(span), |bytes| {
        let head = &bytes[..bytes.len().min(LINE_HEAD)];
        if !MARKS.iter().any(|kind| found(head, kind)) {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        let time = entry["timestamp"].as_str().and_then(millis);
        match mark(&entry) {
            Some(Mark::Compaction) => context = None,
            Some(Mark::Count(tokens)) => {
                context = Some(tokens);
                at = time.or(at);
            }
            Some(Mark::Turn) => at = time.or(at),
            None => {}
        }
    });
    Some(Standing {
        context: context?,
        at: at?,
        hour: true,
    })
}

/// What a whole line marks: a count only where it holds a request's usage,
/// which a count Codex writes before a turn's first request does not.
fn mark(entry: &Value) -> Option<Mark> {
    if entry["type"] == "compacted" {
        return Some(Mark::Compaction);
    }
    if entry["type"] != "event_msg" {
        return None;
    }
    let payload = &entry["payload"];
    match payload["type"].as_str()? {
        "context_compacted" => Some(Mark::Compaction),
        "item_started" | "item_completed" if payload["item"]["type"] == "ContextCompaction" => {
            Some(Mark::Compaction)
        }
        "token_count" => tokens(&payload["info"]["last_token_usage"]).map(Mark::Count),
        "task_started" | "task_complete" | "turn_aborted" => Some(Mark::Turn),
        _ => None,
    }
}

/// The tokens a request's usage counts: its whole, or its input and
/// output where the whole is not given. None for a count without usage,
/// which Codex writes before a turn's first request.
fn tokens(usage: &Value) -> Option<u64> {
    usage["total_tokens"].as_u64().or_else(|| {
        let input = usage["input_tokens"].as_u64()?;
        Some(input + usage["output_tokens"].as_u64().unwrap_or(0))
    })
}

fn found(bytes: &[u8], what: &[u8]) -> bool {
    bytes.windows(what.len()).any(|window| window == what)
}

/// What a line says, when it is the user's words or the agent's. Codex
/// writes each message once as an item, and, before it wrote items and in
/// the sessions it runs for itself, as an event; `events` reads the
/// events.
fn said_in(entry: &Value, events: bool) -> Option<Quoted> {
    if entry["type"] != "event_msg" {
        return None;
    }
    let payload = &entry["payload"];
    let (user, text) = match payload["type"].as_str()? {
        "item_completed" if !events => {
            let item = &payload["item"];
            let user = match item["type"].as_str()? {
                "UserMessage" => true,
                "AgentMessage" => false,
                _ => return None,
            };
            let text = item["content"]
                .as_array()?
                .iter()
                .filter(|part| {
                    matches!(
                        part["type"].as_str(),
                        Some("text" | "Text" | "input_text" | "output_text")
                    )
                })
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            (user, text)
        }
        "user_message" if events => (true, payload["message"].as_str()?.to_string()),
        "agent_message" if events => (false, payload["message"].as_str()?.to_string()),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(Quoted { user, text })
}

/// The messages of a stretch of the rollout, as items where it holds any
/// and as events otherwise.
fn said(rollout: &Path, span: Span) -> Vec<Quoted> {
    let mut items = Vec::new();
    let mut events = Vec::new();
    lines(rollout, Some(span), |bytes| {
        if !found(bytes, b"\"event_msg\"") {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        items.extend(said_in(&entry, false));
        events.extend(said_in(&entry, true));
    });
    if items.is_empty() {
        events
    } else {
        items
    }
}

/// The last `most` messages of the user's, each with the agent's words
/// after it, oldest first.
pub fn last_said(rollout: &Path, most: usize) -> Vec<Quoted> {
    let Some(length) = std::fs::metadata(rollout).ok().map(|meta| meta.len()) else {
        return Vec::new();
    };
    let span = Span {
        start: length.saturating_sub(TAIL_KEEP),
        end: length,
    };
    last_exchanges(said(rollout, span), most)
}

/// The first message of the user's, which began the conversation.
pub fn first_said(rollout: &Path) -> Option<String> {
    let length = std::fs::metadata(rollout).ok()?.len();
    let span = Span {
        start: 0,
        end: length.min(HEAD_KEEP),
    };
    said(rollout, span)
        .into_iter()
        .find(|said| said.user)
        .map(|said| said.text)
}

#[cfg(test)]
#[path = "codex_rollout_tests.rs"]
mod tests;
