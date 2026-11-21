import { beforeEach, describe, expect, it } from "vitest";
import {
  isStartedFolded,
  loadStartedFolds,
  moveStartedFold,
  resetStartedFolds,
  setStartedFolded,
} from "$lib/startedFolds.svelte";

describe("the fold of a starter's sessions", () => {
  const starter = { key: "k1", id: "sid-1" };

  beforeEach(() => {
    localStorage.clear();
    resetStartedFolds();
  });

  it("keeps a starter folded across a restart, and open once it is opened again", () => {
    expect(isStartedFolded(starter)).toBe(false);
    setStartedFolded(starter, true);
    expect(isStartedFolded(starter)).toBe(true);

    // A restart starts with nothing in memory and reads what was kept.
    resetStartedFolds();
    expect(isStartedFolded({ key: "k2", id: "sid-1" })).toBe(false);
    loadStartedFolds();
    expect(isStartedFolded({ key: "k2", id: "sid-1" })).toBe(true);
    expect(isStartedFolded({ key: "k3", id: "sid-2" })).toBe(false);

    setStartedFolded(starter, false);
    resetStartedFolds();
    loadStartedFolds();
    expect(isStartedFolded(starter)).toBe(false);
  });

  it("holds the fold of a starter with no id for the run only", () => {
    const fresh = { key: "k9", id: null };
    setStartedFolded(fresh, true);
    expect(isStartedFolded(fresh)).toBe(true);
    expect(localStorage.getItem("chord.foldedStarters")).toBeNull();
  });

  it("reads kept folds leniently, and keeps the most recent ones", () => {
    localStorage.setItem("chord.foldedStarters", JSON.stringify(["a", 4, "b"]));
    loadStartedFolds();
    expect(isStartedFolded({ key: "x", id: "a" })).toBe(true);
    expect(isStartedFolded({ key: "y", id: "b" })).toBe(true);
    localStorage.setItem("chord.foldedStarters", "{broken");
    loadStartedFolds();
    expect(isStartedFolded({ key: "x", id: "a" })).toBe(false);
  });

  it("moves the fold to the new id when a starter goes on from its notes", () => {
    setStartedFolded(starter, true);
    moveStartedFold("sid-1", "sid-2");
    expect(isStartedFolded({ key: "k1", id: "sid-1" })).toBe(false);
    expect(isStartedFolded({ key: "k1", id: "sid-2" })).toBe(true);
    resetStartedFolds();
    loadStartedFolds();
    expect(isStartedFolded({ key: "k1", id: "sid-2" })).toBe(true);
  });

  it("leaves an open starter open when it goes on", () => {
    moveStartedFold("sid-1", "sid-2");
    expect(isStartedFolded({ key: "k1", id: "sid-2" })).toBe(false);
  });
});
