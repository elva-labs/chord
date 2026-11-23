import { core, type RunState } from "$lib/core";
import { byKey, byToken } from "$lib/sessions.svelte";

/**
 * The team runs of the sessions on screen, as the core reads them. A view
 * follows its session's run while it is drawn; the core says when a run
 * moved, and every view following a session of that run reads it again,
 * once for a burst of moves. A change of the tree is not told: it shows
 * on the next read, when the view comes into sight or a turn ends.
 */

/** The run each followed session leads or is a member of, by session key;
    null where it is in none. */
export const runs = $state({ of: {} as Record<string, RunState | null> });

/** How long a burst of moves is gathered before the runs are read. */
export const BURST = 100;

/** How many views follow each session. */
const followers = new Map<string, number>();
/** The last read asked for each session: an older answer is dropped. */
const latest = new Map<string, number>();
let reads = 0;
let moved: Set<string> | null = null;

/** Reads the run of a session, keeping what was read before where the
    core cannot say. */
export async function readRun(key: string): Promise<void> {
  const session = byKey(key);
  if (session === null) return;
  const read = ++reads;
  latest.set(key, read);
  let state: RunState | null;
  try {
    state = await core().runState(session.project, session.token);
  } catch {
    return;
  }
  if (latest.get(key) !== read || !followers.has(key)) return;
  runs.of[key] = state;
}

/** Follows a session's run while a view draws it. Answers the way to stop. */
export function followRun(key: string): () => void {
  followers.set(key, (followers.get(key) ?? 0) + 1);
  void readRun(key);
  return () => {
    const left = (followers.get(key) ?? 1) - 1;
    if (left > 0) {
      followers.set(key, left);
      return;
    }
    followers.delete(key);
    latest.delete(key);
    delete runs.of[key];
  };
}

function readMoved() {
  const leads = moved ?? new Set<string>();
  moved = null;
  for (const key of followers.keys()) {
    const session = byKey(key);
    if (session === null) continue;
    const known = runs.of[key];
    const ours = leads.has(session.token) || (known != null && leads.has(known.run.lead));
    // A session another started may have joined a run since it was read.
    if (ours || (known == null && session.delegated)) void readRun(key);
  }
}

/** Hears the core say a run moved. */
export function runMoved(lead: string) {
  if (moved === null) {
    moved = new Set();
    setTimeout(readMoved, BURST);
  }
  moved.add(lead);
}

/** Follows the core's word on runs for as long as the window is open. */
export function hearRuns(): Promise<() => void> {
  return core().onRunChanged(({ lead }) => runMoved(lead));
}

/** Whether a run's lead has no row in the window: the run is ended from
    one of its members then. */
export function leadGone(state: RunState): boolean {
  return byToken(state.run.lead) === null;
}

/** Waives a gate of the session's run, for this run, saying why. Answers
    why the core refused, or null. */
export async function waive(key: string, gate: number, reason: string): Promise<string | null> {
  const session = byKey(key);
  if (session === null) return "That session is gone.";
  try {
    await core().runWaive(session.project, session.token, gate, reason);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  await readRun(key);
  return null;
}

/** Ends the run the session is in, by its lead's token. Answers why the
    core refused, or null once it is ended. */
export async function endRun(key: string): Promise<string | null> {
  const session = byKey(key);
  const state = runs.of[key];
  if (session == null || state == null) return "That session is gone.";
  try {
    await core().runEnd(session.project, state.run.lead);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  await readRun(key);
  return null;
}
