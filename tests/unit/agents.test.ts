import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAgent, OwnAgent } from "$lib/core";

const sent: unknown[] = [];
/** What the core answers the next change with: null keeps it. */
let refusal: string | null = null;
/** What the core reads as installed, and the dirs it was asked with. */
let installed: InstalledAgent[] = [];
const asked: unknown[][] = [];

vi.mock("$lib/persist", () => ({
  persist: (change: unknown) => {
    sent.push(change);
    return Promise.resolve(refusal);
  },
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    installedAgents: async (...args: unknown[]) => {
      asked.push(args);
      return installed;
    },
  }),
}));

vi.mock("$lib/accounts.svelte", () => ({
  accountOf: (project: string) => (project === "/work" ? "work" : null),
  dirFor: (account: string | null, harness: string) =>
    account === null ? undefined : `/home/${account}/${harness}`,
}));

import {
  adoptAgents,
  agentByKey,
  agentByTitle,
  agentEfforts,
  agentFacts,
  agentProblem,
  agents,
  agentsSettings,
  allAgents,
  initials,
  loadInstalled,
  MOST_AGENTS,
  newAgent,
  ownAgents,
  removeAgent,
  reset,
  resetShipped,
  saveAgent,
  SHIPPED,
  shippedAgents,
} from "$lib/agents.svelte";

const mine = (title: string, description = "Checks migrations for locks.\n\nYou read each migration."): OwnAgent => ({
  title,
  description,
  model: { harness: "claude-code", model: "opus" },
  effort: "high",
  readsOnly: true,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  reset();
  sent.length = 0;
  asked.length = 0;
  refusal = null;
  installed = [];
});

describe("the shipped agents", () => {
  it("are the eight the mockup names, each with a first line, a body and what it runs on", () => {
    expect(SHIPPED.map((agent) => agent.title)).toEqual([
      "Researcher",
      "Developer",
      "Debugger",
      "Tester",
      "Reviewer",
      "Security reviewer",
      "Cloud architect",
      "Docs writer",
    ]);
    for (const agent of SHIPPED) {
      const [first, blank, ...body] = agent.description.split("\n");
      expect(first.length).toBeGreaterThan(0);
      expect(blank).toBe("");
      expect(body.join("\n").length).toBeGreaterThan(0);
    }
    const reviewer = agentByKey("chord:Reviewer", null)!;
    expect(reviewer.firstLine).toBe("Checks a change for bugs, design and fit.");
    expect(agentFacts(reviewer)).toEqual(["Opus", "High", "Reads only"]);
    expect(agentFacts(agentByKey("chord:Developer", null)!)).toEqual(["Sonnet", "High", "Changes files"]);
  });

  it("are never stored as they ship", () => {
    adoptAgents([mine("Migrations")]);
    expect(agentsSettings().map((agent) => agent.title)).toEqual(["Migrations"]);
  });
});

describe("a shipped agent the user changed", () => {
  const reviewer = (): OwnAgent => ({ shipped: "Reviewer", ...JSON.parse(JSON.stringify(SHIPPED[4])) });

  it("is kept with the user's own and listed in its place under its key", () => {
    expect(saveAgent({ ...reviewer(), title: "Code reviewer", effort: "max" }, "Reviewer")).toBeNull();
    expect(agents.own).toEqual([{ ...reviewer(), title: "Code reviewer", effort: "max" }]);
    expect(sent).toEqual([{ agents: [{ ...reviewer(), title: "Code reviewer", effort: "max" }] }]);
    expect(ownAgents()).toEqual([]);
    const listed = shippedAgents().find((agent) => agent.key === "chord:Reviewer")!;
    expect(listed).toMatchObject({ kind: "shipped", title: "Code reviewer", effort: "max", changed: true });
    expect(shippedAgents().map((agent) => agent.key)).toEqual(SHIPPED.map((agent) => `chord:${agent.title}`));
    expect(agentByKey("chord:Reviewer", null)?.title).toBe("Code reviewer");
    expect(agentByTitle("reviewer", null)?.key).toBe("chord:Reviewer");
    expect(agentByTitle("code reviewer", null)?.key).toBe("chord:Reviewer");
    expect(saveAgent({ ...reviewer(), title: "Code reviewer", effort: "low" }, "Code reviewer")).toBeNull();
    expect(agents.own).toHaveLength(1);
    expect(agents.own[0].effort).toBe("low");
  });

  it("is dropped when kept as it ships, or reset", () => {
    saveAgent({ ...reviewer(), effort: "max" }, "Reviewer");
    saveAgent(mine("Migrations"), null);
    expect(saveAgent(reviewer(), "Reviewer")).toBeNull();
    expect(agents.own.map((agent) => agent.title)).toEqual(["Migrations"]);
    expect(shippedAgents()[4].changed).toBeUndefined();
    saveAgent({ ...reviewer(), effort: "max" }, "Reviewer");
    removeAgent("Reviewer");
    expect(agents.own).toHaveLength(2);
    resetShipped("Reviewer");
    expect(agents.own.map((agent) => agent.title)).toEqual(["Migrations"]);
    expect(sent.at(-1)).toEqual({ agents: [mine("Migrations")] });
  });

  it("is held to the rules, and not counted with the user's own", () => {
    adoptAgents([{ ...reviewer(), title: "Code reviewer" }]);
    expect(agentProblem({ ...reviewer(), title: "REVIEWER" }, "Code reviewer")).toBeNull();
    expect(agentProblem({ ...reviewer(), title: "Tester" }, "Code reviewer")).toMatch(/Chord ships/);
    expect(agentProblem(mine("code reviewer"), null)).toMatch(/taken/);
    expect(agentProblem({ ...reviewer(), shipped: "Tester", title: "Code reviewer" }, "Tester")).toMatch(/taken/);
    adoptAgents([
      { ...reviewer(), title: "Code reviewer" },
      ...Array.from({ length: MOST_AGENTS }, (_, at) => mine(`Agent ${at}`)),
    ]);
    expect(agentProblem(mine("One more"), null)).toMatch(/32 agents of your own/);
    expect(agentProblem({ ...reviewer(), shipped: "Tester", title: "Tester" }, "Tester")).toBeNull();
  });
});

describe("the user's own agents", () => {
  it("are adopted from the settings, and a file from before has none", () => {
    adoptAgents([mine("Migrations")]);
    expect(agents.own).toHaveLength(1);
    adoptAgents(undefined);
    expect(agents.own).toEqual([]);
  });

  it("are kept, changed in place and removed, each change sent", async () => {
    expect(saveAgent(mine("Migrations"), null)).toBeNull();
    expect(saveAgent(mine("Cost"), null)).toBeNull();
    expect(saveAgent({ ...mine("Migrations checker"), readsOnly: false }, "Migrations")).toBeNull();
    expect(agents.own.map((agent) => agent.title)).toEqual(["Migrations checker", "Cost"]);
    expect(agents.own[0].readsOnly).toBe(false);
    removeAgent("Cost");
    expect(agents.own.map((agent) => agent.title)).toEqual(["Migrations checker"]);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual({ agents: [{ ...mine("Migrations checker"), readsOnly: false }] });
    await settle();
    expect(agents.refused).toBeNull();
  });

  it("keep a field a later version wrote when one is changed", () => {
    adoptAgents([{ ...mine("Migrations"), colour: "red" } as OwnAgent]);
    expect(saveAgent({ ...mine("Migrations"), effort: "max" }, "Migrations")).toBeNull();
    expect(agents.own[0]).toEqual({ ...mine("Migrations"), effort: "max", colour: "red" });
  });

  it("are trimmed when kept", () => {
    saveAgent({ ...mine("  Migrations "), description: "\n Checks.\n" }, null);
    expect(agents.own[0].title).toBe("Migrations");
    expect(agents.own[0].description).toBe("Checks.");
  });

  it("are held to the core's rules", () => {
    adoptAgents([mine("Migrations")]);
    expect(agentProblem(mine(" "), null)).toMatch(/title is needed/);
    expect(agentProblem(mine("x".repeat(41)), null)).toMatch(/40 characters/);
    expect(agentProblem(mine("a\nb"), null)).toMatch(/one line/);
    for (const lookalike of ["Revie\u202ewer", "Revie\u200bwer", "Re\u2028viewer", "Re\u3164viewer"]) {
      expect(agentProblem(mine(lookalike), null)).toMatch(/hidden characters/);
    }
    expect(agentProblem(mine("reviewer"), null)).toMatch(/Chord ships/);
    expect(agentProblem(mine("MIGRATIONS"), null)).toMatch(/taken/);
    expect(agentProblem(mine("MIGRATIONS"), "Migrations")).toBeNull();
    expect(agentProblem(mine("Cost", "  "), null)).toMatch(/description is needed/);
    expect(agentProblem(mine("Cost", "x".repeat(8001)), null)).toMatch(/8000/);
    adoptAgents(Array.from({ length: MOST_AGENTS }, (_, at) => mine(`Agent ${at}`)));
    expect(agentProblem(mine("One more"), null)).toMatch(/32 agents of your own/);
    expect(agentProblem(mine("Agent 3 again"), "Agent 3")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("say why the core refused a change, until one is kept", async () => {
    refusal = "the settings could not be written";
    saveAgent(mine("Migrations"), null);
    await settle();
    expect(agents.refused).toBe("the settings could not be written");
    refusal = null;
    saveAgent(mine("Cost"), null);
    expect(agents.refused).toBeNull();
  });

  it("start blank on Sonnet at high effort, reading only", () => {
    expect(newAgent()).toEqual({
      title: "",
      description: "",
      model: { harness: "claude-code", model: "sonnet" },
      effort: "high",
      readsOnly: true,
    });
  });
});

describe("the installed agents", () => {
  const found: InstalledAgent[] = [
    {
      source: "claude",
      name: "migrations",
      description: "Checks migrations.",
      model: "opus",
      effort: null,
      readsOnly: true,
      text: "You read each migration.",
      path: "/home/work/claude-code/agents/migrations.md",
    },
    {
      source: "codex",
      name: "explorer",
      description: "",
      model: null,
      effort: "low",
      readsOnly: false,
      text: "Map the code.\nThen say what you found.",
      path: "/home/work/codex/agents/explorer.toml",
    },
  ];

  it("are read for a project under its account, and listed after the shipped and own", async () => {
    installed = found;
    adoptAgents([mine("Mine")]);
    await loadInstalled("/work");
    expect(asked).toEqual([["/work", "/home/work/claude-code", "/home/work/codex"]]);
    expect(allAgents("/work").map((agent) => agent.key)).toEqual([
      ...SHIPPED.map((agent) => `chord:${agent.title}`),
      "own:Mine",
      "claude:migrations",
      "codex:explorer",
    ]);
    expect(allAgents("/elsewhere")).toHaveLength(SHIPPED.length + 1);
    const codex = agentByKey("codex:explorer", "/work")!;
    expect(codex.firstLine).toBe("Map the code.");
    expect(codex.model).toBeNull();
    expect(agentFacts(codex)).toEqual(["Session's model", "Low", "Changes files"]);
    expect(agentByKey("claude:migrations", "/work")!.model).toEqual({ harness: "claude-code", model: "opus" });
  });

  it("are read under the harnesses' own login where the project has no account", async () => {
    await loadInstalled("/home");
    expect(asked).toEqual([["/home", undefined, undefined]]);
    expect(agents.installed["/home"]).toEqual([]);
  });
});

describe("an agent by title", () => {
  it("is the user's own first, then shipped, then installed", async () => {
    installed = [
      {
        source: "project",
        name: "Migrations",
        description: "Theirs.",
        model: null,
        effort: null,
        readsOnly: false,
        text: "",
        path: "/p/.claude/agents/m.md",
      },
    ];
    await loadInstalled("/p");
    expect(agentByTitle("migrations", "/p")?.key).toBe("project:Migrations");
    adoptAgents([mine("Migrations")]);
    expect(agentByTitle("migrations", "/p")?.key).toBe("own:Migrations");
    expect(agentByTitle("REVIEWER", "/p")?.key).toBe("chord:Reviewer");
    expect(agentByTitle("Nobody", "/p")).toBeUndefined();
  });
});

describe("the efforts an agent names", () => {
  it("are its harness's, Claude Code's where it runs on the session's model", () => {
    expect(agentEfforts("codex")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(agentEfforts(null)).toEqual(agentEfforts("claude-code"));
    expect(agentEfforts("claude-code")).toContain("max");
  });
});

describe("initials", () => {
  it("are two letters as the mockup draws them", () => {
    const titles = [...SHIPPED.map((agent) => agent.title), "Cloud cost optimizer"];
    expect(titles.map(initials)).toEqual(["RS", "DV", "DB", "TS", "RV", "SR", "CA", "DW", "CC"]);
    expect(initials("a")).toBe("A");
  });
});
