/**
 * Word wrap in the editor: a long line breaks at the editor's edge instead
 * of running on past it.
 *
 * It is a setting kept with the others for the machine, off unless the user
 * turns it on, and one choice for every file. The window keeps a copy of
 * its own as well, read before the core has answered, so the first file
 * opens as the last one was drawn.
 */

import type { Settings } from "$lib/core";
import { persist } from "$lib/persist";

const KEY = "chord.wordWrap";

export const wrap = $state({
  /** Whether the editor wraps long lines. */
  on: false,
});

/** This part of the settings. */
export function wrapSettings(): Pick<Settings, "wordWrap"> {
  return { wordWrap: wrap.on };
}

function remember() {
  try {
    localStorage.setItem(KEY, wrap.on ? "on" : "off");
  } catch {
    // Non-fatal: the next start draws the default until the core answers.
  }
}

/** Reads the window's own copy, for the first frame. */
export function loadWrap() {
  try {
    wrap.on = localStorage.getItem(KEY) === "on";
  } catch {
    wrap.on = false;
  }
}

/** Takes the core's word for the machine. Anything but true is off. */
export function adoptWrap(value: unknown) {
  wrap.on = value === true;
  remember();
}

/** Turns wrapping on or off, at once. */
export function setWrap(on: boolean) {
  wrap.on = on;
  remember();
  persist({ wordWrap: on });
}

/** Wrapping the other way. */
export function toggleWrap() {
  setWrap(!wrap.on);
}

/** Test seam. */
export function resetWrap() {
  wrap.on = false;
}
