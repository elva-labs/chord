import { expect, test, type Page } from "@playwright/test";
import { PROJECT, columnsAtRest, installFakeCore, startNew } from "./fake";

/**
 * The folded sessions pane peeked over the agent while reviewing: when it
 * goes back. Runs in WebKit as well, the app's own webview on macOS.
 */

const SLOT = "[data-testid='sessions-slot']";
const SESSIONS = `${SLOT} section[data-pane='sessions']`;
const OTHER = "/home/ada/dev/other";
const MOD = "ControlOrMeta";

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT, OTHER] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await page.keyboard.press("Enter");
  await startNew(page);
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-state", "running");
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
});

/** Rests the pointer on the folded column until the pane peeks. */
async function peek(page: Page) {
  await expect(page.getByTestId("unfold-sessions")).toBeVisible();
  await columnsAtRest(page);
  const column = (await page.locator(SLOT).boundingBox())!;
  // From elsewhere: the pointer enters the column only by coming to it.
  await page.mouse.move(600, 400);
  await page.mouse.move(column.x + column.width / 2, column.y + column.height / 2, { steps: 3 });
  await expect(page.locator(SLOT)).toHaveClass(/\bpeeking\b/);
}

/** Moves the pointer onto the viewer, clear of the peeked pane, and presses. */
async function pressViewer(page: Page) {
  const viewer = (await page.getByTestId("viewer").boundingBox())!;
  const at = { x: viewer.x + viewer.width - 40, y: viewer.y + viewer.height / 2 };
  await page.mouse.move(at.x, at.y, { steps: 5 });
  // The pointer has left, and the keyboard holds the pane.
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-focus", "sessions");
  await expect(page.locator(SLOT)).toHaveClass(/\bpeeking\b/);
  await page.mouse.click(at.x, at.y);
}

async function gone(page: Page) {
  await expect(page.locator(SLOT)).not.toHaveClass(/\bpeeking\b/);
  await expect(page.getByTestId("unfold-sessions")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-focus", "changes");
}

const header = (page: Page, name: string) => page.locator(SESSIONS).getByText(name, { exact: true });

test("puts the pane back after another project is picked in it and the viewer pressed", async ({ page }) => {
  await peek(page);
  await header(page, "other").click();
  await expect(page.getByTestId("empty-said")).toHaveText("No session open in other.");
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  await pressViewer(page);
  await gone(page);
});

test("puts the pane back after the project on screen is picked in it and the viewer pressed", async ({ page }) => {
  await peek(page);
  await header(page, "demo").click();
  await pressViewer(page);
  await gone(page);
});

test("puts the pane back after a press on its blank space and then on the viewer", async ({ page }) => {
  await peek(page);
  const pane = (await page.locator(SESSIONS).boundingBox())!;
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height - 60);
  await pressViewer(page);
  await gone(page);
});

test("puts the pane back when a shortcut takes the keyboard out of it with the pointer elsewhere", async ({ page }) => {
  await page.keyboard.press(`${MOD}+1`);
  await expect(page.locator(SLOT)).toHaveClass(/\bpeeking\b/);
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-focus", "sessions");
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.locator(SLOT)).not.toHaveClass(/\bpeeking\b/);
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-focus", "changes");
});
