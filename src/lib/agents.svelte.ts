import type { HarnessId, InstalledAgent, OwnAgent, Settings } from "$lib/core";
import { core } from "$lib/core";
import { accountOf, dirFor } from "$lib/accounts.svelte";
import { hidden } from "$lib/bang";
import { modelLabel } from "$lib/models";
import { persist } from "$lib/persist";
import { effortName } from "$lib/settingChoices";

/**
 * The agents a session can be: a title and a description it is told to
 * work by, and what it runs on.
 *
 * The description's first line says in a few words what the agent does,
 * and is what menus show. An agent may name a model on one harness, an
 * effort, and whether it only reads; a session keeps its own for each one
 * the agent leaves out.
 *
 * Three kinds are listed, in this order: the eight Chord ships, which are
 * the window's; the user's own, kept in the settings and checked here with
 * the rules the core holds them to; and the ones the user installed for a
 * harness, read from where the harness keeps them for a project and never
 * written. A shipped agent the user changed is kept among the user's own,
 * naming the title it ships under, and is listed in the shipped one's
 * place under the shipped one's key, so whatever names it still finds it.
 */

/** What the core holds the user's own agents to; the shipped ones changed
    are not counted. */
export const MOST_AGENTS = 32;
export const LONGEST_TITLE = 40;
export const LONGEST_DESCRIPTION = 8000;

/** What an agent runs on: a model on one harness. */
export interface AgentModel {
  harness: HarnessId;
  model: string;
}

/** An agent as a menu or the settings page lists it. `key` names it across
    the kinds, `text` is what a session is told, `changed` says the user
    changed a shipped one, and `source` says where an installed one was
    read. */
export interface Agent {
  key: string;
  kind: "shipped" | "own" | "installed";
  changed?: boolean;
  title: string;
  firstLine: string;
  text: string;
  model: AgentModel | null;
  effort: string | null;
  readsOnly: boolean;
  source?: InstalledAgent["source"];
  path?: string;
}

const sonnet: AgentModel = { harness: "claude-code", model: "sonnet" };
const opus: AgentModel = { harness: "claude-code", model: "opus" };

/** The agents Chord ships, as they ship. The core holds their titles too,
    so no other agent of the user's takes one, and which of them only read,
    for the team's holds. */
export const SHIPPED: readonly OwnAgent[] = [
  {
    title: "Researcher",
    description:
      "Finds out how something works before anyone changes it.\n\nYou find out; you change nothing. Start from the question you were given and say what would answer it. Read the code, the docs, the history and, when it helps, the web, and follow the real call path rather than guessing from names. Prefer one confirmed fact over three likely ones, and say which is which. When there are options, give each with what it costs and what it rules out, and pick one. Report in this order: the answer in two sentences, the evidence with file and line, the options if any, and what you could not find out.",
    model: sonnet,
    effort: "medium",
    readsOnly: true,
  },
  {
    title: "Developer",
    description:
      "Builds a change end to end: code, tests and docs.\n\nYou build one change end to end. Read the plan step and the code around it first, and follow the patterns already there, even where you would do it differently. Make the smallest change that does the whole job: the code, tests that fail without it, and the docs it touches. Run the checks for what you changed before you say done. Commit in small steps with clear messages. If the plan is wrong or the brief is unclear, stop and say so instead of building around it. Report what you changed, what you ran and its result, and anything you left out on purpose.",
    model: sonnet,
    effort: "high",
    readsOnly: false,
  },
  {
    title: "Debugger",
    description:
      "Finds the cause of a failure and fixes it.\n\nYou find why something fails, then fix it. Reproduce it first and write down the exact steps; a bug you cannot reproduce is not yet yours to fix. Form one guess at a time and test it with the cheapest check that could prove it wrong. Read logs and state rather than reasoning from symptoms. When you find the cause, write a test that fails because of it, then fix the cause, not the place it showed up. Look for the same mistake elsewhere. Report the cause in one sentence, the evidence, the fix, and the test that now guards it.",
    model: opus,
    effort: "high",
    readsOnly: false,
  },
  {
    title: "Tester",
    description:
      "Writes the tests a change is missing.\n\nYou try to break the change. Read what it claims to do, then list the cases that would prove it wrong: edges, empty and huge inputs, bad order, a dependency failing, two calls at once. Check which of them the existing tests cover and write the missing ones beside them, in their style. Run them and the suite around them. A failing test you wrote is a finding, not something to fix yourself; report it with the steps. Report the cases you tried, which passed, which failed, and what you could not test.",
    model: sonnet,
    effort: "medium",
    readsOnly: false,
  },
  {
    title: "Reviewer",
    description:
      "Checks a change for bugs, design and fit.\n\nYou check a change before it goes in, and you change nothing. Read the plan or the brief first so you know what the change is meant to do, then the diff and enough around it to judge it. Look for bugs first, then for code that will be hard to change, then for poor fit with the patterns around it. Skip what a formatter would catch. Each finding names the file and line, what goes wrong and in which case, how serious it is, and whether it must change before the change goes in. Give everything you found in one verdict, so the fixes come back for one look rather than one at a time. Say yes when nothing high is left, even if you would have written it differently, and name the small things left as follow-ups that need no second look.",
    model: opus,
    effort: "high",
    readsOnly: true,
  },
  {
    title: "Security reviewer",
    description:
      "Checks a plan or change for ways it can be abused.\n\nThink as an attacker with the code in front of you. Follow every input from where it enters to where it is used: auth, sessions, secrets, injection, what is logged. Each finding names the path, how it is reached and the fix.",
    model: opus,
    effort: "high",
    readsOnly: true,
  },
  {
    title: "Cloud architect",
    description:
      "Designs and reviews infrastructure.\n\nYou design and review infrastructure as the person who will be woken when it breaks. For each part, ask what it costs a month at today's load and at ten times, how it fails and what notices, how it is deployed and rolled back, and who can reach it. Prefer managed services and fewer moving parts unless a number says otherwise. Check the infrastructure code against what the plan says. Each finding gives the resource, the risk or the cost with a figure where you can, and the simpler option.",
    model: opus,
    effort: "high",
    readsOnly: true,
  },
  {
    title: "Docs writer",
    description:
      "Writes the docs a change needs.\n\nYou write the docs a change needs. Read the change and the docs around it first, and write in the project's voice and structure, not your own. Say what the thing does and how to use it, with one example that runs. Cut anything that restates the code or tells how it came to be. Keep a page to what one reader needs at one moment. Check every command, path and option you name against the code. Fix what the change made wrong elsewhere, the README included. Report the pages you changed and anything still undocumented.",
    model: sonnet,
    effort: "medium",
    readsOnly: false,
  },
];

export const agents = $state({
  /** The user's own and the shipped ones changed, in the order the user
      keeps them. */
  own: [] as OwnAgent[],
  /** The agents installed for each project's harnesses, by project, once
      read. */
  installed: {} as Record<string, InstalledAgent[]>,
  /** Why the last change on the settings page was not kept, while it
      matters. */
  refused: null as string | null,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The agents' part of the settings: the user's own. */
export function agentsSettings(): OwnAgent[] {
  return clone($state.snapshot(agents.own));
}

/** Takes the core's word for the user's own agents. A settings object from
    before agents existed, or one whose agents the core could not read, has
    none. */
export function adoptAgents(settings: Settings["agents"] | undefined) {
  agents.own = Array.isArray(settings) ? clone(settings) : [];
}

/** The first line of a description: what menus show. */
export function firstLine(description: string): string {
  return description.trim().split("\n", 1)[0].trim();
}

function fromOwn(agent: OwnAgent, kind: "shipped" | "own"): Agent {
  return {
    key: kind === "shipped" ? `chord:${agent.shipped ?? agent.title}` : `own:${agent.title}`,
    kind,
    ...(agent.shipped === undefined ? {} : { changed: true }),
    title: agent.title,
    firstLine: firstLine(agent.description),
    text: agent.description.trim(),
    model: agent.model === null ? null : { ...agent.model },
    effort: agent.effort,
    readsOnly: agent.readsOnly,
  };
}

const harnessOf: Record<InstalledAgent["source"], HarnessId> = {
  claude: "claude-code",
  project: "claude-code",
  codex: "codex",
};

function fromInstalled(agent: InstalledAgent): Agent {
  return {
    key: `${agent.source}:${agent.name}`,
    kind: "installed",
    title: agent.name,
    firstLine: firstLine(agent.description) || firstLine(agent.text),
    text: agent.text.trim() || agent.description.trim(),
    model: agent.model === null ? null : { harness: harnessOf[agent.source], model: agent.model },
    effort: agent.effort,
    readsOnly: agent.readsOnly,
    source: agent.source,
    path: agent.path,
  };
}

/** The change the user made to a shipped agent, if any. */
export function changeOf(shipped: string): OwnAgent | undefined {
  return agents.own.find((agent) => agent.shipped === shipped);
}

/** The agents Chord ships, as listed: each as the user changed it, if so. */
export function shippedAgents(): Agent[] {
  return SHIPPED.map((agent) => fromOwn(changeOf(agent.title) ?? agent, "shipped"));
}

/** The user's own agents, as listed. */
export function ownAgents(): Agent[] {
  return agents.own.filter((agent) => agent.shipped === undefined).map((agent) => fromOwn(agent, "own"));
}

/** The agents installed for a project's harnesses, as listed; none before
    they are read. */
export function installedAgents(project: string | null): Agent[] {
  if (project === null) return [];
  return (agents.installed[project] ?? []).map(fromInstalled);
}

/** Every agent a session in a project can be, in the order menus list
    them: shipped, the user's own, then installed. */
export function allAgents(project: string | null): Agent[] {
  return [...shippedAgents(), ...ownAgents(), ...installedAgents(project)];
}

/** The agent a key names, among those a project's sessions can be. */
export function agentByKey(key: string | null | undefined, project: string | null): Agent | undefined {
  if (key === null || key === undefined) return undefined;
  return allAgents(project).find((agent) => agent.key === key);
}

/** The agent a title names, as the start tool takes it: the user's own
    first, then shipped, by the title it has or the one it ships under, then
    installed, ignoring the case of A to Z. */
export function agentByTitle(title: string, project: string | null): Agent | undefined {
  const named = (agent: Agent) =>
    sameTitle(agent.title, title) || (agent.kind === "shipped" && sameTitle(agent.key.slice("chord:".length), title));
  const lists = [ownAgents(), shippedAgents(), installedAgents(project)];
  for (const list of lists) {
    const found = list.find(named);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Reads the agents installed for a project's harnesses, under the
    project's account. A harness that has none, or a machine that cannot
    say, leaves the project with none. */
export async function loadInstalled(project: string): Promise<void> {
  const account = accountOf(project);
  try {
    const found = await core().installedAgents(
      project,
      dirFor(account, "claude-code"),
      dirFor(account, "codex"),
    );
    agents.installed[project] = found;
  } catch {
    agents.installed[project] = [];
  }
}

/** Titles are the same when they differ only in the case of A to Z, as the
    core compares them. */
const asciiLower = (title: string) => title.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameTitle = (a: string, b: string) => asciiLower(a) === asciiLower(b);

/** The user's own agents counted against the most the settings hold. */
const ownCount = () => agents.own.filter((agent) => agent.shipped === undefined).length;

/** Why an agent of the user's, or a shipped one changed, will not do among
    the others, or null when it will. `editing` is the title one of the
    user's own had, for one already kept; a shipped one is found by the
    title it ships under. */
export function agentProblem(draft: OwnAgent, editing: string | null): string | null {
  const title = draft.title.trim();
  if (title === "") return "A title is needed.";
  if ([...title].length > LONGEST_TITLE) return `A title is ${LONGEST_TITLE} characters at most.`;
  if (hidden.test(title)) return "A title is one line, with no hidden characters.";
  if (SHIPPED.some((shipped) => sameTitle(shipped.title, title) && shipped.title !== draft.shipped)) {
    return `${title} is an agent Chord ships.`;
  }
  const others = agents.own.filter((agent) =>
    draft.shipped === undefined
      ? agent.shipped !== undefined || editing === null || agent.title !== editing
      : agent.shipped !== draft.shipped,
  );
  if (others.some((other) => sameTitle(other.title, title))) return `${title} is taken already.`;
  const description = draft.description.trim();
  if (description === "") return "A description is needed; its first line says what the agent does.";
  if ([...description].length > LONGEST_DESCRIPTION) {
    return `A description is ${LONGEST_DESCRIPTION} characters at most.`;
  }
  if (draft.shipped === undefined && editing === null && ownCount() >= MOST_AGENTS) {
    return `The settings hold ${MOST_AGENTS} agents of your own at most.`;
  }
  return null;
}

/** Keeps an agent of the user's: a new one at the end, or one already kept
    in its place, with any field a later version wrote kept as it was. A
    shipped one changed is kept the same way, found by the title it ships
    under, and is dropped when it is as it ships again. Answers why not
    when it will not do. */
export function saveAgent(draft: OwnAgent, editing: string | null): string | null {
  const problem = agentProblem(draft, editing);
  if (problem !== null) return problem;
  const shipped = draft.shipped;
  const at = agents.own.findIndex((agent) =>
    shipped === undefined ? agent.shipped === undefined && agent.title === editing : agent.shipped === shipped,
  );
  const kept: OwnAgent = {
    ...(shipped === undefined ? {} : { shipped }),
    ...(at < 0 ? {} : clone($state.snapshot(agents.own[at]))),
    title: draft.title.trim(),
    description: draft.description.trim(),
    model: draft.model === null ? null : { ...draft.model },
    effort: draft.effort,
    readsOnly: draft.readsOnly,
  };
  const original = SHIPPED.find((agent) => agent.title === shipped);
  if (original !== undefined && same(kept, { shipped, ...original })) {
    if (at >= 0) agents.own.splice(at, 1);
  } else if (at < 0) agents.own.push(kept);
  else agents.own[at] = kept;
  keep();
  return null;
}

/** Whether two plain values hold the same, whatever order their fields are
    in. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

/** Removes an agent of the user's. */
export function removeAgent(title: string) {
  const at = agents.own.findIndex((agent) => agent.shipped === undefined && agent.title === title);
  if (at < 0) return;
  agents.own.splice(at, 1);
  keep();
}

/** Puts a shipped agent back as it ships. */
export function resetShipped(shipped: string) {
  const at = agents.own.findIndex((agent) => agent.shipped === shipped);
  if (at < 0) return;
  agents.own.splice(at, 1);
  keep();
}

/** A blank agent of the user's, as the settings page starts one. */
export function newAgent(): OwnAgent {
  return { title: "", description: "", model: { ...sonnet }, effort: "high", readsOnly: true };
}

/** The efforts the settings page offers for an agent on each harness, from
    the least to the most. An agent on the session's model is offered
    Claude Code's. */
const EFFORTS_ON: Record<HarnessId, string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

/** The efforts an agent on a harness can name, the session's harness
    when it names no model. */
export function agentEfforts(harness: HarnessId | null): string[] {
  return EFFORTS_ON[harness ?? "claude-code"];
}

/** What reading only does to an agent's session, where a lock says it. */
export const READS_ONLY_ABOUT =
  "Reads only: file edits are refused and the agent is told to change nothing. A command it runs is left to the mode.";

/** The line under an agent: what it runs on, at what effort, and whether
    it only reads. */
export function agentFacts(agent: Pick<Agent, "model" | "effort" | "readsOnly">): string[] {
  return [
    agent.model === null ? "Session's model" : modelLabel(agent.model.harness, agent.model.model),
    ...(agent.effort === null ? [] : [effortName(agent.effort)]),
    agent.readsOnly ? "Reads only" : "Changes files",
  ];
}

/** Two letters for an agent's badge: the first letters of its first two
    words, or of a single word its first letter and the next consonant. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) return "";
  if (words.length > 1) return (first(words[0]) + first(words[1])).toUpperCase();
  const letters = [...words[0]];
  const next = letters.slice(1).find((letter) => /[^aeiouy\W\d_]/iu.test(letter)) ?? letters[1] ?? "";
  return (letters[0] + next).toUpperCase();
}

const first = (word: string) => [...word][0] ?? "";

/**
 * Sends the page's change. When the core refuses it, the window says why;
 * a later change that is kept clears that.
 */
function keep() {
  agents.refused = null;
  void Promise.resolve(persist({ agents: agentsSettings() }, { quiet: true })).then((refused) => {
    if (refused === null || refused === undefined) return;
    agents.refused = refused;
  });
}

/** Test seam. */
export function reset() {
  agents.own = [];
  agents.installed = {};
  agents.refused = null;
}
