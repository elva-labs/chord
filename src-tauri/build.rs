fn main() {
    commit();
    tauri_build::build()
}

/// Puts the commit the app is built from in `CHORD_COMMIT`, eight
/// characters, for About to copy. Empty when the source is not in a git
/// repository and CI does not name one.
fn commit() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let commit = git(&["rev-parse", "--short=8", "HEAD"])
        .or_else(|| {
            std::env::var("GITHUB_SHA")
                .ok()
                .map(|sha| sha.chars().take(8).collect())
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=CHORD_COMMIT={commit}");
    for path in ["HEAD", "packed-refs"] {
        let path = git(&["rev-parse", "--git-path", path]);
        if let Some(path) = path.filter(|path| std::path::Path::new(path).exists()) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if let Some(head) = git(&["symbolic-ref", "-q", "HEAD"]) {
        let path = git(&["rev-parse", "--git-path", &head]);
        if let Some(path) = path.filter(|path| std::path::Path::new(path).exists()) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}
