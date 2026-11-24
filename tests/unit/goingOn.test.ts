import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoingOn, GoingOnOptions } from "$lib/core";
import type { Session } from "$lib/sessions.svelte";

let answer: GoingOn = { context: null, idle: null, goesOn: false, briefing: null };
/** Answers by conversation id, ahead of `answer`. */
const answers: Record<string, GoingOn> = {};
const asked: GoingOnOptions[] = [];
/** The conversations whose judgement fails. */
const failing = new Set<string>();

vi.mock("$lib/core", () => ({
  core: () => ({
    async goingOn(options: GoingOnOptions) {
      asked.push(options);
      if (failing.has(options.session)) throw new Error("core restarted");
      return answers[options.session] ?? answer;
    },
  }),
}));
/** The accounts the window adopted. */
const adopted = new Set<string>();
vi.mock("$lib/accounts.svelte", () => ({
  dirFor: () => undefined,
  known: (account: string | null) => account === null || adopted.has(account),
}));

const {
  askWhole,
  briefingBack,
  going,
  briefingFor,
  identified,
  leftBy,
  lineage,
  lineageOf,
  lostAt,
  onWentOn,
  resetGoingOn,
  spoke,
  takeUp,
  tokensText,
  wentOn,
  wentOnFrom,
  wholeOf,
} = await import("$lib/goingOn.svelte");

function row(fields: Partial<Session> = {}): Session {
  return {
    key: "row-1",
    agent: "claude-code",
    project: "/p",
    startIn: null,
    account: null,
    token: "token-1",
    resumedFrom: "old-id",
    ...fields,
  } as Session;
}

const COLD: GoingOn = { context: 967_000, idle: 10_800, goesOn: true, briefing: "BRIEFING" };

beforeEach(() => {
  resetGoingOn();
  localStorage.clear();
  asked.length = 0;
  failing.clear();
  adopted.clear();
  for (const id of Object.keys(answers)) delete answers[id];
  answer = { context: 40_000, idle: 60, goesOn: false, briefing: null };
  onWentOn(null);
});

describe("taking a conversation up again", () => {
  it("resumes a warm or small one whole, and starts a cold and large one fresh from its briefing, once", async () => {
    expect(await takeUp(row())).toBe("old-id");
    expect(wentOn("row-1")).toBeNull();
    expect(asked[0]).toMatchObject({ agent: "claude-code", project: "/p", session: "old-id", token: "token-1" });

    answer = COLD;
    expect(await takeUp(row())).toBeNull();
    expect(wentOn("row-1")).toEqual({ from: "old-id", context: 967_000, briefing: "BRIEFING", spoken: false });
    expect(briefingFor("row-1")).toBe("BRIEFING");
    expect(briefingFor("row-1")).toBeNull();
    // A first message that never reached the agent takes it back.
    briefingBack("row-1", "BRIEFING");
    expect(briefingFor("row-1")).toBe("BRIEFING");
  });

  it("asks for the notes whatever the size and rest for a conversation that goes on by itself, the user's ask for the whole left for later", async () => {
    // Small and warm as the core judges it, it is still briefed.
    answer = { context: 40_000, idle: 60, goesOn: true, briefing: "BRIEFING" };
    askWhole("row-1");
    expect(await takeUp(row(), { always: true })).toBeNull();
    expect(asked[0]).toMatchObject({ session: "old-id", always: true });
    expect(briefingFor("row-1")).toBe("BRIEFING");
    // Where the core writes no briefing, the id comes back and nothing went on.
    answer = { context: null, idle: null, goesOn: false, briefing: null };
    expect(await takeUp(row({ key: "row-2" }), { always: true })).toBe("old-id");
    expect(wentOn("row-2")).toBeNull();
    // Asked without it, nothing of it is sent.
    await takeUp(row({ key: "row-3" }));
    expect(asked.at(-1)).not.toHaveProperty("always");
  });

  it("judges a Codex conversation as a Claude Code one, from the notes after a limit too", async () => {
    answer = COLD;
    expect(await takeUp(row({ agent: "codex" }))).toBeNull();
    expect(asked[0]).toMatchObject({ agent: "codex", session: "old-id", token: "token-1" });
    expect(briefingFor("row-1")).toBe("BRIEFING");
    expect(await takeUp(row({ agent: "codex" }), { always: true })).toBeNull();
    expect(asked[1]).toMatchObject({ agent: "codex", always: true });
    askWhole("row-1");
    expect(await takeUp(row({ agent: "codex" }))).toBe("old-id");
    expect(asked).toHaveLength(2);
  });

  it("asks nothing for a new conversation, and resumes whole once the user asks", async () => {
    answer = COLD;
    expect(await takeUp(row({ resumedFrom: null }))).toBeNull();
    expect(asked).toHaveLength(0);
    askWhole("row-1");
    expect(await takeUp(row())).toBe("old-id");
    expect(asked).toHaveLength(0);
    // Only the next start: the one after is judged again.
    expect(await takeUp(row())).toBeNull();
  });

  it("keeps the fresh conversation as going on from the old one, for its messages and its old id", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    answer = COLD;
    await takeUp(row());
    identified("row-1", "new-id");
    expect(moved).toEqual([["old-id", "new-id"]]);
    expect(lineageOf("new-id")).toEqual(["old-id", "new-id"]);
    expect(JSON.parse(localStorage.getItem("chord.wentOn") ?? "{}")).toEqual({ "new-id": "old-id" });
    // Again, from the fresh one.
    await takeUp(row({ resumedFrom: "new-id" }));
    identified("row-1", "newer-id");
    expect(lineageOf("newer-id")).toEqual(["old-id", "new-id", "newer-id"]);
    expect(wentOnFrom("old-id")).toBe("newer-id");
    expect(wentOnFrom("old-i")).toBe("newer-id");
    expect(wentOnFrom("other")).toBeNull();
  });

  it("goes on with the newest stored conversation of the chain where nothing is stored under the id, and drops that id from it", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    // old-id went on as new-id, never spoken to, so nothing is stored
    // under new-id, which the row kept.
    answer = COLD;
    await takeUp(row());
    identified("row-1", "new-id");
    moved.length = 0;
    answers["new-id"] = { context: null, idle: null, goesOn: false, briefing: "NOTES ALONE", missing: true };
    answer = { context: 40_000, idle: 60, goesOn: false, briefing: null };
    expect(await takeUp(row({ resumedFrom: "new-id" }))).toBe("old-id");
    expect(asked.map((one) => one.session).slice(-2)).toEqual(["new-id", "old-id"]);
    expect(wentOn("row-1")).toBeNull();
    expect(lostAt("row-1")).toEqual({ id: "new-id", to: "old-id", earlier: true, notes: false });
    expect(lostAt("row-1")).toBeNull();
    expect(lineage()).toEqual({});
    expect(moved).toEqual([["new-id", "old-id"]]);
    // Cold and large, the stored one goes on from its notes as its own would.
    answer = COLD;
    await takeUp(row());
    identified("row-1", "new-id");
    expect(await takeUp(row({ resumedFrom: "new-id" }))).toBeNull();
    expect(wentOn("row-1")).toMatchObject({ from: "old-id", briefing: "BRIEFING" });
    identified("row-1", "newer-id");
    expect(lineage()).toEqual({ "newer-id": "old-id" });
    expect(wentOnFrom("old-id")).toBe("newer-id");
  });

  it("goes on fresh from the notes alone where nothing of the chain is stored, and drops the chain", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    answer = COLD;
    await takeUp(row());
    identified("row-1", "new-id");
    moved.length = 0;
    const nothing = { context: null, idle: null, goesOn: false, briefing: "NOTES ALONE", missing: true };
    answers["new-id"] = nothing;
    answers["old-id"] = { ...nothing, briefing: null };
    expect(await takeUp(row({ resumedFrom: "new-id" }))).toBeNull();
    expect(wentOn("row-1")).toEqual({ from: "new-id", context: null, briefing: "NOTES ALONE", spoken: false, lost: true });
    expect(lostAt("row-1")).toEqual({ id: "new-id", to: null, earlier: true, notes: true });
    // Nothing whole is there to resume.
    expect(wholeOf({ key: "row-1" })).toBeNull();
    // The fresh run goes on from none of the ids that held nothing, while
    // what is kept by the row's id follows it.
    expect(lineage()).toEqual({});
    identified("row-1", "fresh-id");
    expect(lineage()).toEqual({});
    expect(lineageOf("fresh-id")).toEqual(["fresh-id"]);
    expect(moved).toEqual([["new-id", "fresh-id"]]);
  });

  it("walks a chain of several ids that hold nothing back to the stored one", async () => {
    going.lineage["c"] = "b";
    going.lineage["b"] = "a";
    going.lineage["a"] = "stored";
    const nothing = { context: null, idle: null, goesOn: false, briefing: null, missing: true };
    answers["c"] = nothing;
    answers["b"] = nothing;
    answers["a"] = nothing;
    expect(await takeUp(row({ resumedFrom: "c" }))).toBe("stored");
    expect(asked.map((one) => one.session)).toEqual(["c", "b", "a", "stored"]);
    expect(lineage()).toEqual({});
    expect(lostAt("row-1")).toEqual({ id: "c", to: "stored", earlier: true, notes: false });
  });

  it("resumes whole an earlier conversation whose judgement fails in the walk", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    going.lineage["new-id"] = "old-id";
    answers["new-id"] = { context: null, idle: null, goesOn: false, briefing: "NOTES ALONE", missing: true };
    failing.add("old-id");
    expect(await takeUp(row({ resumedFrom: "new-id" }))).toBe("old-id");
    expect(wentOn("row-1")).toBeNull();
    expect(lineage()).toEqual({});
    expect(moved).toEqual([["new-id", "old-id"]]);
    expect(lostAt("row-1")).toEqual({ id: "new-id", to: "old-id", earlier: true, notes: false });
  });

  it("starts a row fresh whose only id holds nothing, and says so only where there are notes", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    const nothing = { context: null, idle: null, goesOn: false, briefing: null, missing: true };
    answers["lonely"] = nothing;
    // A brand-new row closed before its first message, brought back after
    // a restart, lost nothing: it starts fresh and says nothing.
    expect(await takeUp(row({ resumedFrom: "lonely" }))).toBeNull();
    expect(wentOn("row-1")).toBeNull();
    expect(lostAt("row-1")).toBeNull();
    expect(lineage()).toEqual({});
    // With notes, it goes on from them and says so, and the dead id stays
    // out of the chain with nothing kept under it moved.
    answers["lonely"] = { ...nothing, briefing: "NOTES ALONE" };
    expect(await takeUp(row({ resumedFrom: "lonely" }))).toBeNull();
    expect(wentOn("row-1")).toMatchObject({ from: "lonely", briefing: "NOTES ALONE", lost: true, alone: true });
    expect(wholeOf({ key: "row-1" })).toBeNull();
    expect(lostAt("row-1")).toEqual({ id: "lonely", to: null, earlier: false, notes: true });
    identified("row-1", "fresh-id");
    expect(lineage()).toEqual({});
    expect(moved).toEqual([]);
  });

  it("never takes a running row's id as holding nothing", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    going.lineage["new-id"] = "old-id";
    answers["new-id"] = { context: null, idle: null, goesOn: false, briefing: "NOTES ALONE", missing: true };
    for (const how of [{ running: true }, { running: true, always: true }]) {
      expect(await takeUp(row({ resumedFrom: "new-id" }), how)).toBe("new-id");
      expect(asked.map((one) => one.session)).not.toContain("old-id");
      expect(wentOn("row-1")).toBeNull();
      expect(lostAt("row-1")).toBeNull();
      expect(lineage()).toEqual({ "new-id": "old-id" });
      expect(moved).toEqual([]);
    }
  });

  it("resumes whole a missing id of a row under an account the window does not know", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    going.lineage["new-id"] = "old-id";
    answers["new-id"] = { context: null, idle: null, goesOn: false, briefing: "NOTES ALONE", missing: true };
    expect(await takeUp(row({ resumedFrom: "new-id", account: "Work" }))).toBe("new-id");
    expect(asked.map((one) => one.session)).not.toContain("old-id");
    expect(wentOn("row-1")).toBeNull();
    expect(lostAt("row-1")).toBeNull();
    expect(lineage()).toEqual({ "new-id": "old-id" });
    expect(moved).toEqual([]);
    // Once adopted, the account's answer is acted on.
    adopted.add("Work");
    answers["old-id"] = { context: 40_000, idle: 60, goesOn: false, briefing: null };
    expect(await takeUp(row({ resumedFrom: "new-id", account: "Work" }))).toBe("old-id");
    expect(lostAt("row-1")).toMatchObject({ id: "new-id", to: "old-id" });
  });

  it("takes a core that does not say what is missing as finding it", async () => {
    expect(await takeUp(row())).toBe("old-id");
    expect(lostAt("row-1")).toBeNull();
  });

  it("offers to resume whole only until anything is said to the fresh run", async () => {
    answer = COLD;
    await takeUp(row());
    expect(wholeOf({ key: "row-1" })).toMatchObject({ from: "old-id", context: 967_000 });
    // The first message takes the briefing, and with it the choice.
    expect(briefingFor("row-1")).toBe("BRIEFING");
    expect(wholeOf({ key: "row-1" })).toBeNull();
    // One that never reached the agent gives it back.
    briefingBack("row-1", "BRIEFING");
    expect(wholeOf({ key: "row-1" })).not.toBeNull();
    // A terminal row's briefing goes as its first prompt with nothing
    // said; a line typed after it is.
    await takeUp(row());
    expect(briefingFor("row-1", false)).toBe("BRIEFING");
    expect(wholeOf({ key: "row-1" })).not.toBeNull();
    spoke("row-1");
    expect(wholeOf({ key: "row-1" })).toBeNull();
    // After a restart, with no run that went on in this window, there is
    // nothing to offer.
    resetGoingOn();
    identified("row-1", "new-id");
    expect(wholeOf({ key: "row-1" })).toBeNull();
  });

  it("leaves the old conversation off the list from the moment the row goes on, before its new id", async () => {
    expect(leftBy(["row-1"]).size).toBe(0);
    answer = COLD;
    await takeUp(row());
    expect([...leftBy(["row-1", "row-2"])]).toEqual(["old-id"]);
    // A closed row no longer holds it.
    expect(leftBy(["row-2"]).size).toBe(0);
  });

  it("keeps offering an id that held nothing while the fresh run that dropped it lasts", async () => {
    going.lineage["new-id"] = "old-id";
    answers["new-id"] = { context: null, idle: null, goesOn: false, briefing: "NOTES", missing: true };
    answers["old-id"] = { context: null, idle: null, goesOn: false, briefing: null, missing: true };
    expect(await takeUp(row({ resumedFrom: "new-id" }))).toBeNull();
    // The run still names what it dropped, and the list offers it should
    // it turn up where the core did not look.
    expect(wentOn("row-1")).toMatchObject({ from: "new-id", lost: true });
    expect(lostAt("row-1")).toMatchObject({ id: "new-id", to: null });
    expect(leftBy(["row-1"]).size).toBe(0);
  });

  it("says a context in tokens as the menu does", () => {
    expect(tokensText(412_345)).toBe("412k tokens");
    expect(tokensText(1_000_000)).toBe("1M tokens");
    expect(tokensText(1_250_000)).toBe("1.3M tokens");
  });
});
