import { hold, letGo } from "$lib/flash.svelte";
import { describe, type ActionKey, type Chord } from "$lib/keys.svelte";
import {
  SEQUENCE_TIMEOUT,
  resolveSequence,
  type KeyState,
  type SequenceContext,
} from "$lib/keymap";

/**
 * The sequence under way: a first step pressed, waiting for its second key.
 * The status bar holds the first step's name until the sequence ends.
 */

let pending: Chord | null = null;
let hint: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The first step that waits for its second key, if one does. */
export function pendingStep(): Chord | null {
  return pending;
}

/** Ends the sequence under way, if one is. */
export function endSequence() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (hint !== null) letGo(hint);
  hint = null;
  pending = null;
}

/**
 * Takes a key for sequences. "held" when the key belongs to a sequence and
 * goes no further, the action when it completes one, and null when it goes
 * where it would have gone.
 */
export function sequenceKey(e: KeyState, ctx?: SequenceContext): ActionKey | "held" | null {
  const step = resolveSequence(e, pending, ctx);
  if (step === null) return null;
  switch (step.type) {
    case "begin":
      endSequence();
      pending = step.first;
      hint = `${describe(step.first, ctx?.mac)}, then…`;
      hold(hint);
      timer = setTimeout(endSequence, SEQUENCE_TIMEOUT);
      return "held";
    case "complete":
      endSequence();
      return step.action;
    case "cancel":
      endSequence();
      return "held";
    case "end":
      endSequence();
      return null;
  }
}
