import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followStrayKeys, isKeyName, withoutArrowControls } from "$lib/strayKeys";

describe("the character a navigation key is named by", () => {
  it("is exactly a control or a function key code point, alone", () => {
    for (const data of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0001", "\u007f", "\u0085", "", "", "", "", ""])
      expect(isKeyName(data)).toBe(true);
    for (const data of ["a", "\t", "\n", "", "", "", "", "\u001d\u001d", "a\u001d", ""])
      expect(isKeyName(data)).toBe(false);
  });

  it("is removed from sent text as the four arrow controls only", () => {
    expect(withoutArrowControls("a\u001cb\u001dc\u001ed\u001fe")).toBe("abcde");
    const kept = "a\fb\u000bc\u0085d\u001b[31mred\u001b[0m\u001b\t\n\r";
    expect(withoutArrowControls(kept)).toBe(kept);
  });
});

describe("the guard on typing", () => {
  let stop: () => void;

  beforeEach(() => {
    document.body.innerHTML = `<textarea id="t"></textarea><input id="i"><input id="p" type="password"><div class="xterm"><textarea id="x"></textarea></div><div class="cm-editor"><div id="c" contenteditable="true"></div></div>`;
    stop = followStrayKeys();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  const press = (id: string, key: string, options: KeyboardEventInit = {}) =>
    document.getElementById(id)!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));

  const insert = (id: string, data: string, inputType = "insertText") => {
    const event = new InputEvent("beforeinput", { data, inputType, bubbles: true, cancelable: true });
    document.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("refuses the insert that follows a navigation key, in a textarea and an input", () => {
    for (const id of ["t", "i", "p"])
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "F5", "F20"]) {
        press(id, key);
        expect(insert(id, "\u001d")).toBe(true);
        press(id, key);
        expect(insert(id, "")).toBe(true);
      }
  });

  it("allows Shift with the key, and no other modifier", () => {
    press("t", "ArrowRight", { shiftKey: true });
    expect(insert("t", "\u001d")).toBe(true);
    for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      press("t", "End", options);
      expect(insert("t", "\u001d")).toBe(false);
    }
  });

  it("refuses only the next insert, and nothing after another key or its release", () => {
    press("t", "End");
    expect(insert("t", "\u001d")).toBe(true);
    expect(insert("t", "\u001d")).toBe(false);
    press("t", "End");
    press("t", "a");
    expect(insert("t", "\u001d")).toBe(false);
    press("t", "End");
    document.getElementById("t")!.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
    expect(insert("t", "\u001d")).toBe(false);
  });

  it("never touches typed or pasted text of any other kind", () => {
    for (const data of ["a", "", "", "\f", "\u0085", "\u001b[31mred", "\u001d\u001d"]) {
      press("t", "ArrowRight");
      expect(insert("t", data)).toBe(data === "\f" || data === "\u0085");
    }
    for (const type of ["insertFromPaste", "insertFromDrop", "insertReplacementText", "insertCompositionText"]) {
      press("t", "ArrowRight");
      expect(insert("t", "\u001d", type)).toBe(false);
    }
    // No navigation key went down, so a form feed or NEL typed is left alone.
    expect(insert("t", "\f")).toBe(false);
    expect(insert("t", "\u0085")).toBe(false);
    expect(insert("t", "")).toBe(false);
  });

  it("leaves a terminal and a code editor alone", () => {
    for (const id of ["x", "c"]) {
      press(id, "ArrowRight");
      expect(insert(id, "\u001d")).toBe(false);
    }
  });
});
