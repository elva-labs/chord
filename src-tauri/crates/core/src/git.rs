//! What the working tree looks like right now.
//!
//! libgit2 rather than gix: its status and diff are boring and complete, which
//! is exactly what you want underneath a UI. Almost everything here is a plain
//! query against a path, with no state of its own, so the watcher can call it
//! again whenever the tree moves and the pane simply re-renders. The
//! worktrees are the exception: adding one and taking one away change what
//! is on disk, and they run git itself rather than libgit2.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use git2::{AttrCheckFlags, AttrValue, DiffFormat, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;

/// Above this a diff stops being something you read and starts being something
/// that makes the pane crawl. The viewer says so rather than rendering it.
const MAX_DIFF_LINES: usize = 4000;
const MAX_CONTENT_LINES: usize = 8000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// M, A, D, R or C, matching what git itself calls them.
    pub status: String,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// hunk, add, del or ctx.
    pub kind: String,
    pub text: String,
    pub old: Option<u32>,
    pub new: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub lines: Vec<DiffLine>,
    pub binary: bool,
    /// True when the diff was cut short at the line cap.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub lines: Vec<String>,
    pub binary: bool,
    pub truncated: bool,
}

fn open(path: &Path) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("not a git repository: {}", e.message()))
}

/// Letters chosen to match `git status --short`, and the order of the checks
/// matters: a file can be both staged and modified, and the more interesting
/// of the two is what the pane should show.
fn letter(status: Status) -> &'static str {
    if status.is_index_new() || status.is_wt_new() {
        "A"
    } else if status.is_index_deleted() || status.is_wt_deleted() {
        "D"
    } else if status.is_index_renamed() || status.is_wt_renamed() {
        "R"
    } else if status.is_conflicted() {
        "C"
    } else {
        "M"
    }
}

/// Whether a status entry names a directory rather than a file.
///
/// Git does not look inside a directory that holds a repository of its own,
/// a worktree under the project among them, so status reports the whole
/// directory as one path with a trailing slash. Nothing can be done with it:
/// a directory has no diff, and reading it as a file is an error.
fn is_directory(path: &str) -> bool {
    path.ends_with('/')
}

pub fn status(root: &Path) -> Result<Vec<ChangedFile>, String> {
    let repo = open(root)?;

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| format!("could not read status: {}", e.message()))?;

    let changed: Vec<(String, Status)> = statuses
        .iter()
        .filter(|entry| entry.status() != Status::CURRENT)
        .filter_map(|entry| {
            entry
                .path()
                .ok()
                .map(|path| (path.to_string(), entry.status()))
        })
        .filter(|(path, _)| !is_directory(path))
        .collect();

    let counts = line_counts(
        &repo,
        changed
            .iter()
            .filter(|(_, status)| *status != Status::WT_NEW)
            .map(|(path, _)| path.as_str()),
    );

    let mut files: Vec<ChangedFile> = changed
        .into_iter()
        .map(|(path, status)| {
            let (add, del, binary) = if status == Status::WT_NEW {
                untracked_counts(&repo, &path)
            } else {
                counts.get(&path).copied().unwrap_or_default()
            };
            ChangedFile {
                path,
                status: letter(status).to_string(),
                add,
                del,
                binary,
            }
        })
        .collect();

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Additions, deletions and binary-ness per path, from one diff over all of
/// them at once. Diffing the tree once per changed file is quadratic in
/// practice, and an agent mid-refactor touches a lot of files.
fn line_counts<'a>(
    repo: &Repository,
    paths: impl Iterator<Item = &'a str>,
) -> HashMap<String, (u32, u32, bool)> {
    let mut options = DiffOptions::new();
    // include_untracked lists a new file; show_untracked_content is what makes
    // its lines appear. Without the second, a file the agent just created shows
    // up with an empty diff, which is the common case rather than an edge one.
    //
    // The paths are literal, so the walk looks each file up in them as a
    // sorted list and skips folders holding none of them. That keeps one
    // status read linear in the files a project holds, thousands of new ones
    // included.
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .disable_pathspec_match(true);
    let mut any = false;
    for path in paths {
        options.pathspec(path);
        any = true;
    }

    let mut counts = HashMap::new();
    if !any {
        return counts;
    }

    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let Ok(diff) = repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut options)) else {
        return counts;
    };

    let _ = diff.print(DiffFormat::Patch, |delta, _, line| {
        let Some(path) = delta.new_file().path().or(delta.old_file().path()) else {
            return true;
        };
        let entry: &mut (u32, u32, bool) = counts
            .entry(path.to_string_lossy().to_string())
            .or_default();
        if delta.flags().is_binary() {
            entry.2 = true;
        }
        match line.origin() {
            '+' => entry.0 += 1,
            '-' => entry.1 += 1,
            _ => {}
        }
        true
    });

    counts
}

/// How far into a file git looks for a NUL byte to call it binary.
const BINARY_PROBE: usize = 8000;

/// The size over which libgit2 calls a file binary without reading it.
const MAX_TEXT: u64 = 512 * 1024 * 1024;

/// Lines and binary-ness of a file git does not track, all of which is added
/// lines, counted the way git counts them. Only the start of a binary file is
/// read: a project can hold thousands of untracked screenshots, and status
/// runs whenever the tree moves.
fn untracked_counts(repo: &Repository, path: &str) -> (u32, u32, bool) {
    // The `diff` attribute unset makes a file binary and set makes it text,
    // without a look inside. A diff driver named there is probed like no
    // attribute at all: its own `binary` setting is not read.
    let probe = match repo
        .get_attr(Path::new(path), "diff", AttrCheckFlags::FILE_THEN_INDEX)
        .map(AttrValue::from_string)
    {
        Ok(AttrValue::False) => return (0, 0, true),
        Ok(AttrValue::True) => false,
        _ => true,
    };
    let Some(full) = repo.workdir().map(|dir| dir.join(path)) else {
        return (0, 0, false);
    };
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return (0, 0, false);
    };
    if meta.file_type().is_symlink() {
        return (1, 0, false);
    }
    if probe && meta.len() > MAX_TEXT {
        return (0, 0, true);
    }
    match std::fs::File::open(&full).map(|file| added_lines(file, probe)) {
        Ok(Some(lines)) => (lines, 0, false),
        Ok(None) => (0, 0, true),
        Err(_) => (0, 0, false),
    }
}

/// The lines in what `reader` holds, or None when `probe` asks and it is
/// binary: a NUL byte in its first `BINARY_PROBE` bytes, after which nothing
/// more is read.
fn added_lines(mut reader: impl Read, probe: bool) -> Option<u32> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut seen = 0usize;
    let mut lines = 0u32;
    let mut last = b'\n';
    loop {
        let limit = if seen < BINARY_PROBE {
            BINARY_PROBE - seen
        } else {
            buffer.len()
        };
        let read = match reader.read(&mut buffer[..limit]) {
            Ok(0) => break,
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let chunk = &buffer[..read];
        if probe && seen < BINARY_PROBE && chunk.contains(&0) {
            return None;
        }
        seen += read;
        lines = lines.saturating_add(chunk.iter().filter(|&&byte| byte == b'\n').count() as u32);
        last = chunk[read - 1];
    }
    if last != b'\n' {
        lines = lines.saturating_add(1);
    }
    Some(lines)
}

pub fn diff(root: &Path, file: &str) -> Result<FileDiff, String> {
    let repo = open(root)?;

    let mut options = DiffOptions::new();
    options
        .pathspec(file)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);

    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo
        .diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut options))
        .map_err(|e| format!("could not diff {file}: {}", e.message()))?;

    let mut lines = Vec::new();
    let mut binary = false;
    let mut truncated = false;

    let _ = diff.print(DiffFormat::Patch, |delta, hunk, line| {
        if delta.flags().is_binary() {
            binary = true;
            return true;
        }
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            return false;
        }

        // The file header lines carry no hunk and are noise in a pane that
        // already names the file.
        let kind = match line.origin() {
            '+' => "add",
            '-' => "del",
            ' ' => "ctx",
            'H' => "hunk",
            _ => return true,
        };
        if kind == "hunk" && hunk.is_none() {
            return true;
        }

        lines.push(DiffLine {
            kind: kind.to_string(),
            text: String::from_utf8_lossy(line.content())
                .trim_end_matches('\n')
                .to_string(),
            old: line.old_lineno(),
            new: line.new_lineno(),
        });
        true
    });

    Ok(FileDiff {
        lines,
        binary,
        truncated,
    })
}

/// A path inside the worktree, and nothing else: the frontend only ever asks
/// for paths git listed, but the core is the one that has to make that true.
pub(crate) fn inside_worktree(file: &str) -> Result<&Path, String> {
    use std::path::Component;

    let path = Path::new(file);
    let escapes = path
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
    if file.is_empty() || escapes {
        return Err(format!("{file} is not a path inside the working tree"));
    }
    Ok(path)
}

pub fn content(root: &Path, file: &str) -> Result<FileContent, String> {
    let repo = open(root)?;
    let workdir = repo
        .workdir()
        .ok_or("a bare repository has no working tree")?;
    let path = workdir.join(inside_worktree(file)?);

    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {file}: {e}"))?;

    // The same rule git uses: a NUL byte in the first few kilobytes means this
    // is not text, and rendering it would fill the pane with noise.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Ok(FileContent {
            lines: Vec::new(),
            binary: true,
            truncated: false,
        });
    }

    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    let truncated = all.len() > MAX_CONTENT_LINES;

    Ok(FileContent {
        lines: all
            .into_iter()
            .take(MAX_CONTENT_LINES)
            .map(str::to_string)
            .collect(),
        binary: false,
        truncated,
    })
}

/// Everything in the working tree that git would track, plus what it does not
/// yet, honouring .gitignore. A second data source, not a filter over status.
pub fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let repo = open(root)?;

    let mut paths: Vec<String> = repo
        .index()
        .map_err(|e| format!("could not read the index: {}", e.message()))?
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path).ok())
        .collect();

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    if let Ok(statuses) = repo.statuses(Some(&mut options)) {
        for entry in statuses.iter() {
            if entry.status().is_wt_new() {
                if let Ok(path) = entry.path() {
                    if !is_directory(path) {
                        paths.push(path.to_string());
                    }
                }
            }
        }
    }

    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    /// One-based, as editors count.
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    /// True when there were more than the cap and the rest were dropped.
    pub truncated: bool,
}

/// Hits beyond this many are cut: a query like `e` matches most lines of a
/// repository, and a list that long says nothing a shorter one does not.
pub const GREP_CAP: usize = 500;

/// Lines matching a query, through `git grep`: fixed string, case-folded,
/// text files only, tracked and untracked alike, so what is searched is what
/// the tree lists. `paths` narrows it to those files, which is how a search
/// follows the changed-files scope. An empty query is no search.
pub fn grep(root: &Path, query: &str, paths: Option<&[String]>) -> Result<GrepResult, String> {
    if query.trim().is_empty() {
        return Ok(GrepResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    if let Some(paths) = paths {
        if paths.is_empty() {
            return Ok(GrepResult {
                hits: Vec::new(),
                truncated: false,
            });
        }
    }

    let workdir = workdir(root)?;
    let mut command = command(&workdir);
    command.args([
        "grep",
        "-n",
        "-I",
        "-i",
        "-F",
        "--no-color",
        "--untracked",
        "-e",
        query,
    ]);
    if let Some(paths) = paths {
        command.arg("--");
        command.args(paths);
    }
    let output = command
        .output()
        .map_err(|e| format!("could not run git grep: {e}"))?;
    // 1 is git's "nothing matched"; anything above is an error worth reading.
    if !output.status.success() && output.status.code() != Some(1) {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "git grep failed".to_string()
        } else {
            message
        });
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut hits = Vec::new();
    let mut truncated = false;
    for line in text.lines() {
        if hits.len() >= GREP_CAP {
            truncated = true;
            break;
        }
        // path:line:text, and a path may itself hold no colon that matters:
        // the line number is the first field that parses.
        let Some((path, rest)) = line.split_once(':') else {
            continue;
        };
        let Some((number, matched)) = rest.split_once(':') else {
            continue;
        };
        let Ok(number) = number.parse::<u32>() else {
            continue;
        };
        hits.push(GrepHit {
            path: path.to_string(),
            line: number,
            text: matched.to_string(),
        });
    }
    Ok(GrepResult { hits, truncated })
}

/// The worktree root, which is what the watcher should watch and what paths
/// are relative to.
pub fn workdir(root: &Path) -> Result<PathBuf, String> {
    let repo = open(root)?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "a bare repository has no working tree".to_string())
}

/// Where a project keeps the worktrees the workbench makes for it.
pub const WORKTREES: &str = ".claude/worktrees";

/// The branch a worktree the workbench made in the project was made on,
/// which is its directory's name, or None for a folder that is not one of
/// those worktrees.
pub fn made_branch(project: &Path, cwd: &Path) -> Option<String> {
    let under = dunce::canonicalize(project.join(WORKTREES)).ok()?;
    let cwd = dunce::canonicalize(cwd).ok()?;
    let name = cwd.strip_prefix(&under).ok()?;
    let mut parts = name.components();
    let only = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let name = only.as_os_str().to_str()?;
    plain_worktree_name(name).then(|| name.to_string())
}

/// A worktree's name, which is also a branch's and a directory's: letters,
/// digits, dashes and underscores, and never one of git's own options.
fn plain_worktree_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 60
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Variables that name a repository, a work tree, an index, objects or the
/// refs to look under. A process started by `git rebase --exec`, a hook or
/// `git bisect run` inherits them, and git would follow them away from the
/// directory it is asked to work in. `GIT_CONFIG_PARAMETERS` is here because
/// only `git -c` sets it, and it can carry `core.worktree`. The user's own
/// config variables (`GIT_CONFIG_COUNT` with its keys and values, the global
/// and system files) and identity variables are not: those are settings, not
/// a pointer at a repository.
pub(crate) const REPOSITORY_VARIABLES: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
];

/// Every git the core starts is built here: run in `dir`, with the variables
/// that name a repository cleared so the repository is the one `dir` is in,
/// and with the ext transport off, since it runs whatever a URL names.
pub(crate) fn command(dir: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("git");
    for name in REPOSITORY_VARIABLES {
        command.env_remove(name);
    }
    command
        .args(["-c", "protocol.ext.allow=never"])
        .current_dir(dir);
    command
}

/// Runs git as a program, with what the caller passes as arguments alone
/// and never as a line for a shell.
fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = command(dir)
        .args(args)
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git is not installed".to_string(),
            _ => format!("could not run git: {e}"),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr
            .lines()
            .last()
            .unwrap_or("git failed")
            .trim()
            .to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The commit the folder's branch is on, none before its first commit.
pub fn head(dir: &Path) -> Option<String> {
    run(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .ok()
        .filter(|hash| !hash.is_empty())
}

/// The newest commit both commits come from, as the folder's repository
/// knows them; none when either is not in it or they share no history.
pub fn merge_base(dir: &Path, one: &str, other: &str) -> Option<String> {
    run(dir, &["merge-base", "--end-of-options", one, other])
        .ok()
        .filter(|hash| !hash.is_empty())
}

/// The hash of the tree the checkout the folder is in holds now: its
/// committed files with every change on top, staged or not, and the files
/// git does not track yet, leaving out what it ignores. The same files give
/// the same hash on any branch and after any rebase. It is made in a copy
/// of the checkout's index, so the index, the branch and the stashes are
/// left as they were and a file the index knows unchanged is not read
/// again; the copy keeps the index's time, so a file git cannot know
/// unchanged from its stat data is read. In the copy, a file marked
/// unchanged is read anyway, and so is one marked to be skipped when it is
/// there; one a sparse checkout left out stays as committed. The objects it writes are git's to clear away.
/// A file monitor or an untracked cache the folder is set up with is not
/// asked.
pub fn tree_hash(dir: &Path) -> Result<String, String> {
    let git_dir = run(dir, &["rev-parse", "--absolute-git-dir"])?;
    let top = PathBuf::from(run(dir, &["rev-parse", "--show-toplevel"])?);
    let index = Path::new(&git_dir).join(format!("chord-index-{}", uuid::Uuid::new_v4()));
    let in_index = |args: &[&str]| -> Result<String, String> {
        let output = command(&top)
            .env("GIT_INDEX_FILE", &index)
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
            ])
            .args(args)
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr
                .lines()
                .last()
                .unwrap_or("git failed")
                .trim()
                .to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let made = (|| {
        if copy_index(&Path::new(&git_dir).join("index"), &index).is_err() {
            let _ = std::fs::remove_file(&index);
            if head(dir).is_some() {
                in_index(&["read-tree", "HEAD"])?;
            }
        }
        let listed = in_index(&["ls-files", "-v", "-z"])?;
        let (mut unchanged, mut skipped) = (Vec::new(), Vec::new());
        for entry in listed.split('\0') {
            let Some((tag, path)) = entry.split_at_checked(2) else {
                continue;
            };
            if tag.starts_with(|c: char| c.is_ascii_lowercase()) {
                unchanged.push(path);
            }
            if tag.eq_ignore_ascii_case("s ") && top.join(path).exists() {
                skipped.push(path);
            }
        }
        for (flag, paths) in [
            ("--no-assume-unchanged", unchanged),
            ("--no-skip-worktree", skipped),
        ] {
            if !paths.is_empty() {
                in_index(&[&["update-index", flag, "--"], paths.as_slice()].concat())?;
            }
        }
        in_index(&["add", "--all"])?;
        in_index(&["write-tree"])
    })();
    let _ = std::fs::remove_file(&index);
    let _ = std::fs::remove_file(index.with_extension("lock"));
    made
}

/// Copies an index with its modification time. Git trusts an entry's stat
/// data only when the file was not changed in or after the second the index
/// was written, and reads the rest again; with the original's time the copy
/// trusts the same entries the original does, and a file rewritten at the
/// same size in that second is still read.
fn copy_index(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut source = std::fs::File::open(from)?;
    let modified = source.metadata()?.modified()?;
    let mut copy = std::fs::File::create_new(to)?;
    std::io::copy(&mut source, &mut copy)?;
    copy.set_modified(modified)
}

/// The tree of the commit the folder's branch is on, none before its first
/// commit.
pub fn head_tree(dir: &Path) -> Option<String> {
    run(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"])
        .ok()
        .filter(|hash| !hash.is_empty())
}

/// Whether the folder's repository still holds a tree, such as one
/// [`tree_hash`] wrote, which git may clear away once nothing refers to it.
pub fn has_tree(dir: &Path, tree: &str) -> bool {
    !tree.is_empty()
        && tree.chars().all(|c| c.is_ascii_hexdigit())
        && run(dir, &["cat-file", "-e", &format!("{tree}^{{tree}}")]).is_ok()
}

/// Where the folder is in its repository, from the top, ending in `/`;
/// empty at the top.
pub fn prefix(dir: &Path) -> Result<String, String> {
    run(dir, &["rev-parse", "--show-prefix"])
}

/// The paths that differ between a commit and a tree, measured from the
/// folder `from` names in the repository, as [`prefix`] gives it: a path
/// outside it begins with `../`, and a renamed file is named by both its
/// names. With no commit, every path of the tree.
pub fn changed_paths(
    dir: &Path,
    from: &str,
    since: Option<&str>,
    tree: &str,
) -> Result<Vec<String>, String> {
    let listed = match since {
        Some(commit) => run(
            dir,
            &[
                "diff",
                "--name-only",
                "--no-renames",
                "-z",
                "--end-of-options",
                commit,
                tree,
            ],
        )?,
        None => run(
            dir,
            &[
                "ls-tree",
                "-r",
                "--name-only",
                "--full-tree",
                "-z",
                "--end-of-options",
                tree,
            ],
        )?,
    };
    let from: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    Ok(listed
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            let parts: Vec<&str> = path.split('/').collect();
            let shared = from
                .iter()
                .zip(&parts)
                .take_while(|(a, b)| a == b)
                .count()
                .min(parts.len() - 1);
            let mut measured = "../".repeat(from.len() - shared);
            measured.push_str(&parts[shared..].join("/"));
            measured
        })
        .collect())
}

/// Where the lines of a file as a base has it stand in the file as the
/// start has it.
enum Placed {
    /// The base has the file as the start does.
    Same,
    /// The base's file differs from the start's by these runs of lines,
    /// each the lines of the start's it takes the place of and the lines of
    /// the base's that stand there, as the count of lines before the run
    /// and the count up to its end.
    Through(Vec<[u64; 4]>),
    /// The start has no such file to place the base's lines in.
    Apart,
}

impl Placed {
    /// How the file a change is made to stands against the start's: the
    /// file at `path` with the contents `id` in the base.
    fn of(
        repo: &Repository,
        start: Option<&git2::Tree>,
        path: &[u8],
        id: git2::Oid,
    ) -> Result<Placed, git2::Error> {
        let Some(start) = start else {
            return Ok(Placed::Same);
        };
        let was = std::str::from_utf8(path)
            .ok()
            .and_then(|path| start.get_path(Path::new(path)).ok())
            .filter(|entry| entry.kind() == Some(git2::ObjectType::Blob));
        let Some(was) = was else {
            return Ok(if id.is_zero() {
                Placed::Same
            } else {
                Placed::Apart
            });
        };
        if was.id() == id {
            return Ok(Placed::Same);
        }
        if id.is_zero() {
            return Ok(Placed::Apart);
        }
        let (old, new) = (repo.find_blob(was.id())?, repo.find_blob(id)?);
        let mut options = DiffOptions::new();
        options
            .context_lines(0)
            .interhunk_lines(0)
            .indent_heuristic(false);
        let patch = git2::Patch::from_blobs(&old, None, &new, None, Some(&mut options))?;
        if patch.delta().flags().is_binary() {
            return Ok(Placed::Apart);
        }
        let mut runs = Vec::new();
        for at in 0..patch.num_hunks() {
            let (hunk, _) = patch.hunk(at)?;
            let (before, to) = span(hunk.old_start(), hunk.old_lines());
            let (after, end) = span(hunk.new_start(), hunk.new_lines());
            runs.push([before, to, after, end]);
        }
        Ok(Placed::Through(runs))
    }

    /// Where the base's line `line`, counted from none, stands in the
    /// start's file: by its count there, or for a line the base brought,
    /// by the place in the start's file its run stands at and its count in
    /// that run. The first byte says which.
    fn line(&self, line: u64) -> Vec<u8> {
        let (kind, at, within) = match self {
            Placed::Same => (0u8, line, 0),
            Placed::Apart => (2, line, 0),
            Placed::Through(runs) => {
                let mut found = None;
                let mut shift = 0i128;
                for [_, to, after, end] in runs {
                    if line < *after {
                        break;
                    }
                    if line < *end {
                        found = Some((1, *to, line - after));
                        break;
                    }
                    shift = i128::from(*to) - i128::from(*end);
                }
                found.unwrap_or((0, (i128::from(line) + shift) as u64, 0))
            }
        };
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&at.to_be_bytes());
        bytes.extend_from_slice(&within.to_be_bytes());
        bytes
    }

    /// Where the place after the base's first `lines` lines stands in the
    /// start's file: after as many of its lines. A place among or right
    /// after lines the base brought is the place after the start's lines
    /// they stand for. The first byte says whether the start has the file.
    fn gap(&self, lines: u64) -> Vec<u8> {
        let (kind, at) = match self {
            Placed::Same => (0u8, lines),
            Placed::Apart => (2, lines),
            Placed::Through(runs) => {
                let mut found = None;
                let mut shift = 0i128;
                for [_, to, after, end] in runs {
                    if lines <= *after {
                        break;
                    }
                    if lines <= *end {
                        found = Some(*to);
                        break;
                    }
                    shift = i128::from(*to) - i128::from(*end);
                }
                (0, found.unwrap_or((i128::from(lines) + shift) as u64))
            }
        };
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&at.to_be_bytes());
        bytes
    }
}

/// A run of lines a hunk names by its first line and its count, as the
/// count of lines before it and the count up to its end. A run of no lines
/// is named by the line it follows.
fn span(first: u32, count: u32) -> (u64, u64) {
    let (first, count) = (u64::from(first), u64::from(count));
    match count {
        0 => (first, first),
        _ => (first.saturating_sub(1), first.saturating_sub(1) + count),
    }
}

/// The byte a kind of difference is hashed as, which stays as it is
/// whatever order libgit2 lists the kinds in.
fn status_byte(status: git2::Delta) -> Result<u8, String> {
    Ok(match status {
        git2::Delta::Added => b'A',
        git2::Delta::Deleted => b'D',
        git2::Delta::Modified => b'M',
        git2::Delta::Renamed => b'R',
        git2::Delta::Copied => b'C',
        git2::Delta::Typechange => b'T',
        other => return Err(format!("a difference of an unknown kind: {other:?}")),
    })
}

/// The changes hashed, by the commits and the tree they were hashed for.
/// Each of the three names its contents, so a hash kept here stays true.
static HASHED: std::sync::Mutex<Option<HashMap<[String; 3], String>>> = std::sync::Mutex::new(None);

/// How many hashes are kept before they are all let go.
const HASHED_KEPT: usize = 512;

/// The hash of the change from the commit `since` to a tree, for work that
/// began at the commit `start`: for each path that differs, its old and new
/// names, its old and new modes, whether it was added, deleted, renamed or
/// changed, and each run of lines taken out and put in, with no lines
/// around it; for a binary file or a submodule, its old and new contents'
/// ids. A renamed file is found by its contents, and its lines are the ones
/// that differ from its old name. A run is placed in the file as `start`
/// has it: lines taken out by the line of that file they begin at, lines
/// put in by the line of that file they follow, each found through the
/// lines that differ between `start` and `since`. So the same lines taken
/// out of and put into the same places of the same files read as the same
/// change on any commit they are put on, whatever that commit brought
/// around them. Lines put in among lines `since` brought, or right after
/// them, stand after the lines of `start` those stand for, whichever of
/// them they follow. With no `since`, every file of the tree is added;
/// with no `start`, it is `since`. Only the files that differ are read.
pub fn change_hash(
    dir: &Path,
    start: Option<&str>,
    since: Option<&str>,
    tree: &str,
) -> Result<String, String> {
    let whole = |text: &str| text.len() >= 40 && git2::Oid::from_str(text).is_ok();
    let key = match (start.or(since), since) {
        (Some(start), Some(since)) if whole(start) && whole(since) && whole(tree) => {
            Some([start.to_string(), since.to_string(), tree.to_string()])
        }
        _ => None,
    };
    if let Some(key) = &key {
        let kept = HASHED.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hash) = kept.as_ref().and_then(|kept| kept.get(key)) {
            return Ok(hash.clone());
        }
    }
    let hash = change_hashed(dir, start, since, tree)?;
    if let Some(key) = key {
        let mut kept = HASHED.lock().unwrap_or_else(|e| e.into_inner());
        let kept = kept.get_or_insert_with(HashMap::new);
        if kept.len() >= HASHED_KEPT {
            kept.clear();
        }
        kept.insert(key, hash.clone());
    }
    Ok(hash)
}

fn change_hashed(
    dir: &Path,
    start: Option<&str>,
    since: Option<&str>,
    tree: &str,
) -> Result<String, String> {
    let repo = open(dir)?;
    let failed = |e: git2::Error| e.message().to_string();
    let new = repo
        .find_tree(git2::Oid::from_str(tree).map_err(failed)?)
        .map_err(failed)?;
    let tree_of = |commit: &str| {
        repo.revparse_single(commit)
            .and_then(|object| object.peel_to_tree())
            .map_err(failed)
    };
    let old = since.map(tree_of).transpose()?;
    let began = match (start, &old) {
        (Some(start), Some(old)) => Some(tree_of(start)?).filter(|began| began.id() != old.id()),
        _ => None,
    };
    let mut options = DiffOptions::new();
    options
        .context_lines(0)
        .interhunk_lines(0)
        .indent_heuristic(false)
        .ignore_submodules(false);
    let mut diff = repo
        .diff_tree_to_tree(old.as_ref(), Some(&new), Some(&mut options))
        .map_err(failed)?;
    let mut similar = git2::DiffFindOptions::new();
    similar.renames(true).copies(false);
    diff.find_similar(Some(&mut similar)).map_err(failed)?;

    let mut records: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = Vec::new();
    for at in 0..diff.deltas().len() {
        let patch = git2::Patch::from_diff(&diff, at)
            .map_err(failed)?
            .ok_or("a file that differs has no lines to read")?;
        let delta = patch.delta();
        let name = |file: &git2::DiffFile| file.path_bytes().unwrap_or_default().to_vec();
        let (old_file, new_file) = (delta.old_file(), delta.new_file());
        let mut record = Vec::new();
        let mut field = |bytes: &[u8]| {
            record.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
            record.extend_from_slice(bytes);
        };
        field(&[status_byte(delta.status())?]);
        field(&name(&old_file));
        field(&name(&new_file));
        field(&u32::from(old_file.mode()).to_be_bytes());
        field(&u32::from(new_file.mode()).to_be_bytes());
        let opaque = delta.flags().is_binary()
            || old_file.mode() == git2::FileMode::Commit
            || new_file.mode() == git2::FileMode::Commit;
        if opaque {
            field(old_file.id().as_bytes());
            field(new_file.id().as_bytes());
        } else {
            let placed = Placed::of(&repo, began.as_ref(), &name(&old_file), old_file.id())
                .map_err(failed)?;
            for hunk in 0..patch.num_hunks() {
                let (header, lines) = patch.hunk(hunk).map_err(failed)?;
                let (before, _) = span(header.old_start(), header.old_lines());
                let (mut out, mut put, mut ends) = (Vec::new(), Vec::new(), Vec::new());
                for at in 0..lines {
                    let line = patch.line_in_hunk(hunk, at).map_err(failed)?;
                    let into = match line.origin() {
                        '-' => &mut out,
                        '+' => &mut put,
                        '<' | '>' | '=' => &mut ends,
                        _ => continue,
                    };
                    into.push(line.origin() as u8);
                    into.extend_from_slice(&(line.content().len() as u64).to_be_bytes());
                    into.extend_from_slice(line.content());
                }
                if header.old_lines() > 0 {
                    field(&placed.line(before));
                } else {
                    field(&[]);
                }
                field(&out);
                if header.new_lines() > 0 {
                    field(&placed.gap(before));
                } else {
                    field(&[]);
                }
                field(&put);
                field(&ends);
            }
        }
        records.push((name(&new_file), name(&old_file), record));
    }
    records.sort();
    let mut all = Vec::new();
    for (_, _, record) in records {
        all.extend_from_slice(&(record.len() as u64).to_be_bytes());
        all.extend(record);
    }
    git2::Oid::hash_object(git2::ObjectType::Blob, &all)
        .map(|oid| oid.to_string())
        .map_err(failed)
}

/// Whether a remote's address is a path: a `file://` address, or one
/// that names neither a scheme nor a host, as `host:path` does.
fn is_local_address(url: &str) -> bool {
    if url.starts_with("file://") {
        return true;
    }
    if url.contains("://") {
        return false;
    }
    match url.split_once(':') {
        Some((host, _)) => host.contains('/') || host.len() < 2,
        None => true,
    }
}

/// The remote a folder's base follows: the one `remote.pushDefault`
/// names, else `origin`, when its address is not a path. The remote a
/// branch tracks is never followed: a branch made from another remote's
/// branch tracks that remote with nothing said, and its default branch is
/// not where the work is pushed.
fn followed_remote(repo: &Repository) -> Option<String> {
    let name = repo
        .config()
        .ok()?
        .get_string("remote.pushDefault")
        .unwrap_or_else(|_| "origin".to_string());
    let remote = repo.find_remote(&name).ok()?;
    let followed = !is_local_address(remote.url().ok()?);
    followed.then_some(name)
}

/// The commit the change in the folder counts from, given the one it
/// began at: the newest commit the folder's branch shares with the default
/// branch of the remote it follows, as the folder last fetched it, when
/// that commit is the one it began at or comes after it, so a rebase on
/// that branch moves it there; otherwise the one it began at. One remote
/// is followed and no other: the one `remote.pushDefault` names, else
/// `origin`, and only when its address is not a path, since a fetch from
/// a repository at a path takes whatever branch is checked out there for
/// the default one. The remote's
/// default branch is the one its `HEAD` names, or else its `main` or
/// `master`. The folder's own branches, local `main` among them, never move
/// it, so committing work or merging it into a local branch does not take
/// it out of the change.
pub fn moved_base(dir: &Path, start: Option<&str>) -> Option<String> {
    let start_text = start?;
    let moved = (|| -> Option<String> {
        let repo = open(dir).ok()?;
        let start = git2::Oid::from_str(start_text).ok()?;
        let head = repo.head().ok()?.peel_to_commit().ok()?.id();
        let remote = followed_remote(&repo)?;
        let tip = ["HEAD", "main", "master"].iter().find_map(|name| {
            repo.find_reference(&format!("refs/remotes/{remote}/{name}"))
                .ok()?
                .resolve()
                .ok()?
                .peel_to_commit()
                .ok()
                .map(|commit| commit.id())
        })?;
        let base = repo.merge_base(head, tip).ok()?;
        (base == start || repo.graph_descendant_of(base, start).unwrap_or(false))
            .then(|| base.to_string())
    })();
    Some(moved.unwrap_or_else(|| start_text.to_string()))
}

/// Adds a worktree of the project under `.claude/worktrees`, on a new
/// branch of the same name, and says where it is, absolute. The name is a
/// plain identifier, and a worktree that is already there is left alone.
/// The name itself when nothing has it, else the first of `name-2`,
/// `name-3` and so on that is free, as a path and as a branch.
fn free_worktree_name(project: &Path, name: &str) -> Result<String, String> {
    let taken = |candidate: &str| {
        project.join(WORKTREES).join(candidate).exists()
            || run(
                project,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    &format!("refs/heads/{candidate}"),
                ],
            )
            .is_ok()
    };
    if !taken(name) {
        return Ok(name.to_string());
    }
    (2..100)
        .map(|n| format!("{name}-{n}"))
        .find(|candidate| !taken(candidate))
        .ok_or_else(|| format!("a hundred worktrees are named after {name} already"))
}

pub fn worktree_add(project: &Path, name: &str) -> Result<String, String> {
    if !plain_worktree_name(name) {
        return Err(format!(
            "{name:?} is not a name for a worktree: letters, digits, dashes and underscores"
        ));
    }
    // Without a repository there is nothing to add a worktree to.
    open(project)?;
    // The name is a wish: a worktree of that name already there, from an
    // earlier run of the same work, makes this one the next number up.
    let name = free_worktree_name(project, name)?;
    let path = project.join(WORKTREES).join(&name);
    let target = path.to_string_lossy().to_string();
    run(project, &["worktree", "add", "-b", &name, "--", &target])?;
    Ok(dunce::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Where it is, absolute.
    pub path: String,
    /// Its directory's name, which is also its branch's.
    pub name: String,
    /// The branch it is on, short, and empty for a tree on no branch.
    pub branch: String,
    /// True when the branch holds nothing the project's own checkout does
    /// not, so taking the tree away loses no work.
    pub merged: bool,
    /// True when something in the tree is uncommitted.
    pub dirty: bool,
}

/// The path as the window would name it, and the path itself when it
/// cannot be resolved, which is what adding a worktree answers with.
fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the project's checked-out HEAD already has everything the
/// reference does. A reference the project no longer knows holds nothing,
/// so it counts as merged.
fn merged_into_head(project: &Path, reference: &str) -> bool {
    let known = run(
        project,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            reference,
        ],
    )
    .is_ok();
    !known
        || run(
            project,
            &[
                "merge-base",
                "--is-ancestor",
                "--end-of-options",
                reference,
                "HEAD",
            ],
        )
        .is_ok()
}

/// A worktree as git lists it: its path, the commit it has checked out and
/// the branch it is on.
type Listed = (PathBuf, Option<String>, Option<String>);

/// The worktrees git knows of whose path is under the project's
/// `.claude/worktrees`, each with its path resolved.
fn made_worktrees(project: &Path) -> Result<Vec<Listed>, String> {
    // Without a repository there are no worktrees, and saying so beats
    // whatever git makes of a directory that is not there.
    open(project)?;
    // Nothing here is a caller's string: the listing takes no path, so
    // there is no positional argument for one to reach.
    let listed = run(project, &["worktree", "list", "--porcelain"])?;

    // One entry per `worktree` line, the lines under it belonging to it.
    let mut entries: Vec<Listed> = Vec::new();
    for line in listed.lines() {
        let line = line.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            entries.push((PathBuf::from(path), None, None));
            continue;
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.1 = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            entry.2 = Some(branch.to_string());
        }
    }

    let base = canonical(&project.join(WORKTREES));
    Ok(entries
        .into_iter()
        .map(|(path, head, branch)| (canonical(&path), head, branch))
        .filter(|(path, _, _)| path.starts_with(&base))
        .collect())
}

/// Where each of the worktrees the workbench has made for the project is,
/// resolved, and nothing else about them.
pub fn worktree_paths(project: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(made_worktrees(project)?
        .into_iter()
        .map(|(path, _, _)| path)
        .collect())
}

/// The worktrees the workbench has made for the project: those git knows
/// about whose path is under `.claude/worktrees`, with enough about each
/// to say whether it can go. A worktree the user made elsewhere is theirs
/// and is not listed.
pub fn worktrees(project: &Path) -> Result<Vec<Worktree>, String> {
    let mut trees: Vec<Worktree> = Vec::new();
    for (path, head, reference) in made_worktrees(project)? {
        let Some(name) = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        // What the tree holds is its branch, or the commit it has checked
        // out when it is on no branch.
        let reference = reference.or(head).unwrap_or_default();
        trees.push(Worktree {
            merged: reference.is_empty() || merged_into_head(project, &reference),
            // A status that cannot be read lists nothing. Git itself
            // refuses to remove a tree with work in it, so the removal is
            // guarded either way.
            dirty: status(&path)
                .map(|files| !files.is_empty())
                .unwrap_or(false),
            path: path.to_string_lossy().to_string(),
            name,
            branch: reference
                .strip_prefix("refs/heads/")
                .unwrap_or_default()
                .to_string(),
        });
    }
    trees.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(trees)
}

/// Takes a worktree of the project away, and the branch it was on with it.
/// Only one of the project's own, and only when what is in it is safe to
/// lose: work not committed, or committed and not in the project, is work
/// the user has nowhere else.
pub fn worktree_remove(project: &Path, name: &str) -> Result<(), String> {
    if !plain_worktree_name(name) {
        return Err(format!(
            "{name:?} is not a name for a worktree: letters, digits, dashes and underscores"
        ));
    }
    let tree = worktrees(project)?
        .into_iter()
        .find(|tree| tree.name == name)
        .ok_or_else(|| format!("{name} is not a worktree of this project"))?;
    if tree.dirty {
        return Err(format!("{name} has uncommitted work"));
    }
    if !tree.merged {
        return Err(format!("{name} has commits the project does not"));
    }

    run(project, &["worktree", "remove", "--", &tree.path])?;
    // The tree is gone by here, which is what the call is for. A branch
    // that will not delete is left standing rather than reported as a
    // removal that did not happen.
    if !tree.branch.is_empty() {
        let _ = run(project, &["branch", "-d", "--", &tree.branch]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;
    use std::io::Write as _;
    use std::process::Command;

    /// A throwaway repository. Shelling out to git rather than building one
    /// through the API keeps the fixtures readable and matches what a user's
    /// tree actually looks like.
    fn repo(name: &str) -> Scratch {
        let dir = Scratch::new(&format!("git-{name}"));

        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git should be installed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
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

    #[test]
    fn a_clean_tree_has_nothing_to_show() {
        let dir = repo("clean");
        write(&dir, "a.txt", "one\n");
        commit(&dir);

        assert!(status(&dir).unwrap().is_empty());
    }

    #[test]
    fn reports_a_modified_file_with_its_line_counts() {
        let dir = repo("modified");
        write(&dir, "a.txt", "one\ntwo\nthree\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\nthree\nfour\n");

        let files = status(&dir).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].add, 2, "the changed line and the new one");
        assert_eq!(files[0].del, 1);
    }

    #[test]
    fn reports_an_untracked_file_as_added() {
        let dir = repo("untracked");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        write(&dir, "new.txt", "fresh\n");

        let files = status(&dir).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].status, "A");
    }

    #[test]
    fn counts_untracked_files_as_libgit2_diffs_them() {
        let dir = repo("untracked-counts");
        write(&dir, ".gitattributes", "*.dat binary\n*.dt diff\n");
        commit(&dir);
        write(&dir, "ends.txt", "one\ntwo\n");
        write(&dir, "open.txt", "one\ntwo");
        write(&dir, "empty.txt", "");
        write(&dir, "blank.txt", "\n\n\n");
        write(&dir, "marked.dat", "text, but marked binary\n");
        write(&dir, "deep/er/nested.md", "# a\n\nb\n");
        let mut late = vec![b'x'; BINARY_PROBE + 10];
        late.push(0);
        std::fs::write(dir.join("late-nul.txt"), &late).unwrap();
        std::fs::write(
            dir.join("shot.png"),
            [0x89, b'P', b'N', b'G', 0, 1, 2, b'\n'],
        )
        .unwrap();
        write(&dir, "forced.dt", "a\0b\nc\n");
        // Windows allows no `*` or `?` in a file's name.
        let glob = if cfg!(windows) {
            "a[1].txt"
        } else {
            "a[1]*?.txt"
        };
        write(&dir, glob, "glob\ncharacters\n");
        // Text to well past the probe, then sparse to just over the size
        // libgit2 reads.
        let large = std::fs::File::create(dir.join("large.log")).unwrap();
        (&large)
            .write_all(&b"line\n".repeat(4 * BINARY_PROBE))
            .unwrap();
        large.set_len(MAX_TEXT + 1).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("ends.txt", dir.join("link")).unwrap();
        let expected = if cfg!(unix) { 12 } else { 11 };

        let files = status(&dir).unwrap();
        let repo = Repository::open(&*dir).unwrap();
        let libgit2 = line_counts(&repo, files.iter().map(|file| file.path.as_str()));
        assert_eq!(files.len(), expected);
        for file in &files {
            assert_eq!(file.status, "A", "{}", file.path);
            let (add, del, binary) = libgit2.get(&file.path).copied().unwrap_or_default();
            assert_eq!(
                (file.add, file.del, file.binary),
                (add, del, binary),
                "{}",
                file.path
            );
        }
    }

    /// Reads from an endless stream and keeps count of what it handed out.
    struct Counted<R> {
        inner: R,
        read: usize,
    }

    impl<R: Read> Read for Counted<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buf)?;
            self.read += read;
            Ok(read)
        }
    }

    #[test]
    fn reads_no_further_into_a_binary_file_than_it_takes_to_call_it_binary() {
        let mut stream = Counted {
            inner: std::io::repeat(0).take(1 << 30),
            read: 0,
        };

        assert_eq!(added_lines(&mut stream, true), None);
        assert!(stream.read <= BINARY_PROBE, "read {} bytes", stream.read);
    }

    #[test]
    fn reports_a_deleted_file() {
        let dir = repo("deleted");
        write(&dir, "gone.txt", "bye\n");
        commit(&dir);
        std::fs::remove_file(dir.join("gone.txt")).unwrap();

        let files = status(&dir).unwrap();
        assert_eq!(files[0].status, "D");
    }

    #[test]
    fn respects_gitignore() {
        let dir = repo("ignored");
        write(&dir, ".gitignore", "secret.txt\n");
        commit(&dir);
        write(&dir, "secret.txt", "shh\n");

        assert!(status(&dir).unwrap().iter().all(|f| f.path != "secret.txt"));
        assert!(list_files(&dir).unwrap().iter().all(|p| p != "secret.txt"));
    }

    #[test]
    fn sorts_by_path_so_the_tree_is_stable() {
        let dir = repo("sorted");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        write(&dir, "z.txt", "z\n");
        write(&dir, "b.txt", "b\n");

        let paths: Vec<String> = status(&dir).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec!["b.txt", "z.txt"]);
    }

    #[test]
    fn produces_a_readable_diff() {
        let dir = repo("diff");
        write(&dir, "a.txt", "one\ntwo\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\n");

        let result = diff(&dir, "a.txt").unwrap();
        assert!(!result.binary);
        assert!(result.lines.iter().any(|l| l.kind == "hunk"));

        let added: Vec<&DiffLine> = result.lines.iter().filter(|l| l.kind == "add").collect();
        let removed: Vec<&DiffLine> = result.lines.iter().filter(|l| l.kind == "del").collect();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].text, "TWO");
        assert_eq!(removed[0].text, "two");
    }

    #[test]
    fn diff_lines_carry_both_line_numbers() {
        let dir = repo("linenos");
        write(&dir, "a.txt", "one\ntwo\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\n");

        let result = diff(&dir, "a.txt").unwrap();
        let context = result.lines.iter().find(|l| l.kind == "ctx").unwrap();
        assert_eq!(context.old, Some(1));
        assert_eq!(context.new, Some(1));

        let added = result.lines.iter().find(|l| l.kind == "add").unwrap();
        assert_eq!(added.old, None, "an addition has no old line");
        assert_eq!(added.new, Some(2));
    }

    #[test]
    fn diffs_an_untracked_file_as_all_additions() {
        let dir = repo("newdiff");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        write(&dir, "new.txt", "alpha\nbeta\n");

        let result = diff(&dir, "new.txt").unwrap();
        assert!(result.lines.iter().filter(|l| l.kind == "add").count() >= 2);
        assert!(result.lines.iter().all(|l| l.kind != "del"));
    }

    #[test]
    fn calls_a_binary_file_binary_rather_than_rendering_it() {
        let dir = repo("binary");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3]).unwrap();

        assert!(content(&dir, "blob.bin").unwrap().binary);
    }

    #[test]
    fn refuses_to_read_outside_the_worktree() {
        let dir = repo("escape");
        write(&dir, "a.txt", "x\n");
        commit(&dir);

        assert!(content(&dir, "../etc/passwd").is_err());
        assert!(content(&dir, "/etc/passwd").is_err());
        assert!(content(&dir, "src/../../a.txt").is_err());
        assert!(content(&dir, "").is_err());
        assert!(content(&dir, "./a.txt").is_ok());
    }

    #[test]
    fn counts_lines_for_several_files_at_once() {
        let dir = repo("several");
        write(&dir, "a.txt", "one\n");
        write(&dir, "b.txt", "one\ntwo\n");
        commit(&dir);
        write(&dir, "a.txt", "one\ntwo\nthree\n");
        write(&dir, "b.txt", "one\n");
        write(&dir, "c.txt", "fresh\n");

        let files = status(&dir).unwrap();
        let find = |name: &str| files.iter().find(|f| f.path == name).unwrap();
        assert_eq!((find("a.txt").add, find("a.txt").del), (2, 0));
        assert_eq!((find("b.txt").add, find("b.txt").del), (0, 1));
        assert_eq!((find("c.txt").add, find("c.txt").del), (1, 0));
    }

    #[test]
    fn reads_file_content() {
        let dir = repo("content");
        write(&dir, "a.txt", "one\ntwo\nthree\n");
        commit(&dir);

        let result = content(&dir, "a.txt").unwrap();
        assert_eq!(result.lines, vec!["one", "two", "three"]);
        assert!(!result.truncated);
    }

    #[test]
    fn truncates_a_very_long_file_rather_than_crawling() {
        let dir = repo("long");
        let body: String = (0..MAX_CONTENT_LINES + 500)
            .map(|i| format!("line {i}\n"))
            .collect();
        write(&dir, "long.txt", &body);
        commit(&dir);

        let result = content(&dir, "long.txt").unwrap();
        assert_eq!(result.lines.len(), MAX_CONTENT_LINES);
        assert!(result.truncated);
    }

    #[test]
    fn lists_tracked_and_untracked_files_together() {
        let dir = repo("listing");
        write(&dir, "src/a.rs", "x\n");
        commit(&dir);
        write(&dir, "src/b.rs", "y\n");

        let files = list_files(&dir).unwrap();
        assert!(files.contains(&"src/a.rs".to_string()));
        assert!(files.contains(&"src/b.rs".to_string()));
    }

    #[test]
    fn works_from_a_subdirectory_of_the_repository() {
        let dir = repo("subdir");
        write(&dir, "src/deep/a.txt", "one\n");
        commit(&dir);
        write(&dir, "src/deep/a.txt", "two\n");

        // Paths stay relative to the worktree root, not to where you looked.
        let files = status(&dir.join("src/deep")).unwrap();
        assert_eq!(files[0].path, "src/deep/a.txt");
    }

    // A worktree under the project is a repository of its own, which git
    // reports as one directory rather than the files inside it. A directory
    // is not something the pane can show, so it is not a change.
    #[test]
    fn a_worktree_under_the_project_is_not_a_changed_file() {
        let dir = repo("worktree-status");
        write(&dir, "a.txt", "one\n");
        commit(&dir);

        let tree = worktree_add(&dir, "feature").unwrap();
        write(Path::new(&tree), "b.txt", "two\n");

        assert!(status(&dir).unwrap().is_empty(), "{:?}", status(&dir));
        assert!(!list_files(&dir)
            .unwrap()
            .iter()
            .any(|path| path.contains("worktrees")));

        // The worktree's own changes are its own to show.
        let inside = status(Path::new(&tree)).unwrap();
        assert_eq!(inside.len(), 1);
        assert_eq!(inside[0].path, "b.txt");
    }

    #[test]
    fn says_plainly_when_there_is_no_repository() {
        let dir = Scratch::new("git-none");
        // A temp directory can sit inside someone's repository, so only assert
        // on the error when discovery genuinely finds nothing.
        if let Err(message) = status(&dir) {
            assert!(message.contains("not a git repository"), "{message}");
        }
    }

    #[test]
    fn finds_lines_by_text_across_tracked_and_untracked_files() {
        let dir = repo("grep");
        write(&dir, "src/lib.rs", "fn handle_client() {}\nfn other() {}\n");
        commit(&dir);
        write(&dir, "notes.md", "call handle_client twice\n");
        write(&dir, "image.bin", "\0\0handle_client\0");

        let found = grep(&dir, "Handle_Client", None).unwrap();
        assert!(!found.truncated);
        let mut where_: Vec<(String, u32)> = found
            .hits
            .iter()
            .map(|h| (h.path.clone(), h.line))
            .collect();
        where_.sort();
        assert_eq!(
            where_,
            [("notes.md".to_string(), 1), ("src/lib.rs".to_string(), 1)]
        );
        assert_eq!(
            found
                .hits
                .iter()
                .find(|h| h.path == "src/lib.rs")
                .unwrap()
                .text,
            "fn handle_client() {}"
        );
    }

    #[test]
    fn narrows_to_the_given_files() {
        let dir = repo("grep-scope");
        write(&dir, "a.rs", "needle\n");
        write(&dir, "b.rs", "needle\n");
        commit(&dir);
        let found = grep(&dir, "needle", Some(&["b.rs".to_string()])).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].path, "b.rs");
        assert!(grep(&dir, "needle", Some(&[])).unwrap().hits.is_empty());
    }

    #[test]
    fn nothing_matched_is_an_empty_list_not_an_error() {
        let dir = repo("grep-none");
        write(&dir, "a.rs", "fn main() {}\n");
        commit(&dir);
        assert!(grep(&dir, "zzz-not-here", None).unwrap().hits.is_empty());
        assert!(grep(&dir, "   ", None).unwrap().hits.is_empty());
    }

    #[test]
    fn adds_a_worktree_under_the_project_on_a_branch_of_its_own() {
        let dir = repo("worktree");
        write(&dir, "a.txt", "one\n");
        commit(&dir);

        let path = worktree_add(&dir, "review-42").unwrap();
        assert!(path
            .replace('\\', "/")
            .ends_with(".claude/worktrees/review-42"));
        assert!(Path::new(&path).is_absolute());
        assert!(Path::new(&path).join("a.txt").is_file());
        let branches = Command::new("git")
            .args(["branch", "--list", "review-42"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).contains("review-42"));

        // The same name again is the next number up, as a path and a branch.
        let again = worktree_add(&dir, "review-42").unwrap();
        assert!(
            again
                .replace('\\', "/")
                .ends_with(".claude/worktrees/review-42-2"),
            "{again}"
        );
        let third = worktree_add(&dir, "review-42").unwrap();
        assert!(third.ends_with("review-42-3"), "{third}");
    }

    #[test]
    fn a_made_worktree_names_the_branch_it_was_made_on() {
        let dir = repo("made-branch");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        let path = worktree_add(&dir, "fix-login").unwrap();
        assert_eq!(
            made_branch(&dir, Path::new(&path)).as_deref(),
            Some("fix-login")
        );
        let again = worktree_add(&dir, "fix-login").unwrap();
        assert_eq!(
            made_branch(&dir, Path::new(&again)).as_deref(),
            Some("fix-login-2")
        );
        // The project itself, a folder inside a worktree and one that is
        // not there name no branch.
        assert_eq!(made_branch(&dir, &dir), None);
        std::fs::create_dir_all(Path::new(&path).join("src")).unwrap();
        assert_eq!(made_branch(&dir, &Path::new(&path).join("src")), None);
        assert_eq!(made_branch(&dir, &dir.join(WORKTREES).join("gone")), None);
    }

    #[test]
    fn refuses_a_worktree_name_that_is_not_a_plain_one() {
        let dir = repo("worktree-names");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        for name in ["../escape", "one/two", "-b", "", "with space", "quote\"d"] {
            let refused = worktree_add(&dir, name).unwrap_err();
            assert!(
                refused.contains("is not a name for a worktree"),
                "{name}: {refused}"
            );
        }
        assert!(!dir.join(".claude").exists());
    }

    #[test]
    fn a_directory_that_is_no_repository_says_so() {
        let dir = Scratch::new("git-worktree-bare");
        let refused = worktree_add(&dir, "review").unwrap_err();
        assert!(refused.contains("not a git repository"), "{refused}");
    }

    /// Runs git in a directory and hands back what it said, for the parts
    /// of a fixture the helpers above do not cover.
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn lists_the_worktrees_it_made_and_nothing_else() {
        let dir = repo("worktree-list");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        worktree_add(&dir, "review").unwrap();
        // One the user made somewhere else is theirs, not the workbench's.
        let elsewhere = dir.join("aside");
        git(
            &dir,
            &[
                "worktree",
                "add",
                "-b",
                "aside",
                "--",
                &elsewhere.to_string_lossy(),
            ],
        );

        let trees = worktrees(&dir).unwrap();
        assert_eq!(trees.len(), 1, "{trees:?}");
        assert_eq!(trees[0].name, "review");
        assert_eq!(trees[0].branch, "review");
        assert!(Path::new(&trees[0].path).is_absolute());
        assert!(trees[0]
            .path
            .replace('\\', "/")
            .ends_with(".claude/worktrees/review"));
        assert!(trees[0].merged, "a fresh worktree is where the project is");
        assert!(!trees[0].dirty);
    }

    #[test]
    fn a_worktree_with_commits_of_its_own_stays_until_they_are_merged() {
        let dir = repo("worktree-unmerged");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        let path = PathBuf::from(worktree_add(&dir, "work").unwrap());
        write(&path, "b.txt", "two\n");
        commit(&path);

        let trees = worktrees(&dir).unwrap();
        assert!(!trees[0].merged);
        assert!(!trees[0].dirty);
        let refused = worktree_remove(&dir, "work").unwrap_err();
        assert!(
            refused.contains("has commits the project does not"),
            "{refused}"
        );
        assert!(path.exists());

        git(&dir, &["merge", "-q", "--no-edit", "work"]);
        assert!(worktrees(&dir).unwrap()[0].merged);
        worktree_remove(&dir, "work").unwrap();
        assert!(!path.exists(), "the tree is gone");
        assert!(worktrees(&dir).unwrap().is_empty());
        let branches = git(&dir, &["branch", "--list", "work"]);
        assert!(branches.is_empty(), "the branch is gone too: {branches}");
    }

    #[test]
    fn a_worktree_with_uncommitted_work_stays() {
        let dir = repo("worktree-dirty");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        let path = PathBuf::from(worktree_add(&dir, "busy").unwrap());
        write(&path, "a.txt", "changed\n");

        let trees = worktrees(&dir).unwrap();
        assert!(trees[0].dirty);
        assert!(trees[0].merged, "it has committed nothing");
        let refused = worktree_remove(&dir, "busy").unwrap_err();
        assert!(refused.contains("has uncommitted work"), "{refused}");
        assert!(path.exists());
    }

    #[test]
    fn removes_only_a_worktree_of_the_project_under_a_plain_name() {
        let dir = repo("worktree-remove-names");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        worktree_add(&dir, "review").unwrap();

        for name in ["../escape", "one/two", "-f", ""] {
            let refused = worktree_remove(&dir, name).unwrap_err();
            assert!(
                refused.contains("is not a name for a worktree"),
                "{name}: {refused}"
            );
        }
        let missing = worktree_remove(&dir, "nothing").unwrap_err();
        assert!(
            missing.contains("is not a worktree of this project"),
            "{missing}"
        );
        assert_eq!(worktrees(&dir).unwrap().len(), 1);
    }

    #[test]
    fn cuts_a_flood_of_hits_and_says_so() {
        let dir = repo("grep-cap");
        let body: String = (0..(GREP_CAP + 20))
            .map(|i| format!("common line {i}\n"))
            .collect();
        write(&dir, "big.txt", &body);
        commit(&dir);
        let found = grep(&dir, "common", None).unwrap();
        assert_eq!(found.hits.len(), GREP_CAP);
        assert!(found.truncated);
    }

    #[test]
    fn the_tree_hash_follows_the_files_and_leaves_the_index_alone() {
        let dir = repo("tree-hash");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        let clean = tree_hash(&dir).unwrap();
        let committed = run(&dir, &["rev-parse", "HEAD^{tree}"]).unwrap();
        assert_eq!(clean, committed);

        write(&dir, "b.txt", "new\n");
        let untracked = tree_hash(&dir).unwrap();
        assert_ne!(untracked, clean);
        assert_eq!(tree_hash(&dir).unwrap(), untracked);
        // The folder's own index holds nothing of it.
        assert_eq!(run(&dir, &["diff", "--cached", "--name-only"]).unwrap(), "");
        let git_dir = dir.join(".git");
        let left: Vec<_> = std::fs::read_dir(&git_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("chord-index")
            })
            .collect();
        assert!(left.is_empty());

        // Ignored files are not part of it.
        write(&dir, ".gitignore", "out/\n");
        let ignoring = tree_hash(&dir).unwrap();
        write(&dir, "out/built.txt", "x\n");
        assert_eq!(tree_hash(&dir).unwrap(), ignoring);

        // A commit of the same files keeps the hash.
        commit(&dir);
        assert_eq!(tree_hash(&dir).unwrap(), ignoring);
    }

    /// The tree of the folder's files as an index made from nothing holds
    /// them, every file read afresh.
    fn fresh_tree(dir: &Path) -> String {
        let index = dir.join(".git").join("fresh-index");
        let in_fresh = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .env("GIT_INDEX_FILE", &index)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        in_fresh(&["add", "--all"]);
        let tree = in_fresh(&["write-tree"]);
        std::fs::remove_file(&index).unwrap();
        tree
    }

    #[test]
    fn a_file_changed_in_the_second_the_index_was_written_changes_the_tree_hash() {
        let dir = repo("tree-racy");
        // Stat data compared in whole seconds, as a git built without
        // sub-second times compares it.
        run(&dir, &["config", "core.checkStat", "minimal"]).unwrap();
        let second = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        };
        for round in 0..20 {
            // Starts just after a second turns, so the commit and the
            // rewrite fall in one second and the hash in the next.
            let start = second();
            while second() == start {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let within = second();
            write(&dir, "a.txt", &format!("one {round:02}\n"));
            commit(&dir);
            write(&dir, "a.txt", &format!("two {round:02}\n"));
            if second() != within {
                continue;
            }
            while second() == within {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert_eq!(tree_hash(&dir).unwrap(), fresh_tree(&dir), "round {round}");
            return;
        }
        panic!("no round fell within one second");
    }

    #[test]
    fn a_file_the_index_says_is_unchanged_still_changes_the_tree_hash() {
        let dir = repo("tree-marked");
        write(&dir, "a.txt", "one\n");
        write(&dir, "b.txt", "one\n");
        commit(&dir);
        let clean = tree_hash(&dir).unwrap();
        run(&dir, &["update-index", "--assume-unchanged", "a.txt"]).unwrap();
        run(&dir, &["update-index", "--skip-worktree", "b.txt"]).unwrap();
        write(&dir, "a.txt", "two\n");
        let edited = tree_hash(&dir).unwrap();
        assert_ne!(edited, clean);
        write(&dir, "b.txt", "two\n");
        assert_ne!(tree_hash(&dir).unwrap(), edited);
        // One a sparse checkout left out stays as committed.
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        assert_eq!(tree_hash(&dir).unwrap(), edited);
    }

    #[test]
    fn a_folder_before_its_first_commit_has_a_tree_and_every_path_changed() {
        let dir = repo("tree-first");
        assert_eq!(head(&dir), None);
        write(&dir, "src/a.rs", "fn a() {}\n");
        let tree = tree_hash(&dir).unwrap();
        assert_eq!(
            changed_paths(&dir, "", None, &tree).unwrap(),
            vec!["src/a.rs"]
        );
    }

    #[test]
    fn the_changed_paths_are_those_since_a_commit_renames_by_both_names() {
        let dir = repo("changed-paths");
        write(&dir, "keep.txt", "same\n");
        write(&dir, "old name.txt", "moved\n");
        commit(&dir);
        let since = head(&dir).unwrap();
        std::fs::rename(dir.join("old name.txt"), dir.join("new name.txt")).unwrap();
        write(&dir, "infra/main.tf", "x\n");
        let tree = tree_hash(&dir).unwrap();
        let mut paths = changed_paths(&dir, "", Some(&since), &tree).unwrap();
        paths.sort();
        assert_eq!(paths, vec!["infra/main.tf", "new name.txt", "old name.txt"]);
    }

    #[test]
    fn the_changed_paths_are_measured_from_the_folder_named() {
        let dir = repo("changed-from");
        write(&dir, "apps/web/keep.txt", "same\n");
        commit(&dir);
        let since = head(&dir).unwrap();
        write(&dir, "apps/web/infra/main.tf", "x\n");
        write(&dir, "apps/api/a.rs", "x\n");
        let web = dir.join("apps/web");
        assert_eq!(prefix(&web).unwrap(), "apps/web/");
        let tree = tree_hash(&web).unwrap();
        assert_eq!(tree, tree_hash(&dir).unwrap());
        let mut paths = changed_paths(&web, "apps/web/", Some(&since), &tree).unwrap();
        paths.sort();
        assert_eq!(paths, vec!["../api/a.rs", "infra/main.tf"]);
        let mut every = changed_paths(&web, "apps/web/", None, &tree).unwrap();
        every.sort();
        assert_eq!(every, vec!["../api/a.rs", "infra/main.tf", "keep.txt"]);
    }

    /// A commit on `parent` with `files` written over its own, by its id.
    fn commit_on(dir: &Path, parent: &str, files: &[(&str, &str)]) -> String {
        git(dir, &["checkout", "-q", "--detach", parent]);
        for (name, body) in files {
            write(dir, name, body);
        }
        commit(dir);
        head(dir).unwrap()
    }

    /// The hash of the change from the commit `since` to the commit `to`,
    /// for work that began at `start`.
    fn change(dir: &Path, start: &str, since: &str, to: &str) -> String {
        let tree = git(dir, &["rev-parse", &format!("{to}^{{tree}}")]);
        change_hash(dir, Some(start), Some(since), &tree).unwrap()
    }

    /// A repository whose first commit holds `body` as `src/lib.rs`.
    fn begun(name: &str, body: &str) -> (Scratch, String) {
        let dir = repo(name);
        write(&dir, "src/lib.rs", body);
        commit(&dir);
        let start = head(&dir).unwrap();
        (dir, start)
    }

    const GUARDED: &str = "fn delete_user(user: &User) {\n    require_admin(user);\n    delete(user);\n}\n\nfn list_users(user: &User) {\n    require_admin(user);\n    list();\n}\n";

    #[test]
    fn the_same_line_taken_out_of_another_place_is_another_change() {
        let (dir, start) = begun("change-removed-copy", GUARDED);
        let unguarded = |function: &str| {
            GUARDED.replacen(
                &format!("{function}(user: &User) {{\n    require_admin(user);\n"),
                &format!("{function}(user: &User) {{\n"),
                1,
            )
        };
        let listing = commit_on(&dir, &start, &[("src/lib.rs", &unguarded("list_users"))]);
        let deleting = commit_on(&dir, &start, &[("src/lib.rs", &unguarded("delete_user"))]);
        assert_ne!(
            git(&dir, &["rev-parse", &format!("{listing}^{{tree}}")]),
            git(&dir, &["rev-parse", &format!("{start}^{{tree}}")]),
            "the guard is out"
        );
        assert_ne!(
            change(&dir, &start, &start, &listing),
            change(&dir, &start, &start, &deleting)
        );
    }

    const PAYING: &str =
        "fn pay(order: &Order) {\n    let total = order.total();\n    charge(total);\n}\n";

    #[test]
    fn the_same_line_put_in_at_another_place_is_another_change() {
        let (dir, start) = begun("change-added-moved", PAYING);
        let before = commit_on(
            &dir,
            &start,
            &[(
                "src/lib.rs",
                &PAYING.replace("    charge(", "    check(order);\n    charge("),
            )],
        );
        let after = commit_on(
            &dir,
            &start,
            &[(
                "src/lib.rs",
                &PAYING.replace("total);\n", "total);\n    check(order);\n"),
            )],
        );
        assert_ne!(
            change(&dir, &start, &start, &before),
            change(&dir, &start, &start, &after)
        );
        let top = commit_on(
            &dir,
            &start,
            &[("src/lib.rs", &format!("    check(order);\n{PAYING}"))],
        );
        assert_ne!(
            change(&dir, &start, &start, &top),
            change(&dir, &start, &start, &before)
        );
    }

    #[test]
    fn a_line_put_below_lines_the_base_brought_in_place_of_others_is_another_change() {
        let (dir, start) = begun("change-added-below", PAYING);
        let checked = PAYING.replace("    let total", "    check(order);\n    let total");
        let work = commit_on(&dir, &start, &[("src/lib.rs", &checked)]);
        let returning = "    let Some(total) = order.total() else {\n        return;\n    };\n";
        let main = commit_on(
            &dir,
            &start,
            &[(
                "src/lib.rs",
                &PAYING.replace("    let total = order.total();\n", returning),
            )],
        );
        let kept = commit_on(
            &dir,
            &main,
            &[(
                "src/lib.rs",
                &checked.replace("    let total = order.total();\n", returning),
            )],
        );
        let below = commit_on(
            &dir,
            &main,
            &[(
                "src/lib.rs",
                &PAYING.replace(
                    "    let total = order.total();\n",
                    &format!("{returning}    check(order);\n"),
                ),
            )],
        );
        let reviewed = change(&dir, &start, &start, &work);
        assert_eq!(
            change(&dir, &start, &main, &kept),
            reviewed,
            "the check is where it was reviewed, above the base's lines"
        );
        assert_ne!(
            change(&dir, &start, &main, &below),
            reviewed,
            "the check is below the return the base brought"
        );
    }

    #[test]
    fn the_same_line_the_base_brought_above_leaves_each_copy_its_own_place() {
        let (dir, start) = begun("change-copy-above", GUARDED);
        let unguarded = |body: &str, function: &str| {
            body.replacen(
                &format!("{function}(user: &User) {{\n    require_admin(user);\n"),
                &format!("{function}(user: &User) {{\n"),
                1,
            )
        };
        let work = commit_on(
            &dir,
            &start,
            &[("src/lib.rs", &unguarded(GUARDED, "list_users"))],
        );
        let more = format!(
            "fn add_user(user: &User) {{\n    require_admin(user);\n    add(user);\n}}\n\n{GUARDED}"
        );
        let main = commit_on(&dir, &start, &[("src/lib.rs", &more)]);
        let rebased = commit_on(
            &dir,
            &main,
            &[("src/lib.rs", &unguarded(&more, "list_users"))],
        );
        let other = commit_on(
            &dir,
            &main,
            &[("src/lib.rs", &unguarded(&more, "delete_user"))],
        );
        let reviewed = change(&dir, &start, &start, &work);
        assert_eq!(change(&dir, &start, &main, &rebased), reviewed);
        assert_ne!(
            change(&dir, &start, &main, &other),
            reviewed,
            "the second copy in the file now, which was the first when it was reviewed"
        );
    }

    #[test]
    fn lines_put_where_the_base_put_its_own_read_the_same_either_side_of_them() {
        let (dir, start) = begun("change-same-gap", "one\ntwo\n");
        let work = commit_on(&dir, &start, &[("src/lib.rs", "one\ntwo\nwork\n")]);
        let main = commit_on(&dir, &start, &[("src/lib.rs", "one\ntwo\nmain\n")]);
        let below = commit_on(&dir, &main, &[("src/lib.rs", "one\ntwo\nmain\nwork\n")]);
        let above = commit_on(&dir, &main, &[("src/lib.rs", "one\ntwo\nwork\nmain\n")]);
        let reviewed = change(&dir, &start, &start, &work);
        assert_eq!(change(&dir, &start, &main, &below), reviewed);
        assert_eq!(change(&dir, &start, &main, &above), reviewed);
        let apart = commit_on(&dir, &main, &[("src/lib.rs", "one\nwork\ntwo\nmain\n")]);
        assert_ne!(change(&dir, &start, &main, &apart), reviewed);
    }

    const CACHE: &str = "    if let Some(hit) = cache(req) {\n        return hit;\n    }\n";
    const GUARD: &str = "    require_auth(req);\n";

    /// A function body with `parts` between its first line and its last
    /// two.
    fn served(parts: &[&str]) -> String {
        format!(
            "fn get(req: &Req) -> Resp {{\n{}    let data = load(req);\n    render(data)\n}}\n",
            parts.concat()
        )
    }

    #[test]
    fn a_line_among_lines_the_base_brought_has_its_place_only_in_the_bases_files() {
        let (dir, start) = begun("change-anchor-gap", &served(&[]));
        let main = commit_on(&dir, &start, &[("src/lib.rs", &served(&[CACHE]))]);
        let (first, rest) = CACHE.split_once('\n').unwrap();
        let places = [
            served(&[GUARD, CACHE]),
            served(&[CACHE, GUARD]),
            served(&[first, "\n", GUARD, rest]),
        ]
        .map(|body| commit_on(&dir, &main, &[("src/lib.rs", &body)]));
        let [above, below, inside] = places.each_ref().map(|to| change(&dir, &start, &main, to));
        assert_eq!(above, below, "the start has one gap for all of them");
        assert_eq!(above, inside);
        let [above, below, inside] = places.each_ref().map(|to| change(&dir, &main, &main, to));
        assert_ne!(above, below);
        assert_ne!(above, inside);
        assert_ne!(below, inside);
    }

    #[test]
    fn a_line_among_lines_the_base_put_for_others_reads_as_one_after_them() {
        let (dir, start) = begun("change-among", "a\nb\nc\n");
        let main = commit_on(&dir, &start, &[("src/lib.rs", "a\nb1\nb2\nc\n")]);
        let places = [
            "a\nX\nb1\nb2\nc\n",
            "a\nb1\nX\nb2\nc\n",
            "a\nb1\nb2\nX\nc\n",
        ]
        .map(|body| commit_on(&dir, &main, &[("src/lib.rs", body)]));
        let [before, among, after] = places.each_ref().map(|to| change(&dir, &start, &main, to));
        assert_ne!(before, after);
        assert_eq!(among, after, "the start has no place between the two");
        let [before, among, after] = places.each_ref().map(|to| change(&dir, &main, &main, to));
        assert_ne!(before, among);
        assert_ne!(among, after);
        assert_ne!(before, after);
    }

    #[test]
    fn line_endings_are_in_the_change() {
        let (dir, start) = begun("change-crlf", "one\r\ntwo\r\n");
        let unix = commit_on(&dir, &start, &[("src/lib.rs", "one\ntwo\n")]);
        assert_ne!(
            change(&dir, &start, &start, &unix),
            change(&dir, &start, &start, &start),
            "every line differs by its ending"
        );
        let crlf = commit_on(&dir, &start, &[("src/lib.rs", "one\r\ntwo\r\nwork\r\n")]);
        let lf = commit_on(&dir, &start, &[("src/lib.rs", "one\r\ntwo\r\nwork\n")]);
        assert_ne!(
            change(&dir, &start, &start, &crlf),
            change(&dir, &start, &start, &lf)
        );
        let main = commit_on(&dir, &start, &[("src/lib.rs", "top\r\none\r\ntwo\r\n")]);
        let rebased = commit_on(
            &dir,
            &main,
            &[("src/lib.rs", "top\r\none\r\ntwo\r\nwork\r\n")],
        );
        assert_eq!(
            change(&dir, &start, &main, &rebased),
            change(&dir, &start, &start, &crlf),
            "the same line on a newer base"
        );
    }

    #[test]
    fn an_empty_file_is_in_the_change() {
        let (dir, start) = begun("change-empty", "one\n");
        let none = change(&dir, &start, &start, &start);
        let empty = commit_on(&dir, &start, &[("src/empty.rs", "")]);
        let added = change(&dir, &start, &start, &empty);
        assert_ne!(added, none, "a file with nothing in it is a file more");
        let elsewhere = commit_on(&dir, &start, &[("src/other.rs", "")]);
        assert_ne!(change(&dir, &start, &start, &elsewhere), added);
        let line = commit_on(&dir, &start, &[("src/empty.rs", "\n")]);
        assert_ne!(change(&dir, &start, &start, &line), added);
        let emptied = commit_on(&dir, &start, &[("src/lib.rs", "")]);
        assert_ne!(change(&dir, &start, &start, &emptied), none);
        assert_ne!(
            change(&dir, &empty, &empty, &line),
            change(&dir, &empty, &empty, &empty),
            "a line put in a file that had none"
        );

        let main = commit_on(&dir, &start, &[("README.md", "main's own\n")]);
        let rebased = commit_on(&dir, &main, &[("src/empty.rs", "")]);
        assert_eq!(change(&dir, &start, &main, &rebased), added);
    }

    #[test]
    fn a_change_of_mode_a_deletion_and_the_end_of_a_file_are_in_the_change() {
        let dir = repo("change-kinds");
        write(&dir, "run.sh", "echo\n");
        write(&dir, "gone.txt", "gone\n");
        write(&dir, "end.txt", "last\n");
        write(&dir, "empty.txt", "");
        write(&dir, "dos.txt", "a\r\n");
        commit(&dir);
        let start = head(&dir).unwrap();
        let same = change(&dir, &start, &start, &start);
        let differs = |files: &[(&str, &str)], why: &str| {
            let to = commit_on(&dir, &start, files);
            let hash = change(&dir, &start, &start, &to);
            assert_ne!(hash, same, "{why}");
            hash
        };
        let ended = differs(&[("end.txt", "last")], "the last line loses its end");
        let more = differs(&[("end.txt", "last\n\n")], "an empty line more");
        assert_ne!(ended, more);
        differs(&[("empty.txt", "\n")], "an empty file gets a line");
        differs(&[("dos.txt", "a\n")], "a line loses its carriage return");
        let added = differs(&[("new.txt", "")], "an empty file more");
        assert_ne!(added, differs(&[("other.txt", "")], "by another name"));

        git(&dir, &["checkout", "-q", "--detach", &start]);
        git(&dir, &["rm", "-q", "gone.txt"]);
        commit(&dir);
        let deleted = change(&dir, &start, &start, &head(&dir).unwrap());
        assert_ne!(deleted, same, "a file deleted");
        assert_ne!(
            deleted,
            differs(&[("gone.txt", "")], "a file emptied"),
            "a file deleted is not a file emptied"
        );

        git(&dir, &["checkout", "-q", "--detach", &start]);
        git(&dir, &["update-index", "--chmod=+x", "run.sh"]);
        git(&dir, &["commit", "-q", "-m", "mode"]);
        let run = change(&dir, &start, &start, &head(&dir).unwrap());
        assert_ne!(run, same, "a file made runnable, its lines as they were");
    }

    #[test]
    fn a_submodule_is_in_the_change_by_the_commit_it_is_at() {
        let dir = repo("change-submodule");
        write(&dir, "keep.txt", "x\n");
        commit(&dir);
        let start = head(&dir).unwrap();
        let at = |commit: &str| {
            git(&dir, &["checkout", "-q", "--detach", &start]);
            git(
                &dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{commit},vendor/lib"),
                ],
            );
            git(&dir, &["commit", "-q", "-m", "submodule"]);
            let to = head(&dir).unwrap();
            git(&dir, &["reset", "-q", "--hard"]);
            change(&dir, &start, &start, &to)
        };
        let one = at("1111111111111111111111111111111111111111");
        let other = at("2222222222222222222222222222222222222222");
        assert_ne!(one, change(&dir, &start, &start, &start));
        assert_ne!(one, other);
    }

    /// A repository on the branch `work` at its first commit, with the
    /// remote `origin` at an address elsewhere and its `main` there too.
    fn followed(name: &str) -> (Scratch, String) {
        let dir = repo(name);
        write(&dir, "a.txt", "a\n");
        commit(&dir);
        let start = head(&dir).unwrap();
        git(&dir, &["checkout", "-q", "-b", "work"]);
        git(
            &dir,
            &["remote", "add", "origin", "https://example.invalid/p.git"],
        );
        git(&dir, &["update-ref", "refs/remotes/origin/main", &start]);
        (dir, start)
    }

    /// A commit on the work with one file more, by its id.
    fn more(dir: &Path, name: &str) -> String {
        write(dir, name, "x\n");
        commit(dir);
        head(dir).unwrap()
    }

    #[test]
    fn the_base_follows_the_one_remote_and_no_second_one_ahead_of_it() {
        let (dir, start) = followed("base-second-remote");
        git(
            &dir,
            &["remote", "add", "bob", "https://example.invalid/bob.git"],
        );
        let theirs = more(&dir, "theirs.txt");
        git(&dir, &["update-ref", "refs/remotes/bob/main", &theirs]);
        more(&dir, "work.txt");
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "bob's commit is in the work's history and stays in the change"
        );

        git(&dir, &["update-ref", "refs/remotes/origin/main", &theirs]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(theirs.as_str())
        );
    }

    #[test]
    fn remotes_that_part_leave_the_base_with_the_one_followed() {
        let (dir, start) = followed("base-remotes-part");
        git(
            &dir,
            &["remote", "add", "bob", "https://example.invalid/bob.git"],
        );
        let ours = more(&dir, "ours.txt");
        git(&dir, &["update-ref", "refs/remotes/origin/main", &ours]);
        let aside = commit_on(&dir, &start, &[("aside.txt", "x\n")]);
        git(&dir, &["update-ref", "refs/remotes/bob/main", &aside]);
        git(&dir, &["checkout", "-q", "work"]);
        more(&dir, "work.txt");
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(ours.as_str())
        );

        git(&dir, &["config", "branch.work.remote", "bob"]);
        git(&dir, &["config", "branch.work.merge", "refs/heads/main"]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(ours.as_str()),
            "the remote the branch tracks is not followed"
        );
        git(&dir, &["config", "remote.pushDefault", "bob"]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "the work is pushed to bob, whose main it is not on"
        );
        git(&dir, &["config", "remote.pushDefault", "gone"]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "a remote that is not there is not passed over for origin"
        );
    }

    #[test]
    fn a_branch_made_from_another_remotes_branch_leaves_the_base() {
        let (dir, start) = followed("base-upstream");
        git(
            &dir,
            &["remote", "add", "bob", "https://example.invalid/bob.git"],
        );
        let theirs = more(&dir, "theirs.txt");
        git(&dir, &["update-ref", "refs/remotes/bob/main", &theirs]);
        git(&dir, &["checkout", "-q", "-b", "fix", "bob/main"]);
        assert_eq!(git(&dir, &["config", "branch.fix.remote"]), "bob");
        more(&dir, "work.txt");
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "bob's commit stays in the change"
        );
    }

    #[test]
    fn a_remote_that_is_a_folder_here_never_moves_the_base() {
        let (dir, start) = followed("base-local-remote");
        let feature = more(&dir, "feature.txt");
        more(&dir, "work.txt");
        for address in ["../peer", "/tmp/peer", "file:///tmp/peer", "C:/peer"] {
            git(&dir, &["remote", "set-url", "origin", address]);
            git(
                &dir,
                &["update-ref", "refs/remotes/origin/feature", &feature],
            );
            git(
                &dir,
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/HEAD",
                    "refs/remotes/origin/feature",
                ],
            );
            assert_eq!(
                moved_base(&dir, Some(&start)).as_deref(),
                Some(start.as_str()),
                "{address}"
            );
        }
        for address in [
            "git@example.invalid:p.git",
            "example.invalid:team/p.git",
            "ssh://example.invalid/p.git",
        ] {
            git(&dir, &["remote", "set-url", "origin", address]);
            assert_eq!(
                moved_base(&dir, Some(&start)).as_deref(),
                Some(feature.as_str()),
                "{address}"
            );
        }
    }

    #[test]
    fn the_remotes_default_branch_is_its_head_or_else_main_or_master() {
        let (dir, start) = followed("base-default-branch");
        let trunk = more(&dir, "trunk.txt");
        let work = more(&dir, "work.txt");
        git(&dir, &["update-ref", "refs/remotes/origin/trunk", &trunk]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "main is where the work began"
        );
        git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(trunk.as_str())
        );

        git(&dir, &["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
        git(&dir, &["update-ref", "-d", "refs/remotes/origin/main"]);
        git(&dir, &["update-ref", "refs/remotes/origin/master", &trunk]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(trunk.as_str())
        );
        git(&dir, &["update-ref", "-d", "refs/remotes/origin/master"]);
        assert_eq!(
            moved_base(&dir, Some(&start)).as_deref(),
            Some(start.as_str()),
            "no default branch is known"
        );
        let _ = work;
    }

    #[test]
    fn the_head_tree_is_the_tree_hash_once_everything_is_committed() {
        let dir = repo("head-tree");
        assert_eq!(head_tree(&dir), None);
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        assert_eq!(head_tree(&dir), Some(tree_hash(&dir).unwrap()));
        write(&dir, "a.txt", "two\n");
        assert_ne!(head_tree(&dir), Some(tree_hash(&dir).unwrap()));
    }
}
