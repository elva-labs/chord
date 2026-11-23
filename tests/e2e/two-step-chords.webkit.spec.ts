import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

// The default shortcut of two steps under macOS rules: ⌃X then S sends what
// waits now from the composer. The page reports macOS whatever the machine.

const H = "int-1";

const input = (page: Page) => page.getByTestId("composer-input");
const queued = (page: Page) => page.locator("[data-testid='user-message'][data-state='queued']");

test("sends what waits on ⌃X then S under macOS rules", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "macOS rules hold in WebKit");
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await expect(page.getByTestId("conversation")).toBeVisible();

  for (const text of ["go", "first"]) {
    await input(page).fill(text);
    await page.keyboard.press("Enter");
    if (text === "go") {
      await page.evaluate(`(() => { const f = window.__integrated; f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" }); })()`);
    }
  }
  await expect(queued(page)).toHaveCount(1);

  await input(page).focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("flash-readout")).toHaveText("⌃X, then…");
  await page.keyboard.press("s");
  await expect(queued(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue("");
});
