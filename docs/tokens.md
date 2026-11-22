# Tokens

Long work costs most where an agent reads a large conversation again. Each turn reads the whole context, and once the agent's prompt cache has lapsed, reading it again costs as much as writing all of it afresh. Chord does a few things to keep that down. None of them has a setting, and none changes what the agent can do. The full behaviour is in the [sessions reference](reference/sessions.md#going-on-from-the-notes) and the [orchestrator](orchestrator.md).

## Going on from notes

A Claude Code or Codex conversation that is cold and large goes on from its notes instead of being read again whole. Cold means past the lifetime of its last cache write, less two minutes of an hour or thirty seconds of five minutes. Large means a context of 100,000 tokens or more. Codex does not record how long its cache lasts, so Chord assumes an hour. A warm or small conversation is resumed whole, as is one whose last request does not say when it ran.

Going on starts a fresh conversation in the same row, with the same name and notes. The agent is given a briefing of a few thousand tokens: the session's brief and list of notes, the user's first message, the last three messages with the agent's replies, and where the old transcript is, to search for a detail and never to read whole. The conversation view still draws the earlier messages above. Resume whole in the row's menu goes back to the old conversation until anything is said to the fresh one.

This applies to your own sessions, the one on screen and sessions another session started. It is judged when a row starts again, when a running row comes on screen or the window returns, and when you send a message after a rest. A terminal row left running is not judged, and neither is a run with something working in the background.

Measured on the maintainer's own use over two days, 16 conversations went on from their notes. Their last requests carried a median of 170,000 tokens of context, and the first request of each fresh conversation a median of 48,000. Priced at list, those first requests cost $6.94 against an estimated $39.68 for resuming whole, 83% less. The estimate assumes each old conversation would have been resumed whole and cold, and it leaves out later requests, where a fresh conversation may read files again. One of the 16 was still warm and cost $0.44 more than a whole resume would have.

## Notes and the brief

Every session keeps a brief, what is being built, and notes, each a title, a summary and a few lines. The agent writes them as things settle, never keys or passwords. A later note can replace an earlier one. They are stored under the session's token in the workbench's folder in your home directory, readable by you alone, and nothing is written into the project. Show notes in a row's menu opens them. They are what makes the step above possible. What they leave out, such as files read and reasoning never written down, is lost unless the agent finds it in the old transcript.

## The tools say less

The instructions the workbench gives an agent about its tools stay between roughly 2,600 and 3,500 characters, depending on the session, inside the 4,096 characters Claude Code keeps of a tool server's instructions, so they arrive whole. A test fails if one grows past that. Codex shows its model only the start of such instructions until it takes up a tool, so a Codex session is given them whole as developer instructions. Rules that belong to one tool live in that tool's description, which a session reads when it takes the tool up. Descriptions are written short.

The `sessions` listing for an orchestrating session gives open sessions in full and a session that is over as one short line, the last ten only. `all` lists the rest and `find` matches words of a name.

## Orchestration

A session started by another session:

- runs one model below its starter's when nothing names a model, the starter is a Claude Code conversation above Sonnet, and the step is not a review. Opus runs under Fable and Sonnet under Opus. The start's answer says the model.
- compacts at 150,000 tokens of context. Claude Code sessions you start yourself keep the agent's default.
- is put away once its work is over and five minutes have passed with nothing open on it, so finished rows do not pile up. A line from its starter brings it back where it ran.
- is reported to its starter together with others. While the starter's cache is warm, reports are held about half a minute and at most two minutes. Once it is cold, a wake waits until none of its sessions is working, or twenty minutes. A wait or a message from you is never held.

Each started session is asked to end with a short report that someone without its context could go on from, so the starter reads that and does not ask for more. In a measured set of 11 orchestrations with three or more sessions, the starter itself was about a fifth of the list-price cost, and its sessions the rest.

## Usage log

The workbench keeps a log of tokens per turn, context sizes and resumes, wakes and starts for each session, in its folder in your home directory. Nothing shows it and nothing is sent from it. It is there to tune the limits above.
