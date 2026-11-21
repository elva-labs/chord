# Sessions

A session is one agent at work in one project. Open a folder as a project and start a session in it with the button on the project's header, or resume one the agent had there before. Several projects and sessions run at once, and switching between them stops nothing. Everything below is described in full in the [sessions reference](reference/sessions.md).

## Starting and closing

- The `+` on a project's header starts a session. With both Claude Code and Codex installed, it asks which agent.
- <kbd>Cmd</kbd><kbd>P</kbd> goes to any session or project. <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> opens the command palette, which can also start a session.
- The × on a live row stops the session and keeps it in the project's past sessions. Closing a project stops everything running in it.
- Closing asks first when it would lose unsaved edits or stop a shell that is still running something.

## What a row says

The dot says what the agent is doing:

| Dot | Means |
| --- | --- |
| Green | Working |
| Accent | Waiting for you |
| Ringed | Asking for a permission |
| Yellow | Left open at the last quit, not running yet |
| Grey | Done or ended |

When the agent leaves a line for you, it shows under the row's name, with the model the session runs on. A session you have not looked at since it changed is marked unread. With the window in the background, a system notification says when a session starts waiting for you ([notifications](settings.md#notifications)). <kbd>Cmd</kbd><kbd>.</kbd> goes to the next session that needs you.

How well the dot keeps up depends on the agent and on whether [hooks](hooks.md) are on: [what a row says](reference/sessions.md#what-a-row-says) has the detail.

## Active and inactive

A project you have not used for a week folds under Inactive at the foot of the pane. A project with a session running or waiting for you stays in the list. The span is a [setting](settings.md#sessions). See [active and inactive](reference/sessions.md#active-and-inactive).

## Past sessions

Under the live sessions sit the ones you ran in the project lately. Click one to resume it. Older sessions, including ones run from a plain terminal, wait behind a row such as "33 earlier sessions…", which opens a searchable list. See [past sessions](reference/sessions.md#past-sessions).

When the app starts again, the sessions that were open come back as yellow rows, and the one on screen resumes. See [after a restart](reference/sessions.md#after-a-restart).

## Following the session

The changes pane follows the session on screen. When the agent moves into a git worktree, the pane shows the changes there and says so in its header. See [following the session](reference/sessions.md#following-the-session).

## Integrated sessions

A session runs either in a terminal, with the agent's own interface, or integrated, as a conversation the window draws itself. Which one is a setting for each agent, [sessions](settings.md#sessions), a terminal to begin with. Either way the agent's own login, settings, skills and MCP servers apply, and the conversation is the same one: a session started one way resumes the other.

In an integrated session:

- a permission the agent asks for appears over the composer, to allow or deny;
- images and files can be pasted or dropped into a message;
- `/` lists the agent's commands, `@` mentions a file, and `!` runs a shell command of your own;
- a message sent while the agent works waits for the turn, with Send now and Take back;
- <kbd>Esc</kbd> stops a turn, and <kbd>Esc</kbd> twice in an empty composer goes back to before one of your earlier messages.

[Integrated sessions](reference/sessions.md#integrated-sessions) has all of it, and [integrated](integrated.md) how the agents are driven.

### When the setting is switched

Sessions already open move to the new way once they are at rest, with their conversation. A single session can be reopened the other way from its row's menu. See [when the setting is switched](reference/sessions.md#when-the-setting-is-switched).

## Subagents on the rail

An integrated Claude Code session's subagents show under its row while they run, each with what it was asked to do and its state. See [subagents on the rail](reference/sessions.md#subagents-on-the-rail).

## Accounts

With [accounts](settings.md#accounts) set up, each project runs under one, named on its header, and a new session can be started under another. See [accounts](reference/sessions.md#accounts).

## Notes

Each session keeps short notes of its conversation through the app: a brief of what is being built, and a note whenever something settles. See [notes](reference/sessions.md#notes).

### Going on from the notes

A Claude Code conversation that is large and has gone cold, past its prompt cache, goes on from its notes in a fresh conversation rather than being read again whole. Resume whole, in the row's menu, reads it all again instead. See [going on from the notes](reference/sessions.md#going-on-from-the-notes).

## Dropping files

A file dropped on a terminal types its path there. Dropped on an integrated session, an image goes with the next message and any other file is its path. See [dropping files](reference/sessions.md#dropping-files).
