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
//! agent of the user's takes one.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// A model on one harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModel {
    pub harness: String,
    pub model: String,
}

/// One of the user's own agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Agent {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub model: Option<AgentModel>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub reads_only: bool,
}

const SHAPE: &str =
    "agents is a list of agents, each a title, a description, a model or none, an effort or none, and whether it reads only";

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

/// The agents a value holds, their titles and descriptions trimmed, or the
/// reason one will not do. Titles are unique, ignoring case.
pub fn read(value: &Value) -> Result<Vec<Agent>, String> {
    let list = value.as_array().ok_or(SHAPE)?;
    if list.len() > MOST_AGENTS {
        return Err(format!("the settings hold {MOST_AGENTS} agents at most"));
    }
    let mut agents: Vec<Agent> = Vec::with_capacity(list.len());
    for entry in list {
        let mut agent: Agent = serde_json::from_value(entry.clone()).map_err(|_| SHAPE)?;
        check(&agent)?;
        agent.title = agent.title.trim().to_string();
        agent.description = agent.description.trim().to_string();
        if agents
            .iter()
            .any(|earlier| earlier.title.eq_ignore_ascii_case(&agent.title))
        {
            return Err(format!("there is already an agent called {}", agent.title));
        }
        agents.push(agent);
    }
    Ok(agents)
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
        assert!(
            with("model", json!({ "agent": "codex", "model": "gpt" })).contains("agents is a list")
        );
        assert!(with("effort", json!("very high")).contains("effort"));
        assert!(with("readsOnly", json!("yes")).contains("agents is a list"));
        assert!(with("colour", json!("red")).contains("agents is a list"));
        assert!(read(&json!({ "Migrations": {} })).is_err());
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
}
