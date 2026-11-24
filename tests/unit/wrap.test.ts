import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { Settings } from "$lib/core";

const sets: Partial<Settings>[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change as Settings;
    },
  }),
}));

import { adoptWrap, loadWrap, resetWrap, setWrap, toggleWrap, wrap, wrapSettings } from "$lib/wrap.svelte";
import { resetPersist } from "$lib/persist";
import { stateFor, wrapChange, wrapping } from "$lib/codeEditor";
import { ACTIONS, PRESETS } from "$lib/keys.svelte";

beforeEach(() => {
  resetWrap();
  resetPersist();
  sets.length = 0;
  localStorage.removeItem("chord.wordWrap");
});

describe("the setting", () => {
  it("is off until turned on", () => {
    expect(wrap.on).toBe(false);
    expect(wrapSettings()).toEqual({ wordWrap: false });
  });

  it("is stored when set, and flipped by the toggle", () => {
    setWrap(true);
    expect(wrap.on).toBe(true);
    toggleWrap();
    expect(wrap.on).toBe(false);
  });

  it("adopts what the core holds, and an absent value is off", () => {
    adoptWrap(true);
    expect(wrap.on).toBe(true);
    adoptWrap(undefined);
    expect(wrap.on).toBe(false);
  });

  it("is remembered for the first frame of the next start", () => {
    setWrap(true);
    resetWrap();
    expect(wrap.on).toBe(false);
    loadWrap();
    expect(wrap.on).toBe(true);
  });
});

describe("the editor's state", () => {
  it("wraps once told to, and is left alone when already so", () => {
    const state = stateFor("a long line");
    expect(wrapChange(state, false)).toBeNull();
    const change = wrapChange(state, true);
    expect(change).not.toBeNull();
    const next = state.update(change!).state;
    expect(wrapping.get(next)).not.toBe(wrapping.get(state));
    expect(wrapChange(next, true)).toBeNull();
    expect(next.doc.toString()).toBe("a long line");
    expect(EditorState.create({}).doc.length).toBe(0);
  });
});

describe("the chord", () => {
  it("is listed with the editor's and bound in every preset", () => {
    expect(ACTIONS.find(({ key }) => key === "editor.wrap")?.group).toBe("Editor");
    for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[])
      expect(PRESETS[name]["editor.wrap"]).toMatchObject({ key: "z", alt: true });
  });
});
