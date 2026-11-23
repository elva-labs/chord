/**
 * What the welcome and the Setup tab say about each check the core made.
 *
 * An agent is found when its program is on the PATH; one is enough to go
 * on. A missing agent is quiet while another is found, and asks to be
 * installed when none is. A found agent that is not signed in asks to be
 * run once. git missing asks to be installed but never holds the app back.
 *
 * Only an agent known to be missing holds the app back. When the login
 * shell could not be read, or the checks could not be made, a program that
 * was not found may be there all the same: the window says so and lets the
 * user go on.
 */
import type { Setup, SetupCheck } from "$lib/core";

export type Icon = "ok" | "need" | "none" | "busy";

export interface SetupRow {
  id: string;
  name: string;
  /** The program's name, shown beside an agent's name. */
  binary: string | null;
  icon: Icon;
  version: string | null;
  /** "Not found", or "Found" when the program gave no version. */
  status: string | null;
  /** What follows the version, and in which tone. */
  extra: { text: string; tone: "plain" | "warn" } | null;
  /** The command that sets it right, and the line above it. */
  command: string | null;
  say: string | null;
  /** The install guide, for a program that is missing. */
  guide: string | null;
  /** Whether the steps show without being asked for. */
  open: boolean;
}

export const BLOCKED = "Install Claude Code or Codex, then check again.";

/** Whether an agent was found, which is what Continue waits on. */
export function agentFound(setup: Setup): boolean {
  return setup.checks.some((check) => check.agent && check.path !== null);
}

/** The footer's demand when no agent is found after a good read. */
export function blocked(setup: Setup): string | null {
  return agentFound(setup) || !setup.fromLoginShell ? null : BLOCKED;
}

/** The line said when no agent was found but the read could not be trusted
    to tell, or null when it could. */
export function unsure(setup: Setup | null, error: string | null): string | null {
  if (setup !== null && agentFound(setup)) return null;
  if (error !== null) return "Chord could not check this machine, so an agent may be here all the same.";
  if (setup !== null && !setup.fromLoginShell) {
    return "Chord could not read your shell's setup, so an agent may be here all the same.";
  }
  return null;
}

export function row(check: SetupCheck, setup: Setup): SetupRow {
  const base = {
    id: check.id,
    name: check.name,
    binary: check.agent ? check.binary : null,
    version: check.version,
    status: null,
    extra: null,
    command: null,
    say: null,
    guide: null,
    open: false,
  };
  if (check.path === null) {
    const loud = !check.agent || !agentFound(setup);
    return {
      ...base,
      icon: loud ? "need" : "none",
      version: null,
      status: "Not found",
      command: check.install.command,
      say: check.agent ? null : "Worktrees, diffs and the changes view need it.",
      guide: check.install.link,
      open: loud,
    };
  }
  const status = check.version === null ? "Found" : null;
  if (check.signedIn === false) {
    return {
      ...base,
      icon: "need",
      status,
      extra: { text: "Not signed in", tone: "warn" },
      command: check.binary,
      say: "Run it once in a terminal and sign in.",
      open: true,
    };
  }
  return {
    ...base,
    icon: "ok",
    status,
    extra: check.signedIn ? { text: "Signed in", tone: "plain" } : null,
  };
}

/** The checks in their two groups: the agents, and source control. */
export function groups(setup: Setup): { agents: SetupRow[]; tools: SetupRow[] } {
  return {
    agents: setup.checks.filter((check) => check.agent).map((check) => row(check, setup)),
    tools: setup.checks.filter((check) => !check.agent).map((check) => row(check, setup)),
  };
}
