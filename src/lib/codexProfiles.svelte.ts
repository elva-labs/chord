import { core, type CodexProfile } from "$lib/core";
import { dirFor } from "$lib/accounts.svelte";
import { hostOf } from "$lib/remote.svelte";

/**
 * Codex's profiles: the `<name>.config.toml` files in an account's Codex
 * home, any of which a new Codex session can run under, and the one last
 * picked in each project.
 *
 * The core reads the files on the project's machine. The window keeps the
 * list last heard for each account on each machine while it is open, and
 * reads it again as a new session is asked for, so a file added since is
 * offered. A session started before its account's list is heard starts
 * under none, as does one on a core that lists none.
 *
 * The profile last picked for a new session in each project, or no profile,
 * is the window's own memory, kept between runs on this machine. A new
 * Codex session there starts under it unless another is picked, where the
 * account still has it.
 */

const profiles = $state<{
  byKey: Record<string, CodexProfile[]>;
  /** The last pick in each project: a name, or null for no profile. */
  picked: Record<string, string | null>;
}>({ byKey: {}, picked: {} });

const PICKED_KEY = "chord.pickedProfiles";

/** A name as the core lists profiles by: led by a letter, digit or `_`. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Whether the text is a name a profile could go by. */
export function isProfileName(text: string): boolean {
  return NAME.test(text);
}

/** A list's key: the machine, empty for this one, and the account. */
function keyOf(project: string, account: string | null): string {
  return `${hostOf(project) ?? ""}\n${account ?? ""}`;
}

/** The profiles the account has on the project's machine, by name, as
    last heard. None until heard. */
export function profilesOf(project: string, account: string | null): CodexProfile[] {
  return profiles.byKey[keyOf(project, account)] ?? [];
}

/** The profile of that name the account has on the project's machine. */
export function profileOf(project: string, account: string | null, name: string): CodexProfile | null {
  return profilesOf(project, account).find((profile) => profile.name === name) ?? null;
}

function readable(profile: unknown): profile is CodexProfile {
  if (typeof profile !== "object" || profile === null) return false;
  const { name, model, effort, provider } = profile as Record<string, unknown>;
  const text = (value: unknown) => value === null || typeof value === "string";
  return typeof name === "string" && NAME.test(name) && text(model) && text(effort) && text(provider);
}

/** Reads the profiles the account has on the project's machine. A list
    that cannot be read is none. */
export async function readProfiles(project: string, account: string | null) {
  const key = keyOf(project, account);
  try {
    const listed: unknown = await core().codexProfiles(project, dirFor(account, "codex"));
    profiles.byKey[key] = Array.isArray(listed) ? listed.filter(readable) : [];
  } catch {
    // A core from before profiles, or a home it could not read.
    profiles.byKey[key] = [];
  }
}

/** The profile a new Codex session in the project starts under unless
    another is picked: the one picked there last, where the account has
    it. Null for none. */
export function profileToStart(project: string, account: string | null): string | null {
  const last = profiles.picked[project] ?? null;
  return last !== null && profileOf(project, account, last) !== null ? last : null;
}

/** Whether a profile, or no profile, was picked in the project before. */
export function pickedBefore(project: string): boolean {
  return profiles.picked[project] !== undefined;
}

/** Remembers the profile picked for a new session in a project, null for
    no profile. */
export function pickProfile(project: string, profile: string | null) {
  if (profile !== null && !NAME.test(profile)) return;
  if (profiles.picked[project] === profile) return;
  profiles.picked[project] = profile;
  try {
    localStorage.setItem(PICKED_KEY, JSON.stringify(profiles.picked));
  } catch {
    // Non-fatal: the pick does not survive a restart.
  }
}

/** The picks kept from the last run. One that does not read is dropped. */
export function loadPickedProfiles() {
  try {
    const raw = localStorage.getItem(PICKED_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const picked: Record<string, string | null> = {};
    for (const [project, profile] of Object.entries(stored))
      if (profile === null || (typeof profile === "string" && NAME.test(profile))) picked[project] = profile;
    profiles.picked = picked;
  } catch {
    // Nothing picked, then.
  }
}

/** Test seam. */
export function resetProfiles() {
  profiles.byKey = {};
  profiles.picked = {};
}
