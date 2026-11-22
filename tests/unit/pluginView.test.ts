import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginNotifyEvent,
  PluginViewDataEvent,
  PluginViewEvent,
  PluginViewMessageRequest,
} from "$lib/core";
import { clear, deselect, files, showMedia } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import { clicked, resetNotify } from "$lib/notify.svelte";
import {
  ACT_SPAN,
  contextFor,
  dataArrived,
  leftPage,
  open,
  pluginNotified,
  pluginViews,
  resetPluginViews,
  send,
  showAsked,
  spendAct,
  TOKEN_MOST,
  viewChanged,
  viewOf,
} from "$lib/pluginView.svelte";
import { reset as resetSessions, sessions, type Session } from "$lib/sessions.svelte";
import { theme } from "$lib/theme.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const sent: PluginViewMessageRequest[] = [];
const notified: { title: string; body: string; id: string }[] = [];
let refuse: string | null = null;
vi.mock("$lib/core", () => ({
  core: () => ({
    async pluginViewMessage(request: PluginViewMessageRequest) {
      sent.push(request);
      if (refuse !== null) throw new Error(refuse);
    },
    async notify(title: string, body: string, id: string) {
      notified.push({ title, body, id });
    },
    async setWindowTitle() {},
  }),
}));

const event = (extra: Partial<PluginViewEvent> = {}): PluginViewEvent => ({
  source: "src-1",
  plugin: "github",
  project: "/one",
  width: "wide",
  html: "<h1>The branch</h1>",
  open: false,
  ...extra,
});

const data = (
  extra: Partial<PluginViewDataEvent> = {},
): PluginViewDataEvent => ({
  source: "src-1",
  plugin: "github",
  project: "/one",
  data: { checks: 2 },
  ...extra,
});

beforeEach(() => {
  clear();
  resetWorkspace();
  resetPluginViews();
  resetNotify();
  resetSessions();
  sent.length = 0;
  notified.length = 0;
  refuse = null;
  layout.mode = "working";
  workspace.active = "/one";
});

describe("a plugin's page", () => {
  it("keeps the latest the plugin sent, per project", () => {
    viewChanged(event());
    viewChanged(event({ project: "/two", html: "<h1>Two</h1>" }));
    viewChanged(event({ html: "<h1>Again</h1>" }));
    expect(pluginViews.pages).toHaveLength(2);
    expect(viewOf("src-1/github")?.html).toBe("<h1>Again</h1>");
    workspace.active = "/two";
    expect(viewOf("src-1/github")?.html).toBe("<h1>Two</h1>");
  });

  it("has nothing for a plugin that sent no page", () => {
    viewChanged(event());
    expect(viewOf("src-1/graph")).toBeNull();
  });

  it("shows one when it is asked for, and the viewer opens on it", () => {
    viewChanged(event());
    expect(files.pluginView).toBeNull();
    open("src-1/github", "/one");
    expect(files.pluginView?.html).toBe("<h1>The branch</h1>");
    expect(files.pluginView?.width).toBe("wide");
    expect(layout.mode).toBe("reviewing");
  });

  it("opens by itself when the plugin asks, for the project on screen", () => {
    viewChanged(event({ project: "/two", open: true }));
    expect(files.pluginView).toBeNull();
    viewChanged(event({ open: true }));
    expect(files.pluginView?.project).toBe("/one");
  });

  it("hands the open page the newer one the plugin sends", () => {
    viewChanged(event({ open: true }));
    viewChanged(event({ html: "<h1>Newer</h1>" }));
    expect(files.pluginView?.html).toBe("<h1>Newer</h1>");
  });

  it("goes when the plugin sends no page, and takes the viewer with it", () => {
    viewChanged(event({ open: true }));
    viewChanged(event({ html: "" }));
    expect(pluginViews.pages).toHaveLength(0);
    expect(files.pluginView).toBeNull();
    expect(layout.mode).toBe("working");
  });

  it("goes without closing a viewer that is on something else", () => {
    viewChanged(event());
    showMedia({
      id: "m1",
      owner: "session-1",
      project: "/one",
      files: ["/one/shot.png"],
      caption: null,
      at: 0,
    });
    viewChanged(event({ html: "" }));
    expect(pluginViews.pages).toHaveLength(0);
    expect(files.media).not.toBeNull();
    expect(layout.mode).toBe("reviewing");
  });

  it("lets the viewer go to what the agent presents, and back", () => {
    viewChanged(event({ open: true }));
    showMedia({
      id: "m1",
      owner: "session-1",
      project: "/one",
      files: ["/one/shot.png"],
      caption: null,
      at: 0,
    });
    expect(files.pluginView).toBeNull();
    open("src-1/github", "/one");
    expect(files.media).toBeNull();
    deselect();
    expect(files.pluginView).toBeNull();
  });
});

describe("what crosses the bridge", () => {
  it("sends a message to the plugin the page belongs to", async () => {
    viewChanged(event());
    await send("src-1/github", "/one", { hello: 1 });
    expect(sent).toEqual([
      {
        source: "src-1",
        plugin: "github",
        project: "/one",
        payload: { hello: 1 },
        acted: false,
      },
    ]);
  });

  it("says a message came of something the user did only when the page says so", async () => {
    viewChanged(event());
    await send("src-1/github", "/one", { merge: 12 }, true);
    expect(sent).toEqual([
      {
        source: "src-1",
        plugin: "github",
        project: "/one",
        payload: { merge: 12 },
        acted: true,
      },
    ]);
  });

  it("counts one message of a click or key as the user's, and the rest of it as the page's own", () => {
    expect(spendAct("src-1/github", "/one", true, 1000)).toBe(true);
    expect(spendAct("src-1/github", "/one", true, 1001)).toBe(false);
    expect(spendAct("src-1/github", "/one", true, 1000 + ACT_SPAN - 1)).toBe(false);
    expect(spendAct("src-1/github", "/one", true, 1000 + ACT_SPAN)).toBe(true);
  });

  it("counts a message as the user's never without a click or key behind it", () => {
    expect(spendAct("src-1/github", "/one", false, 1000)).toBe(false);
  });

  it("counts the next click as the user's once one ended, or the user left the page", () => {
    expect(spendAct("src-1/github", "/one", true, 1000)).toBe(true);
    expect(spendAct("src-1/github", "/one", false, 1100)).toBe(false);
    expect(spendAct("src-1/github", "/one", true, 1200)).toBe(true);
    leftPage("src-1/github", "/one");
    expect(spendAct("src-1/github", "/one", true, 1300)).toBe(true);
  });

  it("counts a click for each page alone, by plugin and by project", () => {
    expect(spendAct("src-1/github", "/one", true, 1000)).toBe(true);
    expect(spendAct("src-1/jira", "/one", true, 1000)).toBe(true);
    expect(spendAct("src-1/github", "/two", true, 1000)).toBe(true);
    expect(spendAct("src-1/github", "/one", true, 1000)).toBe(false);
  });

  it("drops a message for a page that is gone", async () => {
    await send("src-1/github", "/one", { hello: 1 });
    expect(sent).toHaveLength(0);
  });

  it("keeps what the plugin refused to itself", async () => {
    viewChanged(event());
    refuse = "the plugin is not running";
    await expect(send("src-1/github", "/one", {})).resolves.toBeUndefined();
  });

  it("hands the plugin's data to the page that is open", () => {
    viewChanged(event({ open: true }));
    dataArrived(data());
    expect(pluginViews.data).toMatchObject({
      key: "src-1/github",
      project: "/one",
      data: { checks: 2 },
    });
  });

  it("counts each message, so the same data twice arrives twice", () => {
    viewChanged(event({ open: true }));
    dataArrived(data());
    const first = pluginViews.data!.seq;
    dataArrived(data());
    expect(pluginViews.data!.seq).toBeGreaterThan(first);
  });

  it("drops data for a page that is not the open one", () => {
    viewChanged(event({ open: true }));
    dataArrived(data({ project: "/two" }));
    dataArrived(data({ plugin: "graph" }));
    expect(pluginViews.data).toBeNull();
  });

  it("drops data when no page is open at all", () => {
    viewChanged(event());
    dataArrived(data());
    expect(pluginViews.data).toBeNull();
  });
});

describe("a plugin's notification that names no session", () => {
  const told = (extra: Partial<PluginNotifyEvent> = {}): PluginNotifyEvent => ({
    source: "src-1",
    plugin: "github",
    project: "/two",
    text: "A review was asked of you",
    target: "pr/7",
    ...extra,
  });
  const openBoth = () => {
    workspace.open.push(
      { path: "/one", name: "one", repository: "/one", isGit: true },
      { path: "/two", name: "orbit-api", repository: "/two", isGit: true },
    );
  };

  it("is told under the project and the plugin's name, with its text as the body", () => {
    openBoth();
    pluginNotified(told());
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toBe("orbit-api · github");
    expect(notified[0].body).toBe("A review was asked of you");
  });

  it("is told for no project that is not open", () => {
    pluginNotified(told());
    expect(notified).toHaveLength(0);
  });

  it("is told by the same name for the same target, so the newer takes the place of the last", () => {
    openBoth();
    pluginNotified(told());
    pluginNotified(told({ text: "Again" }));
    pluginNotified(told({ target: "pr/8" }));
    expect(notified[0].id).toBe(notified[1].id);
    expect(notified[2].id).not.toBe(notified[0].id);
  });

  it("brings its project forward on a click and opens the page there, handed the target", () => {
    openBoth();
    viewChanged(event({ project: "/two" }));
    pluginNotified(told());
    clicked(notified[0].id);
    expect(workspace.active).toBe("/two");
    expect(files.pluginView?.project).toBe("/two");
    expect(pluginViews.target).toMatchObject({ key: "src-1/github", project: "/two", target: "pr/7" });
  });

  it("opens no page on a click for a plugin with none, nor for a project closed since", () => {
    openBoth();
    pluginNotified(told());
    clicked(notified[0].id);
    expect(workspace.active).toBe("/two");
    expect(files.pluginView).toBeNull();
    expect(pluginViews.target).toBeNull();

    viewChanged(event({ project: "/two" }));
    workspace.active = "/one";
    pluginNotified(told({ target: "pr/9" }));
    workspace.open.splice(1, 1);
    clicked(notified[1].id);
    expect(workspace.active).toBe("/one");
    expect(files.pluginView).toBeNull();
  });

  it("hands the page no target when the plugin gave none", () => {
    openBoth();
    viewChanged(event({ project: "/two" }));
    pluginNotified(told({ target: null }));
    clicked(notified[0].id);
    expect(files.pluginView?.project).toBe("/two");
    expect(pluginViews.target).toBeNull();
  });
});

describe("what a page is told of what is around it", () => {
  /** A row with only what the context and a show read. */
  function row(key: string, project: string, id: string | null) {
    const session = { key, project, id } as unknown as Session;
    sessions.all.push(session);
    return session;
  }
  const read = (token: string) => ({ "--bg": " #0e1112 ", "--accent": "teal" })[token] ?? "";

  it("names the session on screen while it is of the page's project, and no other", () => {
    row("k1", "/one", "agent-1");
    row("k2", "/two", "agent-2");
    expect(contextFor("/one", read).session).toBeNull();
    sessions.active = "k1";
    expect(contextFor("/one", read).session).toBe("agent-1");
    sessions.active = "k2";
    expect(contextFor("/one", read).session).toBeNull();
    row("k3", "/one", "x".repeat(129));
    sessions.active = "k3";
    expect(contextFor("/one", read).session).toBeNull();
  });

  it("hands over the theme's tokens, trimmed, with a value past its most as empty", () => {
    const told = contextFor("/one", (token) => (token === "--ink" ? "y".repeat(TOKEN_MOST + 1) : read(token)));
    expect(told.tokens.bg).toBe("#0e1112");
    expect(told.tokens.accent).toBe("teal");
    expect(told.tokens.ink).toBe("");
    expect(Object.keys(told.tokens)).toContain("radius-sm");
    expect(told.look).toBe(theme.look);
    theme.look = "terminal";
    expect(contextFor("/one", read).look).toBe("terminal");
    theme.look = "modern";
  });

  it("brings a session of the project on screen on the user's act", () => {
    row("k1", "/one", "agent-1");
    expect(showAsked("/one", "agent-1", true)).toBe(true);
    expect(sessions.active).toBe("k1");
  });

  it("brings nothing on screen without the user's act", () => {
    row("k1", "/one", "agent-1");
    expect(showAsked("/one", "agent-1", false)).toBe(false);
    expect(sessions.active).toBeNull();
  });

  it("brings no session of another project, nor any while the page's project is not on screen", () => {
    row("k2", "/two", "agent-2");
    expect(showAsked("/one", "agent-2", true)).toBe(false);
    row("k1", "/one", "agent-1");
    workspace.active = "/two";
    expect(showAsked("/one", "agent-1", true)).toBe(false);
    expect(sessions.active).toBeNull();
  });

  it("brings nothing for an id it does not know, nor for one that is not a short string", () => {
    row("k1", "/one", "agent-1");
    row("k0", "/one", null);
    for (const asked of ["agent-9", "", "a".repeat(129), 7, null, { id: "agent-1" }, ["agent-1"]])
      expect(showAsked("/one", asked, true)).toBe(false);
    expect(sessions.active).toBeNull();
  });
});
