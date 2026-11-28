import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConductor } from "$lib/conductor.svelte";
import { reopen } from "$lib/reopen.svelte";
import { resetAttention } from "$lib/attention.svelte";
import {
  create,
  exact,
  lastActive,
  loadRemembered,
  reset as resetSessions,
  sessions,
  started,
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
    one.changedAt = Date.now();
    expect(lastActive(one)).toBe(was);
  });
});
