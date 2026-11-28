import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: unknown) => {
      sent.push(change);
      return change;
    },
    transcripts: async () => [],
    kill: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    setWindowTitle: async () => {},
  }),
}));

import {
  adoptInactiveAfter,
  file,
  holdsActive,
  inactiveAfterSettings,
  historyDue,
  isActive,
  lastActive,
  lastUsed,
  loadUsed,
  projects,
  QUIET_EVERY,
  readQuietNext,
  resetProjects,
  setInactiveAfter,
  sortProjects,
  splitProjects,
  steady,
  touch,
} from "$lib/projects.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import "$lib/orchestrator.svelte";
import {
  byActivity,
  create,
  lastActive as activeAt,
  modelLabel,
  earlierLabel,
  nextNeedingYou,
  reopened,
  reset as resetSessions,
  sessions,
  since,
  started,
} from "$lib/sessions.svelte";
import { activate, bringForward, close, goTo, makeInactive, onScreen, openPath, reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 12);

const entry = (id: string, modifiedMs: number) => ({
  id,
  title: null,
  modified: Math.floor(modifiedMs / 1000),
  size: 1,
  cwd: null,
  agent: "claude-code" as const,
  account: null,
});

beforeEach(() => {
  localStorage.clear();
  sent.length = 0;
  resetSessions();
  resetWorkspace();
  resetProjects();
  resetConductor();
});

describe("last used", () => {
  it("is nothing for a project nothing dates", () => {
    expect(lastUsed("/repo")).toBeNull();
  });

  // The order is the user's: an agent at work in a project says it is in
  // use, and moves nothing.
  it("is the user's own record, else the newest transcript, never a row changing", () => {
    sessions.history["/repo"] = [entry("b", NOW - 2 * DAY), entry("a", NOW - 9 * DAY)];
    expect(lastUsed("/repo")).toBe(NOW - 2 * DAY);

    touch("/repo", NOW - 5 * DAY);
    expect(lastUsed("/repo")).toBe(NOW - 5 * DAY);

    const live = create("/repo");
    live.changedAt = NOW - DAY;
    live.activeAt = live.changedAt;
    expect(lastUsed("/repo")).toBe(NOW - 5 * DAY);
  });

  it("is outlived by the project's activity: a row changing, or a transcript written", () => {
    touch("/repo", NOW - 5 * DAY);
    sessions.history["/repo"] = [entry("b", NOW - 2 * DAY)];
    expect(lastActive("/repo")).toBe(NOW - 2 * DAY);
    const live = create("/repo");
    live.changedAt = NOW - DAY;
    live.activeAt = live.changedAt;
    expect(lastActive("/repo")).toBe(NOW - DAY);
  });

  it("dates a project by its latest turn, not by the entry written last", () => {
    // Written now, but its last turn was 30 days ago.
    const old = { ...entry("a", NOW), active: Math.floor((NOW - 30 * DAY) / 1000) };
    sessions.history["/repo"] = [old, entry("b", NOW - 2 * DAY)];
    expect(lastUsed("/repo")).toBe(NOW - 2 * DAY);
    expect(lastActive("/repo")).toBe(NOW - 2 * DAY);
  });

  // A row left from the last quit is drawn again at the start, which is no
  // use of the project: its transcript says when it was worked in.
  it("does not take a row left from the last quit as activity", () => {
    const left = reopened("/repo", "a", "claude-code", null, null, null);
    left.changedAt = NOW;
    expect(lastActive("/repo")).toBeNull();
  });

  // The record holds no project once it is closed, so it does not grow
  // with every project ever opened; a project still on its way in keeps
  // its own.
  it("forgets a project once it is closed, and only then", () => {
    workspace.open.push(
      { path: "/a", name: "a", repository: "/a", isGit: true },
      { path: "/b", name: "b", repository: "/b", isGit: true },
    );
    touch("/a", NOW - DAY);
    touch("/b", NOW - 2 * DAY);
    touch("/arriving", NOW - 3 * DAY);
    close("/a");
    expect(projects.used).toEqual({ "/b": NOW - 2 * DAY, "/arriving": NOW - 3 * DAY });
    expect(JSON.parse(localStorage.getItem("chord.used")!)).not.toHaveProperty("/a");
  });

  it("keeps when a project was filed between runs, until it is closed", () => {
    workspace.open.push({ path: "/a", name: "a", repository: "/a", isGit: true });
    file("/a", NOW);
    file("/b", NOW - DAY);
    projects.filed = {};
    loadUsed();
    expect(projects.filed).toEqual({ "/a": NOW, "/b": NOW - DAY });
    close("/a");
    expect(projects.filed).toEqual({ "/b": NOW - DAY });
    expect(JSON.parse(localStorage.getItem("chord.filed")!)).toEqual({ "/b": NOW - DAY });
  });

  // Only what the user does stamps a project: the window or an agent
  // bringing one forward does not.
  it("is stamped by the user alone, and kept between runs", async () => {
    workspace.open.push(
      { path: "/repo", name: "repo", repository: "/repo", isGit: true },
      { path: "/other", name: "other", repository: "/other", isGit: true },
    );
    activate("/repo");
    expect(projects.used).toEqual({});

    const row = create("/other");
    started(row.key, "pty-1", "s-1");
    goTo(row.key);
    const at = projects.used["/other"];
    expect(Date.now() - at).toBeLessThan(1000);
    expect(projects.used["/repo"]).toBeUndefined();
    await openPath("/repo");
    expect(projects.used["/repo"]).toBeGreaterThanOrEqual(at);

    projects.used = {};
    loadUsed();
    expect(projects.used["/other"]).toBe(at);

    localStorage.setItem("chord.used", "not json");
    projects.used = {};
    loadUsed();
    expect(projects.used).toEqual({});

    localStorage.setItem("chord.used", JSON.stringify({ "/a": 5, "/b": "soon" }));
    loadUsed();
    expect(projects.used).toEqual({ "/a": 5 });
  });
});

describe("active and inactive", () => {
  it("keeps a project active within the span, and folds it after", () => {
    touch("/repo", NOW - 6 * DAY);
    expect(isActive("/repo", null, NOW)).toBe(true);
    expect(isActive("/repo", null, NOW + 2 * DAY)).toBe(false);

    projects.inactiveAfter = "day";
    expect(isActive("/repo", null, NOW)).toBe(false);
    projects.inactiveAfter = "month";
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("keeps a project with a live or unread session active, however long ago it was used", () => {
    touch("/repo", NOW - 60 * DAY);
    expect(isActive("/repo", null, NOW)).toBe(false);

    const live = create("/repo");
    started(live.key, "pty-1", "s-1");
    live.changedAt = NOW - 60 * DAY;
    live.activeAt = live.changedAt;
    expect(isActive("/repo", null, NOW)).toBe(true);

    live.status = "exited";
    expect(isActive("/repo", null, NOW)).toBe(false);
    live.unread = true;
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("keeps the project on screen active, and every project with the span at never", () => {
    expect(isActive("/repo", "/repo", NOW)).toBe(true);
    expect(isActive("/repo", null, NOW)).toBe(false);
    projects.inactiveAfter = "never";
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("splits the projects, each half in the order chosen", () => {
    touch("/b", NOW - DAY);
    touch("/a", NOW - 2 * DAY);
    touch("/old-b", NOW - 20 * DAY);
    touch("/old-a", NOW - 30 * DAY);
    const paths = ["/old-a", "/a", "/b", "/never", "/old-b"];
    for (const path of paths) sessions.history[path] = [];

    expect(splitProjects(paths, null, "used", NOW)).toEqual({
      active: ["/b", "/a"],
      inactive: ["/old-b", "/old-a", "/never"],
    });
    expect(splitProjects(paths, null, "name", NOW)).toEqual({
      active: ["/a", "/b"],
      inactive: ["/never", "/old-a", "/old-b"],
    });
  });

  // Two checkouts of the same name sort by their paths, so the order
  // never flickers between them.
  it("breaks a tie by path", () => {
    expect(sortProjects(["/work/app", "/spike/app"], "name")).toEqual(["/spike/app", "/work/app"]);
    expect(sortProjects(["/work/app", "/spike/app"], "used")).toEqual(["/spike/app", "/work/app"]);
  });
});

describe("a project filed by hand", () => {
  it("is inactive within the span, until it is used again", () => {
    touch("/repo", NOW - DAY);
    expect(isActive("/repo", null, NOW)).toBe(true);
    file("/repo", NOW);
    expect(isActive("/repo", null, NOW)).toBe(false);
    expect(lastUsed("/repo")).toBe(NOW - DAY);

    touch("/repo", NOW + 1);
    expect(isActive("/repo", null, NOW + 1)).toBe(true);
    // The span counts from that activity as it does for any project.
    expect(isActive("/repo", null, NOW + 8 * DAY)).toBe(false);
  });

  it("is inactive with the span at never, until a row changes or a transcript is written", () => {
    projects.inactiveAfter = "never";
    file("/rows", NOW);
    file("/written", NOW);
    expect(isActive("/rows", null, NOW)).toBe(false);

    const row = create("/rows");
    row.status = "exited";
    row.changedAt = NOW - 1;
    row.activeAt = row.changedAt;
    expect(isActive("/rows", null, NOW)).toBe(false);
    row.changedAt = NOW + 1;
    row.activeAt = row.changedAt;
    expect(isActive("/rows", null, NOW + 1)).toBe(true);

    sessions.history["/written"] = [entry("a", NOW - DAY)];
    expect(isActive("/written", null, NOW)).toBe(false);
    sessions.history["/written"] = [entry("a", NOW + 1000)];
    expect(isActive("/written", null, NOW + 1000)).toBe(true);
  });

  it("stays active while on screen, or while a session under it is live or unread", () => {
    file("/repo", NOW);
    expect(isActive("/repo", "/repo", NOW)).toBe(true);
    const row = create("/repo");
    started(row.key, "pty-1", "s-1");
    row.changedAt = NOW - DAY;
    row.activeAt = row.changedAt;
    expect(holdsActive("/repo")).toBe(true);
    expect(isActive("/repo", null, NOW)).toBe(true);
    row.status = "exited";
    row.unread = true;
    expect(isActive("/repo", null, NOW)).toBe(true);
    row.unread = false;
    expect(isActive("/repo", null, NOW)).toBe(false);
  });

  // A machine whose clock runs ahead dates its transcripts after now.
  it("is inactive when its latest transcript is dated after now", () => {
    sessions.history["/repo"] = [entry("a", NOW + DAY)];
    file("/repo", NOW);
    expect(isActive("/repo", null, NOW)).toBe(false);
  });

  it("splits under inactive in the order chosen", () => {
    touch("/a", NOW - 2 * DAY);
    touch("/b", NOW - DAY);
    for (const path of ["/a", "/b"]) sessions.history[path] = [];
    file("/b", NOW);
    file("/a", NOW);
    expect(splitProjects(["/a", "/b"], null, "used", NOW)).toEqual({ active: [], inactive: ["/b", "/a"] });
  });

  const three = () => {
    for (const name of ["a", "b", "c"]) {
      workspace.open.push({ path: `/${name}`, name, repository: `/${name}`, isGit: true });
    }
  };

  it("leaves the front to the project last used, without using it again", () => {
    three();
    const now = Date.now();
    touch("/a", now - 2 * DAY);
    touch("/c", now - DAY);
    activate("/b");
    makeInactive("/b");
    expect(workspace.active).toBe("/c");
    expect(sessions.active).toBeNull();
    expect(projects.used).toEqual({ "/a": now - 2 * DAY, "/c": now - DAY });
    expect(isActive("/b", onScreen())).toBe(false);
    expect(JSON.parse(localStorage.getItem("chord.workspace")!).active).toBe("/c");

    makeInactive("/c");
    expect(workspace.active).toBe("/a");
  });

  it("keeps both filed when two are filed in a row", () => {
    three();
    workspace.open.pop();
    touch("/a", Date.now() - 2000);
    touch("/b", Date.now() - 1000);
    activate("/a");
    makeInactive("/a");
    expect(workspace.active).toBe("/b");
    makeInactive("/b");
    expect(workspace.active).toBeNull();
    expect(isActive("/a", onScreen())).toBe(false);
    expect(isActive("/b", onScreen())).toBe(false);
  });

  it("does not put a project the span folded in front", () => {
    three();
    touch("/a", Date.now() - 30 * DAY);
    touch("/c", Date.now() - 20 * DAY);
    activate("/b");
    makeInactive("/b");
    expect(workspace.active).toBeNull();
  });

  it("leaves the front where it is when it is not on screen", () => {
    three();
    activate("/a");
    makeInactive("/c");
    expect(workspace.active).toBe("/a");
  });

  it("leaves nothing in front when it is the only project", () => {
    workspace.open.push({ path: "/a", name: "a", repository: "/a", isGit: true });
    activate("/a");
    makeInactive("/a");
    expect(workspace.active).toBeNull();
    expect(workspace.open).toHaveLength(1);
    expect(isActive("/a", onScreen())).toBe(false);
  });
});

describe("the span setting", () => {
  it("is a week to begin with, and takes only a span it knows", () => {
    expect(inactiveAfterSettings()).toEqual({ inactiveAfter: "week" });
    adoptInactiveAfter("never");
    expect(projects.inactiveAfter).toBe("never");
    adoptInactiveAfter("fortnight");
    expect(projects.inactiveAfter).toBe("week");
  });

  it("is sent to the core when changed, and only then", () => {
    setInactiveAfter("week");
    expect(sent).toEqual([]);
    setInactiveAfter("month");
    expect(sent).toEqual([{ inactiveAfter: "month" }]);
    expect(projects.inactiveAfter).toBe("month");
  });
});

// A session an orchestrator started hangs under it, in the orchestrator's
// project: that is where it is drawn, and where it counts.
describe("a session hanging under its starter", () => {
  function hang(project: string) {
    const starter = create("/here");
    started(starter.key, "pty-1", "starter-1");
    const kid = create(project);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = starter.token;
    return { starter, kid };
  }

  it("keeps the project it is drawn under active, not the one it runs in", () => {
    touch("/here", NOW - 60 * DAY);
    touch("/there", NOW - 60 * DAY);
    const { starter, kid } = hang("/there");
    kid.changedAt = NOW;
    kid.activeAt = kid.changedAt;
    sessions.history["/there"] = [entry("kid-1", NOW)];

    expect(isActive("/there", null, NOW)).toBe(false);
    expect(lastActive("/there")).toBe(NOW - 60 * DAY);
    expect(isActive("/here", null, NOW)).toBe(true);

    starter.status = "exited";
    kid.needs = "permission";
    kid.unread = true;
    expect(isActive("/here", null, NOW)).toBe(true);
    expect(isActive("/there", null, NOW)).toBe(false);
  });

  // Its transcript is written in the project it runs in, and counts
  // toward the project it is drawn under.
  it("counts its transcript toward the project it is drawn under", () => {
    touch("/here", NOW - 60 * DAY);
    touch("/there", NOW - 60 * DAY);
    const { starter, kid } = hang("/there");
    starter.status = "dormant";
    kid.status = "dormant";
    kid.activeAt = null;
    starter.activeAt = null;
    sessions.history["/there"] = [entry("kid-1", NOW - DAY)];
    expect(lastActive("/here")).toBe(NOW - DAY);
    expect(isActive("/here", null, NOW)).toBe(true);
    expect(lastActive("/there")).toBe(NOW - 60 * DAY);
    expect(isActive("/there", null, NOW)).toBe(false);
  });

  // Picked, from the pane, the palette or the chord, it is on screen and
  // its starter's project is the one used, and the one the pane counts
  // as on screen.
  it("is picked into its starter's project", () => {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/there", name: "there", repository: "/there", isGit: true },
    );
    touch("/there", NOW - 60 * DAY);
    const { kid } = hang("/there");
    goTo(kid.key);
    expect(workspace.active).toBe("/there");
    expect(sessions.active).toBe(kid.key);
    expect(Date.now() - projects.used["/here"]).toBeLessThan(1000);
    expect(projects.used["/there"]).toBe(NOW - 60 * DAY);
    expect(onScreen()).toBe("/here");
  });

  // The project on screen is the one in front, but for a session on screen
  // that hangs under its starter in another project: then it is the
  // starter's, while the one in front stays the one the session runs in.
  it("puts its starter's project on screen while it is on screen", () => {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/there", name: "there", repository: "/there", isGit: true },
      { path: "/else", name: "else", repository: "/else", isGit: true },
    );
    expect(onScreen()).toBeNull();
    const { starter, kid } = hang("/there");
    activate("/there");
    sessions.active = kid.key;
    expect(workspace.active).toBe("/there");
    expect(onScreen()).toBe("/here");
    // Its starter on screen is its own project's.
    activate("/here");
    sessions.active = starter.key;
    expect(onScreen()).toBe("/here");
    // A project with no session on screen is itself.
    activate("/else");
    expect(sessions.active).toBeNull();
    expect(onScreen()).toBe("/else");
    // So is one whose session on screen hangs under nobody.
    const own = create("/there");
    activate("/there");
    sessions.active = own.key;
    expect(onScreen()).toBe("/there");
  });
});

// Only the user's pick of a session opens one, so nothing is read for them.
describe("bringing a project forward", () => {
  function three() {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/there", name: "there", repository: "/there", isGit: true },
    );
    const here = create("/here");
    started(here.key, "pty-1", "here-1");
    const there = create("/there");
    started(there.key, "pty-2", "there-1");
    there.unread = true;
    return { here, there };
  }

  it("opens no session, and leaves an unread one unread", () => {
    const { here, there } = three();
    goTo(here.key);
    bringForward("/there");
    expect(workspace.active).toBe("/there");
    expect(sessions.active).toBeNull();
    expect(there.unread).toBe(true);
    // Picked again with nothing on screen, it still opens none.
    bringForward("/there");
    expect(sessions.active).toBeNull();
  });

  it("keeps the session on screen when its own project is picked", () => {
    const { here } = three();
    const second = create("/here");
    goTo(here.key);
    bringForward("/here");
    expect(sessions.active).toBe(here.key);
    expect(sessions.active).not.toBe(second.key);
  });

  it("opens none for a project opened by its path", async () => {
    const { here, there } = three();
    goTo(here.key);
    await openPath("/there");
    expect(sessions.active).toBeNull();
    await openPath("/new");
    expect(workspace.active).toBe("/new");
    expect(sessions.active).toBeNull();
    expect(there.unread).toBe(true);
  });

  it("is what closing the project in front leaves the next one with", () => {
    const { here, there } = three();
    goTo(here.key);
    close("/here");
    expect(workspace.active).toBe("/there");
    expect(sessions.active).toBeNull();
    expect(there.unread).toBe(true);
  });
});

describe("the projects whose history is not read yet", () => {
  // Their transcripts may make them active: drawn under Inactive first,
  // they would move as soon as they were read.
  it("are in neither half until it is, unless active by what is known", () => {
    touch("/known", NOW - DAY);
    expect(splitProjects(["/known", "/unread"], null, "used", NOW)).toEqual({
      active: ["/known"],
      inactive: [],
    });
    sessions.history["/unread"] = [entry("t", NOW - 40 * DAY)];
    expect(splitProjects(["/known", "/unread"], null, "used", NOW)).toEqual({
      active: ["/known"],
      inactive: ["/unread"],
    });
  });
});

// The history clock ticks every minute. The projects in use are read on
// every tick, the inactive ones every five minutes, and all of them on
// the first tick after the window comes back into view.
describe("the histories the clock reads", () => {
  it("takes in the inactive projects every few minutes, and after a return", () => {
    touch("/active", NOW - DAY);
    touch("/old", NOW - 40 * DAY);
    const paths = ["/active", "/old"];
    expect(historyDue(paths, null, NOW)).toEqual(paths);
    expect(historyDue(paths, null, NOW + 60_000)).toEqual(["/active"]);
    expect(historyDue(paths, null, NOW + 4 * 60_000)).toEqual(["/active"]);
    expect(historyDue(paths, null, NOW + QUIET_EVERY)).toEqual(paths);
    expect(historyDue(paths, null, NOW + QUIET_EVERY + 60_000)).toEqual(["/active"]);
    readQuietNext();
    expect(historyDue(paths, null, NOW + QUIET_EVERY + 120_000)).toEqual(paths);
  });
});

describe("an order that holds still", () => {
  it("keeps what is drawn in place, drops what went and puts what came after what it follows", () => {
    expect(steady(["a", "b", "c"], ["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(steady(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
    expect(steady(["a", "b"], ["new", "b", "a"])).toEqual(["new", "a", "b"]);
    expect(steady(["a", "b"], ["b", "x", "a", "y"])).toEqual(["a", "y", "b", "x"]);
    expect(steady([], ["a", "b"])).toEqual(["a", "b"]);
  });
});

// The chord that goes to the next session needing you reaches a session
// in any project, and going there brings its project forward and in use.
describe("the next session that needs you", () => {
  it("is found whatever the project's last use, and brings it forward", () => {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/old", name: "old", repository: "/old", isGit: true },
    );
    activate("/here");
    touch("/old", Date.now() - 40 * DAY);
    const asking = create("/old");
    started(asking.key, "pty-1", "s-1");
    const own = create("/here");
    started(own.key, "pty-2", "s-2");
    asking.needs = "permission";
    asking.changedAt = Date.now() - 40 * DAY;
    asking.activeAt = asking.changedAt;

    expect(isActive("/old", workspace.active)).toBe(true);
    expect(nextNeedingYou()?.key).toBe(asking.key);
    goTo(asking.key);
    expect(workspace.active).toBe("/old");
    expect(Date.now() - (lastUsed("/old") ?? 0)).toBeLessThan(1000);
  });
});

describe("since", () => {
  it("says when, as short as a row's end can", () => {
    const at = new Date(2026, 10, 13, 12).getTime();
    expect(since(at - 20_000, at)).toBe("now");
    expect(since(at - 4 * 60_000, at)).toBe("4m");
    expect(since(at - 90 * 60_000, at)).toBe("1h");
    expect(since(at - 3 * DAY, at)).toBe("Tue");
    expect(since(at - 15 * DAY, at)).toBe("2w");
    expect(since(at - 45 * DAY, at)).toBe("1mo");
    expect(since(at - 400 * DAY, at)).toBe("1y");
    expect(since(at + 5000, at)).toBe("now");
  });
});

describe("the order of a project's rows", () => {
  it("is the latest activity first, a row left from the last quit by its transcript", () => {
    const first = create("/repo");
    const second = create("/repo");
    const left = reopened("/repo", "t-1", "claude-code", null, null, null);
    first.activeAt = NOW - 1000;
    second.activeAt = NOW - 5000;
    left.changedAt = NOW;
    sessions.history["/repo"] = [entry("t-1", NOW - DAY)];
    expect(byActivity([first, second, left]).map((row) => row.key)).toEqual([first.key, second.key, left.key]);
    expect(activeAt(left)).toBe(NOW - DAY);

    second.activeAt = NOW;
    expect(byActivity([first, second, left])[0].key).toBe(second.key);
  });
});

describe("what a row says", () => {
  it("names a model the way it is said", () => {
    expect(modelLabel("opus")).toBe("Opus");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("counts the folded tail on one quiet line", () => {
    expect(earlierLabel(26)).toBe("Earlier · 26");
  });
});
