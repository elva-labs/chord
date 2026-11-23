//! Teams: the agents a lead may call and the gates their work passes.
//!
//! A team names its members, each an agent by title with the models it may
//! run on, and its gates. A gate says which member approves, and when: the
//! plan, before building, or the change, before handing over. A gate may
//! hold only when the work touches some paths. The lead is the session the
//! user starts with the team; it has no agent of its own and, unless the
//! team says otherwise, does no work itself. How many sessions of a member
//! run at once and how many times a gate may ask for changes are the
//! workbench's, not the team's.
//!
//! The settings file keeps the teams beside the workflows, which stay as
//! written for a version that knows no teams. A field this version does
//! not know is kept as written, so a later version may add one back.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::workflow::{self, Step, Workflows, AGENTS as HARNESSES};

/// How many teams the settings may hold, how many members and gates one
/// may have, how many models a member may list, how many globs a gate,
/// and how long a name, a glob or a model's name may be.
pub const MOST_TEAMS: usize = 16;
pub const MOST_MEMBERS: usize = 16;
pub const MOST_GATES: usize = 16;
pub const MOST_MODELS: usize = 16;
pub const MOST_GLOBS: usize = 16;
pub const LONGEST_NAME: usize = 40;
const LONGEST_GLOB: usize = 200;
const LONGEST_WORD: usize = 40;

/// How many sessions of a member run at once, and how many times a gate
/// may ask for changes before it waits for the user. A team sets neither.
pub const AT_ONCE: u32 = 3;
pub const ROUNDS: u32 = 3;

pub const SHIP_WITH_CHECKS: &str = "Ship with checks";
pub const QUICK_FIX: &str = "Quick fix";

/// The agent a workflow's work step becomes, and its review step.
pub const DEVELOPER: &str = "Developer";
pub const REVIEWER: &str = "Reviewer";

/// A model on one harness. A field this version does not know is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub harness: String,
    pub model: String,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

/// An agent the lead may call, by title. An empty `models` lets it run on
/// the model its agent names, or any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<Model>,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

/// When a gate holds: on the plan, before building, or on the change,
/// before handing over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum When {
    Plan,
    Change,
}

impl When {
    pub fn words(self) -> &'static str {
        match self {
            When::Plan => "before building",
            When::Change => "before handing over",
        }
    }
}

/// A member's approval the work waits for. With `touches`, the gate holds
/// only when the plan's paths or the branch's changes match one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gate {
    pub who: String,
    pub when: When,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touches: Option<Vec<String>>,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Team {
    pub name: String,
    pub members: Vec<Member>,
    #[serde(default)]
    pub gates: Vec<Gate>,
    /// Whether the lead only reads and calls its members, delegating
    /// through the workbench's start tool. On unless the team says
    /// otherwise, and written only when off.
    #[serde(rename = "startOnly", default = "on", skip_serializing_if = "is_on")]
    pub start_only: bool,
    #[serde(flatten)]
    pub later: Map<String, Value>,
}

fn on() -> bool {
    true
}

fn is_on(value: &bool) -> bool {
    *value
}

impl Team {
    pub fn member(&self, agent: &str) -> Option<&Member> {
        self.members
            .iter()
            .find(|member| member.agent.eq_ignore_ascii_case(agent))
    }

    /// Whether some gate names the agent as the one who approves.
    pub fn approves(&self, agent: &str) -> bool {
        self.gates
            .iter()
            .any(|gate| gate.who.eq_ignore_ascii_case(agent))
    }
}

fn member(agent: &str) -> Member {
    Member {
        agent: agent.into(),
        models: Vec::new(),
        later: Map::new(),
    }
}

fn gate(who: &str, when: When, touches: Option<&[&str]>) -> Gate {
    Gate {
        who: who.into(),
        when,
        touches: touches.map(|globs| globs.iter().map(|glob| glob.to_string()).collect()),
        later: Map::new(),
    }
}

fn team(name: &str, members: &[&str], gates: Vec<Gate>) -> Team {
    Team {
        name: name.into(),
        members: members.iter().map(|agent| member(agent)).collect(),
        gates,
        start_only: true,
        later: Map::new(),
    }
}

/// The teams Chord ships. Ship with checks: a researcher, developers, a
/// tester and three who approve: security on the plan and the change,
/// the cloud architect on a plan that touches infrastructure, and a
/// reviewer on the change. Quick fix: developers and a reviewer who
/// approves the change.
pub fn shipped() -> Vec<Team> {
    vec![
        team(
            SHIP_WITH_CHECKS,
            &[
                "Researcher",
                DEVELOPER,
                "Tester",
                "Security reviewer",
                REVIEWER,
                "Cloud architect",
            ],
            vec![
                gate("Security reviewer", When::Plan, None),
                gate("Cloud architect", When::Plan, Some(&["infra/**"])),
                gate("Security reviewer", When::Change, None),
                gate(REVIEWER, When::Change, None),
            ],
        ),
        team(
            QUICK_FIX,
            &[DEVELOPER, REVIEWER],
            vec![gate(REVIEWER, When::Change, None)],
        ),
    ]
}

fn fits_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name.chars().count() <= LONGEST_NAME
        && !name.chars().any(|c| c.is_control())
}

fn is_word(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= LONGEST_WORD
        && !text.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn check_model(owner: &str, model: &Model) -> Result<(), String> {
    if !HARNESSES.contains(&model.harness.as_str()) {
        return Err(format!(
            "{owner} names the harness {:?}, which is one of {}",
            model.harness,
            HARNESSES.join(", ")
        ));
    }
    if !is_word(&model.model) {
        return Err(format!(
            "{owner} names a model that is one word, {LONGEST_WORD} characters at most, not {:?}",
            model.model
        ));
    }
    Ok(())
}

/// Whether a glob will do: a path pattern relative to the project, short,
/// on one line, whose parts are each a name or a pattern. A glob that
/// starts with `/` or `./`, ends with `/`, or has an empty, `.` or `..`
/// part would match no path git names, so it is refused.
fn fits_glob(glob: &str) -> bool {
    !glob.trim().is_empty()
        && glob.len() <= LONGEST_GLOB
        && !glob.chars().any(|c| c.is_control())
        && glob
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Whether one team keeps the rules: a name, members each named once with
/// models that exist, and gates each naming one of its members, with
/// paths that will do.
pub fn check_team(team: &Team) -> Result<(), String> {
    let name = team.name.trim();
    if !fits_name(name) {
        return Err(format!(
            "a team needs a name of a few words, {LONGEST_NAME} characters at most"
        ));
    }
    if team.members.is_empty() {
        return Err(format!("{name} needs at least one agent"));
    }
    if team.members.len() > MOST_MEMBERS {
        return Err(format!("{name} has {MOST_MEMBERS} agents at most"));
    }
    if team.gates.len() > MOST_GATES {
        return Err(format!("{name} has {MOST_GATES} gates at most"));
    }
    for (index, member) in team.members.iter().enumerate() {
        let agent = member.agent.trim();
        if !fits_name(agent) {
            return Err(format!(
                "an agent of {name} is named by its title, {LONGEST_NAME} characters at most"
            ));
        }
        if team.members[..index]
            .iter()
            .any(|earlier| earlier.agent.trim().eq_ignore_ascii_case(agent))
        {
            return Err(format!("{name} has {agent} twice"));
        }
        let owner = format!("{agent} in {name}");
        if member.models.len() > MOST_MODELS {
            return Err(format!("{owner} lists {MOST_MODELS} models at most"));
        }
        for (at, model) in member.models.iter().enumerate() {
            check_model(&owner, model)?;
            if member.models[..at]
                .iter()
                .any(|earlier| (&earlier.harness, &earlier.model) == (&model.harness, &model.model))
            {
                return Err(format!("{owner} lists {} twice", model.model));
            }
        }
    }
    for (index, gate) in team.gates.iter().enumerate() {
        let who = gate.who.trim();
        if team.member(who).is_none() {
            return Err(format!(
                "a gate of {name} waits for {who:?}, which is not one of its agents"
            ));
        }
        if team.gates[..index].iter().any(|earlier| {
            earlier.who.trim().eq_ignore_ascii_case(who) && earlier.when == gate.when
        }) {
            return Err(format!(
                "{name} has {who} approve {} twice",
                gate.when.words()
            ));
        }
        if let Some(globs) = &gate.touches {
            if globs.is_empty() || globs.len() > MOST_GLOBS {
                return Err(format!(
                    "the gate of {who} in {name} names between 1 and {MOST_GLOBS} paths it holds for"
                ));
            }
            if let Some(bad) = globs.iter().find(|glob| !fits_glob(glob)) {
                return Err(format!(
                    "the gate of {who} in {name} holds for paths in the project, such as infra/**, not {bad:?}"
                ));
            }
        }
    }
    Ok(())
}

/// A team in the settings file that does not read or keep the rules, with
/// the rule it breaks, its name where it has one, and where it stands in
/// the file's list.
#[derive(Debug, Clone, PartialEq)]
pub struct SetAside {
    pub at: usize,
    pub name: String,
    pub reason: String,
    pub entry: Value,
}

const SHAPE: &str = "teams is a list of teams";
const ONE_SHAPE: &str = "a team is a name, its agents, and its gates, each an agent who approves the plan or the change";

/// The team an entry holds, its names trimmed, or the reason it will not
/// do beside the teams read before it. Names are unique, ignoring case.
fn one(entry: &Value, earlier: &[Team]) -> Result<Team, String> {
    let mut team: Team = serde_json::from_value(entry.clone()).map_err(|_| ONE_SHAPE)?;
    check_team(&team)?;
    team.name = team.name.trim().to_string();
    for member in &mut team.members {
        member.agent = member.agent.trim().to_string();
    }
    for gate in &mut team.gates {
        gate.who = gate.who.trim().to_string();
    }
    if earlier
        .iter()
        .any(|kept| kept.name.eq_ignore_ascii_case(&team.name))
    {
        return Err(format!("there is already a team called {}", team.name));
    }
    Ok(team)
}

/// The teams a value holds, or the reason one will not do. A change sets
/// the teams this way, whole or not at all.
pub fn read(value: &Value) -> Result<Vec<Team>, String> {
    let list = value.as_array().ok_or(SHAPE)?;
    if list.len() > MOST_TEAMS {
        return Err(format!("the settings hold {MOST_TEAMS} teams at most"));
    }
    let mut teams: Vec<Team> = Vec::with_capacity(list.len());
    for entry in list {
        let team = one(entry, &teams)?;
        teams.push(team);
    }
    Ok(teams)
}

/// The teams a settings file's list holds, read one at a time: each one
/// that does not read or keep the rules, one whose name an earlier one
/// has, and one past the most the settings hold is set aside with the
/// reason, and the rest are used.
pub fn read_lenient(list: &[Value]) -> (Vec<Team>, Vec<SetAside>) {
    let mut teams: Vec<Team> = Vec::new();
    let mut aside = Vec::new();
    for (at, entry) in list.iter().enumerate() {
        let reason = match one(entry, &teams) {
            Ok(team) if teams.len() < MOST_TEAMS => {
                teams.push(team);
                continue;
            }
            Ok(_) => format!("the settings hold {MOST_TEAMS} teams at most"),
            Err(reason) => reason,
        };
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        aside.push(SetAside {
            at,
            name: name.trim().to_string(),
            reason,
            entry: entry.clone(),
        });
    }
    (teams, aside)
}

fn model_of(model: &workflow::Model) -> Model {
    Model {
        harness: model.agent.clone(),
        model: model.model.clone(),
        later: Map::new(),
    }
}

/// Adds models to a member's list, each once. A step that lists none
/// allows any, and so does the member then.
fn widen(models: &mut Option<Vec<Model>>, more: &[workflow::Model]) {
    match models {
        None => {}
        Some(_) if more.is_empty() => *models = None,
        Some(list) => {
            for model in more.iter().map(model_of) {
                if !list
                    .iter()
                    .any(|kept| (&kept.harness, &kept.model) == (&model.harness, &model.model))
                {
                    list.push(model);
                }
            }
        }
    }
}

/// The team a workflow becomes. Its work steps become one Developer, on
/// the models they list, and its review steps one Reviewer, on the models
/// they list, with a gate on the change. A workflow with no review has no
/// gate. The rest is not carried over: how many sessions a step ran at
/// once and how many times a review sent the work back, since a team uses
/// the workbench's defaults for both; the orchestrator's model, since the
/// lead is the session the user starts; and who agrees with a review and
/// which step it goes back to, since a team has no order.
pub fn from_workflow(source: &workflow::Workflow) -> Team {
    let mut work: Option<Option<Vec<Model>>> = None;
    let mut review: Option<Option<Vec<Model>>> = None;
    for step in &source.steps {
        let slot = match step {
            Step::Work { .. } => &mut work,
            Step::Review { .. } => &mut review,
        };
        widen(slot.get_or_insert_with(|| Some(Vec::new())), step.models());
    }
    let with_models = |agent: &str, models: Option<Vec<Model>>| Member {
        agent: agent.into(),
        models: models.unwrap_or_default(),
        later: Map::new(),
    };
    let mut members = Vec::new();
    let mut gates = Vec::new();
    if let Some(models) = work {
        members.push(with_models(DEVELOPER, models));
    }
    if let Some(models) = review {
        members.push(with_models(REVIEWER, models));
        gates.push(gate(REVIEWER, When::Change, None));
    }
    Team {
        name: source.name.trim().to_string(),
        members,
        gates,
        start_only: source.start_only,
        later: Map::new(),
    }
}

/// The teams a file from before teams is given: each workflow it uses that
/// the user made or changed, in order, then each shipped team whose name
/// is free while there is room. A workflow equal, once read, to one the
/// workbench ships makes no team, so an untouched install gets only the
/// shipped teams. A workflow that is set aside stays in the workflows only.
/// Each team carries the workflow's agents and models over, and no
/// orchestrator model, review limit or parallel count (see
/// [`from_workflow`]).
pub fn from_workflows(workflows: &Workflows) -> Vec<Team> {
    let stock = Workflows::default().list;
    let mut teams: Vec<Team> = Vec::new();
    for source in workflows
        .list
        .iter()
        .filter(|source| !stock.contains(source))
    {
        let team = from_workflow(source);
        let taken = teams
            .iter()
            .any(|kept| kept.name.eq_ignore_ascii_case(&team.name));
        if teams.len() < MOST_TEAMS && !taken && check_team(&team).is_ok() {
            teams.push(team);
        }
    }
    for team in shipped() {
        let taken = teams
            .iter()
            .any(|kept| kept.name.eq_ignore_ascii_case(&team.name));
        if teams.len() < MOST_TEAMS && !taken {
            teams.push(team);
        }
    }
    teams
}

/// Whether a path the work touches matches one of a gate's globs. In a
/// glob, `*` stands for any characters within one part of a path, `?` for
/// one character, and a part that is `**` for any number of parts, at
/// least one when it ends the glob, so `infra/**` holds for what is in
/// `infra` and not for a file named `infra`; the rest stands for itself.
pub fn touches(globs: &[String], paths: &[String]) -> bool {
    globs.iter().any(|glob| {
        let parts: Vec<&str> = glob.split('/').collect();
        paths.iter().any(|path| {
            let along: Vec<&str> = path.split('/').collect();
            parts_match(&parts, &along)
        })
    })
}

/// Whether any of the globs holds for a path a plan names, taking each path
/// as a file or as a folder: a folder holds for a glob when anything inside
/// it could match, so a plan that names `infra` puts an `infra/**` gate in
/// force.
pub fn plan_touches(globs: &[String], paths: &[String]) -> bool {
    touches(globs, paths)
        || globs.iter().any(|glob| {
            let parts: Vec<&str> = glob.split('/').collect();
            paths.iter().any(|path| {
                let along: Vec<&str> = path.split('/').collect();
                inside_could_match(&parts, &along)
            })
        })
}

/// Whether the glob could match a path inside the folder `path`: some
/// leading parts of the glob match the whole folder and at least one part
/// is left for what is inside it.
fn inside_could_match(glob: &[&str], path: &[&str]) -> bool {
    let width = path.len() + 1;
    // `reach[g * width + p]`: whether glob[..g] matches path[..p].
    let mut reach = vec![false; (glob.len() + 1) * width];
    reach[0] = true;
    for g in 0..glob.len() {
        for p in 0..=path.len() {
            if !reach[g * width + p] {
                continue;
            }
            if glob[g] == "**" {
                reach[(g + 1) * width + p] = true;
                if p < path.len() {
                    reach[g * width + p + 1] = true;
                }
            } else if p < path.len() && part_matches(glob[g], path[p]) {
                reach[(g + 1) * width + p + 1] = true;
            }
        }
    }
    (0..glob.len()).any(|g| reach[g * width + path.len()])
}

/// Whether the parts of a path match the parts of a glob, worked from the
/// end in a table of glob parts against path parts, so no glob takes long.
fn parts_match(glob: &[&str], path: &[&str]) -> bool {
    let width = path.len() + 1;
    // `fits[g * width + p]`: whether glob[g..] matches path[p..].
    let mut fits = vec![false; (glob.len() + 1) * width];
    fits[glob.len() * width + path.len()] = true;
    for g in (0..glob.len()).rev() {
        for p in (0..=path.len()).rev() {
            fits[g * width + p] = if glob[g] == "**" && g > 0 && g + 1 == glob.len() {
                p < path.len()
            } else if glob[g] == "**" {
                fits[(g + 1) * width + p] || (p < path.len() && fits[g * width + p + 1])
            } else {
                p < path.len() && part_matches(glob[g], path[p]) && fits[(g + 1) * width + p + 1]
            };
        }
    }
    fits[0]
}

fn part_matches(glob: &str, part: &str) -> bool {
    let glob: Vec<char> = glob.chars().collect();
    let part: Vec<char> = part.chars().collect();
    let (mut g, mut p) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while p < part.len() {
        match glob.get(g) {
            Some('*') => {
                star = Some((g, p));
                g += 1;
            }
            Some(&c) if c == '?' || c == part[p] => {
                g += 1;
                p += 1;
            }
            _ => match star {
                Some((at, from)) => {
                    g = at + 1;
                    p = from + 1;
                    star = Some((at, from + 1));
                }
                None => return false,
            },
        }
    }
    glob[g..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_shipped_teams_keep_their_own_rules() {
        let teams = shipped();
        for team in &teams {
            check_team(team).unwrap();
        }
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, [SHIP_WITH_CHECKS, QUICK_FIX]);
        assert_eq!(teams[0].members.len(), 6);
        assert_eq!(teams[0].gates.len(), 4);
        assert_eq!(teams[1].members.len(), 2);
        assert_eq!(teams[1].gates.len(), 1);
        // Each shipped member is an agent Chord ships.
        for team in &teams {
            for member in &team.members {
                assert!(crate::agents::SHIPPED_TITLES.contains(&member.agent.as_str()));
            }
        }
    }

    #[test]
    fn a_team_is_written_with_only_the_fields_that_say_something() {
        let value = serde_json::to_value(&shipped()[1]).unwrap();
        assert_eq!(
            value,
            json!({
                "name": "Quick fix",
                "members": [{ "agent": "Developer" }, { "agent": "Reviewer" }],
                "gates": [{ "who": "Reviewer", "when": "change" }],
            })
        );
        assert_eq!(read(&json!([value])).unwrap(), vec![shipped()[1].clone()]);
    }

    #[test]
    fn a_field_this_version_does_not_know_is_kept() {
        let entry = json!({
            "name": "Later",
            "members": [{ "agent": "Developer", "brief": "short" }],
            "gates": [{ "who": "Developer", "when": "plan", "letter": "A" }],
            "goal": "ship it",
        });
        let teams = read(&json!([entry])).unwrap();
        assert_eq!(serde_json::to_value(&teams[0]).unwrap(), entry);
    }

    #[test]
    fn the_lead_count_and_rounds_a_file_names_are_kept_and_not_used() {
        let entry = json!({
            "name": "Earlier",
            "members": [{ "agent": "Developer", "count": 0 }, { "agent": "Reviewer", "count": 99 }],
            "gates": [{ "who": "Reviewer", "when": "change", "rounds": 0 }],
            "lead": { "harness": "nowhere", "model": "two words" },
        });
        let teams = read(&json!([entry])).unwrap();
        assert_eq!(teams[0].gates.len(), 1);
        assert_eq!(serde_json::to_value(&teams[0]).unwrap(), entry);
    }

    fn with(change: impl FnOnce(&mut Value)) -> Result<Vec<Team>, String> {
        let mut value = serde_json::to_value(shipped()).unwrap();
        change(&mut value);
        read(&value)
    }

    #[test]
    fn a_team_is_refused_when_it_breaks_a_rule() {
        assert!(with(|v| v[0]["name"] = json!(" ")).is_err());
        assert!(with(|v| v[0]["members"] = json!([])).is_err());
        assert!(with(|v| v[1]["name"] = json!("ship WITH checks"))
            .unwrap_err()
            .contains("already a team"));
        assert!(with(|v| v[1]["gates"][0]["who"] = json!("Tester"))
            .unwrap_err()
            .contains("not one of its agents"));
        assert!(with(|v| v[1]["gates"][0]["when"] = json!("done")).is_err());
        assert!(with(|v| v[1]["members"][1]["agent"] = json!("developer"))
            .unwrap_err()
            .contains("twice"));
        assert!(with(|v| v[1]["gates"][0]["touches"] = json!([])).is_err());
        assert!(with(|v| v[1]["gates"][0]["touches"] = json!(["/etc/**"])).is_err());
        assert!(with(
            |v| v[1]["members"][0]["models"] = json!([{ "harness": "gpt", "model": "x" }])
        )
        .is_err());
        assert!(with(|v| v[1]["gates"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "who": "Reviewer", "when": "change" })))
        .unwrap_err()
        .contains("twice"));
    }

    #[test]
    fn a_team_that_does_not_read_is_set_aside_and_the_rest_are_used() {
        let list = vec![
            json!({ "name": "Broken", "members": "none" }),
            serde_json::to_value(&shipped()[1]).unwrap(),
            serde_json::to_value(&shipped()[1]).unwrap(),
        ];
        let (teams, aside) = read_lenient(&list);
        assert_eq!(teams.len(), 1);
        assert_eq!(aside.len(), 2);
        assert_eq!(aside[0].at, 0);
        assert_eq!(aside[0].name, "Broken");
        assert_eq!(aside[1].at, 2);
        assert!(aside[1].reason.contains("already a team"));
    }

    /// The workflows a version before teams wrote by default: Build and
    /// review, and Direct, as the file holds them.
    fn stored_defaults() -> Value {
        json!({
            "list": [
                {
                    "name": "Build and review",
                    "orchestrator": { "agent": "claude-code", "model": "fable" },
                    "steps": [
                        { "kind": "work", "name": "Work", "models": [{ "agent": "claude-code", "model": "sonnet" }], "parallel": 1 },
                        { "kind": "review", "name": "Review", "models": [{ "agent": "claude-code", "model": "opus" }], "reviewerApproves": true, "orchestratorAgrees": true, "backTo": "Work", "limit": 3 }
                    ]
                },
                {
                    "name": "Direct",
                    "orchestrator": { "agent": "claude-code", "model": "fable" },
                    "steps": [{ "kind": "work", "name": "Work", "models": [], "parallel": 8 }]
                }
            ],
            "default": null,
            "overrides": {}
        })
    }

    #[test]
    fn a_workflow_the_user_changed_becomes_a_team_beside_the_shipped_teams() {
        let mut stored = stored_defaults();
        stored["list"][0]["name"] = json!("My build");
        stored["list"][1]["name"] = json!("My direct");
        let teams = from_workflows(&workflow::read(&stored).unwrap());
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(
            names,
            ["My build", "My direct", SHIP_WITH_CHECKS, QUICK_FIX]
        );
        assert_eq!(
            serde_json::to_value(&teams[0]).unwrap(),
            json!({
                "name": "My build",
                "members": [
                    { "agent": "Developer", "models": [{ "harness": "claude-code", "model": "sonnet" }] },
                    { "agent": "Reviewer", "models": [{ "harness": "claude-code", "model": "opus" }] }
                ],
                "gates": [{ "who": "Reviewer", "when": "change" }]
            })
        );
        // Direct has no gate and lets any model run; its eight at once and
        // the orchestrator's model are not carried over.
        assert_eq!(
            serde_json::to_value(&teams[1]).unwrap(),
            json!({
                "name": "My direct",
                "members": [{ "agent": "Developer" }],
                "gates": []
            })
        );
        for team in &teams {
            check_team(team).unwrap();
        }
    }

    #[test]
    fn a_workflow_of_the_users_own_keeps_what_it_set() {
        let stored = json!({
            "list": [{
                "name": "Careful",
                "orchestrator": { "agent": "codex", "model": "gpt-5.5" },
                "startOnly": false,
                "steps": [
                    { "kind": "work", "name": "Build", "models": [{ "agent": "codex", "model": "gpt-5.5" }, { "agent": "claude-code", "model": "sonnet" }], "parallel": 2 },
                    { "kind": "review", "name": "First look", "models": [{ "agent": "claude-code", "model": "opus" }], "reviewerApproves": true, "orchestratorAgrees": false, "backTo": "Build", "limit": 5 },
                    { "kind": "work", "name": "Polish", "models": [{ "agent": "claude-code", "model": "sonnet" }], "parallel": 4 },
                    { "kind": "review", "name": "Last look", "models": [{ "agent": "codex", "model": "default" }], "reviewerApproves": false, "orchestratorAgrees": true, "backTo": "Polish", "limit": 2 }
                ]
            }],
            "default": "Careful",
            "overrides": { "/Users/someone/project": "Careful" }
        });
        let teams = from_workflows(&workflow::read(&stored).unwrap());
        assert_eq!(teams.len(), 3);
        assert_eq!(
            serde_json::to_value(&teams[0]).unwrap(),
            json!({
                "name": "Careful",
                "members": [
                    { "agent": "Developer", "models": [{ "harness": "codex", "model": "gpt-5.5" }, { "harness": "claude-code", "model": "sonnet" }] },
                    { "agent": "Reviewer", "models": [{ "harness": "claude-code", "model": "opus" }, { "harness": "codex", "model": "default" }] }
                ],
                "gates": [{ "who": "Reviewer", "when": "change" }],
                "startOnly": false
            })
        );
        // A step that allows any model makes the member allow any.
        let mut any = stored.clone();
        any["list"][0]["steps"][2]["models"] = json!([]);
        let teams = from_workflows(&workflow::read(&any).unwrap());
        assert!(teams[0].members[0].models.is_empty());
    }

    #[test]
    fn a_workflow_named_like_a_shipped_team_keeps_the_name() {
        let mut stored = stored_defaults();
        stored["list"][1]["name"] = json!("quick fix");
        let teams = from_workflows(&workflow::read(&stored).unwrap());
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, ["quick fix", SHIP_WITH_CHECKS]);
    }

    #[test]
    fn a_full_list_of_workflows_leaves_no_room_for_the_shipped_teams() {
        let mut stored = stored_defaults();
        let one = stored["list"][1].clone();
        let list: Vec<Value> = (0..MOST_TEAMS)
            .map(|at| {
                let mut each = one.clone();
                each["name"] = json!(format!("Flow {at}"));
                each
            })
            .collect();
        stored["list"] = Value::from(list);
        let teams = from_workflows(&workflow::read(&stored).unwrap());
        assert_eq!(teams.len(), MOST_TEAMS);
        assert!(!teams.iter().any(|team| team.name == QUICK_FIX));
    }

    #[test]
    fn a_gate_on_paths_holds_for_the_paths_it_names() {
        let globs = vec!["infra/**".to_string()];
        assert!(touches(&globs, &["infra/main.tf".into()]));
        assert!(touches(&globs, &["infra/modules/net/vpc.tf".into()]));
        assert!(!touches(&globs, &["src/infra.rs".into()]));
        assert!(!touches(&globs, &[]));
        let rust = vec!["*.rs".to_string()];
        assert!(touches(&rust, &["main.rs".into()]));
        assert!(!touches(&rust, &["src/main.rs".into()]));
        let deep = vec!["**/*.tf".to_string(), "docs/?.md".to_string()];
        assert!(touches(&deep, &["main.tf".into()]));
        assert!(touches(&deep, &["a/b/c.tf".into()]));
        assert!(touches(&deep, &["docs/a.md".into()]));
        assert!(!touches(&deep, &["docs/ab.md".into(), "main.tfx".into()]));
        // Many parts of `**` against a deep path answer at once.
        let many = vec![format!("{}x", "**/".repeat(100))];
        let path = vec!["a/".repeat(100) + "y"];
        assert!(!touches(&many, &path));
    }

    #[test]
    fn a_folder_a_plan_names_holds_for_the_globs_inside_it() {
        let globs = |list: &[&str]| -> Vec<String> { list.iter().map(|g| g.to_string()).collect() };
        let paths = |list: &[&str]| -> Vec<String> { list.iter().map(|p| p.to_string()).collect() };
        assert!(plan_touches(&globs(&["infra/**"]), &paths(&["infra"])));
        assert!(plan_touches(&globs(&["infra/*.tf"]), &paths(&["infra"])));
        assert!(plan_touches(&globs(&["**/*.rs"]), &paths(&["src"])));
        assert!(plan_touches(
            &globs(&["src/**/auth/*"]),
            &paths(&["src/app"])
        ));
        assert!(plan_touches(
            &globs(&["infra/**"]),
            &paths(&["infra/main.tf"])
        ));
        assert!(!plan_touches(&globs(&["infra/**"]), &paths(&["docs"])));
        assert!(!plan_touches(
            &globs(&["infra/*.tf"]),
            &paths(&["infra/modules/x"])
        ));
        assert!(plan_touches(
            &globs(&["src/*.rs"]),
            &paths(&["src/main.rs"])
        ));
        assert!(!touches(&globs(&["infra/**"]), &paths(&["infra"])));
    }

    #[test]
    fn a_glob_ending_in_two_stars_holds_for_what_is_inside_and_not_the_name() {
        let globs = vec!["infra/**".to_string()];
        assert!(!touches(&globs, &["infra".into()]));
        assert!(touches(&globs, &["infra/a".into()]));
        let within = ["a/**/b".to_string(), "**".to_string()];
        assert!(touches(&within[..1], &["a/b".into()]));
        assert!(touches(&within[..1], &["a/x/y/b".into()]));
        assert!(touches(&within[1..], &["top.md".into()]));
    }

    #[test]
    fn a_glob_that_could_match_no_path_is_refused() {
        for bad in [
            "./infra/**",
            "/infra/**",
            "infra/",
            "infra//main.tf",
            "../infra",
            "a/./b",
            " ",
        ] {
            let refused = with(|team| team[0]["gates"][0]["touches"] = json!([bad]));
            assert!(refused.is_err(), "{bad:?} was let through");
        }
        with(|team| team[0]["gates"][0]["touches"] = json!(["infra/**", "*.tf"])).unwrap();
    }

    #[test]
    fn a_workflow_equal_to_a_shipped_one_makes_no_team() {
        let teams = from_workflows(&Workflows::default());
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, [SHIP_WITH_CHECKS, QUICK_FIX]);
        // The stock workflows as an earlier version writes them read the same.
        let teams = from_workflows(&workflow::read(&stored_defaults()).unwrap());
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, [SHIP_WITH_CHECKS, QUICK_FIX]);
        // One the user changed becomes a team.
        let mut changed = stored_defaults();
        changed["list"][0]["steps"][1]["limit"] = json!(4);
        let teams = from_workflows(&workflow::read(&changed).unwrap());
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, ["Build and review", SHIP_WITH_CHECKS, QUICK_FIX]);
    }
}
