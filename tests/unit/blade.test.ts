import { describe, expect, it } from "vitest";
import { BEAT, DONE, DURATION, arrived, blade, moved, risen, welcomeEnds } from "$lib/blade";

describe("blade", () => {
  it("starts from nothing and ends on the finished mark", () => {
    const first = blade(0);
    expect(first.opacity).toBe(0);
    expect(first.accent).toBe(0);
    expect(first.gapHeight).toBe(0);
    expect(blade(DURATION)).toBe(DONE);
    expect(blade(DURATION + 1000)).toBe(DONE);
  });

  it("shows the glint only while the cut travels", () => {
    expect(blade(400).glint).toBeNull();
    expect(blade(600).glint).not.toBeNull();
    expect(blade(800).glint).toBeNull();
  });

  it("runs the pink out from the cut once it is open", () => {
    expect(blade(790).accent).toBe(0);
    expect(blade(800).accent).toBe(1);
    expect(blade(1000).wipe).toBeGreaterThan(0);
    expect(blade(1000).wipe).toBeLessThan(1);
  });

  it("moves the mark up after the hold and brings the pieces in one after another", () => {
    expect(moved(0)).toBe(0);
    expect(moved(10_000)).toBe(1);
    expect(arrived(600, 0)).toBeGreaterThan(arrived(600, 1));
    expect(arrived(10_000, 4)).toBe(1);
  });

  it("leaves a piece that is in without a style", () => {
    expect(risen(1)).toBe("");
    expect(risen(0)).toBe("opacity: 0; transform: translateY(12px)");
  });

  it("ends the welcome's motion after the beat, the mark and the last piece", () => {
    const end = welcomeEnds(5);
    expect(end).toBeGreaterThan(BEAT + DURATION);
    expect(arrived(end - BEAT - DURATION, 4)).toBe(1);
  });
});
