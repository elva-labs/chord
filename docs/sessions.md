# Sessions

A session is one agent at work in one project. Open a folder as a project and start a session in it, or resume one the agent had there before. Several projects and sessions run at once, and switching between them stops nothing. Everything below is described in full in the [sessions reference](reference/sessions.md).

## Starting and closing

- Every new session starts in the command palette, <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd>. A project's New session and the + open it there with the project chosen. One line says what the session starts on, such as `Claude Code · Work`, and <kbd>Enter</kbd> starts it. Change picks another harness, account or workflow, and for Codex a [profile](reference/sessions.md#codex-profiles) where the account has any.
- <kbd>Cmd</kbd><kbd>P</kbd> goes to any session or project.
- New session in Chord or New session in a terminal, in the project's ⋯ menu and the palette, starts one the other way from the setting.
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

When the agent leaves a line for you, it shows under the row's name, with the model the session runs on and the Codex profile it runs under, if any. A session you have not looked at since it changed is marked unread. With the window in the background, a system notification says when a session starts waiting for you ([notifications](settings.md#notifications)). <kbd>Cmd</kbd><kbd>.</kbd> goes to the next session that needs you.

How well the dot keeps up depends on the harness and on whether [hooks](hooks.md) are on: [what a row says](reference/sessions.md#what-a-row-says) has the detail.

## Active and inactive

A project you have not used for a week folds under Inactive at the foot of the pane. A project with a session running or waiting for you stays in the list. The span is a [setting](settings.md#sessions). See [active and inactive](reference/sessions.md#active-and-inactive).

## Past sessions

Under the live sessions sit the ones you ran in the project lately. Click one to resume it. Once a project has more than three rows with nothing running, the rest fold into a quiet line at its end, such as `Earlier · 8`, which counts the older sessions too, including ones run from a plain terminal. Opened, it shows the folded rows and a row that opens a searchable list of the older ones. See [past sessions](reference/sessions.md#past-sessions).

When the app starts again, the sessions that were open come back as yellow rows, and the one on screen resumes. A session another session started comes back under its starter, and a line sent to it starts it. See [after a restart](reference/sessions.md#after-a-restart).

## Following the session

The changes pane follows the session on screen. When the agent moves into a git worktree, the pane shows the changes there and says so in its header. See [following the session](reference/sessions.md#following-the-session).

## Sessions in Chord

A session runs either in a terminal, with the harness's own interface, or in Chord, as a conversation the window draws itself. Which one is a setting for each harness, [sessions](settings.md#sessions), in a terminal to begin with. Either way the harness's own login, settings, skills and MCP servers apply, and the conversation is the same one: a session started one way resumes the other.

In Chord, the agent's questions dock over the composer. A permission offers Allow once, Allow for this session and Don't allow, each answered by its number key, with more behind More. Its slash commands work, and images and files can go with a message. A turn stopped at the usage limit says when the limit resets, and a Claude Code conversation can Continue when it resets. When it goes on, by itself or because you wrote to it, the agent is given the message the limit cut short and the messages you sent after it that went unanswered, word for word and in order, with their images, also once the app was quit and opened again. Codex conversations are not carried for, since Codex does not say a limit ended its turn. The [reference](reference/sessions.md#sessions-in-chord) has the detail, and [sessions in Chord](integrated.md) how the harnesses are driven. The + on the composer picks an [agent](settings.md#agents) for the session to work as.

### When the setting is switched

Sessions already open move to the new way once they are at rest, with their conversation. A single session can be reopened the other way from its row's menu, with Reopen as a conversation or Reopen in a terminal. See [when the setting is switched](reference/sessions.md#when-the-setting-is-switched).

## Subagents on the rail

A Claude Code session in Chord shows its subagents under its row while they run, each with what it was asked to do and its state. See [subagents on the rail](reference/sessions.md#subagents-on-the-rail).

## Names

A row reads `New session` until something names it: the harness's title, a name you give it through the harness's rename command, or the first words of your first message, passing over a line that is only a link or a path. A session drawn as a conversation is then named by its agent in its first turn, once, in a few words about what it is for, the first words holding until that name arrives, across a restart too; a name you or a starting session gave stays. See [names](reference/sessions.md#names).

## Accounts

With [accounts](settings.md#accounts) set up, each project runs under one, named on its header, and a new session can be started under another. See [accounts](reference/sessions.md#accounts).

## Notes

Each session keeps short notes of its conversation through the app: a brief of what is being built, a note whenever something settles, and open items, one line each for what is still owed, until each is done or dropped. See [notes](reference/sessions.md#notes).

### Going on from the notes

A Claude Code conversation that is large and has gone cold, past its prompt cache, goes on from its notes in a fresh conversation rather than being read again whole. Resume whole, in the row's menu, reads it all again instead, and with notes switched off in the settings every conversation is resumed whole. See [going on from the notes](reference/sessions.md#going-on-from-the-notes).

## Dropping files

A file dropped on a terminal types its path there. Dropped on a session in Chord, an image goes with the next message and any other file is its path. See [dropping files](reference/sessions.md#dropping-files).
