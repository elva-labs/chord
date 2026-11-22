use std::collections::VecDeque;

use serde_json::Value;

use super::*;

/// Answers each request with the next of the answers given, and keeps
/// what it was asked.
struct Recorded {
    asked: Vec<(String, Value)>,
    answers: VecDeque<Answer>,
}

impl Recorded {
    fn new(answers: impl IntoIterator<Item = Answer>) -> Self {
        Self {
            asked: Vec::new(),
            answers: answers.into_iter().collect(),
        }
    }
}

impl Ask for Recorded {
    fn ask(&mut self, method: &str, params: Value) -> Answer {
        self.asked.push((method.to_string(), params));
        self.answers
            .pop_front()
            .unwrap_or_else(|| Answer::Gone("no more answers".into()))
    }
}

fn listed() -> Value {
    json!({
        "data": [
            {"id": "gpt-6.2-sol", "model": "gpt-6.2-sol", "displayName": "GPT-6.2-Sol",
             "description": "", "hidden": false, "isDefault": true,
             "supportedReasoningEfforts": [
                 {"reasoningEffort": "low", "description": "Quick"},
                 {"reasoningEffort": "high", "description": "Thorough"}
             ],
             "defaultReasoningEffort": "low"},
            {"id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol",
             "hidden": false, "supportedReasoningEfforts": []},
            {"id": "gpt-old", "model": "gpt-old", "displayName": "Old", "hidden": true}
        ],
        "nextCursor": null
    })
}

#[test]
fn reads_the_models_codex_lists_with_their_names() {
    let mut server = Recorded::new([Answer::Result(listed())]);
    let catalog = catalog_of(&mut server).unwrap();
    let names: Vec<_> = catalog
        .models
        .iter()
        .map(|model| (model.value.as_str(), model.name.as_deref()))
        .collect();
    assert_eq!(
        names,
        [
            ("gpt-6.2-sol", Some("GPT-6.2-Sol")),
            ("gpt-6.1-sol", Some("GPT-6.1-Sol"))
        ]
    );
    assert!(catalog.models[0].is_default);
    assert_eq!(catalog.models[0].efforts, ["low", "high"]);
    assert_eq!(server.asked, [("model/list".to_string(), json!({}))]);
}

#[test]
fn reads_every_page_codex_lists_its_models_on() {
    let mut first = listed();
    first["nextCursor"] = json!("3");
    let second = json!({"data": [
        {"id": "gpt-5.6-luna", "model": "gpt-5.6-luna", "displayName": "GPT-5.6-Luna",
         "hidden": false, "supportedReasoningEfforts": []}
    ], "nextCursor": null});
    let mut server = Recorded::new([Answer::Result(first), Answer::Result(second)]);
    let catalog = catalog_of(&mut server).unwrap();
    let values: Vec<_> = catalog.models.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(values, ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-5.6-luna"]);
    assert_eq!(
        server.asked[1],
        ("model/list".to_string(), json!({"cursor": "3"}))
    );
    // A later page that cannot be read leaves the ones before it, and a
    // cursor said again ends the list.
    let mut first = listed();
    first["nextCursor"] = json!("3");
    let mut server = Recorded::new([
        Answer::Result(first),
        Answer::Refused("invalid cursor".into()),
    ]);
    assert_eq!(catalog_of(&mut server).unwrap().models.len(), 2);
    let mut again = listed();
    again["nextCursor"] = json!("3");
    let mut server = Recorded::new([Answer::Result(again.clone()), Answer::Result(again)]);
    assert_eq!(catalog_of(&mut server).unwrap().models.len(), 2);
    assert_eq!(server.asked.len(), 2);
}

#[test]
fn says_why_where_codex_will_not_list_its_models() {
    let mut server = Recorded::new([Answer::Refused("not signed in".into())]);
    assert_eq!(
        catalog_of(&mut server),
        Err("Codex would not list its models: not signed in".to_string())
    );
    let mut server = Recorded::new([Answer::TooLong]);
    assert!(catalog_of(&mut server).is_err());
}

#[test]
fn says_the_catalog_as_the_window_reads_it() {
    let mut server = Recorded::new([Answer::Result(listed())]);
    let said = serde_json::to_value(catalog_of(&mut server).unwrap()).unwrap();
    assert_eq!(said["models"][0]["value"], "gpt-6.2-sol");
    assert_eq!(said["models"][0]["name"], "GPT-6.2-Sol");
    assert_eq!(said["models"][0]["isDefault"], true);
}
