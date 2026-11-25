import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A plugin's commands in the command palette: listed after the app's with
 * the plugin's name, found by what is typed after a `>` in go to, and told
 * to the plugin when picked. A pick the core refuses is said in the status
 * bar. In both looks, and following the project on screen.
 */

const MOD = "ControlOrMeta";

/** Set to a folder, the test leaves its screenshots there. */
const SHOTS = process.env.PLUGIN_PALETTE_SHOTS;

/** Another project open beside the first. */
const OTHER = "/home/ada/dev/other";

/** The commands a plugin sends for a project, the first unless named. */
async function pushCommands(page: Page, plugin: string, labels: string[], project = PROJECT) {
  await page.evaluate(
    ({ project, plugin, labels }) =>
      (window as unknown as { __pluginPalette: (event: unknown) => void }).__pluginPalette({
        source: "src-1",
        plugin,
        project,
        commands: labels.map((label, at) => ({ id: `c${at}`, label })),
      }),
    { project, plugin, labels },
  );
}

const picks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pluginPicks?: unknown[] }).__pluginPicks ?? []);

for (const look of ["modern", "terminal"] as const) {
  test.describe(`in the ${look} look`, () => {
    test.beforeEach(async ({ page }) => {
      await installFakeCore(page, { open: [PROJECT], settings: { look } });
      await page.goto("/");
      await expect(page.getByTestId("status-bar")).toBeVisible();
    });

    test("lists a plugin's command after a > in go to, and tells the plugin when it is picked", async ({ page }) => {
      await pushCommands(page, "github", ["Pull request overview", "Open settings"]);
      await page.keyboard.press(`${MOD}+P`);
      await page.keyboard.type(">pul");
      await expect(page.getByTestId("palette-prefix")).toBeVisible();
      const row = page.getByTestId("palette-row").filter({ hasText: "Pull request overview" });
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-kind", "plugin");
      await expect(row.getByTestId("palette-detail")).toHaveText("github");
      if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/palette-${look}.png` });

      // A label the app uses stays the app's.
      await page.getByTestId("palette-field").fill("open settings");
      await expect(page.getByTestId("palette-row").filter({ hasText: "Open settings" })).toHaveCount(1);
      await expect(page.locator("[data-testid='palette-row'][data-kind='plugin']")).toHaveCount(0);

      // The plugin's name finds its commands too.
      await page.getByTestId("palette-field").fill("github");
      await expect(row).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette")).toHaveCount(0);
      await expect.poll(() => picks(page)).toEqual([
        { source: "src-1", plugin: "github", command: "c0", project: PROJECT, session: null },
      ]);
    });

    test("says plainly when the plugin is not running", async ({ page }) => {
      await pushCommands(page, "explode", ["Blow up"]);
      await page.keyboard.press(`${MOD}+Shift+P`);
      await page.keyboard.type("blow");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("flash-readout")).toHaveText("Blow up: the explode plugin is not running");
    });

    test("drops a plugin's commands when it sends none", async ({ page }) => {
      await pushCommands(page, "github", ["Pull request overview"]);
      await pushCommands(page, "github", []);
      await page.keyboard.press(`${MOD}+Shift+P`);
      await page.keyboard.type("pul");
      await expect(page.locator("[data-testid='palette-row'][data-kind='plugin']")).toHaveCount(0);
    });
  });
}

test("lists the commands of the project on screen, and follows it to another", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT, OTHER] });
  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toBeVisible();
  await pushCommands(page, "github", ["Pull request overview"]);
  await pushCommands(page, "github", ["Issue board"], OTHER);
  const plugged = page.locator("[data-testid='palette-row'][data-kind='plugin']");

  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("github");
  await expect(plugged).toHaveText([/Pull request overview/]);
  await page.keyboard.press("Escape");

  await page.locator(`[data-row="project:${OTHER}"] .project-row`).click();
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("github");
  await expect(plugged).toHaveText([/Issue board/]);
  await page.keyboard.press("Enter");
  await expect.poll(() => picks(page)).toEqual([
    { source: "src-1", plugin: "github", command: "c0", project: OTHER, session: null },
  ]);
});
