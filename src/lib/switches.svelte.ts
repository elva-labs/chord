/**
 * The two switches on the Sessions page: notes, and agents with their teams
 * and gates.
 *
 * Notes off, a session is not told to keep notes and its conversation is
 * always resumed whole. Agents off, nothing offers an agent, a team or a
 * gate, and a team's run already going on holds nothing until they are on
 * again. Off hides and stops; it deletes nothing, so turned on again
 * everything is as it was. Both are settings kept with the others for the
 * machine, on unless the user turns them off, and the user's alone to
 * change.
 */

import type { Settings } from "$lib/core";
import { persist } from "$lib/persist";

export const switches = $state({
  /** Whether sessions keep notes and go on from them. */
  notes: true,
  /** Whether agents, teams and gates are offered. */
  agents: true,
});

/** This part of the settings. */
export function switchesSettings(): Pick<Settings, "notesOn" | "agentsOn"> {
  return { notesOn: switches.notes, agentsOn: switches.agents };
}

/** Who is told when agents go on or off. */
const told: ((on: boolean) => void)[] = [];

/** `handler` is told each time agents are switched on or off. */
export function onAgentsSwitched(handler: (on: boolean) => void) {
  told.push(handler);
}

function agents(on: boolean) {
  if (switches.agents === on) return;
  switches.agents = on;
  for (const handler of told) handler(on);
}

/** Takes the core's word for the machine. Anything but false is on. */
export function adoptSwitches(notes: unknown, agentsOn: unknown) {
  switches.notes = notes !== false;
  agents(agentsOn !== false);
}

/** Sets whether sessions keep notes and go on from them. */
export function setNotesOn(on: boolean) {
  switches.notes = on;
  persist({ notesOn: on });
}

/** Sets whether agents, teams and gates are offered. */
export function setAgentsOn(on: boolean) {
  agents(on);
  persist({ agentsOn: on });
}

/** Test seam. */
export function resetSwitches() {
  switches.notes = true;
  switches.agents = true;
}
