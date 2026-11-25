/**
 * The context, in tokens, at which a Claude Code session compacts its
 * conversation on its own: one figure for the user's own sessions and one
 * for the sessions other sessions start.
 *
 * Every turn reads the whole context, so a smaller one costs less per
 * turn. A started session's work seldom needs its oldest turns word for
 * word, so its sessions compact at 150,000 unless the user says otherwise;
 * the user's own keep the agent's default unless the user names a figure.
 * None leaves it to the agent. Both are settings kept with the others for
 * the machine, and the user's alone to change. A session takes the figure
 * when it starts or is resumed.
 */

import type { Settings } from "$lib/core";
import { persist } from "$lib/persist";

/** The fewest tokens a session compacts at: Claude Code takes no fewer. */
export const FEWEST_COMPACT_AT = 100_000;
/** The most tokens a session compacts at: the largest context a model
    holds. */
export const MOST_COMPACT_AT = 1_000_000;
/** Where a started session compacts unless the user says otherwise. */
export const STARTED_CONTEXT = 150_000;

export const compactAt = $state({
  /** Where the user's own sessions compact, or null for the agent's
      default. */
  own: null as number | null,
  /** Where a session another session started compacts, or null for the
      agent's default. */
  started: STARTED_CONTEXT as number | null,
});

/** Whether a figure is one a session may compact at. */
export function fitsCompactAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FEWEST_COMPACT_AT &&
    value <= MOST_COMPACT_AT
  );
}

/** This part of the settings. */
export function compactAtSettings(): Pick<Settings, "ownCompactAt" | "startedCompactAt"> {
  return { ownCompactAt: compactAt.own, startedCompactAt: compactAt.started };
}

/** Takes the core's word for the machine. A figure that does not fit is
    the default: none for the user's own, 150,000 for started ones, where
    null is the agent's default. */
export function adoptCompactAt(own: unknown, started: unknown) {
  compactAt.own = fitsCompactAt(own) ? own : null;
  compactAt.started = started === null ? null : fitsCompactAt(started) ? started : STARTED_CONTEXT;
}

/** Sets where the user's own sessions compact, from the next one started. */
export function setOwnCompactAt(tokens: number | null) {
  compactAt.own = tokens;
  persist({ ownCompactAt: tokens });
}

/** Sets where started sessions compact, from the next one started. */
export function setStartedCompactAt(tokens: number | null) {
  compactAt.started = tokens;
  persist({ startedCompactAt: tokens });
}

/** Test seam. */
export function resetCompactAt() {
  compactAt.own = null;
  compactAt.started = STARTED_CONTEXT;
}
