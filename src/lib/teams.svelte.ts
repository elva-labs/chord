import type { GateWhen, Settings, Team, TeamGate, TeamProblem } from "$lib/core";
import { core } from "$lib/core";
import { persist, recovering } from "$lib/persist";

/**
 * The teams a session can lead: a name, the agents it calls, and the gates
 * each change passes. The core says which teams are in use: the settings
 * file's own, or for a file with none, those its workflows give. The
 * window lists those and never works them out. The first change made here
 * writes the whole list as the file's own, and leaves the workflows as
 * they are.
 *
 * A team keeps whatever its entries hold that the window does not know,
 * as the file has it, so a change here writes it back unchanged.
 *
 * The core checks a team being edited and says every rule it breaks; the
 * window says only that a team needs a name.
 */

export const teams = $state({
  /** The settings file's own, or undefined for a file that has none. */
  file: undefined as Team[] | undefined,
  /** The teams in use on this machine, as the core last said. */
  inUse: [] as Team[],
  /** The teams in use where a project is, by project, once read. */
  byProject: {} as Record<string, Team[]>,
  /** Why the last change on the settings page was not kept, while it
      matters. */
  refused: null as string | null,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The teams' part of the settings: the file's own, where it has them. */
export function teamsSettings(): Pick<Settings, "teams"> {
  return teams.file === undefined ? {} : { teams: clone($state.snapshot(teams.file)) };
}

/** Takes the core's word for the file's teams, and asks it again which
    are in use. */
export function adoptTeams(settings: Settings["teams"] | undefined) {
  teams.file = Array.isArray(settings) ? clone(settings) : undefined;
  if (teams.file !== undefined) teams.inUse = clone(teams.file);
  teams.byProject = {};
  void loadTeams();
}

/** Reads the teams in use on this machine. */
export async function loadTeams() {
  try {
    teams.inUse = await core().teamsInUse("");
  } catch {
    teams.inUse = teams.file === undefined ? [] : clone(teams.file);
  }
}

/** Reads the teams in use where a project is. */
export async function loadProjectTeams(project: string) {
  try {
    teams.byProject[project] = await core().teamsInUse(project);
  } catch {
    teams.byProject[project] = [];
  }
}

/** The teams a lead of the project may be started with, once read. */
export function teamsFor(project: string | null): Team[] {
  return project === null ? teams.inUse : (teams.byProject[project] ?? []);
}

export function teamByName(name: string, list: Team[] = teams.inUse): Team | undefined {
  const wanted = name.trim().toLowerCase();
  return list.find((team) => team.name.trim().toLowerCase() === wanted);
}

/** "4 gates · 6 agents". */
export function teamSummary(team: Team): string {
  const gates = team.gates.length;
  const members = team.members.length;
  return `${gates} ${gates === 1 ? "gate" : "gates"} · ${members} ${members === 1 ? "agent" : "agents"}`;
}

export function newTeam(): Team {
  return { name: "", members: [], gates: [] };
}

export function newGate(who: string): TeamGate {
  return { who, when: "change" };
}

/** Whether the draft has an agent of this title, in any case. */
export function hasMember(team: Team, title: string): boolean {
  const wanted = title.trim().toLowerCase();
  return team.members.some((member) => member.agent.trim().toLowerCase() === wanted);
}

export const WHEN: Record<GateWhen, { name: string; about: string }> = {
  plan: { name: "before building", about: "Approves the plan" },
  change: { name: "before handing over", about: "Approves the change" },
};

/** The globs a "touches" field holds, split on commas and spaces. */
export function globsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((glob) => glob.trim())
    .filter((glob) => glob !== "");
}

const NO_NAME: TeamProblem = { text: "A team needs a name.", quiet: false };

/**
 * What the core finds with a draft, most important first, the hints that
 * do not keep it from being saved last. `editing` names the team it
 * replaces, or null for a new one; `folders` are where the open projects
 * are, which a gate's paths are matched against. A draft with no name is
 * not sent. A check that cannot be made is itself the problem, so nothing
 * is saved unchecked.
 */
export async function checkTeam(draft: Team, editing: string | null, folders: string[]): Promise<TeamProblem[]> {
  if (draft.name.trim() === "") return [NO_NAME];
  try {
    return await core().teamCheck("", $state.snapshot(draft) as Team, editing, folders);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return [{ text: `The team could not be checked: ${why}`, quiet: false }];
  }
}

/** Whether a problem keeps a draft from being saved. */
export function refuses(problems: TeamProblem[]): boolean {
  return problems.some((problem) => !problem.quiet);
}

/** Keeps the draft in place of `editing`, or as a new team last, once the
    core finds nothing that keeps it from being saved. Answers with what it
    found. */
export async function saveTeam(draft: Team, editing: string | null, folders: string[] = []): Promise<TeamProblem[]> {
  const problems = await checkTeam(draft, editing, folders);
  if (refuses(problems)) return problems;
  const kept = { ...clone(draft), name: draft.name.trim() };
  const list = clone($state.snapshot(teams.inUse));
  const at = editing === null ? -1 : list.findIndex((team) => team.name === editing);
  if (at === -1) list.push(kept);
  else list[at] = kept;
  keep(list);
  return problems;
}

export function removeTeam(name: string) {
  keep(clone($state.snapshot(teams.inUse)).filter((team) => team.name !== name));
}

let kept = 0;

/**
 * Makes the list the file's own and sends it, showing it at once. When the
 * core refuses the latest list sent, it goes back to what it was and the
 * window says the change was not kept and why; a later change that is
 * kept clears that. A refused list a later one has taken the place of
 * says nothing. Where the settings go back to what is stored on a
 * refusal, that brings the teams back with them.
 */
function keep(list: Team[]) {
  const before = {
    file: teams.file === undefined ? undefined : clone($state.snapshot(teams.file)),
    inUse: clone($state.snapshot(teams.inUse)),
  };
  const mine = ++kept;
  teams.file = list;
  teams.inUse = clone(list);
  teams.refused = null;
  void Promise.resolve(persist({ teams: clone(list) }, { quiet: true })).then((refused) => {
    if (refused === null || refused === undefined || mine !== kept) return;
    teams.refused = `Not kept: ${refused}`;
    if (recovering()) return;
    teams.file = before.file;
    teams.inUse = before.inUse;
  });
}

/** Test seam. */
export function reset() {
  teams.file = undefined;
  teams.inUse = [];
  teams.byProject = {};
  teams.refused = null;
}
