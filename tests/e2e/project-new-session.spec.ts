import { expect, test, type Page } from "@playwright/test";
import { NO_WORKFLOW, PROJECT, installFakeCore, paletteChoice, startNew } from "./fake";

/**
 * Asking for a new session in a project starts nothing but the session
 * picked. Here each project has a session left open at the last quit,
 * which starts only once it is on screen: the one in front starts as the
 * window opens, and the other project's waits. Asking for a new session
 * in that other project opens the palette on that project's defaults and
 * leaves the session on screen where it is, so the one waiting there
 * never starts.
 */

const OTHER = "/home/ada/dev/other";
const MOD = "ControlOrMeta";

const head = (page: Page, name: string) =>
  page.getByTestId("project-head").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
const section = (page: Page, name: string) => page.getByTestId("project-section").filter({ has: head(page, name) });
/** The row of the session left open in the other project at the last quit. */
const leftOpen = (page: Page) => section(page, "other").getByTestId("session-row");
const order = (page: Page) => page.locator("[data-testid='project-head'] .name");

/** The row left open in the other project still waits, yellow. A row
    leaves that state the moment it is on screen, before its agent is
    spawned, so while another session holds the screen this rules out a
    spawn for it, then or later. */
async function stillWaiting(page: Page) {
  await expect(page.locator(".session.on")).toHaveCount(1);
  await expect(section(page, "other").locator(".session.on")).toHaveCount(0);
  await expect(section(page, "other").locator(".dot.dormant")).toHaveCount(1);
}

function spawned(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    ((window as unknown as { __spawns?: { session?: string }[] }).__spawns ?? []).map(
      (spawn) => spawn.session ?? null,
    ),
  );
}

async function open(page: Page, used?: Record<string, number>) {
  await installFakeCore(page, {
    open: [PROJECT, OTHER],
    agents: ["claude-code", "codex"],
    settings: NO_WORKFLOW,
    ...(used === undefined ? {} : { used }),
  });
  await page.addInitScript(
    ({ here, other }) => {
      if (localStorage.getItem("chord.open") !== null) return;
      localStorage.setItem(
        "chord.open",
        JSON.stringify({
          open: [
            { project: here, id: "on-screen", agent: "claude-code", startIn: null, model: null },
            { project: other, id: "left-open", agent: "claude-code", startIn: null, model: null },
          ],
          active: "on-screen",
        }),
      );
    },
    { here: PROJECT, other: OTHER },
  );
  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-state", "running");
  expect(await spawned(page)).toEqual(["on-screen"]);
}

const ready = (page: Page) => page.locator("[data-testid='palette-row'][data-kind='ready']");
const change = (page: Page) => page.locator("[data-testid='palette-row'][data-kind='change']");

/** The palette is open on the other project's defaults, and nothing else
    moved: the session on screen and its project are the ones from before,
    and the other project's session is still waiting. */
async function askingInOther(page: Page) {
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "new");
  await expect(ready(page)).toBeVisible();
  await expect(ready(page).getByTestId("palette-detail")).toHaveText("Claude Code");
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await expect(head(page, "other")).not.toHaveClass(/\bon\b/);
  await expect(section(page, "demo").locator(".session.on")).toHaveCount(1);
  await stillWaiting(page);
}

/** The defaults' row starts the new session alone, and it takes the screen. */
async function startInOther(page: Page) {
  await startNew(page);
  await expect.poll(() => spawned(page)).toHaveLength(2);
  expect(await spawned(page)).toEqual(["on-screen", null]);
  await expect(head(page, "other")).toHaveClass(/\bon\b/);
  await expect(section(page, "other").locator(".session.on .dot")).not.toHaveClass(/dormant/);
  await expect(leftOpen(page).locator(".dot.dormant")).toHaveCount(1);
}

test("a project's + opens the palette on its defaults and starts none of the project's sessions", async ({ page }) => {
  await open(page);
  await expect(leftOpen(page).locator(".dot")).toHaveClass(/dormant/);

  await head(page, "other").getByTestId("project-new-session").click();
  await askingInOther(page);
  await startInOther(page);
});

test("Change lists the agents, and the one picked starts alone", async ({ page }) => {
  await open(page);
  await head(page, "other").getByTestId("project-new-session").click();
  await askingInOther(page);
  await change(page).click();
  await expect(paletteChoice(page, "Claude Code")).toBeVisible();
  await expect(paletteChoice(page, "Codex")).toBeVisible();
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await stillWaiting(page);
  await paletteChoice(page, "Codex").click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => spawned(page)).toHaveLength(2);
  expect(await spawned(page)).toEqual(["on-screen", null]);
  await expect(head(page, "other")).toHaveClass(/\bon\b/);
  await expect(leftOpen(page).locator(".dot.dormant")).toHaveCount(1);
});

// Asking is not using the project: the list keeps its order once the
// pointer has left the pane, and backing out leaves it as it was.
test("backing out of the palette leaves everything as it was", async ({ page }) => {
  await open(page, { [PROJECT]: 0, [OTHER]: 3600 * 1000 });
  await expect(order(page)).toHaveText(["demo", "other"]);
  await head(page, "other").getByTestId("project-new-session").click();
  await askingInOther(page);
  await page.mouse.move(900, 450);
  await expect(order(page)).toHaveText(["demo", "other"]);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(order(page)).toHaveText(["demo", "other"]);
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await stillWaiting(page);
  expect(await spawned(page)).toEqual(["on-screen"]);
});

test("New session in a project's menu does what its + does", async ({ page }) => {
  await open(page);
  await head(page, "other").click({ button: "right" });
  await page.getByTestId("project-menu-new").click();
  await askingInOther(page);
  await startInOther(page);
});

test("New session in an inactive project's menu opens the palette on it and the project stays inactive until a session starts", async ({
  page,
}) => {
  await open(page, { [PROJECT]: 0, [OTHER]: 30 * 24 * 3600 * 1000 });
  await expect(head(page, "other")).toHaveCount(0);
  const inactive = page.getByTestId("inactive-project").filter({ hasText: "other" });
  await page.getByTestId("inactive-fold").click();
  await inactive.click({ button: "right" });
  await page.getByTestId("project-menu-new").click();

  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "new");
  await expect(ready(page).getByTestId("palette-detail")).toHaveText("Claude Code");
  await expect(section(page, "demo").locator(".session.on")).toHaveCount(1);
  expect(await spawned(page)).toEqual(["on-screen"]);

  // Nothing used it, so backing out leaves it under Inactive.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(head(page, "other")).toHaveCount(0);
  await expect(inactive).toBeVisible();
  expect(await spawned(page)).toEqual(["on-screen"]);

  await inactive.click({ button: "right" });
  await page.getByTestId("project-menu-new").click();
  await expect(ready(page)).toBeVisible();
  await startNew(page);
  await expect.poll(() => spawned(page)).toHaveLength(2);
  expect(await spawned(page)).toEqual(["on-screen", null]);
  await expect(head(page, "other")).toHaveClass(/\bon\b/);
});

test("New session in the palette leaves the session on screen until the new one starts", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("new session");
  await page.keyboard.press("Enter");
  await page.keyboard.type("other");
  await page.keyboard.press("Enter");

  // Asking for the defaults, nothing has moved yet.
  await askingInOther(page);
  await startInOther(page);
});
