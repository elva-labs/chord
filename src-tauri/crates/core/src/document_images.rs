//! The images a Markdown document draws from its own project: those it
//! names by a path relative to itself, as a README names its pictures.
//!
//! The document may have come from anywhere, a cloned repository or an
//! agent, so the rule is narrow. An image is read only when every one of
//! these holds, checked where the files are, after `..` and symlinks
//! resolve:
//!
//! - the path is relative, in plain `/`-separated names, with no empty
//!   name, no `\`, no `:` and no NUL, so it names no drive, no other scheme
//!   and no stream of a file;
//! - the document and the image both resolve to regular files inside the
//!   project;
//! - no name in the path starts with a dot, nor does any folder or file it
//!   resolves to past the folders the document is in itself: a hidden file
//!   or folder is where a secret is kept (`.env`, `.git`, `.ssh`);
//! - the image is one by its extension, and at most [`MEDIA_CAP`];
//! - the project is not the root of a disk, nor the home directory or a
//!   folder above it, which would put the whole of a user's files in reach
//!   of a document left there.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::show::{media_type, Media, MEDIA_CAP};

fn hidden(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// The names of a relative path, or why it is refused.
fn names(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() || path.starts_with('/') {
        return Err("is not a path inside the project".into());
    }
    if path.contains(['\\', ':', '\0']) {
        return Err("is not a plain relative path".into());
    }
    let names: Vec<&str> = path.split('/').collect();
    for name in &names {
        if name.is_empty() {
            return Err("is not a plain relative path".into());
        }
        if hidden(name) {
            return Err("is hidden, and hidden files are not drawn".into());
        }
    }
    Ok(names)
}

/// The project as it resolves, unless it is a root or holds the home
/// directory.
fn project(root: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let project = std::fs::canonicalize(root)
        .map_err(|e| format!("is not drawn: the project could not be read ({e})"))?;
    let holds_home = home
        .and_then(|home| std::fs::canonicalize(home).ok())
        .is_some_and(|home| home.starts_with(&project));
    if project.parent().is_none() || holds_home {
        return Err(
            "is not drawn: the project holds the home directory or is a root, so a document there draws nothing from it"
                .into(),
        );
    }
    Ok(project)
}

/// Where an image a document names resolves to, when the document may
/// draw it. `root` is the project, `document` the document's path in it,
/// and `file` the image's path relative to the document, decoded.
pub fn resolve(
    root: &Path,
    document: &str,
    file: &str,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    let wanted = names(file)?;
    let project = project(root, home)?;
    let at: Vec<&str> = document.split('/').collect();
    if document.is_empty()
        || document.starts_with('/')
        || document.contains('\0')
        || at.iter().any(|name| matches!(*name, "" | "." | ".."))
    {
        return Err("is not drawn: the document is not in the project".into());
    }
    let document = std::fs::canonicalize(
        at.iter()
            .fold(project.clone(), |path, name| path.join(name)),
    )
    .ok()
    .filter(|document| document.starts_with(&project) && document.is_file())
    .ok_or("is not drawn: the document is not in the project")?;
    let folder = document
        .parent()
        .ok_or("is not drawn: the document has no folder")?;
    let joined = wanted
        .iter()
        .fold(folder.to_path_buf(), |path, name| path.join(name));
    let target = std::fs::canonicalize(&joined).map_err(|_| "is not there".to_string())?;
    if !target.starts_with(&project) {
        return Err("is outside the project".into());
    }
    // Past the folders the document is in itself, nothing it reaches may
    // be hidden, a symlink's target included.
    let shared = folder
        .components()
        .zip(target.components())
        .take_while(|(a, b)| a == b)
        .count();
    for part in target.components().skip(shared) {
        match part {
            Component::Normal(name) if name.to_str().is_some_and(|name| !hidden(name)) => {}
            Component::Normal(_) => return Err("is hidden, and hidden files are not drawn".into()),
            _ => return Err("is outside the project".into()),
        }
    }
    if !media_type(&target).is_some_and(|mime| mime.starts_with("image/")) {
        return Err("is not an image".into());
    }
    if !target.is_file() {
        return Err("is not a file".into());
    }
    Ok(target)
}

fn too_large(size: u64) -> String {
    format!(
        "is {} MB, more than the {} MB shown here",
        size.div_ceil(1024 * 1024),
        MEDIA_CAP / (1024 * 1024)
    )
}

/// An image a document names, encoded, with its type, or why the document
/// may not draw it.
pub fn read(root: &Path, document: &str, file: &str, home: Option<&Path>) -> Result<Media, String> {
    use base64::Engine;
    let target = resolve(root, document, file, home)?;
    let mime = media_type(&target).unwrap_or("application/octet-stream");
    let handle = std::fs::File::open(&target).map_err(|e| format!("could not be read: {e}"))?;
    // Read no further than the cap, whatever the file's size says.
    let mut bytes = Vec::new();
    handle
        .take(MEDIA_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not be read: {e}"))?;
    let size = bytes.len() as u64;
    if size > MEDIA_CAP {
        return Err(too_large(size));
    }
    Ok(Media {
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    /// A project with a README at its top, a guide in a folder under it,
    /// the README's icon, and a secret beside the project.
    fn project() -> (Scratch, PathBuf) {
        let dir = Scratch::new("document-images");
        let root = dir.join("project");
        std::fs::create_dir_all(root.join("docs/guide")).unwrap();
        std::fs::write(root.join("README.md"), "<img src=docs/icon.png>").unwrap();
        std::fs::write(root.join("docs/guide/use.md"), "![](../icon.png)").unwrap();
        std::fs::write(root.join("docs/icon.png"), [137, 80, 78, 71]).unwrap();
        std::fs::write(dir.join("secret.png"), [1, 2, 3]).unwrap();
        (dir, root)
    }

    #[test]
    fn reads_an_image_beside_under_or_above_the_document_in_the_project() {
        let (_dir, root) = project();
        let icon = read(&root, "README.md", "docs/icon.png", None).unwrap();
        assert_eq!(icon.mime, "image/png");
        assert_eq!(icon.data, "iVBORw==");
        assert_eq!(icon.size, 4);
        assert!(read(&root, "README.md", "./docs/icon.png", None).is_ok());
        assert!(read(&root, "docs/guide/use.md", "../icon.png", None).is_ok());
        assert!(read(&root, "docs/guide/use.md", "../../docs/./icon.png", None).is_ok());
    }

    #[test]
    fn refuses_a_path_that_leaves_the_project_or_names_another_place() {
        let (dir, root) = project();
        for file in [
            "../secret.png",
            "docs/../../secret.png",
            "docs/guide/../../../secret.png",
        ] {
            let why = read(&root, "README.md", file, None).unwrap_err();
            assert!(why.contains("outside the project"), "{file}: {why}");
        }
        let absolute = dir.join("secret.png").to_string_lossy().to_string();
        assert!(read(&root, "README.md", &absolute, None)
            .unwrap_err()
            .contains("not a path inside"));
        for file in [
            "file:///etc/hosts",
            "https://example.com/a.png",
            "C:/Windows/a.png",
            "..\\secret.png",
            "docs/icon.png:stream",
            "docs/icon.png\0",
            "docs//icon.png",
        ] {
            let why = read(&root, "README.md", file, None).unwrap_err();
            assert!(why.contains("not a plain relative path"), "{file}: {why}");
        }
        assert!(read(&root, "README.md", "", None).is_err());
        assert!(read(&root, "README.md", "~/secret.png", None)
            .unwrap_err()
            .contains("not there"));
    }

    #[test]
    fn draws_nothing_for_a_document_outside_the_project_or_with_no_path() {
        let (dir, root) = project();
        std::fs::write(dir.join("loose.md"), "![](project/docs/icon.png)").unwrap();
        for document in [
            "../loose.md",
            "",
            "/README.md",
            "docs",
            "gone.md",
            "./README.md",
        ] {
            let why = read(&root, document, "docs/icon.png", None).unwrap_err();
            assert!(why.contains("not in the project"), "{document}: {why}");
        }
    }

    #[test]
    fn refuses_hidden_files_and_folders_but_not_those_the_document_is_in() {
        let (_dir, root) = project();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/logo.png"), [1]).unwrap();
        std::fs::write(root.join(".env.png"), [1]).unwrap();
        for file in [
            ".git/logo.png",
            ".env.png",
            "docs/.hidden.png",
            "docs/guide/../../.env.png",
        ] {
            let why = read(&root, "README.md", file, None).unwrap_err();
            assert!(why.contains("hidden"), "{file}: {why}");
        }
        // A worktree in a hidden folder of the project draws its own images.
        let tree = root.join(".claude/worktrees/one");
        std::fs::create_dir_all(tree.join("docs")).unwrap();
        std::fs::write(tree.join("README.md"), "").unwrap();
        std::fs::write(tree.join("docs/icon.png"), [7]).unwrap();
        let drawn = read(
            &root,
            ".claude/worktrees/one/README.md",
            "docs/icon.png",
            None,
        )
        .unwrap();
        assert_eq!(drawn.size, 1);
    }

    #[test]
    fn reads_only_images_of_at_most_the_cap() {
        let (_dir, root) = project();
        std::fs::write(root.join("notes.txt"), "text").unwrap();
        std::fs::write(root.join("id_rsa"), "key").unwrap();
        std::fs::write(root.join("report.pdf"), "%PDF").unwrap();
        std::fs::create_dir_all(root.join("dir.png")).unwrap();
        for file in ["notes.txt", "id_rsa", "report.pdf", "README.md"] {
            let why = read(&root, "README.md", file, None).unwrap_err();
            assert!(why.contains("not an image"), "{file}: {why}");
        }
        assert!(read(&root, "README.md", "dir.png", None)
            .unwrap_err()
            .contains("not a file"));
        assert!(read(&root, "README.md", "gone.png", None)
            .unwrap_err()
            .contains("not there"));
        let big = std::fs::File::create(root.join("big.png")).unwrap();
        big.set_len(MEDIA_CAP + 1).unwrap();
        assert!(read(&root, "README.md", "big.png", None)
            .unwrap_err()
            .contains("more than the 8 MB"));
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlink_only_while_it_stays_in_the_project() {
        let (dir, root) = project();
        std::os::unix::fs::symlink(dir.join("secret.png"), root.join("out.png")).unwrap();
        std::os::unix::fs::symlink(dir.path(), root.join("up")).unwrap();
        std::os::unix::fs::symlink(root.join("docs/icon.png"), root.join("same.png")).unwrap();
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        std::fs::write(root.join(".cache/k.png"), [9]).unwrap();
        std::os::unix::fs::symlink(root.join(".cache/k.png"), root.join("k.png")).unwrap();
        std::os::unix::fs::symlink(dir.join("secret.png"), root.join("docs/inside.md")).unwrap();
        assert!(read(&root, "README.md", "out.png", None)
            .unwrap_err()
            .contains("outside the project"));
        assert!(read(&root, "README.md", "up/secret.png", None)
            .unwrap_err()
            .contains("outside the project"));
        assert!(read(&root, "README.md", "k.png", None)
            .unwrap_err()
            .contains("hidden"));
        assert!(read(&root, "docs/inside.md", "icon.png", None)
            .unwrap_err()
            .contains("not in the project"));
        assert_eq!(read(&root, "README.md", "same.png", None).unwrap().size, 4);
    }

    #[test]
    fn draws_nothing_for_a_project_that_is_the_home_directory_or_above_it() {
        let (dir, root) = project();
        let why = read(&root, "README.md", "docs/icon.png", Some(&root)).unwrap_err();
        assert!(why.contains("home directory"), "{why}");
        let below = root.join("docs");
        assert!(read(&root, "README.md", "docs/icon.png", Some(&below))
            .unwrap_err()
            .contains("home directory"));
        assert!(read(
            &root,
            "README.md",
            "docs/icon.png",
            Some(&dir.join("elsewhere"))
        )
        .is_ok());
    }
}
