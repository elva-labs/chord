import { expect, test, type Page } from "@playwright/test";
import { NO_WORKFLOW, PROJECT, installFakeCore } from "./fake";

/**
 * Closing the session on screen leaves none selected and the agent pane on
 * its empty state. A session left open at the last quit, which starts once
 * it is on screen, is not put there by the close, so nothing is resumed.
 */

function spawned(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    ((window as unknown as { __spawns?: { session?: string }[] }).__spawns ?? []).map(
      (spawn) => spawn.session ?? null,
    ),
  );
}

/** Two rows in the project: a dormant one listed first, and the one on
    screen, started as the window opens. */
async function open(page: Page) {
  await installFakeCore(page, { open: [PROJECT], settings: NO_WORKFLOW });
  await page.addInitScript(
    ({ project }) => {
      if (localStorage.getItem("chord.open") !== null) return;
      localStorage.setItem(
        "chord.open",
        JSON.stringify({
          open: [
            { project, id: "left-open", agent: "claude-code", startIn: null, model: null },
            { project, id: "on-screen", agent: "claude-code", startIn: null, model: null },
          ],
          active: "on-screen",
        }),
      );
    },
    { project: PROJECT },
  );
  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-state", "running");
  expect(await spawned(page)).toEqual(["on-screen"]);
}

test("closing the session on screen shows the empty state and resumes nothing", async ({ page }) => {
  await open(page);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  const onScreen = page.locator(".session.on");
  await expect(onScreen).toHaveCount(1);
  await onScreen.hover();
  await onScreen.getByTestId("close-session").click();

  await expect(rows).toHaveCount(1);
  await expect(page.locator(".session.on")).toHaveCount(0);
  await expect(page.getByTestId("agent-status")).toContainText("No session open in");
  await expect(page.getByTestId("start-agent").first()).toBeVisible();
  await expect(page.locator("section[data-pane='agent'] [data-testid='terminal']")).toHaveCount(0);
  // The row left from the quit stays waiting; nothing is spawned for it.
  await expect(rows.locator(".dot.dormant")).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await spawned(page)).toEqual(["on-screen"]);
});

test("closing a session that is not on screen leaves the screen as it is", async ({ page }) => {
  await open(page);
  const left = page.getByTestId("session-row").filter({ has: page.locator(".dot.dormant") });
  await left.hover();
  await left.locator("..").getByTestId("close-session").click();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(page.locator(".session.on")).toHaveCount(1);
  await expect(page.getByTestId("agent-status")).toHaveCount(0);
});
