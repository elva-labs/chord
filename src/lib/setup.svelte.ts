/**
 * The core's checks of the machine, as the welcome and the Setup tab show
 * them. A read keeps the last answer in place while it runs, so nothing
 * jumps; reads asked for while one runs wait for it.
 */
import { core, type Setup } from "$lib/core";

export const setup = $state({
  /** The last answer, or null before the first one. */
  found: null as Setup | null,
  busy: false,
  error: null as string | null,
});

let reading: Promise<void> | null = null;

/** Reads the machine. Fresh reads the login shell again first, as Check
    again does; a fresh read asked for while another runs follows it. */
export function checkSetup(fresh = false): Promise<void> {
  if (reading) return fresh ? reading.then(() => checkSetup(true)) : reading;
  setup.busy = true;
  reading = core()
    .setupChecks(fresh)
    .then((found) => {
      setup.found = found;
      setup.error = null;
    })
    .catch((error) => {
      setup.error = String(error);
    })
    .finally(() => {
      setup.busy = false;
      reading = null;
    });
  return reading;
}
