// WebKit on macOS names the arrow, Home, End, Page and function keys with
// characters from the control range (U+001C to U+001F for the arrows) and
// from the private-use range (U+F700 to U+F8FF), and a text field can take
// one in as typed text. No key inserts such a character here: it is stopped
// where it would be typed, in every field, and cut from any text sent on.

const TERMINAL = ".xterm";

/** Every C0 control but tab and newline, DEL, the C1 controls and the
    private-use block the system keys are named in. */
// eslint-disable-next-line no-control-regex
const STRAY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f-]/g;

/** The text without a character no key should type. A carriage return
    that ends a line is a newline; every other control goes. */
export function withoutStray(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(STRAY, "");
}

/** Whether `text` holds a character a key must not type. */
export function hasStray(text: string): boolean {
  STRAY.lastIndex = 0;
  const found = STRAY.test(text);
  STRAY.lastIndex = 0;
  return found;
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TERMINAL) !== null;
}

/** A key's own character, refused before it is typed. */
function onBeforeInput(e: Event) {
  const event = e as InputEvent;
  if (!event.cancelable || event.data == null || event.data === "" || inTerminal(event.target)) return;
  if (event.inputType !== "insertText" && event.inputType !== "insertReplacementText") return;
  if (withoutStray(event.data) === "" && hasStray(event.data)) event.preventDefault();
}

/** A character that got in by a path that gave no chance to refuse it is
    taken out again, the caret kept where it was. */
function onInput(e: Event) {
  const field = e.target;
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) || inTerminal(field)) return;
  if (!hasStray(field.value)) return;
  const at = field.selectionStart;
  const kept = at === null ? null : withoutStray(field.value.slice(0, at)).length;
  field.value = withoutStray(field.value);
  if (kept !== null) field.setSelectionRange(kept, kept);
}

/** Starts the guard on the whole document; the returned function stops it. */
export function followStrayKeys(): () => void {
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("input", onInput, true);
  return () => {
    document.removeEventListener("beforeinput", onBeforeInput, true);
    document.removeEventListener("input", onInput, true);
  };
}
