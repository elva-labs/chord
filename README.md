# Chord

<img src="docs/app-icon.png" width="128" height="128" alt="">

A desktop app for working alongside Claude Code and Codex, across all your projects, where the agent can use the app as much as you can and you see everything it does.

![A session started in a project and given a task; the files it changes land in the changes pane as it works, with the git plugin's fold under the tree, and one of them is opened as a diff.](docs/demo.gif)

## An agent that works the app with you

The agent does not only answer in text. It opens a file at the lines it means, or a diff, in front of you. It presents a document, a diagram or a page. It opens the app it is building in a browser beside you, then clicks through it and reads the console. It starts other sessions, sends them work, waits on them and reads what they did. It changes a setting, or makes a theme, when you ask it to.

You see each of these as it happens: what it opens comes up in front of you, a browser tab it opened is marked as the agent's, and every session it starts has a row of its own that you can open and take over.

What matters is asked first. A change to the settings, a theme or your stylesheet is shown to you and made only if you allow it, every time. A session it would start in another project, on another agent or under another account is put to you, and a session it starts begins with no more permission than its own. A command it wants run is typed into a terminal for you to run yourself.

![The agent draws the request flow: a Mermaid diagram and a latency chart open in the viewer, one under the other, with the caption above and the call on the media list under the tree.](docs/tools-present.gif)

## Every session at a glance

Each session has a row with a dot that says whether the agent is working, waiting for you or asking for a permission, and the last line it left you. With the window in the background, a notification says when one needs you, and <kbd>Cmd</kbd><kbd>.</kbd> goes straight to it.

## The changes as they land

Beside the agent, the project's changed files and their diffs refresh as it edits. When the agent moves into a git worktree, the pane follows it there. Open a file to read it whole, or rendered if it is Markdown, HTML, a diagram or an image.

## The agent you already use

Claude Code and Codex run as themselves, with your login, settings, skills and MCP servers. A session runs in a terminal, with the agent's own interface, or in Chord, as a conversation the window draws, and the same conversation resumes either way. Past sessions are listed under their project, including the ones you ran from a plain terminal.

## Make it yours

[Plugins](docs/plugins.md) add tools for the agent, a section under the file tree and pages of their own. Themes, fonts, every shortcut and a stylesheet of your own change the rest. Also in the box: an [editor](docs/editor.md) beside the agent, and projects on [other machines](docs/remote.md) over ssh.

## Install

On macOS, with Homebrew:

```
brew tap elva-labs/elva
brew install --cask chord@beta
```

Every [release](https://github.com/elva-labs/chord/releases) also carries installers for macOS, Linux and Windows. The macOS builds are signed and notarized.

Chord runs the agents you have installed: `claude` or `codex` on your login shell's PATH. The cask also puts `chord` on the PATH, so `chord .` opens the folder you are in.

Chord was called Agent Workbench before 1.0. Its settings move over on the first start, and [release](docs/release.md#the-casks-and-formulas-under-the-apps-earlier-name) says how the casks under the earlier name move.

## Docs

Using it:

- [Sessions](docs/sessions.md): starting, reading a row, past sessions, in Chord or in a terminal.
- [Layout](docs/layout.md) and [settings](docs/settings.md): the window, and what each setting changes.
- [Hooks](docs/hooks.md), [browser](docs/browser.md) and [orchestrator](docs/orchestrator.md): what the agent can do in the app.
- [Tokens](docs/tokens.md): what Chord does to spare them on long work.
- [Focus](docs/focus-model.md): the shortcuts and who owns the keyboard.
- [Editor](docs/editor.md), [remote](docs/remote.md), [plugins](docs/plugins.md) and [platforms](docs/platforms.md).

Building it:

- [Building](docs/building.md): running it from source and verifying a change.
- [Architecture](docs/architecture.md): the one rule and the two halves.
- [Agents](docs/adapters.md) and [sessions in Chord](docs/integrated.md): how each agent is driven.
- [Testing](docs/testing.md), [CI and releases](docs/release.md), and the full behaviour of [sessions](docs/reference/sessions.md), [layout](docs/reference/layout.md) and [settings](docs/reference/settings.md).
