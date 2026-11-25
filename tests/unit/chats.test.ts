import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where the core says the chats folder is, and how often it was asked. */
const fake = {
  dir: "/home/ada/.chord/chats" as string | null,
  foreign: [] as string[],
  asked: 0,
  titles: [] as string[],
};

vi.mock("$lib/core", () => ({
  core: () =>
    new Proxy(
      {
        async chatsDir() {
          fake.asked += 1;
          if (fake.dir === null) throw "/home/ada/.chord/chats is a link, not a folder";
          return { dir: fake.dir, foreign: fake.foreign };
        },
        async projectInfo(path: string) {
          return { path, name: path.split("/").at(-1)!, repository: path, isGit: true };
        },
        async setWindowTitle(title: string) {
          fake.titles.push(title);
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
  chatOnScreen,
  chatRows,
  chats,
  footEntries,
  isChat,
  isChatsFolder,
  load,
  olderCount,
  pastChats,
  recentChats,
  resetChats,
} from "$lib/chats.svelte";
import {
  activeSession,
  close,
  create,
  forProject,
  reset as resetSessions,
  select,
  sessions,
  shownName,
  type HistoryEntry,
} from "$lib/sessions.svelte";
import { offeredChats, openResume, pickChat, resume } from "$lib/resume.svelte";
import {
  chatClosed,
  chatInFront,
  goTo,
  hookedProjects,
  openPath,
  projectLabel,
  reset as resetWorkspace,
  restore,
  resumeChat,
  startSession,
  workspace,
} from "$lib/workspace.svelte";
import { projects, resetProjects } from "$lib/projects.svelte";
import { changesVisible, layout, terminalVisible, toggleTerminal } from "$lib/layout.svelte";
import { projectFor } from "$lib/show.svelte";
import { ownerOnScreen } from "$lib/terminals.svelte";

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
  fake.foreign = [];
  fake.asked = 0;
  fake.titles = [];
  resetChats(DIR);
  resetWorkspace();
  resetProjects();
  workspace.open = [{ path: A, name: "one", repository: A, isGit: true }];
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
    expect(chats.error).toBeNull();
    expect(chats.foreign).toEqual([]);
  });

  it("are nowhere when the core cannot use the folder, which says why", async () => {
    resetChats();
    fake.dir = null;
    expect(await load()).toBeNull();
    expect(isChatsFolder(DIR)).toBe(false);
    expect(chatCount()).toBe(0);
    expect(chats.error).toBe("/home/ada/.chord/chats is a link, not a folder");
  });

  it("keep the files in the folder the workbench did not write, to name", async () => {
    resetChats();
    fake.foreign = [".claude/settings.json", "CLAUDE.md"];
    expect(await load()).toBe(DIR);
    expect(chats.foreign).toEqual([".claude/settings.json", "CLAUDE.md"]);
  });

  it("are the sessions in the folder, never a project's", () => {
    const chat = create(DIR, null, "claude-code", null, null, null, null);
    const work = create(A, null, "claude-code", null, null, null, null);
    expect(isChat(chat)).toBe(true);
    expect(isChat(work)).toBe(false);
    expect(chatRows()).toEqual([chat]);
  });

  it("read as a new chat until something names them", () => {
    expect(shownName(create(DIR, null, "claude-code", null, null, null, null))).toBe("New chat");
    expect(shownName(create(A, null, "claude-code", null, null, null, null))).toBe("New session");
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

describe("the chats folder in the window", () => {
  it("is called Chats, and is in front without being an open project", () => {
    expect(projectLabel(DIR)).toBe("Chats");
    startSession(DIR);
    expect(forProject(DIR)).toHaveLength(1);
    expect(workspace.active).toBe(DIR);
    expect(chatInFront()).toBe(true);
    expect(workspace.open.map((project) => project.path)).toEqual([A]);
    expect(fake.titles.at(-1)).toBe("Chats — Chord");
  });

  it("is never used as a project, so never sorted or split among them", () => {
    startSession(DIR);
    expect(projects.used[DIR]).toBeUndefined();
    startSession(A);
    expect(projects.used[A]).toBeDefined();
  });

  it("opened by its path is in front with no chat on screen, and stays out of the open projects", async () => {
    create(DIR, null, "claude-code", null, null, null, null);
    sessions.active = null;
    expect(await openPath(DIR)).toBe(true);
    expect(workspace.open.map((project) => project.path)).toEqual([A]);
    expect(workspace.active).toBe(DIR);
    expect(activeSession()).toBeNull();
  });

  it("opened by its path with a chat on screen keeps that chat", async () => {
    startSession(DIR);
    const chat = activeSession()!;
    expect(await openPath(DIR)).toBe(true);
    expect(activeSession()).toBe(chat);
  });

  it("brings a chat on screen when the user picks it", () => {
    const chat = create(DIR, null, "claude-code", null, null, null, null);
    startSession(A);
    expect(goTo(chat.key)).toBe(true);
    expect(workspace.active).toBe(DIR);
    expect(activeSession()).toBe(chat);
  });

  it("takes the hooks answer the open projects take", () => {
    expect(hookedProjects()).toEqual([A, DIR]);
    resetChats();
    expect(hookedProjects()).toEqual([A]);
  });

  it("is in front again after a restart when a chat was, and never opened among the projects", async () => {
    resetChats();
    workspace.open = [];
    localStorage.setItem("chord.workspace", JSON.stringify({ open: [A, DIR], active: DIR }));
    await restore();
    expect(workspace.open.map((project) => project.path)).toEqual([A]);
    expect(workspace.active).toBe(DIR);
  });

  it("is in front after a restart with no chat in place of the one that was on screen", async () => {
    resetChats();
    workspace.open = [];
    create(DIR, null, "claude-code", null, null, null, null);
    localStorage.setItem("chord.workspace", JSON.stringify({ open: [A], active: DIR }));
    await restore();
    expect(workspace.active).toBe(DIR);
    expect(activeSession()).toBeNull();
  });
});

describe("the chats line", () => {
  it("holds nothing under it while closed with no chat on screen", () => {
    create(DIR, null, "claude-code", null, null, null, null);
    select(create(A, null, "claude-code", null, null, null, null).key);
    expect(chatOnScreen()).toBeNull();
    expect(footEntries()).toEqual([]);
  });

  it("keeps the chat on screen under it while closed", () => {
    create(DIR, null, "claude-code", null, null, null, null);
    const on = create(DIR, null, "claude-code", null, null, null, null);
    select(on.key);
    expect(chatOnScreen()).toBe(on);
    expect(footEntries()).toMatchObject([{ kind: "row", session: on }]);
  });

  it("lists the recent chats while the tray is open", () => {
    sessions.history[DIR] = Array.from({ length: 7 }, (_, index) => past(`p${index}`, index + 1));
    create(DIR, null, "claude-code", null, null, null, null);
    chats.tray = true;
    expect(footEntries()).toHaveLength(5);
    expect(olderCount()).toBe(3);
  });
});

describe("a past chat", () => {
  it("resumes in front, under the account it ran under, without opening the folder", () => {
    const chat = resumeChat({ ...past("a", 3), account: "home" });
    expect(chat).not.toBeNull();
    expect(chat!.project).toBe(DIR);
    expect(chat!.account).toBe("home");
    expect(workspace.active).toBe(DIR);
    expect(activeSession()).toBe(chat);
    expect(workspace.open.map((project) => project.path)).toEqual([A]);
  });

  it("cannot resume while the folder is unknown", () => {
    resetChats();
    expect(resumeChat(past("a", 3))).toBeNull();
    expect(forProject(DIR)).toEqual([]);
  });
});

describe("the older chats", () => {
  it("list every chat, open or past, the latest first, narrowed by name", () => {
    sessions.history[DIR] = [past("a", 1), past("b", 30), { ...past("c", 400), title: "Plans for spring" }];
    const row = create(DIR, null, "claude-code", null, null, null, null);
    openResume(DIR);
    expect(offeredChats().map((entry) => (entry.kind === "row" ? entry.session.key : entry.transcript.id))).toEqual([
      row.key,
      "a",
      "b",
      "c",
    ]);
    resume.query = "SPRING plans";
    expect(offeredChats().map((entry) => (entry.kind === "past" ? entry.transcript.id : null))).toEqual(["c"]);
  });

  it("put the one picked in front and close", () => {
    sessions.history[DIR] = [past("a", 1)];
    openResume(DIR);
    const [entry] = offeredChats();
    pickChat(entry);
    expect(resume.open).toBe(false);
    expect(activeSession()?.resumedFrom).toBe("a");
    expect(workspace.active).toBe(DIR);
  });
});

describe("a chat on screen", () => {
  const place = (path: string, cwd = DIR) => ({ path, from: 1, to: 1, note: null, cwd, session: null });

  beforeEach(() => {
    layout.mode = "working";
    layout.chat = false;
    layout.changesChosen = true;
    layout.changesForced = false;
    layout.noProject = false;
    layout.terminalChosen = false;
    layout.terminalForced = false;
  });

  it("hides the right side but for what its agent presents or shows", () => {
    layout.chat = true;
    expect(changesVisible()).toBe(false);
    layout.mode = "reviewing";
    expect(changesVisible()).toBe(true);
    layout.chat = false;
    layout.mode = "working";
    expect(changesVisible()).toBe(true);
  });

  it("has no project terminal, and its toggle leaves the choice alone", () => {
    layout.terminalChosen = true;
    layout.chat = true;
    expect(terminalVisible()).toBe(false);
    toggleTerminal();
    expect(layout.terminalChosen).toBe(true);
    startSession(DIR);
    expect(ownerOnScreen()).toBeNull();
  });

  it("shows its own files and what lies under no open project, a project's in the project", () => {
    expect(projectFor(place(`${DIR}/march-budget.md`))).toBe(DIR);
    expect(projectFor(place(`${DIR}/notes.md`, A))).toBe(DIR);
    expect(projectFor(place("/tmp/plot.png"))).toBe(DIR);
    expect(projectFor(place(`${A}/src/main.ts`))).toBe(A);
    expect(projectFor(place("/tmp/plot.png", "/home/ada/elsewhere"))).toBeNull();
  });

  it("closed, takes the chats out of the front for the first open project", () => {
    startSession(DIR);
    const chat = activeSession()!;
    expect(chatInFront()).toBe(true);
    close(chat.key);
    chatClosed(chat.key);
    expect(workspace.active).toBe(A);
  });

  it("closed with no project open, leaves nothing in front", () => {
    workspace.open = [];
    startSession(DIR);
    const chat = activeSession()!;
    close(chat.key);
    chatClosed(chat.key);
    expect(workspace.active).toBeNull();
  });

  it("leaves the chats in front when another session takes the closed one's place", () => {
    startSession(DIR);
    const one = activeSession()!;
    startSession(DIR);
    const two = activeSession()!;
    close(one.key);
    select(two.key);
    chatClosed(one.key);
    expect(workspace.active).toBe(DIR);
  });
});
