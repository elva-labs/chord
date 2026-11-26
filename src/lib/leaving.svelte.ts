/**
 * What closing the window takes with it, and the shells closing a session
 * or a project takes.
 *
 * Closing the window ends the app, and every session and shell running in
 * it with it. The question names only what can be lost by that: a session
 * working on a turn, whose turn is cut, a shell with something running in
 * it, and files with unsaved edits. A session open and at rest loses
 * nothing, since it comes back as a row to resume, so it is neither counted
 * nor mentioned. The core holds the window's close, by any way it is asked
 * for, and the app's quit, while a session works, a shell is busy or the
 * editor holds unsaved edits, and the window decides whether to ask. The
 * window keeps the core told whether a session works or a shell is busy;
 * the editor tells it about the edits.
 *
 * Closing a session closes the shells that belong to it, and closing a
 * project every shell that started in it, so either asks first while one of
 * those is busy, in the same words.
 */

import { untrack } from "svelte";
import { core } from "$lib/core";
import { anyUnsaved, confirmLeave, editor, leaveRequested } from "$lib/editor.svelte";
import { conducting } from "$lib/orchestrator.svelte";
import { byKey as sessionByKey, isLive, midTurn, sessions, shownName } from "$lib/sessions.svelte";
import {
  belongsTo,
  forOwner,
  forProject,
  label,
  ownerOnScreen,
  runningIn,
  shortCommand,
  terminals,
  withOwner,
  type Shell,
} from "$lib/terminals.svelte";

/** A shell with something running in it, as the question names it. */
export interface BusyShell {
  label: string;
  /** What runs in it, the first started first. */
  running: string[];
}

export const leaving = $state({
  /** The busy shells the question names, once they are read. */
  busy: [] as BusyShell[],
});

/** How long a shell's processes are waited for before the window decides
    without them: well inside the time the core waits for the question. */
export const READ_WITHIN = 1500;

/** The sessions that would lose a turn: how many are on one, and how many
    of those wait on the user for a permission. A session on a turn is what
    the sessions pane's dot calls working, or one stopped mid-turn on a
    permission, so the question and the rows agree. A session at rest, or
    stopped with something unread, loses nothing. */
export interface Open {
  count: number;
  waiting: number;
}

/** The sessions on a turn, as the question counts them. */
export function running(): Open {
  const turn = sessions.all.filter((session) => midTurn(session) || (isLive(session) && conducting(session)));
  return {
    count: turn.length,
    waiting: turn.filter((session) => session.needs === "permission").length,
  };
}

/** Whether a shell has a process behind it. */
function isOpen(shell: Shell): boolean {
  return shell.ptyId !== null && shell.status === "running";
}

/** The shells with a process behind them, in every project. */
function openShells(): Shell[] {
  return terminals.all.filter(isOpen);
}

/** A shell named from where the user is: alone when it is one of the
    owner's on screen, else with whose it is. */
function fromScreen(shell: Shell): string {
  if (belongsTo(shell, ownerOnScreen())) return label(shell);
  return withOwner(shell);
}

/** A shell named for the question about closing its project: alone when
    it is the project's own, else with its session. */
function inProject(shell: Shell): string {
  const session = shell.session === null ? null : sessionByKey(shell.session);
  return session === null ? label(shell) : `${label(shell)} of ${shownName(session)}`;
}

/** Keeps the core told whether a session works or a shell is open. Runs in an
    effect root: call once, from the page. */
export function watchRunning() {
  $effect(() => {
    const any = running().count > 0 || openShells().length > 0;
    untrack(() => void core().setRunning(any).catch(() => {}));
  });
}

/** Of these shells, the ones with something still running in them, each
    named for the question: by default every open shell, one not on screen
    saying which session or project it belongs to. A shell whose processes
    are not read in time counts as idle. */
export async function busyShells(shells: Shell[] = openShells(), name: (shell: Shell) => string = fromScreen): Promise<BusyShell[]> {
  const read = await Promise.all(
    shells.filter(isOpen).map(async (shell) => {
      const late = new Promise<string[]>((done) => setTimeout(() => done([]), READ_WITHIN));
      const running = await Promise.race([runningIn(shell.ptyId!), late]);
      return { label: name(shell), running };
    }),
  );
  return read.filter((shell) => shell.running.length > 0);
}

/** What is being closed from the sessions pane: a session, by its key, or
    a project, by its path. */
export type Closed = { session: string } | { project: string };

/** The busy shells closing a session or a project would stop: the
    session's own, or every shell that started in the project. A session's
    are named alone; a project's own are too, and a session's say which. */
export function busyGoing(closed: Closed): Promise<BusyShell[]> {
  if ("session" in closed) {
    const session = sessionByKey(closed.session);
    if (session === null) return Promise.resolve([]);
    return busyShells(forOwner({ project: session.project, session: session.key }), label);
  }
  return busyShells(forProject(closed.project), inProject);
}

/** The core held back the window's close or the app's quit. With sessions
    running or edits unsaved the question goes up at once, and names the
    busy shells once they are read; otherwise the shells are read first,
    and the window goes at once when none is busy. */
export async function leaveAsked(ask: { kind: "window" | "quit"; generation: number }) {
  if (running().count > 0 || anyUnsaved()) {
    leaving.busy = [];
    leaveRequested(ask);
    leaving.busy = await busyShells();
    return;
  }
  const busy = await busyShells();
  if (busy.length === 0 && running().count === 0 && !anyUnsaved()) {
    if (editor.asking?.kind === "leave") editor.asking = null;
    confirmLeave(ask.kind);
    return;
  }
  leaving.busy = busy;
  leaveRequested(ask);
}

/** A count and its noun, kept together on one line. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What is working or running, as one noun phrase: sessions working, busy
    shells running, or both. */
function what(count: number, shells: number): string {
  return [
    count > 0 ? `${counted(count, "session", "sessions")} working` : null,
    shells > 0 ? `${counted(shells, "busy shell", "busy shells")} running` : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
}

/** The shells alone, as one noun phrase. */
function shellsRunning(shells: number): string {
  return `${counted(shells, "busy shell", "busy shells")} running`;
}

/** Where the busy shells' first commands run. */
function shellsSentence(busy: BusyShell[]): string {
  const first = (shell: BusyShell) => `“${shortCommand(shell.running[0])}”`;
  if (busy.length === 1) {
    const [shell] = busy;
    const more = shell.running.length - 1;
    return more === 0
      ? `${first(shell)} is running in ${shell.label}.`
      : `${first(shell)} and ${counted(more, "more", "more")} are running in ${shell.label}.`;
  }
  const [one, two, ...rest] = busy;
  const named = `${first(one)} is running in ${one.label}`;
  if (rest.length === 0) return `${named}, and ${first(two)} in ${two.label}.`;
  return `${named}, ${first(two)} in ${two.label}, and something in ${counted(rest.length, "more", "more")}.`;
}

/** The question and what it says, for sessions working or shells busy
    and nothing unsaved. */
export function runningQuestion(
  kind: "window" | "quit",
  { count, waiting }: Open,
  busy: BusyShell[] = [],
): { question: string; detail: string; action: string } {
  const action = kind === "quit" ? "Quit" : "Close window";
  const total = count + busy.length;
  // Everything ended while the question was up.
  if (total === 0) {
    return { question: kind === "quit" ? "Quit?" : "Close the window?", detail: "Nothing is running now.", action };
  }
  const lost = what(count, busy.length);
  const question = kind === "quit" ? `Quit with ${lost}?` : `Close the window with ${lost}?`;
  const sentences: string[] = [];
  if (waiting > 0) {
    sentences.push(
      count === 1
        ? "The session is waiting on you."
        : `${waiting} of the sessions ${waiting === 1 ? "is" : "are"} waiting on you.`,
    );
  }
  if (busy.length > 0) sentences.push(shellsSentence(busy));
  const them = total === 1 ? "it" : "them";
  sentences.push(kind === "quit" ? `Quitting stops ${them}.` : `Closing the window quits the app and stops ${them}.`);
  return { question, detail: sentences.join(" "), action };
}

/** What the unsaved question adds about sessions working and busy shells
    running, if any. */
export function runningAside({ count }: Open, busy: BusyShell[] = []): string {
  const total = count + busy.length;
  if (total === 0) return "";
  const parts: string[] = [];
  if (count > 0) parts.push(`${counted(count, "session", "sessions")} ${count === 1 ? "is" : "are"} working`);
  if (busy.length > 0) parts.push(`${counted(busy.length, "busy shell", "busy shells")} ${busy.length === 1 ? "is" : "are"} running`);
  return ` ${parts.join(", and ")}, and ${total === 1 ? "stops" : "stop"} with the app.`;
}

/** The question before a session or a project closes while shells that go
    with it are busy, and nothing is unsaved: the window's words, for what
    is closed. */
export function closingQuestion(
  kind: "session" | "project",
  name: string,
  busy: BusyShell[],
): { question: string; detail: string; action: string } {
  const them = busy.length === 1 ? "it" : "them";
  return {
    question: `Close ${name} with ${shellsRunning(busy.length)}?`,
    detail: `${shellsSentence(busy)} Closing the ${kind} stops ${them}.`,
    action: kind === "session" ? "Close session" : "Close project",
  };
}

/** What the unsaved question about closing a session or a project adds
    about the busy shells that go with it, if any. */
export function closingAside(kind: "session" | "project", busy: BusyShell[]): string {
  if (busy.length === 0) return "";
  return ` ${counted(busy.length, "busy shell", "busy shells")} ${busy.length === 1 ? "is" : "are"} running, and ${busy.length === 1 ? "stops" : "stop"} with the ${kind}.`;
}
