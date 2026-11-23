import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Team, TeamProblem } from "$lib/core";

const sent: unknown[] = [];
/** What the core answers the next change with: null keeps it. */
let refusal: string | null = null;
/** While set, the answers to changes wait here, in order, to be given. */
let held: ((refusal: string | null) => void)[] | null = null;
/** Whether settings going back to what is stored bring the teams back. */
let recovers = false;
/** What the core says is in use, by project, and what it was asked. */
let inUse: Record<string, Team[]> = {};
const asked: string[] = [];
/** What the core finds with the next draft, and what it was asked. */
let found: TeamProblem[] | "unreachable" = [];
const checked: { draft: Team; editing: string | null; folders: string[] }[] = [];

vi.mock("$lib/persist", () => ({
  persist: (change: unknown) => {
    sent.push(change);
    if (held !== null) return new Promise((answer) => held?.push(answer));
    return Promise.resolve(refusal);
  },
  recovering: () => recovers,
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    teamsInUse: async (project: string) => {
      asked.push(project);
      if (!(project in inUse)) throw new Error("not read");
      return inUse[project];
    },
    teamCheck: async (_project: string, draft: Team, editing: string | null, folders: string[]) => {
      checked.push({ draft, editing, folders });
      if (found === "unreachable") throw new Error("no core");
      return found;
    },
  }),
}));

import {
  adoptTeams,
  checkTeam,
  globsOf,
  loadProjectTeams,
  loadTeams,
  refuses,
  removeTeam,
  reset,
  saveTeam,
  teamByName,
  teams,
  teamsFor,
  teamsSettings,
  teamSummary,
} from "$lib/teams.svelte";

const ship: Team = {
  name: "Ship with checks",
  members: [{ agent: "Planner" }, { agent: "Builder" }, { agent: "Reviewer" }],
  gates: [
    { who: "Planner", when: "plan" },
    { who: "Reviewer", when: "change" },
  ],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  reset();
  sent.length = 0;
  asked.length = 0;
  refusal = null;
  held = null;
  recovers = false;
  inUse = {};
  found = [];
  checked.length = 0;
});

describe("the teams in use", () => {
  it("are the core's word, never worked out here", async () => {
    inUse[""] = [ship];
    adoptTeams(undefined);
    await flush();
    expect(asked).toEqual([""]);
    expect(teams.file).toBeUndefined();
    expect(teams.inUse.map((team) => team.name)).toEqual(["Ship with checks"]);
    expect(teamsSettings()).toEqual({});
  });

  it("fall back to the file's own where the core cannot say", async () => {
    adoptTeams([ship]);
    await flush();
    expect(teams.inUse).toEqual([ship]);
    expect(teamsSettings()).toEqual({ teams: [ship] });
  });

  it("are read for a project on their own", async () => {
    inUse["/p"] = [ship];
    expect(teamsFor("/p")).toEqual([]);
    await loadProjectTeams("/p");
    expect(teamsFor("/p")).toEqual([ship]);
    await loadProjectTeams("/gone");
    expect(teamsFor("/gone")).toEqual([]);
  });

  it("are found by name in any case", async () => {
    inUse[""] = [ship];
    await loadTeams();
    expect(teamByName(" ship WITH checks")?.name).toBe("Ship with checks");
    expect(teamByName("Other")).toBeUndefined();
  });

  it("say how many gates and agents", () => {
    expect(teamSummary(ship)).toBe("2 gates · 3 agents");
    expect(teamSummary({ name: "One", members: [{ agent: "A" }], gates: [{ who: "A", when: "plan" }] })).toBe(
      "1 gate · 1 agent",
    );
  });
});

describe("a team kept", () => {
  it("writes the whole list as the file's own the first time", async () => {
    inUse[""] = [ship];
    await loadTeams();
    const said = await saveTeam({ name: " Quick ", members: [{ agent: "Builder" }], gates: [] }, null);
    expect(said).toEqual([]);
    expect(sent).toEqual([{ teams: [ship, { name: "Quick", members: [{ agent: "Builder" }], gates: [] }] }]);
    expect(teams.file?.map((team) => team.name)).toEqual(["Ship with checks", "Quick"]);
  });

  it("replaces the one edited in its place, keeping what the window does not know", async () => {
    const odd = { ...ship, startOnly: true, later: 1 } as Team;
    inUse[""] = [odd, { name: "B", members: [{ agent: "X" }], gates: [] }];
    await loadTeams();
    const draft = JSON.parse(JSON.stringify(odd)) as Team;
    draft.name = "Ship";
    draft.gates.pop();
    expect(await saveTeam(draft, "Ship with checks")).toEqual([]);
    const kept = (sent[0] as { teams: Team[] }).teams;
    expect(kept.map((team) => team.name)).toEqual(["Ship", "B"]);
    expect(kept[0]).toMatchObject({ startOnly: true, later: 1, gates: [{ who: "Planner", when: "plan" }] });
  });

  it("is removed by name", async () => {
    inUse[""] = [ship];
    await loadTeams();
    removeTeam("Ship with checks");
    expect(sent).toEqual([{ teams: [] }]);
    expect(teamsSettings()).toEqual({ teams: [] });
  });

  it("goes back, and says why, when the core refuses to keep it", async () => {
    inUse[""] = [ship];
    await loadTeams();
    refusal = "The settings file is read only.";
    await saveTeam({ name: "A", members: [{ agent: "X" }], gates: [] }, null);
    await flush();
    expect(teams.refused).toBe("Not kept: The settings file is read only.");
    expect(teams.inUse).toEqual([ship]);
    expect(teams.file).toBeUndefined();
    refusal = null;
    removeTeam("Ship with checks");
    expect(teams.refused).toBeNull();
  });

  it("says nothing of a refused change a later kept one has taken the place of", async () => {
    const answers: ((refusal: string | null) => void)[] = [];
    held = answers;
    await saveTeam({ name: "A", members: [{ agent: "X" }], gates: [] }, null);
    await saveTeam({ name: "B", members: [{ agent: "X" }], gates: [] }, null);
    answers[1](null);
    answers[0]("No.");
    await flush();
    expect(teams.refused).toBeNull();
    expect(teams.inUse.map((team) => team.name)).toEqual(["A", "B"]);
  });

  it("is left to the settings going back when they do", async () => {
    recovers = true;
    refusal = "No.";
    await saveTeam({ name: "A", members: [{ agent: "X" }], gates: [] }, null);
    await flush();
    expect(teams.refused).toBe("Not kept: No.");
    expect(teams.inUse.map((team) => team.name)).toEqual(["A"]);
  });
});

describe("what a team is held to", () => {
  const one = (change: Partial<Team> = {}): Team => ({ name: "T", members: [{ agent: "A" }], gates: [], ...change });

  it("is the core's word, asked with the team it replaces and the open folders", async () => {
    found = [
      { text: "A team needs an agent.", quiet: false },
      { text: "No file in the open projects matches infra/** yet.", quiet: true },
    ];
    expect(await checkTeam(one({ members: [] }), "T", ["/p"])).toEqual(found);
    expect(checked).toEqual([{ draft: one({ members: [] }), editing: "T", folders: ["/p"] }]);
  });

  it("needs a name before the core is asked", async () => {
    expect(await checkTeam(one({ name: "  " }), null, [])).toEqual([{ text: "A team needs a name.", quiet: false }]);
    expect(checked).toEqual([]);
  });

  it("is not saved while the core finds what keeps it from being", async () => {
    found = [{ text: "There is already a team called Ship with checks.", quiet: false }];
    expect(await saveTeam(one(), null)).toEqual(found);
    expect(sent).toEqual([]);
  });

  it("is saved with only hints", async () => {
    found = [{ text: "No file in the open projects matches a/** yet.", quiet: true }];
    expect(refuses(found)).toBe(false);
    expect(await saveTeam(one(), null, ["/p"])).toEqual(found);
    expect(sent).toEqual([{ teams: [one()] }]);
  });

  it("is not saved when it cannot be checked, which says so", async () => {
    found = "unreachable";
    const said = await saveTeam(one(), null);
    expect(said).toEqual([{ text: "The team could not be checked: no core", quiet: false }]);
    expect(refuses(said)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("splits a gate's paths on commas and spaces", () => {
    expect(globsOf(" infra/**, docs/*.md  src/a ")).toEqual(["infra/**", "docs/*.md", "src/a"]);
  });
});
