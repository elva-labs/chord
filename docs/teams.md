# Teams

A team is the agents a lead may call and the gates their work passes. The
lead is the session the user starts with the team. It has no agent of its
own and, unless the team says otherwise, only reads and hands every piece
of work to a session of its own, as an orchestrator under a workflow does
(see [orchestrator](orchestrator.md)).

## What a team holds

A team has a name, its members and its gates.

A member is an [agent](settings.md#agents) by its title, with the models it
may run on, any where it lists none. Three sessions of a member may run at
once; the team does not set it.

A gate names the member who approves and when:

- **on the plan**, before building;
- **on the change**, before handing over.

A gate may name paths, as globs relative to the project such as `infra/**`,
and then holds only when the plan or the change touches one of them. In a
glob, `*` stands for any characters within one part of a path, `?` for one
character, and a part that is `**` for any number of parts. A gate may ask
for changes three times, and then waits for the user; the team does not
set it either.

Chord ships two teams:

- **Ship with checks**: a Researcher, Developers, a Tester, a Security
  reviewer, a Reviewer and a Cloud architect. The Security reviewer
  approves the plan and the change, the Cloud architect approves a plan
  that touches `infra/**`, and the Reviewer approves the change.
- **Quick fix**: Developers and a Reviewer, who approves the change.

How the settings file keeps them, how they are made and changed on the
Agents tab, and how a file from before teams is given its own, is in
[settings](reference/settings.md#teams). A team made from a
workflow keeps its agents and models, and not the orchestrator's model, how
many times a review may send the work back, or how many sessions a step
runs at once.

## A team's run

A run begins when its lead starts, with the team as it was then and the
commit the lead's folder was at. It records the sessions the lead starts as
the team's members, each with its agent, its brief and the folder it works
in, the plan the lead writes, the verdicts on its gates, and the user's
waivers. It is kept in a small database in the workbench's directory in the
user's home, and nothing of it is written into the project. A lead started
again with the team goes on with the run it has. The lead starts only the
team's agents in its run, and a session it starts outside the team is
refused.

A run ends when its lead's session is closed for good. An ended run is kept
for 30 days and then removed.

The plan is kept in versions, each with a hash of its text and the paths it
names, the paths sorted, so the same paths in another order are the same
plan. The paths are the lead's own list, and nothing checks them against
the work: a gate on some paths is needed when the plan names one of them
or a folder one of them is in. A path the lead leaves out puts its gate off
until the change touches it, and by then the building the gate was meant
to approve first is done.

The change is what each checkout the run's work is in holds, committed or
not, untracked files included, as a hash of its files, called its tree, and
the paths changed there. The lead's checkout counts from the commit the run
began at, and a member's own folder or worktree from the newest commit it
shares with that one. A folder nothing changed in is left out, and so are
the folders of members that only read, and a member's folder that no longer
exists, which `gates` names. While nothing changed anywhere the change is
the lead's folder.

A member that only reads may read the change in its own folder or worktree,
with the change checked out there. A verdict naming that folder is on the
change in the run's folder whose tree it has, and is refused when that tree
is the change in none of them, or in more than one, which then names the
folder it is on. `gates` tells such a member which change its folder has.

Paths are measured from the run's folder, the one the lead started in, the
paths the plan names, the paths a gate names and its globs alike. In a run
started in a subfolder of a repository, `src/app.rs` is in that subfolder,
and a path outside it begins with `../`.

A verdict names what it was given on: the plan's version, or the change's
tree and, when the work is in more than one folder, the folder. A verdict
on a plan or a tree that no longer stands is refused, and the member reads
it again. An approval goes out of date when what it named changes after
it, so an edit in a member's folder puts the approvals of the change there
out of date. A rebase that leaves the files as they were keeps the
approval.

A gate stands as one of:

- **Waiting**: no approval yet, or changes were asked for;
- **Approved**: approved on the plan or the change that stands;
- **Out of date**: approved, then changed;
- **Waived**: the user let it pass, with a reason, for this run;
- **Not needed**: it names paths, and neither the plan nor the change
  touches any of them. A gate whose change cannot be read stays needed.

A gate on the change stands in each folder something changed in, and is
approved only once it is approved in each of them.

A gate that has asked for changes as many times as it may takes no more
verdicts and waits for the user, whose waiver is the only way past it.
Gates are never taken away from a run, and none of the run's tools waives
one: the user waives a gate in the window, with a reason, as
[in the window](#in-the-window) describes.

## In the window

A session is started as a team's lead by picking the team in the
composer's agent list, under Teams, before the first message. Its chip
names the team, and the session keeps it for the run once something is
said, after the window opens again too. A session picked that way leads
the team's run and never joins another as a member. With no teams in use,
the Agents tab says what a team is under New team.

A session in a run, its lead or a member, shows one line above the
composer: how many of the gates needed stand, and why the next one holds.
The line opens to each gate with its standing. A gate that holds offers
Waive, which asks only why, in 500 characters at most. A gate with a
verdict opens its record: which agent approved or asked for changes on
what, the findings, and the rest behind Details, with Copy summary. A
member whose lead has no row in the window offers End run, which asks
first and then ends the run by its lead, and says so when the run cannot
be ended. The line is read again when the run moves, once for a burst of
moves, after a waiver or End run, when the session comes into sight and
when a turn ends.

The line gives the same reason a lead's stop is held for, so a Codex lead
sent back to work is going on for the reason the line shows.

## Switched off

Agents and teams can be switched off on the Sessions tab of the settings.
Off, nothing offers a team or a gate, and no team's run begins. A run
already going on is kept as it is but holds nothing until they are on
again, when it holds as before: work it held when they went off goes
through. Nothing is deleted. See
[agents and teams](reference/settings.md#agents-and-teams).

## The run's tools

A session in a run has tools of the run beside the
[workbench's](hooks.md#the-agents-tools), listed only to the run's sessions:

- `plan`, for the lead: writes the plan, in Markdown, with the paths it
  touches, in place of the one before, which puts the approvals of the one
  before out of date;
- `gate_add`, for the lead: adds a gate for one of the team's agents, on
  the plan or the change, on some paths or always;
- `verdict`, for a member whose agent approves a gate: approves the plan or
  the change it read, or asks for changes with findings that say what must
  change, on each gate its agent approves;
- `gates`, for every session in the run: the plan, its version and hash,
  the tree of the change in each folder, and each gate's agent, when it
  holds, how it stands and why, and the last verdict's findings.

## What a run holds

The holds stop a session's mistakes, not a session set on getting round
them. A repository that must not take an unreviewed change needs a check
of its own first, such as branch protection, and the holds as well.

While a gate on the plan is open, waiting or out of date, **building** is
held: the lead does not start or send work to a session that would change
files. While any gate is open, **handing over** is held: the lead does not
stop with the work done, and no session in the run pushes, or opens or
merges a pull request, from whichever folder it works in.

Only commits go out, so an approval of the change holds the hand-over as
well while the approved tree differs from the tree of the last commit in
that folder: work approved and not yet committed, or committed with more
left beside it. Commit the approved work, or remove what should not go out,
and the hand-over is free. Uncommitted work does not hold the lead's stop.

| Hold | Claude Code in Chord | Codex in Chord | Either in a terminal |
| --- | --- | --- | --- |
| A start or a send that would change files | refused | refused | refused |
| A push or a pull request | refused before it runs | turned down when Codex asks to run it | not held |
| The lead's stop | sent back to work | sent back to work | not held |

A start is held unless the session's agent only reads, or, for a session
resumed, the member it resumes only read. A send is held to the same rule
for the session it goes to. Both are refused by the workbench's tools, so
they hold whatever runs the lead. A start is refused as well when the
settings cannot be read, since what the agent may do is not known.

A lead in Claude Code in Chord that only reads has start left to its mode,
since the run starts only the team's agents and holds a start as above, and
send and stop where the session they name is a member of its run. A send or
a stop to any other session it started, which no run holds, is asked about
as for any session that only reads (see [reading
only](integrated.md#the-mode-a-session-starts-in)). Left to the mode, a
call is asked about where the mode asks for it. The window's own questions
stand as well: before a start in another project, on another harness or
under another account, before every start while the settings say so, and
before a round of review past its limit (see
[orchestrator](orchestrator.md#what-the-user-is-asked)). A Codex lead is
asked as its [approval policy](hooks.md#the-agents-tools) says.

A shell command hands the work over when git or gh is a command the shell
runs and it pushes, with `git push`, `git send-pack` or `git subtree
push`, or opens or merges a pull request, with `gh pr create`, `gh pr
new`, `gh pr merge` or a `gh api` call that writes to a pull request, a
merge, a branch or its files. The command is read as the shell reads it:
after assignments and redirections, inside an `sh -c` string, an eval or a
command substitution, in a here-document or a here-string given to a
shell, and after these commands only: env, command, builtin, exec, nohup,
nice, time, timeout, sudo, doas, stdbuf, ionice, setsid, caffeinate,
coproc, flock, watch and xargs. A command after any other, such as
`arch -arm64`, `op run --`, `mise exec --`, `direnv exec .`, `nix develop
-c`, `unbuffer`, `script -q /dev/null` or `bundle exec`, is not read. A word
that only mentions a push, in a message, a search, a file written from a
here-document or a commit message, does not count, and neither does a dry
run.

What is known only once the command runs counts when it may hand the work
over:

- a shell reading its commands from a pipe, a redirected input or a
  process substitution;
- git or gh given the rest of their words by xargs;
- a command or a subcommand named by an expansion such as `$tool`;
- a git command given an alias, or configuration to include, with `-c`
  for the one run.

A refused command says which gate holds it. A run that cannot be read
holds every such command.

The lead's stop is held in Chord: when it would end its turn while a gate
it can move holds the hand-over, it is sent back once, told which gate
holds and to ask for the verdicts the `gates` tool names, or to stop and
ask the user. Stopping again ends the turn. It is not sent back when every
open gate waits for the user, or when the run cannot be read. On Codex the
lead goes on in a turn of its own, which the window shows as part of the
turn that stopped, and only a turn that answers a message and ends
complete is sent back: not one the user interrupted, one that failed, or
one Codex started itself, such as a compaction.

The holds on a Claude Code session hold its subagents too: Claude Code puts
a subagent's tool calls to the same checks as the session's own.

What the holds do not see:

- a push or a pull request by any program other than git and gh that
  talks to the host, such as curl;
- git run under another name, as a copy or a link named otherwise, and a
  push made by a script, an interpreter such as Python, an alias or
  configuration set beforehand, or a command run on another machine over
  ssh;
- git given configuration by assignments before it, such as `HOME`,
  `GIT_DIR` or `GIT_CONFIG_*`, and a mistyped subcommand that
  `help.autocorrect` runs as a push;
- a command run by find `-exec`, by parallel, by `env -S` or by a trap,
  such as `trap 'git push' EXIT`;
- gh writing to a pull request or a branch in a way not named above, such
  as `gh api repos/o/r/pulls -ftitle=x`, `gh api graphql` with
  `createCommitOnBranch` or `updateRef`, or `gh repo sync`;
- a push or a pull request by a tool other than the shell;
- on Codex, any command Codex runs without asking, whatever the reason:
  with no approvals, with full access, once the user has allowed it for
  the session, or when its sandbox allows network access;
- the lead's own edits, when the team lets it change files;
- a push or a pull request in a terminal session, and a terminal lead's
  stop;
- the run's database itself. Every session runs as the user, so one with
  a shell can write the database directly: add a verdict or a waiver, or
  act as another session of the run. Only the run's tools are held to the
  rules above.
- the window's own routes. A session with a shell can reach
  `chord-remote serve` as the window does, and so waive a gate or end a
  run, as it can write the store.
