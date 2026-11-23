import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flash, resetFlash } from "$lib/flash.svelte";
import { SEQUENCE_TIMEOUT, type SequenceContext } from "$lib/keymap";
import { resetKeys } from "$lib/keys.svelte";
import { endSequence, pendingStep, sequenceKey } from "$lib/sequence";

const ctx: SequenceContext = { focus: "agent", reviewing: false, integrated: true, mac: true };
const ctrlX = { key: "x", ctrlKey: true };

beforeEach(() => {
  vi.useFakeTimers();
  resetKeys({ mac: true });
  resetFlash();
  endSequence();
});

afterEach(() => {
  endSequence();
  vi.useRealTimers();
});

describe("a sequence under way", () => {
  it("holds its first step in the status bar until the second key completes it", () => {
    expect(sequenceKey(ctrlX, ctx)).toBe("held");
    expect(pendingStep()?.key).toBe("x");
    expect(flash.held).toBe("⌃X, then…");
    expect(sequenceKey({ key: "s" }, ctx)).toBe("send.now");
    expect(pendingStep()).toBeNull();
    expect(flash.held).toBeNull();
  });

  it("ends by itself once the time is up, and the next key goes on as usual", () => {
    sequenceKey(ctrlX, ctx);
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 1);
    expect(pendingStep()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(pendingStep()).toBeNull();
    expect(flash.held).toBeNull();
    expect(sequenceKey({ key: "s" }, ctx)).toBeNull();
  });

  it("takes Escape and goes no further", () => {
    sequenceKey(ctrlX, ctx);
    expect(sequenceKey({ key: "Escape" }, ctx)).toBe("held");
    expect(pendingStep()).toBeNull();
    expect(sequenceKey({ key: "s" }, ctx)).toBeNull();
  });

  it("lets Escape through to a terminal, ending the wait", () => {
    sequenceKey(ctrlX, ctx);
    expect(sequenceKey({ key: "Escape" }, { ...ctx, terminal: true })).toBeNull();
    expect(pendingStep()).toBeNull();
  });

  it("lets a second key that completes nothing through", () => {
    sequenceKey(ctrlX, ctx);
    expect(sequenceKey({ key: "d" }, ctx)).toBeNull();
    expect(pendingStep()).toBeNull();
    expect(flash.held).toBeNull();
  });

  it("waits past a modifier pressed alone", () => {
    sequenceKey(ctrlX, ctx);
    expect(sequenceKey({ key: "Shift", shiftKey: true }, ctx)).toBeNull();
    expect(pendingStep()).not.toBeNull();
  });

  it("starts the clock again on a new first step", () => {
    sequenceKey(ctrlX, ctx);
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 100);
    sequenceKey({ key: "d" }, ctx);
    sequenceKey(ctrlX, ctx);
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT - 100);
    expect(pendingStep()).not.toBeNull();
  });
});
