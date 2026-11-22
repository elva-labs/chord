# Settings

<kbd>Cmd</kbd><kbd>,</kbd> opens the settings (<kbd>Ctrl</kbd><kbd>,</kbd> on Windows and Linux). A choice applies at once, and every window on the machine follows it. Each setting is its name, its control and at most one short line, and one you have changed shows Reset beside it. The [settings reference](reference/settings.md) describes each one in full.

![The settings over the workbench, open on the appearance settings.](settings.png)

## Appearance

Mode is system, light or dark. System follows the desktop. The Appearance tab also holds the look, the colour, compact mode and the two fonts, with the background and custom styles behind More.

## Theme

The look: modern, with rounded cards in a sans, or terminal, with square boxes in mono. Both use the same colours. <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd> cycles through them. See [theme](reference/settings.md#theme).

## Font

The terminal and the editor draw in one family, the rest of the app in another, each the system's own to begin with. The terminal can have IBM Plex Mono or JetBrains Mono, and the interface IBM Plex Sans or Inter. See [font](reference/settings.md#font).

## Colour

Five palettes, teal, indigo, amber, rose and mono, and after them themes of your own, which an agent can make for you. See [colour](reference/settings.md#colour).

## Background

A colour, or a gradient of up to three, behind the window's chrome, picked on a colour pad. Each palette and theme keeps its own. See [background](reference/settings.md#background).

### Cards

How much of the background shows through the panes as well, none to begin with. See [cards](reference/settings.md#cards).

## Custom styles

A stylesheet of your own, `user.css` beside the settings file, laid over the app's own. It can restyle anything, and it cannot load anything from outside. If it makes the app hard to use, Turn Off Custom Styles in the app's menu switches it off. See [custom styles](reference/settings.md#custom-styles) for what to aim it at.

## Live updates

Let sessions talk to Chord, in the Sessions tab. Off, the app learns what a session is doing by watching its files. On, it does through the harness's [hooks](hooks.md), which keep the session's row more exact and give the session the app's tools. A fresh install has it on. A project can go the other way from the rest, under By project. See [live updates](reference/settings.md#live-updates).

## Sessions

- **Run**, for each harness, Claude Code or Codex: In Chord, a conversation the window draws, or In a terminal, the harness's own interface. In a terminal to begin with. [Sessions](sessions.md#sessions-in-chord) says what the difference is.
- **Start on**, for each harness: the model, effort and mode you last chose for it. Use defaults puts back the harness's own.
- **Ask before a session starts another**: Outside its project to begin with, so a session may start one in its own project without asking. Every time puts every start to you.
- **Keep listed**: how long past sessions stay listed, forever, 30 days, 7 days or 1 day. Older ones are still there to resume behind the project's Earlier line.
- **Fold inactive projects after**: 1 day, 7 days, 30 days or never, 7 days to begin with.

See [sessions](reference/settings.md#sessions).

## Agents

An agent is a role: a title, a description whose first line is what lists show, and the model, effort and whether it reads only. The Agents tab lists the agents Chord ships, which you can change and reset, then your own, which you make, change and remove there, and under them the agents you installed for Claude Code or Codex, read from where those keep them and never written. See [agents](reference/settings.md#agents).

## Workflows

A workflow names the model a session starts on, and the models it may hand work and review to. The roles are fixed: the orchestrator you talk to, workers that do a piece of work, and reviewers that check it. Each project can follow a workflow of its own. See [workflows](reference/settings.md#workflows) and [orchestrator](orchestrator.md).

## Accounts

An account is a separate login: a Claude Code configuration directory and a Codex home, such as `~/.claude-work` and `~/.codex-work`. Naming an account logs nothing in. Run the harness once in a terminal with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set to the directory, and it asks for a login and keeps it there. Each project then runs under the account chosen for it. See [accounts](reference/settings.md#accounts).

## Plugins

Sources of plugins, with a switch for each plugin. Every plugin is off to begin with. See [plugins](plugins.md).

## Keys

The whole table of shortcuts, with two presets and room for your own. A shortcut changed from its preset shows Reset, and Reset all shortcuts puts the preset back. See [focus](focus-model.md).

## Notifications

While the window is in the background, a system notification says when a session starts waiting for you or asks you something. A chime can go with it. Notifications are on and the chime off to begin with. See [notifications](reference/settings.md#notifications).

## An agent changing them

An agent can ask to change the settings when you ask it to, such as a darker look or a shortcut of your own. Each change is put to you over the window first, from what it is to what it would be, and nothing changes unless you choose Allow. The hooks, plugins, accounts, notifications and what is asked before a session starts are yours alone to change. See [an agent changing them](reference/settings.md#an-agent-changing-them).

## Where they are kept

In `settings.json` under `~/.chord`. An edit to the file reaches an open window at once. See [where they are kept](reference/settings.md#where-they-are-kept).

## An install from before Chord

Chord was called Agent Workbench before 1.0. On its first start it moves the earlier name's `~/.agent-workbench` folder to `~/.chord`, and renames what it had written under the earlier name, and lists every file it changed in `~/.chord/migration.md`. See [an install from before Chord](reference/settings.md#an-install-from-before-chord).
