import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

// A shortcut of two steps: Ctrl+X then S sends what waits now, a lone
// Ctrl+X in the composer still cuts, and the settings record a sequence.
// The page reports Linux whatever the machine, so Ctrl is the modifier
// throughout and a text field keeps Ctrl+X when it has a selection.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function calls(page: Page): Promise<{ method: string }[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls);
}

const input = (page: Page) => page.getByTestId("composer-input");
const queued = (page: Page) => page.locator("[data-testid='user-message'][data-state='queued']");

async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await expect(page.getByTestId("conversation")).toBeVisible();
}

/** A turn at work on a long command, with `waiting` sent behind it. */
async function busy(page: Page, ...waiting: string[]) {
  for (const text of ["go", ...waiting]) {
    await input(page).fill(text);
    await page.keyboard.press("Enter");
    if (text === "go") {
      await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
    }
  }
  await expect(queued(page)).toHaveCount(waiting.length);
}

test("sends every waiting message now on Ctrl+X then S, and types nothing", async ({ page }) => {
  await open(page);
  await busy(page, "first", "second");
  await input(page).focus();
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("flash-readout")).toHaveText("Ctrl+X, then…");
  await page.keyboard.press("s");
  await expect(queued(page)).toHaveCount(0);
  await expect(page.getByTestId("flash-readout")).toHaveText("");
  await expect(input(page)).toHaveValue("");
  expect((await calls(page)).filter((call) => call.method === "sendNow")).toHaveLength(1);
});

test("leaves Ctrl+X with text selected in the composer to cut it", async ({ page }) => {
  await open(page);
  await busy(page, "first");
  await input(page).fill("keep this, cut this");
  await input(page).evaluate((field: HTMLTextAreaElement) => {
    field.setSelectionRange(10, 19);
    (window as unknown as { cutKey?: boolean }).cutKey = undefined;
    field.addEventListener("keydown", (e) => {
      if (e.key === "x") (window as unknown as { cutKey?: boolean }).cutKey = e.defaultPrevented;
    });
  });
  await page.keyboard.press("Control+x");
  // The key reached the field with nothing done to it, and no sequence began.
  expect(await page.evaluate(() => (window as unknown as { cutKey?: boolean }).cutKey)).toBe(false);
  await expect(page.getByTestId("flash-readout")).toHaveText("");
  // S is a letter typed, not the end of a sequence.
  await page.keyboard.press("s");
  await expect(input(page)).toHaveValue("keep this,s");
  await expect(queued(page)).toHaveCount(1);
});

test("records a shortcut of two steps in the settings", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("flash-readout")).toHaveText("");
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-tab-keys").click();
  const row = page.getByTestId("chord-send.now");
  await expect(row).toHaveText("Ctrl+X S");
  await row.click();
  await expect(row).toHaveText(/Press keys/);
  await page.keyboard.press("Control+k");
  await expect(row).toHaveText("Ctrl+K, then…");
  await page.keyboard.press("d");
  await expect(row).toHaveText("Ctrl+K D");
  await expect(page.getByTestId("preset-custom")).toBeVisible();

  // A one-step chord that would begin it is refused, and says why.
  await page.getByTestId("chord-review").click();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("chord-problem")).toHaveText(/Ctrl\+K begins Ctrl\+K D, which is Send waiting messages now/);
});
