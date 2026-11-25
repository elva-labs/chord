import type { PaneId } from "$lib/layout.svelte";
import {
  actionOf,
  chordFor,
  chordFromEvent,
  describe,
  firstStepFromEvent,
  keys,
  sameChord,
  sameFirst,
  secondStepFromEvent,
  type ActionKey,
  type Chord,
  type SecondStep,
} from "$lib/keys.svelte";
import { isMac } from "$lib/platform";

export { isMac };

/**
 * The focus model, in one place.
 *
 * The agent pane owns the keyboard. Claude Code needs Ctrl+C, Ctrl+R, Esc and
 * Shift+Tab, so the app chrome claims only Cmd (or Ctrl on Windows/Linux)
 * chords and lets everything else through. Tab in particular is never a
 * focus-mover here: it is completion inside the TUI.
 *
 * The modifier is one key per platform, not either: on macOS every Ctrl chord
 * is the agent's, since Cmd is what the chrome answers to, and Ctrl+B or
 * Ctrl+E are readline to the TUI. On Windows and Linux there is only Ctrl,
 * and the bound chords are the ones the chrome takes.
 *
 * Escape is the one key whose meaning depends on where focus is, which is why
 * this function takes the context rather than leaving the caller to decide:
 * the whole model stays testable without a DOM. It belongs to whichever
 * terminal has focus, the agent's or a shell's, and to the chrome otherwise.
 *
 * The editor is a text field of the app's own, and keeps what a text field
 * needs while it has the keyboard: Escape, every chord on an arrow key,
 * which moves or selects there, and the viewer's chord, which selects the
 * next occurrence there. Find there is find in the file. Save is editor
 * mode's, from anywhere but a terminal, where on Windows and Linux the same
 * Ctrl chord is the process's. Close closes what is in front, from
 * anywhere on macOS; elsewhere a terminal keeps Ctrl+W and closes on the
 * chord with Shift added. A new untitled file is the app's from anywhere,
 * in either mode, but a terminal on Windows and Linux, where Ctrl+N is the
 * shell's next line of history.
 *
 * An integrated session has no terminal: its composer stops a running turn
 * on Escape and lets the key through when none runs, and then it closes the
 * viewer while reviewing, goes back to the editor in editor mode, and does
 * nothing else. Save and close are the app's from it, and find there is
 * find in the conversation.
 *
 * A sequence is a first step and a second key after it. Its first step may
 * be held with Ctrl on macOS too, as Ctrl+X is, since the chord alone is
 * still nothing the app takes: Ctrl+X does nothing until its second key
 * comes. A first step held with Ctrl, which is every first step off macOS,
 * begins nothing while a terminal has the keyboard, so the process gets it
 * as before. In a text field a first step that edits there does that and
 * begins nothing: see `editsThere`. After a first step the next key within
 * `SEQUENCE_TIMEOUT` completes the sequence, or ends it and goes where it
 * would have gone; Escape ends it and goes nowhere.
 */

export type Action =
  | { type: "focus"; pane: PaneId }
  | { type: "toggle"; pane: "sessions" | "changes" }
  | { type: "cycleTheme" }
  | { type: "toggleReview" }
  | { type: "toggleView" }
  | { type: "toggleScope" }
  | { type: "toggleTerminal" }
  /** Agent mode or editor mode: what takes the middle of the window. */
  | { type: "toggleMode" }
  /** A name field for a new file in the tree, in editor mode. */
  | { type: "newFile" }
  /** An untitled file in a new tab of the editor, from either mode. */
  | { type: "newUntitled" }
  /** The file in front in the editor written to disk. */
  | { type: "save" }
  /** Long lines in the editor broken at its edge, or not. */
  | { type: "toggleWrap" }
  /** What is in front closed: see `closeTarget`. */
  | { type: "close" }
  /** A new shell in the terminal panel, with the keyboard in it. */
  | { type: "newShell" }
  /** The keyboard to the status bar's first control. */
  | { type: "focusStatus" }
  /** Find in the file in the editor. */
  | { type: "findInFile" }
  /** Find in the conversation of an integrated session. */
  | { type: "findInThread" }
  /** The keyboard to the editor, from elsewhere in editor mode. */
  | { type: "toEditor" }
  | { type: "exitReview" }
  | { type: "openSettings" }
  /** The search field: narrowing the tree, or searching inside files. */
  | { type: "find"; mode: "files" | "lines" }
  /** Next or previous session, or shell when the terminal panel has focus. */
  | { type: "cycle"; direction: 1 | -1 }
  /** The palette that goes to a session or project, opened or put away. */
  | { type: "goto" }
  /** The command palette, opened or put away. */
  | { type: "palette" }
  /** The next session waiting on the user. */
  | { type: "attention" }
  /** The palette, ready to start a chat. */
  | { type: "newChat" }
  /** The terminal with the keyboard drawn a pixel larger, smaller, or at
      its default size. */
  | { type: "zoom"; step: 1 | -1 | 0 }
  /** The messages that wait in the integrated session in front, sent now. */
  | { type: "sendNow" };

export interface KeyState {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KeyContext {
  focus: PaneId;
  reviewing: boolean;
  /** The window is in editor mode. */
  editing?: boolean;
  /** The editor has the keyboard. */
  inEditor?: boolean;
  /** Whether the agent pane holds an integrated session, which has no
      terminal to own the keyboard. */
  integrated?: boolean;
  /** Whether Cmd is the modifier. Defaults to what the browser reports. */
  mac?: boolean;
}

const DEFAULT_CONTEXT: KeyContext = { focus: "agent", reviewing: false };

/** Panes that hold a pty, whose keys are the process's rather than the app's. */
function isTerminal(pane: PaneId): boolean {
  return pane === "agent" || pane === "terminal";
}

/** What each bound action does. The chords come from the keymap the user
    chose; this is the part that does not change. */
const ACTION_OF: Record<ActionKey, Action> = {
  "focus.sessions": { type: "focus", pane: "sessions" },
  "focus.agent": { type: "focus", pane: "agent" },
  "focus.changes": { type: "focus", pane: "changes" },
  "focus.terminal": { type: "focus", pane: "terminal" },
  "focus.status": { type: "focusStatus" },
  "toggle.sessions": { type: "toggle", pane: "sessions" },
  "toggle.changes": { type: "toggle", pane: "changes" },
  "toggle.terminal": { type: "toggleTerminal" },
  mode: { type: "toggleMode" },
  "session.next": { type: "cycle", direction: 1 },
  "session.previous": { type: "cycle", direction: -1 },
  "session.attention": { type: "attention" },
  "chat.new": { type: "newChat" },
  "send.now": { type: "sendNow" },
  "zoom.in": { type: "zoom", step: 1 },
  "zoom.out": { type: "zoom", step: -1 },
  "zoom.reset": { type: "zoom", step: 0 },
  goto: { type: "goto" },
  palette: { type: "palette" },
  review: { type: "toggleReview" },
  view: { type: "toggleView" },
  scope: { type: "toggleScope" },
  find: { type: "find", mode: "files" },
  findLines: { type: "find", mode: "lines" },
  "file.new": { type: "newFile" },
  "file.untitled": { type: "newUntitled" },
  "file.save": { type: "save" },
  "editor.wrap": { type: "toggleWrap" },
  "file.close": { type: "close" },
  "terminal.new": { type: "newShell" },
  theme: { type: "cycleTheme" },
  settings: { type: "openSettings" },
};

/** What a bound action does, for a caller that has the action rather than
    a key event: the palette. */
export function actionFor(key: ActionKey): Action {
  return ACTION_OF[key];
}

/** How long a sequence's first step waits for the second, in ms. */
export const SEQUENCE_TIMEOUT = 1500;

/** What the field a key goes to does with keys: a text field, the code
    editor, which cuts and copies the whole line with nothing selected, or
    nothing that takes text. */
export type Field = "text" | "code" | null;

export interface SequenceContext extends KeyContext {
  /** The field the key goes to. */
  field?: Field;
  /** Whether that field has text selected. */
  selection?: boolean;
  /** Whether the key goes to a terminal, whatever the pane in focus. */
  terminal?: boolean;
}

/** What a key does to sequences: begins one, completes one with an action,
    ends one on Escape, ends one and goes on where it would have gone (Escape
    in a terminal among them), or has nothing to do with them. */
export type SequenceStep =
  | { type: "begin"; first: Chord }
  | { type: "complete"; action: ActionKey }
  | { type: "cancel" }
  | { type: "end" }
  | null;

/** Cocoa's text keys with Ctrl, which a text field on macOS answers. */
const COCOA_CTRL = new Set(["a", "b", "d", "e", "f", "h", "k", "n", "o", "p", "t", "v", "y"]);

/** Whether a first step does something of its own in a field, so it does
    that rather than begin a sequence: a key that is not a character, select
    all, paste, undo and redo, cut and copy with something selected or in
    the code editor, and on macOS Ctrl with one of Cocoa's text keys. */
export function editsThere(first: Chord, field: Field, selection: boolean): boolean {
  if (field === null) return false;
  if (first.key.length > 1) return true;
  if (first.ctrl) return COCOA_CTRL.has(first.key);
  if (["a", "v", "z", "y"].includes(first.key)) return true;
  if (first.key === "x" || first.key === "c") return selection || field === "code";
  return false;
}

/** The action whose sequence is `first` then `second` exactly, if one is. */
function completes(table: typeof keys.bindings, first: Chord, second: SecondStep): ActionKey | null {
  for (const [action, chord] of Object.entries(table) as [ActionKey, Chord][]) {
    if (chord.then !== undefined && sameChord(chord, { ...first, then: second })) return action;
  }
  return null;
}

/**
 * What a key does to sequences, given the first step pressed before it, if
 * one waits. The caller keeps that first step, and drops it once
 * `SEQUENCE_TIMEOUT` passes.
 */
export function resolveSequence(
  e: KeyState,
  pending: Chord | null,
  ctx: SequenceContext = DEFAULT_CONTEXT,
): SequenceStep {
  const mac = ctx.mac ?? isMac();
  const table = keys.bindings;
  const terminal =
    ctx.terminal === true || (isTerminal(ctx.focus) && !(ctx.focus === "agent" && ctx.integrated));
  if (pending !== null) {
    if (e.key === "Escape") return terminal ? { type: "end" } : { type: "cancel" };
    const second = secondStepFromEvent(e, pending, mac);
    if (second === undefined) return null;
    if (second !== null) {
      const action = completes(table, pending, second);
      if (action !== null) return { type: "complete", action };
      // The first step's modifier held on through the second key, when no
      // sequence has that second step with it.
      if (second.modifier) {
        const plain = completes(table, pending, { key: second.key, shift: second.shift, alt: second.alt });
        if (plain !== null) return { type: "complete", action: plain };
      }
    }
    return { type: "end" };
  }
  const first = firstStepFromEvent(e, mac);
  if (first === null) return null;
  if (!Object.values(table).some((chord) => chord.then !== undefined && sameFirst(chord, first))) {
    return null;
  }
  if (terminal && (first.ctrl || !mac)) return null;
  if (editsThere(first, ctx.field ?? null, ctx.selection ?? false)) return null;
  return { type: "begin", first };
}

/** On a layout where = needs Shift, or + has a key of its own, Cmd+= arrives
    as + or Shift+=. Those read as the plain = when no chord holds them. */
function plainEquals(chord: Chord): Chord | null {
  if (chord.key === "+" || (chord.key === "=" && chord.shift)) {
    return { key: "=", shift: false, alt: chord.alt };
  }
  return null;
}

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mac = ctx.mac ?? isMac();
  const chord = chordFromEvent(e, mac);

  if (chord === null) {
    // Escape belongs to the agent whenever the agent has it. A pane that owns
    // focus may use it: the viewer closes on it, and a list pane hands the
    // keyboard back to where typing resumes, the agent, or the editor in
    // editor mode, which keeps its own Escape.
    if (e.key === "Escape" && !isTerminal(ctx.focus)) {
      if (ctx.editing) return ctx.inEditor ? null : { type: "toEditor" };
      return ctx.reviewing ? { type: "exitReview" } : { type: "focus", pane: "agent" };
    }
    // An integrated session's composer lets Escape through when no turn
    // runs: it closes the viewer while reviewing, and hands the keyboard
    // back to the editor in editor mode, as a list pane does there.
    if (e.key === "Escape" && ctx.focus === "agent" && ctx.integrated) {
      if (ctx.editing) return { type: "toEditor" };
      if (ctx.reviewing) return { type: "exitReview" };
    }
    return null;
  }

  if (ctx.inEditor && chord.key.startsWith("Arrow")) return null;

  let action = actionOf(chord);
  if (action === null) {
    const plain = plainEquals(chord);
    if (plain !== null) action = actionOf(plain);
  }
  if (action === null) {
    const also = closeAlso(mac);
    return also !== null && sameChord(chord, also) ? ACTION_OF["file.close"] : null;
  }
  // Filtering the tree is the changes pane's own: in a terminal the same
  // chord is the process's, Ctrl+F most of all. In the editor it finds in
  // the file, and in an integrated session's pane in its conversation.
  if (action === "find" && ctx.inEditor) return { type: "findInFile" };
  if (action === "find" && ctx.focus === "agent" && ctx.integrated) return { type: "findInThread" };
  if (action === "find" && isTerminal(ctx.focus)) return null;
  // The viewer's chord has no viewer to open in editor mode; in the editor
  // it is the editor's own.
  if (action === "review" && ctx.editing) return null;
  // Saving is editor mode's, from anywhere but a terminal: the tree, the
  // editor, and an integrated session's composer, which is a text field
  // with no use for it. A terminal keeps the chord: Ctrl+S is the
  // process's on Windows and Linux. On macOS the File menu answers what the
  // page lets through. Close is the app's from anywhere on macOS, where no
  // process has Cmd+W; elsewhere a terminal keeps Ctrl+W, which deletes a
  // word there, and `closeAlso` closes from it instead.
  const terminal = isTerminal(ctx.focus) && !(ctx.focus === "agent" && ctx.integrated);
  if (action === "file.save" && (!ctx.editing || terminal)) return null;
  if (action === "file.close" && !mac && terminal) return null;
  // Wrapping is the editor's: it has no meaning outside editor mode.
  if (action === "editor.wrap" && !ctx.editing) return null;
  // A new untitled file is the app's in either mode. On Windows and Linux
  // a terminal keeps Ctrl+N, its next line of history; on macOS Cmd is
  // never the terminal's.
  if (action === "file.untitled" && terminal && !mac) return null;
  return ACTION_OF[action];
}

/** Off macOS, the close chord with Shift added, which closes as well, from
    anywhere: it is the one a terminal lets through, as Ctrl+Shift+T opens a
    shell from one. None on macOS, where the close chord is never a
    process's, nor when the close chord has Shift already or another action
    holds the shifted one. */
export function closeAlso(mac: boolean = isMac()): Chord | null {
  if (mac) return null;
  const close = chordFor("file.close");
  if (close.shift) return null;
  const also = { ...close, shift: true };
  return actionOf(also) === null ? also : null;
}

/** What close acts on, the first of these that holds. */
export type CloseTarget =
  /** The palette, put away as Escape does. */
  | "palette"
  /** A dialog that holds the keyboard, closed as Escape does. */
  | "dialog"
  /** Nothing: a question in a strip holds the keyboard, and a second
      press neither answers it nor reaches past it. */
  | "nothing"
  /** The shell in front, with the keyboard in the terminal panel. */
  | "shell"
  /** The browser's tab in front, while the browser is shown. */
  | "browserTab"
  /** In editor mode, what took the editor's place: what the agent
      presented, or a plugin's page. */
  | "other"
  /** The editor's tab in front. */
  | "tab"
  /** The viewer, while reviewing. */
  | "viewer"
  /** The window, which asks first while sessions run or edits are
      unsaved. */
  | "window";

export interface CloseState {
  /** The palette is up. */
  palette: boolean;
  /** A dialog that holds the keyboard is up: the settings, the remote or
      resume lists, or an action's input. */
  dialog: boolean;
  /** A question in a strip has the keyboard. */
  question: boolean;
  focus: PaneId;
  editing: boolean;
  reviewing: boolean;
  /** The terminal panel has a shell in front. */
  shell: boolean;
  /** The editor has a tab in front. */
  tab: boolean;
  /** In editor mode, something other than a file takes the editor's
      place: what the agent presented, a plugin's page, or the browser. */
  other: boolean;
  /** The browser is what the viewer or the editor's place shows, with a
      tab in front. */
  browserTab: boolean;
}

/**
 * What close closes. It is the thing in front, wherever the keyboard is,
 * except that the terminal panel holding the keyboard puts its shell in
 * front. It never closes a session: a session is closed from its row,
 * which says what goes with it. Where nothing smaller is in front, it is
 * the window, and the window asks first while anything would be lost.
 */
export function closeTarget(state: CloseState): CloseTarget {
  if (state.palette) return "palette";
  if (state.dialog) return "dialog";
  if (state.question) return "nothing";
  if (state.focus === "terminal" && state.shell) return "shell";
  if (state.editing) {
    if (state.other) return state.browserTab ? "browserTab" : "other";
    return state.tab ? "tab" : "window";
  }
  if (state.reviewing) return state.browserTab ? "browserTab" : "viewer";
  return "window";
}

/** The close item's name in the File menu, for what it would close. */
export function closeLabel(target: CloseTarget): string {
  switch (target) {
    case "shell":
      return "Close Shell";
    case "tab":
    case "browserTab":
      return "Close Tab";
    case "viewer":
    case "other":
      return "Close Viewer";
    case "window":
      return "Close Window";
    default:
      return "Close";
  }
}

export interface Binding {
  keys: string;
  does: string;
  minor?: boolean;
}

/**
 * Human-readable bindings for the status bar, in the platform's own glyphs
 * and from the keymap as it is now. `minor` ones are dropped first when the
 * window is too narrow to show them all.
 */
export function bindingsFor(mac: boolean): Binding[] {
  const d = (action: ActionKey) => describe(chordFor(action), mac);
  return [
    { keys: d("goto"), does: "go to" },
    { keys: d("palette"), does: "commands" },
    {
      keys: `${d("focus.sessions")} ${d("focus.agent")} ${d("focus.changes")} ${d("focus.terminal")}`,
      does: "focus",
      minor: true,
    },
    { keys: d("toggle.sessions"), does: "sessions", minor: true },
    { keys: d("toggle.changes"), does: "changes", minor: true },
    { keys: d("toggle.terminal"), does: "terminal" },
    { keys: `${d("session.next")} ${d("session.previous")}`, does: "switch session" },
    { keys: d("review"), does: "review" },
    { keys: d("view"), does: "view" },
    { keys: d("scope"), does: "scope", minor: true },
    { keys: d("findLines"), does: "search", minor: true },
    { keys: d("settings"), does: "settings", minor: true },
  ];
}
