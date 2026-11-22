import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isProfileName,
  loadPickedProfiles,
  pickedBefore,
  pickProfile,
  profileOf,
  profilesOf,
  profileToStart,
  readProfiles,
  resetProfiles,
} from "$lib/codexProfiles.svelte";

/** What the core answers for the profiles, by the Codex home asked about. */
const listed = vi.hoisted(() => ({
  answer: (_dir: string | undefined): Promise<unknown> => Promise.resolve([]),
  asked: [] as (string | undefined)[],
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    codexProfiles: (_project: string, dir?: string) => {
      listed.asked.push(dir);
      return listed.answer(dir);
    },
  }),
}));

const A = "/home/ada/dev/one";
const LAB = "ssh://ada@lab/srv/one";
const KEY = "chord.pickedProfiles";
const fast = { name: "fast", model: "gpt-6.1-terra", effort: "low", provider: null };

beforeEach(() => {
  resetProfiles();
  localStorage.removeItem(KEY);
  listed.answer = () => Promise.resolve([]);
  listed.asked.length = 0;
});

describe("the Codex profiles an account has", () => {
  it("keeps those that read as profiles, by the machine they were read on", async () => {
    listed.answer = () =>
      Promise.resolve([
        fast,
        { name: "two words", model: null, effort: null, provider: null },
        { name: "../up", model: null, effort: null, provider: null },
        { name: "odd", model: 5, effort: null, provider: null },
        "local",
        null,
      ]);
    await readProfiles(A, null);
    expect(profilesOf(A, null)).toEqual([fast]);
    expect(profileOf(A, null, "fast")).toEqual(fast);
    expect(profilesOf(LAB, null)).toEqual([]);
    expect(profilesOf(A, "Work")).toEqual([]);
  });

  it("are none where the core cannot list them, an older one included", async () => {
    listed.answer = () => Promise.resolve([fast]);
    await readProfiles(A, null);
    listed.answer = () => Promise.reject(new Error("unknown command codex_profiles"));
    await readProfiles(A, null);
    expect(profilesOf(A, null)).toEqual([]);
    listed.answer = () => Promise.resolve({ fast });
    await readProfiles(A, null);
    expect(profilesOf(A, null)).toEqual([]);
  });

  it("go by names of letters, digits, dashes and underscores alone", () => {
    expect(isProfileName("fast_2-b")).toBe(true);
    for (const name of ["", "a b", "../a", "a.b", "a&b", "a%b", "x".repeat(65)]) expect(isProfileName(name)).toBe(false);
  });
});

describe("the profile a new session starts under", () => {
  it("is the one picked last in the project, while the account still has it", async () => {
    listed.answer = () => Promise.resolve([fast]);
    await readProfiles(A, null);
    expect(profileToStart(A, null)).toBeNull();
    expect(pickedBefore(A)).toBe(false);
    pickProfile(A, "fast");
    expect(profileToStart(A, null)).toBe("fast");
    expect(profileToStart(A, "Work")).toBeNull();
    listed.answer = () => Promise.resolve([]);
    await readProfiles(A, null);
    expect(profileToStart(A, null)).toBeNull();
    expect(pickedBefore(A)).toBe(true);
  });

  it("is kept between runs, no profile included, and a pick that does not read is dropped", () => {
    pickProfile(A, "fast");
    pickProfile(LAB, null);
    pickProfile("/elsewhere", "no good");
    resetProfiles();
    loadPickedProfiles();
    expect(pickedBefore(A)).toBe(true);
    expect(pickedBefore(LAB)).toBe(true);
    expect(pickedBefore("/elsewhere")).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ [A]: "../up", [LAB]: "fast" }));
    resetProfiles();
    loadPickedProfiles();
    expect(pickedBefore(A)).toBe(false);
    expect(pickedBefore(LAB)).toBe(true);
  });
});
