import { tick } from "svelte";
import { ACTIONS, chordFor, describe, type ActionKey } from "$lib/keys.svelte";
import { actionFor, type Action } from "$lib/keymap";
import {
  canPreview,
  effectiveView,
  files,
  matches,
  selectedEntry,
  setView,
} from "$lib/files.svelte";
import { hostOf, openRemote } from "$lib/remote.svelte";
import {
  focusPane,
  layout,
  peekSessions,
  returnFocus,
  sessionsShown,
} from "$lib/layout.svelte";
import {
  accountLabel,
  accountToStart,
  hasAccounts,
  names,
  lastPicked,
  pickAccount,
} from "$lib/accounts.svelte";
import { harnessLabel, installed, isReady } from "$lib/harness.svelte";
import {
  pickedBefore,
  pickProfile,
  profilesKnown,
  profilesOf,
  profileToStart,
  profileToStartHeard,
  readProfiles,
} from "$lib/codexProfiles.svelte";
import { catalogName } from "$lib/modelCatalog.svelte";
import { chosenFor, defaultModelOf, modelToStart } from "$lib/lastChosen.svelte";
import { core, type HarnessId } from "$lib/core";
import { openSetup } from "$lib/settings.svelte";
import { wrapApplies } from "$lib/editor.svelte";
import { toggleWrap, wrap } from "$lib/wrap.svelte";
import {
  overrideOf,
  workflowGist,
  workflowNamed,
  workflowOf,
  workflows,
} from "$lib/workflows.svelte";
import {
  defaultAgent,
  otherWay,
  rowName,
  sessions,
  waitingOnYou,
  type Session,
} from "$lib/sessions.svelte";
import {
  bringForward,
  goTo,
  onScreen,
  pick,
  projectLabel,
  startSession,
  workspace,
} from "$lib/workspace.svelte";
import { liveUnder } from "$lib/projects.svelte";
import { startsIn } from "$lib/orchestratorFolder.svelte";
import { unfoldSessions } from "$lib/viewers.svelte";
import { reduced } from "$lib/motion";
import { canGoBack, openBack } from "$lib/rewind.svelte";
import { compact } from "$lib/compact.svelte";
import { browser } from "$lib/browser.svelte";

/**
 * The palette: one field over the workbench in two lists. Go to narrows the
 * sessions and the projects by what is typed, and commands narrows every
 * action the keys can do and the few that have no chord. A `>` typed first
 * in go to switches to commands.
 *
 * A session is listed by when it last changed, with its state, its project
 * and the time. A project is listed with how many sessions are live in it,
 * or when it was last used. An action is listed with its chord. Going to
 * the next session that needs you leads the commands, since it is what the
 * palette is opened for most.
 *
 * A new session asks for the project when it is not known, then offers
 * one line: the session it would start, on the agent it used last and the
 * account the project runs under, which Enter starts. Change, under it,
 * asks the rest in steps in the same field: the account when accounts are
 * named, then how it runs: under one of the workflows, the project's own
 * first, or as one agent with no workflow. The workflows are offered where
 * the project follows one, by its own choice or by the default for new
 * sessions. Codex alone then asks which of the account's Codex profiles it
 * runs under, where the account has any. Each answer becomes a chip, and a
 * step with nothing to choose is not asked. The session starts on the last
 * answer.
 */

export type Mode = "goto" | "commands" | "new";

export type CommandId =
  | "new"
  | "newHere"
  | "newOther"
  | "open"
  | "remote"
  | "goBack"
  | "preview"
  | "source"
  | "wrap"
  | "setup"
  | "welcome";

/** An answer to one of the questions a new session asks. */
export type Step =
  | { kind: "project"; path: string }
  | { kind: "account"; account: string | null }
  | { kind: "agent"; agent: HarnessId }
  | { kind: "workflow"; workflow: string }
  | { kind: "profile"; profile: string | null };

export type StepKind = Step["kind"];

export type PaletteItem =
  | {
      kind: "attention";
      id: "attention";
      label: string;
      detail: string;
      waiting: number;
      chord: string;
      group: null;
    }
  | {
      kind: "session";
      id: string;
      label: string;
      /** Nothing names it yet, so its label is "New session". */
      unnamed: boolean;
      group: string;
      session: Session;
      project: string;
      when: string;
    }
  | {
      kind: "project";
      id: string;
      label: string;
      group: string;
      path: string;
      end: string;
    }
  | {
      kind: "command";
      id: string;
      label: string;
      group: null;
      command: CommandId;
      chord: string;
    }
  | {
      kind: "choice";
      id: string;
      label: string;
      group: string;
      step: Step;
      /** A line beside the label: what a workflow does. */
      detail: string;
      end: string;
    }
  | {
      kind: "action";
      id: string;
      label: string;
      group: null;
      action: ActionKey;
      chord: string;
    }
  | {
      /** The session the defaults start, which Enter takes. */
      kind: "ready";
      id: "ready";
      label: string;
      group: null;
      /** The answers it starts on. */
      steps: Step[];
      /** What it runs on, as one line. */
      detail: string;
    }
  | {
      /** The way to the questions the defaults answered. */
      kind: "change";
      id: "change";
      label: string;
      group: null;
    };

/** What picking an item leads to. The palette stays up on a step; it goes
    away before a command or a session is reached, so where the keyboard
    ends up is where it stays; and an action is the page's to perform. */
export type Outcome =
  | { type: "stay" }
  | { type: "close"; then: () => void }
  | { type: "perform"; action: Action };

const JUMP = ACTIONS.find(({ key }) => key === "session.attention")!;

export const ATTENTION_LABEL = JUMP.label;

export const SESSIONS = "Sessions";
export const PROJECTS = "Projects";

export const palette = $state({
  open: false,
  mode: "goto" as Mode,
  query: "",
  /** The answers given so far to a new session's questions. */
  steps: [] as Step[],
  /** A new session in a known project offers its defaults as one line,
      until Change or typing asks the questions instead. */
  ready: false,
  /** The list a new session was asked for from, go to or the commands,
      and what was typed in it, which stepping back out of the new session
      opens again with the same text. */
  from: "commands" as "commands" | "goto",
  came: "",
  /** Counts every time a list is opened, so a palette still fading out from
      the last close takes the keyboard again. */
  opened: 0,
  /** The palette is closed and fading out, which it stays drawn for. */
  leaving: false,
});

/** How long the palette takes to fade out, in milliseconds. */
export const FADE = 110;

let leaveTimer: ReturnType<typeof setTimeout> | null = null;

function stopLeaving() {
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = null;
  palette.leaving = false;
}

export function openGoTo() {
  palette.mode = "goto";
  palette.query = "";
  palette.steps = [];
  palette.ready = false;
  palette.from = "commands";
  palette.came = "";
  palette.opened += 1;
  stopLeaving();
  palette.open = true;
}

export function openCommands() {
  palette.mode = "commands";
  palette.query = "";
  palette.steps = [];
  palette.ready = false;
  palette.from = "commands";
  palette.came = "";
  palette.opened += 1;
  stopLeaving();
  palette.open = true;
}

/** The commands palette, for callers that only know there is one. */
export const openPalette = openCommands;

/** Puts the palette away and hands the keyboard back to the pane that had
    it. The palette stays drawn for the length of its fade, so the keyboard
    is not left to its removal. */
export function closePalette() {
  if (!palette.open) return;
  palette.open = false;
  returnFocus();
  if (reduced()) return;
  palette.leaving = true;
  leaveTimer = setTimeout(stopLeaving, FADE);
}

/** Test seam. */
export function resetPalette() {
  stopLeaving();
  palette.open = false;
  palette.mode = "goto";
  palette.query = "";
  palette.steps = [];
  palette.ready = false;
  palette.from = "commands";
  palette.came = "";
}

/** The field changed. A `>` first in go to leaves it for commands, with
    the rest of what was typed. A new session's defaults with nothing to
    choose take no text. */
export function setQuery(text: string) {
  if (palette.mode === "goto" && text.startsWith(">")) {
    palette.mode = "commands";
    palette.query = text.slice(1);
    return;
  }
  if (palette.mode === "new" && palette.ready && stepsLeft(palette.steps).length === 0) return;
  palette.query = text;
}

/** When a project was last used: the latest of its sessions' changes and
    its past sessions, in milliseconds, or null when it has had none. */
export function lastUsed(path: string): number | null {
  const times = [
    ...sessions.all
      .filter((session) => session.project === path)
      .map((session) => session.changedAt),
    ...(sessions.history[path] ?? []).map(
      (transcript) => transcript.modified * 1000,
    ),
  ];
  return times.length === 0 ? null : Math.max(...times);
}

/** A time as a row's end spells it: "now", or a count of minutes, hours,
    days, weeks or months since. */
export function since(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w`;
  return `${Math.floor(seconds / 2_592_000)}mo`;
}

/** The open projects, the latest used first and the rest in the order they
    were opened. */
export function projectsByUse(): string[] {
  return workspace.open
    .map((project, order) => ({
      path: project.path,
      order,
      used: lastUsed(project.path) ?? 0,
    }))
    .sort((a, b) => b.used - a.used || a.order - b.order)
    .map((project) => project.path);
}

/** How a project stands at a row's end: the live sessions drawn under it
    in the sessions pane, else how long since it was last used. */
function standing(path: string): string {
  const live = liveUnder(path);
  if (live > 0) return `${live} live`;
  const used = lastUsed(path);
  return used === null ? "" : since(used);
}

/** The command that shows the file open in the viewer the other way, when
    it is one the app renders: Preview file while its source is shown, Show
    source while its rendering is. Offered with the viewer holding a file,
    outside editor mode, which has its own views. */
function viewCommand(): PaletteItem | null {
  if (layout.mode !== "reviewing" || files.media !== null || files.pluginView !== null)
    return null;
  if (browser.showing) return null;
  const entry = selectedEntry();
  if (entry === null || !canPreview(entry)) return null;
  const rendered = effectiveView() === "rendered";
  return {
    kind: "command",
    id: rendered ? "command:source" : "command:preview",
    label: rendered ? "Show source" : "Preview file",
    group: null,
    command: rendered ? "source" : "preview",
    chord: "",
  };
}

/** The command that turns wrapping of long lines in the editor on or off,
    named for what it does. Offered with a text file in the editor's front. */
function wrapCommand(): PaletteItem | null {
  if (!wrapApplies()) return null;
  return {
    kind: "command",
    id: "command:wrap",
    label: wrap.on ? "Turn word wrap off" : "Turn word wrap on",
    group: null,
    command: "wrap",
    chord: describe(chordFor("editor.wrap")),
  };
}

/** The sessions and the projects a query leaves, in that order, then the
    command for the file in the viewer when something is typed that it
    matches, first when the text is the start of its name: go to lists no
    commands otherwise. */
export function goToItems(query: string): PaletteItem[] {
  const now = Date.now();
  const rows = [...sessions.all]
    .sort((a, b) => b.changedAt - a.changedAt)
    .map((session): PaletteItem => ({
      kind: "session",
      id: `session:${session.key}`,
      label: rowName(session) ?? "New session",
      unnamed: rowName(session) === null,
      group: SESSIONS,
      session,
      project: projectLabel(session.project),
      when: since(session.changedAt, now),
    }))
    .filter(
      (item) =>
        item.kind === "session" &&
        matches(`${item.label} ${item.project}`, query),
    );
  const projects = projectsByUse()
    .map((path): PaletteItem => ({
      kind: "project",
      id: `project:${path}`,
      label: projectLabel(path),
      group: PROJECTS,
      path,
      end: standing(path),
    }))
    .filter((item) => matches(item.label, query));
  const view = viewCommand();
  const shown =
    view !== null && query.trim() !== "" && matches(view.label, query) ? [view] : [];
  // Typing the start of the command's name puts it first, so Enter runs it.
  const first =
    view !== null &&
    shown.length > 0 &&
    view.label.toLowerCase().startsWith(query.trim().toLowerCase());
  if (sessions.all.length === 0 && workspace.open.length === 0) {
    const open: PaletteItem = {
      kind: "command",
      id: "command:open",
      label: "Open project",
      group: null,
      command: "open",
      chord: "",
    };
    return [...(matches(open.label, query) ? [open] : []), ...shown];
  }
  return first ? [...shown, ...rows, ...projects] : [...rows, ...projects, ...shown];
}

/** The commands a query leaves: the jump to who needs you, then the ones
    with no chord, then every action the keys can do. */
export function commandItems(query: string): PaletteItem[] {
  const attention: PaletteItem = {
    kind: "attention",
    id: "attention",
    label: ATTENTION_LABEL,
    detail: JUMP.group,
    group: null,
    // The jump goes to sessions other than the one on screen, so those are
    // what it counts.
    waiting: waitingOnYou().filter((session) => session.key !== sessions.active)
      .length,
    chord: describe(chordFor("session.attention")),
  };
  const command = (id: CommandId, label: string): PaletteItem => ({
    kind: "command",
    id: `command:${id}`,
    label,
    group: null,
    command: id,
    chord: "",
  });
  // Nothing new starts in the orchestrator folder, so with it on screen
  // only New session is offered, which asks for the project.
  const here = startsIn(onScreen()) ? onScreen() : null;
  const other = here === null ? null : otherWay(here);
  const view = viewCommand();
  const wrapping = wrapCommand();
  const commands: PaletteItem[] = [
    ...(workspace.open.length === 0 ? [] : [command("new", "New session")]),
    ...(here === null
      ? []
      : [command("newHere", `New session in ${projectLabel(here)}`)]),
    // The other way from New session's, for one session in the project on
    // screen, alone.
    ...(other === null
      ? []
      : [
          command(
            "newOther",
            other === "integrated"
              ? `New session in Chord in ${projectLabel(here!)}`
              : `New session in a terminal in ${projectLabel(here!)}`,
          ),
        ]),
    // Going back is the session on screen's, while it is at rest.
    ...(sessions.active !== null && canGoBack(sessions.active)
      ? [command("goBack", "Go back to an earlier message")]
      : []),
    ...(view === null ? [] : [view]),
    ...(wrapping === null ? [] : [wrapping]),
    command("open", "Open project"),
    command("remote", "Open remote project"),
    command("setup", "Check setup"),
    command("welcome", "Show welcome"),
  ];
  const actions = ACTIONS.filter(
    ({ key }) =>
      key !== "palette" && key !== "session.attention" && key !== "editor.wrap",
  ).map(({ key, label }): PaletteItem => ({
    kind: "action",
    id: `action:${key}`,
    label,
    group: null,
    action: key,
    chord: describe(chordFor(key)),
  }));
  return [attention, ...commands, ...actions].filter((item) =>
    matches(
      `${item.label} ${item.kind === "attention" ? item.detail : ""}`,
      query,
    ),
  );
}

/** The question a new session asks next given the answers so far, or null
    when it has all it needs. How it runs is asked as "agent", and answered
    by an agent or a workflow; it is asked when there is more than one
    agent, or a workflow on offer in the project, to pick between. The
    profile is asked of Codex alone, where the account has profiles. */
export function nextStep(steps: Step[]): StepKind | null {
  const has = (kind: StepKind) => steps.some((step) => step.kind === kind);
  if (!has("project")) return "project";
  if (hasAccounts() && !has("account")) return "account";
  const project = projectOfSteps(steps);
  const how = installed().length > 1 || (project !== null && offered(project).length > 0);
  if (how && !has("agent") && !has("workflow")) return "agent";
  if (project !== null && !has("profile") && !has("workflow") && harnessOfSteps(steps, project) === "codex")
    if (profilesOf(project, accountOfSteps(steps, project)).length > 0) return "profile";
  return null;
}

/** The harness the answers so far run alone: the one picked, else the one
    the project used last. */
function harnessOfSteps(steps: Step[], project: string): HarnessId {
  const step = steps.find((candidate) => candidate.kind === "agent");
  return step === undefined ? defaultAgent(project) : step.agent;
}

/** The account the answers so far run under: the one picked, else the
    one a new session in the project starts under. */
function accountOfSteps(steps: Step[], project: string): string | null {
  const step = steps.find((candidate) => candidate.kind === "account");
  return step === undefined ? accountToStart(project) : step.account;
}

/** The questions still to ask, the next first. */
export function stepsLeft(steps: Step[]): StepKind[] {
  const left: StepKind[] = [];
  const taken = [...steps];
  for (let kind = nextStep(taken); kind !== null; kind = nextStep(taken)) {
    left.push(kind);
    taken.push(
      kind === "project"
        ? { kind, path: "" }
        : kind === "account"
          ? { kind, account: null }
          : kind === "profile"
            ? { kind, profile: null }
            : { kind: "agent", agent: "claude-code" },
    );
  }
  return left;
}

/** The project the answers so far name. */
export function projectOfSteps(steps: Step[]): string | null {
  const step = steps.find((candidate) => candidate.kind === "project");
  return step === undefined ? null : step.path;
}

/** An answer as its chip spells it. */
export function chipOf(step: Step): string {
  switch (step.kind) {
    case "project":
      return projectLabel(step.path);
    case "account":
      return accountLabel(step.account);
    case "agent":
      return harnessLabel(step.agent);
    case "workflow":
      return step.workflow;
    case "profile":
      return step.profile ?? NO_PROFILE;
  }
}

export const PROFILES = "With which Codex profile";
const NO_PROFILE = "No profile";

export const WORKFLOWS = "Workflows";
export const ALONE = "No workflow";

/** The workflows a new session in a project is offered: none unless the
    project follows one, by its own choice or by the default. */
function offered(project: string) {
  return workflowOf(project) === null ? [] : workflows.list;
}

/** What the last question offers, as titled lists drawn in order: the
    workflows, the project's own first, then the agents to run alone. The
    project's own says whether the project chose it or follows the default
    for new sessions. */
function runSections(
  project: string,
): { title: string; items: PaletteItem[] }[] {
  const own = workflowOf(project);
  const ownEnd = overrideOf(project) === undefined ? "default" : "project's workflow";
  const list = offered(project);
  const ordered =
    own === null || list.length === 0
      ? list
      : [own, ...list.filter((workflow) => workflow.name !== own.name)];
  const sections = [
    {
      title: WORKFLOWS,
      items: ordered.map((workflow): PaletteItem => ({
        kind: "choice",
        id: `workflow:${workflow.name}`,
        label: workflow.name,
        group: WORKFLOWS,
        step: { kind: "workflow", workflow: workflow.name },
        detail: workflowGist(workflow),
        end: workflow.name === own?.name ? ownEnd : "",
      })),
    },
    {
      title: ALONE,
      items: installed().map((agent): PaletteItem => ({
        kind: "choice",
        id: `agent:${agent}`,
        label: harnessLabel(agent),
        group: ALONE,
        step: { kind: "agent", agent },
        detail: "",
        end: sessions.preferred[project] === agent ? "last used" : "",
      })),
    },
  ];
  return sections.filter((section) => section.items.length > 0);
}

/** The projects a new session can go in: the one on screen first, then
    by when they were last used. */
function projectChoices(): PaletteItem[] {
  const group = "In which project";
  const order = projectsByUse();
  const here = onScreen();
  const paths =
    here !== null && order.includes(here)
      ? [here, ...order.filter((path) => path !== here)]
      : order;
  return paths.map((path): PaletteItem => ({
    kind: "choice",
    id: `project:${path}`,
    label: projectLabel(path),
    group,
    step: { kind: "project", path },
    detail: "",
    end: standing(path),
  }));
}

/** The accounts a new session can run under, the agents' own first. The
    one it starts under unless another is picked says why: it is the
    project's, or the one picked there last. */
function accountChoices(project: string): PaletteItem[] {
  if (!isOpen(project)) return [];
  const group = "Under which account";
  const own = accountToStart(project);
  const why = lastPicked(project) === undefined ? "this project's" : "last picked";
  return [null, ...names()].map((account): PaletteItem => ({
    kind: "choice",
    id: `account:${account ?? ""}`,
    label: accountLabel(account),
    group,
    step: { kind: "account", account },
    detail: "",
    end: account === own ? why : "",
  }));
}

/** How many of a profile's settings a session is not given, said on its
    line. Null for none. */
function leftOutCount(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 setting left out" : `${count} settings left out`;
}

/** The Codex profiles a new session can run under: no profile first, then
    the account's, each with the model and effort its file sets, the
    provider where it names one, and how many of its settings are left out.
    No profile says what the session starts on without one, as far as that
    is known. The one it starts under unless another is picked says so
    where it was picked before. */
function profileChoices(project: string, account: string | null): PaletteItem[] {
  const host = hostOf(project);
  const named = (model: string | null) =>
    model === null ? null : (catalogName("codex", model, account, host) ?? model);
  const start = profileToStart(project, account);
  const last = (name: string | null) => (pickedBefore(project) && name === start ? "last used here" : null);
  const end = (parts: (string | null)[]) => parts.filter((part) => part !== null && part !== "").join(" · ");
  const none = modelToStart("codex", account) ?? defaultModelOf("codex", account);
  return [
    {
      kind: "choice",
      id: "profile:",
      label: NO_PROFILE,
      group: PROFILES,
      step: { kind: "profile", profile: null },
      detail: "config.toml",
      end: end([named(none), chosenFor("codex").effort ?? null, last(null)]),
    },
    ...profilesOf(project, account).map(
      (profile): PaletteItem => ({
        kind: "choice",
        id: `profile:${profile.name}`,
        label: profile.name,
        group: PROFILES,
        step: { kind: "profile", profile: profile.name },
        detail: [`${profile.name}.config.toml`, leftOutCount(profile.leftOut.length)].filter((part) => part !== null).join(" · "),
        end: end([named(profile.model), profile.effort, profile.provider, last(profile.name)]),
      }),
    ),
  ];
}

/** The answers a new session in a project starts on when none is changed:
    the project, then for each question it would ask, the account a new
    session there starts under, the workflow it follows, else the harness it
    used last, and for Codex the profile it starts under. */
export function defaultsFor(path: string): Step[] {
  const steps: Step[] = [{ kind: "project", path }];
  for (let kind = nextStep(steps); kind !== null && kind !== "project"; kind = nextStep(steps)) {
    if (kind === "account") steps.push({ kind, account: accountToStart(path) });
    else if (kind === "profile") steps.push({ kind, profile: profileToStart(path, accountOfSteps(steps, path)) });
    else {
      const own = workflowOf(path);
      steps.push(own === null ? { kind: "agent", agent: defaultAgent(path) } : { kind: "workflow", workflow: own.name });
    }
  }
  return steps;
}

/** The line a new session's defaults read as: how it runs, the agent even
    where it is not a question, the profile where it runs under one, then
    the account where accounts are named. */
function readyLine(path: string, steps: Step[]): string {
  const how = steps.find((step) => step.kind === "agent" || step.kind === "workflow");
  const account = steps.find((step) => step.kind === "account");
  const profile = steps.find((step) => step.kind === "profile" && step.profile !== null);
  return [
    how === undefined ? harnessLabel(defaultAgent(path)) : chipOf(how),
    ...(profile === undefined ? [] : [chipOf(profile)]),
    ...(account === undefined ? [] : [chipOf(account)]),
  ].join(" · ");
}

/** The defaults' line, and Change under it where there is a choice. */
function readyItems(path: string): PaletteItem[] {
  const steps = defaultsFor(path);
  const ready: PaletteItem = {
    kind: "ready",
    id: "ready",
    label: "New session",
    group: null,
    steps,
    detail: readyLine(path, steps),
  };
  const change: PaletteItem = { kind: "change", id: "change", label: "Change", group: null };
  return steps.length > 1 ? [ready, change] : [ready];
}

export const WHICH_HARNESS = "Which harness";

/** Everything Change would ask about a project's new session, narrowed by
    what is typed: how it runs, then the account, then the Codex profile,
    each under its heading, and in each the names the text begins first. */
function readySearch(project: string, query: string): PaletteItem[] {
  const left = stepsLeft([{ kind: "project", path: project }]);
  const defaults = defaultsFor(project);
  const how = left.includes("agent") ? runSections(project) : [];
  const alone = how.length === 1 && how[0].title === ALONE;
  const groups = [
    ...how.map((section) =>
      section.items.map((item): PaletteItem => (alone && item.kind === "choice" ? { ...item, group: WHICH_HARNESS } : item)),
    ),
    left.includes("account") ? accountChoices(project) : [],
    defaults.some((step) => step.kind === "profile")
      ? profileChoices(project, accountOfSteps(defaults, project))
      : [],
  ];
  const typed = query.trim().toLowerCase();
  const begins = (item: PaletteItem) => item.label.toLowerCase().startsWith(typed);
  return groups.flatMap((items) => {
    const found = items.filter((item) => matches(item.label, query));
    return [...found.filter(begins), ...found.filter((item) => !begins(item))];
  });
}

/** What the question being asked offers, narrowed by what is typed. On a
    new session's defaults, what is typed narrows everything they stand for. */
export function stepItems(
  query: string,
  steps: Step[] = palette.steps,
): PaletteItem[] {
  const asking = nextStep(steps);
  const project = projectOfSteps(steps);
  if (asking !== "project" && (project === null || !isOpen(project)))
    return [];
  if (palette.ready && project !== null)
    return query.trim() === "" ? readyItems(project) : readySearch(project, query);
  const all =
    asking === "project"
      ? projectChoices()
      : asking === "account" && project !== null
        ? accountChoices(project)
        : asking === "agent" && project !== null
          ? runSections(project).flatMap((section) => section.items)
          : asking === "profile" && project !== null
            ? profileChoices(project, accountOfSteps(steps, project))
            : [];
  return all.filter((item) => matches(item.label, query));
}

/** What the palette lists now, in the order it draws them. */
export function paletteItems(): PaletteItem[] {
  if (palette.mode === "new") return stepItems(palette.query);
  return palette.mode === "goto"
    ? goToItems(palette.query)
    : commandItems(palette.query);
}

/** Whether picking an item does anything: the jump with nothing waiting
    does not, and neither does a new session while no agent is ready. */
export function pickable(item: PaletteItem): boolean {
  if (item.kind === "attention") return item.waiting > 0;
  if (item.kind === "command")
    return isReady() || (item.command !== "new" && item.command !== "newHere" && item.command !== "newOther");
  return true;
}

/** The entry the cursor starts on when the list is not narrowed: in go to,
    the first session that is not the one on screen; in a new session, the
    account the project runs under or the agent it used last. Null leaves it
    to the first entry that does something. */
export function startingId(): string | null {
  if (palette.query.trim() !== "") return null;
  if (palette.mode === "goto")
    return (
      goToItems("").find(
        (item) => item.kind === "session" && item.session.key !== sessions.active,
      )?.id ?? null
    );
  if (palette.mode !== "new" || palette.ready) return null;
  const project = projectOfSteps(palette.steps);
  if (project === null) return null;
  const asking = nextStep(palette.steps);
  if (asking === "account") return `account:${accountToStart(project) ?? ""}`;
  if (asking === "agent") {
    const own = workflowOf(project);
    return own === null ? `agent:${defaultAgent(project)}` : `workflow:${own.name}`;
  }
  if (asking === "profile")
    return `profile:${profileToStart(project, accountOfSteps(palette.steps, project)) ?? ""}`;
  return null;
}

/** Whether a project is still open. */
function isOpen(path: string): boolean {
  return workspace.open.some((project) => project.path === path);
}

/** Starts a session on the answers given: under the workflow picked, or
    the agent picked alone. The project's default account stands in for a
    question that was not asked, and a session not asked how to run runs as
    a plain new one does. A Codex session not asked its profile runs under
    the one it would start under. An account or a profile the user picked
    is the project's default from then on, the account where the project
    names none of its own. A project that has closed meanwhile gets none. */
function startOn(steps: Step[], picked: boolean) {
  const path = projectOfSteps(steps);
  if (path === null || !isOpen(path)) return;
  const account = steps.find((step) => step.kind === "account");
  if (picked && account !== undefined) pickAccount(path, account.account);
  const profile = steps.find((step) => step.kind === "profile");
  if (picked && profile !== undefined) pickProfile(path, profile.profile);
  const agent = steps.find((step) => step.kind === "agent");
  const workflow = steps.find((step) => step.kind === "workflow");
  startSession(
    path,
    agent?.agent,
    account === undefined ? undefined : account.account,
    workflow === undefined ? undefined : (workflowNamed(workflow.workflow) ?? undefined),
    undefined,
    profile === undefined ? profileToStart(path, accountOfSteps(steps, path)) : profile.profile,
  );
}

/** The picks held until their account's Codex profiles are heard, by
    count, so a later pick lets an earlier one go. */
let holds = 0;

/** Holds a pick that would start a Codex session before its account's
    profiles are heard, and makes it again, by `again`, once they are, where
    the palette still stands as it did. Null where nothing waits: the
    session asks no profile, or its account's list is known. */
function onceProfilesHeard(steps: Step[], again: () => Outcome): Outcome | null {
  const project = projectOfSteps(steps);
  if (project === null || !isOpen(project) || !installed().includes("codex")) return null;
  if (steps.some((step) => step.kind === "profile" || step.kind === "workflow")) return null;
  if (harnessOfSteps(steps, project) !== "codex") return null;
  const account = accountOfSteps(steps, project);
  if (profilesKnown(project, account)) return null;
  const hold = ++holds;
  const { opened, mode, steps: at, ready, query } = palette;
  const still = () =>
    hold === holds &&
    palette.open &&
    palette.opened === opened &&
    palette.mode === mode &&
    palette.steps === at &&
    palette.ready === ready &&
    palette.query === query;
  void readProfiles(project, account).then(() => {
    if (!still()) return;
    const outcome = again();
    if (outcome.type !== "close") return;
    closePalette();
    void tick().then(outcome.then);
  });
  return { type: "stay" };
}

/** Takes an answer, and starts the session when it was the last one asked,
    once a Codex session's profiles are heard. The project's answer leads
    to the defaults' line instead. */
function answer(steps: Step[]): Outcome {
  const project = projectOfSteps(steps);
  if (project !== null && isOpen(project) && installed().includes("codex"))
    void readProfiles(project, accountOfSteps(steps, project));
  return goOn(steps);
}

/** Moves on from an answer: to the next question, or to the session. */
function goOn(steps: Step[]): Outcome {
  const ready = steps.length === 1 && steps[0].kind === "project";
  if (!ready && nextStep(steps) === null)
    return onceProfilesHeard(steps, () => goOn(steps)) ?? { type: "close", then: () => startOn(steps, true) };
  palette.mode = "new";
  palette.steps = steps;
  palette.ready = ready;
  palette.query = "";
  return { type: "stay" };
}

/** Starts asking for a new session, in a project when it is known. With
    one project open the project is known, and is not asked. The
    orchestrator folder is never the project, so a new session from one of
    its rows asks which. The palette opens on the step where it is shut. */
export function beginNew(path: string | null): Outcome {
  if (!isReady()) return { type: "stay" };
  const only = workspace.open.length === 1 ? workspace.open[0].path : null;
  const project = (startsIn(path) ? path : null) ?? only;
  if (!palette.open) {
    palette.opened += 1;
    stopLeaving();
    palette.from = "commands";
    palette.came = "";
  } else if (palette.mode !== "new") {
    palette.from = palette.mode;
    palette.came = palette.query;
  }
  const outcome = answer(project === null ? [] : [{ kind: "project", path: project }]);
  palette.open = true;
  return outcome;
}

/** The palette on a new session's step, from a button or a key outside it:
    the project's defaults when it is known, else which project. */
export function openNew(path: string | null) {
  beginNew(path);
}

/** Goes back a step: from the questions Change asked, the last answer is
    taken back, and with none given the defaults' line is offered again.
    From that line, go to is where the question came from when it was asked
    there, a project already picked in it; else the project is taken back
    where it was asked, and otherwise the commands list is where the
    question came from. */
export function stepBack() {
  palette.query = "";
  if (palette.mode === "new" && !palette.ready && palette.steps.length > 1) {
    palette.steps = palette.steps.slice(0, -1);
    return;
  }
  if (palette.mode === "new" && !palette.ready && palette.steps.length === 1) {
    palette.ready = true;
    return;
  }
  if (palette.from === "goto") {
    palette.steps = [];
    palette.ready = false;
    palette.mode = "goto";
    palette.query = palette.came;
    return;
  }
  const only = workspace.open.length === 1;
  if (palette.steps.length > 0 && !only) {
    palette.steps = [];
    palette.ready = false;
    return;
  }
  palette.steps = [];
  palette.ready = false;
  palette.mode = "commands";
  palette.query = palette.came;
}

/** Gives the keyboard to the sessions pane, which a project with no session
    has instead of a terminal. Called once the page has reacted to the
    project coming forward, which puts a peeked pane back. A folded pane is
    opened first, or while reviewing peeked over the agent so the viewer
    stays. A window too narrow for the pane leaves it folded, as the user
    set it, and the keyboard goes to the agent pane, which has no session to
    give it to and takes it itself. So does compact mode, where going to a
    project leaves the pane where it is, out of sight. */
function keyboardToSessions() {
  if (!sessionsShown() && !compact.on) {
    if (layout.mode === "reviewing") peekSessions(true);
    else if (!layout.sessionsForced) unfoldSessions();
  }
  focusPane(sessionsShown() ? "sessions" : "agent");
}

/** Picks an item. With `alone` held, a session or project starts a new
    session in its project instead of going to it. */
export function pickItem(item: PaletteItem, alone = false): Outcome {
  if (!pickable(item)) return { type: "stay" };
  switch (item.kind) {
    case "session":
      if (alone) return beginNew(item.session.project);
      return {
        type: "close",
        then: () => void (goTo(item.session.key) && focusPane("agent")),
      };
    case "project":
      if (alone) return beginNew(item.path);
      return {
        type: "close",
        then: () => {
          bringForward(item.path);
          if (sessions.active !== null) focusPane("agent");
          else void tick().then(keyboardToSessions);
        },
      };
    case "choice": {
      if (!palette.ready) return answer([...palette.steps, item.step]);
      // Found from the defaults' line: the defaults with this one answer
      // changed.
      const path = projectOfSteps(palette.steps);
      if (path === null) return { type: "stay" };
      // Another account drops the default account's profile, so the
      // session starts under the profile it would under that account.
      const kin = (step: Step) =>
        item.step.kind === "account" || item.step.kind === "profile"
          ? step.kind === item.step.kind
          : step.kind === "agent" || step.kind === "workflow";
      const steps = defaultsFor(path)
        .filter((step) => !(item.step.kind === "account" && step.kind === "profile"))
        .map((step) => (kin(step) ? item.step : step));
      return (
        onceProfilesHeard(steps, () => pickItem(item, alone)) ?? {
          type: "close",
          then: () => startOn(steps, item.step.kind === "account" || item.step.kind === "profile"),
        }
      );
    }
    case "ready": {
      const steps = item.steps;
      const path = projectOfSteps(steps);
      const again = (): Outcome =>
        path === null ? { type: "stay" } : { type: "close", then: () => startOn(defaultsFor(path), false) };
      return onceProfilesHeard(steps, again) ?? { type: "close", then: () => startOn(steps, false) };
    }
    case "change":
      palette.ready = false;
      palette.query = "";
      return { type: "stay" };
    case "attention":
      return { type: "perform", action: { type: "attention" } };
    case "command":
      switch (item.command) {
        case "new":
          return beginNew(null);
        case "newHere":
          return beginNew(onScreen());
        case "newOther": {
          const here = onScreen();
          if (here === null || !startsIn(here)) return { type: "stay" };
          const agent = defaultAgent(here);
          const kind = otherWay(here);
          if (kind === null) return { type: "stay" };
          const account = accountToStart(here);
          return {
            type: "close",
            then: async () => {
              const profile = agent === "codex" ? await profileToStartHeard(here, account) : null;
              startSession(here, agent, account, null, kind, profile);
            },
          };
        }
        case "open":
          return { type: "close", then: () => void pick() };
        case "remote":
          return { type: "close", then: () => void openRemote() };
        case "preview":
          return { type: "close", then: () => setView("rendered") };
        case "source":
          return { type: "close", then: () => setView("content") };
        case "wrap":
          return wrapApplies() ? { type: "close", then: toggleWrap } : { type: "stay" };
        case "setup":
          return { type: "close", then: openSetup };
        case "welcome":
          return { type: "close", then: () => void core().welcomeShow() };
        case "goBack": {
          const key = sessions.active;
          if (key === null) return { type: "stay" };
          return {
            type: "close",
            then: () => {
              focusPane("agent");
              void openBack(key);
            },
          };
        }
      }
    case "action":
      return { type: "perform", action: actionFor(item.action) };
  }
}
