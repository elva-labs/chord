/**
 * The agent each session works as, picked on the composer's chip: by the
 * row's key while the row is open, and by the conversation's id once it is
 * known, so that a session resumed or reopened, after a restart too, shows
 * the agent and starts reading only as it was. The newest few hundred are
 * kept.
 *
 * The agent's text goes ahead of the next message the user sends, once;
 * the conversation holds it from then on, so a resumed session is not told
 * again.
 *
 * Apart from that, the last agent picked is kept for each purpose a pick
 * is made for: the composer's own, and a plugin's ask card for a review,
 * which starts on its own last pick and leaves the composer's as it was.
 */

import { agentNote } from "$lib/instructions";

/** What a session is kept working as: the agent's key and title, and
    whether it still reads only, which picking another mode ends. */
export interface SessionAgent {
  key: string;
  title: string;
  readsOnly: boolean;
}

const KEY = "chord.sessionAgents";
const LAST_KEY = "chord.lastAgents";
const MOST = 500;

/** What each purpose a pick is made for last picked. */
export type AgentPurpose = "composer" | "review";

const byRow = $state<Record<string, SessionAgent | null>>({});
/** The note that goes ahead of the row's next message of the user's. */
const ahead = new Map<string, string>();
let byId: Map<string, SessionAgent> | null = null;

function isAgent(value: unknown): value is SessionAgent {
  if (typeof value !== "object" || value === null) return false;
  const kept = value as Record<string, unknown>;
  return typeof kept.key === "string" && typeof kept.title === "string" && typeof kept.readsOnly === "boolean";
}

function read(): Map<string, SessionAgent> {
  if (byId !== null) return byId;
  byId = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(stored))
      for (const entry of stored)
        if (Array.isArray(entry) && typeof entry[0] === "string" && isAgent(entry[1])) byId.set(entry[0], entry[1]);
  } catch {
    // None is kept, then: each session starts with no agent.
  }
  return byId;
}

function write(kept: Map<string, SessionAgent>) {
  while (kept.size > MOST) kept.delete(kept.keys().next().value as string);
  try {
    localStorage.setItem(KEY, JSON.stringify([...kept]));
  } catch {
    // Non-fatal: the agents do not outlast the window.
  }
}

function keepById(id: string, agent: SessionAgent | null) {
  const kept = read();
  kept.delete(id);
  if (agent !== null) kept.set(id, agent);
  write(kept);
}

/** The agent the row's session works as, or null for none: the one picked
    on the row, else the one its conversation was kept with. */
export function agentOfRow(key: string, id: string | null): SessionAgent | null {
  if (key in byRow) return byRow[key];
  return id === null ? null : (read().get(id) ?? null);
}

/** The row's session works as `agent` from its next message, or as none,
    which is picked only before its first: the conversation is told of the
    agent with that message. */
export function pickAgent(
  key: string,
  id: string | null,
  agent: { key: string; title: string; text: string; readsOnly: boolean } | null,
) {
  const picked = agent === null ? null : { key: agent.key, title: agent.title, readsOnly: agent.readsOnly };
  byRow[key] = picked;
  if (id !== null) keepById(id, picked);
  if (agent !== null) ahead.set(key, agentNote(agent.title, agent.text));
  else ahead.delete(key);
}

/** The row's session reads only or no longer does, by the user's choice of
    mode or the agent's: kept with its agent. */
export function agentReadsOnly(key: string, id: string | null, on: boolean) {
  const agent = agentOfRow(key, id);
  if (agent === null || agent.readsOnly === on) return;
  const changed = { ...agent, readsOnly: on };
  byRow[key] = changed;
  if (id !== null) keepById(id, changed);
}

/** The row's conversation is now known by `id`: the agent picked before is
    kept by it. */
export function agentIdentified(key: string, id: string) {
  if (key in byRow) keepById(id, byRow[key]);
}

/** The note to send ahead of the row's next message, given once. */
export function agentAhead(key: string): string | null {
  const note = ahead.get(key);
  if (note === undefined) return null;
  ahead.delete(key);
  return note;
}

/** Puts the note back for a message that never reached the agent, unless
    another was picked since. */
export function agentAheadBack(key: string, note: string) {
  if (!ahead.has(key)) ahead.set(key, note);
}

/** The row is closed: what it picked stays kept by its conversation. */
export function forgetAgentRow(key: string) {
  delete byRow[key];
  ahead.delete(key);
}

function readLast(): Partial<Record<AgentPurpose, string>> {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, key]) => typeof key === "string"));
  } catch {
    return {};
  }
}

/** The agent last picked for `purpose`, by its key, or null for none. */
export function lastAgent(purpose: AgentPurpose): string | null {
  return readLast()[purpose] ?? null;
}

/** `key` is the agent last picked for `purpose`, or null for none. */
export function keepLastAgent(purpose: AgentPurpose, key: string | null) {
  const last = readLast();
  if (key === null) delete last[purpose];
  else last[purpose] = key;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {
    // Non-fatal: the pick does not outlast the window.
  }
}
