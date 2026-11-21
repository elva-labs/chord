use super::*;
use crate::scratch::Scratch;
use serde_json::{json, Value};

/// 2026-11-19T08:00:00Z in milliseconds.
const AT: u64 = 1_795_075_200_000;

/// A line as Codex writes it, its time and kind ahead of what it holds,
/// `seconds` after [`AT`].
fn line(seconds: u64, kind: &str, payload: Value) -> String {
    format!(
        "{{\"timestamp\":\"2026-11-19T08:{:02}:{:02}.000Z\",\"ordinal\":1,\"type\":\"{kind}\",\"payload\":{payload}}}",
        seconds / 60,
        seconds % 60
    )
}

fn count(seconds: u64, usage: Value) -> String {
    line(
        seconds,
        "event_msg",
        json!({ "type": "token_count", "info": { "last_token_usage": usage, "model_context_window": 258_400 } }),
    )
}

fn total(seconds: u64, tokens: u64) -> String {
    count(
        seconds,
        json!({ "input_tokens": tokens - 500, "cached_input_tokens": tokens - 900, "output_tokens": 500, "reasoning_output_tokens": 80, "total_tokens": tokens }),
    )
}

fn user(seconds: u64, text: &str) -> String {
    line(
        seconds,
        "event_msg",
        json!({ "type": "item_completed", "item": { "type": "UserMessage", "id": "u", "content": [
            { "type": "local_image", "path": "/tmp/shot.png" },
            { "type": "text", "text": text, "text_elements": [] }
        ] } }),
    )
}

fn agent(seconds: u64, text: &str) -> String {
    line(
        seconds,
        "event_msg",
        json!({ "type": "item_completed", "item": { "type": "AgentMessage", "id": "a", "content": [{ "type": "Text", "text": text }], "phase": "final_answer" } }),
    )
}

fn rollout(home: &Scratch, lines: &[String]) -> std::path::PathBuf {
    let path = home.path().join("rollout.jsonl");
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    path
}

#[test]
fn the_standing_is_the_last_count_and_the_last_line() {
    let home = Scratch::new("rollout-standing");
    let path = rollout(
        &home,
        &[
            user(0, "hello"),
            total(5, 150_000),
            agent(6, "first"),
            total(9, 212_000),
            line(
                30,
                "event_msg",
                json!({ "type": "task_complete", "last_agent_message": "done" }),
            ),
        ],
    );
    assert_eq!(
        standing(&path),
        Some(Standing {
            context: 212_000,
            at: AT + 30_000,
            hour: true
        })
    );
}

#[test]
fn a_count_without_usage_leaves_the_last_one_and_a_count_without_a_whole_adds_up() {
    let home = Scratch::new("rollout-counts");
    let path = rollout(
        &home,
        &[
            count(
                1,
                json!({ "input_tokens": 120_000, "output_tokens": 3_000 }),
            ),
            line(
                2,
                "event_msg",
                json!({ "type": "token_count", "info": null }),
            ),
        ],
    );
    assert_eq!(
        standing(&path).map(|standing| standing.context),
        Some(123_000)
    );
}

#[test]
fn a_compaction_after_the_last_count_leaves_no_standing_until_the_next_count() {
    let home = Scratch::new("rollout-compacted");
    let compacted = line(
        10,
        "compacted",
        json!({ "message": "", "replacement_history": [{ "type": "message", "role": "user", "content": [] }] }),
    );
    let path = rollout(&home, &[total(5, 208_511), compacted.clone()]);
    assert_eq!(standing(&path), None);

    let path = rollout(&home, &[total(5, 208_511), compacted, total(11, 15_501)]);
    assert_eq!(
        standing(&path).map(|standing| standing.context),
        Some(15_501)
    );

    let path = rollout(
        &home,
        &[
            total(5, 208_511),
            line(
                10,
                "event_msg",
                json!({ "type": "item_completed", "item": { "type": "ContextCompaction", "id": "c" } }),
            ),
        ],
    );
    assert_eq!(standing(&path), None);
}

#[test]
fn a_rollout_without_a_count_or_a_file_has_no_standing() {
    let home = Scratch::new("rollout-none");
    let path = rollout(&home, &[user(0, "hello"), agent(3, "hi")]);
    assert_eq!(standing(&path), None);
    assert_eq!(standing(&home.path().join("gone.jsonl")), None);
}

#[test]
fn the_messages_are_read_from_the_items_with_the_agents_words_as_one() {
    let home = Scratch::new("rollout-said");
    let path = rollout(
        &home,
        &[
            user(0, "first ask"),
            agent(1, "first answer"),
            user(2, "second ask"),
            agent(3, "looking"),
            line(
                4,
                "event_msg",
                json!({ "type": "item_completed", "item": { "type": "CommandExecution", "id": "x" } }),
            ),
            agent(5, "found it"),
            user(6, "third ask"),
            agent(7, "third answer"),
            line(
                7,
                "event_msg",
                json!({ "type": "agent_message", "message": "third answer" }),
            ),
        ],
    );
    let said = last_said(&path, 2);
    assert_eq!(
        said,
        vec![
            Quoted {
                user: true,
                text: "second ask".into()
            },
            Quoted {
                user: false,
                text: "looking\n\nfound it".into()
            },
            Quoted {
                user: true,
                text: "third ask".into()
            },
            Quoted {
                user: false,
                text: "third answer".into()
            },
        ]
    );
    assert_eq!(first_said(&path).as_deref(), Some("first ask"));
}

#[test]
fn a_rollout_written_before_items_is_read_from_its_events() {
    let home = Scratch::new("rollout-events");
    let path = rollout(
        &home,
        &[
            line(
                0,
                "event_msg",
                json!({ "type": "user_message", "message": "old ask", "images": [] }),
            ),
            line(
                1,
                "event_msg",
                json!({ "type": "agent_message", "message": "old answer" }),
            ),
            line(
                2,
                "response_item",
                json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>" }] }),
            ),
        ],
    );
    assert_eq!(
        last_said(&path, 3),
        vec![
            Quoted {
                user: true,
                text: "old ask".into()
            },
            Quoted {
                user: false,
                text: "old answer".into()
            },
        ]
    );
    assert_eq!(first_said(&path).as_deref(), Some("old ask"));
}
