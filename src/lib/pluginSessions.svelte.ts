/**
 * What a plugin asks of sessions: to start one, and to send a line to one
 * it started. The core lets each through only in answer to something the
 * user did in the plugin, once and within its time, and for a send only to
 * a session of the plugin's own start; the window starts nothing the user
 * has not said yes to on the conductor's card, and sends nothing a session
 * could take as a command.
 */

import { core, type PluginSendEvent, type PluginSentOutcome, type PluginStartEvent } from "$lib/core";
import { accountToStart, dirsOf } from "$lib/accounts.svelte";
import {
  askForPlugin,
  cameUp,
  mayChangeModel,
  nameCut,
  oneLine,
  runsShell,
  treeStands,
  typeLine,
  worktreeName,
  type PluginPick,
} from "$lib/conductor.svelte";
import { say } from "$lib/flash.svelte";
import { wentOnFrom } from "$lib/goingOn.svelte";
import { handleOf, send as sendIntegrated } from "$lib/integrated.svelte";
import { choose, modelToStart } from "$lib/lastChosen.svelte";
import { startsIn } from "$lib/orchestratorFolder.svelte";
import { pluginMark, pluginStarted, pluginStartOf, rowOfRequest } from "$lib/pluginStarts.svelte";
import { kindFor } from "$lib/sessionKind.svelte";
import {
  byKey,
  create,
  defaultAgent,
  nameTaken,
  reopeningRow,
  sessions,
  wake,
  type Session,
} from "$lib/sessions.svelte";
import { readsAsYou } from "$lib/unseen";
import { goTo, workspace } from "$lib/workspace.svelte";

/** The most a start's prompt holds, in UTF-8 bytes, as the core caps it. */
export const PROMPT_MOST = 8 * 1024;
/** The most a sent line holds, in UTF-8 bytes, as the core caps it. */
export const TEXT_MOST = 4 * 1024;

/** The model pick that stands for the agent's own default. */
const OWN_DEFAULT = "default";

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Whether a session may be started in a project: it is open, and it is
    not the orchestrator folder. */
function startable(project: string): boolean {
  return startsIn(project) && workspace.open.some((open) => open.path === project);
}

/** Why the window starts nothing for a plugin's start without asking the
    user, or null where it asks. A prompt is words: one an agent could take
    as a command, or a terminal as a shell line, is none of a plugin's to
    give. */
export function startRefusal(asked: PluginStartEvent): string | null {
  if (!startable(asked.project)) return "its project is not open";
  const line = oneLine(asked.prompt);
  if (line === "") return "it has no prompt";
  if (bytes(asked.prompt) > PROMPT_MOST) return "its prompt is too long";
  if (mayChangeModel(line)) return "its prompt begins with a slash";
  if (runsShell(line)) return "its prompt begins with !";
  return null;
}

/**
 * A plugin asks to start a session. The conductor's card asks the user,
 * every time, with the agent and model it runs on, the last chosen to
 * begin with; on yes the session starts the way a session's start does,
 * comes on screen, and is the plugin's from then on. Nothing is said back
 * to the plugin on no: it hears of a start by the session's own lines.
 */
export async function pluginStartAsked(asked: PluginStartEvent): Promise<string | null> {
  if (startRefusal(asked) !== null) return null;
  const agent = defaultAgent(asked.project);
  const begins: PluginPick = {
    agent,
    model: modelToStart(agent, accountToStart(asked.project)) ?? OWN_DEFAULT,
  };
  const { choice, pick } = await askForPlugin(asked, begins);
  if (choice === "no") return null;
  // The project may have closed while the card waited.
  if (!startable(asked.project)) return null;

  let startIn: string | null = null;
  if (asked.worktree) {
    try {
      startIn = await core().worktreeAdd(asked.project, worktreeName(asked.name ?? asked.prompt), dirsOf());
    } catch (error) {
      say(`The worktree could not be made: ${String(error)}`);
      return null;
    }
  }
  const terminal = kindFor(pick.agent) === "terminal";
  const account = accountToStart(asked.project);
  const session = create(
    asked.project,
    null,
    pick.agent,
    startIn,
    terminal ? oneLine(asked.prompt) : asked.prompt,
    pick.model === OWN_DEFAULT ? null : pick.model,
    account,
    null,
  );
  session.madeTree = startIn !== null;
  pluginStarted(session.key, {
    source: asked.source,
    plugin: asked.plugin,
    project: asked.project,
    request: asked.request,
  });
  // The name the plugin gave is the row's until the agent names it, cut as
  // a row's name is. One that reads as the user's, or that another live
  // session, the workbench or an agent has, is not taken.
  const candidate = asked.name === null ? null : nameCut(oneLine(asked.name));
  if (candidate !== null && candidate !== "" && !readsAsYou(candidate) && !nameTaken(candidate, session.key))
    session.title = candidate;
  choose(pick.agent, "model", pick.model);
  goTo(session.key);
  return session.key;
}

/** The row of the session a send names: the one the plugin's start made,
    else the one with its id, or with the id of a conversation that went
    on from it under a new one. */
function rowFor(event: PluginSendEvent): Session | null {
  const key = rowOfRequest(event.source, event.plugin, event.started);
  const started = key === null ? null : byKey(key);
  if (started !== null) return started;
  const fresh = wentOnFrom(event.session);
  return (
    sessions.all.find((row) => row.project === event.project && row.id === event.session) ??
    (fresh === null ? null : sessions.all.find((row) => row.project === event.project && row.id === fresh)) ??
    null
  );
}

/** A session that will not come back: it ended, failed or crashed. A row
    left from the last quit, or put to rest, comes back on a line. */
const OVER = new Set(["exited", "crashed", "failed"]);

/**
 * A plugin sends a line to a session the core knows as its start's. The
 * line goes as the plugin's, shown as its words, and the session comes on
 * screen; a session at rest is resumed with it. Nothing goes that could be
 * a command: a line that begins with a slash, one a terminal would run in
 * the shell, or any line to a terminal asking for a permission, which the
 * line could answer. The plugin hears what came of it.
 */
export async function pluginSendAsked(event: PluginSendEvent): Promise<PluginSentOutcome> {
  const outcome = await deliver(event);
  try {
    await core().pluginSent(event.project, event.request, outcome);
  } catch {
    // A plugin that stopped meanwhile hears nothing.
  }
  return outcome;
}

async function deliver(event: PluginSendEvent): Promise<PluginSentOutcome> {
  const line = oneLine(event.text);
  if (line === "" || bytes(event.text) > TEXT_MOST || mayChangeModel(line)) return "refused";
  const row = rowFor(event);
  if (row === null || row.project !== event.project) return "gone";
  // Known again after the window was loaded afresh, by the start the core
  // tied it to.
  if (pluginStartOf(row.key) === null)
    pluginStarted(row.key, {
      source: event.source,
      plugin: event.plugin,
      project: event.project,
      request: event.started,
    });
  const from = pluginMark(event.source, event.plugin);
  const integrated = row.kind === "integrated";
  const typed = integrated ? event.text : line;
  if (!integrated && runsShell(typed)) return "refused";
  if (OVER.has(row.status)) return "gone";
  if (reopeningRow(row.key)) return "refused";

  if (row.status === "dormant") {
    if (row.id === null) return "gone";
    if (row.startIn !== null && !(await treeStands(row.project, row.startIn))) return "gone";
    const now = byKey(row.key);
    if (now === null || now.status !== "dormant") return "refused";
    now.prompt = typed;
    now.engaged = true;
    wake(now.key);
    goTo(now.key);
    return "delivered";
  }

  if (row.status === "starting" && (await cameUp(row.key)) !== null) return "refused";
  const up = byKey(row.key);
  if (up === null || up.status !== "running") return "refused";
  if (integrated) {
    if (handleOf(up.key) === null) return "refused";
    if (sendIntegrated(up.key, typed, [], from) === null) return "refused";
    up.turnEnd = null;
    goTo(up.key);
    return "delivered";
  }
  if (up.ptyId === null || up.needs === "permission") return "refused";
  try {
    await typeLine(up.key, up.ptyId, typed);
  } catch {
    return "refused";
  }
  goTo(up.key);
  return "delivered";
}
