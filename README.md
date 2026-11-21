# Chord

<img src="docs/app-icon.png" width="128" height="128" alt="">

A desktop app for running Claude Code and Codex side by side, across all your projects, with what each session is doing and every file it changes in front of you.

![A session started in a project and given a task; the files it changes land in the changes pane as it works, with the git plugin's fold under the tree, and one of them is opened as a diff.](docs/demo.gif)

## Every session at a glance

Each session has a row with a dot that says whether the agent is working, waiting for you or asking for a permission, and the last line it left you. With the window in the background, a notification says when one needs you, and <kbd>Cmd</kbd><kbd>.</kbd> goes straight to it.

![The user asks one session to run the tests and moves to another. When the tests finish, the first agent's line appears under its row with the dot lit, and goes when the row is opened.](docs/tools-notify.gif)

## The changes as they land

Beside the agent, the project's changed files and their diffs refresh as it edits. When the agent moves into a git worktree, the pane follows it there. Open a file to read it whole, or rendered if it is Markdown, HTML, a diagram or an image.

## The agent you already use

Claude Code and Codex run as themselves, with your login, settings, skills and MCP servers. A session runs in a terminal with the agent's own interface, or as a conversation the window draws, and the same conversation resumes either way. Past sessions are listed under their project, including the ones you ran from a plain terminal.

## Sessions that direct other sessions

Any session can start others, in any open project and on a worktree of its own, then send them work, wait on them and read what they did. A workflow sets which models do the work and which review it. Each session it starts is a row of its own that you can open and take over.

![A session on screen with the sessions it started on the rail under it, and the board at the foot of the changes pane with a row for each, its step, what it is doing, and the project it may start in.](docs/orchestrator-board.png)

## An agent that can show you things

The agent can open a file at the lines it means, put a diagram, chart, image or page in front of you, type a command into a terminal for you to run, and leave a line on its row when it is done.

![The agent draws the request flow: a Mermaid diagram and a latency chart open in the viewer, one under the other, with the caption above and the call on the media list under the tree.](docs/tools-present.gif)

Also: an [editor](docs/editor.md) beside the agent, a [browser](docs/browser.md) it can drive, projects on [other machines](docs/remote.md) over ssh, and [plugins](docs/plugins.md).

## Install

On macOS, with Homebrew:

```
brew tap elva-labs/elva
brew install --cask chord@beta
```

Every [release](https://github.com/elva-labs/chord/releases) also carries a `.dmg` for macOS, an `.AppImage` and a `.deb` for Linux, and a setup `.exe` for Windows. Stable releases add an `.rpm` and an `.msi`. The macOS builds are signed and notarized.

Chord runs the agents you have installed: `claude` or `codex` on your login shell's PATH. The cask also puts `awb` on the PATH, so `awb .` opens the folder you are in.

Chord was called Agent Workbench before 1.0. Its settings move over on the first start, and [release](docs/release.md#the-casks-and-formulas-under-the-apps-earlier-name) says how the casks under the earlier name move.

## Docs

Using it:

- [Sessions](docs/sessions.md): starting, reading a row, past sessions, integrated sessions.
- [Layout](docs/layout.md): the panes, what folds, the terminal panel and the status bar.
- [Settings](docs/settings.md): every tab and what it changes.
- [Focus](docs/focus-model.md): the key chords and who owns the keyboard.
- [Hooks](docs/hooks.md): the tools they give the agent.
- [Orchestrator](docs/orchestrator.md): sessions that start and direct others.
- [Editor](docs/editor.md), [browser](docs/browser.md), [remote](docs/remote.md), [plugins](docs/plugins.md) and [platforms](docs/platforms.md).

Building it:

- [Building](docs/building.md): running it from source and verifying a change.
- [Architecture](docs/architecture.md): the one rule and the two halves.
- [Agents](docs/adapters.md) and [integrated sessions](docs/integrated.md): how each agent is driven.
- [Testing](docs/testing.md) and [CI and releases](docs/release.md).
- The [reference](docs/reference/sessions.md) pages hold the full behaviour of [sessions](docs/reference/sessions.md), [layout](docs/reference/layout.md) and [settings](docs/reference/settings.md).
