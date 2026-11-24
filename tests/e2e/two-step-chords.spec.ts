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

async function open(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], ...settings } });
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

/** Watches whether the composer's next Ctrl+X reaches it untouched. */
async function watchCut(page: Page) {
  await input(page).evaluate((field: HTMLTextAreaElement) => {
    (window as unknown as { cutKey?: boolean }).cutKey = undefined;
    field.addEventListener("keydown", (e) => {
      if (e.key === "x") (window as unknown as { cutKey?: boolean }).cutKey = e.defaultPrevented;
    });
  });
}

const cutKey = (page: Page) => page.evaluate(() => (window as unknown as { cutKey?: boolean }).cutKey);

// A table that holds Send waiting messages now as Ctrl+X alone, as a build
// that kept only a sequence's first step would leave it, reads as the
// default, so Ctrl+X still cuts.
test("reads a table holding Ctrl+X alone for send now as the default", async ({ page }) => {
  await open(page, { keys: { "send.now": { key: "x", shift: false, alt: false } } });
  await busy(page, "first");
  await input(page).fill("keep this, cut this");
  await input(page).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(10, 19));
  await watchCut(page);
  await page.keyboard.press("Control+x");
  expect(await cutKey(page)).toBe(false);
  await expect(page.getByTestId("flash-readout")).toHaveText("");
  await expect(queued(page)).toHaveCount(1);
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-tab-keys").click();
  await expect(page.getByTestId("chord-send.now")).toHaveText("Ctrl+X S");
});

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

test("sends on Ctrl+X then Ctrl+S too, with Ctrl held", async ({ page }) => {
  await open(page);
  await busy(page, "first");
  await input(page).focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("x");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await expect(queued(page)).toHaveCount(0);
  expect((await calls(page)).filter((call) => call.method === "sendNow")).toHaveLength(1);
});

test("says why in the status bar when nothing can be sent now", async ({ page }) => {
  await open(page);
  await input(page).fill("draft");
  await page.keyboard.press("Control+x");
  await page.keyboard.press("s");
  await expect(page.getByTestId("flash-readout")).toHaveText("No message waits");
  await expect(input(page)).toHaveValue("draft");
});

test("leaves Ctrl+X with text selected in the composer to cut it", async ({ page }) => {
  await open(page);
  await busy(page, "first");
  await input(page).fill("keep this, cut this");
  await input(page).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(10, 19));
  await watchCut(page);
  await page.keyboard.press("Control+x");
  // The key reached the field with nothing done to it, and no sequence began.
  expect(await cutKey(page)).toBe(false);
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
  // The action it was refused for is named in the problem's colour.
  const colour = (testid: string, inner: string) =>
    page.getByTestId(testid).evaluate((el, inner) => {
      const node = inner === "" ? el : el.closest(".s-row")!.querySelector(inner)!;
      return getComputedStyle(node).color;
    }, inner);
  expect(await colour("chord-review", ".s-name")).toBe(await colour("chord-problem", ""));
});

test("shows no problem while a second key may follow, and ends the recording on Tab or Ctrl+W", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-tab-keys").click();
  const review = page.getByTestId("chord-review");

  // Ctrl+X alone would begin Send waiting messages now, but D makes it whole.
  await review.click();
  await page.keyboard.press("Control+x");
  await expect(review).toHaveText("Ctrl+X, then…");
  await expect(page.getByTestId("chord-problem")).toHaveCount(0);
  await page.keyboard.press("d");
  await expect(review).toHaveText("Ctrl+X D");
  await expect(page.getByTestId("chord-problem")).toHaveCount(0);

  // Tab is no second step: the chord stays alone and the keyboard moves on.
  await review.click();
  await page.keyboard.press("Control+g");
  await page.keyboard.press("Tab");
  await expect(review).toHaveText("Ctrl+G");
  await expect(review).not.toBeFocused();

  // Nor is Ctrl+W, which closes the settings as it always does.
  await review.click();
  await page.keyboard.press("Control+u");
  await page.keyboard.press("Control+w");
  await expect(page.getByTestId("settings")).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-tab-keys").click();
  await expect(page.getByTestId("chord-review")).toHaveText("Ctrl+U");
});
