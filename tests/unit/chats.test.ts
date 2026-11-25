import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where the core says the chats folder is, and how often it was asked. */
const fake = {
  dir: "/home/ada/.chord/chats" as string | null,
  asked: 0,
};

vi.mock("$lib/core", () => ({
  core: () =>
    new Proxy(
      {
        async chatsDir() {
          fake.asked += 1;
          if (fake.dir === null) throw new Error("no core");
          return fake.dir;
        },
      },
      {
        get(target, name: string) {
          if (name in target) return target[name as keyof typeof target];
          return async () => undefined;
        },
      },
    ),
}));

import {
  chatCount,
  chatMark,
  chatRows,
  chats,
  isChat,
  isChatsFolder,
  load,
  olderCount,
  pastChats,
  recentChats,
  resetChats,
} from "$lib/chats.svelte";
import { create, reset as resetSessions, sessions, type HistoryEntry } from "$lib/sessions.svelte";

const DIR = "/home/ada/.chord/chats";
const A = "/home/ada/dev/one";

/** A past chat, written `days` ago. */
const past = (id: string, days: number): HistoryEntry => ({
  id,
  modified: Math.floor(Date.now() / 1000) - days * 86_400 - 60,
  size: 100,
  title: `Chat ${id}`,
  agent: "claude-code",
  account: null,
});

beforeEach(() => {
  resetSessions();
  localStorage.clear();
  fake.dir = DIR;
  fake.asked = 0;
  resetChats(DIR);
});

describe("chats", () => {
  it("live in the folder the core names, asked for once", async () => {
    resetChats();
    expect(isChatsFolder(DIR)).toBe(false);
    expect(await load()).toBe(DIR);
    expect(await load()).toBe(DIR);
    expect(fake.asked).toBe(1);
    expect(chats.dir).toBe(DIR);
    expect(isChatsFolder(DIR)).toBe(true);
    expect(isChatsFolder(A)).toBe(false);
    expect(isChatsFolder(null)).toBe(false);
  });

  it("are nowhere when the core cannot say", async () => {
    resetChats();
    fake.dir = null;
    expect(await load()).toBeNull();
    expect(isChatsFolder(DIR)).toBe(false);
    expect(chatCount()).toBe(0);
  });

  it("are the sessions in the folder, never a project's", () => {
    const chat = create(DIR, null, "claude-code", null, null, null, null);
    const work = create(A, null, "claude-code", null, null, null, null);
    expect(isChat(chat)).toBe(true);
    expect(isChat(work)).toBe(false);
    expect(chatRows()).toEqual([chat]);
  });

  // Aging hides a project's old past sessions behind a fold; a past chat
  // stays listed however old, and one the window never ran is a chat too.
  it("count every past chat, however old and whoever ran it", () => {
    sessions.history[DIR] = [past("a", 1), past("b", 400), past("c", 40)];
    sessions.mine[DIR] = ["a"];
    expect(pastChats().map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(chatCount()).toBe(3);
  });

  it("count a chat open as a row once, not again as a past one", () => {
    sessions.history[DIR] = [past("a", 1), past("b", 2)];
    create(DIR, "a", "claude-code", null, null, null, null);
    expect(pastChats().map((entry) => entry.id)).toEqual(["b"]);
    expect(chatCount()).toBe(2);
  });

  it("list every row and the latest past ones in the tray, the rest older", () => {
    sessions.history[DIR] = Array.from({ length: 8 }, (_, index) => past(`p${index}`, index + 1));
    const row = create(DIR, null, "claude-code", null, null, null, null);
    const recent = recentChats(5);
    expect(recent).toHaveLength(5);
    expect(recent[0]).toMatchObject({ kind: "row", session: row });
    expect(recent.slice(1).map((entry) => (entry.kind === "past" ? entry.transcript.id : null))).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
    ]);
    expect(olderCount(5)).toBe(4);
  });

  it("never leave an open row to the older list", () => {
    for (let index = 0; index < 6; index += 1) create(DIR, null, "claude-code", null, null, null, null);
    sessions.history[DIR] = [past("p0", 1)];
    expect(recentChats(5)).toHaveLength(6);
    expect(olderCount(5)).toBe(1);
  });

  it("mark the line for a chat asking, unread or at work, asking first", () => {
    const one = create(DIR, null, "claude-code", null, null, null, null);
    const two = create(DIR, null, "claude-code", null, null, null, null);
    expect(chatMark()).toBeNull();
    one.status = "running";
    one.working = true;
    expect(chatMark()).toBe("working");
    two.unread = true;
    expect(chatMark()).toBe("unread");
    one.needs = "permission";
    expect(chatMark()).toBe("asking");
  });

  it("leave a project's sessions out of the mark", () => {
    const work = create(A, null, "claude-code", null, null, null, null);
    work.unread = true;
    expect(chatMark()).toBeNull();
  });
});
