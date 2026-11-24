/**
 * A conversation taken up again goes on from its notes when it is cold and
 * large: its row starts a fresh conversation of the agent's, the same row
 * with the same name and token, and the first message it is sent carries
 * the briefing the core wrote, the brief and list of notes, how it began,
 * its last exchanges and where its transcript is. Warm or small, it is
 * resumed whole, and so is one the user asks to have whole from the row's
 * menu. The core judges which from the transcript, or a Codex
 * conversation's rollout; the window acts on it.
 * A conversation that goes on by itself once a usage limit resets goes on
 * from its notes whatever its size and rest.
 *
 * The fresh conversation's id is kept as going on from the old one, so
 * its row draws the old conversation's messages above its own after a
 * restart too, and what the window keeps by the old id follows it.
 */
import { dirFor } from "$lib/accounts.svelte";
import { core, type GoingOn } from "$lib/core";
import { logUsage } from "$lib/usageLog";
import type { Session } from "$lib/sessions.svelte";

/** A row's run that went on from notes: the conversation it went on from,
    that conversation's context in tokens when its transcript said, the
    briefing until the first message takes it, and whether anything has
    been said to the fresh run beyond the briefing. `lost` marks a run
    whose `from` holds nothing stored: there is nothing to resume whole,
    and the fresh run is not kept as going on from it. */
export interface Went {
  from: string;
  context: number | null;
  briefing: string | null;
  spoken: boolean;
  lost?: boolean;
}

const LINEAGE_KEY = "chord.wentOn";
/** The most ids kept as going on from another. */
const LINEAGE_MOST = 500;
/** The most conversations one row's earlier messages are read from. */
const CHAIN_MOST = 8;

export const going = $state({
  /** The runs that went on, by row key, while the run lasts. */
  runs: {} as Record<string, Went>,
  /** Each conversation that went on from another, by its id, with that
      one's id. */
  lineage: {} as Record<string, string>,
});

/** The rows whose next start resumes whole, as the user asked. */
const whole = new Set<string>();

let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(LINEAGE_KEY) ?? "{}");
    if (kept !== null && typeof kept === "object")
      for (const [id, from] of Object.entries(kept))
        if (typeof from === "string" && from !== "") going.lineage[id] = from;
  } catch {
    // An unreadable record only means the earlier messages are read from
    // the newest conversation alone.
  }
}

function save() {
  const ids = Object.keys(going.lineage);
  for (const id of ids.slice(0, Math.max(0, ids.length - LINEAGE_MOST))) delete going.lineage[id];
  try {
    localStorage.setItem(LINEAGE_KEY, JSON.stringify(going.lineage));
  } catch {
    // Kept for this run of the window only.
  }
}

/** What a row's start found where nothing was stored under the id it
    took up: that id, and the earlier conversation of its chain it went on
    with, or null where none of the chain was stored and it went on fresh.
    `earlier` is whether the chain held conversations before the id, and
    `notes` whether the fresh run is briefed from the session's notes. */
export interface Lost {
  id: string;
  to: string | null;
  earlier: boolean;
  notes: boolean;
}

/** What each row's latest start found missing, by row key, until read. */
const lost: Record<string, Lost> = {};

/** How a conversation is taken up. `always` goes on from the notes
    whatever its size and rest. `unspoken` is a row whose conversation
    was never spoken to in this window. `running` is a row whose run is up
    on the id, which is never taken as holding nothing. */
export interface TakingUp {
  always?: boolean;
  unspoken?: boolean;
  running?: boolean;
}

/**
 * Decides how a row about to start takes its conversation up again, and
 * answers the agent's id to resume, or null to start a fresh conversation,
 * which goes on from the notes where `wentOn` holds a run. A judgement that
 * fails resumes whole. With `always` the conversation goes on from its
 * notes whatever its size and rest, and the id comes back only where it
 * cannot.
 *
 * Where nothing is stored under the id and the id is a fresh run of the
 * row, one that went on from another or was never spoken to, the row goes
 * on with the newest conversation of its chain that is stored, judged as
 * its own would be, and the id that held nothing leaves the chain. A
 * judgement of an earlier one that fails resumes that one whole. Where
 * none is stored, the ids that held nothing leave the chain and the row
 * goes on fresh, from the notes where there are any. Either way `lostAt`
 * says so once, except for a row that held only that id and has no notes,
 * which lost nothing and starts fresh. Any other id that holds nothing,
 * and any for a running row, is resumed whole.
 */
export async function takeUp(session: Session, how: TakingUp = {}): Promise<string | null> {
  const from = session.resumedFrom;
  const always = how.always === true;
  delete going.runs[session.key];
  delete lost[session.key];
  if (from === null) return null;
  if (!always && whole.delete(session.key)) {
    logUsage(session, "resume", { from, whole: true, asked: true });
    return from;
  }
  try {
    const judged = await judge(session, from, always);
    if (judged.missing !== true) return took(session, from, judged, always);
    load();
    if (how.running !== true && (going.lineage[from] !== undefined || how.unspoken === true))
      return await takeUpStored(session, from, judged, always);
    logUsage(session, "resume", { from, whole: true, missing: true, ...(always ? { afterLimit: true } : {}) });
    return from;
  } catch {
    return from;
  }
}

function judge(session: Session, id: string, always: boolean) {
  return core().goingOn({
    agent: session.agent,
    project: session.project,
    cwd: session.startIn ?? undefined,
    session: id,
    configDir: dirFor(session.account, session.agent),
    token: session.token,
    ...(always ? { always: true } : {}),
  });
}

/** Acts on the judgement of a conversation that is stored. */
function took(session: Session, from: string, judged: GoingOn, always: boolean, extra: Record<string, unknown> = {}) {
  const goes = judged.goesOn && judged.briefing !== null;
  logUsage(session, "resume", {
    from,
    whole: !goes,
    context: judged.context,
    idle: judged.idle,
    ...(always ? { afterLimit: true } : {}),
    ...extra,
  });
  if (!goes) return from;
  going.runs[session.key] = { from, context: judged.context, briefing: judged.briefing, spoken: false };
  return null;
}

/** Takes up the newest stored conversation of the chain `missing` ends,
    or goes on fresh, from the notes `judged` holds, where none is. */
async function takeUpStored(session: Session, missing: string, judged: GoingOn, always: boolean) {
  const chain = lineageOf(missing);
  const dead = [missing];
  for (const id of chain.slice(0, -1).reverse()) {
    let earlier: GoingOn | null;
    try {
      earlier = await judge(session, id, always);
    } catch {
      earlier = null;
    }
    if (earlier !== null && earlier.missing === true) {
      dead.push(id);
      continue;
    }
    // The ids that held nothing leave the chain, so the stored one is
    // what went on, once, and what is kept by the id follows it back.
    for (const gone of dead) delete going.lineage[gone];
    save();
    movedOn(missing, id, session.key);
    lost[session.key] = { id: missing, to: id, earlier: true, notes: false };
    // One that could not be judged is resumed whole.
    if (earlier === null) {
      logUsage(session, "resume", { from: id, whole: true, lost: missing, ...(always ? { afterLimit: true } : {}) });
      return id;
    }
    return took(session, id, earlier, always, { lost: missing });
  }
  // None of the chain holds anything: none of it stays in the lineage, so
  // dead ids never stack up behind the row.
  for (const gone of dead) if (dead.includes(going.lineage[gone] ?? "")) delete going.lineage[gone];
  save();
  const notes = judged.briefing !== null;
  const earlier = chain.length > 1;
  logUsage(session, "resume", { from: missing, whole: false, lost: missing, ...(always ? { afterLimit: true } : {}) });
  if (!notes && !earlier) return null;
  lost[session.key] = { id: missing, to: null, earlier, notes };
  going.runs[session.key] = { from: missing, context: null, briefing: judged.briefing, spoken: false, lost: true };
  return null;
}

/** What the row's latest start found missing, said once. */
export function lostAt(key: string): Lost | null {
  const found = lost[key] ?? null;
  delete lost[key];
  return found;
}

/** The row's run went on from notes, and from what. */
export function wentOn(key: string): Went | null {
  return going.runs[key] ?? null;
}

/** What a row can resume whole: the conversation its run went on from in
    this window, with the context it had, until anything is said to the
    fresh run. Resumed whole after that, the old conversation would not
    hold what was said since, while the row still drew it. None for a row
    whose run went on from none, or from one that holds nothing. */
export function wholeOf(session: { key: string }): Went | null {
  const went = going.runs[session.key];
  return went === undefined || went.spoken || went.lost === true ? null : went;
}

/** The briefing to send ahead of the run's first message, given once.
    `said` is whether a message goes with it, which the fresh run is then
    spoken to with. */
export function briefingFor(key: string, said = true): string | null {
  const went = going.runs[key];
  if (went === undefined || went.briefing === null) return null;
  const briefing = went.briefing;
  went.briefing = null;
  if (said) went.spoken = true;
  return briefing;
}

/** Puts the briefing back for a first message that never reached the
    agent. */
export function briefingBack(key: string, briefing: string) {
  const went = going.runs[key];
  if (went !== undefined && went.briefing === null) {
    went.briefing = briefing;
    went.spoken = false;
  }
}

/** Something was said to the row's run, which can no longer be resumed
    whole without losing it. */
export function spoke(key: string) {
  const went = going.runs[key];
  if (went !== undefined) went.spoken = true;
}

/** The conversations the rows with these keys went on from, while their
    runs last: the rows go on with them, and the list does not offer them
    again, whether the fresh runs' ids are known yet or not. */
export function leftBy(keys: readonly string[]): Set<string> {
  const left = new Set<string>();
  for (const key of keys) {
    const went = going.runs[key];
    if (went !== undefined) left.add(went.from);
  }
  return left;
}

let movedOn: (from: string, to: string, key: string) => void = () => {};

/** Hears a conversation that went on under a new id, to move what is kept
    by the old one. */
export function onWentOn(handler: ((from: string, to: string, key: string) => void) | null) {
  movedOn = handler ?? (() => {});
}

/** The fresh run's own id is known: it is kept as going on from the old
    conversation, unless that one holds nothing, and what is kept by the
    old id follows it. */
export function identified(key: string, id: string) {
  const went = going.runs[key];
  if (went === undefined || id === went.from) return;
  if (went.lost !== true) {
    load();
    going.lineage[id] = went.from;
    save();
  }
  movedOn(went.from, id, key);
}

/** Whether another conversation went on from this one. */
export function superseded(id: string): boolean {
  load();
  return Object.values(going.lineage).includes(id);
}

/** The newest conversation that went on from the one `given` names, by
    its whole id or the start of it; null where none went on from it. */
export function wentOnFrom(given: string): string | null {
  load();
  const found = Object.entries(going.lineage).filter(([, from]) => from === given || from.startsWith(given));
  if (found.length !== 1) return null;
  let at = found[0][0];
  for (let step = 0; step < CHAIN_MOST; step += 1) {
    const next = Object.entries(going.lineage).find(([, from]) => from === at)?.[0];
    if (next === undefined) break;
    at = next;
  }
  return at;
}

/** Each conversation that went on from another, by its id, with that
    one's id. */
export function lineage(): Readonly<Record<string, string>> {
  load();
  return going.lineage;
}

/** The conversations a row's messages are read from, oldest first, ending
    with `id`. */
export function lineageOf(id: string): string[] {
  load();
  const chain = [id];
  let at = going.lineage[id];
  while (at !== undefined && chain.length < CHAIN_MOST && !chain.includes(at)) {
    chain.unshift(at);
    at = going.lineage[at];
  }
  return chain;
}

/** Every conversation a row went on from, oldest first, ending with
    `id`, however long the chain: what belongs to a session for as long as
    it exists, as media does. */
export function wholeLineageOf(id: string): string[] {
  load();
  const chain = [id];
  const seen = new Set(chain);
  let at = going.lineage[id];
  while (at !== undefined && !seen.has(at)) {
    chain.unshift(at);
    seen.add(at);
    at = going.lineage[at];
  }
  return chain;
}

/** The row's run no longer counts as one that went on. */
export function forgetWent(key: string) {
  delete going.runs[key];
}

/** The row's next start resumes whole, and its run no longer counts as
    one that went on. */
export function askWhole(key: string) {
  whole.add(key);
  delete going.runs[key];
}

/** A context as the row's menu says it: 412k tokens. */
export function tokensText(context: number): string {
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tokens`;
  return `${Math.round(context / 1000)}k tokens`;
}

// Read once as the window starts, so nothing read inside a derived value
// writes to the state.
load();

/** Test seam. */
export function resetGoingOn() {
  for (const key of Object.keys(going.runs)) delete going.runs[key];
  for (const id of Object.keys(going.lineage)) delete going.lineage[id];
  whole.clear();
  for (const key of Object.keys(lost)) delete lost[key];
  loaded = false;
}
