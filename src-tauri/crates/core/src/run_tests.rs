use super::*;
use crate::scratch::Scratch;
use crate::team::{shipped, QUICK_FIX, REVIEWER, SHIP_WITH_CHECKS};
use std::process::Command;

fn repo(name: &str) -> Scratch {
    let dir = Scratch::new(&format!("run-{name}"));
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .output()
            .expect("git should be installed");
    }
    dir
}

fn write(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn commit(dir: &Path) {
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "commit"]] {
        Command::new("git")
            .args(&args)
            .current_dir(dir)
            .output()
            .unwrap();
    }
}

fn team(name: &str) -> Team {
    shipped()
        .into_iter()
        .find(|team| team.name == name)
        .unwrap()
}

/// A home, a folder with one commit, and a run of `name` begun in it with
/// a lead and the members named.
fn started(label: &str, name: &str, members: &[(&str, &str, bool)]) -> (Scratch, Scratch) {
    let home = Scratch::new(&format!("run-home-{label}"));
    let dir = repo(label);
    write(&dir, "src/main.rs", "fn main() {}\n");
    commit(&dir);
    begin(home.path(), "lead", &team(name), &dir).unwrap();
    for (token, agent, reads_only) in members {
        join(
            home.path(),
            "lead",
            token,
            agent,
            &dir,
            None,
            *reads_only,
            "brief",
        )
        .unwrap();
    }
    (home, dir)
}

/// The verdict of `token` on what stands now for the lead's run: the
/// plan's latest version, or the change's tree in the lead's folder.
fn given(
    home: &Path,
    token: &str,
    when: When,
    approved: bool,
    findings: &str,
    version: Option<&str>,
) -> Result<Vec<GateState>, String> {
    let now = state(home, "lead").unwrap().unwrap();
    match when {
        When::Plan => {
            let latest = now.plan.map_or(1, |plan| plan.version);
            verdict(
                home,
                token,
                Read::Plan { version: latest },
                approved,
                findings,
                version,
            )
        }
        When::Change => {
            let tree = now.places[0].tree.clone().unwrap_or_default();
            let read = Read::Change {
                folder: None,
                tree: &tree,
            };
            verdict(home, token, read, approved, findings, version)
        }
    }
}

fn standing(home: &Path, who: &str, when: When) -> GateState {
    state(home, "lead")
        .unwrap()
        .unwrap()
        .gates
        .into_iter()
        .find(|gate| gate.gate.who == who && gate.gate.when == when)
        .unwrap()
}

#[test]
fn a_run_begins_with_its_teams_gates_and_its_folders_commit() {
    let (home, dir) = started("begin", SHIP_WITH_CHECKS, &[]);
    let state = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(state.run.base, git::head(&dir));
    assert!(state.run.base.is_some());
    assert_eq!(state.gates.len(), 4);
    assert!(state.gates.iter().all(|gate| !gate.gate.added));
    assert_eq!(state.gates[0].reason, "no plan is written yet");
    assert_eq!(state.line(), "Gates 0 of 4 · No plan is written yet");
}

#[test]
fn a_lead_begun_again_keeps_its_run() {
    let (home, dir) = started("again", QUICK_FIX, &[("dev", "Developer", false)]);
    plan(home.path(), "lead", "Fix it.", &[]).unwrap();
    let again = begin(home.path(), "lead", &team(SHIP_WITH_CHECKS), &dir).unwrap();
    assert_eq!(again.team.name, QUICK_FIX);
    let state = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(state.plan.unwrap().version, 1);
    assert_eq!(
        Runs::open(home.path())
            .unwrap()
            .members("lead")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reading_a_run_that_is_not_there_makes_nothing() {
    let home = Scratch::new("run-none");
    assert_eq!(state(home.path(), "lead").unwrap(), None);
    assert!(!folder(home.path()).exists());
    assert_eq!(start_held(home.path(), "lead", false).unwrap(), None);
}

#[test]
fn only_a_teams_agents_join_its_run_and_a_member_takes_its_id_later() {
    let (home, dir) = started("join", QUICK_FIX, &[]);
    let refused = join(home.path(), "lead", "t", "Tester", &dir, None, false, "").unwrap_err();
    assert_eq!(refused, "Tester is not one of Quick fix's agents.");
    let member = join(
        home.path(),
        "lead",
        "rev",
        "reviewer",
        &dir,
        None,
        true,
        "Review it",
    )
    .unwrap();
    assert_eq!(member.agent, REVIEWER, "kept as the team names it");
    let again = join(
        home.path(),
        "lead",
        "rev",
        "Reviewer",
        &dir,
        Some("abc-12345678"),
        true,
        "Other",
    )
    .unwrap();
    assert_eq!(again.session.as_deref(), Some("abc-12345678"));
    assert_eq!(again.brief, "Review it");
    assert_eq!(
        member_by_session(home.path(), "lead", "abc-1234")
            .unwrap()
            .map(|m| m.token),
        Some("rev".to_string())
    );
    assert_eq!(
        member_by_session(home.path(), "lead", "abc-123").unwrap(),
        None,
        "too short a prefix names no member"
    );
    join(
        home.path(),
        "lead",
        "dev",
        "Developer",
        &dir,
        Some("abc-12349999"),
        false,
        "",
    )
    .unwrap();
    assert_eq!(
        member_by_session(home.path(), "lead", "abc-1234").unwrap(),
        None,
        "a prefix two members share names neither"
    );
    assert_eq!(
        Runs::open(home.path())
            .unwrap()
            .lead_of("rev")
            .unwrap()
            .as_deref(),
        Some("lead")
    );
}

#[test]
fn only_the_lead_writes_the_plan() {
    let (home, _dir) = started("lead-only", QUICK_FIX, &[("dev", "Developer", false)]);
    assert_eq!(
        plan(home.path(), "dev", "Mine.", &[]).unwrap_err(),
        ONLY_THE_LEAD
    );
    assert_eq!(
        plan(home.path(), "lead", "  ", &[]).unwrap_err(),
        "The plan is empty."
    );
    let first = plan(
        home.path(),
        "lead",
        "Fix it.",
        &["./src/a.rs".into(), "src/a.rs".into()],
    )
    .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(first.paths, vec!["src/a.rs"]);
    let second = plan(home.path(), "lead", "Fix it better.", &[]).unwrap();
    assert_eq!(second.version, 2);
    assert_ne!(first.hash, second.hash);
}

#[test]
fn building_waits_for_the_plans_approval_and_a_new_plan_makes_it_out_of_date() {
    let (home, _dir) = started(
        "plan",
        SHIP_WITH_CHECKS,
        &[
            ("sec", "Security reviewer", true),
            ("dev", "Developer", false),
        ],
    );
    let held = state(home.path(), "lead").unwrap().unwrap().building_held();
    assert_eq!(
        held.as_deref(),
        Some("Building is held: no plan is written yet.")
    );
    assert!(start_held(home.path(), "lead", false).unwrap().is_some());
    assert_eq!(
        start_held(home.path(), "lead", true).unwrap(),
        None,
        "a reader starts"
    );

    let refused = given(home.path(), "sec", When::Plan, true, "", None).unwrap_err();
    assert!(refused.starts_with("No plan is written yet"), "{refused}");

    plan(
        home.path(),
        "lead",
        "Add a login.",
        &["src/login.rs".into()],
    )
    .unwrap();
    let gates = given(home.path(), "sec", When::Plan, true, "", None).unwrap();
    assert_eq!(gates.len(), 1, "only its gate on the plan");
    assert_eq!(gates[0].standing, Standing::Approved);
    assert_eq!(
        standing(home.path(), "Cloud architect", When::Plan).standing,
        Standing::NotNeeded,
        "the plan touches nothing under infra"
    );
    assert_eq!(start_held(home.path(), "lead", false).unwrap(), None);
    assert_eq!(start_held(home.path(), "dev", false).unwrap(), None);

    plan(
        home.path(),
        "lead",
        "Add a login and a logout.",
        &["src/login.rs".into()],
    )
    .unwrap();
    let gate = standing(home.path(), "Security reviewer", When::Plan);
    assert_eq!(gate.standing, Standing::OutOfDate);
    assert_eq!(
        gate.reason,
        "Security reviewer's approval of the plan is out of date"
    );
    assert!(start_held(home.path(), "lead", false).unwrap().is_some());
}

#[test]
fn a_gate_on_some_paths_holds_when_the_plan_or_the_change_touches_them() {
    let (home, dir) = started("touches", SHIP_WITH_CHECKS, &[]);
    let gate = standing(home.path(), "Cloud architect", When::Plan);
    assert_eq!(
        gate.standing,
        Standing::Waiting,
        "no plan says what it touches yet"
    );

    plan(
        home.path(),
        "lead",
        "Add a bucket.",
        &["infra/bucket.tf".into()],
    )
    .unwrap();
    assert_eq!(
        standing(home.path(), "Cloud architect", When::Plan).standing,
        Standing::Waiting
    );

    plan(home.path(), "lead", "Add a page.", &["src/page.rs".into()]).unwrap();
    assert_eq!(
        standing(home.path(), "Cloud architect", When::Plan).standing,
        Standing::NotNeeded
    );
    write(&dir, "infra/main.tf", "resource {}\n");
    assert_eq!(
        standing(home.path(), "Cloud architect", When::Plan).standing,
        Standing::Waiting,
        "the change touches infra though the plan did not say so"
    );
}

#[test]
fn an_approved_change_goes_out_of_date_when_the_tree_changes() {
    let (home, dir) = started("change", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let held = state(home.path(), "lead")
        .unwrap()
        .unwrap()
        .handing_over_held();
    assert_eq!(
        held.as_deref(),
        Some("Handing over is held: Reviewer has not approved the change yet.")
    );
    write(&dir, "src/main.rs", "fn main() { println!(); }\n");
    let gates = given(home.path(), "rev", When::Change, true, "", None).unwrap();
    assert_eq!(gates[0].standing, Standing::Approved);
    let state_now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(state_now.handing_over_held(), None);
    assert_eq!(state_now.line(), "Gates 1 of 1");

    commit(&dir);
    assert_eq!(
        standing(home.path(), REVIEWER, When::Change).standing,
        Standing::Approved,
        "a commit of the same tree keeps the approval"
    );
    write(&dir, "notes.txt", "untracked\n");
    assert_eq!(
        standing(home.path(), REVIEWER, When::Change).standing,
        Standing::OutOfDate,
        "an untracked file is part of the change"
    );
}

#[test]
fn asking_for_changes_says_what_and_waits_for_the_user_after_its_rounds() {
    let (home, dir) = started("rounds", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let empty = given(home.path(), "rev", When::Change, false, " ", None).unwrap_err();
    assert!(empty.contains("findings"), "{empty}");
    for round in 1..=ROUNDS {
        write(&dir, "src/main.rs", &format!("// round {round}\n"));
        let gates = given(home.path(), "rev", When::Change, false, "Fix it.", None).unwrap();
        assert_eq!(gates[0].asks, round);
        assert_eq!(gates[0].at_limit, round == ROUNDS);
    }
    let state_now = state(home.path(), "lead").unwrap().unwrap();
    assert!(state_now.waits_for_the_user());
    assert_eq!(
        state_now.gates[0].reason,
        "Reviewer asked for changes to the change 3 times; the gate waits for the user, who may waive it"
    );
    let refused = given(home.path(), "rev", When::Change, true, "", None).unwrap_err();
    assert!(refused.contains("waits for the user"), "{refused}");

    assert_eq!(
        waive(home.path(), "lead", 1, " ").unwrap_err(),
        "A waiver says why."
    );
    assert!(waive(home.path(), "lead", 9, "No.").is_err());
    waive(home.path(), "lead", 1, "Checked it myself.").unwrap();
    let state_now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(state_now.gates[0].standing, Standing::Waived);
    assert_eq!(state_now.handing_over_held(), None);
    assert!(!state_now.waits_for_the_user());
}

#[test]
fn only_a_member_whose_agent_approves_gives_a_verdict() {
    let (home, _dir) = started(
        "who",
        QUICK_FIX,
        &[("dev", "Developer", false), ("rev", "Reviewer", true)],
    );
    let stranger = given(home.path(), "x", When::Change, true, "", None).unwrap_err();
    assert_eq!(stranger, NOT_A_MEMBER);
    let lead = given(home.path(), "lead", When::Change, true, "", None).unwrap_err();
    assert_eq!(lead, NOT_A_MEMBER, "the lead does not approve its own work");
    let dev = given(home.path(), "dev", When::Change, true, "", None).unwrap_err();
    assert_eq!(
        dev,
        "Developer approves no gate before handing over in this run."
    );
    let plan_gate = given(home.path(), "rev", When::Plan, true, "", None).unwrap_err();
    assert_eq!(
        plan_gate,
        "Reviewer approves no gate before building in this run."
    );
}

#[test]
fn a_verdict_keeps_who_gave_it_on_what() {
    let (home, _dir) = started("record", QUICK_FIX, &[("rev", "Reviewer", true)]);
    given(
        home.path(),
        "rev",
        When::Change,
        false,
        "Name it better.",
        Some("v1"),
    )
    .unwrap();
    let verdicts = Runs::open(home.path()).unwrap().verdicts("lead").unwrap();
    assert_eq!(verdicts.len(), 1);
    let given = &verdicts[0];
    assert_eq!(given.token, "rev");
    assert_eq!(given.agent, REVIEWER);
    assert_eq!(given.agent_version.as_deref(), Some("v1"));
    assert_eq!(given.brief, "brief");
    assert_eq!(given.findings, "Name it better.");
    assert_eq!(given.plan, None);
    let tree = state(home.path(), "lead").unwrap().unwrap().places[0]
        .tree
        .clone()
        .unwrap();
    assert_eq!(given.on, tree);
}

#[test]
fn the_lead_adds_gates_but_never_one_the_run_has() {
    let (home, _dir) = started("add", QUICK_FIX, &[("dev", "Developer", false)]);
    assert_eq!(
        gate_add(home.path(), "dev", REVIEWER, When::Plan, None).unwrap_err(),
        ONLY_THE_LEAD
    );
    let added = gate_add(home.path(), "lead", "reviewer", When::Plan, None).unwrap();
    assert_eq!(
        (added.id, added.who.as_str(), added.added),
        (2, REVIEWER, true)
    );
    assert!(gate_add(home.path(), "lead", REVIEWER, When::Change, None)
        .unwrap_err()
        .contains("twice"));
    assert!(gate_add(home.path(), "lead", "Tester", When::Change, None).is_err());
    assert!(start_held(home.path(), "lead", false).unwrap().is_some());
}

#[test]
fn a_run_in_a_folder_before_its_first_commit_reads_its_change() {
    let home = Scratch::new("run-home-fresh");
    let dir = repo("fresh");
    begin(home.path(), "lead", &team(QUICK_FIX), &dir).unwrap();
    join(home.path(), "lead", "rev", "Reviewer", &dir, None, true, "").unwrap();
    write(&dir, "a.txt", "one\n");
    let state_now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(state_now.run.base, None);
    assert_eq!(state_now.paths, vec!["a.txt"]);
    let gates = given(home.path(), "rev", When::Change, true, "", None).unwrap();
    assert_eq!(gates[0].standing, Standing::Approved);
}

#[test]
fn a_folder_that_is_not_a_repository_holds_the_change() {
    let home = Scratch::new("run-home-plain");
    let dir = Scratch::new("run-plain");
    begin(home.path(), "lead", &team(QUICK_FIX), &dir).unwrap();
    join(home.path(), "lead", "rev", "Reviewer", &dir, None, true, "").unwrap();
    let gate = standing(home.path(), REVIEWER, When::Change);
    assert_eq!(gate.standing, Standing::Waiting);
    assert!(
        gate.reason.starts_with("the change cannot be read"),
        "{}",
        gate.reason
    );
    assert!(given(home.path(), "rev", When::Change, true, "", None).is_err());
}

#[test]
fn a_gate_on_some_paths_is_needed_when_the_change_cannot_be_read() {
    let home = Scratch::new("run-home-unread");
    let dir = Scratch::new("run-unread");
    begin(home.path(), "lead", &team(SHIP_WITH_CHECKS), &dir).unwrap();
    plan(home.path(), "lead", "Add a page.", &["src/page.rs".into()]).unwrap();
    let gate = standing(home.path(), "Cloud architect", When::Plan);
    assert_eq!(
        gate.standing,
        Standing::Waiting,
        "the change may touch infra though the plan does not"
    );
}

#[test]
fn handing_over_is_a_pull_request_opened_or_merged_or_a_push() {
    for command in [
        "gh pr create --fill",
        "cd app && gh pr merge 12 --squash",
        "git push origin HEAD",
        "/usr/bin/git push",
        "git -C ../app push -u origin main",
        "echo ok; git  push",
        "(git push)",
        "bash -c \"git push origin main\"",
        "sh -c 'gh pr create --fill'",
        "gh -R owner/app pr merge 3",
        "gh pr --repo owner/app create",
        "x=$(git push)",
        "git --no-pager -c a=b push",
    ] {
        assert!(hands_over(command), "{command}");
    }
    for command in [
        "git status",
        "gh pr view 12",
        "git commit -m 'push it'",
        "git log --grep push",
        "gh pr checks 3",
        "git -C push status",
    ] {
        assert!(!hands_over(command), "{command}");
    }
}

#[test]
fn an_agents_version_is_its_hash_when_it_is_the_users() {
    let own: Vec<Agent> = serde_json::from_value(serde_json::json!([
        {"title": "Linter", "description": "Lints"},
        {"shipped": "Reviewer", "title": "Reviewer", "description": "Mine"}
    ]))
    .unwrap();
    let linter = agent_version(&own, "linter").unwrap();
    assert_eq!(linter.len(), 40);
    assert!(agent_version(&own, "Reviewer").is_some());
    assert_eq!(agent_version(&own, "Developer"), None);
    assert_ne!(Some(linter), agent_version(&own, "Reviewer"));
}

/// Whether a session's run holds handing over, as it does when the run
/// cannot be read.
fn held(home: &Path, token: &str) -> bool {
    state_of(home, token).map_or(true, |state| {
        state.is_some_and(|state| state.handing_over_held().is_some())
    })
}

/// A worktree of `dir` on a branch of its own, beside it.
fn worktree(dir: &Path, name: &str) -> PathBuf {
    let path = dir.with_file_name(format!(
        "{}-{name}",
        dir.file_name().unwrap().to_string_lossy()
    ));
    let made = Command::new("git")
        .args(["worktree", "add", "-q", "-b", name])
        .arg(&path)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(made.status.success(), "{made:?}");
    path
}

#[test]
fn a_push_from_a_members_worktree_is_judged_on_the_change_there() {
    let (home, dir) = started("worktree", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let tree_dir = worktree(&dir, "work");
    join(
        home.path(),
        "lead",
        "dev",
        "Developer",
        &tree_dir,
        None,
        false,
        "",
    )
    .unwrap();
    write(&tree_dir, "src/main.rs", "fn main() { work() }\n");
    assert!(
        held(home.path(), "dev"),
        "the change in the worktree is not approved"
    );
    let now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(now.places.len(), 2);
    assert_eq!(now.paths, vec!["src/main.rs"]);
    let tree = now.places[1].tree.clone().unwrap();
    assert_ne!(
        Ok(tree.clone()),
        now.places[0].tree,
        "each folder has its own tree"
    );
    let gates = verdict(
        home.path(),
        "rev",
        Read::Change {
            folder: None,
            tree: &tree,
        },
        true,
        "",
        None,
    )
    .unwrap();
    assert_eq!(gates[0].standing, Standing::Approved, "{}", gates[0].reason);
    let given = Runs::open(home.path()).unwrap().verdicts("lead").unwrap();
    assert!(same(given[0].folder.as_deref().unwrap(), &tree_dir));
    assert!(!held(home.path(), "dev"));

    write(&tree_dir, "src/main.rs", "fn main() { more() }\n");
    let gate = standing(home.path(), REVIEWER, When::Change);
    assert_eq!(gate.standing, Standing::OutOfDate, "{}", gate.reason);
    assert!(held(home.path(), "dev"));
    assert!(held(home.path(), "lead"));

    write(&dir, "README.md", "lead's own\n");
    let gate = standing(home.path(), REVIEWER, When::Change);
    assert_eq!(gate.folders.len(), 2, "the change is in both folders now");
    let refused = given_in(home.path(), None).unwrap_err();
    assert!(refused.contains("more than one folder"), "{refused}");
    let stray = Scratch::new("run-stray");
    let refused = given_in(home.path(), Some(stray.path())).unwrap_err();
    assert!(
        refused.contains("is not a folder the run's work is in"),
        "{refused}"
    );
    given_in(home.path(), Some(&tree_dir)).unwrap();
    given_in(home.path(), Some(&dir)).unwrap();
    assert!(!held(home.path(), "dev"));
    let _ = std::fs::remove_dir_all(&tree_dir);
}

#[test]
fn a_commit_in_a_worktree_before_its_member_joined_is_in_the_change() {
    let (home, dir) = started("worktree-early", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let tree_dir = worktree(&dir, "early");
    write(&tree_dir, "src/early.rs", "fn early() {}\n");
    commit(&tree_dir);
    join(
        home.path(),
        "lead",
        "dev",
        "Developer",
        &tree_dir,
        None,
        false,
        "",
    )
    .unwrap();
    let now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(now.paths, vec!["src/early.rs"]);
    assert!(
        held(home.path(), "dev"),
        "the commit made before joining is not approved"
    );
    let _ = std::fs::remove_dir_all(&tree_dir);
}

/// The reviewer's approval of the change in `folder` as it stands now.
fn given_in(home: &Path, folder: Option<&Path>) -> Result<Vec<GateState>, String> {
    let now = state(home, "lead").unwrap().unwrap();
    let place = match folder {
        Some(folder) => now.places.iter().find(|place| same(&place.folder, folder)),
        None => now.places.first(),
    };
    let tree = place
        .and_then(|place| place.tree.clone().ok())
        .unwrap_or_else(|| "0".repeat(40));
    let read = Read::Change {
        folder,
        tree: &tree,
    };
    verdict(home, "rev", read, true, "", None)
}

#[test]
fn a_verdict_on_a_plan_that_was_replaced_is_refused() {
    let (home, _dir) = started(
        "replaced",
        SHIP_WITH_CHECKS,
        &[("sec", "Security reviewer", true)],
    );
    plan(home.path(), "lead", "Add a page.", &[]).unwrap();
    let read = state_of(home.path(), "sec").unwrap().unwrap().plan.unwrap();
    plan(home.path(), "lead", "Add a page and a login.", &[]).unwrap();
    let old = Read::Plan {
        version: read.version,
    };
    let refused = verdict(home.path(), "sec", old, true, "", None).unwrap_err();
    assert_eq!(
        refused,
        "Version 1 of the plan is not the latest: version 2 is. Read it with the gates tool and give the verdict on it."
    );
    let none = Read::Plan { version: 7 };
    let refused = verdict(home.path(), "sec", none, true, "", None).unwrap_err();
    assert_eq!(
        refused,
        "The plan has no version 7; the latest is version 2."
    );
    let gates = verdict(
        home.path(),
        "sec",
        Read::Plan { version: 2 },
        true,
        "",
        None,
    )
    .unwrap();
    assert!(gates.iter().all(|gate| gate.standing == Standing::Approved));
    let given = Runs::open(home.path()).unwrap().verdicts("lead").unwrap();
    assert_eq!(given[0].plan, Some(2));
}

#[test]
fn a_verdict_on_a_tree_that_changed_since_it_was_read_is_refused() {
    let (home, dir) = started("stale", QUICK_FIX, &[("rev", "Reviewer", true)]);
    write(&dir, "src/main.rs", "fn main() { one() }\n");
    let read = state_of(home.path(), "rev").unwrap().unwrap().places[0]
        .tree
        .clone()
        .unwrap();
    write(&dir, "src/main.rs", "fn main() { two() }\n");
    let old = Read::Change {
        folder: None,
        tree: &read,
    };
    let refused = verdict(home.path(), "rev", old, true, "", None).unwrap_err();
    assert!(refused.contains(&format!("not {read}.")), "{refused}");
    assert!(refused.contains("is not the one read"), "{refused}");
    assert!(Runs::open(home.path())
        .unwrap()
        .verdicts("lead")
        .unwrap()
        .is_empty());
}

#[test]
fn a_plans_paths_in_another_order_are_the_same_plan() {
    let (home, _dir) = started("order", QUICK_FIX, &[]);
    let one = plan(
        home.path(),
        "lead",
        "Fix it.",
        &["b.rs".into(), "a.rs".into()],
    )
    .unwrap();
    let two = plan(
        home.path(),
        "lead",
        "Fix it.",
        &["a.rs".into(), "./b.rs".into()],
    )
    .unwrap();
    assert_eq!(one.paths, vec!["a.rs", "b.rs"]);
    assert_eq!(one.hash, two.hash);
}

#[test]
fn opening_the_store_keeps_what_is_in_it() {
    let (home, _dir) = started("keep", QUICK_FIX, &[("dev", "Developer", false)]);
    plan(home.path(), "lead", "Fix it.", &[]).unwrap();
    let file = folder(home.path()).join(FILE);
    let before = std::fs::metadata(&file).unwrap().len();
    make_own(&file).unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().len(), before);
    let runs = Runs::open(home.path()).unwrap();
    assert_eq!(runs.members("lead").unwrap().len(), 1);
    assert!(runs.latest_plan("lead").unwrap().is_some());
}

#[test]
fn a_store_kept_by_a_later_build_is_not_read() {
    let (home, _dir) = started("later", QUICK_FIX, &[]);
    let file = folder(home.path()).join(FILE);
    Connection::open(&file)
        .unwrap()
        .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA + 1))
        .unwrap();
    let refused = Runs::open(home.path()).err().unwrap();
    assert!(refused.contains("kept by a later Chord"), "{refused}");
    assert!(held(home.path(), "lead"));
}
