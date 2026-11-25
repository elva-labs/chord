/**
 * Chats: conversations with an agent that belong to no project.
 *
 * Every chat runs in one folder the core names, `chats` under the
 * workbench's home, and a chat is a session whose project is that folder.
 * The folder is never an open project: it is drawn as the chats line at the
 * foot of the sessions pane, and a chat on screen puts it in front without
 * opening it. Every past chat stays reachable, however old.
 */

import { core } from "$lib/core";
import {
  byChange,
  everyPast,
  forProject,
  isLive,
  lastChanged,
  type HistoryEntry,
  type Session,
} from "$lib/sessions.svelte";

export const chats = $state<{ dir: string | null }>({ dir: null });

/** How many chats the tray lists before the row that opens the rest. */
export const RECENT = 5;

let knowDir: (dir: string | null) => void = () => {};
let asked: Promise<string | null> | null = null;
/** Settles with the folder's path once the core has said where it is, or
    with null when it cannot say. */
export const chatsKnown: Promise<string | null> = new Promise((resolve) => (knowDir = resolve));

/** Asks the core for the folder, which it makes when missing. Asked once:
    a later call has the same answer. */
export function load(): Promise<string | null> {
  asked ??= core()
    .chatsDir()
    .then(
      (dir) => (typeof dir === "string" && dir !== "" ? dir : null),
      () => null,
    )
    .then((dir) => {
      chats.dir = dir;
      knowDir(dir);
      return dir;
    });
  return asked;
}

/** Whether a path is the chats folder. */
export function isChatsFolder(path: string | null): boolean {
  return path !== null && chats.dir !== null && path === chats.dir;
}

/** Whether a session is a chat. */
export function isChat(session: Session): boolean {
  return isChatsFolder(session.project);
}

/** The chats open as rows, the latest changed first. */
export function chatRows(): Session[] {
  return chats.dir === null ? [] : byChange(forProject(chats.dir));
}

/** Every past chat not open as a row, the latest written first. */
export function pastChats(): HistoryEntry[] {
  if (chats.dir === null) return [];
  return [...everyPast(chats.dir)].sort((a, b) => b.modified - a.modified);
}

/** How many chats there are: those open as rows and every past one. */
export function chatCount(): number {
  return chatRows().length + pastChats().length;
}

export type ChatEntry =
  | { kind: "row"; session: Session; at: number }
  | { kind: "past"; transcript: HistoryEntry; at: number };

/** What the tray lists: every chat open as a row, then the latest past
    ones up to `RECENT` in all, in order of when each last changed. A row is
    never left to the older list, which only resumes. */
export function recentChats(most = RECENT): ChatEntry[] {
  const rows: ChatEntry[] = chatRows().map((session) => ({ kind: "row", session, at: lastChanged(session) }));
  const room = Math.max(0, most - rows.length);
  const past: ChatEntry[] = pastChats()
    .slice(0, room)
    .map((transcript) => ({ kind: "past", transcript, at: transcript.modified * 1000 }));
  return [...rows, ...past].sort((a, b) => b.at - a.at);
}

/** How many past chats the tray leaves to the older list. */
export function olderCount(most = RECENT): number {
  return Math.max(0, chatCount() - recentChats(most).length);
}

/** What the chats line marks while it is closed: a chat asking for a
    permission, one unread, or one at work, in that order. Null when every
    chat is at rest. The caller may say what at work is, as a row's dot
    does. */
export type ChatMark = "asking" | "unread" | "working";

export function chatMark(
  atWork: (session: Session) => boolean = (session) => session.working,
): ChatMark | null {
  const rows = chatRows();
  if (rows.some((session) => session.needs === "permission")) return "asking";
  if (rows.some((session) => session.unread)) return "unread";
  if (rows.some((session) => isLive(session) && atWork(session))) return "working";
  return null;
}

/** Test seam. */
export function resetChats(dir: string | null = null) {
  chats.dir = dir;
  asked = dir === null ? null : Promise.resolve(dir);
}
