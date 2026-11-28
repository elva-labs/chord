import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A menu in the sessions pane keeps its natural width and stands whole
 * inside the window at the pane's least width, over the pane to the right
 * where it is wider than its own.
 */

/** The sessions pane at its least width, with a session whose menu holds a
    long item. */
async function narrow(page: Page) {
  const now = Math.floor(Date.now() / 1000);
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [{ id: "past-1", modified: now - 7200, size: 100, title: "Count things" }],
  });
  await page.addInitScript((project) => {
    localStorage.setItem("chord.layout", JSON.stringify({ sessions: 180 }));
    localStorage.setItem("chord.mine", JSON.stringify({ [project]: ["past-1"] }));
    (window as unknown as { __goingOn: unknown }).__goingOn = {
      context: 309_000,
      idle: 7200,
      goesOn: true,
      briefing: "Briefing.",
    };
  }, PROJECT);
  await page.goto("/");
  await page.getByTestId("past-session").click();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  const pane = (await page.locator("section[data-pane='sessions']").boundingBox())!;
  expect(pane.width).toBeLessThanOrEqual(180);
}

/** The menu whole inside the window, and every item drawn where it stands:
    nothing cuts it off or lies over it. */
async function whole(page: Page, menu: Locator) {
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  const hidden = await menu.locator("[role^='menuitem']").evaluateAll((items) =>
    items.flatMap((item) => {
      const at = item.getBoundingClientRect();
      const y = at.top + at.height / 2;
      const seen = [at.left + 1, at.right - 1].every((x) => item.contains(document.elementFromPoint(x, y)));
      return seen && item.scrollWidth <= item.clientWidth ? [] : [item.textContent?.trim()];
    }),
  );
  expect(hidden).toEqual([]);
}

test("a session's menu with a long item is whole in a narrow pane", async ({ page }) => {
  await narrow(page);
  await page.getByTestId("session-row").click({ button: "right" });
  await expect(page.getByTestId("session-menu-whole")).toHaveText("Resume whole, reads 309k tokens");
  await whole(page, page.getByTestId("session-menu"));
});

test("a session's menu opened upwards at the window's foot is whole in a narrow pane", async ({ page }) => {
  await narrow(page);
  const row = page.getByTestId("session-row");
  const at = (await row.boundingBox())!;
  await page.setViewportSize({ width: 900, height: 560 });
  // The tree ends just under the row, so its menu opens over it.
  await page.addStyleTag({ content: `[data-testid="sessions-nav"] > .tree { max-height: ${at.height * 8}px; }` });
  await row.evaluate((element) => {
    const tree = element.closest<HTMLElement>(".tree")!;
    const spacer = document.createElement("div");
    spacer.style.height = `${tree.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom - 4}px`;
    spacer.style.flex = "none";
    tree.prepend(spacer);
  });
  await row.click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await whole(page, menu);
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual((await row.boundingBox())!.y + 1);
});

test("the project's, the sort's and the pane's menus are whole in a narrow pane", async ({ page }) => {
  await narrow(page);
  const header = page.locator(`[data-row='project:${PROJECT}']`);
  await header.hover();
  await header.getByTestId("project-more").click();
  await whole(page, page.getByTestId("project-menu"));
  await page.keyboard.press("Escape");
  await page.getByTestId("project-sort").click();
  await whole(page, page.getByTestId("project-sort-menu"));
  await page.keyboard.press("Escape");
  await page.getByTestId("sessions-menu").click();
  await whole(page, page.getByTestId("sessions-menu-items"));
});

test("a session's menu goes as the keyboard leaves the pane for a palette", async ({ page }) => {
  await narrow(page);
  await page.getByTestId("session-row").click({ button: "right" });
  await expect(page.getByTestId("session-menu")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("session-menu")).toHaveCount(0);
});
