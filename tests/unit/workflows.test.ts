import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Workflow } from "$lib/core";
import {
  adoptWorkflows,
  DIRECT,
  defaultWorkflow,
  directWorkflow,
  reset,
  workflowOf,
  listProblem,
  readWorkflow,
  setProblem,
  workflowProblem,
  workflows,
  describeWorkflow,
  startsOnly,
  stepsGist,
  workflowGist,
} from "$lib/workflows.svelte";
import rules from "../fixtures/workflow-rules.json";

const sent: unknown[] = [];
/** What the core answers the next change with: null keeps it. */
let refusal: string | null = null;
/** What the core says it holds when asked. */
let stored: Settings["workflows"] | null = null;

vi.mock("$lib/persist", () => ({
  persist: (change: unknown) => {
    sent.push(change);
    return Promise.resolve(refusal);
  },
  // The window's recovery takes what is stored when the core refuses.
  recovering: () => true,
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsGet: async () => ({ stored: true, settings: { workflows: stored } }),
  }),
}));

const NAME = "Build and review";
const A = "/repo/one";

beforeEach(() => {
  reset();
  sent.length = 0;
  refusal = null;
  stored = null;
  // The tests below start from Build and review alone, turned on.
  adoptWorkflows({ list: [defaultWorkflow()], default: NAME, overrides: {} });
});

describe("a fresh window", () => {
  it("has the shipped workflows, with new sessions following none", () => {
    adoptWorkflows(undefined);
    expect(workflows.list).toEqual([defaultWorkflow(), directWorkflow()]);
    expect(workflows.default).toBeNull();
    const workflow = workflows.list[0];
    expect(workflow.orchestrator).toEqual({ agent: "claude-code", model: "fable" });
    expect(workflow.steps.map((step) => step.kind)).toEqual(["work", "review"]);
    expect(workflowProblem(workflow)).toBeNull();
    // Direct: one step of work, on any model, as many at once as a session
    // may run, and the orchestrator hands out work only through start.
    const direct = workflows.list[1];
    expect(direct.name).toBe(DIRECT);
    expect(direct.orchestrator).toEqual({ agent: "claude-code", model: "fable" });
    expect(direct.steps).toEqual([{ kind: "work", name: "Work", models: [], parallel: 8 }]);
    expect(startsOnly(direct)).toBe(true);
    expect(workflowProblem(direct)).toBeNull();
    expect(workflowGist(direct)).toBe("Fable directs, any model works");
    expect(stepsGist(direct)).toBe("any model works");
  });

  it("takes the core's workflows, and drops a choice that names one it does not hold", () => {
    const other = { ...defaultWorkflow(), name: "Quick" };
    adoptWorkflows({
      list: [other],
      default: "Gone",
      overrides: { [A]: "Quick", "/b": "Gone", "/c": null },
    });
    expect(workflows.list).toEqual([other]);
    expect(workflows.default).toBeNull();
    expect(workflows.overrides).toEqual({ [A]: "Quick", "/c": null });
  });

  it("keeps none at all when the core says there are none", () => {
    adoptWorkflows({ list: [], default: null, overrides: {} });
    expect(workflows.list).toEqual([]);
    expect(workflowOf(A)).toBeNull();
  });
});

describe("delegating only through start", () => {
  it("is on unless the workflow says otherwise, and is kept only when off", () => {
    expect(startsOnly(workflows.list[0])).toBe(true);
    expect(describeWorkflow(workflows.list[0])).not.toContain("subagents");
    const off = { ...workflows.list[0], startOnly: false };
    expect(startsOnly(off)).toBe(false);
    expect(describeWorkflow(off)).toContain("keeping its own subagents");
  });

  it("is read from what an agent writes as true or false, and nothing else", () => {
    const written = (startOnly: unknown) => ({ ...defaultWorkflow(), startOnly });
    expect(readWorkflow(written(false)).startOnly).toBe(false);
    expect(readWorkflow(written(true))).not.toHaveProperty("startOnly");
    expect(() => readWorkflow(written("no"))).toThrow("startOnly");
  });
});

describe("what makes a workflow valid", () => {
  const ok = (): Workflow => defaultWorkflow();

  it("is what the core takes, case by case, read the way an agent's is", () => {
    const takes = (set: unknown) => {
      try {
        const held = set as Settings["workflows"];
        const list = held.list.map((workflow) => readWorkflow(workflow));
        return setProblem({ ...held, list }) === null;
      } catch {
        return false;
      }
    };
    for (const { case: what, valid, workflow } of rules.cases) {
      expect(listProblem([workflow as Workflow]) === null, what).toBe(valid);
      expect(takes({ list: [workflow], default: null, overrides: {} }), what).toBe(valid);
    }
    for (const { case: what, valid, workflows: set } of rules.sets) {
      expect(takes(set), what).toBe(valid);
    }
  });

  it("needs at least one step", () => {
    const workflow = ok();
    workflow.steps = [];
    expect(workflowProblem(workflow)).toMatch(/at least one step/);
  });

  it("needs step names that differ, ignoring case", () => {
    const workflow = ok();
    workflow.steps[1].name = "work";
    (workflow.steps[1] as { backTo: string }).backTo = "Work";
    expect(workflowProblem(workflow)).toMatch(/taken/);
  });

  it("needs a review to name an earlier step", () => {
    const workflow = ok();
    workflow.steps.reverse();
    expect(workflowProblem(workflow)).toMatch(/before it/);
  });
});

describe("a workflow in a few words", () => {
  it("names who directs, works and reviews, and to its orchestrator what the others do", () => {
    const workflow = defaultWorkflow();
    expect(workflowGist(workflow)).toBe("Fable directs, Sonnet works, Opus reviews");
    expect(stepsGist(workflow)).toBe("Sonnet works and Opus reviews");
    const three: Workflow = {
      ...workflow,
      steps: [{ kind: "work", name: "Plan", models: [{ agent: "claude-code", model: "opus" }], parallel: 1 }, ...workflow.steps],
    };
    expect(stepsGist(three)).toBe("Opus works, Sonnet works and Opus reviews");
    expect(stepsGist({ ...workflow, steps: workflow.steps.slice(0, 1) })).toBe("Sonnet works");
  });
});
