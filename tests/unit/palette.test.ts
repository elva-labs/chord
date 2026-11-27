import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attention } from "$lib/attention.svelte";
import { chordFor, describe as spell, resetKeys } from "$lib/keys.svelte";
import {
  ATTENTION_LABEL,
  askingChat,
  beginChat,
  closePalette,
  commandItems,
  goToItems,
  lastUsed,
  beginNew,
  defaultsAskAs,
  defaultsFor,
  nextStep,
  openCommands,
  openGoTo,
  openPalette,
  palette,
  paletteItems,
  pickable,
  pickItem,
  resetPalette,
  setQuery,
  since,
  startingId,
  stepBack,
  stepItems,
  stepsLeft,
  type PaletteItem,
} from "$lib/palette.svelte";
import { canPreview, effectiveView, files, matches, select as selectFile } from "$lib/files.svelte";
import { browser } from "$lib/browser.svelte";
import { layout } from "$lib/layout.svelte";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { harnesses } from "$lib/harness.svelte";
import { create, exact, reset, select, sessions, started } from "$lib/sessions.svelte";
import { activate, bringForward, onScreen, reset as resetWorkspace, startSession, workspace } from "$lib/workspace.svelte";
import { projects, resetProjects } from "$lib/projects.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import "$lib/orchestrator.svelte";
import { resetFolder } from "$lib/orchestratorFolder.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";
import { resetSwitches, switches } from "$lib/switches.svelte";
import { pickProfile, profileToStart, readProfiles, resetProfiles } from "$lib/codexProfiles.svelte";
import { paletteChanged, resetPluginPalette } from "$lib/pluginPalette.svelte";
import { flash } from "$lib/flash.svelte";
import { resetChats } from "$lib/chats.svelte";
import { resetSessionKinds, sessionKinds } from "$lib/sessionKind.svelte";
import { agents } from "$lib/agents.svelte";
import { reset as resetTeams, teams } from "$lib/teams.svelte";
import {
  agentOfRow,
  agentPickedIn,
  agentStartsAt,
  agentWaits,
  forgetAgentRow,
  pickAgentIn,
  resetPickedAgents,
} from "$lib/sessionAgents.svelte";

/** The Codex profiles the core lists, for any account. */
const listed = vi.hoisted(() => ({ profiles: [] as unknown[] }));
/** The plugin commands picked, and what the core says to the next pick. */
const picks = vi.hoisted(() => ({ made: [] as unknown[], refuse: null as string | null }));

vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async () => {},
    setBadge: async () => {},
    setWindowTitle: async () => {},
    codexProfiles: async () => listed.profiles,
    pluginPalettePick: async (request: unknown) => {
      picks.made.push(request);
      if (picks.refuse !== null) throw picks.refuse;
    },
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";
const C = "/home/ada/dev/three";

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

const sessionKeys = (items: PaletteItem[]) =>
  items.flatMap((item) => (item.kind === "session" ? [item.session.key] : []));
const projectPaths = (items: PaletteItem[]) =>
  items.flatMap((item) => (item.kind === "project" ? [item.path] : []));

beforeEach(() => {
  reset();
  resetWorkspace();
  resetProjects();
  resetConductor();
  resetKeys();
  resetPalette();
  resetAccounts();
  resetProfiles();
  resetChats();
  listed.profiles = [];
  resetPluginPalette();
  picks.made = [];
  picks.refuse = null;
  // No workflows unless a test has some.
  resetWorkflows();
  resetSwitches();
  harnesses.availability = "ready";
  harnesses.installed = ["claude-code"];
  harnesses.integrable = [];
  attention.focused = true;
  workspace.open.push(repo(A), repo(B), repo(C));
});

describe("matching", () => {
  it("takes every word, in any order and any case", () => {
    expect(matches("Show or hide the terminal", "TERM hide")).toBe(true);
    expect(matches("Show or hide the terminal", "term shell")).toBe(false);
    expect(matches("anything", "   ")).toBe(true);
  });
});

describe("opening", () => {
  it("opens go to and commands with an empty field", () => {
    palette.query = "left over";
    openGoTo();
    expect(palette).toMatchObject({ open: true, mode: "goto", query: "" });
    palette.query = "left over";
    openCommands();
    expect(palette).toMatchObject({ open: true, mode: "commands", query: "" });
  });

  it("keeps openPalette working as the commands palette", () => {
    openPalette();
    expect(palette).toMatchObject({ open: true, mode: "commands" });
    closePalette();
    expect(palette.open).toBe(false);
  });

  it("switches to commands on a > typed first, keeping the rest", () => {
    openGoTo();
    setQuery("po");
    expect(palette).toMatchObject({ mode: "goto", query: "po" });
    setQuery(">");
    expect(palette).toMatchObject({ mode: "commands", query: "" });
    openGoTo();
    setQuery(">zoom in");
    expect(palette).toMatchObject({ mode: "commands", query: "zoom in" });
  });

  it("does not read a > later in the text, or in commands, as a switch", () => {
    openGoTo();
    setQuery("a>b");
    expect(palette).toMatchObject({ mode: "goto", query: "a>b" });
    openCommands();
    setQuery(">x");
    expect(palette).toMatchObject({ mode: "commands", query: ">x" });
  });
});

describe("go to", () => {
  it("lists the sessions, then the projects", () => {
    create(A);
    create(B);
    const items = goToItems("");
    expect(items.map((item) => item.kind)).toEqual([
      "session",
      "session",
      "project",
      "project",
      "project",
    ]);
  });

  it("orders the sessions by their latest change, and not by their status", () => {
    attention.focused = false;
    const old = create(A);
    const waiting = create(B);
    const newest = create(C);
    old.changedAt = 3000;
    waiting.changedAt = 1000;
    newest.changedAt = 2000;
    // The one that needs you is the oldest change, and stays last.
    started(waiting.key, "pty-2", "session-pty-2");
    exact("session-pty-2", "stop");
    waiting.changedAt = 1000;
    expect(sessionKeys(goToItems(""))).toEqual([old.key, newest.key, waiting.key]);
  });

  it("matches a session on its name or its project, every word", () => {
    const first = create(A);
    const second = create(B);
    first.changedAt = 1000;
    second.changedAt = 2000;
    first.title = "Fix the cache";
    second.title = "Fix the parser";
    const keys = (query: string) => sessionKeys(goToItems(query));
    expect(keys("fix")).toEqual([second.key, first.key]);
    expect(keys("cache")).toEqual([first.key]);
    expect(keys("two")).toEqual([second.key]);
    expect(keys("fix one")).toEqual([first.key]);
    expect(keys("cache two")).toEqual([]);
  });

  it("matches a session by the label of its project, with the path above it when two share a name", () => {
    workspace.open.push(repo("/work/main"), repo("/spike/main"));
    const work = create("/work/main");
    create("/spike/main");
    expect(sessionKeys(goToItems("work/main"))).toEqual([work.key]);
  });

  it("narrows the projects by their label, inactive ones included", () => {
    create(A);
    expect(projectPaths(goToItems("tw"))).toEqual([B]);
    expect(projectPaths(goToItems("ada"))).toEqual([]);
  });

  it("matches the Open project row against what is typed when nothing is open", () => {
    resetWorkspace();
    reset();
    expect(goToItems("").map((item) => item.label)).toEqual(["Open project"]);
    expect(goToItems("open").map((item) => item.label)).toEqual(["Open project"]);
    expect(goToItems("zzz")).toEqual([]);
  });

  it("gives a session its project and the time of its change", () => {
    const own = create(A);
    own.changedAt = Date.now() - 3 * 60_000;
    const item = goToItems("").find((candidate) => candidate.kind === "session");
    expect(item).toMatchObject({ project: "one", when: "3m", group: "Sessions" });
  });

  it("gives a project its live sessions, else when it was last used", () => {
    create(A);
    const quiet = create(B);
    quiet.status = "dormant";
    quiet.changedAt = Date.now() - 2 * 86_400_000 - 60_000;
    const end = (path: string) =>
      goToItems("").find((item) => item.kind === "project" && item.path === path);
    expect(end(A)).toMatchObject({ end: "1 live", group: "Projects" });
    expect(end(B)).toMatchObject({ end: "2d" });
    expect(end(C)).toMatchObject({ end: "" });
  });

  it("lists the projects by when they were last used", () => {
    const one = create(A);
    const two = create(B);
    one.changedAt = 1000;
    two.changedAt = 5000;
    expect(projectPaths(goToItems(""))).toEqual([B, A, C]);
  });

  it("counts a past session as use of its project", () => {
    sessions.history[C] = [
      { id: "t", modified: 4000, size: 1, title: null, agent: "claude-code", account: null },
    ];
    expect(lastUsed(C)).toBe(4_000_000);
    expect(lastUsed(A)).toBeNull();
    expect(projectPaths(goToItems(""))[0]).toBe(C);
  });

  it("keeps ids unique", () => {
    create(A);
    create(B);
    const ids = goToItems("").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists what the palette is showing", () => {
    create(A);
    openGoTo();
    expect(paletteItems().some((item) => item.kind === "session")).toBe(true);
    openCommands();
    expect(paletteItems().some((item) => item.kind === "session")).toBe(false);
  });
});

describe("chats in go to", () => {
  const CHATS = "/home/ada/.chord/chats";
  const groups = (items: PaletteItem[]) => items.map((item) => `${item.kind}:${item.group}`);

  beforeEach(() => {
    resetChats(CHATS);
    create(A).changedAt = 3000;
    const open = create(CHATS);
    open.changedAt = 2500;
    open.title = "Plan the export rework";
    sessions.history[CHATS] = [
      { id: "old", modified: 2, size: 1, title: "Invoice export formats", agent: "claude-code", account: null },
    ];
  });

  it("stand in a group of their own between the sessions and the projects, past chats too", () => {
    expect(groups(goToItems(""))).toEqual([
      "session:Sessions",
      "session:Chats",
      "past:Chats",
      "project:Projects",
      "project:Projects",
      "project:Projects",
    ]);
    const [open, past] = goToItems("").filter((item) => item.group === "Chats");
    expect(open).toMatchObject({ label: "Plan the export rework", project: "chat" });
    expect(past).toMatchObject({ label: "Invoice export formats" });
    expect(projectPaths(goToItems(""))).not.toContain(CHATS);
  });

  it("match on their name, and all of them on the word chat", () => {
    expect(goToItems("export").map((item) => item.label)).toEqual([
      "Plan the export rework",
      "Invoice export formats",
    ]);
    expect(goToItems("chat").filter((item) => item.group !== "Chats")).toEqual([]);
    expect(goToItems("chat")).toHaveLength(2);
  });

  it("resume a past chat in front when picked, not as a project", () => {
    const past = goToItems("formats")[0];
    const outcome = pickItem(past);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all.find((session) => session.resumedFrom === "old")).toMatchObject({ project: CHATS });
    expect(workspace.active).toBe(CHATS);
    expect(workspace.open.map(({ path }) => path)).not.toContain(CHATS);
  });

  it("start a new chat on a chat held alone", () => {
    expect(pickItem(goToItems("formats")[0], true)).toEqual({ type: "stay" });
    expect(palette.mode).toBe("new");
    expect(palette.steps).toEqual([{ kind: "project", path: CHATS }]);
  });
});

describe("where go to starts", () => {
  it("puts the cursor on the first session that is not the one on screen", () => {
    const first = create(A);
    const second = create(B);
    first.changedAt = 1_000;
    second.changedAt = 2_000;
    select(second.key);
    expect(goToItems("")[0]).toMatchObject({ id: `session:${second.key}` });
    openGoTo();
    expect(startingId()).toBe(`session:${first.key}`);
  });

  it("starts on the first entry when the only session is the one on screen, and when typing", () => {
    create(A);
    openGoTo();
    expect(startingId()).toBeNull();
    create(B);
    setQuery("session");
    expect(startingId()).toBeNull();
  });

  it("offers to open a project when nothing is open, and nothing when a query matches nothing", () => {
    workspace.open.length = 0;
    expect(goToItems("").map((item) => item.id)).toEqual(["command:open"]);
    expect(pickable(goToItems("")[0])).toBe(true);
    expect(goToItems("x")).toEqual([]);
  });
});

describe("what picking does in go to", () => {
  it("brings a session forward and gives it the keyboard once the palette is away", () => {
    const first = create(A);
    create(B);
    const item = goToItems("").find(
      (candidate) => candidate.kind === "session" && candidate.session.key === first.key,
    )!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.active).toBe(first.key);
    expect(workspace.active).toBe(A);
  });

  it("gives the keyboard to the sessions pane for a project with no session", async () => {
    const { layout } = await import("$lib/layout.svelte");
    create(A);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    await tick();
    expect(workspace.active).toBe(B);
    expect(sessions.active).toBeNull();
    expect(layout.focus).toBe("sessions");
  });

  it("leaves the sessions pane alone in a window too narrow for it", async () => {
    const { layout } = await import("$lib/layout.svelte");
    layout.sessionsChosen = false;
    layout.sessionsForced = true;
    layout.mode = "working";
    create(A);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    await tick();
    expect(layout.sessionsChosen).toBe(false);
    expect(layout.focus).toBe("agent");
    layout.sessionsForced = false;
    layout.sessionsChosen = true;
  });

  it("keeps the session on screen when its project is picked", () => {
    const first = create(A);
    create(A);
    select(first.key);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === A)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    expect(sessions.active).toBe(first.key);
  });

  it("brings a project forward with no session, its unread one still unread", () => {
    const waiting = create(B);
    waiting.unread = true;
    select(create(A).key);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(workspace.active).toBe(B);
    expect(sessions.active).toBeNull();
    expect(waiting.unread).toBe(true);
  });

  // A project whose only session hangs under a starter in another project
  // has none drawn under it: go to counts none live there, and picking it
  // shows it with no session, as the project on screen, rather than that
  // session, which would put the starter's project on screen instead.
  it("shows a project whose only session hangs elsewhere with none", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = starter.token;
    activate(A);
    sessions.active = starter.key;
    const row = (path: string) =>
      goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === path)!;
    expect(row(A)).toMatchObject({ end: "2 live" });
    expect(row(C)).toMatchObject({ end: "now" });

    const outcome = pickItem(row(C));
    if (outcome.type === "close") outcome.then();
    expect(workspace.active).toBe(C);
    expect(sessions.active).toBeNull();
    expect(onScreen()).toBe(C);
    expect(Date.now() - projects.used[C]).toBeLessThan(1000);

    // Nor is a session of its own drawn under it opened.
    const own = create(C);
    started(own.key, "pty-3", "own-1");
    activate(A);
    const again = pickItem(row(C));
    if (again.type === "close") again.then();
    expect(sessions.active).toBeNull();
  });

  // The session on screen hangs under its starter's project from another
  // one: bringing the starter's project forward counts it as used and
  // leaves the session and the project in front as they are.
  it("keeps a started session on screen when its starter's project is brought forward", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = starter.token;
    activate(C);
    sessions.active = kid.key;
    expect(onScreen()).toBe(A);

    bringForward(A);
    expect(sessions.active).toBe(kid.key);
    expect(workspace.active).toBe(C);
    expect(onScreen()).toBe(A);
    expect(Date.now() - projects.used[A]).toBeLessThan(1000);
  });

  // A project picked is the user using it, as a session picked is.
  it("counts a project picked as used, the one in front too", () => {
    workspace.active = A;
    for (const path of [B, A]) {
      const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === path)!;
      const outcome = pickItem(item);
      if (outcome.type === "close") outcome.then();
      expect(Date.now() - projects.used[path]).toBeLessThan(1000);
    }
    expect(projects.used[C]).toBeUndefined();
  });
});

describe("commands", () => {
  it("is the jump first, then the commands without a chord, then the actions", () => {
    const items = commandItems("");
    expect(items[0]).toMatchObject({ kind: "attention", label: ATTENTION_LABEL });
    expect(items.slice(1, 6).map((item) => item.label)).toEqual([
      "New session",
      "Open project",
      "Open remote project",
      "Check setup",
      "Show welcome",
    ]);
    expect(items.slice(6).every((item) => item.kind === "action")).toBe(true);
  });

  it("offers a new session in the project on screen only while one is", () => {
    expect(commandItems("new session").map((item) => item.label)).toEqual(["New session"]);
    workspace.active = B;
    expect(commandItems("new session").map((item) => item.label)).toEqual([
      "New session",
      "New session in two",
    ]);
    workspace.open = [];
    workspace.active = null;
    expect(commandItems("new session")).toEqual([]);
  });

  it("does not offer a new session while no agent is ready", () => {
    harnesses.availability = "missing";
    const item = commandItems("new session")[0];
    expect(pickable(item)).toBe(false);
    expect(pickItem(item)).toEqual({ type: "stay" });
  });

  it("has every action that has a chord, but not the palette itself or the jump's own", () => {
    const actions = commandItems("").flatMap((item) => (item.kind === "action" ? [item.action] : []));
    expect(actions).not.toContain("palette");
    expect(actions).not.toContain("session.attention");
    expect(actions).toContain("goto");
    expect(actions).toContain("settings");
    expect(actions).toContain("zoom.in");
  });

  it("narrows by the words of the label", () => {
    expect(commandItems("terminal zoom").map((item) => item.label)).toEqual([
      "Zoom the terminal in",
      "Zoom the terminal out",
      "Reset the terminal's zoom",
    ]);
    expect(commandItems("remote").map((item) => item.label)).toEqual(["Open remote project"]);
  });

  it("shows each action's chord", () => {
    const item = commandItems("open settings").find((candidate) => candidate.kind === "action");
    expect(item?.kind === "action" && item.chord).toBe(spell(chordFor("settings")));
  });

  it("does not list sessions", () => {
    create(A);
    expect(commandItems("").some((item) => item.kind === "session")).toBe(false);
  });

  it("does not match the jump to a word it has none of, and keeps ids unique", () => {
    expect(commandItems("zoom").some((item) => item.kind === "attention")).toBe(false);
    const ids = commandItems("").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts the sessions waiting on the user", () => {
    attention.focused = false;
    const first = create(A);
    started(first.key, "pty-1", "session-pty-1");
    exact("session-pty-1", "stop");
    create(B);
    expect(commandItems("")[0]).toMatchObject({ kind: "attention", waiting: 1 });
    select(first.key);
    expect(commandItems("")[0]).toMatchObject({ kind: "attention", waiting: 0 });
  });

  it("does nothing when the jump has nothing waiting", () => {
    expect(pickItem(commandItems("")[0])).toEqual({ type: "stay" });
  });

  it("hands an action to the page, and the jump too", () => {
    attention.focused = false;
    const first = create(A);
    started(first.key, "pty-1", "session-pty-1");
    exact("session-pty-1", "stop");
    create(B);
    expect(pickItem(commandItems("")[0])).toEqual({ type: "perform", action: { type: "attention" } });
    const zoom = commandItems("zoom in")[0];
    expect(pickItem(zoom)).toEqual({ type: "perform", action: { type: "zoom", step: 1 } });
    expect(pickItem(commandItems("go to")[0])).toEqual({ type: "perform", action: { type: "goto" } });
  });
});

describe("plugins' commands", () => {
  const overview = (project = A, labels = ["Pull request overview"]) =>
    paletteChanged({
      source: "src-1",
      plugin: "github",
      project,
      commands: labels.map((label, at) => ({ id: `c${at}`, label })),
    });
  const plugged = (query: string) =>
    commandItems(query).flatMap((item) => (item.kind === "plugin" ? [item] : []));

  it("lists the project on screen's after the app's, with the plugin's name", () => {
    overview();
    overview(B, ["Something else"]);
    workspace.active = A;
    const items = commandItems("");
    expect(items.at(-1)).toMatchObject({ kind: "plugin", label: "Pull request overview", detail: "github" });
    expect(items.slice(0, -1).every((item) => item.kind !== "plugin")).toBe(true);
    workspace.active = B;
    expect(plugged("").map((item) => item.label)).toEqual(["Something else"]);
  });

  it("lists none while no project is on screen", () => {
    overview();
    workspace.active = null;
    expect(plugged("")).toEqual([]);
  });

  it("matches on the label and on the plugin's name", () => {
    overview();
    workspace.active = A;
    expect(plugged("pul").map((item) => item.label)).toEqual(["Pull request overview"]);
    expect(plugged("github").map((item) => item.label)).toEqual(["Pull request overview"]);
    expect(plugged("overview git").map((item) => item.label)).toEqual(["Pull request overview"]);
    expect(plugged("checks")).toEqual([]);
  });

  it("leaves out a label that reads as one of the app's commands", () => {
    overview(A, ["Open settings", "open project", "Show source", "New session in api", "New session", "Pull requests"]);
    workspace.active = A;
    expect(plugged("").map((item) => item.label)).toEqual(["Pull requests"]);
  });

  it("leaves out one offered only at other times, and one spaced apart", () => {
    overview(A, [
      "Turn word wrap on",
      "Go back to an earlier message",
      "Preview  file",
      "New  session",
      "New session\tin api",
      "Newsletter",
    ]);
    workspace.active = A;
    expect(plugged("").map((item) => item.label)).toEqual(["Newsletter"]);
  });

  it("goes when the plugin sends an empty list", () => {
    overview();
    workspace.active = A;
    paletteChanged({ source: "src-1", plugin: "github", project: A, commands: [] });
    expect(plugged("")).toEqual([]);
  });

  it("tells the plugin of a pick once the palette is away, with the session on screen", async () => {
    overview();
    const session = create(A);
    select(session.key);
    workspace.active = A;
    const outcome = pickItem(plugged("pul")[0]);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") await outcome.then();
    await tick();
    expect(picks.made).toEqual([
      { source: "src-1", plugin: "github", command: "c0", project: A, session: session.token },
    ]);
  });

  it("says in the status bar what the core refused", async () => {
    overview();
    workspace.active = A;
    picks.refuse = "the github plugin is not running";
    const outcome = pickItem(plugged("pul")[0]);
    if (outcome.type === "close") outcome.then();
    await tick();
    await tick();
    expect(picks.made).toHaveLength(1);
    expect(flash.text).toBe("Pull request overview: the github plugin is not running");
  });
});

describe("previewing the file in the viewer", () => {
  const open = (path: string, status: string | null = "M") => {
    files.scope = "all";
    files.everything = [{ path, status }];
    files.selected = path;
    files.view = "diff";
    files.renderedFor = null;
    layout.mode = "reviewing";
  };
  const labels = (query: string) => goToItems(query).map((item) => item.label);

  beforeEach(() => {
    files.media = null;
    files.pluginView = null;
  });

  it.each(["notes.md", "page.html", "flow.mmd", "logo.svg"])(
    "offers Preview file for %s, in go to once something is typed and in the commands",
    (path) => {
      open(path);
      expect(canPreview({ path, status: "M" })).toBe(true);
      expect(labels("preview")).toEqual(["Preview file"]);
      expect(labels("")).not.toContain("Preview file");
      expect(commandItems("preview").map((item) => item.label)).toEqual(["Preview file"]);
    },
  );

  it("is not offered for a file the app cannot render, a deleted one, or with no viewer", () => {
    open("main.rs");
    expect(labels("preview")).toEqual([]);
    expect(commandItems("preview")).toEqual([]);
    open("gone.md", "D");
    expect(labels("preview")).toEqual([]);
    open("page.html");
    layout.mode = "working";
    expect(labels("preview")).toEqual([]);
    layout.mode = "editing";
    expect(commandItems("preview")).toEqual([]);
  });

  it("previews the file, then shows its source again", () => {
    open("page.html");
    const preview = goToItems("preview")[0];
    const outcome = pickItem(preview);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(effectiveView()).toBe("rendered");
    expect(labels("source")).toEqual(["Show source"]);
    expect(labels("preview")).toEqual([]);
    const back = pickItem(goToItems("source")[0]);
    if (back.type === "close") back.then();
    expect(effectiveView()).toBe("content");
  });

  it("shows source for another HTML file, and for the same file reopened", async () => {
    open("page.html");
    files.everything = [
      { path: "page.html", status: "M" },
      { path: "other.html", status: "M" },
    ];
    const outcome = pickItem(goToItems("preview")[0]);
    if (outcome.type === "close") outcome.then();
    expect(effectiveView()).toBe("rendered");
    await selectFile("other.html");
    expect(effectiveView()).toBe("diff");
    await selectFile("page.html");
    expect(effectiveView()).toBe("diff");
  });

  it("keeps the rendered view across a code file for Markdown", async () => {
    open("notes.md");
    files.everything = [
      { path: "notes.md", status: "M" },
      { path: "main.rs", status: "M" },
      { path: "more.md", status: "M" },
    ];
    const outcome = pickItem(goToItems("preview")[0]);
    if (outcome.type === "close") outcome.then();
    await selectFile("main.rs");
    await selectFile("more.md");
    expect(effectiveView()).toBe("rendered");
  });

  it.each([
    ["media", () => (files.media = { id: "m", owner: "a", project: "/p", files: ["/x.md"], caption: "", at: 1 })],
    ["a plugin page", () => (files.pluginView = { plugin: "p", id: "v", title: "V", html: "" } as never)],
    ["the browser", () => (browser.showing = true)],
  ])("is not offered while %s fills the viewer", (_name, fill) => {
    open("page.html");
    expect(labels("preview")).toEqual(["Preview file"]);
    fill();
    expect(labels("preview")).toEqual([]);
    expect(commandItems("preview")).toEqual([]);
    browser.showing = false;
  });

  it("stops being offered when the previewed file is deleted or changes kind", () => {
    open("page.html");
    files.renderedFor = "page.html";
    files.view = "rendered";
    expect(labels("source")).toEqual(["Show source"]);
    files.everything = [{ path: "page.html", status: "D" }];
    expect(labels("source")).toEqual([]);
    expect(labels("preview")).toEqual([]);
    open("main.rs");
    files.view = "rendered";
    expect(labels("source")).toEqual([]);
    expect(labels("preview")).toEqual([]);
  });

  it("ranks the command first when the text starts its name, and not otherwise", () => {
    open("page.html");
    expect(labels("preview")[0]).toBe("Preview file");
    // "e" matches projects as well, and starts no command name.
    const both = labels("e");
    expect(both).toContain("Preview file");
    expect(both[0]).not.toBe("Preview file");
  });
});

describe("time", () => {
  it("is spelled coarsely, from now to months", () => {
    const now = 10_000_000_000;
    expect(since(now - 5_000, now)).toBe("now");
    expect(since(now - 3 * 60_000, now)).toBe("3m");
    expect(since(now - 5 * 3_600_000, now)).toBe("5h");
    expect(since(now - 2 * 86_400_000, now)).toBe("2d");
    expect(since(now - 21 * 86_400_000, now)).toBe("3w");
    expect(since(now - 70 * 86_400_000, now)).toBe("2mo");
    expect(since(now + 5_000, now)).toBe("now");
  });
});

/** Picks the entry the field would pick on Enter, for a test walking the steps. */
function choose(label: string, alone = false) {
  const item = paletteItems().find((candidate) => candidate.label === label);
  if (item === undefined) throw new Error(`nothing called ${label}`);
  return pickItem(item, alone);
}

/** Enter on the defaults' line, and what it closes on run. */
function start() {
  const outcome = choose("New session");
  expect(outcome.type).toBe("close");
  if (outcome.type === "close") outcome.then();
}

/** Lets the reads of profiles under way be heard, and a start they held
    go on. */
const heard = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a new chat", () => {
  const CHATS = "/home/ada/.chord/chats";

  it("is offered with its chord once the chats folder is known, a project open or not", () => {
    expect(commandItems("new chat")).toEqual([]);
    resetChats(CHATS);
    const item = commandItems("new chat")[0];
    expect(item).toMatchObject({ kind: "command", label: "New chat", chord: spell(chordFor("chat.new")) });
    workspace.open = [];
    workspace.active = null;
    expect(commandItems("new chat").map((each) => each.label)).toEqual(["New chat"]);
  });

  it("is not offered while no agent is ready", () => {
    resetChats(CHATS);
    harnesses.availability = "missing";
    const item = commandItems("new chat")[0];
    expect(pickable(item)).toBe(false);
    expect(pickItem(item)).toEqual({ type: "stay" });
  });

  it("offers its defaults on one line, with no project asked, and starts on Enter in the chats folder", () => {
    resetChats(CHATS);
    expect(beginChat()).toEqual({ type: "stay" });
    expect(askingChat()).toBe(true);
    expect(palette.ready).toBe(true);
    const items = stepItems("");
    // As is there while agents are on, dimmed for a chat in a terminal.
    expect(items.map((item) => item.kind)).toEqual(["ready", "as"]);
    expect(items[0].kind === "ready" && items[0].detail).toBe("no project");
    const outcome = pickItem(items[0]);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: CHATS, agent: "claude-code", workflow: null });
    expect(workspace.open.map(({ path }) => path)).not.toContain(CHATS);
  });

  it("follows no workflow, whatever the default", () => {
    resetChats(CHATS);
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(stepsLeft([{ kind: "project", path: CHATS }])).toEqual([]);
    beginChat();
    const outcome = pickItem(stepItems("")[0]);
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: CHATS, workflow: null });
  });

  it("goes back to the commands it came from, never to a project question", () => {
    resetChats(CHATS);
    openCommands();
    expect(choose("New chat").type).toBe("stay");
    expect(askingChat()).toBe(true);
    stepBack();
    expect(palette.mode).toBe("commands");
    expect(palette.steps).toEqual([]);
  });

  it("does nothing while the chats folder is not known", () => {
    expect(beginChat()).toEqual({ type: "stay" });
    expect(palette.open).toBe(false);
  });
});

const quick = () => ({
  ...defaultWorkflow(),
  name: "Quick fix",
  steps: [defaultWorkflow().steps[0]],
});

describe("how a new session runs, with agents and teams off", () => {
  beforeEach(() => {
    switches.agents = false;
  });

  it("offers the defaults alone, with nothing to change, and starts on Enter with one agent and no workflow", () => {
    adoptWorkflows(undefined);
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    expect(beginNew(A)).toEqual({ type: "stay" });
    const items = stepItems("");
    expect(items.map((item) => item.label)).toEqual(["New session"]);
    expect(items[0].kind === "ready" && items[0].detail).toBe("Claude Code");
    start();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null, model: null });
  });

  it("asks nothing more in a project that follows no workflow, whatever another project chose", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: { "/elsewhere": "Build and review" } });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    beginNew(A);
    expect(stepItems("").map((item) => item.label)).toEqual(["New session"]);
    start();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null });
    // Nor where the project chose none over the default.
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: { [A]: null } });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
  });

  it("offers the workflows above the agents where the project follows one, even with one agent installed", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual(["agent"]);
    beginNew(A);
    const [line] = stepItems("");
    expect(line.kind === "ready" && line.detail).toBe("Build and review");
    choose("Change");
    const items = stepItems("");
    expect(items.map((item) => [item.group, item.label])).toEqual([
      ["Workflows", "Build and review"],
      ["No workflow", "Claude Code"],
    ]);
    const [flow] = items;
    expect(flow.kind === "choice" && flow.detail).toBe("Fable directs, Sonnet works, Opus reviews");
    expect(flow.kind === "choice" && flow.end).toBe("default");
    expect(startingId()).toBe("workflow:Build and review");
    // Picked, the one agent starts alone, though the project follows a
    // workflow.
    const outcome = choose("Claude Code");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null, model: null });
  });

  it("says whether the project chose its workflow or follows the default", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    beginNew(A);
    choose("Change");
    const ends = () => stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(ends()).toEqual(["default", ""]);
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    expect(ends()).toEqual(["project's workflow", ""]);
  });

  it("puts the project's workflow first, marked, with the cursor on it, and starts under it", () => {
    adoptWorkflows({ list: [quick(), defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    beginNew(A);
    choose("Change");
    const items = stepItems("");
    expect(items.map((item) => item.label)).toEqual(["Build and review", "Quick fix", "Claude Code"]);
    expect(items.map((item) => (item.kind === "choice" ? item.end : null))).toEqual([
      "project's workflow",
      "",
      "",
    ]);
    expect(startingId()).toBe("workflow:Build and review");
    const outcome = choose("Build and review");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", model: "fable" });
    expect(sessions.all[0].workflow?.name).toBe("Build and review");
  });

  it("starts under another workflow picked, and alone on an agent picked", async () => {
    harnesses.installed = ["claude-code", "codex"];
    adoptWorkflows({ list: [defaultWorkflow(), quick()], default: "Build and review", overrides: {} });
    beginNew(A);
    choose("Change");
    let outcome = choose("Quick fix");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0].workflow?.name).toBe("Quick fix");
    beginNew(A);
    choose("Change");
    expect(choose("Codex")).toEqual({ type: "stay" });
    await heard();
    expect(sessions.all[1]).toMatchObject({ agent: "codex", workflow: null });
    beginNew(A);
    choose("Change");
    outcome = choose("Claude Code");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[2]).toMatchObject({ agent: "claude-code", workflow: null, model: null });
  });
});

describe("how a new session runs, with agents and teams on", () => {
  it("offers no workflow, and starts alone though the project follows one", () => {
    adoptWorkflows({ list: [quick(), defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    beginNew(A);
    const [line] = stepItems("");
    expect(line.kind === "ready" && line.detail).toBe("Claude Code");
    // Typed on the line, a workflow's name finds nothing to change to.
    expect(stepItems("quick").filter((item) => item.kind === "choice")).toEqual([]);
    start();
    expect(sessions.all[0].workflow).toBeNull();
  });

  it("asks nothing more of a project that follows a workflow, there being one agent to start", () => {
    adoptWorkflows({ list: [quick(), defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    beginNew(A);
    expect(stepItems("").map((item) => item.kind)).not.toContain("change");
    start();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null });
  });
});

describe("a new session", () => {
  const spawned = () => sessions.all.map((session) => ({ ...session }));

  it("starts from the command with the project to ask for first", () => {
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(palette).toMatchObject({ open: true, mode: "new", query: "", steps: [] });
    expect(nextStep(palette.steps)).toBe("project");
  });

  it("lists the project on screen first, then the rest by last use", () => {
    const one = create(A);
    const three = create(C);
    one.changedAt = 1000;
    three.changedAt = 9000;
    workspace.active = A;
    beginNew(null);
    expect(stepItems("").map((item) => item.label)).toEqual(["one", "three", "two"]);
    workspace.active = null;
    expect(stepItems("").map((item) => item.label)).toEqual(["three", "one", "two"]);
    expect(stepItems("tw").map((item) => item.label)).toEqual(["two"]);
  });

  // A session started by another hangs under its starter, in the
  // starter's project, which is then the project on screen: the question
  // and the command for the project on screen name it, not the project the
  // session runs in, and the cursor starts on it.
  it("takes the starter's project as the one on screen while a session it started is", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = starter.token;
    kid.changedAt = Date.now();
    activate(C);
    sessions.active = kid.key;
    expect(workspace.active).toBe(C);

    expect(commandItems("new session in").map((item) => item.label)).toEqual(["New session in one"]);
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(stepItems("")[0]).toMatchObject({ id: `project:${A}`, label: "one" });
    expect(startingId()).toBeNull();

    openCommands();
    expect(choose("New session in one")).toEqual({ type: "stay" });
    start();
    expect(sessions.all.at(-1)?.project).toBe(A);
  });

  // Nothing new starts in the orchestrator folder: on screen, it offers no
  // New session in it, and a new session from one of its rows asks which
  // project.
  it("offers nothing new in the orchestrator folder", () => {
    const folder = "/home/ada/.chord/orchestrator";
    resetFolder(folder);
    const old = create(folder, "old-1", "claude-code", null);
    started(old.key, "pty-1", "old-1");
    activate(folder);
    sessions.active = old.key;
    expect(onScreen()).toBe(folder);

    expect(commandItems("new session").map((item) => item.label)).toEqual(["New session"]);
    expect(beginNew(folder)).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([]);
    expect(stepItems("").map((item) => item.label)).toEqual(["one", "two", "three"]);
    resetFolder();
  });

  it("starts in the project on Enter when there is nothing else to choose", () => {
    openCommands();
    choose("New session");
    expect(choose("two")).toEqual({ type: "stay" });
    expect(palette.ready).toBe(true);
    start();
    expect(spawned()).toHaveLength(1);
    expect(sessions.all[0]).toMatchObject({ project: B, agent: "claude-code", account: null });
    expect(workspace.active).toBe(B);
  });

  it("asks for the account when accounts are named, then starts under it", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    accounts.overrides = { [B]: "Work" };
    openCommands();
    choose("New session");
    expect(choose("two")).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: B }]);
    // The project's account is the default, and Change offers the others.
    const [line] = stepItems("");
    expect(line.kind === "ready" && line.detail).toBe("Claude Code · Work");
    choose("Change");
    expect(nextStep(palette.steps)).toBe("account");
    expect(stepItems("").map((item) => item.label)).toEqual(["Default", "Work"]);
    // The cursor begins on the account the project runs under.
    expect(startingId()).toBe("account:Work");
    const outcome = choose("Default");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: B, account: null });
  });

  it("asks for the agent only where more than one is installed", () => {
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    harnesses.installed = ["claude-code", "codex"];
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual(["agent"]);
    expect(stepsLeft([])).toEqual(["project", "agent"]);
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    expect(stepsLeft([])).toEqual(["project", "account", "agent"]);
  });

  it("takes each answer as a chip and starts on the last, with the project's agent offered first", () => {
    harnesses.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    sessions.preferred[A] = "codex";
    beginNew(A);
    expect(palette.steps).toEqual([{ kind: "project", path: A }]);
    choose("Change");
    choose("Work");
    expect(palette.steps.map((step) => step.kind)).toEqual(["project", "account"]);
    expect(stepItems("").map((item) => item.label)).toEqual(["Claude Code", "Codex"]);
    expect(startingId()).toBe("agent:codex");
    const outcome = choose("Claude Code");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", account: "Work" });
  });

  it("marks the agent last used on its entry", () => {
    harnesses.installed = ["claude-code", "codex"];
    sessions.preferred[A] = "codex";
    beginNew(A);
    choose("Change");
    const marks = stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(marks).toEqual(["", "last used"]);
  });

  it("clears the field at each step, and narrows only the question asked", () => {
    harnesses.installed = ["claude-code", "codex"];
    openCommands();
    choose("New session");
    setQuery("tw");
    expect(palette.query).toBe("tw");
    choose("two");
    expect(palette.query).toBe("");
    setQuery("codex");
    expect(stepItems(palette.query).map((item) => item.label)).toEqual(["Codex"]);
  });

  it("starts a project's next session under the account picked there last, unless the project names one", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    beginNew(A);
    choose("Change");
    const outcome = choose("Work");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, account: "Work" });
    // The next one starts there under Work, marked as the one picked last.
    beginNew(A);
    const [line] = stepItems("");
    expect(line.kind === "ready" && line.detail).toBe("Claude Code · Work");
    choose("Change");
    expect(startingId()).toBe("account:Work");
    expect(stepItems("").map((item) => (item.kind === "choice" ? item.end : null))).toEqual(["", "last picked"]);
    // The pick is the project's own, not every project's.
    beginNew(B);
    const [other] = stepItems("");
    expect(other.kind === "ready" && other.detail).toBe("Claude Code · Default");
    // A project's own word wins over the pick.
    accounts.overrides = { [A]: null };
    beginNew(A);
    const [own] = stepItems("");
    expect(own.kind === "ready" && own.detail).toBe("Claude Code · Default");
  });

  it("does not take the defaults' line as a pick", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    accounts.everywhere = "Work";
    beginNew(A);
    choose("New session");
    expect(accounts.picked).toEqual({});
  });

  it("finds every choice the defaults stand for in what is typed on their line", async () => {
    harnesses.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    accounts.overrides = { [A]: "Work" };
    beginNew(A);
    setQuery("cod");
    expect(palette.ready).toBe(true);
    // Codex begins with it, so it comes before Claude Code and takes the cursor.
    expect(stepItems(palette.query).map((item) => [item.label, item.group])).toEqual([
      ["Codex", "Which harness"],
      ["Claude Code", "Which harness"],
    ]);
    setQuery("o");
    expect(stepItems(palette.query).map((item) => [item.label, item.group])).toEqual([
      ["Claude Code", "Which harness"],
      ["Codex", "Which harness"],
      ["Work", "Under which account"],
    ]);
    // Enter starts the one found, with the other defaults as they were.
    setQuery("cod");
    expect(choose("Codex")).toEqual({ type: "stay" });
    await heard();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "codex", account: "Work" });
  });

  it("starts the default agent under an account found on the defaults' line, and keeps the pick", async () => {
    harnesses.installed = ["claude-code", "codex"];
    sessions.preferred[A] = "codex";
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    beginNew(A);
    setQuery("wor");
    expect(choose("Work")).toEqual({ type: "stay" });
    await heard();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "codex", account: "Work" });
    expect(accounts.picked).toEqual({ [A]: "Work" });
  });

  it("takes no text on the defaults' line when there is nothing to choose", () => {
    beginNew(A);
    expect(stepsLeft(palette.steps)).toEqual([]);
    setQuery("hello");
    expect(palette.query).toBe("");
    expect(stepItems(palette.query).map((item) => item.kind)).toEqual(["ready", "as"]);
  });

  it("marks the account the project runs under as the project's", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    beginNew(A);
    choose("Change");
    const marks = stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(marks).toEqual(["this project's", ""]);
  });

  it("puts what was typed in the commands back when stepping out of the first question", () => {
    openCommands();
    setQuery("new sess");
    choose("New session");
    expect(palette.query).toBe("");
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", query: "new sess", steps: [] });
    // Opened afresh, the commands start empty again.
    choose("New session");
    openCommands();
    expect(palette.query).toBe("");
    choose("New session");
    stepBack();
    expect(palette.query).toBe("");
  });

  it("steps back by one answer, to the defaults, and from the first question to the commands", () => {
    harnesses.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    openCommands();
    choose("New session");
    choose("one");
    choose("Change");
    choose("Work");
    expect(palette.steps).toHaveLength(2);
    stepBack();
    expect(palette.steps).toEqual([{ kind: "project", path: A }]);
    expect(palette.ready).toBe(false);
    stepBack();
    expect(palette.ready).toBe(true);
    stepBack();
    expect(palette.steps).toEqual([]);
    expect(palette.mode).toBe("new");
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", query: "", steps: [] });
  });

  it("starts in the project on screen from its own command", () => {
    workspace.active = C;
    openCommands();
    expect(choose("New session in three")).toEqual({ type: "stay" });
    start();
    expect(sessions.all[0]).toMatchObject({ project: C });
  });

  it("starts with Cmd+Enter from a session or a project in go to", () => {
    const own = create(B);
    harnesses.installed = ["claude-code", "codex"];
    openGoTo();
    const session = paletteItems().find((item) => item.kind === "session")!;
    expect(pickItem(session, true)).toEqual({ type: "stay" });
    expect(palette).toMatchObject({ mode: "new", steps: [{ kind: "project", path: B }] });
    expect(own.project).toBe(B);

    openGoTo();
    const project = paletteItems().find((item) => item.kind === "project" && item.path === C)!;
    expect(pickItem(project, true)).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: C }]);
  });

  it("steps back out of a new session Cmd+Enter began to go to, with what was typed there", () => {
    harnesses.installed = ["claude-code", "codex"];
    openGoTo();
    setQuery("thr");
    const project = paletteItems().find((item) => item.kind === "project" && item.path === C)!;
    pickItem(project, true);
    expect(palette).toMatchObject({ mode: "new", ready: true, query: "" });
    choose("Change");
    stepBack();
    expect(palette.ready).toBe(true);
    stepBack();
    expect(palette).toMatchObject({ mode: "goto", query: "thr", steps: [], ready: false });
  });

  it("offers the defaults with Cmd+Enter when the project is all it needs", () => {
    openGoTo();
    const project = paletteItems().find((item) => item.kind === "project" && item.path === C)!;
    expect(pickItem(project, true)).toEqual({ type: "stay" });
    start();
    expect(sessions.all.map((session) => session.project)).toEqual([C]);
  });

  it("does not ask for the project when only one is open", () => {
    workspace.open.splice(0, workspace.open.length, repo(B));
    harnesses.installed = ["claude-code", "codex"];
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: B }]);
    expect(stepsLeft(palette.steps)).toEqual(["agent"]);
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", steps: [] });
  });

  it("starts nothing in a project that has closed meanwhile", () => {
    beginNew(A);
    const outcome = pickItem(stepItems("")[0]);
    expect(outcome.type).toBe("close");
    workspace.open.splice(0, workspace.open.length, repo(B), repo(C));
    if (outcome.type === "close") outcome.then();
    expect(sessions.all).toEqual([]);
  });

  it("offers nothing at a later step once the project has closed", () => {
    harnesses.installed = ["claude-code", "codex"];
    beginNew(A);
    expect(stepItems("")).not.toEqual([]);
    workspace.open.splice(0, workspace.open.length, repo(B), repo(C));
    expect(stepItems("")).toEqual([]);
  });

  it("brings the project forward when a session is started in it", () => {
    workspace.active = A;
    startSession(B);
    expect(workspace.active).toBe(B);
    expect(sessions.all[0]).toMatchObject({ project: B });
  });

  it("leaves the steps behind when a list is opened again", () => {
    beginNew(A);
    openGoTo();
    expect(palette).toMatchObject({ mode: "goto", steps: [] });
    beginNew(A);
    openCommands();
    expect(palette).toMatchObject({ mode: "commands", steps: [] });
  });
});

describe("a Codex session's profile", () => {
  const fast = { name: "fast", model: "gpt-6.1-terra", effort: "low", provider: null };
  const local = {
    name: "local",
    model: "gpt-oss-20b",
    effort: null,
    provider: "ollama",
    leftOut: ["approval_policy", "mcp_servers"],
  };
  const ends = () => stepItems("").map((item) => (item.kind === "choice" ? [item.label, item.detail, item.end] : null));

  it("is asked where the account has profiles, and the one picked is started under and offered next", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [fast, local];
    await readProfiles(A, null);
    beginNew(A);
    expect(stepsLeft(palette.steps)).toEqual(["profile"]);
    expect(stepItems("")[0]).toMatchObject({ kind: "ready", detail: "Codex" });

    choose("Change");
    expect(nextStep(palette.steps)).toBe("profile");
    expect(startingId()).toBe("profile:");
    expect(ends()).toEqual([
      ["No profile", "config.toml", ""],
      ["fast", "fast.config.toml", "gpt-6.1-terra · low"],
      ["local", "local.config.toml · 2 settings left out", "gpt-oss-20b · ollama"],
    ]);
    const outcome = choose("fast");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "codex", profile: "fast", model: null });

    beginNew(A);
    expect(stepItems("")[0]).toMatchObject({ kind: "ready", detail: "Codex · fast" });
    choose("Change");
    expect(startingId()).toBe("profile:fast");
    expect(ends()[1]).toEqual(["fast", "fast.config.toml", "gpt-6.1-terra · low · last used here"]);
    expect(ends()[0]).toEqual(["No profile", "config.toml", ""]);
  });

  it("is not asked of Claude Code, of a workflow, or under an account with none", async () => {
    harnesses.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } };
    listed.profiles = [fast];
    await readProfiles(A, null);
    const project = { kind: "project", path: A } as const;
    const personal = { kind: "account", account: null } as const;
    expect(nextStep([project, personal, { kind: "agent", agent: "codex" }])).toBe("profile");
    expect(nextStep([project, personal, { kind: "agent", agent: "claude-code" }])).toBeNull();
    expect(nextStep([project, personal, { kind: "workflow", workflow: "Build and review" }])).toBeNull();
    expect(nextStep([project, { kind: "account", account: "Work" }, { kind: "agent", agent: "codex" }])).toBeNull();
  });

  it("starts from the defaults' line under the one picked last, while the account still has it", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [fast];
    await readProfiles(A, null);
    pickProfile(A, "fast");
    beginNew(A);
    start();
    expect(sessions.all[0]).toMatchObject({ agent: "codex", profile: "fast" });
    await heard();

    listed.profiles = [];
    await readProfiles(A, null);
    expect(profileToStart(A, null)).toBeNull();
    beginNew(A);
    start();
    expect(sessions.all[1]).toMatchObject({ agent: "codex", profile: null });
  });

  it("waits for the account's list before starting from the defaults' line", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [fast];
    pickProfile(A, "fast");
    beginNew(A);
    expect(stepItems("")[0]).toMatchObject({ kind: "ready", detail: "Codex" });
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(sessions.all).toEqual([]);
    await heard();
    expect(palette.open).toBe(false);
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "codex", profile: "fast" });
  });

  it("starts nothing held once the palette has moved on", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [fast];
    beginNew(A);
    expect(choose("New session")).toEqual({ type: "stay" });
    closePalette();
    await heard();
    expect(sessions.all).toEqual([]);
    resetProfiles();
    beginNew(B);
    expect(choose("New session")).toEqual({ type: "stay" });
    beginNew(C);
    await heard();
    expect(sessions.all).toEqual([]);
    expect(palette).toMatchObject({ open: true, mode: "new" });
  });

  it("asks under a second account once its list is heard", async () => {
    harnesses.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } };
    listed.profiles = [];
    beginNew(A);
    await heard();
    listed.profiles = [fast];
    choose("Change");
    expect(nextStep(palette.steps)).toBe("account");
    choose("Work");
    expect(nextStep(palette.steps)).toBe("agent");
    expect(choose("Codex")).toEqual({ type: "stay" });
    await heard();
    expect(sessions.all).toEqual([]);
    expect(nextStep(palette.steps)).toBe("profile");
    const outcome = choose("fast");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ agent: "codex", account: "Work", profile: "fast" });
  });

  it("starts under the account found on the defaults' line with that account's profile, not the default's", async () => {
    harnesses.installed = ["codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } };
    listed.profiles = [fast];
    pickProfile(A, "fast");
    beginNew(A);
    await heard();
    expect(stepItems("")[0]).toMatchObject({ kind: "ready", detail: "Codex · fast · Default" });
    listed.profiles = [local];
    setQuery("wor");
    expect(choose("Work")).toEqual({ type: "stay" });
    await heard();
    expect(sessions.all[0]).toMatchObject({ agent: "codex", account: "Work", profile: null });
  });

  it("starts the other way under the one picked last, once the account's list is heard", async () => {
    harnesses.installed = ["codex"];
    harnesses.integrable = ["codex"];
    listed.profiles = [fast];
    pickProfile(A, "fast");
    workspace.active = A;
    openCommands();
    const outcome = choose("New session in Chord in one");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") await outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "codex", kind: "integrated", profile: "fast" });
  });

  it("says one setting left out of a profile in the singular", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [{ ...fast, leftOut: ["skills"] }];
    await readProfiles(A, null);
    beginNew(A);
    choose("Change");
    expect(ends()[1]).toEqual(["fast", "fast.config.toml · 1 setting left out", "gpt-6.1-terra · low"]);
  });

  it("keeps no profile picked as the project's pick, and takes a name only from the list", async () => {
    harnesses.installed = ["codex"];
    listed.profiles = [fast, { name: "../outside", model: null, effort: null, provider: null }, { name: 5 }];
    await readProfiles(A, null);
    pickProfile(A, "fast");
    beginNew(A);
    choose("Change");
    expect(stepItems("").map((item) => item.label)).toEqual(["No profile", "fast"]);
    const outcome = choose("No profile");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ agent: "codex", profile: null });
    expect(profileToStart(A, null)).toBeNull();
    beginNew(A);
    choose("Change");
    expect(startingId()).toBe("profile:");
    expect(ends()[0]).toEqual(["No profile", "config.toml", "last used here"]);
  });
});

describe("the agent a new session works as", () => {
  const SHIP = { name: "Ship", members: ["Developer", "Reviewer"], gates: [] } as unknown as (typeof teams.inUse)[number];
  const labels = () => stepItems("").map((item) => item.label);
  const row = (id: string) => stepItems("").find((item) => item.id === id);

  beforeEach(() => {
    switches.agents = true;
    harnesses.integrable = ["claude-code", "codex"];
    sessionKinds.integrated = ["claude-code", "codex"];
    resetPickedAgents();
    resetTeams();
    agents.installed = { [A]: [] };
    teams.byProject = { [A]: [SHIP] };
  });

  afterEach(() => {
    for (const session of sessions.all) forgetAgentRow(session.key);
    resetSessionKinds();
    resetTeams();
    agents.installed = {};
  });

  it("puts As under the line, naming no agent, and starts as none on Enter", () => {
    beginNew(A);
    expect(stepItems("")).toMatchObject([
      { kind: "ready", detail: "Claude Code" },
      { kind: "as", label: "As", detail: "No agent", end: "", off: false },
    ]);
    start();
    expect(sessions.all[0]).toMatchObject({ project: A, kind: "integrated" });
    expect(agentOfRow(sessions.all[0].key, null)).toBeNull();
  });

  it("opens one step of no agent, the agents and the teams, and starts on the one picked", () => {
    beginNew(A);
    expect(choose("As")).toEqual({ type: "stay" });
    expect(palette.as).toBe(true);
    expect(startingId()).toBe("as:");
    const items = stepItems("");
    expect(items[0]).toMatchObject({ id: "as:", label: "No agent", group: "Agents" });
    expect(items.find((item) => item.label === "Reviewer")).toMatchObject({
      group: "Agents",
      detail: "Checks a change for bugs, design and fit.",
      icon: "agent",
      lock: true,
    });
    expect(items.find((item) => item.label === "Developer")).toMatchObject({ lock: false });
    expect(items.at(-1)).toMatchObject({ label: "Ship", group: "Teams", detail: "0 gates · 2 agents", icon: "team" });
    const outcome = choose("Reviewer");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    const key = sessions.all[0].key;
    expect(agentOfRow(key, null)).toEqual({ key: "chord:Reviewer", title: "Reviewer", readsOnly: true });
    expect(agentWaits(key)).toBe(true);
    expect(agentStartsAt(key)).toBe("high");
    expect(sessions.all[0].model).toBe("opus");
    expect(agentPickedIn(A)).toBe("chord:Reviewer");
  });

  it("starts the next new session in the project as the agent last picked, named on the line", () => {
    pickAgentIn(A, "chord:Reviewer");
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    accounts.overrides = { [A]: "Work" };
    beginNew(A);
    expect(stepItems("")).toMatchObject([
      { kind: "ready", detail: "Claude Code · Reviewer · Work" },
      { kind: "change" },
      { kind: "as", detail: "Reviewer", end: "last picked" },
    ]);
    choose("As");
    expect(startingId()).toBe("as:agent:chord:Reviewer");
    expect(row("as:agent:chord:Reviewer")).toMatchObject({ end: "last picked", lock: true });
    expect(beginNew(B).type).toBe("stay");
    expect(stepItems("").find((item) => item.kind === "as")).toMatchObject({ detail: "No agent" });
  });

  it("goes back to the line from the step on an empty field", () => {
    beginNew(A);
    choose("As");
    stepBack();
    expect(palette).toMatchObject({ mode: "new", ready: true, as: false });
    expect(stepItems("").map((item) => item.kind)).toEqual(["ready", "as"]);
  });

  it("forgets the agent on No agent, and leaves it as it was for a team", () => {
    pickAgentIn(A, "chord:Reviewer");
    beginNew(A);
    choose("As");
    let outcome = choose("Ship");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0].team).toBe("Ship");
    expect(agentOfRow(sessions.all[0].key, null)).toBeNull();
    expect(agentPickedIn(A)).toBe("chord:Reviewer");
    beginNew(A);
    choose("As");
    outcome = choose("No agent");
    if (outcome.type === "close") outcome.then();
    expect(agentPickedIn(A)).toBeNull();
  });

  it("finds agents and teams typed on the line, beside the harnesses, and starts on one at once", () => {
    harnesses.installed = ["claude-code", "codex"];
    beginNew(A);
    setQuery("re");
    const found = stepItems("re");
    expect(found.find((item) => item.label === "Reviewer")?.group).toBe("As which agent");
    expect(stepItems("ship")).toMatchObject([{ label: "Ship", group: "Leading which team" }]);
    expect(stepItems("no agent")).toMatchObject([{ id: "as:", label: "No agent" }]);
    const item = found.find((candidate) => candidate.label === "Researcher")!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(agentOfRow(sessions.all[0].key, null)?.title).toBe("Researcher");
    expect(agentPickedIn(A)).toBe("chord:Researcher");
  });

  it("asks it last through Change, after the harness, and starts on it", () => {
    harnesses.installed = ["claude-code", "codex"];
    beginNew(A);
    choose("Change");
    choose("Claude Code");
    expect(nextStep(palette.steps)).toBe("as");
    expect(stepsLeft(palette.steps)).toEqual(["as"]);
    expect(labels()[0]).toBe("No agent");
    const outcome = choose("Developer");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ agent: "claude-code" });
    expect(agentOfRow(sessions.all[0].key, null)?.title).toBe("Developer");
  });

  it("is off for a terminal, which finds no agent, and back for a harness in Chord", () => {
    harnesses.installed = ["claude-code", "codex"];
    sessionKinds.integrated = ["codex"];
    pickAgentIn(A, "chord:Reviewer");
    beginNew(A);
    expect(row("as")).toMatchObject({ detail: "No agent", end: "in a terminal", off: true });
    expect(pickable(row("as")!)).toBe(false);
    expect(startingId()).toBeNull();
    expect(stepItems("reviewer")).toEqual([]);
    choose("Change");
    choose("Codex");
    expect(nextStep(palette.steps)).toBe("as");
    expect(startingId()).toBe("as:agent:chord:Reviewer");
  });

  it("ignores the workflow a project follows, leaving As live and the line on the agent last picked", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    pickAgentIn(A, "chord:Reviewer");
    beginNew(A);
    expect(stepItems("")).toMatchObject([
      { kind: "ready", detail: "Claude Code · Reviewer" },
      { kind: "as", detail: "Reviewer", off: false },
    ]);
    expect(stepItems("")[1]).not.toMatchObject({ end: "under a workflow" });
    expect(pickable(row("as")!)).toBe(true);
    expect(defaultsAskAs()).toBe(true);
    start();
    expect(sessions.all[0]).toMatchObject({ agent: "claude-code", workflow: null });
    expect(agentOfRow(sessions.all[0].key, null)?.title).toBe("Reviewer");
    expect(agentPickedIn(A)).toBe("chord:Reviewer");
  });

  it("ignores a project's own workflow too, and starts the line alone", () => {
    adoptWorkflows({ list: [quick(), defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    expect(defaultsFor(A).map((step) => step.kind)).not.toContain("workflow");
    beginNew(A);
    expect(row("as")).toMatchObject({ off: false });
    start();
    expect(sessions.all[0]).toMatchObject({ project: A, workflow: null });
  });

  it("is as before with agents off, keeping the agent last picked", () => {
    switches.agents = false;
    pickAgentIn(A, "chord:Reviewer");
    beginNew(A);
    expect(stepItems("").map((item) => item.kind)).toEqual(["ready"]);
    expect(stepItems("reviewer")).toEqual([]);
    start();
    expect(agentOfRow(sessions.all[0].key, null)).toBeNull();
    expect(agentPickedIn(A)).toBe("chord:Reviewer");
  });
});
