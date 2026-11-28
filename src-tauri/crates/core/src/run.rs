//! A team's run: the lead the user started with a team, the members it
//! started, the plan it wrote, the verdicts its gates were given, and the
//! user's waivers.
//!
//! A run begins when its lead starts, with the team as it was then and the
//! commit its folder was at. Its gates are the team's and any the lead
//! adds; none is ever removed. A plan is kept in versions, each with a
//! hash of its text and its paths sorted. The run's work is in places:
//! the lead's folder and each folder a member that changes files joined
//! in; a member's folder that is gone is left out. A place's checkout is
//! read as it stands, untracked files included, as its tree. Its change
//! counts from its base: the commit the run began at, or for a folder
//! other than the lead's, the newest commit it shares with the run's, or
//! where a rebase on the followed remote's default branch moved it, the
//! newest commit the branch shares with that branch as last fetched,
//! unless that leaves nothing changed; see [`git::moved_base`]. The change
//! is the paths changed since the base and a hash of the lines taken out
//! and put in there, with no lines around them, each run placed in the
//! file as the base has it; see [`git::change_hash`]. Paths, in the change
//! and in a gate, are measured from the run's folder. A verdict names the
//! plan version or the place and change its member read, is refused when
//! that is no longer what stands, and records the hash it was given on
//! and, for a change, the base it counted from. A plan or a change that
//! differs since makes an approval out of date. A rebase that puts the
//! same lines on a newer base keeps it: the change is hashed again with
//! its lines placed in the files of the verdict's base, so what the base
//! brought in before the verdict counts as its reader saw it. A verdict
//! recorded on a tree approves while the place has that tree. A
//! member that only reads makes no place of its folder; reading there, it
//! approves the change in the place whose tree, or failing that whose
//! change, that folder has. A gate on the change is judged in each place
//! something changed in, and a push is judged against them all, since
//! worktrees share their branches.
//!
//! A gate is Waiting, Approved, Kept, Out of date, Waived or Not needed.
//! While a gate on the plan is open, building is held: starting a session
//! that changes files. While any gate is open, handing over is held: the
//! lead's done, a pull request, a merge and a push. A push and a pull
//! request send commits alone, so they are held too while a place where a
//! gate on the change stands approved or kept holds work that is not
//! committed. A gate that asked for changes as many times as its rounds
//! waits for the user, whose waiver, with a reason, is the only way past
//! it, and lasts for this run.
//!
//! An approval may name follow-ups: small fixes the reviewer needs no
//! second look at. The lead may keep a gate on the change whose last
//! verdict in a place was an approval and is out of date there, with a
//! reason: the gate is Kept, and passes, while that place's change is the
//! one it was kept for, and a later change puts it out of date again. A
//! gate on the plan, one that waits for the user and one never approved
//! are never kept. Keeps are a table of their own, so a build that knows
//! nothing of them reads a kept gate as out of date.
//!
//! The record is kept in a small database in the core's home, written by
//! the tool server and read by the window and the harnesses' holds.
//! Nothing of it is in the project.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::agents::Agent;
use crate::git;
use crate::notes::now;
use crate::team::{self, Gate, Team, When, MOST_GATES, ROUNDS};

/// The database's file, in the runs' folder.
pub const FILE: &str = "runs.db";

/// How long a plan, a path, a list of paths, findings and follow-ups, a
/// brief and the reason for a waiver or a keep may be, in characters or
/// entries.
pub const PLAN_MOST: usize = 20_000;
pub const PATH_MOST: usize = 400;
pub const PATHS_MOST: usize = 500;
pub const FINDINGS_MOST: usize = 8_000;
pub const BRIEF_MOST: usize = 8_000;
pub const REASON_MOST: usize = 500;

/// The tables that keep a run, by its lead, the run's own last.
const RUN_TABLES: [&str; 8] = [
    "members",
    "earlier_sessions",
    "gates",
    "plans",
    "verdicts",
    "waivers",
    "keeps",
    "runs",
];

/// How long a write waits for another session's write to finish.
const BUSY: Duration = Duration::from_secs(5);

/// The runs' folder in the workbench's directory in the user's home. It
/// and everything in it are the user's alone.
pub fn folder(home: &Path) -> PathBuf {
    crate::home::dir(home).join("runs")
}

fn make_folder(path: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| format!("the run could not be kept in {}: {e}", path.display()))
}

/// Makes the file the user's alone, unless it is there: another session
/// may have made it, and its tables, a moment before.
fn make_own(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

/// How long an ended run is kept before it is deleted.
pub const KEPT_ENDED: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The version of the store's tables this build keeps.
const SCHEMA: i64 = 1;

/// Whether two paths name the same folder, as written or once resolved.
pub(crate) fn same(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn failed(error: rusqlite::Error) -> String {
    format!("the run could not be read or written: {error}")
}

fn too_long(what: &str, text: &str, most: usize) -> Result<(), String> {
    let length = text.chars().count();
    if length > most {
        return Err(format!(
            "The {what} is {length} characters; keep it to {most} at most."
        ));
    }
    Ok(())
}

/// A hash of some bytes, the one git gives them as a file.
fn hash(bytes: &[u8]) -> Result<String, String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .map(|oid| oid.to_string())
        .map_err(|e| format!("the hash could not be made: {e}"))
}

/// The version of one of the user's own agents, or of a shipped one the
/// user changed, by the title the start tool takes: a hash of it as it is
/// kept. None for a shipped agent as it ships and an agent installed for
/// a harness.
pub fn agent_version(own: &[Agent], title: &str) -> Option<String> {
    let title = title.trim();
    let agent = own
        .iter()
        .find(|agent| agent.shipped.is_none() && agent.title.trim().eq_ignore_ascii_case(title))
        .or_else(|| {
            own.iter().find(|agent| {
                agent.shipped.as_deref().is_some_and(|shipped| {
                    shipped.eq_ignore_ascii_case(title)
                        || agent.title.trim().eq_ignore_ascii_case(title)
                })
            })
        })?;
    hash(&serde_json::to_vec(agent).ok()?).ok()
}

/// A run as it began.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub lead: String,
    pub team: Team,
    pub folder: PathBuf,
    /// The commit the folder was at when the run began; none before its
    /// first commit.
    pub base: Option<String>,
    pub at: i64,
}

/// A session the lead started in the run.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub token: String,
    pub lead: String,
    pub agent: String,
    /// The harness's id for the session, once known.
    pub session: Option<String>,
    pub reads_only: bool,
    pub brief: String,
    /// The folder it works in, as it was when it joined.
    pub folder: PathBuf,
    /// The commit the change in its folder counts from: the run's for the
    /// lead's folder, and for another the newest commit both the run's and
    /// the one that folder was at when it joined come from, so commits made
    /// there before it joined count in its change. None, counting every
    /// path of the folder, when the two share no history.
    pub base: Option<String>,
}

/// A gate of the run: one of the team's, or one the lead added.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunGate {
    /// Its place in the run, from 1.
    pub id: i64,
    pub who: String,
    pub when: When,
    pub touches: Option<Vec<String>>,
    pub rounds: u32,
    pub added: bool,
}

/// One version of the plan.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: i64,
    pub text: String,
    pub paths: Vec<String>,
    pub hash: String,
    pub at: i64,
}

/// A verdict given on a gate.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub id: i64,
    pub gate: i64,
    /// The token of the session that gave it.
    pub token: String,
    pub agent: String,
    /// The version of the agent it ran as, where it is one of the user's.
    pub agent_version: Option<String>,
    /// The hash of the plan or the change it was given on, or for a
    /// verdict recorded before changes were hashed, the tree.
    pub on: String,
    /// The version of the plan it was given on, for a gate on the plan.
    pub plan: Option<i64>,
    /// The place whose change it was given on, for a gate on the change.
    pub folder: Option<PathBuf>,
    /// The commit that change counted from, in whose files its lines are
    /// placed. None for a gate on the plan, and for a verdict recorded
    /// without one, whose lines are placed in the files the work began
    /// with.
    pub base: Option<String>,
    pub brief: String,
    pub approved: bool,
    pub findings: String,
    /// What an approval leaves to fix that needs no second look; empty for
    /// none and for asking for changes.
    pub follow_ups: String,
    pub at: i64,
}

/// The user's waiver of a gate, for this run.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Waiver {
    pub gate: i64,
    pub reason: String,
    pub at: i64,
}

/// The lead's keep of an approval that went out of date in one place,
/// for the change there as it was kept.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Keep {
    pub id: i64,
    pub gate: i64,
    /// The approving verdict kept: the last the gate was given there.
    pub verdict: i64,
    /// The token of the session that kept it, the run's lead.
    pub token: String,
    pub folder: PathBuf,
    /// The hash of the change it was kept for, its lines placed in the
    /// files of `base`.
    pub on: String,
    pub base: Option<String>,
    pub reason: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Standing {
    Waiting,
    Approved,
    /// Approved on an earlier change, kept by the lead for this one.
    Kept,
    OutOfDate,
    Waived,
    NotNeeded,
}

impl Standing {
    pub fn words(self) -> &'static str {
        match self {
            Standing::Waiting => "Waiting",
            Standing::Approved => "Approved",
            Standing::Kept => "Approved, kept by the lead",
            Standing::OutOfDate => "Out of date",
            Standing::Waived => "Waived",
            Standing::NotNeeded => "Not needed",
        }
    }

    /// Whether the gate still holds what it holds.
    pub fn open(self) -> bool {
        matches!(self, Standing::Waiting | Standing::OutOfDate)
    }

    /// Whether the work stands passed on an approval, given on it or kept
    /// for it.
    fn approved(self) -> bool {
        matches!(self, Standing::Approved | Standing::Kept)
    }
}

/// A gate as it stands now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GateState {
    pub gate: RunGate,
    pub standing: Standing,
    /// How many times it asked for changes.
    pub asks: u32,
    /// Whether it asked for changes as many times as its rounds, so it
    /// waits for the user and takes no more verdicts.
    pub at_limit: bool,
    /// The line that says why it stands as it does.
    pub reason: String,
    pub verdict: Option<Verdict>,
    pub waiver: Option<Waiver>,
    /// The lead's keep in the first place it stands kept in.
    pub kept: Option<Keep>,
    /// How a gate on the change stands in each place it is judged in.
    pub folders: Vec<FolderStanding>,
}

/// How a gate on the change stands in one place.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderStanding {
    pub folder: PathBuf,
    pub standing: Standing,
    pub reason: String,
}

/// A folder the run's work is in, as it stands now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub folder: PathBuf,
    /// The commit the change there counts from.
    pub base: Option<String>,
    /// The commit the change there began at, which a rebase on a remote's
    /// default branch moves the base on from.
    pub start: Option<String>,
    /// The tree of the commit the folder's branch is on.
    pub head: Option<String>,
    /// The folder's tree, or why it could not be read.
    #[serde(serialize_with = "outcome")]
    pub tree: Result<String, String>,
    /// The hash of the change from the base to the tree, its lines placed
    /// in the base's files, or why it could not be read.
    #[serde(serialize_with = "outcome")]
    pub change: Result<String, String>,
    /// The paths changed there since the base, or why they could not be
    /// read.
    #[serde(serialize_with = "outcome")]
    pub changed: Result<Vec<String>, String>,
}

/// A reading that may have failed, as `{"ok": ...}` or `{"error": why}`.
fn outcome<T: Serialize, S: serde::Serializer>(
    read: &Result<T, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    enum Outcome<'a, T> {
        Ok(&'a T),
        Error(&'a str),
    }
    match read {
        Ok(value) => Outcome::Ok(value).serialize(serializer),
        Err(why) => Outcome::<T>::Error(why).serialize(serializer),
    }
}

impl Place {
    /// The place a folder is, its change counted from where `start` moved
    /// to, with the paths changed there measured from `from`, where the
    /// run's folder is in the repository. A base that moved onto all of
    /// the work, leaving nothing changed, is no base: the change counts
    /// from `start`, so a remote's branch moved onto the work never empties
    /// it.
    fn read(folder: &Path, from: &str, start: Option<&str>) -> Place {
        Place::of_tree(folder, from, start, git::tree_hash(folder))
    }

    /// The place a folder with the tree `tree` is.
    fn of_tree(
        folder: &Path,
        from: &str,
        start: Option<&str>,
        tree: Result<String, String>,
    ) -> Place {
        let base = git::moved_base(folder, start);
        let moved = Place::from_base(folder, from, start, base, tree.clone());
        if moved.base.as_deref() == start
            || !moved.changed.as_ref().is_ok_and(|paths| paths.is_empty())
        {
            return moved;
        }
        Place::from_base(folder, from, start, start.map(str::to_string), tree)
    }

    fn from_base(
        folder: &Path,
        from: &str,
        start: Option<&str>,
        base: Option<String>,
        tree: Result<String, String>,
    ) -> Place {
        let change = tree
            .clone()
            .and_then(|tree| git::change_hash(folder, base.as_deref(), base.as_deref(), &tree))
            .map_err(|e| format!("the change in {} cannot be read: {e}", folder.display()));
        let changed = tree
            .clone()
            .and_then(|tree| git::changed_paths(folder, from, base.as_deref(), &tree))
            .map_err(|e| {
                format!(
                    "what the change in {} touches cannot be read: {e}",
                    folder.display()
                )
            });
        Place {
            folder: folder.to_path_buf(),
            base,
            start: start.map(str::to_string),
            head: git::head_tree(folder),
            tree,
            change,
            changed,
        }
    }

    /// The hash of the change there with its lines placed in the files of
    /// the commit `anchor`, which is its own hash when that is its base.
    fn change_from(&self, anchor: Option<&str>) -> Result<String, String> {
        if anchor == self.base.as_deref() {
            return self.change.clone();
        }
        self.tree.clone().and_then(|tree| {
            git::change_hash(&self.folder, anchor, self.base.as_deref(), &tree).map_err(|e| {
                format!(
                    "the change in {} cannot be read: {e}",
                    self.folder.display()
                )
            })
        })
    }

    /// Whether an approval stands for the place. It names the place's
    /// tree, or its change with the lines placed in the files of the base
    /// the verdict was given on, so lines the base brought in before the
    /// verdict count as the reader saw them, and only lines it brought in
    /// since are passed over. A verdict that records no base has its lines
    /// placed in the files the work began with.
    fn approves(&self, verdict: &Verdict) -> bool {
        self.holds(&verdict.on, verdict.base.as_deref())
    }

    /// Whether the place is still what the hash `on` names: its tree, or
    /// its change with the lines placed in the files of `base`, or of the
    /// commit the work began at when there is none.
    fn holds(&self, on: &str, base: Option<&str>) -> bool {
        if self.tree.as_deref() == Ok(on) {
            return true;
        }
        let anchor = base.or(self.start.as_deref());
        self.change_from(anchor).as_deref() == Ok(on)
    }

    /// Whether anything changed there since its base, or that cannot be
    /// told.
    fn changed_any(&self) -> bool {
        self.changed
            .as_ref()
            .map_or(true, |paths| !paths.is_empty())
    }
}

/// A run as it stands now.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub run: Run,
    pub plan: Option<Plan>,
    /// The folders the run's work is in, the lead's first.
    pub places: Vec<Place>,
    /// The folders of members that are gone, left out of the places.
    pub gone: Vec<PathBuf>,
    /// The paths the plan names and those changed in every place.
    pub paths: Vec<String>,
    pub gates: Vec<GateState>,
}

impl State {
    /// The places a gate on the change is judged in: those something
    /// changed in, or the lead's folder while nothing changed anywhere.
    fn judged(&self) -> Vec<&Place> {
        judged_places(&self.places)
    }

    /// The place a verdict on the change names, or the one place it is
    /// judged in when it names none.
    fn place_for(&self, folder: Option<&Path>) -> Result<&Place, String> {
        let list = |places: &[&Place]| {
            places
                .iter()
                .map(|place| place.folder.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        match folder {
            Some(folder) => self
                .places
                .iter()
                .find(|place| same(&place.folder, folder))
                .ok_or_else(|| {
                    format!(
                        "{} is not a folder the run's work is in; those are {}.",
                        folder.display(),
                        list(&self.places.iter().collect::<Vec<_>>())
                    )
                }),
            None => match self.judged().as_slice() {
                [one] => Ok(one),
                several => Err(format!(
                    "The run's change is in more than one folder, so a verdict names the folder it read: {}.",
                    list(several)
                )),
            },
        }
    }

    /// The place whose change a member that reads in a folder of its own,
    /// which is no place of the run's work, reads there: the one place
    /// whose tree is the tree that folder has now, or failing that, the one
    /// whose change, with its lines placed in the files of that folder's
    /// base, is the change that folder has. With the place comes the
    /// commit a verdict given there is anchored at: the place's base when
    /// the trees are the same, and that folder's base when the lines are,
    /// since those are the files the member read the lines in. None has
    /// it, or more than one does, and the member reads the change where it
    /// is and names that folder.
    pub fn read_in(&self, own: &Path) -> Result<(&Place, Option<String>), String> {
        let tree =
            git::tree_hash(own).map_err(|e| format!("{} cannot be read: {e}", own.display()))?;
        let mut with: Vec<(&Place, Option<String>)> = self
            .places
            .iter()
            .filter(|place| place.tree.as_ref() == Ok(&tree))
            .map(|place| (place, place.base.clone()))
            .collect();
        if with.is_empty() {
            with = self
                .places
                .iter()
                .filter_map(|place| {
                    let mine = Place::of_tree(own, "", place.start.as_deref(), Ok(tree.clone()));
                    (mine.change.is_ok() && place.change_from(mine.base.as_deref()) == mine.change)
                        .then_some((place, mine.base))
                })
                .collect();
        }
        match with.as_slice() {
            [(one, anchor)] => Ok((one, anchor.clone())),
            [] => Err(format!(
                "{} has tree {tree}, which is the change in none of the run's folders, by its tree or its lines: {}. Check the change out there, or read it in the folder it is in and name that folder.",
                own.display(),
                self.places
                    .iter()
                    .map(|place| match &place.change {
                        Ok(change) => format!("{} has change {change}", place.folder.display()),
                        Err(_) => format!("{} cannot be read", place.folder.display()),
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            several => Err(format!(
                "{} has the change in more than one folder, so a verdict names the one it is on: {}.",
                own.display(),
                several
                    .iter()
                    .map(|(place, _)| place.folder.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }

    fn first_open(&self, when: Option<When>) -> Option<&GateState> {
        self.gates
            .iter()
            .filter(|gate| when.is_none_or(|when| gate.gate.when == when))
            .find(|gate| gate.standing.open())
    }

    /// Why building is held, while a gate on the plan is open.
    pub fn building_held(&self) -> Option<String> {
        self.first_open(Some(When::Plan))
            .map(|gate| format!("Building is held: {}.", gate.reason))
    }

    /// Why handing over is held, while any gate is open.
    pub fn handing_over_held(&self) -> Option<String> {
        self.first_open(None)
            .map(|gate| format!("Handing over is held: {}.", gate.reason))
    }

    /// Why a push or a pull request is held beyond handing over: a place
    /// where a gate on the change stands approved or kept holds work that
    /// is not committed, and only commits go out.
    pub fn uncommitted_held(&self) -> Option<String> {
        let approved = |place: &Place| {
            self.gates
                .iter()
                .flat_map(|gate| &gate.folders)
                .any(|folder| folder.standing.approved() && same(&folder.folder, &place.folder))
        };
        let place = self.places.iter().find(|place| {
            place
                .tree
                .as_ref()
                .is_ok_and(|tree| place.head.as_ref() != Some(tree))
                && approved(place)
        })?;
        Some(format!(
            "Sending is held: the approved change in {} is not all committed, and only commits go out. Commit it, or remove what should not go out.",
            place.folder.display()
        ))
    }

    /// Whether every open gate waits for the user, so nothing the lead
    /// does moves the run on.
    pub fn waits_for_the_user(&self) -> bool {
        let mut open = self.gates.iter().filter(|gate| gate.standing.open());
        let mut any = false;
        let all = open.all(|gate| {
            any = true;
            gate.at_limit
        });
        any && all
    }

    /// The one line the window shows above the composer: how many gates
    /// passed of how many, and while one holds, why, or while none does
    /// and the lead kept one, that it did.
    pub fn line(&self) -> String {
        let passed = self.gates.iter().filter(|g| !g.standing.open()).count();
        let count = format!("Gates {passed} of {}", self.gates.len());
        let kept = || {
            self.gates
                .iter()
                .find(|gate| gate.standing == Standing::Kept)
        };
        match self.first_open(None).or_else(kept) {
            Some(gate) => format!("{count} · {}", capitalised(&gate.reason)),
            None => count,
        }
    }
}

pub(crate) fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The store, opened for one call.
pub struct Runs {
    conn: Connection,
}

impl Runs {
    /// Opens the store in the core's home, made the first time.
    pub fn open(home: &Path) -> Result<Self, String> {
        let dir = folder(home);
        make_folder(&dir)?;
        let file = dir.join(FILE);
        // Made the user's alone before SQLite opens it: its journal files
        // take the database's permissions.
        make_own(&file)
            .map_err(|e| format!("the run could not be kept in {}: {e}", dir.display()))?;
        let conn = Connection::open(file).map_err(failed)?;
        conn.busy_timeout(BUSY).map_err(failed)?;
        let _ = conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()));
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(failed)?;
        if version > SCHEMA {
            return Err(format!(
                "the runs in {} were kept by a later Chord, and this one cannot read them",
                dir.display()
            ));
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS runs (
                lead TEXT PRIMARY KEY,
                team TEXT NOT NULL,
                folder TEXT NOT NULL,
                base TEXT,
                at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS members (
                token TEXT PRIMARY KEY,
                lead TEXT NOT NULL,
                agent TEXT NOT NULL,
                session TEXT,
                reads_only INTEGER NOT NULL,
                brief TEXT NOT NULL,
                folder TEXT NOT NULL,
                base TEXT
            );
            CREATE INDEX IF NOT EXISTS members_by_lead ON members (lead);
            CREATE TABLE IF NOT EXISTS earlier_sessions (
                lead TEXT NOT NULL,
                token TEXT NOT NULL,
                session TEXT NOT NULL,
                PRIMARY KEY (token, session)
            );
            CREATE INDEX IF NOT EXISTS earlier_sessions_by_lead ON earlier_sessions (lead);
            CREATE TABLE IF NOT EXISTS gates (
                lead TEXT NOT NULL,
                id INTEGER NOT NULL,
                who TEXT NOT NULL,
                time TEXT NOT NULL,
                touches TEXT,
                rounds INTEGER NOT NULL,
                added INTEGER NOT NULL,
                PRIMARY KEY (lead, id)
            );
            CREATE TABLE IF NOT EXISTS plans (
                lead TEXT NOT NULL,
                version INTEGER NOT NULL,
                text TEXT NOT NULL,
                paths TEXT NOT NULL,
                hash TEXT NOT NULL,
                at INTEGER NOT NULL,
                PRIMARY KEY (lead, version)
            );
            CREATE TABLE IF NOT EXISTS verdicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lead TEXT NOT NULL,
                gate INTEGER NOT NULL,
                token TEXT NOT NULL,
                agent TEXT NOT NULL,
                agent_version TEXT,
                seen TEXT NOT NULL,
                plan INTEGER,
                brief TEXT NOT NULL,
                approved INTEGER NOT NULL,
                findings TEXT NOT NULL,
                at INTEGER NOT NULL,
                folder TEXT,
                base TEXT
            );
            CREATE INDEX IF NOT EXISTS verdicts_by_gate ON verdicts (lead, gate, id);
            CREATE TABLE IF NOT EXISTS waivers (
                lead TEXT NOT NULL,
                gate INTEGER NOT NULL,
                reason TEXT NOT NULL,
                at INTEGER NOT NULL,
                PRIMARY KEY (lead, gate)
            );
            CREATE TABLE IF NOT EXISTS keeps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lead TEXT NOT NULL,
                gate INTEGER NOT NULL,
                verdict INTEGER NOT NULL,
                token TEXT NOT NULL,
                folder TEXT NOT NULL,
                seen TEXT NOT NULL,
                base TEXT,
                reason TEXT NOT NULL,
                at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS keeps_by_gate ON keeps (lead, gate, id);
            CREATE TABLE IF NOT EXISTS ended (
                lead TEXT PRIMARY KEY,
                at INTEGER NOT NULL
            );",
        )
        .map_err(failed)?;
        // A store made before verdicts recorded their base or follow-ups
        // gains the columns; its verdicts read as recorded without them.
        let with = |conn: &Connection, column: &str| {
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('verdicts') WHERE name = ?1",
                params![column],
                |row| row.get::<_, i64>(0),
            )
            .map(|found| found > 0)
        };
        for column in ["base", "follow_ups"] {
            if !with(&conn, column).map_err(failed)? {
                let add = format!("ALTER TABLE verdicts ADD COLUMN {column} TEXT");
                if let Err(e) = conn.execute_batch(&add) {
                    if !with(&conn, column).map_err(failed)? {
                        return Err(failed(e));
                    }
                }
            }
        }
        if version < SCHEMA {
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA}"))
                .map_err(failed)?;
        }
        Ok(Self { conn })
    }

    /// Opens the store only when it is there: reading a run never makes
    /// one.
    pub fn existing(home: &Path) -> Result<Option<Self>, String> {
        if !folder(home).join(FILE).is_file() {
            return Ok(None);
        }
        Self::open(home).map(Some)
    }

    /// Deletes the runs that ended more than [`KEPT_ENDED`] ago, with
    /// everything kept of them.
    fn prune(&self) -> Result<(), String> {
        let before = now() - KEPT_ENDED.as_secs() as i64;
        let old = "(SELECT lead FROM ended WHERE at < ?1)";
        for table in RUN_TABLES {
            self.conn
                .execute(
                    &format!("DELETE FROM {table} WHERE lead IN {old}"),
                    params![before],
                )
                .map_err(failed)?;
        }
        self.conn
            .execute("DELETE FROM ended WHERE at < ?1", params![before])
            .map_err(failed)?;
        // A Chord that does not know the earlier ids deletes a run's
        // members without them.
        self.conn
            .execute(
                "DELETE FROM earlier_sessions WHERE token NOT IN (SELECT token FROM members)",
                [],
            )
            .map_err(failed)?;
        // Nor does one that does not know keeps delete a run's keeps with
        // its verdicts.
        self.conn
            .execute(
                "DELETE FROM keeps WHERE verdict NOT IN (SELECT id FROM verdicts)",
                [],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Deletes a lead's run with everything kept of it.
    fn remove(&self, lead: &str) -> Result<(), String> {
        for table in RUN_TABLES.iter().chain(&["ended"]) {
            self.conn
                .execute(
                    &format!("DELETE FROM {table} WHERE lead = ?1"),
                    params![lead],
                )
                .map_err(failed)?;
        }
        Ok(())
    }

    /// Runs `change` as one write, so another session's tool server sees
    /// all of it or none.
    fn at_once<T>(&self, change: impl FnOnce(&Self) -> Result<T, String>) -> Result<T, String> {
        if !self.conn.is_autocommit() {
            return change(self);
        }
        let transaction = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(failed)?;
        let made = change(self)?;
        transaction.commit().map_err(failed)?;
        Ok(made)
    }

    /// The run a lead leads, while it has not ended: an ended run holds
    /// nothing and takes nothing.
    pub fn run(&self, lead: &str) -> Result<Option<Run>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT team, folder, base, at FROM runs
                 WHERE lead = ?1 AND lead NOT IN (SELECT lead FROM ended)",
                params![lead],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(failed)?;
        let Some((team, folder, base, at)) = row else {
            return Ok(None);
        };
        let team = serde_json::from_str(&team)
            .map_err(|e| format!("the run's team could not be read: {e}"))?;
        Ok(Some(Run {
            lead: lead.to_string(),
            team,
            folder: PathBuf::from(folder),
            base,
            at,
        }))
    }

    pub fn member(&self, token: &str) -> Result<Option<Member>, String> {
        self.conn
            .query_row(
                "SELECT token, lead, agent, session, reads_only, brief, folder, base FROM members
                 WHERE token = ?1",
                params![token],
                member_from,
            )
            .optional()
            .map_err(failed)
    }

    pub fn members(&self, lead: &str) -> Result<Vec<Member>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT token, lead, agent, session, reads_only, brief, folder, base FROM members
                 WHERE lead = ?1 ORDER BY rowid",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], member_from)
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The ids the members of a lead's run went by before the one each is
    /// on now, each with the member's token.
    fn earlier_sessions(&self, lead: &str) -> Result<Vec<(String, String)>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT earlier.token, earlier.session FROM earlier_sessions AS earlier
                 JOIN members ON members.token = earlier.token AND members.lead = earlier.lead
                 WHERE earlier.lead = ?1",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The member a token names goes on as the conversation `session`: the
    /// id it was on is kept among its earlier ones, which still name it.
    /// Nothing for a token that is no member.
    fn went_on(&self, token: &str, session: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO earlier_sessions (lead, token, session)
                 SELECT lead, token, session FROM members
                 WHERE token = ?1 AND session IS NOT NULL AND session <> ?2",
                params![token, session],
            )
            .map_err(failed)?;
        self.conn
            .execute(
                "UPDATE members SET session = ?2 WHERE token = ?1",
                params![token, session],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// The lead of the run a session is in, as its lead or a member, while
    /// the run has not ended.
    pub fn lead_of(&self, token: &str) -> Result<Option<String>, String> {
        if self.run(token)?.is_some() {
            return Ok(Some(token.to_string()));
        }
        let Some(member) = self.member(token)? else {
            return Ok(None);
        };
        Ok(self.run(&member.lead)?.map(|_| member.lead))
    }

    pub fn gates(&self, lead: &str) -> Result<Vec<RunGate>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, who, time, touches, rounds, added FROM gates
                 WHERE lead = ?1 ORDER BY id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, u32>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            })
            .map_err(failed)?;
        let mut gates = Vec::new();
        for row in rows {
            let (id, who, time, touches, rounds, added) = row.map_err(failed)?;
            gates.push(RunGate {
                id,
                who,
                when: if time == "plan" {
                    When::Plan
                } else {
                    When::Change
                },
                touches: touches.and_then(|text| serde_json::from_str(&text).ok()),
                rounds,
                added,
            });
        }
        Ok(gates)
    }

    fn insert_gate(&self, lead: &str, id: i64, gate: &Gate, added: bool) -> Result<(), String> {
        let touches = gate
            .touches
            .as_ref()
            .map(|globs| serde_json::to_string(globs).unwrap_or_default());
        let time = match gate.when {
            When::Plan => "plan",
            When::Change => "change",
        };
        self.conn
            .execute(
                "INSERT INTO gates (lead, id, who, time, touches, rounds, added)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![lead, id, gate.who.trim(), time, touches, ROUNDS, added],
            )
            .map_err(failed)?;
        Ok(())
    }

    pub fn latest_plan(&self, lead: &str) -> Result<Option<Plan>, String> {
        self.conn
            .query_row(
                "SELECT version, text, paths, hash, at FROM plans
                 WHERE lead = ?1 ORDER BY version DESC LIMIT 1",
                params![lead],
                plan_from,
            )
            .optional()
            .map_err(failed)
    }

    pub fn plans(&self, lead: &str) -> Result<Vec<Plan>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT version, text, paths, hash, at FROM plans
                 WHERE lead = ?1 ORDER BY version",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], plan_from)
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    pub fn verdicts(&self, lead: &str) -> Result<Vec<Verdict>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, gate, token, agent, agent_version, seen, plan, brief, approved,
                        findings, at, folder, base, follow_ups
                 FROM verdicts WHERE lead = ?1 ORDER BY id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], |row| {
                Ok(Verdict {
                    id: row.get(0)?,
                    gate: row.get(1)?,
                    token: row.get(2)?,
                    agent: row.get(3)?,
                    agent_version: row.get(4)?,
                    on: row.get(5)?,
                    plan: row.get(6)?,
                    brief: row.get(7)?,
                    approved: row.get(8)?,
                    findings: row.get(9)?,
                    at: row.get(10)?,
                    folder: row.get::<_, Option<String>>(11)?.map(PathBuf::from),
                    base: row.get(12)?,
                    follow_ups: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    pub fn keeps(&self, lead: &str) -> Result<Vec<Keep>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, gate, verdict, token, folder, seen, base, reason, at
                 FROM keeps WHERE lead = ?1 ORDER BY id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], |row| {
                Ok(Keep {
                    id: row.get(0)?,
                    gate: row.get(1)?,
                    verdict: row.get(2)?,
                    token: row.get(3)?,
                    folder: PathBuf::from(row.get::<_, String>(4)?),
                    on: row.get(5)?,
                    base: row.get(6)?,
                    reason: row.get(7)?,
                    at: row.get(8)?,
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    pub fn waivers(&self, lead: &str) -> Result<Vec<Waiver>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT gate, reason, at FROM waivers WHERE lead = ?1 ORDER BY gate")
            .map_err(failed)?;
        let rows = statement
            .query_map(params![lead], |row| {
                Ok(Waiver {
                    gate: row.get(0)?,
                    reason: row.get(1)?,
                    at: row.get(2)?,
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }
}

fn member_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Member> {
    Ok(Member {
        token: row.get(0)?,
        lead: row.get(1)?,
        agent: row.get(2)?,
        session: row.get(3)?,
        reads_only: row.get(4)?,
        brief: row.get(5)?,
        folder: PathBuf::from(row.get::<_, String>(6)?),
        base: row.get(7)?,
    })
}

fn plan_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plan> {
    let paths: String = row.get(2)?;
    Ok(Plan {
        version: row.get(0)?,
        text: row.get(1)?,
        paths: serde_json::from_str(&paths).unwrap_or_default(),
        hash: row.get(3)?,
        at: row.get(4)?,
    })
}

/// Begins the run of a lead started with a team, in its folder, with the
/// team's gates. A lead started again with the team its run has goes on
/// with that run's record, an ended run's too, which holds again from then
/// on without the waivers the user gave it before it ended: a waiver is
/// bound to no plan or change, as a verdict or a keep is, so it could
/// stand for work it never saw. A
/// lead started with any other team, or the same team since changed, ends
/// the run it had: its record is removed, its members are in no run, and a
/// run begins with the team as it is now.
pub fn begin(home: &Path, lead: &str, team: &Team, folder: &Path) -> Result<Run, String> {
    let lead = lead.trim();
    if lead.is_empty() {
        return Err("A run needs its lead's token.".into());
    }
    team::check_team(team)?;
    let runs = Runs::open(home)?;
    runs.at_once(|runs| {
        runs.prune()?;
        let ended = runs
            .conn
            .execute("DELETE FROM ended WHERE lead = ?1", params![lead])
            .map_err(failed)?
            > 0;
        if let Some(run) = runs.run(lead)? {
            if run.team == *team {
                if ended {
                    runs.conn
                        .execute("DELETE FROM waivers WHERE lead = ?1", params![lead])
                        .map_err(failed)?;
                }
                return Ok(run);
            }
            runs.remove(lead)?;
        }
        let run = Run {
            lead: lead.to_string(),
            team: team.clone(),
            folder: folder.to_path_buf(),
            base: git::head(folder),
            at: now(),
        };
        let team_json = serde_json::to_string(team).map_err(|e| e.to_string())?;
        runs.conn
            .execute(
                "INSERT INTO runs (lead, team, folder, base, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![lead, team_json, folder.to_string_lossy(), run.base, run.at],
            )
            .map_err(failed)?;
        for (index, gate) in team.gates.iter().enumerate() {
            runs.insert_gate(lead, index as i64 + 1, gate, false)?;
        }
        Ok(run)
    })
}

/// Ends the run a lead leads: its gates hold nothing from then on, its
/// members are in no run, and it is deleted once [`KEPT_ENDED`] has passed.
/// True when a run ended; false for a session that leads none, a member's
/// included, whose end ends nothing. The lead's session is gone once its
/// row is closed for good, and the user may end a run before that.
pub fn end(home: &Path, lead: &str) -> Result<bool, String> {
    let Some(runs) = Runs::existing(home)? else {
        return Ok(false);
    };
    runs.at_once(|runs| {
        runs.prune()?;
        if runs.run(lead)?.is_none() {
            return Ok(false);
        }
        runs.conn
            .execute(
                "INSERT INTO ended (lead, at) VALUES (?1, ?2) ON CONFLICT (lead) DO NOTHING",
                params![lead, now()],
            )
            .map_err(failed)?;
        Ok(true)
    })
}

/// Records a session the lead started as one of its team's agents, in the
/// folder it works in, with the brief it was given and, once known, its
/// harness's id. The change in a folder other than the lead's counts from
/// the newest commit it shares with the run's. A member recorded already
/// keeps its agent, brief and folder and takes the id, and the id it was on
/// still names it, as [`member_by_session`] takes it. A brief is a record
/// and never holds a start back: one longer than [`BRIEF_MOST`] is kept
/// cut to that.
#[allow(clippy::too_many_arguments)]
pub fn join(
    home: &Path,
    lead: &str,
    token: &str,
    agent: &str,
    folder: &Path,
    session: Option<&str>,
    reads_only: bool,
    brief: &str,
) -> Result<Member, String> {
    let runs = Runs::open(home)?;
    runs.at_once(|runs| {
        runs.record(lead, token, agent, folder, session, reads_only, brief)?
            .ok_or_else(|| "That lead has no run.".to_string())
    })
}

impl Runs {
    /// [`join`] within a write the caller holds. None when the lead has
    /// no run, or its run has ended.
    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        lead: &str,
        token: &str,
        agent: &str,
        folder: &Path,
        session: Option<&str>,
        reads_only: bool,
        brief: &str,
    ) -> Result<Option<Member>, String> {
        let runs = self;
        let Some(run) = runs.run(lead)? else {
            return Ok(None);
        };
        let Some(member) = run.team.member(agent.trim()) else {
            return Err(format!(
                "{} is not one of {}'s agents, as its run names them from when it began.",
                agent.trim(),
                run.team.name
            ));
        };
        let brief: String = brief.chars().take(BRIEF_MOST).collect();
        let session = session.map(str::trim).filter(|id| !id.is_empty());
        let base = if same(folder, &run.folder) {
            run.base.clone()
        } else {
            run.base
                .as_deref()
                .zip(git::head(folder))
                .and_then(|(base, head)| git::merge_base(folder, base, &head))
        };
        if let Some(session) = session {
            runs.went_on(token, session)?;
        }
        runs.conn
            .execute(
                "INSERT INTO members (token, lead, agent, session, reads_only, brief, folder, base)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (token) DO UPDATE SET session = COALESCE(?4, session)",
                params![
                    token,
                    lead,
                    member.agent,
                    session,
                    reads_only,
                    brief,
                    folder.to_string_lossy(),
                    base
                ],
            )
            .map_err(failed)?;
        runs.member(token)?
            .map(Some)
            .ok_or_else(|| "The member could not be recorded.".to_string())
    }
}

/// What a session started for another says of it: the token of the
/// session that asked for it, the agent it is and the brief it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Joining {
    pub by: String,
    pub agent: String,
    #[serde(default)]
    pub brief: String,
}

/// Records a session as a member of the run the session that asked for it
/// is in, as its lead or a member, so a member's own start is in its
/// lead's run as well. None, and nothing kept, when that session is in no
/// run. The run is found and the member recorded in one write, so a run
/// that ends as the start lands leaves the session in no run.
pub fn join_from(
    home: &Path,
    joining: &Joining,
    token: &str,
    folder: &Path,
    session: Option<&str>,
    reads_only: bool,
) -> Result<Option<Member>, String> {
    let by = joining.by.trim();
    if by.is_empty() {
        return Ok(None);
    }
    let Some(runs) = Runs::existing(home)? else {
        return Ok(None);
    };
    let token = token.trim();
    runs.at_once(|runs| {
        let Some(lead) = runs.lead_of(by)? else {
            return Ok(None);
        };
        if token.is_empty() {
            return Err("A session in a team's run needs its token.".into());
        }
        runs.record(
            &lead,
            token,
            &joining.agent,
            folder,
            session,
            reads_only,
            &joining.brief,
        )
    })
}

/// Why a start the caller asks for is refused for leaving its run: a
/// session in a team's run starts only the team's agents, and resumes only
/// the run's members, so every session it starts is in the run and held as
/// the run is. `agent` and `resumed` are what the start names. None for a
/// caller in no run, for a start the run takes, and while agents are
/// switched off.
pub fn start_outside(
    home: &Path,
    caller: &str,
    agent: Option<&str>,
    resumed: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(runs) = Runs::existing(home)? else {
        return Ok(None);
    };
    if paused(home) {
        return Ok(None);
    }
    let Some(lead) = runs.lead_of(caller)? else {
        return Ok(None);
    };
    let Some(run) = runs.run(&lead)? else {
        return Ok(None);
    };
    drop(runs);
    if let Some(resumed) = resumed.map(str::trim).filter(|id| !id.is_empty()) {
        return Ok(member_by_session(home, caller, resumed)?
            .is_none()
            .then(|| format!("This session is in {}'s run, which resumes only the sessions in it; {resumed} is not one of them.", run.team.name)));
    }
    let agents = || {
        run.team
            .members
            .iter()
            .map(|member| member.agent.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Ok(
        match agent.map(str::trim).filter(|agent| !agent.is_empty()) {
            Some(agent) if run.team.member(agent).is_some() => None,
            Some(agent) => Some(format!(
            "{agent} is not one of {}'s agents as the run names them from when it began; this session is in that run, which starts only {}.",
            run.team.name,
            agents()
        )),
            None => Some(format!(
                "This session is in {}'s run, which starts only its agents: name one of {}.",
                run.team.name,
                agents()
            )),
        },
    )
}

/// The paths a plan names, each as written in the folder, without a
/// leading `./`, once, in order.
fn plan_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > PATHS_MOST {
        return Err(format!(
            "The plan names {} paths; keep it to {PATHS_MOST} at most.",
            paths.len()
        ));
    }
    let mut kept: Vec<String> = Vec::new();
    for path in paths {
        let path = path.trim();
        let path = path
            .strip_prefix("./")
            .unwrap_or(path)
            .trim_end_matches('/');
        if path.is_empty() {
            continue;
        }
        too_long("path", path, PATH_MOST)?;
        if !kept.iter().any(|seen| seen == path) {
            kept.push(path.to_string());
        }
    }
    kept.sort();
    Ok(kept)
}

/// Keeps a new version of the lead's plan, with the paths it touches.
pub fn plan(home: &Path, lead: &str, text: &str, paths: &[String]) -> Result<Plan, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("The plan is empty.".into());
    }
    too_long("plan", text, PLAN_MOST)?;
    let paths = plan_paths(paths)?;
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(paths.join("\n").as_bytes());
    let hash = hash(&bytes)?;
    let runs = Runs::existing(home)?.ok_or(ONLY_THE_LEAD)?;
    runs.at_once(|runs| {
        runs.run(lead)?.ok_or(ONLY_THE_LEAD)?;
        let version = runs.latest_plan(lead)?.map_or(1, |plan| plan.version + 1);
        let plan = Plan {
            version,
            text: text.to_string(),
            paths,
            hash,
            at: now(),
        };
        runs.conn
            .execute(
                "INSERT INTO plans (lead, version, text, paths, hash, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    lead,
                    plan.version,
                    plan.text,
                    serde_json::to_string(&plan.paths).unwrap_or_default(),
                    plan.hash,
                    plan.at
                ],
            )
            .map_err(failed)?;
        Ok(plan)
    })
}

/// What a session that is not a run's lead is told when it writes a plan,
/// adds a gate or keeps an approval.
pub const ONLY_THE_LEAD: &str =
    "Only the lead of a team's run writes its plan, adds its gates and keeps an approval, and this session leads none.";

/// Adds a gate to the lead's run: `who`, one of its team's agents,
/// approves the plan or the change, when the work touches `touches` if
/// given. A gate is never removed; one the run has already is refused.
pub fn gate_add(
    home: &Path,
    lead: &str,
    who: &str,
    when: When,
    touches: Option<Vec<String>>,
) -> Result<RunGate, String> {
    let runs = Runs::existing(home)?.ok_or(ONLY_THE_LEAD)?;
    runs.at_once(|runs| {
        let run = runs.run(lead)?.ok_or(ONLY_THE_LEAD)?;
        let gates = runs.gates(lead)?;
        if gates.len() >= MOST_GATES {
            return Err(format!(
                "The run has {MOST_GATES} gates, the most it may have."
            ));
        }
        let touches = touches.filter(|globs| !globs.is_empty());
        let gate = Gate {
            who: who.trim().to_string(),
            when,
            touches,
            later: Default::default(),
        };
        // Checked as the team would be with every gate the run has.
        let mut whole = run.team.clone();
        whole.gates = gates
            .iter()
            .map(|gate| Gate {
                who: gate.who.clone(),
                when: gate.when,
                touches: gate.touches.clone(),
                later: Default::default(),
            })
            .chain([gate.clone()])
            .collect();
        team::check_team(&whole)?;
        let who = run
            .team
            .member(&gate.who)
            .map(|member| member.agent.clone())
            .unwrap_or(gate.who.clone());
        let gate = Gate { who, ..gate };
        let id = gates.len() as i64 + 1;
        runs.insert_gate(lead, id, &gate, true)?;
        Ok(RunGate {
            id,
            who: gate.who,
            when,
            touches: gate.touches,
            rounds: ROUNDS,
            added: true,
        })
    })
}

/// The user's waiver of one of the run's gates, with why. It lasts for
/// this run.
pub fn waive(home: &Path, lead: &str, gate: i64, reason: &str) -> Result<Waiver, String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("A waiver says why.".into());
    }
    too_long("reason", reason, REASON_MOST)?;
    let runs = Runs::existing(home)?.ok_or("That lead has no run.")?;
    runs.at_once(|runs| {
        runs.run(lead)?.ok_or("That lead has no run.")?;
        if !runs.gates(lead)?.iter().any(|known| known.id == gate) {
            return Err(format!("The run has no gate {gate}."));
        }
        let waiver = Waiver {
            gate,
            reason: reason.to_string(),
            at: now(),
        };
        runs.conn
            .execute(
                "INSERT INTO waivers (lead, gate, reason, at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (lead, gate) DO UPDATE SET reason = ?3, at = ?4",
                params![lead, gate, waiver.reason, waiver.at],
            )
            .map_err(failed)?;
        Ok(waiver)
    })
}

/// The lead's keep of an approval on gate `gate` that went out of date,
/// with why the change since needs no second look. It is kept for the
/// change `read` the lead read, by its hash or its tree, in the folder
/// named, or in the one place the approval is out of date in when none is
/// named, and passes the gate there while that is the change. An approval
/// is kept once. Refused when the change there is no longer `read`, for a
/// gate on the plan, one the user waived, one that waits for the user, a
/// place whose last verdict asked for changes or that was never approved,
/// and while agents are switched off.
pub fn keep(
    home: &Path,
    lead: &str,
    gate: i64,
    folder: Option<&Path>,
    read: &str,
    reason: &str,
) -> Result<Keep, String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("Keeping an approval says why the change since needs no second look.".into());
    }
    too_long("reason", reason, REASON_MOST)?;
    if paused(home) {
        return Err(
            "Agents and teams are switched off in the settings, so no gate holds and no approval is kept."
                .into(),
        );
    }
    let now_state = state(home, lead)?.ok_or(ONLY_THE_LEAD)?;
    let held = now_state
        .gates
        .iter()
        .find(|known| known.gate.id == gate)
        .ok_or_else(|| format!("The run has no gate {gate}."))?;
    let who = &held.gate.who;
    if held.gate.when == When::Plan {
        return Err(format!(
            "{who}'s gate is on the plan, and only an approval of the change is kept: a plan is read again whenever it changes."
        ));
    }
    if held.standing == Standing::Waived {
        return Err(format!(
            "The user waived {who}'s gate, so there is nothing to keep."
        ));
    }
    if held.at_limit {
        return Err(format!(
            "{who}'s gate asked for changes as many times as its rounds and waits for the user, so the lead keeps none of it."
        ));
    }
    let list = |places: &[&FolderStanding]| {
        places
            .iter()
            .map(|place| place.folder.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let place = match folder {
        Some(folder) => {
            let place = held
                .folders
                .iter()
                .find(|place| same(&place.folder, folder))
                .ok_or_else(|| {
                    format!(
                        "{} is not a folder {who}'s gate is judged in; those are {}.",
                        folder.display(),
                        list(&held.folders.iter().collect::<Vec<_>>())
                    )
                })?;
            if place.standing != Standing::OutOfDate {
                return Err(not_kept(place.standing, &place.reason));
            }
            place
        }
        None => {
            let out_of_date: Vec<&FolderStanding> = held
                .folders
                .iter()
                .filter(|place| place.standing == Standing::OutOfDate)
                .collect();
            match out_of_date.as_slice() {
                [one] => *one,
                [] => return Err(not_kept(held.standing, &held.reason)),
                several => {
                    return Err(format!(
                        "{who}'s approval is out of date in more than one folder, so keeping it names the folder: {}.",
                        list(several)
                    ))
                }
            }
        }
    };
    let at = now_state
        .places
        .iter()
        .find(|known| same(&known.folder, &place.folder))
        .ok_or_else(|| {
            format!(
                "{} is not a folder the run's work is in.",
                place.folder.display()
            )
        })?;
    let on = at
        .change
        .clone()
        .map_err(|e| format!("The change in {} cannot be read: {e}", at.folder.display()))?;
    let runs = Runs::existing(home)?.ok_or(ONLY_THE_LEAD)?;
    let approval = runs
        .verdicts(lead)?
        .into_iter()
        .rev()
        .find(|given| {
            given.gate == gate
                && given
                    .folder
                    .as_deref()
                    .is_some_and(|given| same(given, &place.folder))
        })
        .filter(|given| given.approved)
        .ok_or_else(|| {
            format!(
                "{who} has given no approval of the change in {}, so there is nothing to keep.",
                place.folder.display()
            )
        })?;
    runs.at_once(|runs| {
        runs.run(lead)?.ok_or(ONLY_THE_LEAD)?;
        let before: i64 = runs
            .conn
            .query_row(
                "SELECT COUNT(*) FROM keeps WHERE lead = ?1 AND verdict = ?2",
                params![lead, approval.id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if before > 0 {
            return Err(KEPT_ONCE.into());
        }
        let read = read.trim();
        if on != read && at.tree.as_deref() != Ok(read) {
            return Err(format!(
                "The change in {} is not the one read: it is {on} now, not {read}. Read it again with the gates tool and keep the approval for it.",
                at.folder.display()
            ));
        }
        let mut kept = Keep {
            id: 0,
            gate,
            verdict: approval.id,
            token: lead.to_string(),
            folder: at.folder.clone(),
            on,
            base: at.base.clone(),
            reason: reason.to_string(),
            at: now(),
        };
        runs.conn
            .execute(
                "INSERT INTO keeps (lead, gate, verdict, token, folder, seen, base, reason, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    lead,
                    gate,
                    kept.verdict,
                    kept.token,
                    kept.folder.to_string_lossy(),
                    kept.on,
                    kept.base,
                    kept.reason,
                    kept.at
                ],
            )
            .map_err(failed)?;
        kept.id = runs.conn.last_insert_rowid();
        Ok(kept)
    })
}

/// Why an approval kept once is not kept again: one review stands in for
/// one round of small changes, not for a series of them.
pub const KEPT_ONCE: &str = "This approval was kept once already; ask the gate's agent again.";

/// Why a gate, or a place it is judged in, that stands as `standing` for
/// `reason` is not kept: only an approval that is out of date is.
fn not_kept(standing: Standing, reason: &str) -> String {
    match standing {
        Standing::Approved => format!(
            "{}, and that approval stands, so there is nothing to keep.",
            capitalised(reason)
        ),
        Standing::Kept => "The approval is kept already, for the change as it is now.".into(),
        Standing::NotNeeded | Standing::Waived => {
            format!("{}, so there is nothing to keep.", capitalised(reason))
        }
        Standing::Waiting | Standing::OutOfDate => {
            format!("Only an approval that is out of date is kept, and {reason}.")
        }
    }
}

/// The run of the session a token names, as its lead or a member.
pub fn state_of(home: &Path, token: &str) -> Result<Option<State>, String> {
    let Some(runs) = Runs::existing(home)? else {
        return Ok(None);
    };
    match runs.lead_of(token)? {
        Some(lead) => state(home, &lead),
        None => Ok(None),
    }
}

/// The lead of the run the session a token names is in, as its lead or a
/// member, or none.
pub fn lead_of(home: &Path, token: &str) -> Result<Option<String>, String> {
    match Runs::existing(home)? {
        Some(runs) => runs.lead_of(token),
        None => Ok(None),
    }
}

/// A run as the window reads it: how it stands, with the lines it shows
/// for it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub state: State,
    /// The line above the composer. See [`State::line`].
    pub line: String,
    pub building_held: Option<String>,
    pub handing_over_held: Option<String>,
    pub uncommitted_held: Option<String>,
    pub waits_for_the_user: bool,
    /// How long the user's reason for a waiver may be, in characters.
    pub reason_most: usize,
}

impl From<State> for View {
    fn from(state: State) -> View {
        View {
            line: state.line(),
            building_held: state.building_held(),
            handing_over_held: state.handing_over_held(),
            uncommitted_held: state.uncommitted_held(),
            waits_for_the_user: state.waits_for_the_user(),
            reason_most: REASON_MOST,
            state,
        }
    }
}

/// The run of a lead as it stands now, or none where it has none.
pub fn state(home: &Path, lead: &str) -> Result<Option<State>, String> {
    let Some(runs) = Runs::existing(home)? else {
        return Ok(None);
    };
    let Some(run) = runs.run(lead)? else {
        return Ok(None);
    };
    let plan = runs.latest_plan(lead)?;
    let verdicts = runs.verdicts(lead)?;
    let waivers = runs.waivers(lead)?;
    let keeps = runs.keeps(lead)?;
    let members = runs.members(lead)?;
    let mut folders: Vec<(&Path, Option<&str>)> = vec![(&run.folder, run.base.as_deref())];
    let mut gone: Vec<PathBuf> = Vec::new();
    for member in members.iter().filter(|member| !member.reads_only) {
        if folders
            .iter()
            .any(|(folder, _)| same(folder, &member.folder))
            || gone.contains(&member.folder)
        {
            continue;
        }
        if member.folder.exists() {
            folders.push((&member.folder, member.base.as_deref()));
        } else {
            gone.push(member.folder.clone());
        }
    }
    let from = git::prefix(&run.folder).unwrap_or_default();
    let places: Vec<Place> = folders
        .iter()
        .map(|(folder, start)| Place::read(folder, &from, *start))
        .collect();
    let mut paths: Vec<String> = plan
        .as_ref()
        .map(|plan| plan.paths.clone())
        .unwrap_or_default();
    for place in &places {
        for path in place.changed.iter().flatten() {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
    }
    let gates = runs
        .gates(lead)?
        .into_iter()
        .map(|gate| {
            let mine: Vec<&Verdict> = verdicts.iter().filter(|v| v.gate == gate.id).collect();
            let kept: Vec<&Keep> = keeps.iter().filter(|k| k.gate == gate.id).collect();
            let waiver = waivers.iter().find(|w| w.gate == gate.id).cloned();
            stand(gate, &mine, &kept, waiver, plan.as_ref(), &places)
        })
        .collect();
    Ok(Some(State {
        run,
        plan,
        places,
        gone,
        paths,
        gates,
    }))
}

/// The places a gate on the change is judged in: those something changed
/// in, or the lead's folder while nothing changed anywhere.
fn judged_places(places: &[Place]) -> Vec<&Place> {
    let changed: Vec<&Place> = places.iter().filter(|place| place.changed_any()).collect();
    if changed.is_empty() {
        places.iter().take(1).collect()
    } else {
        changed
    }
}

/// How a gate stands, by its verdicts, the lead's keeps of them and the
/// user's waiver. A place where the last verdict was an approval that is
/// out of date stands kept while a keep of that verdict names the change
/// there as it is now.
fn stand(
    gate: RunGate,
    verdicts: &[&Verdict],
    keeps: &[&Keep],
    waiver: Option<Waiver>,
    plan: Option<&Plan>,
    places: &[Place],
) -> GateState {
    let asks = verdicts.iter().filter(|v| !v.approved).count() as u32;
    let verdict = verdicts.last().map(|v| (*v).clone());
    let who = gate.who.clone();
    let state = |standing, at_limit, reason: String, folders| GateState {
        gate: gate.clone(),
        standing,
        asks,
        at_limit,
        reason,
        verdict: verdict.clone(),
        waiver: waiver.clone(),
        kept: None,
        folders,
    };
    if let Some(waiver) = &waiver {
        return state(
            Standing::Waived,
            false,
            format!("the user waived {who}'s gate: {}", waiver.reason),
            Vec::new(),
        );
    }
    let planned: &[String] = plan.map_or(&[], |plan| &plan.paths);
    // A gate on some paths holds for a place when the plan or the change
    // there touches one of them.
    let touched = |changed: &[String]| {
        gate.touches
            .as_ref()
            .is_none_or(|globs| team::plan_touches(globs, planned) || team::touches(globs, changed))
    };
    if gate.when == When::Plan {
        let Some(plan) = plan else {
            return state(
                Standing::Waiting,
                false,
                "no plan is written yet".into(),
                Vec::new(),
            );
        };
        // Needed unless the plan, and all of the change in every place,
        // touches none of the gate's paths.
        let unread = places.iter().any(|place| place.changed.is_err());
        let changed: Vec<String> = places
            .iter()
            .flat_map(|place| place.changed.iter().flatten().cloned())
            .collect();
        if !unread && !touched(&changed) {
            return state(
                Standing::NotNeeded,
                false,
                format!("the plan touches nothing {who} approves"),
                Vec::new(),
            );
        }
        let last = verdicts.last().copied();
        let (standing, at_limit, reason) = judge(
            &who,
            "the plan",
            last,
            |given| given.on == plan.hash,
            asks,
            gate.rounds,
        );
        return state(standing, at_limit, reason, Vec::new());
    }
    let judged = judged_places(places);
    let several = judged.len() > 1;
    let (folders, kept): (Vec<FolderStanding>, Vec<Option<Keep>>) = judged
        .iter()
        .map(|place| {
            let of = if several {
                format!("the change in {}", place.folder.display())
            } else {
                "the change".to_string()
            };
            let (standing, reason, kept) = match (&place.change, &place.changed) {
                (Err(e), _) => (Standing::Waiting, format!("{of} cannot be read: {e}"), None),
                (Ok(_), Ok(changed)) if !touched(changed) => (
                    Standing::NotNeeded,
                    format!("{of} touches nothing {who} approves"),
                    None,
                ),
                (Ok(_), _) => {
                    let last = verdicts
                        .iter()
                        .rev()
                        .find(|v| v.folder.as_deref().is_some_and(|f| same(f, &place.folder)))
                        .copied();
                    let (standing, _, reason) = judge(
                        &who,
                        &of,
                        last,
                        |given| place.approves(given),
                        asks,
                        gate.rounds,
                    );
                    let kept = last
                        .filter(|_| standing == Standing::OutOfDate)
                        .and_then(|last| {
                            keeps.iter().rev().find(|keep| {
                                keep.verdict == last.id
                                    && same(&keep.folder, &place.folder)
                                    && place.holds(&keep.on, keep.base.as_deref())
                            })
                        });
                    match kept {
                        Some(keep) => (
                            Standing::Kept,
                            format!("the lead kept {who}'s approval of {of}: {}", keep.reason),
                            Some((*keep).clone()),
                        ),
                        None => (standing, reason, None),
                    }
                }
            };
            (
                FolderStanding {
                    folder: place.folder.clone(),
                    standing,
                    reason,
                },
                kept,
            )
        })
        .unzip();
    let kept = kept.into_iter().flatten().next();
    let open = folders.iter().find(|place| place.standing.open());
    let at_limit = asks >= gate.rounds && open.is_some();
    let (standing, reason) = match open {
        Some(place) if at_limit && place.standing == Standing::Waiting => {
            (place.standing, waits_for_the_user(&who, "the change", asks))
        }
        Some(place) => (place.standing, place.reason.clone()),
        // A gate kept in one place and approved in another stands kept:
        // part of what it passes no reviewer saw.
        None => folders
            .iter()
            .find(|place| place.standing == Standing::Kept)
            .or_else(|| {
                folders
                    .iter()
                    .find(|place| place.standing == Standing::Approved)
            })
            .or(folders.first())
            .map_or(
                (Standing::Waiting, "the change cannot be read".to_string()),
                |place| (place.standing, place.reason.clone()),
            ),
    };
    GateState {
        kept,
        ..state(standing, at_limit, reason, folders)
    }
}

/// How a gate stands on the plan or on the change in one place, by the
/// last verdict it was given there and whether what it was given on
/// stands now, and whether it waits for the user.
fn judge(
    who: &str,
    of: &str,
    last: Option<&Verdict>,
    stands: impl Fn(&Verdict) -> bool,
    asks: u32,
    rounds: u32,
) -> (Standing, bool, String) {
    let at_limit = asks >= rounds;
    match last {
        Some(last) if last.approved && stands(last) => {
            (Standing::Approved, false, format!("{who} approved {of}"))
        }
        Some(last) if last.approved => (
            Standing::OutOfDate,
            at_limit,
            format!("{who}'s approval of {of} is out of date"),
        ),
        Some(_) if at_limit => (Standing::Waiting, true, waits_for_the_user(who, of, asks)),
        Some(_) => (
            Standing::Waiting,
            false,
            format!("{who} asked for changes to {of}"),
        ),
        None => (
            Standing::Waiting,
            false,
            format!("{who} has not approved {of} yet"),
        ),
    }
}

fn waits_for_the_user(who: &str, of: &str, asks: u32) -> String {
    format!("{who} asked for changes to {of} {asks} times; the gate waits for the user, who may waive it")
}

/// What a session that is not a gate's member is told when it gives a
/// verdict.
pub const NOT_A_MEMBER: &str =
    "Only an agent a team's run started to approve one of its gates gives a verdict, and this session is none.";

/// What a member read before its verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Read<'a> {
    /// The version of the plan it read.
    Plan { version: i64 },
    /// The hash of the change it read, in the folder named, which may be
    /// left out while the change is judged in one place. The hash of the
    /// folder's tree stands for its change as well.
    Change {
        folder: Option<&'a Path>,
        change: &'a str,
    },
}

/// Records the verdict of the session `token` names on what it read, the
/// plan's version or the change in one place, on each gate of the run its
/// agent approves then, recording the change's hash. A member that reads
/// in a folder of its own, which is no place of the run's work, and names
/// it, gives its verdict on the change in the place that folder has, with
/// its lines placed in the files that folder read them in; see
/// [`State::read_in`]. A verdict on something that no longer
/// stands is refused, saying what changed. A gate the user waived, or one
/// that waits for the user, takes none. Asking for changes says what must
/// change. An approval may name follow-ups, small fixes it needs no second
/// look at; asking for changes names none, all of it being findings.
pub fn verdict(
    home: &Path,
    token: &str,
    read: Read<'_>,
    approved: bool,
    findings: &str,
    follow_ups: &str,
    agent_version: Option<&str>,
) -> Result<Vec<GateState>, String> {
    let findings = findings.trim();
    if !approved && findings.is_empty() {
        return Err("Asking for changes says what must change, in the findings.".into());
    }
    too_long("findings", findings, FINDINGS_MOST)?;
    let follow_ups = follow_ups.trim();
    if !approved && !follow_ups.is_empty() {
        return Err(
            "Follow-ups go with an approval; asking for changes puts all of it in the findings."
                .into(),
        );
    }
    too_long("follow-ups", follow_ups, FINDINGS_MOST)?;
    let runs = Runs::existing(home)?.ok_or(NOT_A_MEMBER)?;
    let member = runs.member(token)?.ok_or(NOT_A_MEMBER)?;
    let now_state = state(home, &member.lead)?.ok_or(NOT_A_MEMBER)?;
    let on = match read {
        Read::Plan { .. } => When::Plan,
        Read::Change { .. } => When::Change,
    };
    let mine: Vec<&GateState> = now_state
        .gates
        .iter()
        .filter(|gate| gate.gate.when == on && gate.gate.who.eq_ignore_ascii_case(&member.agent))
        .collect();
    if mine.is_empty() {
        return Err(format!(
            "{} approves no gate {} in this run.",
            member.agent,
            on.words()
        ));
    }
    let (seen, version, folder, base) = match read {
        Read::Plan { version } => {
            let plan = now_state
                .plan
                .as_ref()
                .ok_or("No plan is written yet, so there is nothing to approve before building.")?;
            if version != plan.version {
                return Err(if (1..plan.version).contains(&version) {
                    format!(
                        "Version {version} of the plan is not the latest: version {} is. Read it with the gates tool and give the verdict on it.",
                        plan.version
                    )
                } else {
                    format!(
                        "The plan has no version {version}; the latest is version {}.",
                        plan.version
                    )
                });
            }
            (plan.hash.clone(), Some(plan.version), None, None)
        }
        Read::Change { folder, change } => {
            let own = folder.filter(|folder| {
                same(folder, &member.folder)
                    && !now_state
                        .places
                        .iter()
                        .any(|place| same(&place.folder, folder))
            });
            let (place, anchor) = match own {
                Some(own) => now_state.read_in(own)?,
                None => {
                    let place = now_state.place_for(folder)?;
                    (place, place.base.clone())
                }
            };
            let now = place.change.clone().map_err(|e| {
                format!(
                    "The change in {} cannot be read: {e}",
                    place.folder.display()
                )
            })?;
            let read = change.trim();
            if now != read && place.tree.as_deref() != Ok(read) {
                return Err(format!(
                    "The change in {} is not the one read: it is {now} now, not {read}. Read it again with the gates tool and give the verdict on it.",
                    place.folder.display()
                ));
            }
            (
                place.change_from(anchor.as_deref())?,
                None,
                Some(place.folder.to_string_lossy().into_owned()),
                anchor,
            )
        }
    };
    let taking: Vec<&&GateState> = mine
        .iter()
        .filter(|gate| gate.standing != Standing::Waived && !gate.at_limit)
        .collect();
    if taking.is_empty() {
        let gate = mine[0];
        return Err(if gate.standing == Standing::Waived {
            format!(
                "The user waived {}'s gate, so it takes no verdict.",
                gate.gate.who
            )
        } else {
            format!(
                "{}'s gate asked for changes as many times as its rounds and waits for the user, so it takes no verdict.",
                gate.gate.who
            )
        });
    }
    let at = now();
    runs.at_once(|runs| {
        for gate in &taking {
            runs.conn
                .execute(
                    "INSERT INTO verdicts (lead, gate, token, agent, agent_version, seen, plan,
                                           brief, approved, findings, at, folder, base,
                                           follow_ups)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        member.lead,
                        gate.gate.id,
                        token,
                        member.agent,
                        agent_version,
                        seen,
                        version,
                        member.brief,
                        approved,
                        findings,
                        at,
                        folder,
                        base,
                        follow_ups
                    ],
                )
                .map_err(failed)?;
        }
        Ok(())
    })?;
    let ids: Vec<i64> = taking.iter().map(|gate| gate.gate.id).collect();
    let after = state(home, &member.lead)?.ok_or(NOT_A_MEMBER)?;
    Ok(after
        .gates
        .into_iter()
        .filter(|gate| ids.contains(&gate.gate.id))
        .collect())
}

/// Why starting a session in a run is held: while a gate on the plan is
/// open, a session that changes files does not start. `reads_only` is
/// whether the session's agent only reads, or for a session resumed,
/// whether the member it resumes did. None when nothing holds it, the
/// caller leads no run and is in none, or agents are switched off.
pub fn start_held(home: &Path, caller: &str, reads_only: bool) -> Result<Option<String>, String> {
    if reads_only {
        return Ok(None);
    }
    let held = state_of(home, caller)?.and_then(|state| state.building_held());
    Ok(held.filter(|_| !paused(home)))
}

/// Whether the session a token names leads a run that holds: one that has
/// not ended, while agents are switched on. A store that cannot be read
/// says it leads none.
pub fn leads(home: &Path, token: &str) -> bool {
    !paused(home)
        && Runs::existing(home)
            .ok()
            .flatten()
            .and_then(|runs| runs.run(token).ok().flatten())
            .is_some()
}

/// Whether the session a token names leads a run that holds, as
/// [`leads`] says, and the session a send or a stop names is a member of
/// that run, named by its id or a start of it as [`member_by_session`]
/// takes it. A store that cannot be read, or a name that is too short or
/// fits more than one member, says no.
pub fn leads_member(home: &Path, token: &str, session: &str) -> bool {
    leads(home, token)
        && member_by_session(home, token, session)
            .ok()
            .flatten()
            .is_some_and(|member| member.lead == token)
}

/// Whether the session a token names is a member that reads only of a run
/// that holds, as [`leads`] takes one to: as it joined the run. A store
/// that cannot be read says it is not.
pub fn member_reads_only(home: &Path, token: &str) -> bool {
    if paused(home) {
        return false;
    }
    let Some(runs) = Runs::existing(home).ok().flatten() else {
        return false;
    };
    runs.member(token)
        .ok()
        .flatten()
        .filter(|member| member.reads_only)
        .is_some_and(|member| runs.run(&member.lead).ok().flatten().is_some())
}

/// Whether every run holds nothing: agents are switched off in the
/// settings. The runs are kept as they are and hold again once agents are
/// on.
fn paused(home: &Path) -> bool {
    !crate::settings::agents_on(home)
}

/// Why the lead of a run goes on rather than ending its turn: a gate holds
/// the hand-over and something the lead does can move it on, so the turn
/// would end with the work not handed over. None for a session that leads
/// no run, when nothing holds, when every open gate waits for the user,
/// while agents are switched off, or when the run cannot be read, so a
/// broken store never keeps a lead going.
pub fn stop_held(home: &Path, token: &str) -> Option<String> {
    stop_hold(home, token).map(|held| told_to_go_on(&held))
}

/// The gate that holds a lead's stop, as said to the user, such as that
/// handing over is held as a reviewer has not approved the change yet.
/// None where [`stop_held`] is None.
pub fn stop_hold(home: &Path, token: &str) -> Option<String> {
    let state = state(home, token).ok().flatten()?;
    if state.waits_for_the_user() || paused(home) {
        return None;
    }
    state.handing_over_held()
}

/// What a lead whose stop is held is told: what holds it, and how to go on.
pub fn told_to_go_on(held: &str) -> String {
    format!("{held} The gates tool says what each gate waits on. Ask for the verdicts it names and wait for them, keep an approval that is out of date where the change since needs no second look, or stop to ask the user.")
}

/// Why a shell command a session in a run would run is refused: it hands
/// the work over while a gate holds that, or while approved work is not
/// committed. A run that cannot be read holds
/// it too. None for a command that hands nothing over, a session in no
/// run, a run with no gate open, or while agents are switched off.
pub fn command_held(home: &Path, token: &str, command: &str) -> Option<String> {
    if !hands_over(command) || paused(home) {
        return None;
    }
    match state_of(home, token) {
        Ok(state) => state.and_then(|state| {
            state
                .handing_over_held()
                .map(|held| format!("{held} Pushing and opening or merging a pull request wait until every gate passes or the user waives it."))
                .or_else(|| state.uncommitted_held())
        }),
        Err(e) => Some(format!(
            "Handing over is held: the team's run this session is in cannot be read: {e}"
        )),
    }
}

/// The member of the caller's run that a session's id names, by the id or
/// a prefix of it eight characters long at least that names one member
/// alone. The id a member is on now names it first; only where none fits
/// does one it went by before in the run, so a member that went on as a
/// fresh conversation or from the conversation before it is still named
/// by the id it joined with.
pub fn member_by_session(
    home: &Path,
    caller: &str,
    session: &str,
) -> Result<Option<Member>, String> {
    let Some(runs) = Runs::existing(home)? else {
        return Ok(None);
    };
    let Some(lead) = runs.lead_of(caller)? else {
        return Ok(None);
    };
    let session = session.trim();
    if session.is_empty() {
        return Ok(None);
    }
    if session.chars().count() < SESSION_PREFIX {
        return Ok(None);
    }
    let members = runs.members(&lead)?;
    let now: Vec<&Member> = members
        .iter()
        .filter(|member| {
            member
                .session
                .as_deref()
                .is_some_and(|id| id.starts_with(session))
        })
        .collect();
    if !now.is_empty() {
        return Ok(match now.as_slice() {
            [member] => Some((*member).clone()),
            _ => None,
        });
    }
    let earlier: BTreeSet<String> = runs
        .earlier_sessions(&lead)?
        .into_iter()
        .filter(|(_, id)| id.starts_with(session))
        .map(|(token, _)| token)
        .collect();
    let mut tokens = earlier.into_iter();
    Ok(match (tokens.next(), tokens.next()) {
        (Some(token), None) => members.into_iter().find(|member| member.token == token),
        _ => None,
    })
}

/// Records that the session a token names goes on as the conversation
/// `session`, a fresh one or one resumed, so where it is a member of a
/// team's run the id names it, and so do the ids it went by before.
/// Nothing for a token that is no member, or where no run was ever kept.
/// Only a member on a new id writes: the rest only read, which waits on
/// no other writer of the store.
pub fn went_on(home: &Path, token: &str, session: &str) -> Result<(), String> {
    let session = session.trim();
    if session.is_empty() {
        return Ok(());
    }
    let Some(runs) = Runs::existing(home)? else {
        return Ok(());
    };
    match runs.member(token)? {
        Some(member) if member.session.as_deref() != Some(session) => {
            runs.at_once(|runs| runs.went_on(token, session))
        }
        _ => Ok(()),
    }
}

/// How much of a session's id names it, at least, as the start tool takes
/// it.
pub const SESSION_PREFIX: usize = 8;

#[path = "run_command.rs"]
mod command;
pub use command::hands_over;

#[cfg(test)]
#[path = "run_tests.rs"]
pub(crate) mod tests;
