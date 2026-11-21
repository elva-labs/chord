/**
 * Which starters have the sessions they started folded into dots on their
 * own row, kept by the starter's session id in the window's storage so the
 * pane looks the same after a restart. A starter with no id yet holds its
 * fold for the run only, by row key, and the fold does not carry over to the
 * id when it arrives. Only folded starters are kept, and only the
 * `MOST_KEPT` folded most recently.
 */

const KEY = "chord.foldedStarters";
/** How many folded starters the storage keeps. */
export const MOST_KEPT = 500;

export const startedFolds = $state({
  /** The ids of the folded starters, the one folded longest ago first. */
  ids: [] as string[],
  /** Starters with no id yet, by row key. */
  rows: {} as Record<string, boolean>,
});

/** Reads what was kept. Anything unreadable reads as nothing folded. */
export function loadStartedFolds() {
  startedFolds.ids = [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return;
    startedFolds.ids = stored
      .filter((id): id is string => typeof id === "string")
      .slice(-MOST_KEPT);
  } catch {
    // Nothing kept reads as every starter open.
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(startedFolds.ids));
  } catch {
    // Non-fatal: the folds hold for this run and start open next.
  }
}

/** Whether the starter, by its id when it has one, has its sessions folded. */
export function isStartedFolded(session: { key: string; id: string | null }): boolean {
  return session.id === null
    ? startedFolds.rows[session.key] === true
    : startedFolds.ids.includes(session.id);
}

/** Folds or opens a starter's sessions. */
export function setStartedFolded(session: { key: string; id: string | null }, folded: boolean) {
  if (session.id === null) {
    startedFolds.rows[session.key] = folded;
    return;
  }
  const rest = startedFolds.ids.filter((id) => id !== session.id);
  startedFolds.ids = folded ? [...rest, session.id].slice(-MOST_KEPT) : rest;
  save();
}

/** A starter that went on as a fresh conversation keeps its fold under the
    new id. */
export function moveStartedFold(from: string, to: string) {
  if (!startedFolds.ids.includes(from)) return;
  startedFolds.ids = [...startedFolds.ids.filter((id) => id !== from && id !== to), to].slice(
    -MOST_KEPT,
  );
  save();
}

/** Test seam. */
export function resetStartedFolds() {
  startedFolds.ids = [];
  startedFolds.rows = {};
}
