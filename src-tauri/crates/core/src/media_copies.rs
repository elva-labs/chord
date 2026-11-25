//! Copies of presented files from outside the project's own checkout, kept in the workbench's folder so a row on
//! the media list still shows what it held once the file itself is gone:
//! a temp folder is cleared by the system, often within days.
//!
//! Each kept file has a slot of its own, `media/<call>/<n>/<name>`, which
//! is removed with its row. An HTML page's slot also holds the files the
//! page names in its own folder, at the same relative paths, so the copy
//! loads them as the page did. Only files the page or its stylesheets name
//! outright are copied, only those a page may load (see [`crate::page_files`]),
//! and no more than [`PAGE_FILES`] of them or [`PAGE_BYTES`] in all; what a
//! script works out as it runs is not.
//!
//! The copies come to no more than [`BUDGET`] bytes: after each call to
//! keep, whole call folders go, oldest first, until they do. The folder of
//! that call stays.

use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::show::{is_gone, media_type, MEDIA_CAP};

/// The most files copied from a page's folder with it.
pub const PAGE_FILES: usize = 64;
/// The most those files come to together.
pub const PAGE_BYTES: u64 = 16 * 1024 * 1024;
/// The most all the copies come to together.
pub const BUDGET: u64 = 512 * 1024 * 1024;
/// The most names looked at in one page, copied or not.
const LOOKED_AT: usize = 1024;

/// The folder the copies are in, under the workbench's directory in the
/// user's home.
pub fn folder(home: &Path) -> PathBuf {
    crate::home::dir(home).join("media")
}

/// A name no other call to keep has, in this process or another.
fn call_name() -> String {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    format!(
        "{now:x}-{:x}-{:x}",
        std::process::id(),
        CALLS.fetch_add(1, Ordering::Relaxed)
    )
}

/// Makes a folder, readable by the user alone.
fn make_folder(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Writes a copy, readable by the user alone.
fn write_own(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        make_folder(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Leaves a folder that is there readable by the user alone.
fn close_to_others(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// A regular file's bytes, when it has no more than [`MEDIA_CAP`] of them.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // Opening a pipe would otherwise wait for a writer.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    // Asked of what was opened, so nothing can take its place in between.
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MEDIA_CAP + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MEDIA_CAP).then_some(bytes)
}

/// Whether the file is in the project's own checkout: under the project,
/// and not in a worktree or another repository inside it.
fn in_checkout(file: &Path, project: &Path) -> bool {
    file.starts_with(project)
        && file
            .ancestors()
            .skip(1)
            .take_while(|folder| *folder != project)
            .all(|folder| folder.join(".git").symlink_metadata().is_err())
}

/// Copies each file that can be shown, and is outside the project's own
/// checkout, into the workbench's folder: where each copy is, in the order
/// asked, or None for a file of the checkout, one that is not there, is not
/// of a kind shown or is too large to be. `user_home` bounds what a page may
/// load from its folder.
pub fn keep(
    home: &Path,
    files: &[String],
    project: &Path,
    user_home: Option<&Path>,
) -> Result<Vec<Option<String>>, String> {
    keep_within(home, files, project, user_home, BUDGET)
}

/// [`keep`], holding all the copies to `budget` bytes.
fn keep_within(
    home: &Path,
    files: &[String],
    project: &Path,
    user_home: Option<&Path>,
    budget: u64,
) -> Result<Vec<Option<String>>, String> {
    let folder = folder(home);
    close_to_others(&folder);
    let call = folder.join(call_name());
    let kept = files
        .iter()
        .enumerate()
        .map(|(n, file)| {
            let source = Path::new(file);
            if in_checkout(source, project) {
                return None;
            }
            let mime = media_type(source)?;
            let name = source.file_name()?;
            let bytes = read_capped(source)?;
            let slot = call.join(n.to_string());
            let copy = slot.join(name);
            if write_own(&copy, &bytes).is_err() {
                let _ = std::fs::remove_dir_all(&slot);
                let _ = std::fs::remove_dir(&call);
                return None;
            }
            if mime == "text/html" {
                keep_page_files(source, &bytes, &slot, user_home);
            }
            Some(copy.to_string_lossy().into_owned())
        })
        .collect();
    sweep(&folder, &call, budget);
    Ok(kept)
}

/// Removes call folders, oldest first, until the copies come to no more
/// than `budget` bytes. `made` stays, whatever its size.
fn sweep(folder: &Path, made: &Path, budget: u64) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut total = 0;
    let mut older = Vec::new();
    for entry in entries.flatten() {
        // An entry's own metadata: a link is not followed.
        let Ok(found) = entry.metadata() else {
            continue;
        };
        if !found.is_dir() {
            continue;
        }
        let path = entry.path();
        let size = size_of(&path);
        total += size;
        if path != made {
            let changed = found.modified().unwrap_or(UNIX_EPOCH);
            older.push((changed, path, size));
        }
    }
    older.sort();
    for (_, path, size) in older {
        if total <= budget {
            break;
        }
        if std::fs::remove_dir_all(path).is_ok() {
            total -= size;
        }
    }
}

/// The bytes of the files under a folder, links not followed.
fn size_of(folder: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| Some((entry.metadata().ok()?, entry.path())))
        .map(|(found, path)| {
            if found.is_dir() {
                size_of(&path)
            } else {
                found.len()
            }
        })
        .sum()
}

/// Copies what a page names in its folder into its slot.
fn keep_page_files(page: &Path, html: &[u8], slot: &Path, user_home: Option<&Path>) {
    let html = String::from_utf8_lossy(html);
    let mut wanted: VecDeque<String> = attribute_names(&html)
        .into_iter()
        .chain(css_names(&html))
        .filter_map(|name| relative("", &name))
        .collect();
    let mut seen = HashSet::new();
    let (mut files, mut bytes_kept) = (0, 0);
    while let Some(name) = wanted.pop_front() {
        if files == PAGE_FILES || seen.len() == LOOKED_AT {
            break;
        }
        if !seen.insert(name.clone()) {
            continue;
        }
        let Ok(source) = crate::page_files::resolve(page, &name, user_home) else {
            continue;
        };
        let Some(bytes) = read_capped(&source) else {
            continue;
        };
        let size = bytes.len() as u64;
        if bytes_kept + size > PAGE_BYTES || write_own(&slot.join(&name), &bytes).is_err() {
            continue;
        }
        files += 1;
        bytes_kept += size;
        if crate::page_files::page_file_type(&source) == Some("text/css") {
            let at = name.rsplit_once('/').map_or("", |(at, _)| at);
            wanted.extend(
                css_names(&String::from_utf8_lossy(&bytes))
                    .into_iter()
                    .filter_map(|named| relative(at, &named)),
            );
        }
    }
}

/// The values of the attributes by which a tag names a file.
fn attribute_names(html: &str) -> Vec<String> {
    let mut names = Vec::new();
    for tag in html.split('<').skip(1) {
        if !tag.starts_with(|c: char| c.is_ascii_alphabetic()) {
            continue;
        }
        let mut rest = tag.trim_start_matches(|c: char| !c.is_whitespace() && c != '>');
        loop {
            rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
            if rest.is_empty() || rest.starts_with('>') {
                break;
            }
            let end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '=' | '>' | '/'))
                .unwrap_or(rest.len());
            // A stray `=` is stepped over, so every turn moves on.
            if end == 0 {
                rest = &rest[1..];
                continue;
            }
            let attribute = rest[..end].to_ascii_lowercase();
            rest = rest[end..].trim_start();
            let Some(after) = rest.strip_prefix('=') else {
                continue;
            };
            let after = after.trim_start();
            let (value, left) = match after.chars().next() {
                Some(quote @ ('"' | '\'')) => {
                    after[1..].split_once(quote).unwrap_or((&after[1..], ""))
                }
                _ => after.split_at(
                    after
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .unwrap_or(after.len()),
                ),
            };
            rest = left;
            let value = value.replace("&amp;", "&");
            match attribute.as_str() {
                "src" | "href" | "xlink:href" | "poster" | "data" => names.push(value),
                "srcset" => names.extend(
                    value
                        .split(',')
                        .filter_map(|one| one.split_whitespace().next())
                        .map(str::to_string),
                ),
                _ => {}
            }
        }
    }
    names
}

/// The files CSS names, in `url()` and `@import`.
fn css_names(css: &str) -> Vec<String> {
    let mut names = Vec::new();
    for after in css.split("url(").skip(1) {
        let after = after.trim_start();
        let (quote, after) = match after.chars().next() {
            Some(quote @ ('"' | '\'')) => (quote, &after[1..]),
            _ => (')', after),
        };
        if let Some((name, _)) = after.split_once(quote) {
            names.push(name.trim().to_string());
        }
    }
    for after in css.split("@import").skip(1) {
        let after = after.trim_start();
        if let Some(quote @ ('"' | '\'')) = after.chars().next() {
            if let Some((name, _)) = after[1..].split_once(quote) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// A name as written in a file in the folder `at`, as a path relative to
/// the page's folder; None when it is not one, or leads out of it.
fn relative(at: &str, name: &str) -> Option<String> {
    let name = name.trim();
    let name = name.split(['?', '#']).next()?;
    if name.is_empty() || name.starts_with('/') || name.contains(':') {
        return None;
    }
    let name = percent_decoded(name)?;
    let mut parts: Vec<&str> = at.split('/').filter(|part| !part.is_empty()).collect();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn percent_decoded(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| bytes.get(i + 1..i + 3))
            .flatten()
            .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Removes the slot each copy is in. A path that is not a copy in the
/// workbench's folder is left alone.
pub fn forget(home: &Path, copies: &[String]) {
    let folder = folder(home);
    for copy in copies {
        let Ok(inside) = Path::new(copy).strip_prefix(&folder) else {
            continue;
        };
        let parts: Vec<Component> = inside.components().collect();
        if parts.len() < 3 || !parts.iter().all(|p| matches!(p, Component::Normal(_))) {
            continue;
        }
        let call = folder.join(parts[0]);
        let _ = std::fs::remove_dir_all(call.join(parts[1]));
        // Only an empty folder goes: the call's other files keep theirs.
        let _ = std::fs::remove_dir(call);
    }
}

/// Where removable volumes are mounted, and how many folders under each a
/// volume's own folder is.
const MOUNTS: [(&str, usize); 3] = [("/Volumes", 1), ("/media", 2), ("/run/media", 2)];

/// Whether the file is on a drive or volume that is not mounted, which says
/// nothing about the file.
fn away(file: &Path, mounts: &[(&Path, usize)]) -> bool {
    if file
        .ancestors()
        .last()
        .is_some_and(|root| !root.as_os_str().is_empty() && !root.exists())
    {
        return true;
    }
    mounts.iter().any(|(parent, depth)| {
        let Ok(inside) = file.strip_prefix(parent) else {
            return false;
        };
        let volume: PathBuf = inside.components().take(*depth).collect();
        inside.components().count() > *depth && !parent.join(volume).exists()
    })
}

/// For each file, whether it is known to be gone: nothing is at its path,
/// on a volume that is there. A file that cannot be asked about is not.
pub fn gone(files: &[String]) -> Vec<bool> {
    let mounts = MOUNTS.map(|(parent, depth)| (Path::new(parent), depth));
    files
        .iter()
        .map(|file| {
            std::fs::metadata(file).is_err_and(|e| is_gone(&e)) && !away(Path::new(file), &mounts)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    fn put(path: &Path, bytes: &[u8]) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn keeps_a_copy_that_outlives_the_file() {
        let scratch = Scratch::new("media-copies");
        let home = scratch.join("home");
        let shot = put(&scratch.join("tmp/shot.png"), b"png");
        let missing = scratch.join("tmp/no.png").to_string_lossy().into_owned();
        let key = put(&scratch.join("tmp/id_rsa"), b"key");
        let kept = keep(
            &home,
            &[shot.clone(), missing, key],
            &scratch.join("project"),
            Some(&home),
        )
        .unwrap();
        let copy = kept[0].clone().unwrap();
        assert_eq!(&kept[1..], &[None, None]);
        assert!(Path::new(&copy).starts_with(folder(&home)));
        std::fs::remove_file(&shot).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"png");
        assert_eq!(gone(&[shot, copy]), [true, false]);
    }

    #[test]
    fn copies_all_but_the_files_of_the_projects_own_checkout() {
        let scratch = Scratch::new("media-copies-checkout");
        let home = scratch.join("home");
        let project = scratch.join("project");
        put(&project.join(".git/HEAD"), b"ref");
        let own = put(&project.join("shots/own.png"), b"png");
        let tree = project.join(".claude/worktrees/x");
        put(&tree.join(".git"), b"gitdir: elsewhere");
        let inside = put(&tree.join("shots/inside.png"), b"png");
        let beside = put(&scratch.join("project-x/beside.png"), b"png");
        let kept = keep(&home, &[own, inside, beside], &project, Some(&home)).unwrap();
        assert_eq!(
            kept.iter().map(Option::is_some).collect::<Vec<_>>(),
            [false, true, true]
        );
    }

    #[test]
    fn a_file_on_a_volume_that_is_away_is_not_known_to_be_gone() {
        let scratch = Scratch::new("media-copies-away");
        let volumes = scratch.join("Volumes");
        std::fs::create_dir_all(volumes.join("here")).unwrap();
        let mounts = [(volumes.as_path(), 1)];
        assert!(away(&volumes.join("unplugged/shot.png"), &mounts));
        assert!(!away(&volumes.join("here/shot.png"), &mounts));
        assert!(!away(&volumes.join("here/folder/shot.png"), &mounts));
        assert!(!away(&scratch.join("shot.png"), &mounts));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_may_not_be_asked_about_is_not_gone() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("media-copies-locked");
        let locked = scratch.join("locked");
        let shot = put(&locked.join("shot.png"), b"png");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = gone(&[shot]);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(answer, [false]);
    }

    #[test]
    fn leaves_out_a_file_too_large_to_be_shown() {
        let scratch = Scratch::new("media-copies-large");
        let home = scratch.join("home");
        let big = put(
            &scratch.join("tmp/big.png"),
            &vec![0; MEDIA_CAP as usize + 1],
        );
        assert_eq!(
            keep(&home, &[big], &scratch.join("project"), Some(&home)).unwrap(),
            [None]
        );
        assert!(!folder(&home).exists());
    }

    #[test]
    fn a_page_takes_the_files_it_names_in_its_folder_and_no_others() {
        let scratch = Scratch::new("media-copies-page");
        let home = scratch.join("home");
        let at = scratch.join("tmp/report");
        let page = put(
            &at.join("index.html"),
            br#"<link rel=stylesheet href="css/look.css">
                <img src='./shots/one%20a.png?v=2' srcset="two.png 2x, three.png 3x">
                <img src="../outside.png"><img src="https://example.com/far.png">
                <a href=".env">x</a><a href="notes.txt">y</a>
                <div style="background: url(bg.png)"></div>"#,
        );
        for name in [
            "shots/one a.png",
            "two.png",
            "three.png",
            "bg.png",
            "unnamed.png",
            "notes.txt",
            ".env",
            "fonts/a.woff2",
        ] {
            put(&at.join(name), b"x");
        }
        put(
            &at.join("css/look.css"),
            b"@font-face { src: url('../fonts/a.woff2') }",
        );
        put(&scratch.join("tmp/outside.png"), b"x");
        let copy = keep(&home, &[page], &scratch.join("project"), Some(&home)).unwrap()[0]
            .clone()
            .unwrap();
        let slot = Path::new(&copy).parent().unwrap();
        for name in [
            "css/look.css",
            "shots/one a.png",
            "two.png",
            "three.png",
            "bg.png",
            "fonts/a.woff2",
        ] {
            assert!(slot.join(name).is_file(), "{name}");
            // The copy, in a hidden folder itself, loads them as a page.
            crate::page_files::resolve(Path::new(&copy), name, Some(&home)).unwrap();
        }
        for name in ["unnamed.png", "notes.txt", ".env"] {
            assert!(!slot.join(name).exists(), "{name}");
        }
        assert!(!slot.parent().unwrap().join("outside.png").exists());
    }

    #[test]
    fn a_page_takes_no_more_than_the_most_files() {
        let scratch = Scratch::new("media-copies-many");
        let home = scratch.join("home");
        let at = scratch.join("tmp/many");
        let mut html = String::new();
        for n in 0..PAGE_FILES + 5 {
            put(&at.join(format!("{n}.png")), b"x");
            html.push_str(&format!("<img src=\"{n}.png\">"));
        }
        let page = put(&at.join("index.html"), html.as_bytes());
        let copy = keep(&home, &[page], &scratch.join("project"), Some(&home)).unwrap()[0]
            .clone()
            .unwrap();
        let slot = Path::new(&copy).parent().unwrap();
        assert_eq!(std::fs::read_dir(slot).unwrap().count(), PAGE_FILES + 1);
    }

    #[test]
    fn a_page_takes_no_more_than_the_most_bytes() {
        let scratch = Scratch::new("media-copies-heavy");
        let home = scratch.join("home");
        let at = scratch.join("tmp/heavy");
        let each = vec![0; (PAGE_BYTES / 8 * 3) as usize];
        for name in ["a.png", "b.png", "c.png"] {
            put(&at.join(name), &each);
        }
        let page = put(
            &at.join("index.html"),
            br#"<img src="a.png"><img src="b.png"><img src="c.png">"#,
        );
        let copy = keep(&home, &[page], &scratch.join("project"), Some(&home)).unwrap()[0]
            .clone()
            .unwrap();
        let slot = Path::new(&copy).parent().unwrap();
        assert!(slot.join("a.png").is_file() && slot.join("b.png").is_file());
        assert!(!slot.join("c.png").exists());
    }

    #[test]
    fn the_oldest_calls_go_to_keep_the_copies_within_the_budget() {
        let scratch = Scratch::new("media-copies-budget");
        let home = scratch.join("home");
        let shot = put(&scratch.join("tmp/shot.png"), &[0; 10]);
        let call = |budget| {
            // Folders made in turn are told apart by their times.
            std::thread::sleep(std::time::Duration::from_millis(20));
            let kept = keep_within(
                &home,
                std::slice::from_ref(&shot),
                &scratch.join("project"),
                Some(&home),
                budget,
            );
            PathBuf::from(kept.unwrap()[0].clone().unwrap())
        };
        let first = call(25);
        let second = call(25);
        assert!(first.is_file() && second.is_file());
        let third = call(25);
        assert!(!first.ancestors().nth(2).unwrap().exists());
        assert!(second.is_file() && third.is_file());
        // A call larger than the budget is the one that stays.
        let last = call(5);
        assert!(last.is_file());
        assert_eq!(std::fs::read_dir(folder(&home)).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn copies_are_for_the_user_alone() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let scratch = Scratch::new("media-copies-modes");
        let home = scratch.join("home");
        let shot = put(&scratch.join("tmp/shot.png"), b"png");
        std::fs::create_dir_all(folder(&home)).unwrap();
        std::fs::set_permissions(folder(&home), std::fs::Permissions::from_mode(0o755)).unwrap();
        let copy = PathBuf::from(
            keep(&home, &[shot], &scratch.join("project"), Some(&home)).unwrap()[0]
                .clone()
                .unwrap(),
        );
        assert_eq!(mode(&copy), 0o600);
        for folder in copy.ancestors().skip(1).take(3) {
            assert_eq!(mode(folder), 0o700, "{}", folder.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_pipe_is_left_out_without_waiting_for_it() {
        let scratch = Scratch::new("media-copies-pipe");
        let home = scratch.join("home");
        let pipe = scratch.join("pipe.png");
        let name = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let files = [pipe.to_string_lossy().into_owned()];
        assert_eq!(
            keep(&home, &files, &scratch.join("project"), Some(&home)).unwrap(),
            [None]
        );
    }

    #[test]
    fn forgets_a_copy_and_nothing_that_is_not_one() {
        let scratch = Scratch::new("media-copies-forget");
        let home = scratch.join("home");
        let a = put(&scratch.join("tmp/a.png"), b"a");
        let b = put(&scratch.join("tmp/b.png"), b"b");
        let kept: Vec<String> = keep(
            &home,
            &[a.clone(), b],
            &scratch.join("project"),
            Some(&home),
        )
        .unwrap()
        .into_iter()
        .flatten()
        .collect();
        let sneaky = format!("{}/x/0/../../../../tmp/a.png", folder(&home).display());
        forget(&home, &[a.clone(), sneaky, kept[0].clone()]);
        assert!(Path::new(&a).is_file());
        assert!(!Path::new(&kept[0]).exists());
        assert!(Path::new(&kept[1]).is_file());
        forget(&home, &kept[1..]);
        assert_eq!(std::fs::read_dir(folder(&home)).unwrap().count(), 0);
    }

    #[test]
    fn reading_a_file_that_is_gone_says_so() {
        let scratch = Scratch::new("media-copies-gone");
        let file = scratch.join("cleared/shot.png");
        assert_eq!(
            crate::show::read_media(&file).unwrap_err(),
            crate::show::GONE
        );
    }
}
