/**
 * The pages plugins show in the changes pane's viewer.
 *
 * A plugin sends its whole page whenever it changes, per project, so the
 * window keeps the latest of each and never merges. A page with no html in
 * it means the page is gone for that project, which is what a plugin
 * stopping looks like from here; the viewer lets it go with it.
 *
 * Messages between the page and the plugin pass through here: data from the
 * plugin reaches the frame that is open on it, and what the frame sends
 * goes back to the plugin by its source and name. The page is also told
 * what is around it: the session on screen and the theme it is painted in.
 */

import {
  core,
  type PluginNotifyEvent,
  type PluginViewDataEvent,
  type PluginViewEvent,
} from "$lib/core";
import { closeViewer, files, showPluginView } from "$lib/files.svelte";
import { wentOnFrom } from "$lib/goingOn.svelte";
import { tell } from "$lib/notify.svelte";
import { activeSession, sessions } from "$lib/sessions.svelte";
import { resolvedTheme, theme, type LookName } from "$lib/theme.svelte";
import { activate, goTo, projectLabel, workspace } from "$lib/workspace.svelte";

/** A page as one project has it. */
export interface PluginPage {
  /** Source and plugin, which is what a page is kept and messaged by. */
  key: string;
  source: string;
  plugin: string;
  project: string;
  /** Wide is the viewer beside the tree; full is the whole pane. */
  width: "wide" | "full";
  html: string;
}

export const pluginViews = $state({
  pages: [] as PluginPage[],
  /** The latest message for the page on screen, counted so the same data
      twice over still reaches the frame twice. */
  data: null as {
    key: string;
    project: string;
    data: unknown;
    seq: number;
  } | null,
  /** What a click on the plugin's notification hands its page, counted as
      the data is. */
  target: null as {
    key: string;
    project: string;
    target: string;
    seq: number;
  } | null,
});

let seq = 0;

export function keyOf(event: { source: string; plugin: string }): string {
  return `${event.source}/${event.plugin}`;
}

function pageAt(key: string, project: string): PluginPage | null {
  return (
    pluginViews.pages.find(
      (page) => page.key === key && page.project === project,
    ) ?? null
  );
}

/** Whether the viewer is holding this page right now. */
function showing(key: string, project: string): boolean {
  const open = files.pluginView;
  return open !== null && open.key === key && open.project === project;
}

/** The latest page a plugin sent for a project. A page with no html is
    dropped, and the viewer closes if that is what it was holding. */
export function viewChanged(event: PluginViewEvent) {
  const key = keyOf(event);
  const at = pluginViews.pages.findIndex(
    (page) => page.key === key && page.project === event.project,
  );
  const open = showing(key, event.project);
  if (event.html === "") {
    if (at !== -1) pluginViews.pages.splice(at, 1);
    if (open) closeViewer();
    return;
  }
  const page: PluginPage = {
    key,
    source: event.source,
    plugin: event.plugin,
    project: event.project,
    width: event.width,
    html: event.html,
  };
  if (at === -1) pluginViews.pages.push(page);
  else pluginViews.pages[at] = page;
  // A page the viewer is already holding is replaced by the new one; a
  // plugin asking for its page only gets it while its project is on screen.
  if (open || (event.open && workspace.active === event.project))
    showPluginView(page);
}

/** A message from a plugin, for the frame when its page is the one open. */
export function dataArrived(event: PluginViewDataEvent) {
  const key = keyOf(event);
  if (!showing(key, event.project)) return;
  pluginViews.data = {
    key,
    project: event.project,
    data: event.data,
    seq: ++seq,
  };
}

/** The page a plugin has for the project on screen, if it sent one. */
export function viewOf(key: string): PluginPage | null {
  const project = workspace.active;
  if (project === null) return null;
  return pageAt(key, project);
}

/** Shows a plugin's page in the viewer. */
export function open(key: string, project: string) {
  const page = pageAt(key, project);
  if (page === null) return;
  showPluginView(page);
}

/** A plugin's notification that names no session, for a project open
    here: told as any notification is, as the settings allow, titled with
    the project and "The <name> plugin", so it never reads as a session's,
    whose title is the session's name. Its text is the body, which the
    system shows as text. One again with the same target takes the place
    of the last. A click brings the project forward and opens the plugin's
    page there, handed the target; a plugin with no page for the project
    opens none. */
export function pluginNotified(event: PluginNotifyEvent) {
  const { project } = event;
  if (!workspace.open.some((open) => open.path === project)) return;
  const key = keyOf(event);
  const name = JSON.stringify(["plugin", event.source, event.plugin, project, event.target ?? ""]);
  tell(name, `${projectLabel(project)} · The ${event.plugin} plugin`, event.text, () =>
    openAt(key, project, event.target),
  );
}

/** Brings the project forward and opens the plugin's page in it, with the
    target handed to the page. */
export function openAt(key: string, project: string, target: string | null) {
  if (!workspace.open.some((open) => open.path === project)) return;
  if (workspace.active !== project) activate(project);
  if (pageAt(key, project) === null) return;
  open(key, project);
  pluginViews.target = target === null ? null : { key, project, target, seq: ++seq };
}

/** Carries a message from a page to its plugin, `acted` when the user's
    click or key in the page sent it. A plugin that is not there for it
    drops it, as an action the plugin refused is dropped. */
export async function send(key: string, project: string, payload: unknown, acted = false) {
  const page = pageAt(key, project);
  if (page === null) return;
  try {
    await core().pluginViewMessage({
      source: page.source,
      plugin: page.plugin,
      project,
      payload,
      acted,
    });
  } catch {
    // The frame has nowhere to show this, and the page is still the truth.
  }
}

/** How long a click in a page lends it the user's act, as long as a
    browser keeps a click's activation. */
export const ACT_SPAN = 5000;

/** When each page last passed on the user's act, by project and key. */
const actedAt = new Map<string, number>();
const actKey = (key: string, project: string) => `${project}\n${key}`;

/**
 * Whether a message a page sent while the user was clicking or typing in
 * it carries the user's act. One click lends one: the first message in
 * its span does, and the rest do not until the span is over or the user
 * has left the page and come back. A page that sends fifty messages on
 * one click gets one act for them.
 */
export function spendAct(key: string, project: string, activated: boolean, now = performance.now()): boolean {
  const id = actKey(key, project);
  if (!activated) {
    actedAt.delete(id);
    return false;
  }
  const last = actedAt.get(id);
  if (last !== undefined && now - last < ACT_SPAN) return false;
  actedAt.set(id, now);
  return true;
}

/** The user left a page: their next click in it is a new act. */
export function leftPage(key: string, project: string) {
  actedAt.delete(actKey(key, project));
}

/** The theme's tokens a page is handed, named without their dashes. */
export const TOKENS = [
  "bg",
  "surface",
  "surface-2",
  "well",
  "ink",
  "ink-2",
  "ink-3",
  "rule",
  "rule-strong",
  "accent",
  "accent-soft",
  "add",
  "del",
  "mono",
  "sans",
  "radius",
  "radius-sm",
] as const;

/** The most a token's value or a session's id holds, in characters. */
export const TOKEN_MOST = 200;
export const SESSION_MOST = 128;

/** What a page is told of what is around it. */
export interface PageContext {
  /** The agent's id for the session on screen, while it is one of the
      page's project; null otherwise. */
  session: string | null;
  scheme: "light" | "dark";
  look: LookName;
  tokens: Record<string, string>;
}

/** What a page of `project` is told now, with the tokens as `read` reads
    them off the window. A value past its most is told as empty. */
export function contextFor(project: string, read: (token: string) => string): PageContext {
  const row = activeSession();
  const id = row !== null && row.project === project ? row.id : null;
  const tokens: Record<string, string> = {};
  for (const name of TOKENS) {
    const value = read(`--${name}`).trim();
    tokens[name] = value.length > TOKEN_MOST ? "" : value;
  }
  return {
    session: id !== null && id.length <= SESSION_MOST ? id : null,
    scheme: resolvedTheme(),
    look: theme.look,
    tokens,
  };
}

/** A page asks to bring a session on screen. It is brought only on the
    user's act in the page, only while the page's project is the one on
    screen, and only for a session of that project the page names by its
    id, or by the id of a conversation that went on to it. Whether it was
    brought is all the page could learn, and it is told nothing. */
export function showAsked(project: string, session: unknown, acted: boolean): boolean {
  if (!acted || workspace.active !== project) return false;
  if (typeof session !== "string" || session === "" || session.length > SESSION_MOST) return false;
  const row = sessions.all.find(
    (row) => row.project === project && row.id !== null && (row.id === session || wentOnFrom(session) === row.id),
  );
  return row !== undefined && goTo(row.key);
}

/** Test seam. */
export function resetPluginViews() {
  pluginViews.pages = [];
  pluginViews.data = null;
  pluginViews.target = null;
  seq = 0;
  actedAt.clear();
}
