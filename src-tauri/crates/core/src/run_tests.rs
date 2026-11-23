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
pub(crate) fn started(
    label: &str,
    name: &str,
    members: &[(&str, &str, bool)],
) -> (Scratch, Scratch) {
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
fn a_held_lead_goes_on_and_a_hand_over_is_refused_until_the_gates_pass() {
    let (home, dir) = started("stop", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let going_on = stop_held(home.path(), "lead").unwrap();
    assert!(going_on.starts_with("Handing over is held: "), "{going_on}");
    assert_eq!(
        stop_held(home.path(), "rev"),
        None,
        "a member ends its turn"
    );
    assert_eq!(stop_held(home.path(), "other"), None);

    let refused = command_held(home.path(), "lead", "git push origin main").unwrap();
    assert!(refused.starts_with("Handing over is held: "), "{refused}");
    assert!(command_held(home.path(), "rev", "gh pr create --fill").is_some());
    assert_eq!(command_held(home.path(), "lead", "git status"), None);
    assert_eq!(command_held(home.path(), "other", "git push"), None);

    for round in 1..=ROUNDS {
        write(&dir, "src/main.rs", &format!("// round {round}\n"));
        given(home.path(), "rev", When::Change, false, "Fix it.", None).unwrap();
    }
    assert_eq!(
        stop_held(home.path(), "lead"),
        None,
        "a gate waiting for the user lets the lead stop"
    );
    assert!(command_held(home.path(), "lead", "git push").is_some());

    waive(home.path(), "lead", 1, "Checked it myself.").unwrap();
    assert_eq!(stop_held(home.path(), "lead"), None);
    assert_eq!(command_held(home.path(), "lead", "git push"), None);
}

#[test]
fn a_hand_over_is_refused_when_the_run_cannot_be_read() {
    let (home, _dir) = started("unread", QUICK_FIX, &[]);
    let dir = folder(home.path());
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        std::fs::remove_file(entry.path()).unwrap();
    }
    std::fs::write(dir.join(FILE), "not a database, not at all").unwrap();
    let refused = command_held(home.path(), "lead", "git push").unwrap();
    assert!(
        refused.starts_with("Handing over is held: the team's run"),
        "{refused}"
    );
    assert_eq!(command_held(home.path(), "lead", "git status"), None);
    assert_eq!(
        stop_held(home.path(), "lead"),
        None,
        "a broken store never keeps a lead going"
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
        "git send-pack origin main",
        "git -c alias.ship=push ship",
        "gh api repos/owner/app/pulls -f title=Login -f head=login",
        "gh api -X PUT repos/owner/app/pulls/3/merge",
        "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
        "git subtree push --prefix d origin main",
        "\"$(git --exec-path)/git-push\" origin main",
        "sh -c 'git push'",
        "env FOO=1 git push",
        "FOO=1 git push",
        "sudo -u x git push",
        "bash -lc 'git push'",
        "git push 2>&1",
        "git push origin main > /tmp/out",
        "timeout 60 git push",
        "eval 'git push'",
        "echo \"$(git push)\"",
        "for b in a c; do git push origin $b; done",
        "git log && \\\n  git push",
        "echo $((1<<2))\ngit push",
        "(( x = 1<<2 ))\ngit push",
        "bash <<EOF\ngit push\nEOF",
        "bash <<< 'git push'",
        "git push -n --no-dry-run",
        "git push --dry-run --no-dry",
        "git push --push-option -n origin main",
        "git push --push-opt -n origin main",
        "git push -o -n origin main",
        "git push -on origin main",
        "git send-pack -n origin main",
        "stdbuf -oL git push",
        "ionice -c 3 git push",
        "setsid git push",
        "caffeinate -t 60 git push",
        "flock /tmp/lock git push",
        "flock -w 5 /tmp/lock -c 'git push'",
        "watch -n 5 git push",
        "watch 'git push'",
        "coproc git push",
        "coproc pusher { git push; }",
        "gh pr new --fill",
        "bash <<'EOF'\ngit push\nEOF",
        "cat <<EOF\n$(git push)\nEOF",
        "cat <<EOF\n`git push`\nEOF",
        "a=($(git push))",
        "[ -n \"$X\" ] && git push",
        "git -c alias.p=push -C app p",
        "git --namespace push --dry-run push origin",
        "GIT push",
        "Git push origin main",
        "git PUSH",
        "$(echo git) push",
        "`echo git` push",
        "$g push",
        "$\"git\" push",
        "$(echo git push)",
        "echo 'git push' | sh",
        "echo git push | bash -s",
        "printf 'git push' |& env bash",
        "echo push | xargs git",
        "printf 'git push\\n' \\|| sh",
        "echo git push | sh -",
        "echo git push | bash /dev/stdin",
        "echo git push | source /dev/stdin",
        "bash <(echo git push)",
        ". <(echo git push)",
        "sh < <(echo git push)",
        "sh < push.sh",
        "echo git push | bash --rcfile x",
        "bash --rcfile x -c 'git push'",
        "echo push | xargs -I{} git {} origin",
        "echo push | xargs -I X git X origin",
        "echo push | xargs --replace git {} origin",
        "git $cmd origin main",
        "git subtree $sub --prefix d origin main",
        "gh $sub create --fill",
        "gh pr $what --fill",
        "gh api \"$endpoint\" -X PUT",
        "$g $sub",
        "git -c include.path=/tmp/x ship",
        "git -c includeIf.onbranch:main.path=/tmp/x ship",
        "echo 'create --fill' | xargs gh pr",
        "git --config-env alias.p=SHIP p",
        "git --config-env=alias.p=SHIP p",
        "git -c Alias.p=push p",
        "gh api graphql -F query=@merge.graphql",
        "gh api graphql --input query.json",
        "gh api -X PATCH repos/owner/app/git/refs/heads/main -f sha=abc",
        "gh api -X PUT repos/owner/app/contents/a.txt -f message=x",
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
        "gh api repos/owner/app/pulls",
        "gh api -X POST repos/owner/app/issues -f title=Bug",
        "git commit -m \"fix git push docs\"",
        "grep -rn \"git push\" docs",
        "rg 'gh pr create' src",
        "echo git push",
        "echo 'run git push'; git status",
        "git push --dry-run",
        "git push -n origin main",
        "git push -nv",
        "git push --dry origin main",
        "git push -o ci.skip -n origin main",
        "git push origin main -n",
        "find . -name '*.rs' -exec grep push {} +",
        "command -v git push",
        "git status # then git push",
        "git commit -F - <<'EOF'\nWhy git push failed\nso gh pr create waits\nEOF\ngit status",
        "echo 'git push' > notes.txt",
        "cat notes.txt | sh build.sh",
        "echo hi | bash -c 'cat'",
        "git status || sh",
        "git ls-files | xargs git add",
        "GIT_CONFIG_NOSYSTEM=1 git status",
        "git status || sh build.sh",
        "sh build.sh < input.txt",
        "git commit -m \"$message\"",
        "git checkout $branch",
        "gh api \"$endpoint\"",
        "find . -name '*.rs' | xargs -I{} git add {}",
        "parallel gzip ::: a b",
        "$EDITOR notes.md",
        "gh api graphql -f query='{ viewer { login } }'",
        "gh api repos/owner/app/contents/a.txt",
        "watch -n 5 git status",
        "if [ -z \"$X\" ]; then git status; fi",
        "GIT_DIR=.git git status",
        "HOME=/tmp/h git status",
        "GIT_CONFIG_GLOBAL=/dev/null git log",
        "git grep -c include.h",
        "git log -c include.c",
        "flock /tmp/l echo \"git push\"",
        "a=(git push); echo ok",
        "cat > notes.md <<'EOF'\n`git push`\n(gh pr create)\ngit push origin main\nEOF",
        "git commit -F - <<EOF\nWhy git push failed\nEOF",
        "git commit -F - <<< 'git push origin main'",
    ] {
        assert!(!hands_over(command), "{command}");
    }
}

#[test]
fn a_long_command_of_commands_that_run_others_is_read_quickly() {
    let started = std::time::Instant::now();
    let watches = format!("watch watch watch {}", "x ".repeat(20_000));
    assert!(!hands_over(&watches));
    let wrapped = format!("watch {}ls", "env watch ".repeat(200));
    assert!(hands_over(&wrapped));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
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
        command_held(home.path(), "dev", "git push origin work").is_some(),
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
    let held = command_held(home.path(), "dev", "git push origin work").unwrap();
    assert!(held.contains("is not all committed"), "{held}");
    assert_eq!(
        stop_held(home.path(), "lead"),
        None,
        "the stop sends nothing"
    );
    commit(&tree_dir);
    assert_eq!(
        command_held(home.path(), "dev", "git push origin work"),
        None,
        "the approved tree is the one committed"
    );

    write(&tree_dir, "src/main.rs", "fn main() { more() }\n");
    let gate = standing(home.path(), REVIEWER, When::Change);
    assert_eq!(gate.standing, Standing::OutOfDate, "{}", gate.reason);
    assert!(command_held(home.path(), "dev", "git push origin work").is_some());
    assert!(command_held(home.path(), "lead", "git push origin work").is_some());

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
    commit(&tree_dir);
    commit(&dir);
    assert_eq!(
        command_held(home.path(), "dev", "git push origin work"),
        None
    );
    let _ = std::fs::remove_dir_all(&tree_dir);
}

#[test]
fn a_members_folder_that_is_gone_is_left_out_of_the_change() {
    let (home, dir) = started("worktree-gone", QUICK_FIX, &[("rev", "Reviewer", true)]);
    let tree_dir = worktree(&dir, "gone");
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
    write(&dir, "src/main.rs", "fn main() { lead() }\n");
    commit(&dir);
    given_in(home.path(), Some(&dir)).unwrap();
    assert!(command_held(home.path(), "lead", "git push").is_some());

    std::fs::remove_dir_all(&tree_dir).unwrap();
    let now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(now.places.len(), 1);
    assert_eq!(now.gone, vec![tree_dir]);
    assert_eq!(command_held(home.path(), "lead", "git push"), None);
    assert_eq!(stop_held(home.path(), "lead"), None);
}

#[test]
fn paths_in_a_run_in_a_subfolder_are_measured_from_it() {
    let home = Scratch::new("run-home-subfolder");
    let dir = repo("subfolder");
    write(&dir, "apps/web/src/main.rs", "fn main() {}\n");
    commit(&dir);
    let web = dir.join("apps/web");
    begin(home.path(), "lead", &team(SHIP_WITH_CHECKS), &web).unwrap();
    plan(home.path(), "lead", "Add a page.", &["src/page.rs".into()]).unwrap();
    let architect = || standing(home.path(), "Cloud architect", When::Plan).standing;
    assert_eq!(architect(), Standing::NotNeeded);

    write(&dir, "infra/main.tf", "resource {}\n");
    assert_eq!(architect(), Standing::NotNeeded, "outside the run's folder");
    let now = state(home.path(), "lead").unwrap().unwrap();
    assert!(
        now.paths.contains(&"../../infra/main.tf".to_string()),
        "{:?}",
        now.paths
    );

    write(&web, "infra/main.tf", "resource {}\n");
    assert_eq!(architect(), Standing::Waiting);
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
        command_held(home.path(), "dev", "git push origin early").is_some(),
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
fn a_reviewer_reading_in_its_own_folder_approves_the_change_with_its_tree() {
    let (home, dir) = started("own-folder", QUICK_FIX, &[]);
    write(&dir, "src/main.rs", "fn main() { fixed() }\n");
    commit(&dir);
    let own = worktree(&dir, "review");
    join(home.path(), "lead", "rev", "Reviewer", &own, None, true, "").unwrap();
    let now = state(home.path(), "lead").unwrap().unwrap();
    assert_eq!(now.places.len(), 1, "a folder that only reads is no place");
    let tree = git::tree_hash(&own).unwrap();
    assert_eq!(Ok(&tree), now.places[0].tree.as_ref());
    let read = Read::Change {
        folder: Some(&own),
        tree: &tree,
    };
    let gates = verdict(home.path(), "rev", read, true, "", None).unwrap();
    assert_eq!(gates[0].standing, Standing::Approved, "{}", gates[0].reason);
    let given = Runs::open(home.path()).unwrap().verdicts("lead").unwrap();
    assert!(
        same(given[0].folder.as_deref().unwrap(), &dir),
        "the verdict is on the lead's folder, where the change is"
    );

    write(&dir, "src/main.rs", "fn main() { fixed_more() }\n");
    let gate = standing(home.path(), REVIEWER, When::Change);
    assert_eq!(gate.standing, Standing::OutOfDate, "{}", gate.reason);
    let read = Read::Change {
        folder: Some(&own),
        tree: &tree,
    };
    let refused = verdict(home.path(), "rev", read, true, "", None).unwrap_err();
    assert!(
        refused.contains("which is the change in none of the run's folders"),
        "{refused}"
    );
    let _ = std::fs::remove_dir_all(&own);
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
    assert!(command_held(home.path(), "lead", "git push").is_some());
}

#[test]
fn a_session_started_for_one_in_a_run_joins_its_leads_run() {
    let (home, dir) = started("join-from", SHIP_WITH_CHECKS, &[]);
    let joining = |by: &str, agent: &str| Joining {
        by: by.into(),
        agent: agent.into(),
        brief: "build it".into(),
    };
    let developer = join_from(
        home.path(),
        &joining("lead", "developer"),
        "dev",
        &dir,
        None,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        (developer.lead.as_str(), developer.agent.as_str()),
        ("lead", "Developer")
    );
    assert_eq!(developer.brief, "build it");
    // A member's own start is in the lead's run too.
    let reviewer = join_from(
        home.path(),
        &joining("dev", REVIEWER),
        "rev",
        &dir,
        Some("abc"),
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(reviewer.lead, "lead");
    assert_eq!(reviewer.session.as_deref(), Some("abc"));
    assert!(reviewer.reads_only);
    // The id the harness gives later is taken; the rest stands.
    let again = join_from(
        home.path(),
        &joining("lead", REVIEWER),
        "dev",
        &dir,
        Some("xyz"),
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(again.session.as_deref(), Some("xyz"));
    assert_eq!(
        (again.agent.as_str(), again.reads_only),
        ("Developer", false)
    );
    // An agent the team does not have is refused.
    let refused = join_from(
        home.path(),
        &joining("lead", "Designer"),
        "t",
        &dir,
        None,
        false,
    );
    assert!(refused.unwrap_err().contains("not one of"));
    // A session in no run starts nothing in one.
    let outside = join_from(
        home.path(),
        &joining("other", "Developer"),
        "o",
        &dir,
        None,
        false,
    );
    assert_eq!(outside.unwrap(), None);
}

#[test]
fn a_start_outside_any_run_makes_no_store() {
    let home = Scratch::new("run-home-join-none");
    let joining = Joining {
        by: "lead".into(),
        agent: "Developer".into(),
        brief: String::new(),
    };
    let none = join_from(home.path(), &joining, "dev", home.path(), None, false).unwrap();
    assert_eq!(none, None);
    assert!(!folder(home.path()).join(FILE).exists());
}

#[test]
fn an_ended_run_holds_nothing_and_its_lead_started_again_with_the_team_reopens_it() {
    let (home, dir) = started("end", QUICK_FIX, &[("dev", "Developer", false)]);
    plan(home.path(), "lead", "Fix it.", &[]).unwrap();
    assert!(command_held(home.path(), "lead", "git push").is_some());
    // A member's end ends nothing.
    assert!(!end(home.path(), "dev").unwrap());
    assert!(end(home.path(), "lead").unwrap());
    assert!(!end(home.path(), "lead").unwrap());
    assert_eq!(state(home.path(), "lead").unwrap(), None);
    assert_eq!(
        Runs::open(home.path()).unwrap().lead_of("dev").unwrap(),
        None
    );
    assert!(command_held(home.path(), "lead", "git push").is_none());
    begin(home.path(), "lead", &team(QUICK_FIX), &dir).unwrap();
    let runs = Runs::open(home.path()).unwrap();
    assert_eq!(runs.members("lead").unwrap().len(), 1);
    assert!(runs.latest_plan("lead").unwrap().is_some());
    assert!(command_held(home.path(), "lead", "git push").is_some());
}

#[test]
fn a_run_ended_long_ago_is_deleted_and_a_recent_one_kept() {
    let (home, dir) = started("prune", QUICK_FIX, &[("dev", "Developer", false)]);
    begin(home.path(), "recent", &team(QUICK_FIX), &dir).unwrap();
    assert!(end(home.path(), "lead").unwrap());
    assert!(end(home.path(), "recent").unwrap());
    let long_ago = now() - KEPT_ENDED.as_secs() as i64 - 1;
    let runs = Runs::open(home.path()).unwrap();
    runs.conn
        .execute(
            "UPDATE ended SET at = ?1 WHERE lead = 'lead'",
            params![long_ago],
        )
        .unwrap();
    // Any begin or end prunes.
    assert!(!end(home.path(), "nobody").unwrap());
    let count = |sql: &str| -> i64 { runs.conn.query_row(sql, [], |row| row.get(0)).unwrap() };
    assert_eq!(count("SELECT COUNT(*) FROM runs WHERE lead = 'lead'"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM members WHERE lead = 'lead'"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM gates WHERE lead = 'lead'"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM ended WHERE lead = 'lead'"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM runs WHERE lead = 'recent'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM ended WHERE lead = 'recent'"), 1);
}

#[test]
fn ending_with_no_store_makes_none() {
    let home = Scratch::new("run-home-end-none");
    assert!(!end(home.path(), "lead").unwrap());
    assert!(!folder(home.path()).join(FILE).exists());
}

#[test]
fn the_window_reads_a_run_in_camel_case_with_its_lines_from_any_of_its_sessions() {
    let (home, _dir) = started("view", SHIP_WITH_CHECKS, &[("rev", REVIEWER, true)]);
    assert_eq!(
        lead_of(home.path(), "rev").unwrap().as_deref(),
        Some("lead")
    );
    assert_eq!(
        lead_of(home.path(), "lead").unwrap().as_deref(),
        Some("lead")
    );
    assert_eq!(lead_of(home.path(), "stranger").unwrap(), None);

    let state = state_of(home.path(), "rev").unwrap().unwrap();
    let line = state.line();
    let value = serde_json::to_value(View::from(state)).unwrap();
    assert_eq!(value["line"], line);
    assert_eq!(value["run"]["lead"], "lead");
    assert!(value["handingOverHeld"].is_string(), "{value}");
    assert_eq!(value["waitsForTheUser"], false);
    let gate = &value["gates"][0];
    assert_eq!(gate["standing"], "waiting");
    assert_eq!(gate["atLimit"], false);
    assert!(gate["gate"]["who"].is_string(), "{gate}");
    let place = &value["places"][0];
    assert!(place["tree"]["ok"].is_string(), "{place}");
    assert!(place["changed"]["ok"].is_array(), "{place}");
}

#[test]
fn a_place_that_cannot_be_read_says_why_in_its_own_field() {
    let place = Place {
        folder: PathBuf::from("/gone"),
        base: None,
        head: None,
        tree: Err("no such folder".into()),
        changed: Err("no such folder".into()),
    };
    let value = serde_json::to_value(&place).unwrap();
    assert_eq!(
        value["tree"],
        serde_json::json!({ "error": "no such folder" })
    );
    assert_eq!(value["changed"]["error"], "no such folder");
}

#[test]
fn a_lead_reads_no_run_once_it_ended() {
    let (home, _dir) = started("view-ended", SHIP_WITH_CHECKS, &[("rev", REVIEWER, true)]);
    assert!(end(home.path(), "lead").unwrap());
    assert_eq!(lead_of(home.path(), "rev").unwrap(), None);
    assert_eq!(lead_of(Path::new("/nowhere-at-all"), "lead").unwrap(), None);
}
