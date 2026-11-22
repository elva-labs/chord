// WebKit on macOS can type the character a navigation key is named by into a
// field: a control character for an arrow (U+001C to U+001F) or a function
// key code point (U+F700 to U+F7FF). The guard acts only on a text insert
// that follows such a key going down, and only when the insert is one such
// character. Text that is pasted, dropped or typed with any other key is
// never touched, so the Apple logo (U+F8FF), icon-font glyphs and escape
// sequences in a paste arrive as they are.

/** Fields whose keys are their own: a terminal sends them to the program,
    and a code editor takes what it is given. */
const OWN_KEYS = ".xterm, .cm-editor";

/** The keys that move the caret or scroll, with no character of their own. */
const NAVIGATION = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|F([1-9]|1[0-9]|20))$/;

/** The four controls an arrow is named by. */
const ARROW_CONTROLS = /[\u001c-\u001f]/g;

/** The text without the controls an arrow is named by, nothing else. */
export function withoutArrowControls(text: string): string {
  return text.replace(ARROW_CONTROLS, "");
}

/** Whether `data` is the one character a navigation key can be typed as. */
export function isKeyName(data: string): boolean {
  const points = [...data];
  if (points.length !== 1) return false;
  const code = points[0].codePointAt(0)!;
  if (code === 0x09 || code === 0x0a) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xf700 && code <= 0xf7ff);
}

let armed = false;

function onKeyDown(e: KeyboardEvent) {
  armed = NAVIGATION.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function onKeyUp() {
  armed = false;
}

function onBeforeInput(e: Event) {
  const event = e as InputEvent;
  const was = armed;
  armed = false;
  if (!was || !event.cancelable || event.inputType !== "insertText" || event.data == null) return;
  if (event.target instanceof Element && event.target.closest(OWN_KEYS) !== null) return;
  if (isKeyName(event.data)) event.preventDefault();
}

/** Starts the guard on the whole document; the returned function stops it. */
export function followStrayKeys(): () => void {
  armed = false;
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
  };
}
