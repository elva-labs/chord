import type {
  HarnessId,
  ReviewStep,
  Settings,
  UnreadWorkflow,
  Workflow,
  WorkflowModel,
  WorkflowStep,
} from "$lib/core";
import { HARNESS_ORDER, modelLabel, mostCapable, sameModel } from "$lib/models";
import { core } from "$lib/core";
import { persist, recovering } from "$lib/persist";
import { startsOnly } from "$lib/workflowInstructions";

/**
 * The workflows a session can follow.
 *
 * A workflow names the model a session starts on, the orchestrator, and
 * steps in order that either do work or review it, each with the models it
 * may use. The window holds its copy of the list, the name of the workflow
 * new sessions start with (none is a choice) and the projects that choose
 * another; each change is checked here with the rules the core holds the
 * settings to, shown at once and sent. What the core answers, or announces
 * from another window, is taken as it comes.
 */

/** What the core holds the settings to. */
const MOST_WORKFLOWS = 16;
export const MOST_STEPS = 12;
const MOST_MODELS = 16;
export const LONGEST_NAME = 40;
export const MOST_PARALLEL = 8;
export const MOST_ROUNDS = 10;

/** The workflow a fresh install has first, and the shape a new one takes:
    the orchestrator on Claude's most capable model, work on Sonnet, and a
    review on Opus that sends the work back up to three times and then
    asks. */
export function defaultWorkflow(): Workflow {
  return {
    name: "Build and review",
    orchestrator: { agent: "claude-code", model: mostCapable().model },
    steps: [
      {
        kind: "work",
        name: "Work",
        models: [{ agent: "claude-code", model: "sonnet" }],
        parallel: 1,
      },
      {
        kind: "review",
        name: "Review",
        models: [{ agent: "claude-code", model: "opus" }],
        reviewerApproves: true,
        orchestratorAgrees: true,
        backTo: "Work",
        limit: 3,
      },
    ],
  };
}

/** The name of the workflow for directing work with no review. */
export const DIRECT = "Direct";

/** The workflow a fresh install has for directing work with no review:
    the orchestrator on the same model, handing each piece to a session of
    its own on any model, as many at once as a session may run. */
export function directWorkflow(): Workflow {
  return {
    name: DIRECT,
    orchestrator: { agent: "claude-code", model: mostCapable().model },
    steps: [{ kind: "work", name: "Work", models: [], parallel: MOST_PARALLEL }],
  };
}

/** The workflows a fresh install has, in their order. */
function shippedWorkflows(): Workflow[] {
  return [defaultWorkflow(), directWorkflow()];
}

export const workflows = $state({
  /** The workflows in the order they are shown. A window that has heard
      nothing yet has the ones a fresh install has. */
  list: shippedWorkflows() as Workflow[],
  /** The one new sessions start with; null is none, which is what a
      fresh install has. */
  default: null as string | null,
  /** The projects with a word of their own: a workflow's name, or null
      for none, whatever the default. */
  overrides: {} as Record<string, string | null>,
  /** The workflows in the settings file that are not used, each with the
      rule it breaks, carried through every write. */
  unread: [] as UnreadWorkflow[],
});

let known: () => void = () => {};
let knowing = new Promise<void>((settle) => (known = settle));

/** Settles once the window has the machine's workflows, or knows it keeps
    only its own: what a resumed session follows is read after that. */
export function workflowsKnown(): Promise<void> {
  return knowing;
}

/** The window has the workflows it will go on with. */
export function knowWorkflows() {
  known();
}

/** Test seam: the window has not heard what the workflows are. */
export function unknowWorkflows() {
  knowing = new Promise<void>((settle) => (known = settle));
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The workflows' part of the settings. */
export function workflowsSettings(): Settings["workflows"] {
  return {
    list: clone($state.snapshot(workflows.list)),
    default: workflows.default,
    overrides: { ...workflows.overrides },
    // Like the core, the set names its unread workflows only when it has any.
    ...(workflows.unread.length === 0 ? {} : { unread: clone($state.snapshot(workflows.unread)) }),
  };
}

/** Takes the core's word for the workflows, which is the machine's. A
    settings object from before workflows existed gets the ones a fresh
    install has, with new sessions following none. A choice naming a
    workflow the list does not hold is dropped. */
export function adoptWorkflows(settings: Settings["workflows"] | undefined) {
  knowWorkflows();
  if (settings === undefined || !Array.isArray(settings.list)) {
    workflows.list = shippedWorkflows();
    workflows.default = null;
    workflows.overrides = {};
    workflows.unread = [];
    return;
  }
  workflows.unread = clone(settings.unread ?? []);
  const list = clone(settings.list);
  const known = (name: unknown): name is string =>
    typeof name === "string" && list.some((workflow) => workflow.name === name);
  workflows.list = list;
  workflows.default = known(settings.default) ? settings.default : null;
  const overrides: Record<string, string | null> = {};
  for (const [project, choice] of Object.entries(settings.overrides ?? {})) {
    if (choice === null || known(choice)) overrides[project] = choice;
  }
  workflows.overrides = overrides;
}

/** Names are the same when they differ only in the case of A to Z, as the
    core compares them. */
const asciiLower = (name: string) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameName = (a: string, b: string) => asciiLower(a) === asciiLower(b);

/** Why a name will not do among the others, or null when it will. */
export function nameProblem(name: string, others: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name is needed.";
  if ([...trimmed].length > LONGEST_NAME) return `A name is ${LONGEST_NAME} characters at most.`;
  if (others.some((other) => sameName(other, trimmed))) return `${trimmed} is taken already.`;
  return null;
}

function modelProblem(model: WorkflowModel): string | null {
  if (model.agent !== "claude-code" && model.agent !== "codex") {
    return `${model.agent} is not an agent.`;
  }
  const name = model.model.trim();
  // eslint-disable-next-line no-control-regex
  if (name === "" || [...name].length > LONGEST_NAME || /[\s\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    return `A model is named in one word, ${LONGEST_NAME} characters at most, not "${model.model}".`;
  }
  return null;
}

/** The step a review may send the work back to: a work step before it. */
function canGoBackTo(workflow: Workflow, review: number, name: string): boolean {
  return workflow.steps
    .slice(0, review)
    .some((earlier) => earlier.kind === "work" && earlier.name === name);
}

/** Why a workflow will not do, or null when it will: the rules the core
    holds a workflow to. */
export function workflowProblem(workflow: Workflow): string | null {
  const own = nameProblem(workflow.name, []);
  if (own !== null) return own;
  const orchestrator = modelProblem(workflow.orchestrator);
  if (orchestrator !== null) return orchestrator;
  if (workflow.steps.length === 0) return "A workflow needs at least one step.";
  if (workflow.steps.length > MOST_STEPS) return `A workflow has ${MOST_STEPS} steps at most.`;
  for (const [index, step] of workflow.steps.entries()) {
    const named = nameProblem(
      step.name,
      workflow.steps.slice(0, index).map((earlier) => earlier.name),
    );
    if (named !== null) return named;
    if (step.models.length > MOST_MODELS) return `${step.name} lists ${MOST_MODELS} models at most.`;
    for (const [at, model] of step.models.entries()) {
      const problem = modelProblem(model);
      if (problem !== null) return problem;
      if (step.models.slice(0, at).some((earlier) => sameModel(earlier, model))) {
        return `${step.name} lists ${modelLabel(model.agent, model.model)} twice.`;
      }
    }
    if (step.kind === "work") {
      if (!Number.isInteger(step.parallel) || step.parallel < 1 || step.parallel > MOST_PARALLEL) {
        return `${step.name} runs between 1 and ${MOST_PARALLEL} sessions at once.`;
      }
    } else {
      if (!step.reviewerApproves && !step.orchestratorAgrees) {
        return `${step.name} passes the work when the reviewer approves, the orchestrator agrees, or both, so one of them stays on.`;
      }
      if (!canGoBackTo(workflow, index, step.backTo)) {
        return `${step.name} goes back to a work step before it.`;
      }
      if (!Number.isInteger(step.limit) || step.limit < 1 || step.limit > MOST_ROUNDS) {
        return `${step.name} goes back between 1 and ${MOST_ROUNDS} times.`;
      }
    }
  }
  return null;
}

/** Why a set of workflows will not do, or null: each one, and a name
    only once. */
export function listProblem(list: Workflow[]): string | null {
  if (list.length > MOST_WORKFLOWS) return `The settings hold ${MOST_WORKFLOWS} workflows at most.`;
  for (const [index, workflow] of list.entries()) {
    const problem = workflowProblem(workflow);
    if (problem !== null) return problem;
    if (list.slice(0, index).some((earlier) => sameName(earlier.name, workflow.name))) {
      return `There are two workflows called ${workflow.name}.`;
    }
  }
  return null;
}

/** Why a whole set of workflows will not do, or null: each workflow, a name
    once, and the default and every project choice naming one there is. */
export function setProblem(set: Settings["workflows"]): string | null {
  const problem = listProblem(set.list);
  if (problem !== null) return problem;
  const there = (name: string | null) => name === null || set.list.some((workflow) => workflow.name === name);
  if (!there(set.default)) return `There is no workflow called ${set.default}.`;
  for (const choice of Object.values(set.overrides)) {
    if (!there(choice)) return `There is no workflow called ${choice}.`;
  }
  return null;
}

export { startsOnly };

export function workflowNamed(name: string | null | undefined): Workflow | undefined {
  return name === null || name === undefined
    ? undefined
    : workflows.list.find((workflow) => workflow.name === name);
}

/** What each step of a workflow does and the model it runs on first:
    "Sonnet works", "Opus reviews". */
function stepGists(workflow: Workflow): string[] {
  return workflow.steps.map((step) => `${gistModel(step.models[0])} ${step.kind === "work" ? "works" : "reviews"}`);
}

function gistModel(model: WorkflowModel | undefined): string {
  return model === undefined ? "any model" : modelLabel(model.agent, model.model);
}

/** A workflow in a few words: the model each part runs on first, and what
    it does. "Fable directs, Sonnet works, Opus reviews". */
export function workflowGist(workflow: Workflow): string {
  return [`${gistModel(workflow.orchestrator)} directs`, ...stepGists(workflow)].join(", ");
}

/** What the sessions a workflow's orchestrator starts do, said to the
    orchestrator's own session: "Sonnet works and Opus reviews". */
export function stepsGist(workflow: Workflow): string {
  const said = stepGists(workflow);
  return said.length < 2 ? (said[0] ?? "") : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

/** The workflow a project follows: its own word, else the default. Null
    is none. */
export function workflowOf(project: string): Workflow | null {
  const own = workflows.overrides[project];
  const chosen = own === undefined ? workflows.default : own;
  return workflowNamed(chosen) ?? null;
}

/** A project's own word: a name, null for none, or undefined when it
    follows the default. */
export function overrideOf(project: string): string | null | undefined {
  const own = workflows.overrides[project];
  if (own === undefined) return undefined;
  if (own === null) return null;
  return workflowNamed(own) === undefined ? undefined : own;
}

/** The workflow the file holds but cannot use under a name, if any. Its
    name is taken: a workflow of that name would be read as the one the
    file's default and project choices mean. */
function unreadNamed(name: string, unread: UnreadWorkflow[] = workflows.unread): UnreadWorkflow | undefined {
  return unread.find((entry) => entry.name !== null && sameName(entry.name, name));
}

function unreadProblem(name: string): string {
  return `"${name}" is the name of a workflow in the settings file that is not used. Mend that one there, or remove it, first.`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, allowed: string[], what: string) {
  const other = Object.keys(value).find((field) => !allowed.includes(field));
  if (other !== undefined) throw new Error(`${what} has ${allowed.join(", ")}, not ${other}.`);
}

function readModel(value: unknown, what: string): WorkflowModel {
  if (!isObject(value)) throw new Error(`${what} is a model: {"agent": ..., "model": ...}.`);
  only(value, ["agent", "model"], what);
  if (!HARNESS_ORDER.includes(value.agent as HarnessId)) {
    throw new Error(`${what} names a harness that is one of ${HARNESS_ORDER.join(", ")}.`);
  }
  if (typeof value.model !== "string") throw new Error(`${what} names its model as text.`);
  return { agent: value.agent as HarnessId, model: value.model.trim() };
}

function readModels(value: unknown, what: string): WorkflowModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${what} lists models as an array; empty means any.`);
  return value.map((model) => readModel(model, what));
}

/** A workflow as an agent writes it, read strictly: every field the shape
    has and no other, then held to the rules. Throws the reason when it
    will not do. */
export function readWorkflow(value: unknown): Workflow {
  if (!isObject(value)) {
    throw new Error("A workflow is an object of a name, an orchestrator and steps.");
  }
  only(value, ["name", "orchestrator", "steps", "startOnly"], "A workflow");
  if (value.startOnly !== undefined && typeof value.startOnly !== "boolean") {
    throw new Error("A workflow's startOnly is true or false.");
  }
  if (typeof value.name !== "string") throw new Error("A workflow has a name.");
  if (!Array.isArray(value.steps)) throw new Error("A workflow's steps are an array.");
  const steps = value.steps.map((raw, at): WorkflowStep => {
    if (!isObject(raw)) throw new Error(`Step ${at + 1} is an object.`);
    const what = `Step ${at + 1}`;
    if (typeof raw.name !== "string") throw new Error(`${what} has a name.`);
    const models = readModels(raw.models, what);
    if (raw.kind === "work") {
      only(raw, ["kind", "name", "models", "parallel"], what);
      return { kind: "work", name: raw.name.trim(), models, parallel: raw.parallel as number };
    }
    if (raw.kind === "review") {
      only(
        raw,
        ["kind", "name", "models", "reviewerApproves", "orchestratorAgrees", "backTo", "limit"],
        what,
      );
      if (typeof raw.reviewerApproves !== "boolean" || typeof raw.orchestratorAgrees !== "boolean") {
        throw new Error(`${what} says with reviewerApproves and orchestratorAgrees, each true or false, when the work passes.`);
      }
      if (typeof raw.backTo !== "string") throw new Error(`${what} names the step it goes back to as backTo.`);
      return {
        kind: "review",
        name: raw.name.trim(),
        models,
        reviewerApproves: raw.reviewerApproves,
        orchestratorAgrees: raw.orchestratorAgrees,
        backTo: raw.backTo,
        limit: raw.limit as number,
      };
    }
    throw new Error(`${what} has a kind that is work or review.`);
  });
  const workflow: Workflow = {
    name: value.name.trim(),
    orchestrator: readModel(value.orchestrator, "The orchestrator"),
    steps,
    // On is what a workflow is without the field, which is how the
    // settings file keeps it.
    ...(value.startOnly === false ? { startOnly: false } : {}),
  };
  const problem = workflowProblem(workflow);
  if (problem !== null) throw new Error(problem);
  return workflow;
}

/** A model as a few words: its name, or any when none is chosen. */
function modelsText(models: WorkflowModel[]): string {
  return models.length === 0
    ? "any model"
    : models.map((model) => modelLabel(model.agent, model.model)).join(" / ");
}

/** When a review passes the work, in a few words. */
function passesText(step: ReviewStep): string {
  if (step.reviewerApproves && step.orchestratorAgrees) {
    return "the reviewer approves and the orchestrator agrees";
  }
  return step.reviewerApproves ? "the reviewer approves" : "the orchestrator agrees";
}

/** What a step allows, a line each in the words its settings use, for the
    person reading about a session that runs for it: what it does, the
    models, and how many sessions at once or when a review passes the work
    and how often it sends it back. A review names the work it checks when
    that is known. */
export function stepFacts(step: WorkflowStep, work: string | null = null): string[] {
  const [first, ...rest] = step.models;
  const label = (model: WorkflowModel) => modelLabel(model.agent, model.model);
  const models =
    first === undefined
      ? "any model"
      : rest.length === 0
        ? label(first)
        : `${label(first)} (the default) or ${rest.map(label).join(" or ")}`;
  if (step.kind === "work")
    return ["Does work.", `Models it may use: ${models}.`, `Sessions at once: ${step.parallel}.`];
  const times = step.limit === 1 ? "once" : `${step.limit} times`;
  return [
    work === null ? "Reviews work." : `Reviews ${work}.`,
    `Models it may use: ${models}.`,
    `The work passes when ${passesText(step)}.`,
    `Otherwise: go back to ${step.backTo} at most ${times}, then ask me.`,
    `A piece is reviewed ${step.limit + 1} times at most before that.`,
  ];
}

/** A workflow in a line, for showing what a change makes of it: the
    orchestrator, then each step with its models and what bounds it. */
export function describeWorkflow(workflow: Workflow): string {
  const steps = workflow.steps.map((step) =>
    step.kind === "work"
      ? `${step.name} (${modelsText(step.models)}, ${step.parallel} at once)`
      : `${step.name} (${modelsText(step.models)}, passes when ${passesText(step)}, else back to ${step.backTo} ${step.limit === 1 ? "once" : `${step.limit} times`} at most)`,
  );
  const own = startsOnly(workflow) ? "" : ", keeping its own subagents";
  return `${modelLabel(workflow.orchestrator.agent, workflow.orchestrator.model)} directs ${steps.join(", then ")}${own}`;
}

/** What an agent's change does to the workflows: one written whole,
    replacing the one of its name or added; one taken away; and the one new
    sessions start with, null for none. */
export interface WorkflowChange {
  write?: Workflow;
  remove?: string;
  default?: string | null;
}

const namesOf = (list: Workflow[]) => list.map((workflow) => workflow.name).join(", ") || "none";

/** What a change makes of a set of workflows, checked whole. A project
    that chose a workflow taken away follows the default again. Throws the
    reason when it will not do. */
export function changed(
  held: Settings["workflows"],
  change: WorkflowChange,
): Settings["workflows"] {
  const list = clone(held.list);
  let chosen = held.default;
  const overrides = { ...held.overrides };
  let unread = clone(held.unread ?? []);
  if (change.write !== undefined) {
    const name = change.write.name;
    const at = list.findIndex((workflow) => workflow.name === name);
    const mended = at < 0 ? unreadNamed(name, unread) : undefined;
    if (mended !== undefined && mended.name !== name) throw new Error(unreadProblem(mended.name!));
    if (at < 0) list.push(clone(change.write));
    else list[at] = clone(change.write);
    // Written under the name of one the file cannot use, it mends that one:
    // it takes its place, and the default and the choices that meant it.
    if (mended !== undefined) {
      unread = unread.filter((entry) => entry !== mended);
      if (mended.default && chosen === null) chosen = name;
      for (const project of mended.projects) {
        if (overrides[project] === undefined) overrides[project] = name;
      }
    }
  }
  if (change.remove !== undefined) {
    const at = list.findIndex((workflow) => workflow.name === change.remove);
    if (at < 0) {
      throw new Error(`There is no workflow called ${change.remove}; the workflows are ${namesOf(list)}.`);
    }
    list.splice(at, 1);
    if (chosen === change.remove) chosen = null;
    for (const [project, choice] of Object.entries(overrides)) {
      if (choice === change.remove) delete overrides[project];
    }
  }
  if (change.default !== undefined) chosen = change.default;
  if (chosen !== null && !list.some((workflow) => workflow.name === chosen)) {
    throw new Error(`There is no workflow called ${chosen}; the workflows are ${namesOf(list)}.`);
  }
  const problem = listProblem(list);
  if (problem !== null) throw new Error(problem);
  return { list, default: chosen, overrides, ...(unread.length > 0 ? { unread } : {}) };
}

/** Replaces the whole set and sends it. Answers with why not when it will
    not do, or with the core's reason when the core refuses it, in which
    case the window goes back to what it held. */
async function setWorkflows(next: Settings["workflows"]): Promise<string | null> {
  const problem = setProblem(next);
  if (problem !== null) return problem;
  const before = workflowsSettings();
  adoptWorkflows(next);
  const refused = (await save()) ?? null;
  if (refused !== null && !recovering()) adoptWorkflows(before);
  return refused;
}

/**
 * Makes an agent's change to the workflows as they are when the user allows
 * it, so other changes made meanwhile stay. Throws the reason when it
 * will not do or the core refuses it. Answers with what undoes it: the
 * workflow written goes back to what it was, or away if it was new; one
 * taken away comes back where it stood, with the projects that chose it;
 * and the default goes back if it is still the one the change named.
 */
export async function takeWorkflowChange(change: WorkflowChange): Promise<() => void> {
  const before = workflowsSettings();
  const after = changed(before, change);
  const refused = await setWorkflows(after);
  if (refused !== null) throw new Error(refused);
  return () => {
    const now = workflowsSettings();
    const list = clone(now.list);
    let chosen = now.default;
    const overrides = { ...now.overrides };
    const at = (name: string) => list.findIndex((workflow) => workflow.name === name);
    let unread = clone(now.unread ?? []);
    if (change.write !== undefined) {
      const name = change.write.name;
      const was = before.list.find((workflow) => workflow.name === name);
      if (was !== undefined && at(name) >= 0) list[at(name)] = clone(was);
      if (was === undefined && at(name) >= 0) {
        list.splice(at(name), 1);
        if (chosen === name) chosen = null;
        for (const [project, choice] of Object.entries(overrides)) {
          if (choice === name) delete overrides[project];
        }
        // One it mended goes back to the file as it was.
        const mended = before.unread?.find((entry) => entry.name === name);
        if (mended !== undefined && !unread.some((entry) => entry.at === mended.at)) unread.push(clone(mended));
      }
    }
    if (change.remove !== undefined) {
      const name = change.remove;
      const index = before.list.findIndex((workflow) => workflow.name === name);
      if (index >= 0 && !list.some((workflow) => sameName(workflow.name, name))) {
        list.splice(Math.min(index, list.length), 0, clone(before.list[index]));
        for (const [project, choice] of Object.entries(before.overrides)) {
          if (choice === name && overrides[project] === undefined) overrides[project] = name;
        }
      }
    }
    if (after.default !== before.default && chosen === after.default) {
      chosen =
        before.default !== null && list.some((workflow) => workflow.name === before.default)
          ? before.default
          : null;
    }
    void setWorkflows({ list, default: chosen, overrides, ...(unread.length > 0 ? { unread } : {}) });
  };
}

function save(): Promise<string | null> {
  return persist({ workflows: workflowsSettings() }, { quiet: true });
}

/** Test seam. */
export function reset() {
  knowing = Promise.resolve();
  workflows.list = [];
  workflows.default = null;
  workflows.overrides = {};
  workflows.unread = [];
}
