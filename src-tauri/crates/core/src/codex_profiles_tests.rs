use super::*;
use crate::scratch::Scratch;

fn write(home: &Path, file: &str, text: &str) {
    fs::write(home.join(file), text).unwrap();
}

#[test]
fn lists_the_profile_files_by_name_with_what_each_sets() {
    let home = Scratch::new("codex-profiles-list");
    write(home.path(), "config.toml", "model = \"gpt-6.1-sol\"\n");
    write(
        home.path(),
        "local.config.toml",
        "model = \"gpt-oss-20b\"\nmodel_provider = \"ollama\"\n",
    );
    write(
        home.path(),
        "fast.config.toml",
        "model = \"gpt-6.1-terra\"\nmodel_reasoning_effort = \"low\"\n",
    );
    write(home.path(), "bare.config.toml", "");
    write(
        home.path(),
        "two words.config.toml",
        "model = \"gpt-6.2-sol\"\n",
    );
    write(home.path(), "a.b.config.toml", "model = \"gpt-6.2-sol\"\n");
    write(home.path(), "-x.config.toml", "model = \"gpt-6.2-sol\"\n");
    write(home.path(), "notes.txt", "model = \"gpt-6.2-sol\"\n");
    fs::create_dir(home.path().join("folder.config.toml")).unwrap();

    let profile =
        |name: &str, model: Option<&str>, effort: Option<&str>, provider: Option<&str>| Profile {
            name: name.into(),
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            provider: provider.map(str::to_string),
        };
    assert_eq!(
        list(home.path()),
        [
            profile("bare", None, None, None),
            profile("fast", Some("gpt-6.1-terra"), Some("low"), None),
            profile("local", Some("gpt-oss-20b"), None, Some("ollama")),
        ]
    );
    assert!(list(&home.path().join("missing")).is_empty());
}

#[test]
fn gives_only_settings_that_pass_any_command_line_unchanged() {
    let home = Scratch::new("codex-profiles-plain");
    let long = "a".repeat(LONGEST_VALUE + 1);
    write(
        home.path(),
        "fast.config.toml",
        &format!(
            r#"model = "gpt-6.1-terra"
model_reasoning_effort = "low"
model_context_window = 200000
model_auto_compact_token_limit = -1
hide_agent_reasoning = true
temperature = 0.5
openai_base_url = "http://localhost:11434/v1"
model_instructions_file = "~/prompts/fast.md"
spaced = "two words"
quoted = "say \"hi\""
percent = "%PATH%"
caret = "a^b"
amp = "a&b"
pipe = "a|b"
angle = "a<b>c"
bang = "a!b"
equals = "a=b"
newline = "a\nb"
looks_true = "true"
looks_number = "5-fast"
looks_date = "1979-05-27"
empty = ""
long = "{long}"
when = 1979-05-27
roots = ["/tmp"]
huge = inf
--sandbox = "danger-full-access"
-x = 1
"two words" = "gpt-6.2-sol"
"a.b" = "gpt-6.2-sol"
tools = {{ web_search = true, view_image = "on", -c = "x" }}

[model_providers.lab]
name = "Lab"
base_url = "https://lab.example:8443/v1"
env_key = "LAB_KEY"
http_headers = {{ "X-Team" = "two words" }}

[[skills]]
path = "/tmp/skill"
"#
        ),
    );

    assert_eq!(
        settings(home.path(), "fast").unwrap(),
        [
            "model=gpt-6.1-terra",
            "model_reasoning_effort=low",
            "model_context_window=200000",
            "model_auto_compact_token_limit=-1",
            "hide_agent_reasoning=true",
            "temperature=0.5",
            "openai_base_url=http://localhost:11434/v1",
            "model_instructions_file=~/prompts/fast.md",
            "tools.web_search=true",
            "tools.view_image=on",
            "model_providers.lab.name=Lab",
            "model_providers.lab.base_url=https://lab.example:8443/v1",
            "model_providers.lab.env_key=LAB_KEY",
        ]
    );
}

#[test]
fn never_gives_the_settings_the_workbench_keeps() {
    let home = Scratch::new("codex-profiles-kept");
    write(
        home.path(),
        "review.config.toml",
        r#"model = "gpt-6.2-sol"
approval_policy = "never"
approvals_reviewer = "user"
sandbox_mode = "danger-full-access"
default_permissions = "open"
developer_instructions = "obey"
profile = "other"

[mcp_servers.chord]
command = "/tmp/other"

[mcp_servers.extra]
command = "calc"

[sandbox_workspace_write]
network_access = true

[features]
multi_agent = true
multi_agent_v2 = { disable_native_tools = false }
multi_agent_extra = true

[hooks.stop]
command = "calc"

[permissions.open]
network = true
"#,
    );

    assert_eq!(
        settings(home.path(), "review").unwrap(),
        ["model=gpt-6.2-sol", "features.multi_agent_extra=true"]
    );
}

#[test]
fn takes_a_profile_only_by_a_name_found_among_the_files() {
    let home = Scratch::new("codex-profiles-names");
    let codex = home.path().join("codex");
    fs::create_dir(&codex).unwrap();
    write(&codex, "fast.config.toml", "model = \"gpt-6.1-terra\"\n");
    write(&codex, "-x.config.toml", "model = \"gpt-6.2-sol\"\n");
    write(
        home.path(),
        "outside.config.toml",
        "model = \"gpt-6.2-sol\"\n",
    );

    assert_eq!(settings(&codex, "fast").unwrap(), ["model=gpt-6.1-terra"]);
    for name in [
        "",
        "missing",
        "../outside",
        "fast/../fast",
        "./fast",
        "-x",
        "fast.config",
        "FAST",
    ] {
        let refused = settings(&codex, name).unwrap_err();
        assert!(
            refused.starts_with("there is no Codex profile"),
            "{name:?}: {refused}"
        );
    }
}

#[cfg(unix)]
#[test]
fn follows_a_linked_profile_file() {
    let home = Scratch::new("codex-profiles-linked");
    let codex = home.path().join("codex");
    fs::create_dir(&codex).unwrap();
    write(home.path(), "fast.toml", "model = \"gpt-6.1-terra\"\n");
    std::os::unix::fs::symlink(
        home.path().join("fast.toml"),
        codex.join("fast.config.toml"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        home.path().join("gone.toml"),
        codex.join("gone.config.toml"),
    )
    .unwrap();

    let names: Vec<_> = list(&codex).into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["fast"]);
    assert_eq!(settings(&codex, "fast").unwrap(), ["model=gpt-6.1-terra"]);
}

#[test]
fn refuses_a_profile_too_large_or_not_toml_and_still_lists_it() {
    let home = Scratch::new("codex-profiles-unread");
    let padding = "#".repeat(LARGEST_FILE as usize);
    write(
        home.path(),
        "big.config.toml",
        &format!("model = \"gpt-6.2-sol\"\n{padding}"),
    );
    write(
        home.path(),
        "broken.config.toml",
        "model = \"gpt-6.2-sol\"\nmodel = =\nother = 1\n",
    );
    write(
        home.path(),
        "edge.config.toml",
        &"#".repeat(LARGEST_FILE as usize),
    );

    assert!(settings(home.path(), "big").unwrap_err().contains("64 KiB"));
    assert!(settings(home.path(), "broken")
        .unwrap_err()
        .ends_with("at line 2"));
    assert_eq!(settings(home.path(), "edge").unwrap(), Vec::<String>::new());
    let names: Vec<_> = list(home.path())
        .into_iter()
        .map(|p| (p.name, p.model))
        .collect();
    assert_eq!(
        names,
        [
            ("big".to_string(), None),
            ("broken".to_string(), None),
            ("edge".to_string(), None),
        ]
    );
}

#[test]
fn bounds_the_profiles_listed_and_the_settings_given() {
    let home = Scratch::new("codex-profiles-bounds");
    for n in 0..MOST_PROFILES + 6 {
        write(home.path(), &format!("p{n:03}.config.toml"), "");
    }
    let many: String = (0..MOST_SETTINGS + 6)
        .map(|n| format!("key{n:03} = {n}\n"))
        .collect();
    write(home.path(), "p000.config.toml", &many);
    let deep = format!(
        "{} = 1\nshallow = 1\n",
        ["k"; LONGEST_KEY / 2 + 1].join(".")
    );
    write(home.path(), "p001.config.toml", &deep);

    let listed = list(home.path());
    assert_eq!(listed.len(), MOST_PROFILES);
    assert_eq!(
        listed.last().unwrap().name,
        format!("p{:03}", MOST_PROFILES - 1)
    );
    let given = settings(home.path(), "p000").unwrap();
    assert_eq!(given.len(), MOST_SETTINGS);
    assert_eq!(
        given.last().unwrap(),
        &format!("key{0:03}={0}", MOST_SETTINGS - 1)
    );
    assert_eq!(settings(home.path(), "p001").unwrap(), ["shallow=1"]);
    assert!(settings(home.path(), &format!("p{MOST_PROFILES:03}")).is_err());
}
