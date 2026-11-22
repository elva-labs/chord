import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followStrayKeys, withoutStray } from "$lib/strayKeys";

describe("text no key should type", () => {
  it("keeps tabs and newlines and drops every other control", () => {
    expect(withoutStray("a\tb\nc")).toBe("a\tb\nc");
    expect(withoutStray("a\u001db\u001cc\u007fd\u0085e\u0000f")).toBe("abcdef");
    expect(withoutStray("a\r\nb\rc")).toBe("a\nb\nc");
    expect(withoutStray("xyz")).toBe("xyz");
  });
});

describe("the guard on typing", () => {
  let stop: () => void;

  beforeEach(() => {
    document.body.innerHTML = `<textarea id="t"></textarea><input id="i"><div class="xterm"><textarea id="x"></textarea></div>`;
    stop = followStrayKeys();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  const typed = (id: string, data: string) => {
    const event = new InputEvent("beforeinput", { data, inputType: "insertText", bubbles: true, cancelable: true });
    document.getElementById(id)!.dispatchEvent(event);
    return event;
  };

  it("refuses the character of an arrow, Home, End or function key in any field", () => {
    for (const id of ["t", "i"])
      for (const data of ["\u001d", "\u001c", "\u001e", "\u001f", "", "", ""])
        expect(typed(id, data).defaultPrevented).toBe(true);
  });

  it("lets ordinary text, and a terminal's own input, through", () => {
    expect(typed("t", "a").defaultPrevented).toBe(false);
    expect(typed("i", "å").defaultPrevented).toBe(false);
    expect(typed("x", "\u001d").defaultPrevented).toBe(false);
  });

  it("takes out a character that got in unasked, keeping the caret", () => {
    const field = document.getElementById("t") as HTMLTextAreaElement;
    field.value = "ab\u001dc";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field.value).toBe("abc");
    expect(field.selectionStart).toBe(2);
  });
});
