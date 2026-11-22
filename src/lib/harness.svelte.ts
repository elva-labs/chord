import type { HarnessId, DetectReport } from "$lib/core";

/**
 * Which harnesses there are to run at all: Claude Code and Codex.
 *
 * One question per harness, asked once, about the machine rather than about any
 * session. What individual sessions are doing lives in `sessions.svelte.ts`.
 */

/** Every harness the workbench can drive, in the order they are offered. */
export const HARNESSES: HarnessId[] = ["claude-code", "codex"];

/** What the window says of a harness, in one place: what it is called as a
    product and as the one speaking in a conversation, how the user signs
    in to it in a terminal, the variable that names its account's
    directory, whether it lists slash commands once ready, and whether its
    record of a conversation names the model each turn ran on. A run of a
    harness whose record does not goes under the harness's name, live or read
    back, so that a reload draws it under the same name. */
export interface HarnessProfile {
  product: string;
  name: string;
  signIn: string;
  configVar: string;
  commands: boolean;
  turnModels: boolean;
  /** Its models are shown by the names its own list gives them at run
      time, its ids being no names to read. */
  catalogNames: boolean;
  /** A session's row, its card, the status bar and the usage log name
      the model the harness says the session runs on: the one its own
      configuration names where none was chosen. A harness that does not
      has them name the model chosen for the session. */
  namesRunningModel: boolean;
  /** What sending waiting messages now does: interrupt the turn, after
      which the harness takes them all at once, or add them to the turn
      that runs without stopping it. */
  sendNow: "interrupts" | "steers";
}

const PROFILES: Record<HarnessId, HarnessProfile> = {
  "claude-code": {
    product: "Claude Code",
    name: "Claude",
    signIn: "claude",
    configVar: "CLAUDE_CONFIG_DIR",
    commands: true,
    turnModels: true,
    catalogNames: false,
    namesRunningModel: false,
    sendNow: "interrupts",
  },
  codex: {
    product: "Codex",
    name: "Codex",
    signIn: "codex login",
    configVar: "CODEX_HOME",
    commands: false,
    turnModels: false,
    catalogNames: true,
    namesRunningModel: true,
    sendNow: "steers",
  },
};

export function harnessProfile(id: HarnessId): HarnessProfile {
  return PROFILES[id];
}

export function harnessLabel(id: HarnessId): string {
  return PROFILES[id].product;
}

/** The short form for a tag beside a row. */
export function harnessTag(id: HarnessId): string {
  return id === "codex" ? "codex" : "claude";
}

export type Availability =
  | "unknown" // not every harness has been looked for yet
  | "detached" // no core behind the window
  | "missing" // no binary is on PATH
  | "ready";

export const harnesses = $state({
  availability: "unknown" as Availability,
  /** The harnesses whose binary was found, in `HARNESSES` order. */
  installed: [] as HarnessId[],
  /** The harnesses that have been looked for, found or not. */
  asked: [] as HarnessId[],
  /** Where each binary was found. */
  paths: {} as Partial<Record<HarnessId, string>>,
  /** The harnesses the core can drive in messages, as it said when asked. */
  integrable: [] as HarnessId[],
  /** False when the login shell could not be read, which changes what a
      missing binary means. */
  fromLoginShell: false,
  error: null as string | null,
});

export function applyDetect(report: DetectReport, hasCore: boolean) {
  const id = report.id as HarnessId;
  if (!harnesses.asked.includes(id)) harnesses.asked.push(id);
  harnesses.fromLoginShell = harnesses.fromLoginShell || report.fromLoginShell;
  harnesses.error = null;
  const integrable = report.caps?.integrated === true;
  if (integrable !== harnesses.integrable.includes(id))
    harnesses.integrable = integrable
      ? HARNESSES.filter((known) => known === id || harnesses.integrable.includes(known))
      : harnesses.integrable.filter((known) => known !== id);
  if (report.path !== null) {
    harnesses.paths[id] = report.path;
    if (!harnesses.installed.includes(id)) {
      harnesses.installed = HARNESSES.filter((known) => known === id || harnesses.installed.includes(known));
    }
  } else {
    delete harnesses.paths[id];
    harnesses.installed = harnesses.installed.filter((known) => known !== id);
  }
  settle(hasCore);
}

function settle(hasCore: boolean) {
  if (!hasCore) harnesses.availability = "detached";
  else if (harnesses.installed.length > 0) harnesses.availability = "ready";
  else if (HARNESSES.every((id) => harnesses.asked.includes(id))) harnesses.availability = "missing";
  else harnesses.availability = "unknown";
}

export function detectFailed(error: string) {
  harnesses.error = error;
  if (harnesses.installed.length === 0) harnesses.availability = "missing";
}

export function isReady(): boolean {
  return harnesses.availability === "ready";
}

export function isInstalled(id: HarnessId): boolean {
  return harnesses.installed.includes(id);
}

/** The harnesses that can be started, in the order they are offered. */
export function installed(): HarnessId[] {
  return harnesses.installed;
}

/** Why no harness can be started, or null when one can. */
export function unavailableReason(): string | null {
  switch (harnesses.availability) {
    case "unknown":
      return "Looking for Claude Code and Codex…";
    case "detached":
      return "Not connected to the workbench core.";
    case "missing":
      return (
        harnesses.error ??
        (harnesses.fromLoginShell
          ? "Neither claude nor codex was found on your PATH. Install Claude Code or Codex CLI, or check that it is on the PATH your login shell sets up."
          : "Neither claude nor codex was found, and your login shell could not be read, so the PATH searched may be incomplete.")
      );
    case "ready":
      return null;
  }
}

/** Test seam. */
export function resetHarnesses() {
  harnesses.availability = "unknown";
  harnesses.installed = [];
  harnesses.asked = [];
  harnesses.paths = {};
  harnesses.integrable = [];
  harnesses.fromLoginShell = false;
  harnesses.error = null;
}
