//! What this machine has of what the app needs: an agent to run, Claude
//! Code or Codex, and git for worktrees and diffs. Each is looked up on the
//! login shell's PATH, asked for its version, and for an agent, looked at
//! for the credentials a sign-in leaves behind. Nothing here starts a
//! conversation, spends usage or reaches the network.
//!
//! The welcome's own state is a file of its own beside the settings,
//! `welcome.json`, which a version that has no welcome never reads.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{account, adapter, env};

/// How long a program has to say its version. A program that takes longer
/// is reported found with no version.
const VERSION_DEADLINE: Duration = Duration::from_secs(5);

/// One thing the app looks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// `claude-code`, `codex` or `git`.
    pub id: String,
    /// What the user knows it as.
    pub name: String,
    /// The program looked up on the PATH.
    pub binary: String,
    /// True for the agents, one of which the app needs.
    pub agent: bool,
    /// Where the program was found, when it was.
    pub path: Option<String>,
    /// The version it reports, as dotted numbers.
    pub version: Option<String>,
    /// For a found agent, whether credentials of a sign-in are there. None
    /// for git, and for an agent that was not found.
    pub signed_in: Option<bool>,
    /// How to install it on this platform.
    pub install: Install,
}

/// A command that installs a program, for the platforms that have one, and
/// the page that says more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub command: Option<String>,
    pub link: String,
}

/// Every check, in the order they are shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub checks: Vec<Check>,
    /// False when the login shell could not be read, so a program that was
    /// not found may be there all the same.
    pub from_login_shell: bool,
}

impl Setup {
    /// Whether an agent the app can run was found.
    pub fn agent_found(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.agent && check.path.is_some())
    }
}

struct Wanted {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    agent: bool,
}

const WANTED: [Wanted; 3] = [
    Wanted {
        id: "claude-code",
        name: "Claude Code",
        binary: "claude",
        agent: true,
    },
    Wanted {
        id: "codex",
        name: "Codex",
        binary: "codex",
        agent: true,
    },
    Wanted {
        id: "git",
        name: "git",
        binary: "git",
        agent: false,
    },
];

/// Runs every check against the login shell's environment.
pub fn check(home: &Path) -> Setup {
    let environment = env::environment();
    check_with(
        home,
        &environment.vars,
        environment.from_login_shell,
        &keychain_holds_claude,
    )
}

/// Whether an agent is on the login shell's PATH. Nothing is run, so it
/// answers at once.
pub fn agent_on_path() -> bool {
    agent_on_path_in(&env::environment().vars)
}

fn agent_on_path_in(vars: &HashMap<String, String>) -> bool {
    WANTED
        .iter()
        .filter(|wanted| wanted.agent)
        .any(|wanted| find(wanted.binary, vars).is_some())
}

/// Runs every check against `vars`. `keychain` says whether the system's
/// keychain holds Claude Code's credentials. The checks run side by side,
/// since each waits on a program of its own.
fn check_with(
    home: &Path,
    vars: &HashMap<String, String>,
    from_login_shell: bool,
    keychain: &(dyn Fn() -> bool + Sync),
) -> Setup {
    let checks = std::thread::scope(|scope| {
        let running: Vec<_> = WANTED
            .iter()
            .map(|wanted| scope.spawn(move || one(wanted, home, vars, keychain)))
            .collect();
        running
            .into_iter()
            .zip(WANTED.iter())
            .map(|(thread, wanted)| {
                thread.join().unwrap_or_else(|_| Check {
                    id: wanted.id.to_string(),
                    name: wanted.name.to_string(),
                    binary: wanted.binary.to_string(),
                    agent: wanted.agent,
                    path: None,
                    version: None,
                    signed_in: None,
                    install: install(wanted.id),
                })
            })
            .collect()
    });
    Setup {
        checks,
        from_login_shell,
    }
}

fn one(
    wanted: &Wanted,
    home: &Path,
    vars: &HashMap<String, String>,
    keychain: &(dyn Fn() -> bool + Sync),
) -> Check {
    let path = find(wanted.binary, vars);
    let version = path
        .as_deref()
        .and_then(|path| version_of(path, home, vars));
    let signed_in = match (&path, wanted.id) {
        (Some(_), "claude-code") => Some(claude_signed_in(home, vars, keychain)),
        (Some(_), "codex") => Some(codex_signed_in(home, vars)),
        _ => None,
    };
    Check {
        id: wanted.id.to_string(),
        name: wanted.name.to_string(),
        binary: wanted.binary.to_string(),
        agent: wanted.agent,
        path: path.map(|path| path.to_string_lossy().to_string()),
        version,
        signed_in,
        install: install(wanted.id),
    }
}

/// The program on the PATH. On macOS the git in `/usr/bin` stands in for
/// the developer tools until they are installed, and running it then asks
/// the user to install them, so it counts only once they are there.
fn find(binary: &str, vars: &HashMap<String, String>) -> Option<PathBuf> {
    let path = env::find_on_path(vars, binary)?;
    if cfg!(target_os = "macos") && path == Path::new("/usr/bin/git") && !developer_tools() {
        return None;
    }
    Some(path)
}

#[cfg(target_os = "macos")]
fn developer_tools() -> bool {
    std::process::Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            Path::new(String::from_utf8_lossy(&output.stdout).trim())
                .join("usr/bin/git")
                .is_file()
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn developer_tools() -> bool {
    true
}

/// What `program --version` prints, read for its version, or None when it
/// fails or outlasts the deadline.
fn version_of(program: &Path, home: &Path, vars: &HashMap<String, String>) -> Option<String> {
    let mut command = adapter::process(program, vars);
    adapter::prepare_process(&mut command, home, vars);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let deadline = Instant::now() + VERSION_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let text = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()?;
    version_in(&text)
}

/// The first dotted number in a version line: `2.1.3` from `2.1.3 (Claude
/// Code)`, `0.63.0` from `codex-cli 0.63.0`, `2.50.1` from `git version
/// 2.50.1 (Apple Git-155)`.
fn version_in(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|word| {
        let word = word.trim_start_matches(['v', 'V']);
        let end = word
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(word.len());
        let number = word[..end].trim_end_matches('.');
        let dotted = number.contains('.')
            && number.split('.').all(|part| !part.is_empty())
            && number.starts_with(|c: char| c.is_ascii_digit());
        dotted.then(|| number.to_string())
    })
}

/// The variables that sign Claude Code in without a sign-in of its own: an
/// API key, a token, or a cloud provider's credentials.
const CLAUDE_SIGNED_IN_VARS: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// Whether Claude Code has credentials: a variable that signs it in, the
/// credentials file in its directory, the account its state file records,
/// or the item it keeps in the system's keychain.
fn claude_signed_in(
    home: &Path,
    vars: &HashMap<String, String>,
    keychain: &(dyn Fn() -> bool + Sync),
) -> bool {
    if CLAUDE_SIGNED_IN_VARS.iter().any(|name| {
        vars.get(*name)
            .is_some_and(|value| !value.trim().is_empty())
    }) {
        return true;
    }
    if account::claude_dir(home, None, vars)
        .join(".credentials.json")
        .is_file()
    {
        return true;
    }
    let records_account = std::fs::read_to_string(account::claude_json(home, None, vars))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|state| state.get("oauthAccount").is_some_and(|a| !a.is_null()));
    records_account || keychain()
}

/// Whether the keychain holds Claude Code's credentials. Only the item's
/// presence is asked for, never its secret, so the system does not ask the
/// user for leave.
#[cfg(target_os = "macos")]
fn keychain_holds_claude() -> bool {
    std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "macos"))]
fn keychain_holds_claude() -> bool {
    false
}

/// Whether Codex has credentials: the file its sign-in writes.
fn codex_signed_in(home: &Path, vars: &HashMap<String, String>) -> bool {
    account::codex_home(home, None, vars)
        .join("auth.json")
        .is_file()
}

fn install(id: &str) -> Install {
    let (command, link) = match id {
        "claude-code" => (
            Some(if cfg!(windows) {
                "irm https://claude.ai/install.ps1 | iex"
            } else {
                "curl -fsSL https://claude.ai/install.sh | bash"
            }),
            "https://code.claude.com/docs/en/setup",
        ),
        "codex" => (
            Some("npm install -g @openai/codex"),
            "https://developers.openai.com/codex/cli",
        ),
        _ => (
            if cfg!(target_os = "macos") {
                Some("xcode-select --install")
            } else if cfg!(windows) {
                Some("winget install --id Git.Git -e")
            } else {
                None
            },
            "https://git-scm.com/downloads",
        ),
    };
    Install {
        command: command.map(str::to_string),
        link: link.to_string(),
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Welcome {
    seen: bool,
}

fn welcome_path(home: &Path) -> PathBuf {
    crate::home::dir(home).join("welcome.json")
}

/// Whether the welcome is due at this launch. The first launch on a
/// machine notes it as due, so it is shown again until it is gone through;
/// a launch that finds settings but no note is one from a version without
/// a welcome, and notes it as seen.
pub fn welcome_due(home: &Path) -> bool {
    let path = welcome_path(home);
    if let Ok(text) = std::fs::read_to_string(&path) {
        return serde_json::from_str::<Welcome>(&text).is_ok_and(|welcome| !welcome.seen);
    }
    let first = !crate::settings::settings_path(home).exists();
    write_welcome(home, !first);
    first
}

/// Notes the welcome as gone through.
pub fn welcome_seen(home: &Path) {
    write_welcome(home, true);
}

fn write_welcome(home: &Path, seen: bool) {
    let path = welcome_path(home);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&Welcome { seen }) {
        let _ = std::fs::write(&path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    fn no_keychain() -> bool {
        false
    }

    fn vars(path: &Path) -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), path.to_string_lossy().to_string())])
    }

    #[cfg(unix)]
    fn program(dir: &Path, name: &str, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn by_id<'a>(setup: &'a Setup, id: &str) -> &'a Check {
        setup.checks.iter().find(|check| check.id == id).unwrap()
    }

    #[test]
    fn reads_the_version_out_of_each_programs_line() {
        assert_eq!(
            version_in("2.1.3 (Claude Code)\n").as_deref(),
            Some("2.1.3")
        );
        assert_eq!(version_in("codex-cli 0.63.0").as_deref(), Some("0.63.0"));
        assert_eq!(
            version_in("git version 2.50.1 (Apple Git-155)").as_deref(),
            Some("2.50.1")
        );
        assert_eq!(
            version_in("git version 2.47.1.windows.2").as_deref(),
            Some("2.47.1")
        );
        assert_eq!(version_in("v1.4.0").as_deref(), Some("1.4.0"));
        assert_eq!(version_in("no version here"), None);
        assert_eq!(version_in("build 12"), None);
    }

    #[cfg(unix)]
    #[test]
    fn finds_each_program_with_its_version_and_misses_the_absent_one() {
        let home = Scratch::new("setup-found");
        let bin = Scratch::new("setup-found-bin");
        program(&bin, "claude", "echo '2.1.3 (Claude Code)'");
        program(&bin, "codex", "echo 'codex-cli 0.63.0'");
        let setup = check_with(&home, &vars(&bin), true, &no_keychain);
        let ids: Vec<&str> = setup.checks.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["claude-code", "codex", "git"]);
        let claude = by_id(&setup, "claude-code");
        assert_eq!(
            claude.path.as_deref(),
            Some(&*bin.join("claude").to_string_lossy())
        );
        assert_eq!(claude.version.as_deref(), Some("2.1.3"));
        assert_eq!(by_id(&setup, "codex").version.as_deref(), Some("0.63.0"));
        let git = by_id(&setup, "git");
        assert_eq!((git.path.as_deref(), git.version.as_deref()), (None, None));
        assert_eq!(git.signed_in, None);
        assert!(setup.agent_found());
    }

    #[cfg(unix)]
    #[test]
    fn no_agent_on_the_path_is_no_agent_found() {
        let home = Scratch::new("setup-none");
        let bin = Scratch::new("setup-none-bin");
        program(&bin, "git", "echo 'git version 2.50.1'");
        let setup = check_with(&home, &vars(&bin), true, &no_keychain);
        assert!(!setup.agent_found());
        assert_eq!(by_id(&setup, "git").version.as_deref(), Some("2.50.1"));
        assert_eq!(by_id(&setup, "claude-code").signed_in, None);
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_on_the_path_is_seen_without_running_it() {
        let bin = Scratch::new("setup-on-path-bin");
        program(&bin, "git", "echo 'git version 2.50.1'");
        assert!(!agent_on_path_in(&vars(&bin)));
        program(&bin, "codex", "exit 1");
        assert!(agent_on_path_in(&vars(&bin)));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_fails_its_version_is_found_without_one() {
        let home = Scratch::new("setup-fails");
        let bin = Scratch::new("setup-fails-bin");
        program(&bin, "codex", "echo 'codex-cli 0.63.0'; exit 3");
        let setup = check_with(&home, &vars(&bin), true, &no_keychain);
        let codex = by_id(&setup, "codex");
        assert!(codex.path.is_some());
        assert_eq!(codex.version, None);
    }

    #[cfg(unix)]
    #[test]
    fn sign_in_is_read_from_the_credentials_each_agent_leaves() {
        let home = Scratch::new("setup-signed");
        let bin = Scratch::new("setup-signed-bin");
        program(&bin, "claude", "echo 2.1.3");
        program(&bin, "codex", "echo 0.63.0");
        let signed = |setup: &Setup, id: &str| by_id(setup, id).signed_in;

        let setup = check_with(&home, &vars(&bin), true, &no_keychain);
        assert_eq!(signed(&setup, "claude-code"), Some(false));
        assert_eq!(signed(&setup, "codex"), Some(false));

        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/.credentials.json"), "{}").unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/auth.json"), "{}").unwrap();
        let setup = check_with(&home, &vars(&bin), true, &no_keychain);
        assert_eq!(signed(&setup, "claude-code"), Some(true));
        assert_eq!(signed(&setup, "codex"), Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn claude_counts_as_signed_in_by_key_state_or_keychain() {
        let home = Scratch::new("setup-claude-ways");
        let bin = Scratch::new("setup-claude-ways-bin");
        program(&bin, "claude", "echo 2.1.3");
        let signed = |vars: &HashMap<String, String>, keychain: &(dyn Fn() -> bool + Sync)| {
            by_id(&check_with(&home, vars, true, keychain), "claude-code").signed_in
        };
        let mut with_key = vars(&bin);
        with_key.insert("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string());
        assert_eq!(signed(&with_key, &no_keychain), Some(true));
        assert_eq!(signed(&vars(&bin), &|| true), Some(true));

        std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":null}"#).unwrap();
        assert_eq!(signed(&vars(&bin), &no_keychain), Some(false));
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"someone@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(signed(&vars(&bin), &no_keychain), Some(true));
    }

    #[test]
    fn every_check_says_where_to_install_it() {
        for wanted in &WANTED {
            assert!(install(wanted.id).link.starts_with("https://"));
        }
        assert!(install("claude-code").command.is_some());
        assert!(install("codex").command.is_some());
    }

    #[test]
    fn the_first_launch_is_due_until_the_welcome_is_gone_through() {
        let home = Scratch::new("setup-welcome-first");
        assert!(welcome_due(&home));
        assert!(welcome_due(&home));
        welcome_seen(&home);
        assert!(!welcome_due(&home));
    }

    #[test]
    fn a_launch_after_a_version_without_a_welcome_is_not_due() {
        let home = Scratch::new("setup-welcome-update");
        let settings = crate::settings::settings_path(&home);
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, "{}").unwrap();
        assert!(!welcome_due(&home));
        std::fs::remove_file(&settings).unwrap();
        assert!(!welcome_due(&home));
    }
}
