//! What a shell command hands over: the commands a shell runs from it,
//! read as the shell reads them, and which of those push or open or merge
//! a pull request.

/// Whether a shell command hands the work over: a pull request opened or
/// merged with gh or written to with gh api, or a push with git, as a
/// command the shell runs. That is the first word of a command, after
/// assignments, redirections and wrappers such as env and sudo, there or
/// in a command substitution, an `sh -c` string or an eval. A word that
/// only mentions a push, in a message or a search, is not one, and a dry
/// run does not count. A git command given an alias or configuration of
/// its own for the one run, or a home or repository to read it from,
/// counts as a push, since the alias may be one.
/// The text of a here-document or a here-string is read as commands too,
/// since a shell may be what reads it, so one whose lines start with a push
/// counts, and so is the command find, flock, parallel or watch runs. What
/// is not known before the command runs counts as a hand-over when it may
/// be one: a shell reading a pipe, a redirected input or a process
/// substitution, git or gh given the rest of their words by xargs or
/// parallel, and a command or subcommand named by an expansion or a
/// placeholder. A push a script, an alias
/// set beforehand, another program such as an interpreter, or a command run
/// on another machine over ssh makes is not seen.
pub fn hands_over(command: &str) -> bool {
    hands_over_in(command, 0)
}

/// How deep commands are read inside one another before the command
/// counts as a hand-over, unread.
const DEEPEST: u32 = 16;

fn hands_over_in(command: &str, depth: u32) -> bool {
    if depth > DEEPEST {
        return true;
    }
    let mut lexer = Lexer {
        chars: command.chars().collect(),
        at: 0,
        found: Vec::new(),
        piped: Vec::new(),
        bodies: Vec::new(),
        depth: 0,
        too_deep: false,
    };
    lexer.read(None);
    lexer.too_deep
        || lexer.found.iter().enumerate().any(|(at, words)| {
            let words: Vec<&str> = words.iter().map(String::as_str).collect();
            runs_a_hand_over(&words, depth, lexer.piped.contains(&at))
        })
        || lexer
            .bodies
            .iter()
            .any(|body| hands_over_in(body, depth + 1))
}

/// Reads a command into its simple commands, each as its words with quotes
/// taken off and redirections left out, those in command substitutions
/// among them, and the text of its here-documents and here-strings. A
/// command substitution leaves a `$` in its word, for what it puts there
/// is not known, and a process substitution leaves `<(` or `>(` as its
/// word. A command whose input is redirected from a file or a process is
/// counted as given a pipe's output.
struct Lexer {
    chars: Vec<char>,
    at: usize,
    found: Vec<Vec<String>>,
    /// Which of the commands found read what a pipe gives them.
    piped: Vec<usize>,
    bodies: Vec<String>,
    depth: u32,
    too_deep: bool,
}

/// The words of the simple command being read.
#[derive(Default)]
struct Words {
    words: Vec<String>,
    word: String,
    in_word: bool,
    quoted: bool,
    /// The next word is a redirection's target.
    target: bool,
    /// The next word is a here-document's delimiter, its tabs taken off
    /// when true.
    delimiter: Option<bool>,
    heredocs: Vec<(String, bool)>,
    /// The next word is a here-string's.
    here_string: bool,
    /// The here-strings read.
    strings: Vec<String>,
    /// The command being read is given a pipe's output.
    piped: bool,
}

impl Words {
    fn push(&mut self, c: char) {
        self.word.push(c);
        self.in_word = true;
    }

    fn end_word(&mut self) {
        if self.in_word {
            let word = std::mem::take(&mut self.word);
            if let Some(strip) = self.delimiter.take() {
                self.heredocs.push((word, strip));
            } else if self.here_string {
                self.here_string = false;
                self.strings.push(word);
            } else if self.target {
                self.target = false;
            } else {
                self.words.push(word);
            }
        }
        self.in_word = false;
        self.quoted = false;
    }

    fn end_command(&mut self, found: &mut Vec<Vec<String>>, piped: &mut Vec<usize>) {
        self.end_word();
        self.target = false;
        if !self.words.is_empty() {
            if std::mem::take(&mut self.piped) {
                piped.push(found.len());
            }
            found.push(std::mem::take(&mut self.words));
        }
    }

    /// Whether the word so far is a file descriptor a redirection names.
    fn is_descriptor(&self) -> bool {
        !self.quoted && !self.word.is_empty() && self.word.chars().all(|c| c.is_ascii_digit())
    }
}

impl Lexer {
    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).copied()
    }

    /// Reads simple commands until `closer`, a `)` or a backtick that ends
    /// a command substitution, or the end.
    fn read(&mut self, closer: Option<char>) {
        self.depth += 1;
        if self.depth > DEEPEST {
            self.too_deep = true;
            self.at = self.chars.len();
            return;
        }
        let mut words = Words::default();
        let mut parens = 0u32;
        while let Some(c) = self.peek(0) {
            match c {
                '`' if closer == Some('`') => {
                    self.at += 1;
                    break;
                }
                ')' if closer == Some(')') && parens == 0 => {
                    self.at += 1;
                    break;
                }
                ' ' | '\t' => {
                    self.at += 1;
                    words.end_word();
                }
                '\n' => {
                    self.at += 1;
                    words.end_command(&mut self.found, &mut self.piped);
                    for (delimiter, strip) in std::mem::take(&mut words.heredocs) {
                        let body = self.heredoc(&delimiter, strip);
                        self.bodies.push(body);
                    }
                }
                '#' if !words.in_word => {
                    while self.peek(0).is_some_and(|c| c != '\n') {
                        self.at += 1;
                    }
                }
                '<' | '>' if self.peek(1) == Some('(') => {
                    words.end_word();
                    words.push(c);
                    words.push('(');
                    self.at += 2;
                    self.read(Some(')'));
                }
                '<' | '>' => self.redirection(&mut words),
                '&' if self.peek(1) == Some('>') => {
                    words.end_word();
                    self.at += 1;
                    self.redirection(&mut words);
                }
                ';' | '|' | '&' | '(' | ')' => {
                    let or = c == '|' && self.peek(1) == Some('|');
                    let pipe = c == '|' && !or;
                    self.at += if or { 2 } else { 1 };
                    match c {
                        '(' => parens += 1,
                        ')' => parens = parens.saturating_sub(1),
                        _ => {}
                    }
                    words.end_command(&mut self.found, &mut self.piped);
                    words.piped |= pipe;
                }
                '\\' => {
                    self.at += 1;
                    match self.peek(0) {
                        Some('\n') => self.at += 1,
                        Some(next) => {
                            self.at += 1;
                            words.quoted = true;
                            words.push(next);
                        }
                        None => words.push('\\'),
                    }
                }
                '\'' => {
                    self.at += 1;
                    words.quoted = true;
                    words.in_word = true;
                    while let Some(c) = self.peek(0) {
                        self.at += 1;
                        if c == '\'' {
                            break;
                        }
                        words.word.push(c);
                    }
                }
                '"' => {
                    self.at += 1;
                    words.quoted = true;
                    words.in_word = true;
                    self.double_quoted(&mut words);
                }
                '$' if self.peek(1) == Some('(') => {
                    self.at += 2;
                    self.read(Some(')'));
                    words.push('$');
                }
                '$' if self.peek(1) == Some('\'') => {
                    self.at += 2;
                    words.quoted = true;
                    words.in_word = true;
                    while let Some(c) = self.peek(0) {
                        self.at += 1;
                        match c {
                            '\'' => break,
                            '\\' => {
                                if let Some(next) = self.peek(0) {
                                    self.at += 1;
                                    words.word.push(next);
                                }
                            }
                            c => words.word.push(c),
                        }
                    }
                }
                '`' => {
                    self.at += 1;
                    self.read(Some('`'));
                    words.push('$');
                }
                c => {
                    self.at += 1;
                    words.push(c);
                }
            }
        }
        words.end_command(&mut self.found, &mut self.piped);
        self.bodies.append(&mut words.strings);
        self.depth -= 1;
    }

    /// Reads a double-quoted part of a word, after its opening quote,
    /// reading the commands substituted in it.
    fn double_quoted(&mut self, words: &mut Words) {
        while let Some(c) = self.peek(0) {
            match c {
                '"' => {
                    self.at += 1;
                    return;
                }
                '\\' => {
                    self.at += 1;
                    match self.peek(0) {
                        Some('\n') => self.at += 1,
                        Some(next @ ('$' | '`' | '"' | '\\')) => {
                            self.at += 1;
                            words.word.push(next);
                        }
                        _ => words.word.push('\\'),
                    }
                }
                '$' if self.peek(1) == Some('(') => {
                    self.at += 2;
                    self.read(Some(')'));
                    words.word.push('$');
                }
                '`' => {
                    self.at += 1;
                    self.read(Some('`'));
                    words.word.push('$');
                }
                c => {
                    self.at += 1;
                    words.word.push(c);
                }
            }
        }
    }

    /// Reads a redirection at `<`, `>` or after `&`: its operator, then its
    /// target or here-document delimiter as the next word, none of which
    /// is a word of the command.
    fn redirection(&mut self, words: &mut Words) {
        if words.is_descriptor() {
            words.word.clear();
            words.in_word = false;
        } else {
            words.end_word();
        }
        if self.peek(0) == Some('<') && self.peek(1) == Some('<') {
            if self.peek(2) == Some('<') {
                self.at += 3;
                words.here_string = true;
                return;
            }
            self.at += 2;
            let strip = self.peek(0) == Some('-');
            if strip {
                self.at += 1;
            }
            words.delimiter = Some(strip);
            return;
        }
        let input = self.peek(0) == Some('<') && self.peek(1) != Some('>');
        while self.peek(0).is_some_and(|c| matches!(c, '<' | '>')) {
            self.at += 1;
        }
        if self.peek(0).is_some_and(|c| matches!(c, '&' | '|')) {
            self.at += 1;
            if self.peek(0).is_some_and(|c| c.is_ascii_digit() || c == '-') {
                while self.peek(0).is_some_and(|c| c.is_ascii_digit() || c == '-') {
                    self.at += 1;
                }
                return;
            }
        }
        words.piped |= input;
        words.target = true;
    }

    /// Reads a here-document's lines through the one that ends it, and
    /// gives them back; all that is left when no line ends it.
    fn heredoc(&mut self, delimiter: &str, strip: bool) -> String {
        let mut body = String::new();
        while self.at < self.chars.len() {
            let start = self.at;
            while self.peek(0).is_some_and(|c| c != '\n') {
                self.at += 1;
            }
            let line: String = self.chars[start..self.at].iter().collect();
            if self.peek(0) == Some('\n') {
                self.at += 1;
            }
            let line = if strip {
                line.trim_start_matches('\t')
            } else {
                &line
            };
            if line == delimiter {
                break;
            }
            body.push_str(line);
            body.push('\n');
        }
        body
    }
}

/// Words before a command that set a variable for it.
fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let name = name.strip_suffix('+').unwrap_or(name);
    let name = name.split_once('[').map_or(name, |(name, _)| name);
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Words of the shell's grammar that come before a command.
const KEYWORDS: &[&str] = &[
    "!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case",
    "esac", "in", "[[", "]]",
];

/// Commands that run the command after them, with their options that take
/// the next word as their value.
const WRAPPERS: &[(&str, &[&str])] = &[
    ("env", &["-u", "--unset", "-C", "--chdir"]),
    ("command", &[]),
    ("builtin", &[]),
    ("exec", &["-a"]),
    ("nohup", &[]),
    ("nice", &["-n", "--adjustment"]),
    ("time", &["-f", "--format", "-o", "--output"]),
    ("timeout", &["-s", "--signal", "-k", "--kill-after"]),
    (
        "sudo",
        &[
            "-u",
            "--user",
            "-g",
            "--group",
            "-p",
            "--prompt",
            "-C",
            "--close-from",
            "-D",
            "--chdir",
            "-r",
            "--role",
            "-t",
            "--type",
            "-U",
            "--other-user",
            "-T",
            "--command-timeout",
            "-h",
            "--host",
        ],
    ),
    ("doas", &["-u", "-C"]),
    ("stdbuf", &["-i", "-o", "-e"]),
    ("ionice", &["-c", "--class", "-n", "--classdata"]),
    ("setsid", &[]),
    ("caffeinate", &["-t", "-w"]),
    (
        "xargs",
        &[
            "-I",
            "-L",
            "-n",
            "-P",
            "-s",
            "-E",
            "-d",
            "-a",
            "--max-args",
            "--max-procs",
            "--delimiter",
            "--arg-file",
            "--max-lines",
            "--eof",
        ],
    ),
];

/// Shells whose `-c` string is a command of its own.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish"];

/// What a command that runs another gives it: more words from its input
/// when `fed`, and the string it puts its input in place of.
#[derive(Clone, Copy, Default)]
struct Feed<'a> {
    fed: bool,
    placeholder: Option<&'a str>,
}

impl Feed<'_> {
    /// Whether a word is not known before the command runs: made by an
    /// expansion, or put in place of the placeholder.
    fn unknown(&self, word: &str) -> bool {
        word.contains(['$', '*', '?', '['])
            || self
                .placeholder
                .is_some_and(|placeholder| word.contains(placeholder))
    }
}

/// Whether one simple command, as its words, hands the work over, the
/// command given a pipe's output when `piped`.
fn runs_a_hand_over(words: &[&str], depth: u32, piped: bool) -> bool {
    runs_fed(words, depth, piped, Feed::default())
}

/// Whether one simple command hands the work over, given what `feed` says
/// a command that runs it gives it. A command's name is read without
/// regard to case, as a file system that ignores case finds it, and a name
/// an expansion makes counts as git or gh for any words a push or a pull
/// request is made with, for words an expansion makes, or for none. A
/// subcommand an expansion or a placeholder makes counts as a push or a
/// pull request.
fn runs_fed<'a>(words: &[&'a str], depth: u32, piped: bool, mut feed: Feed<'a>) -> bool {
    let mut at = 0;
    let mut configured = false;
    loop {
        while let Some(word) = words
            .get(at)
            .filter(|word| is_assignment(word) || KEYWORDS.contains(word))
        {
            configured |= brings_in_config(word);
            at += 1;
        }
        let Some(first) = words.get(at) else {
            return false;
        };
        let name = first
            .rsplit('/')
            .next()
            .unwrap_or(first)
            .to_ascii_lowercase();
        let name = name.as_str();
        let rest = &words[at + 1..];
        if feed.unknown(name) {
            return rest.is_empty()
                || rest.iter().any(|word| {
                    feed.unknown(word)
                        || matches!(
                            word.to_ascii_lowercase().as_str(),
                            "push" | "send-pack" | "pr" | "api"
                        )
                });
        }
        if let Some((wrapper, valued)) = WRAPPERS.iter().find(|(wrapper, _)| *wrapper == name) {
            let xargs = *wrapper == "xargs";
            feed.fed |= xargs;
            at += 1;
            while let Some(&word) = words.get(at).filter(|word| word.starts_with('-')) {
                at += 1;
                if word == "--" {
                    break;
                }
                if xargs {
                    if let Some(placeholder) = placeholder(word, words.get(at).copied()) {
                        feed.placeholder = Some(placeholder);
                    }
                }
                if *wrapper == "command" && matches!(word, "-v" | "-V") {
                    return false;
                }
                if *wrapper == "env" && (word == "-S" || word == "--split-string") {
                    let script = words[at..].join(" ");
                    return hands_over_in(&script, depth + 1);
                }
                if let Some(split) = word.strip_prefix("-S").filter(|_| *wrapper == "env") {
                    let script = [split].into_iter().chain(words[at..].iter().copied());
                    return hands_over_in(&script.collect::<Vec<_>>().join(" "), depth + 1);
                }
                if valued.contains(&word) {
                    at += 1;
                }
            }
            if *wrapper == "timeout" {
                at += 1;
            }
            continue;
        }
        return match name {
            "git" => configured || git_hands_over(rest, feed),
            "git-push" => !dry_run(rest, true),
            "git-send-pack" => !dry_run(rest, false),
            "gh" => {
                let found: Vec<&str> = subcommands(rest, GH_VALUED)
                    .into_iter()
                    .map(|at| rest[at])
                    .collect();
                match found.as_slice() {
                    [first, ..] if feed.unknown(first) => true,
                    ["pr", second, ..] if feed.unknown(second) => true,
                    ["pr", "create" | "merge", ..] => true,
                    ["api", path, ..] if feed.unknown(path) => feed.fed || sends(rest),
                    ["api", ..] => feed.fed || writes_a_pull_request(rest),
                    [] | ["pr"] => feed.fed,
                    _ => false,
                }
            }
            "eval" => hands_over_in(&rest.join(" "), depth + 1),
            "coproc" | "flock" | "watch" => runs_from_any_word(rest, depth, Feed::default()),
            "parallel" => {
                let placeholder = rest
                    .iter()
                    .enumerate()
                    .find_map(|(at, word)| placeholder(word, rest.get(at + 1).copied()));
                let feed = Feed {
                    fed: true,
                    placeholder,
                };
                let command = rest
                    .iter()
                    .position(|word| word.starts_with(":::"))
                    .map_or(rest, |end| &rest[..end]);
                runs_from_any_word(command, depth, feed)
            }
            "find" => found_execs(rest, depth),
            "source" | "." => rest
                .first()
                .is_some_and(|script| script_from_input(script, piped)),
            shell if SHELLS.contains(&shell) => match shell_string(rest) {
                Some(script) => hands_over_in(script, depth + 1),
                None => reads_its_input(rest, piped),
            },
            _ => false,
        };
    }
}

/// Whether an assignment before a command may give git configuration of
/// its own, an alias among it: git's configuration variables, or the
/// home, configuration directory or repository it reads configuration
/// from.
fn brings_in_config(word: &str) -> bool {
    let name = word.split_once('=').map_or(word, |(name, _)| name);
    (name.starts_with("GIT_CONFIG") && name != "GIT_CONFIG_NOSYSTEM")
        || matches!(
            name,
            "HOME" | "XDG_CONFIG_HOME" | "GIT_DIR" | "GIT_COMMON_DIR"
        )
}

/// The string xargs or parallel puts its input in place of, given by the
/// option `word`, `next` the word after it: `-I` and its value, or `-i`
/// and `--replace`, `{}` unless one is given with it.
fn placeholder<'a>(word: &'a str, next: Option<&'a str>) -> Option<&'a str> {
    let given = |placeholder: &'a str| (!placeholder.is_empty()).then_some(placeholder);
    match word {
        "-I" => next.and_then(given),
        "-i" | "--replace" => Some("{}"),
        word => word
            .strip_prefix("--replace=")
            .or_else(|| word.strip_prefix("-I"))
            .or_else(|| word.strip_prefix("-i"))
            .and_then(given),
    }
}

/// Whether a script a shell runs is read from its input: a process
/// substitution, or, given a pipe's output when `piped`, `-` or the
/// input's device.
fn script_from_input(script: &str, piped: bool) -> bool {
    script.starts_with("<(")
        || script.starts_with("/dev/fd/")
        || (piped && matches!(script, "-" | "/dev/stdin"))
}

/// How much deeper a command that runs another counts for than one read
/// inside another, since what it runs is looked for from each of its
/// words.
const RUNS_ANOTHER: u32 = 4;

/// Whether the words, from any one of them on, or any one of them as a
/// string a shell runs, hand the work over: for a command that runs one
/// after names, options and values this does not tell apart. The words
/// parallel puts its arguments in with are left out, and for parallel the
/// command is the words before its arguments, given the rest by `feed`.
fn runs_from_any_word<'a>(words: &[&'a str], depth: u32, feed: Feed<'a>) -> bool {
    let depth = depth + RUNS_ANOTHER;
    if depth > DEEPEST {
        return true;
    }
    let words: Vec<&str> = words
        .iter()
        .copied()
        .filter(|word| !word.starts_with(":::") && !(word.starts_with('{') && word.ends_with('}')))
        .collect();
    (0..words.len())
        .any(|at| runs_fed(&words[at..], depth, false, feed) || hands_over_in(words[at], depth + 1))
}

/// Whether a command find runs for what it finds hands the work over.
fn found_execs(words: &[&str], depth: u32) -> bool {
    let depth = depth + RUNS_ANOTHER;
    if depth > DEEPEST {
        return true;
    }
    words.iter().enumerate().any(|(at, word)| {
        matches!(*word, "-exec" | "-execdir" | "-ok" | "-okdir") && {
            let run = &words[at + 1..];
            let end = run
                .iter()
                .position(|word| matches!(*word, ";" | "+"))
                .unwrap_or(run.len());
            runs_a_hand_over(&run[..end], depth, false)
        }
    })
}

/// A shell's options that take the next word as their value.
const SHELL_VALUED: &[&str] = &["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

/// Whether a shell given no `-c` reads its commands from what its input
/// gives it, given a pipe's output when `piped`: given no script to run,
/// or given `-s`, or a script read from its input.
fn reads_its_input(words: &[&str], piped: bool) -> bool {
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if *word == "--" {
            continue;
        }
        if SHELL_VALUED.contains(word) {
            rest.next();
        } else if word.len() > 1 && (word.starts_with('-') || word.starts_with('+')) {
            if !word.starts_with("--") && word.contains('s') {
                return piped;
            }
        } else {
            return script_from_input(word, piped);
        }
    }
    piped
}

/// The string a shell given `-c`, alone or among other options, runs.
fn shell_string<'a>(words: &[&'a str]) -> Option<&'a str> {
    let mut given_c = false;
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if *word == "--" {
            continue;
        }
        if SHELL_VALUED.contains(word) {
            rest.next();
        } else if word.len() > 1 && (word.starts_with('-') || word.starts_with('+')) {
            given_c |= !word.starts_with("--") && word.contains('c');
        } else {
            return given_c.then_some(*word);
        }
    }
    None
}

/// Whether git's words hand the work over, given what `feed` says.
fn git_hands_over(words: &[&str], feed: Feed) -> bool {
    if gives_an_alias(words) {
        return true;
    }
    let at = subcommands(words, GIT_VALUED);
    let found: Vec<String> = at
        .iter()
        .map(|&at| words[at].to_ascii_lowercase())
        .collect();
    let found: Vec<&str> = found.iter().map(String::as_str).collect();
    let unknown = |nth: usize| at.get(nth).is_some_and(|&at| feed.unknown(words[at]));
    match found.as_slice() {
        [_, ..] if unknown(0) => true,
        ["subtree", _, ..] if unknown(1) => true,
        ["push" | "send-pack", ..] => !dry_run(&words[at[0] + 1..], found[0] == "push"),
        ["subtree", "push", ..] => true,
        [] | ["subtree"] => feed.fed,
        _ => false,
    }
}

/// Whether git's words give it an alias of their own, with `-c` or
/// `--config-env`, the key in any case, or configuration an alias may be
/// in, with an include.
fn gives_an_alias(words: &[&str]) -> bool {
    let alias = |key: &str| {
        let key = key.to_ascii_lowercase();
        ["alias.", "include.", "includeif."]
            .iter()
            .any(|section| key.starts_with(section))
    };
    words.iter().enumerate().any(|(at, word)| match *word {
        "-c" | "--config-env" => words.get(at + 1).is_some_and(|key| alias(key)),
        word => word
            .strip_prefix("--config-env=")
            .or_else(|| word.strip_prefix("-c"))
            .is_some_and(alias),
    })
}

/// Whether a push's options make it a dry run, as git reads them: the
/// last of `--dry-run` and `--no-dry-run`, or for git push `-n` alone or
/// among short options, each written whole or cut short as git allows.
/// The value an option takes is never read as one, and an option cut so
/// short it may take a value is taken to.
fn dry_run(words: &[&str], short: bool) -> bool {
    let mut dry = false;
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if *word == "--" {
            break;
        }
        if let Some(long) = word.strip_prefix("--") {
            let (name, value) = long
                .split_once('=')
                .map_or((long, None), |(n, v)| (n, Some(v)));
            let cut = |whole: &str| name.len() >= 2 && whole.starts_with(name);
            if value.is_none() && PUSH_VALUED.iter().any(|whole| cut(whole)) {
                rest.next();
            }
            if name.len() >= 4 && "no-dry-run".starts_with(name) {
                dry = false;
            } else if cut("dry-run") {
                dry = true;
            }
        } else if let Some(flags) = word.strip_prefix('-').filter(|_| short) {
            for (at, flag) in flags.char_indices() {
                match flag {
                    'n' => dry = true,
                    'o' => {
                        if at + 1 == flags.len() {
                            rest.next();
                        }
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    dry
}

/// git push's long options that take the next word as their value.
const PUSH_VALUED: &[&str] = &[
    "push-option",
    "repo",
    "receive-pack",
    "exec",
    "recurse-submodules",
];

/// Whether the words after gh api write to a pull request or a branch: a
/// path or a query that names pull requests, merges, refs or a branch's
/// files, sent with a method or fields, which make the call one that
/// writes, or a query read from a file or the input, which is not seen.
fn writes_a_pull_request(words: &[&str]) -> bool {
    let names = words.iter().any(|word| {
        [
            "pulls",
            "PullRequest",
            "/merges",
            "merge-upstream",
            "git/refs",
            "/contents",
        ]
        .iter()
        .any(|name| word.contains(name))
    });
    let unread = words.contains(&"graphql")
        && words
            .iter()
            .any(|word| word.contains("=@") || word.starts_with("--input"));
    names && sends(words) || unread
}

/// Whether gh api's words send a method or fields, which make the call one
/// that writes.
fn sends(words: &[&str]) -> bool {
    words.iter().any(|word| {
        [
            "-X",
            "--method",
            "-f",
            "-F",
            "--field",
            "--raw-field",
            "--input",
        ]
        .iter()
        .any(|option| *word == *option || word.starts_with(&format!("{option}=")))
            || word.starts_with("-X")
    })
}

/// git's own options that take the next word as their value.
const GIT_VALUED: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
];
/// gh's own options that take the next word as their value.
const GH_VALUED: &[&str] = &["-R", "--repo", "--hostname"];

/// Where the first two words after a command's options are, skipping the
/// values of those that take one.
fn subcommands(words: &[&str], valued: &[&str]) -> Vec<usize> {
    let mut found = Vec::new();
    let mut rest = words.iter().enumerate();
    while let Some((at, word)) = rest.next() {
        if valued.contains(word) {
            rest.next();
        } else if !word.starts_with('-') {
            found.push(at);
            if found.len() == 2 {
                break;
            }
        }
    }
    found
}
