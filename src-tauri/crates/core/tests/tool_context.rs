//! The size budget of what the tool server puts in an agent's context: the
//! bytes of its instructions and of its tool list, for each kind of session,
//! as a checked-in file records them.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use chord_core::adapter::{
    CONVERSATION_VIEW, ORCHESTRATOR_ROLE, ROLE_VAR, SESSION_VAR, VIEW_VAR, WAKES, WAKE_VAR,
};
use chord_core::scratch::Scratch;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Size {
    instructions: usize,
    tools: usize,
}

type Variables = Vec<(&'static str, &'static str)>;

/// The tool server's answers to a session with these variables, in a home
/// with default settings and no plugin running: the sizes of the
/// instructions and of the tool list's JSON as the line sent holds it, with
/// the tools' names.
fn measure(home: &Path, variables: &Variables) -> (Size, Vec<String>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_chord-remote"))
        .arg("mcp")
        .env("HOME", home)
        .envs(variables.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("the tool server starts");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize"}}"#).unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list"}}"#).unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let answers: BTreeMap<u64, (&str, Value)> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| {
            let value: Value = serde_json::from_str(line).unwrap();
            (value["id"].as_u64().unwrap(), (line, value))
        })
        .collect();
    let instructions = answers[&1].1["result"]["instructions"].as_str().unwrap();
    let (line, listed) = &answers[&2];
    let tools = &listed["result"]["tools"];
    let sent = tools.to_string();
    assert!(line.contains(&sent), "the tool list is measured as sent");
    let names = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    let size = Size {
        instructions: instructions.len(),
        tools: sent.len(),
    };
    (size, names)
}

/// A team's run led by the session `lead`, with a member whose agent
/// approves a gate, `reviewer`, and one whose agent approves none, `member`.
fn begin_run(home: &Path, folder: &Path) {
    let git = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(folder)
        .status()
        .expect("git should be installed");
    assert!(git.success());
    let team = chord_core::team::shipped()
        .into_iter()
        .find(|team| team.name == chord_core::team::SHIP_WITH_CHECKS)
        .unwrap();
    chord_core::run::begin(home, "lead", &team, folder).unwrap();
    for (token, agent, reads_only) in [
        ("reviewer", "Security reviewer", true),
        ("member", "Developer", false),
    ] {
        chord_core::run::join(home, "lead", token, agent, folder, None, reads_only, "").unwrap();
    }
}

/// Every kind of session whose instructions or tool list differ. Claude Code
/// and Codex are answered alike, so neither is a kind of its own.
fn kinds() -> Vec<(String, Variables, &'static [&'static str])> {
    let views: [(&str, Variables); 3] = [
        ("terminal", vec![]),
        ("terminal, woken", vec![(WAKE_VAR, WAKES)]),
        ("conversation", vec![(VIEW_VAR, CONVERSATION_VIEW)]),
    ];
    let mut kinds = Vec::new();
    for (view, variables) in views {
        kinds.push((view.to_string(), variables.clone(), &[][..]));
        let mut directing = variables;
        directing.push((ROLE_VAR, ORCHESTRATOR_ROLE));
        kinds.push((format!("{view}, orchestrator"), directing, &[][..]));
    }
    // A team's run adds its tools to whichever view the session has.
    let in_a_run: [(&str, &str, &[&str]); 3] = [
        (
            "conversation, run lead",
            "lead",
            &["plan", "gate_add", "keep", "gates"],
        ),
        (
            "conversation, run reviewer",
            "reviewer",
            &["verdict", "gates"],
        ),
        ("conversation, run member", "member", &["gates"]),
    ];
    for (kind, token, run_tools) in in_a_run {
        let mut variables = vec![(VIEW_VAR, CONVERSATION_VIEW), (SESSION_VAR, token)];
        if token == "lead" {
            variables.push((ROLE_VAR, ORCHESTRATOR_ROLE));
        }
        kinds.push((kind.to_string(), variables, run_tools));
    }
    kinds
}

#[test]
fn the_tool_server_s_context_is_the_size_the_budget_records() {
    // Made first: it clears the variables a session the workbench runs would
    // pass on to the servers started here.
    let home = Scratch::new("tool-context-home");
    let folder = Scratch::new("tool-context-folder");
    begin_run(&home, &folder);
    let measured: BTreeMap<String, Size> = kinds()
        .into_iter()
        .map(|(kind, variables, run_tools)| {
            let (size, names) = measure(&home, &variables);
            let listed: Vec<&str> = chord_core::mcp::RUN_TOOLS
                .iter()
                .copied()
                .filter(|tool| names.iter().any(|name| name == tool))
                .collect();
            assert_eq!(listed, run_tools, "the run's tools for {kind}");
            (kind, size)
        })
        .collect();

    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/tool-context-budget.json");
    let written = serde_json::to_string_pretty(&measured).unwrap() + "\n";
    if std::env::var("CHORD_WRITE_FIXTURES").is_ok() {
        std::fs::write(&file, &written).unwrap();
    }
    let kept = std::fs::read_to_string(&file).unwrap_or_default();
    let kept: Option<BTreeMap<String, Size>> = serde_json::from_str(&kept).ok();
    assert!(
        kept.as_ref() == Some(&measured),
        "what the tool server puts in an agent's context differs from the budget in {}\n\n\
         Measured, in bytes:\n{written}\n\
         If the change in size is meant, rewrite the file and commit it:\n\
         CHORD_WRITE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml -p chord-core --test tool_context",
        file.display()
    );
}
