import { lastSegment } from "$lib/paths";
import { pluginOfMark } from "$lib/pluginStarts.svelte";
import { sessions, shownName } from "$lib/sessions.svelte";

/**
 * Who sent a message to a session, when it was not the user: a session
 * that started it, with its prompt, or one that spoke to it with the send
 * tool, or a plugin that started it.
 */

const KEY = "chord.senders";
/** How many messages from other sessions are remembered. */
const KEEP = 1000;

/** The session that sent each message another session sent, by the id
    the message was sent under: the token the sending session's tools name
    it by, or, sent before there were tokens, its id or the folder an agent
    outside the workbench called from. Kept between runs, so a message
    reads as its sender's after a restart too. A message is told to be
    another session's by its id alone, never by its words. */
const senders = $state({ byMessage: {} as Record<string, string> });
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const byMessage: Record<string, string> = {};
    for (const [message, from] of Object.entries(stored)) if (typeof from === "string") byMessage[message] = from;
    senders.byMessage = byMessage;
  } catch {
    // Nothing remembered, then: such a message reads as the user's.
  }
}

// Read when the module loads, never while a view is drawn, which may not
// write the state it reads.
load();

/** A session sent the message with this id. */
export function sentBy(message: string, from: string) {
  load();
  senders.byMessage[message] = from;
  const kept = Object.entries(senders.byMessage);
  if (kept.length > KEEP) senders.byMessage = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(KEY, JSON.stringify(senders.byMessage));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** Who started a session, for the prompt it is started with: told by the
    module that knows who started what. */
let starter: (key: string) => string | null = () => null;

export function startersFrom(how: (key: string) => string | null) {
  starter = how;
}

/** The session that started the session with this row key, if one did. */
export function starterOf(key: string): string | null {
  return starter(key);
}

export interface Sender {
  /** The sending session's id, as the tools name it, where the window
      knows it. */
  id: string | null;
  name: string;
  /** Its row, when the window has one to go to. */
  key: string | null;
  /** The workbench itself sent it, with what the sessions this one
      started did, and no session did. */
  workbench?: boolean;
  /** A plugin sent it, which the thread shows as it was sent. */
  plugin?: boolean;
}

/** What a message the workbench sent of its own is kept under as its
    sender: no session's token and no folder can be it. */
export const WORKBENCH = "workbench:";

let kept: (id: string) => string | null = () => null;

/** Who names a session whose row has gone, by its id: the conductor, by
    the name its caller gave it or the one it was known by. */
export function nameKeptBy(how: ((id: string) => string | null) | null) {
  kept = how ?? (() => null);
}

/** What the user knows a session by, by its id: its row's name while the
    window has its row, and after that the name it went by, where that is
    kept. */
export function sessionName(id: string): string | null {
  const row = sessions.all.find((candidate) => candidate.id === id);
  return row === undefined ? kept(id) : shownName(row);
}

/** Who sent a message: null for the user. A sender the window has no row
    for is named by the name it went by, where that is kept, and otherwise
    as another session: neither its id nor the token the message was sent
    under is anything a person reads. */
export function senderOf(message: { id: string }): Sender | null {
  const from = senders.byMessage[message.id] ?? null;
  if (from === null) return null;
  if (from === WORKBENCH) return { id: null, key: null, name: "Workbench", workbench: true };
  const plugin = pluginOfMark(from);
  if (plugin !== null) return { id: null, key: null, name: `the ${plugin} plugin`, plugin: true };
  const row =
    sessions.all.find((candidate) => candidate.token === from) ??
    sessions.all.find((candidate) => candidate.id === from) ??
    null;
  const id =
    row?.id ?? Object.entries(sessions.tokens).find(([, kept]) => kept.token === from)?.[0] ?? null;
  // An agent the workbench did not start, by the folder it called from;
  // an earlier version kept the folder bare.
  const folder = outsideFolder(from) ?? (from.startsWith("/") ? from : null);
  return {
    id,
    key: row?.key ?? null,
    name:
      row !== null
        ? shownName(row)
        : folder !== null
          ? `an agent in ${lastSegment(folder)}`
          : ((id === null ? null : kept(id)) ?? "another session"),
  };
}

const OUTSIDE_MARK = "outside:";

/** What a call that names no session is kept under as its caller: an agent
    the workbench did not start, by the folder it calls from, marked so that
    no token can be it, and no list an earlier version kept under the bare
    folder either. */
export function outsideCaller(cwd: string): string {
  return `${OUTSIDE_MARK}${cwd}`;
}

/** The folder an agent the workbench did not start calls from, for a
    caller kept under one; null for a session's token. */
export function outsideFolder(caller: string): string | null {
  return caller.startsWith(OUTSIDE_MARK) ? caller.slice(OUTSIDE_MARK.length) : null;
}

/** Test seam. */
export function resetSenders() {
  senders.byMessage = {};
  times.at = {};
  typed.of = {};
  uncarried.of = {};
  loaded = false;
  load();
  loadTimes();
  loadTyped();
  loadUncarried();
}

const TIMES_KEY = "chord.sent-at";

/** When this window sent each message, by its id, kept between runs: a
    message read back from the core after a reload carries no time of its
    own. */
const times = $state({ at: {} as Record<string, number> });

function loadTimes() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TIMES_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const at: Record<string, number> = {};
    for (const [message, when] of Object.entries(stored)) if (typeof when === "number") at[message] = when;
    times.at = at;
  } catch {
    // No times remembered, then: such a message shows none.
  }
}

// Read when the module loads, as the senders are.
loadTimes();

/** The window sent the message with this id at `at`. */
export function sentAt(message: string, at: number) {
  times.at[message] = at;
  const kept = Object.entries(times.at);
  if (kept.length > KEEP) times.at = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(TIMES_KEY, JSON.stringify(times.at));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** When the window sent a message, if it did. */
export function timeOf(message: string): number | null {
  return times.at[message] ?? null;
}

const TYPED_KEY = "chord.typed";

/** How much of each message the user sent was what they typed on the
    composer, by its id, kept between runs: how many characters end its
    text and how many images end its images. The workbench's notes go
    ahead of those words, so after a reload they are told apart by this
    and by nothing the text says. */
const typed = $state({ of: {} as Record<string, [number, number]> });

function loadTyped() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TYPED_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const of: Record<string, [number, number]> = {};
    for (const [message, kept] of Object.entries(stored))
      if (Array.isArray(kept) && kept.length === 2 && kept.every((count) => Number.isSafeInteger(count) && count >= 0))
        of[message] = [kept[0], kept[1]];
    typed.of = of;
  } catch {
    // Nothing remembered, then: such a message is read for its words.
  }
}

// Read when the module loads, as the senders are.
loadTyped();

/** The user typed the last `length` characters and `images` images of the
    message with this id. */
export function typedAs(message: string, length: number, images: number) {
  typed.of[message] = [length, images];
  const kept = Object.entries(typed.of);
  if (kept.length > KEEP) typed.of = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(TYPED_KEY, JSON.stringify(typed.of));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** How much of a message the user typed, where the window kept it. */
export function typedOf(message: string): [number, number] | null {
  return typed.of[message] ?? null;
}

const UNCARRIED_KEY = "chord.uncarried";

/** How many of the messages a usage limit left unanswered could not go
    with each message that went on after them, by its id, kept between
    runs: messages the window can show neither to be the user's typing
    nor to be another's, which the user is told to send again. */
const uncarried = $state({ of: {} as Record<string, number> });

function loadUncarried() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(UNCARRIED_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const of: Record<string, number> = {};
    for (const [message, count] of Object.entries(stored))
      if (Number.isSafeInteger(count) && (count as number) > 0) of[message] = count as number;
    uncarried.of = of;
  } catch {
    // Nothing remembered, then: the thread says nothing under the message.
  }
}

// Read when the module loads, as the senders are.
loadUncarried();

/** `count` messages the limit left unanswered could not go with the
    message with this id. */
export function leftOut(message: string, count: number) {
  uncarried.of[message] = count;
  const kept = Object.entries(uncarried.of);
  if (kept.length > KEEP) uncarried.of = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(UNCARRIED_KEY, JSON.stringify(uncarried.of));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** How many unanswered messages could not go with a message, where any
    could not. */
export function leftOutOf(message: string): number | null {
  return uncarried.of[message] ?? null;
}
