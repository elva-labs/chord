import { flushSync } from "svelte";
import type { SpawnOptions } from "$lib/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductor, PUT_AWAY_AFTER, resetConductor, startedFor, unheard, watchStops } from "$lib/conductor.svelte";
import { childrenOf } from "$lib/orchestrator.svelte";
import { pluginStarted, pluginStartOf, resetPluginStarts } from "$lib/pluginStarts.svelte";
import { reopen, settleWhen, startup } from "$lib/reopen.svelte";
import {
  activeSession,
  close,
  create,
  ended,
  forProject,
  isLive,
  reset as resetSessions,
  select,
  sessions,
  sessionModelName,
  launch,
  loadRemembered,
  started,
  statusLabel,
  wake,
} from "$lib/sessions.svelte";
import {
  reset as resetWorkspace,
  restore,
  workspace,
} from "$lib/workspace.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";

/** The answer a host gives for a project on it, held until released. */
const host = vi.hoisted(() => ({
  release: (_ok: boolean) => {},
}));

/** What the core answers when a row asks for the integrated session under
    its handle: by default it runs none, as after a restart. */
const snapshots = vi.hoisted(() => ({
  answer: (): Promise<never> => Promise.reject(new Error("no such session")),
}));

const spawned: SpawnOptions[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    spawn: async (options: SpawnOptions) => {
      spawned.push(options);
      return { ptyId: `pty-${spawned.length + 10}`, sessionId: options.session ?? null };
    },
    kill: async () => {},
    setWindowTitle: async () => {},
    integratedSnapshot: () => snapshots.answer(),
    projectInfo: async (path: string) => {
      if (path.startsWith("ssh://")) {
        const ok = await new Promise<boolean>((resolve) => (host.release = resolve));
        if (!ok) throw new Error("no answer");
      }
      return { path, name: path, repository: path, isGit: true };
    },
    transcripts: async () => [],
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";
const KEY = "chord.open";

const repo = (path: string) => ({ path, name: path, repository: path, isGit: true });

let stop: () => void = () => {};

beforeEach(() => {
  snapshots.answer = () => Promise.reject(new Error("no such session"));
  // A session follows no workflow here unless a test gives it one.
  resetWorkflows();
  resetSessions();
  resetWorkspace();
  resetConductor();
  resetPluginStarts();
  workspace.open.push(repo(A), repo(B));
  workspace.active = A;
});

afterEach(() => stop());

/** What is on record for the next start. */
function record(): { open: { project: string; id: string }[]; active: string | null } {
  return JSON.parse(localStorage.getItem(KEY) ?? "null");
}

/** A session that has come up with an id, as one does in practice. */
function live(project: string, id: string) {
  const session = create(project);
  started(session.key, `pty-${id}`, id);
  return session;
}

describe("settling the start", () => {
  it("settles once the restore does, and when it fails on the way as well", async () => {
    startup.settled = false;
    await settleWhen(Promise.resolve());
    expect(startup.settled).toBe(true);
    startup.settled = false;
    await settleWhen(Promise.reject(new Error("the restore threw")));
    expect(startup.settled).toBe(true);
  });

  it("is settled by bringing the sessions back", () => {
    startup.settled = false;
    stop = reopen();
    expect(startup.settled).toBe(true);
  });
});

describe("keeping the record", () => {
  it("records the live sessions and the one on screen", () => {
    stop = reopen();
    live(A, "one");
    live(B, "two");
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(record().active).toBe("two");
  });

  it("takes a session closed by hand off the record", () => {
    stop = reopen();
    const one = live(A, "one");
    live(A, "two");
    close(one.key);
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["two"]);
  });

  it("takes a session that ended off the record", () => {
    stop = reopen();
    live(A, "one");
    ended({ id: "pty-one", code: 0, clean: true });
    flushSync();
    expect(record().open).toEqual([]);
  });

  it("keeps a terminal session another session started, as any other", () => {
    stop = reopen();
    live(A, "caller");
    const child = live(B, "child");
    conductor.startedBy[child.key] = "caller";
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["caller", "child"]);
  });

  it("keeps an integrated session another session started, which the core goes on running", () => {
    stop = reopen();
    live(A, "caller");
    const child = create(B, null, "claude-code", null, null, null, null, undefined, "integrated");
    started(child.key, "pty-child", "child");
    conductor.startedBy[child.key] = "caller";
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["caller", "child"]);
  });

  it("keeps where a session was started and on which model", () => {
    stop = reopen();
    const session = create(A, "one", "claude-code", "/home/ada/dev/one/tree", null, "opus");
    started(session.key, "pty-1", "one");
    flushSync();
    expect(record().open[0]).toEqual({
      project: A,
      id: "one",
      agent: "claude-code",
      startIn: "/home/ada/dev/one/tree",
      model: "opus",
      account: null,
      kind: "terminal",
    });
  });

  it("keeps that a session runs in a worktree made for it", () => {
    stop = reopen();
    const session = create(A, "one", "claude-code", "/home/ada/dev/one/tree");
    session.madeTree = true;
    started(session.key, "pty-1", "one");
    flushSync();
    expect((record().open[0] as { made?: boolean }).made).toBe(true);
  });

  it("keeps the plugin's start a session was made by", () => {
    stop = reopen();
    const session = create(A, null, "claude-code", null, "Fix issue 12");
    pluginStarted(session.key, { source: "local", plugin: "github", project: A, request: "req-1" });
    started(session.key, "pty-1", "one");
    flushSync();
    expect((record().open[0] as { plugin?: object }).plugin).toEqual({
      source: "local",
      plugin: "github",
      project: A,
      request: "req-1",
    });
  });

  it("keeps the model a session said it ran on, beside the one chosen for it", () => {
    stop = reopen();
    const session = create(A, "one", "codex");
    session.runsOn = "gpt-5-codex";
    started(session.key, "pty-1", "one");
    flushSync();
    expect(record().open[0]).toMatchObject({ model: null, runsOn: "gpt-5-codex" });
  });

  it("keeps the Codex profile a session runs under, and says none for one under none", () => {
    stop = reopen();
    const under = create(A, "one", "codex");
    under.profile = "fast";
    started(under.key, "pty-1", "one");
    started(create(A, "two", "codex").key, "pty-2", "two");
    flushSync();
    expect(record().open[0]).toMatchObject({ profile: "fast" });
    expect(record().open[1]).not.toHaveProperty("profile");
  });

  it("brings a session that follows a workflow back on that workflow after a quit", async () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    stop = reopen();
    const session = create(A);
    started(session.key, "pty-1", "one");
    flushSync();
    expect(record().open[0]).toMatchObject({ id: "one", agent: "claude-code", model: "fable" });
    stop();

    // The app starts again with the workflow deleted meanwhile: the session
    // follows the copy it kept, and says it is one.
    resetSessions();
    loadRemembered();
    adoptWorkflows({ list: [], default: null, overrides: {} });
    stop = reopen();
    flushSync();
    const back = sessions.all.find((row) => row.id === "one")!;
    wake(back.key);
    await launch(back.key, 80, 24, () => {});
    expect(back.workflow).toEqual(defaultWorkflow());
    expect(back.workflowGone).toBe(true);
    expect(spawned.at(-1)).toMatchObject({ session: "one", model: "fable" });
  });
});

describe("coming back", () => {
  function onRecord(open: object[], active: string | null) {
    localStorage.setItem(KEY, JSON.stringify({ open, active }));
  }

  const entry = (project: string, id: string) => ({
    project,
    id,
    agent: "claude-code",
    startIn: null,
    model: null,
  });

  it("brings each back as a row with nothing running behind it", () => {
    onRecord([entry(A, "one"), entry(A, "two"), entry(B, "three")], "one");
    stop = reopen();
    expect(forProject(A).map((session) => session.id)).toEqual(["one", "two"]);
    expect(forProject(B).map((session) => session.id)).toEqual(["three"]);
    for (const session of sessions.all) {
      expect(session.status).toBe("dormant");
      expect(session.resumedFrom).toBe(session.id);
      expect(isLive(session)).toBe(false);
    }
  });

  it("names a row by the model it said it ran on, and starts it again on the one chosen", async () => {
    onRecord([{ ...entry(A, "one"), agent: "codex", runsOn: "gpt-5-codex" }, { ...entry(A, "two"), agent: "codex" }], null);
    stop = reopen();
    const [said, silent] = forProject(A);
    expect(said.runsOn).toBe("gpt-5-codex");
    expect(sessionModelName(said)).toBe("gpt-5-codex");
    expect(silent.runsOn).toBeNull();
    wake(said.key);
    await launch(said.key, 80, 24, () => {});
    expect(spawned.at(-1)?.session).toBe("one");
    expect(spawned.at(-1)?.model).toBeUndefined();
  });

  it("starts a session again under the Codex profile it ran under, and drops an entry naming no profile's name", async () => {
    onRecord(
      [{ ...entry(A, "one"), agent: "codex", profile: "fast" }, { ...entry(A, "two"), agent: "codex", profile: "../fast" }],
      null,
    );
    stop = reopen();
    expect(forProject(A).map((session) => session.id)).toEqual(["one"]);
    const [under] = forProject(A);
    expect(under.profile).toBe("fast");
    wake(under.key);
    await launch(under.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "one", profile: "fast" });
  });

  it("brings back the plugin's start a session was made by, and its next run tells the core again", async () => {
    const plugin = { source: "local", plugin: "github", project: A, request: "req-1" };
    onRecord([{ ...entry(A, "one"), plugin }], null);
    stop = reopen();
    const [row] = forProject(A);
    expect(pluginStartOf(row.key)).toEqual(plugin);
    wake(row.key);
    await launch(row.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "one", pluginStart: "req-1" });
  });

  it("drops an entry whose plugin's start names another project", () => {
    onRecord(
      [
        { ...entry(A, "one"), plugin: { source: "local", plugin: "github", project: B, request: "req-1" } },
        entry(A, "two"),
      ],
      null,
    );
    stop = reopen();
    expect(forProject(A).map((session) => session.id)).toEqual(["two"]);
  });

  it("brings back that a session runs in a worktree made for it, which a record from before does not say", () => {
    onRecord([{ ...entry(A, "one"), startIn: `${A}/tree`, made: true }, { ...entry(A, "two"), startIn: `${A}/tree` }], null);
    stop = reopen();
    expect(forProject(A).map((session) => session.madeTree)).toEqual([true, false]);
  });

  it("brings back each session another started under its starter, where it stood, and keeps it while the record does not say its work was over", async () => {
    const kid = { id: "kid", project: B, worktree: null, agent: "claude-code" as const, name: "Fix it" };
    conductor.started.lead = [kid, { ...kid, id: "chat" }, { ...kid, id: "taken" }];
    let asked = false;
    snapshots.answer = () => {
      asked = true;
      return Promise.reject(new Error("no such session"));
    };
    onRecord(
      [
        entry(A, "lead"),
        entry(B, "kid"),
        { ...entry(B, "chat"), kind: "integrated" },
        { ...entry(B, "taken"), kind: "integrated", handle: "h-taken" },
      ],
      "lead",
    );
    const unwatch = watchStops();
    try {
      stop = reopen();
      // A run the core no longer has leaves its row as any other.
      await vi.waitFor(() => expect(asked).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      const [lead] = forProject(A);
      const kids = forProject(B);
      expect(kids.map((session) => session.id)).toEqual(["kid", "chat", "taken"]);
      expect(childrenOf(lead)).toEqual(kids);
      for (const session of kids) expect(session.status).toBe("dormant");
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER * 2);
      expect(forProject(B)).toEqual(kids);
      for (const id of ["kid", "chat", "taken"]) expect(spawned.map((options) => options.session)).not.toContain(id);
      expect(conductor.started[lead.token].every((entry) => entry.left === undefined)).toBe(true);
    } finally {
      unwatch();
      vi.useRealTimers();
    }
  });

  it("puts away after the usual rest a session another started whose work was over at the quit, keeping it on its starter's list", async () => {
    const kid = { id: "kid", project: B, worktree: null, agent: "claude-code" as const, name: "Fix it" };
    conductor.started.lead = [kid, { ...kid, id: "busy" }];
    onRecord([entry(A, "lead"), { ...entry(B, "kid"), over: true }, entry(B, "busy")], "lead");
    const unwatch = watchStops();
    vi.useFakeTimers();
    try {
      stop = reopen();
      const [lead] = forProject(A);
      const [over, busy] = forProject(B);
      expect(childrenOf(lead)).toEqual([over, busy]);
      for (const row of [over, busy]) expect(row.status).toBe("dormant");
      // The record keeps which was over, for a restart before it goes.
      flushSync();
      expect(record().open.map((kept) => [kept.id, (kept as { over?: boolean }).over])).toEqual([
        ["lead", undefined],
        ["kid", true],
        ["busy", undefined],
      ]);
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER - 1000);
      expect(forProject(B)).toEqual([over, busy]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(forProject(B)).toEqual([busy]);
      // Put away, it moves to the end of its starter's list, the latest gone.
      expect(conductor.started[lead.token].map((entry) => [entry.id, entry.left])).toEqual([
        ["busy", undefined],
        ["kid", "done"],
      ]);
      flushSync();
      expect(record().open.map((kept) => kept.id)).toEqual(["lead", "busy"]);
      expect(spawned.map((options) => options.session)).not.toContain("kid");
    } finally {
      unwatch();
      vi.useRealTimers();
    }
  });

  it("keeps a session whose work was over at the quit while it is unread or on screen, and puts it away the usual rest after", async () => {
    conductor.started.lead = [{ id: "kid", project: B, worktree: null, agent: "claude-code", name: "Fix it" }];
    localStorage.setItem(
      "chord.waiting",
      JSON.stringify({ kid: { unread: true, note: "Fixed it", notice: null, at: Date.now() } }),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ open: [entry(A, "lead"), { ...entry(B, "kid"), over: true }], active: "lead", waiting: true }),
    );
    loadRemembered();
    const unwatch = watchStops();
    vi.useFakeTimers();
    try {
      stop = reopen();
      const [lead] = forProject(A);
      const [kid] = forProject(B);
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER * 2);
      expect(forProject(B)).toEqual([kid]);
      // Read, and on screen.
      select(kid.key);
      kid.unread = false;
      flushSync();
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER * 2);
      expect(forProject(B)).toEqual([kid]);
      select(lead.key);
      flushSync();
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER - 1000);
      expect(forProject(B)).toEqual([kid]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(forProject(B)).toEqual([]);
    } finally {
      unwatch();
      vi.useRealTimers();
    }
  });

  it("goes on resting toward being put away when a session whose work was over at the quit only comes up, and not once it works", async () => {
    const kid = { id: "looked", project: B, worktree: null, agent: "claude-code" as const, name: "Fix it" };
    conductor.started.lead = [kid, { ...kid, id: "worked" }, { ...kid, id: "coming" }];
    onRecord(
      [
        entry(A, "lead"),
        { ...entry(B, "looked"), over: true },
        { ...entry(B, "worked"), over: true },
        { ...entry(B, "coming"), over: true },
      ],
      "lead",
    );
    const unwatch = watchStops();
    vi.useFakeTimers();
    try {
      stop = reopen();
      const [lead] = forProject(A);
      const [looked, worked, coming] = forProject(B);
      for (const row of [looked, worked]) {
        wake(row.key);
        started(row.key, `pty-${row.id}`, row.id);
      }
      worked.working = true;
      flushSync();
      worked.working = false;
      // Quit while it comes up, it is on record as at work.
      wake(coming.key);
      flushSync();
      expect(record().open.map((kept) => [kept.id, (kept as { over?: boolean }).over])).toEqual([
        ["lead", undefined],
        ["looked", true],
        ["worked", undefined],
        ["coming", undefined],
      ]);
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER);
      expect(forProject(B)).toEqual([worked, coming]);
      expect(conductor.started[lead.token].map((entry) => [entry.id, entry.left])).toEqual([
        ["worked", undefined],
        ["coming", undefined],
        ["looked", "done"],
      ]);
    } finally {
      unwatch();
      vi.useRealTimers();
    }
  });

  it("keeps the row of a session another started while the core could not say whether it still runs it", async () => {
    conductor.started.lead = [{ id: "kid", project: B, worktree: null, agent: "claude-code", name: "Fix it" }];
    let asked = false;
    snapshots.answer = () => {
      asked = true;
      return Promise.reject(new Error("the session's news did not go out in time"));
    };
    onRecord([entry(A, "lead"), { ...entry(B, "kid"), kind: "integrated", handle: "h-kid" }], "lead");
    stop = reopen();
    await vi.waitFor(() => expect(asked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forProject(B).map((session) => session.id)).toEqual(["kid"]);
    expect(forProject(B)[0].status).toBe("dormant");
  });

  it("brings back unread a session another started that was, which its starter hears nothing of until it runs", async () => {
    conductor.started.lead = [{ id: "kid", project: B, worktree: null, agent: "claude-code", name: "Fix it" }];
    localStorage.setItem(
      "chord.waiting",
      JSON.stringify({ kid: { unread: true, note: "Fixed it", notice: null, at: Date.now() } }),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ open: [entry(A, "lead"), entry(B, "kid")], active: "lead", waiting: true }),
    );
    loadRemembered();
    const unwatch = watchStops();
    vi.useFakeTimers();
    try {
      stop = reopen();
      const [lead] = forProject(A);
      const [kid] = forProject(B);
      expect(kid.unread).toBe(true);
      expect(kid.note).toBe("Fixed it");
      // The starter runs again, and is at rest.
      wake(lead.key);
      started(lead.key, "pty-lead", "lead");
      flushSync();
      expect(childrenOf(lead)).toEqual([kid]);
      expect(unheard(lead)).toEqual([]);
      // Seen, it stays as any row from before the restart does.
      kid.unread = false;
      flushSync();
      await vi.advanceTimersByTimeAsync(PUT_AWAY_AFTER * 2);
      expect(forProject(B)).toEqual([kid]);
      expect(kid.status).toBe("dormant");
    } finally {
      unwatch();
      vi.useRealTimers();
    }
  });

  it("puts the one that was on screen back on screen", () => {
    onRecord([entry(A, "one"), entry(A, "two")], "one");
    stop = reopen();
    expect(activeSession()?.id).toBe("one");
  });

  it("opens no session when the one on screen was another project's", () => {
    onRecord([entry(A, "one"), entry(A, "two"), entry(B, "three")], "three");
    stop = reopen();
    expect(sessions.active).toBeNull();
  });

  it("opens no session when none was on screen", () => {
    onRecord([entry(A, "one"), entry(A, "two")], null);
    stop = reopen();
    expect(sessions.active).toBeNull();
    flushSync();
    expect(record().active).toBeNull();
  });

  it("brings back the name a session had", () => {
    sessions.names.one = "the refactor";
    onRecord([entry(A, "one")], null);
    stop = reopen();
    expect(forProject(A)[0].title).toBe("the refactor");
  });

  it("brings back the orchestrator folder's sessions once it is known, though it is not an open project", async () => {
    const ORCHESTRATOR = "/home/ada/.chord/orchestrator";
    onRecord([entry(ORCHESTRATOR, "conductor"), entry("/gone", "one"), entry(A, "two")], null);
    let know: (dir: string | null) => void = () => {};
    stop = reopen(new Map(), new Promise((resolve) => (know = resolve)));
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
    // Kept on record while the folder is not known yet.
    flushSync();
    expect(record().open.map((kept) => kept.id).sort()).toEqual(["conductor", "one", "two"]);
    know(ORCHESTRATOR);
    await Promise.resolve();
    await Promise.resolve();
    expect(sessions.all.map((session) => session.id)).toEqual(["two", "conductor"]);
    flushSync();
    expect(record().open.map((kept) => kept.id).sort()).toEqual(["conductor", "two"]);
  });

  it("brings back chats once the chats folder is known, the chat on screen in front", async () => {
    const ORCHESTRATOR = "/home/ada/.chord/orchestrator";
    const CHATS = "/home/ada/.chord/chats";
    onRecord([entry(CHATS, "chat"), entry(ORCHESTRATOR, "conductor"), entry("/gone", "one"), entry(A, "two")], "chat");
    workspace.active = CHATS;
    let knowFolder: (dir: string | null) => void = () => {};
    let knowChats: (dir: string | null) => void = () => {};
    stop = reopen(
      new Map(),
      new Promise((resolve) => (knowFolder = resolve)),
      new Promise((resolve) => (knowChats = resolve)),
    );
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
    knowFolder(ORCHESTRATOR);
    await Promise.resolve();
    await Promise.resolve();
    // A session in a folder not open stays on record while the chats
    // folder is not known yet: it may be a chat.
    flushSync();
    expect(record().open.map((kept) => kept.id).sort()).toEqual(["chat", "conductor", "one", "two"]);
    knowChats(CHATS);
    await Promise.resolve();
    await Promise.resolve();
    expect(sessions.all.map((session) => session.id)).toEqual(["two", "conductor", "chat"]);
    expect(activeSession()?.id).toBe("chat");
    flushSync();
    expect(record().open.map((kept) => kept.id).sort()).toEqual(["chat", "conductor", "two"]);
  });

  it("leaves out a session whose project is not open", () => {
    onRecord([entry("/gone", "one"), entry(A, "two")], null);
    stop = reopen();
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
  });

  it("keeps a row that never started on the record", () => {
    onRecord([entry(A, "one"), entry(A, "two")], "two");
    stop = reopen();
    flushSync();
    expect(record().open.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("hands what an earlier version kept under a folder to the one Codex session that was open there", () => {
    conductor.started = {
      [A]: [{ id: "kid", project: B, worktree: null, agent: "codex", name: null }],
    };
    onRecord([{ ...entry(A, "codex-a"), agent: "codex" }, entry(A, "claude-a")], null);
    stop = reopen();
    const back = forProject(A).find((session) => session.id === "codex-a")!;
    // A session from before there were tokens comes back under a token of
    // its own, never its id, and what the folder held is its.
    expect(back.token).not.toBe("codex-a");
    expect(sessions.tokens["codex-a"]?.token).toBe(back.token);
    expect(conductor.started[back.token].map((known) => known.id)).toEqual(["kid"]);
    expect(startedFor(sessions.all.find((session) => session.id === "claude-a")!.key)).toBeNull();
    const other = forProject(A).find((session) => session.id === "claude-a")!;
    expect(conductor.started[other.token]).toBeUndefined();
  });

  it("reads a corrupt record as nothing open", () => {
    localStorage.setItem(KEY, "{not json");
    stop = reopen();
    expect(sessions.all).toEqual([]);
  });

  it("drops entries it cannot read and keeps the rest", () => {
    onRecord([{ project: A, id: 7 }, entry(A, "two")], null);
    stop = reopen();
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
  });
});

describe("waking", () => {
  it("starts a dormant row as a resumed session", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        open: [{ project: A, id: "one", agent: "claude-code", startIn: null, model: null }],
        active: null,
      }),
    );
    stop = reopen();
    const session = forProject(A)[0];
    expect(statusLabel(session)).toBe("was open, starts when selected");
    wake(session.key);
    expect(session.status).toBe("starting");
    expect(session.resumedFrom).toBe("one");
  });

  it("leaves a row that is already going alone", () => {
    const session = live(A, "one");
    wake(session.key);
    expect(session.status).toBe("running");
  });
});

describe("a project on another machine", () => {
  const R = "ssh://ada@lab/srv/x";
  const entry = (project: string, id: string) => ({
    project,
    id,
    agent: "claude-code",
    startIn: null,
    model: null,
  });

  /** Restores a workspace of A and R with R in front, and its sessions. */
  async function restoring(active: string, front: string) {
    resetWorkspace();
    localStorage.setItem(
      "chord.workspace",
      JSON.stringify({ open: [A, R], active: front }),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ open: [entry(A, "here"), entry(R, "there")], active }),
    );
    const arriving = await restore();
    stop = reopen(arriving);
    flushSync();
    return () => Promise.all(arriving.values());
  }

  it("does not hold up the sessions here, and keeps its own on record", async () => {
    const arrived = await restoring("here", A);
    expect(sessions.all.map((session) => session.id)).toEqual(["here"]);
    expect(activeSession()?.id).toBe("here");
    expect(record().open.map((item) => item.id)).toEqual(["here", "there"]);
    host.release(true);
    await arrived();
    flushSync();
    expect(forProject(R).map((session) => session.id)).toEqual(["there"]);
    expect(record().open.map((item) => item.id)).toEqual(["here", "there"]);
    expect(activeSession()?.id).toBe("here");
  });

  it("puts the session that was on screen back when its project arrives", async () => {
    const arrived = await restoring("there", R);
    // The project here is in front meanwhile; the one on screen stays on
    // record as the one to come back to.
    expect(workspace.active).toBe(A);
    expect(record().active).toBe("there");
    host.release(true);
    await arrived();
    flushSync();
    expect(workspace.active).toBe(R);
    expect(activeSession()?.id).toBe("there");
    expect(record().active).toBe("there");
  });

  it("starts nothing in the project in front while the one on screen waits", async () => {
    const arrived = await restoring("there", R);
    expect(workspace.active).toBe(A);
    expect(sessions.active).toBeNull();
    expect(forProject(A).map((session) => session.status)).toEqual(["dormant"]);
    host.release(true);
    await arrived();
    flushSync();
    expect(activeSession()?.id).toBe("there");
    expect(forProject(A).map((session) => session.status)).toEqual(["dormant"]);
  });

  it("opens no session when the one on screen cannot come back", async () => {
    const arrived = await restoring("there", R);
    host.release(false);
    await arrived();
    flushSync();
    expect(workspace.active).toBe(A);
    expect(sessions.active).toBeNull();
  });

  it("opens no session when none was on screen and its project is on another machine", async () => {
    resetWorkspace();
    localStorage.setItem(
      "chord.workspace",
      JSON.stringify({ open: [A, R], active: R }),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ open: [entry(A, "here")], active: null }),
    );
    const arriving = await restore();
    stop = reopen(arriving);
    flushSync();
    expect(workspace.active).toBe(A);
    expect(sessions.active).toBeNull();
    host.release(false);
    await Promise.all(arriving.values());
    flushSync();
    expect(workspace.active).toBe(A);
    expect(sessions.active).toBeNull();
  });

  it("keeps a session picked while it waited across a quit", async () => {
    await restoring("there", R);
    select(forProject(A)[0].key);
    flushSync();
    expect(record().active).toBe("here");
    // Quit before the host answers, and start again.
    stop();
    resetSessions();
    resetWorkspace();
    const arriving = await restore();
    stop = reopen(arriving);
    flushSync();
    expect(workspace.active).toBe(A);
    expect(activeSession()?.id).toBe("here");
    host.release(true);
    await Promise.all(arriving.values());
    flushSync();
    expect(workspace.active).toBe(A);
    expect(activeSession()?.id).toBe("here");
  });

  it("takes its sessions off the record when it cannot be described", async () => {
    const arrived = await restoring("here", A);
    host.release(false);
    await arrived();
    flushSync();
    expect(sessions.all.map((session) => session.id)).toEqual(["here"]);
    expect(record().open.map((item) => item.id)).toEqual(["here"]);
  });
});
