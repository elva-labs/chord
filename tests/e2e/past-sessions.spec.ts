import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";
const DAY = 24 * 60 * 60;

const file = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SETTINGS_FILE,
  );

/** Two sessions of the app's own on disk: one changed yesterday, one left
    for ten days. */
async function withTwo(page: Page, settings: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await installFakeCore(page, {
    open: [PROJECT],
    settings,
    transcripts: [
      { id: "fresh-1", modified: now - DAY, size: 100, title: "fresh work" },
      { id: "stale-1", modified: now - 10 * DAY, size: 100, title: "stale work" },
    ],
  });
  await page.addInitScript(
    ({ project }) => {
      localStorage.setItem(
        "chord.mine",
        JSON.stringify({ [project]: ["fresh-1", "stale-1"] }),
      );
    },
    { project: PROJECT },
  );
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test("lists every past session of its own until a span is chosen", async ({ page }) => {
  await withTwo(page);
  await expect(page.getByTestId("past-session")).toHaveCount(2);
  await expect(page.getByTestId("earlier-fold")).toHaveCount(0);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-sessions").click();
  await expect(page.getByTestId("past-sessions")).toHaveValue("forever");
  await page.getByTestId("past-sessions").selectOption("week");
  await expect.poll(async () => (await file(page)).pastSessions).toBe("week");
  await page.keyboard.press("Escape");

  // The stale one is behind the fold, counted there, and still ours to
  // bring back by widening the span.
  await expect(page.getByTestId("past-session")).toHaveCount(1);
  await expect(page.getByTestId("past-session")).toContainText("fresh work");
  await expect(page.getByTestId("earlier-fold")).toHaveText("Earlier · 1");

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-sessions").click();
  await page.getByTestId("past-sessions").selectOption("month");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("past-session")).toHaveCount(2);
});

test("reads the span from the machine's settings", async ({ page }) => {
  await withTwo(page, { pastSessions: "week" });
  await expect(page.getByTestId("past-session")).toHaveCount(1);
  await expect(page.getByTestId("earlier-fold")).toHaveText("Earlier · 1");
});

// The history clock reads the projects in use every minute, and the ones
// under Inactive every five, and all of them when the window comes back
// into view: work done outside the app in an inactive project wakes it.
test("reads an inactive project's history on a slower clock", async ({ page }) => {
  const OLD = "/home/ada/dev/old";
  await page.clock.install();
  await installFakeCore(page, {
    open: [PROJECT, OLD],
    used: { [PROJECT]: 0, [OLD]: 30 * DAY * 1000 },
  });
  await page.goto("/");
  await expect(page.getByTestId("inactive-fold")).toHaveText(/1 project/);
  const reads = () =>
    page.evaluate(() => (window as unknown as { __historyReads?: string[][] }).__historyReads?.flat() ?? []);
  const clear = () =>
    page.evaluate(() => {
      (window as unknown as { __historyReads?: string[][] }).__historyReads = [];
    });
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const blur = () => page.evaluate(() => window.dispatchEvent(new Event("blur")));

  await blur();
  await focus();
  await expect.poll(reads).toContain(OLD);
  await clear();
  await page.clock.runFor(61_000);
  await expect.poll(reads).toContain(PROJECT);
  expect(await reads()).not.toContain(OLD);
  await page.clock.runFor(5 * 60_000);
  await expect.poll(reads).toContain(OLD);

  await clear();
  await blur();
  await focus();
  await expect.poll(reads).toContain(OLD);
});

// Under a project come the sessions running, the ones left open at the
// last quit, and then the past ones, each kind latest first and every name
// starting at one edge. The tail of the quiet rows waits behind a fold;
// open, the fold stays where it was with those rows under it, and closes
// them away again.
test("lists the past sessions last, behind a fold that opens and closes", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const HOUR = 60 * 60;
  const rows: [string, number][] = [
    ["in-front", 0],
    ["left-1", 1],
    ["past-1", 2],
    ["left-2", 3],
    ["past-2", 4],
    ["left-3", 5],
  ];
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: rows.map(([id, hours]) => ({ id, modified: now - hours * HOUR, size: 100, title: id })),
  });
  await page.addInitScript(
    ({ project, ids }) => {
      if (localStorage.getItem("chord.open") !== null) return;
      localStorage.setItem("chord.mine", JSON.stringify({ [project]: ids }));
      localStorage.setItem(
        "chord.open",
        JSON.stringify({
          open: ids
            .filter((id: string) => !id.startsWith("past"))
            .map((id: string) => ({ project, id, agent: "claude-code", startIn: null, model: null })),
          active: "in-front",
        }),
      );
    },
    { project: PROJECT, ids: rows.map(([id]) => id) },
  );
  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-state", "running");

  const fold = page.getByTestId("earlier-fold");
  await expect(fold).toHaveText("Earlier · 3");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("past-session")).toHaveCount(0);

  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("past-session")).toHaveCount(2);
  // Read once the rows have finished coming in, not while they move.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((motion) => motion.playState === "running" && motion.effect?.getTiming().iterations !== Infinity)
            .length,
      ),
    )
    .toBe(0);
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row^='session:'], [data-row^='past:'], [data-row^='more:']")].map((row) => {
      const name = row.querySelector(".label, .fold-text")!;
      return {
        name: name.textContent!.trim(),
        left: name.getBoundingClientRect().left,
        top: row.getBoundingClientRect().top,
      };
    }),
  );
  expect(drawn.map((row) => row.name)).toEqual([
    "in-front",
    "left-1",
    "left-2",
    "Earlier · 3",
    "left-3",
    "past-1",
    "past-2",
  ]);
  for (let at = 1; at < drawn.length; at += 1) expect(drawn[at].top).toBeGreaterThan(drawn[at - 1].top);
  const names = drawn.filter((row) => !row.name.startsWith("Earlier"));
  for (const row of names) expect(row.left).toBeCloseTo(names[0].left, 0);

  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("past-session")).toHaveCount(0);
  await expect(page.getByTestId("session-row")).toHaveCount(3);
});

// The fold counts the sessions this window does not list as well. Open, it
// ends on a row that opens the dialog to resume them from.
for (const look of ["modern", "terminal"] as const) {
  test(`counts the sessions the window does not list, and opens the resume dialog from the fold, in the ${look} look`, async ({ page }) => {
    const now = Math.floor(Date.now() / 1000);
    const HOUR = 60 * 60;
    const own = ["in-front", "left-1", "past-1", "left-2", "past-2", "left-3"];
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { look },
      transcripts: [...own, "elsewhere-1"].map((id, hours) => ({
        id,
        modified: now - hours * HOUR,
        size: 100,
        title: id,
      })),
    });
    await page.addInitScript(
      ({ project, ids }) => {
        if (localStorage.getItem("chord.open") !== null) return;
        localStorage.setItem("chord.mine", JSON.stringify({ [project]: ids }));
        localStorage.setItem(
          "chord.open",
          JSON.stringify({
            open: ids
              .filter((id: string) => !id.startsWith("past"))
              .map((id: string) => ({ project, id, agent: "claude-code", startIn: null, model: null })),
            active: "in-front",
          }),
        );
      },
      { project: PROJECT, ids: own },
    );
    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toHaveAttribute("data-state", "running");

    const fold = page.getByTestId("earlier-fold");
    await expect(fold).toHaveText("Earlier · 4");
    await expect(page.getByTestId("earlier-sessions")).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("earlier-sessions")).toHaveText("1 more from before…");
    // Both lines sit in a session row's columns: the glyph centred under
    // the dots, the words where the names start.
    const dot = await page.locator("[data-ordinal] .dot").first().boundingBox();
    const name = await page.locator("[data-ordinal] .first .label").first().boundingBox();
    for (const line of [fold, page.getByTestId("earlier-sessions")]) {
      const glyph = await line.locator(".chev").boundingBox();
      const words = await line.locator(".fold-text").boundingBox();
      expect(Math.abs(glyph!.x + glyph!.width / 2 - (dot!.x + dot!.width / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(words!.x - name!.x)).toBeLessThanOrEqual(1);
    }
    await page.getByTestId("earlier-sessions").click();
    await expect(page.getByTestId("resume")).toBeVisible();
    await expect(page.getByTestId("resume-filter")).toBeFocused();
  });
}

test("resumes a past session in the worktree the app made for it as its own", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const tree = `${PROJECT}/.claude/worktrees/fix-it`;
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [
      { id: "made-1", modified: now - DAY, size: 100, title: "made for it", cwd: tree },
      { id: "visit-1", modified: now - 2 * DAY, size: 100, title: "only ran there", cwd: tree },
    ],
  });
  await page.addInitScript(
    ({ project, tree }) => {
      localStorage.setItem("chord.mine", JSON.stringify({ [project]: ["made-1", "visit-1"] }));
      localStorage.setItem("chord.trees", JSON.stringify({ starter: [{ project, path: tree, id: "made-1" }] }));
    },
    { project: PROJECT, tree },
  );
  await page.goto("/");
  await expect(page.getByTestId("past-session")).toHaveCount(2);

  const spawned = () =>
    page.evaluate(() =>
      ((window as unknown as { __spawns?: { session?: string; cwd?: string; madeWorktree?: boolean }[] }).__spawns ?? []).map(
        ({ session, cwd, madeWorktree }) => ({ session, cwd, madeWorktree: madeWorktree === true }),
      ),
    );
  await page.getByTestId("past-session").filter({ hasText: "made for it" }).click();
  await expect.poll(spawned).toEqual([{ session: "made-1", cwd: tree, madeWorktree: true }]);
  await page.getByTestId("past-session").filter({ hasText: "only ran there" }).click();
  await expect.poll(async () => (await spawned()).at(-1)).toEqual({ session: "visit-1", cwd: tree, madeWorktree: false });
});

// A row left from the last quit whose conversation went on from its notes
// comes back under the new conversation's id, and is still called by the
// name it had; one nothing names reads New session, never shown by its id.
test("names a row left from the last quit by the conversation it went on from, and reads New session for one nothing names", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [
      { id: "aaaa1111-went-on", modified: now - 60, size: 100, title: "Pick this up from the notes" },
      { id: "bbbb2222-first", modified: now - 3600, size: 100, title: "Login flow rework" },
    ],
  });
  await page.addInitScript(
    ({ project }) => {
      if (localStorage.getItem("chord.open") !== null) return;
      const ids = ["aaaa1111-went-on", "cccc3333-nameless"];
      localStorage.setItem("chord.mine", JSON.stringify({ [project]: ids }));
      localStorage.setItem("chord.wentOn", JSON.stringify({ "aaaa1111-went-on": "bbbb2222-first" }));
      localStorage.setItem(
        "chord.open",
        JSON.stringify({
          open: ids.map((id) => ({ project, id, agent: "claude-code", startIn: null, model: null })),
          active: null,
        }),
      );
    },
    { project: PROJECT },
  );
  await page.goto("/");
  const labels = page.locator("[data-testid='session-row'] .label");
  await expect(labels).toHaveCount(2);
  await expect(labels.filter({ hasText: "Login flow rework" })).toBeVisible();
  await expect(labels.filter({ hasText: /^New session$/ })).toBeVisible();
  await expect(page.locator("[data-testid='session-row']").filter({ hasText: /aaaa1111|bbbb2222|cccc3333/ })).toHaveCount(0);
});
