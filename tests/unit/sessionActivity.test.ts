import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConductor } from "$lib/conductor.svelte";
import { reopen } from "$lib/reopen.svelte";
import { resetAttention } from "$lib/attention.svelte";
import {
  GREEN_FOR,
  YELLOW_FOR,
  activeShown,
  create,
  dotAge,
  ended,
  exact,
  recency,
  lastActive,
  loadRemembered,
  reset as resetSessions,
  sessions,
  started,
  typed,
  wake,
  type Session,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { reset as resetWorkflows } from "$lib/workflows.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    spawn: async (options: { session?: string }) => ({ ptyId: "pty-1", sessionId: options.session ?? null }),
    kill: async () => {},
    setWindowTitle: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    transcripts: async () => [],
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
  }),
}));

const A = "/home/ada/dev/one";
const DAY = 24 * 60 * 60 * 1000;

let stop = () => {};

function open() {
  resetWorkflows();
  resetSessions();
  resetWorkspace();
  resetConductor();
  resetAttention();
  workspace.open.push({ path: A, name: A, repository: A, isGit: true });
  workspace.active = A;
  loadRemembered();
  stop = reopen();
  flushSync();
}

function quit() {
  flushSync();
  stop();
  stop = () => {};
}

const row = (id: string): Session => sessions.all.find((session) => session.id === id)!;

beforeEach(() => {
  localStorage.clear();
  open();
});

afterEach(() => quit());

describe("when a session was last active", () => {
  it("is kept across a quit, and bringing the session back never moves it", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 6 * DAY;
    const was = one.activeAt;

    quit();
    open();
    expect(row("one").status).toBe("dormant");
    expect(lastActive(row("one"))).toBe(was);

    wake(row("one").key);
    started(row("one").key, "pty-2", "one");
    expect(lastActive(row("one"))).toBe(was);
  });

  it("takes the stored conversation's time for a row from a record that had none", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    quit();
    const record = JSON.parse(localStorage.getItem("chord.open")!);
    expect(record.open).toHaveLength(1);
    for (const entry of record.open) delete entry.active;
    localStorage.setItem("chord.open", JSON.stringify(record));
    open();
    const at = Date.now() - 9 * DAY;
    sessions.history[A] = [
      { id: "one", title: null, modified: Math.floor(at / 1000), size: 1, cwd: null, agent: "claude-code", account: null },
    ];
    expect(lastActive(row("one"))).toBe(Math.floor(at / 1000) * 1000);
  });

  it("moves with the agent's turn and the user's message", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 6 * DAY;
    exact("one", "prompt");
    expect(Date.now() - lastActive(one)).toBeLessThan(5000);

    one.activeAt = Date.now() - 6 * DAY;
    exact("one", "stop");
    expect(Date.now() - lastActive(one)).toBeLessThan(5000);
  });

  it("is not moved by a run ending", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 6 * DAY;
    const was = one.activeAt;
    ended({ id: "pty-1", code: 0, clean: true });
    expect(one.status).toBe("exited");
    expect(lastActive(one)).toBe(was);
  });

  it("moves when a line is sent in the terminal that fires no prompt hook", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 6 * DAY;
    typed("pty-1", "/compact");
    expect(Date.now() - lastActive(one)).toBeGreaterThan(5 * DAY);
    typed("pty-1", "\r");
    expect(Date.now() - lastActive(one)).toBeLessThan(5000);
  });

  it("moves when an idle notice ends a turn", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    exact("one", "prompt");
    one.activeAt = Date.now() - 6 * DAY;
    exact("one", "idle");
    expect(one.working).toBe(false);
    expect(Date.now() - lastActive(one)).toBeLessThan(5000);
  });

  it("reads now while the agent works a turn, and as it was after", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    exact("one", "prompt");
    one.activeAt = Date.now() - 6 * DAY;
    const now = Date.now();
    expect(one.working).toBe(true);
    expect(activeShown(one, now)).toBe(now);
    expect(dotAge(one, now)).toBe("recent");
    one.working = false;
    expect(activeShown(one, now)).toBe(now - 6 * DAY);
  });
});

describe("a row left from the last quit", () => {
  const write = (id: string, modified: number, active: number | null) => {
    sessions.history[A] = [
      { id, title: null, modified, size: 1, cwd: null, agent: "claude-code", account: null, active },
    ];
  };

  it("keeps its stored time however late its transcript was written", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 40 * DAY;
    const was = one.activeAt;
    quit();
    open();
    write("one", Math.floor(Date.now() / 1000), Math.floor(was / 1000));
    expect(lastActive(row("one"))).toBe(was);
    expect(dotAge(row("one"), Date.now())).toBe("stale");
  });

  it("takes the time of the transcript's last turn, not of its last write", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    quit();
    const record = JSON.parse(localStorage.getItem("chord.open")!);
    for (const entry of record.open) delete entry.active;
    localStorage.setItem("chord.open", JSON.stringify(record));
    open();
    const turn = Math.floor((Date.now() - 9 * DAY) / 1000);
    write("one", Math.floor(Date.now() / 1000), turn);
    expect(lastActive(row("one"))).toBe(turn * 1000);
  });

  it("is woken before its history is read without taking the window's start for its time", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    quit();
    const record = JSON.parse(localStorage.getItem("chord.open")!);
    for (const entry of record.open) delete entry.active;
    localStorage.setItem("chord.open", JSON.stringify(record));
    open();
    wake(row("one").key);
    expect(row("one").activeAt).toBeNull();
    const turn = Math.floor((Date.now() - 9 * DAY) / 1000);
    write("one", turn, turn);
    expect(lastActive(row("one"))).toBe(turn * 1000);
  });
});

describe("the dot's age", () => {
  it("is green to 4 days, yellow to 14, older after", () => {
    const now = Date.now();
    expect(GREEN_FOR).toBe(4 * DAY);
    expect(YELLOW_FOR).toBe(14 * DAY);
    expect(recency(now, now)).toBe("recent");
    expect(recency(now - 4 * DAY, now)).toBe("recent");
    expect(recency(now - 4 * DAY - 1, now)).toBe("stale");
    expect(recency(now - 14 * DAY, now)).toBe("stale");
    expect(recency(now - 14 * DAY - 1, now)).toBe("old");
  });

  it("is the same before a quit and after the start", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.activeAt = Date.now() - 6 * DAY;
    const now = Date.now();
    expect(dotAge(one, now)).toBe("stale");
    quit();
    open();
    expect(row("one").status).toBe("dormant");
    expect(dotAge(row("one"), now)).toBe("stale");
  });

  it("is none for a session that exited or failed", () => {
    const one = create(A);
    started(one.key, "pty-1", "one");
    one.status = "exited";
    expect(dotAge(one, Date.now())).toBeNull();
    one.status = "crashed";
    expect(dotAge(one, Date.now())).toBeNull();
  });
});
