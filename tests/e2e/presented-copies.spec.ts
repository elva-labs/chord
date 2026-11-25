import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A presented file from outside the project has a copy kept, shown once the
 * file is gone. A row with nothing left to show says so and can be removed.
 * The fake core keeps a copy as `/kept/<n>/<name>`, and a file is gone when
 * its path is in `__gone` or has "missing" in it.
 */

const OUTSIDE = "/private/tmp/out/shot.png";

async function present(page: Page, files: string[], caption: string) {
  await page.evaluate(
    (request) =>
      (window as unknown as { __presentRequest: (request: unknown) => void }).__presentRequest(
        request,
      ),
    { files, caption, cwd: PROJECT },
  );
}

/** The list's fold starts shut. */
async function openList(page: Page) {
  const fold = page.getByRole("button", { name: /Media \(/ });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
}

async function goneNow(page: Page, files: string[]) {
  await page.evaluate((files) => {
    (window as unknown as { __gone: string[] }).__gone = files;
  }, files);
}

const forgotten = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forgotten?: string[] }).__forgotten ?? []);

const row = (page: Page, caption: string) =>
  page.locator("li", { has: page.getByTestId("media-item") }).filter({ hasText: caption });

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__presentRequest" in window))
    .toBe(true);
});

test("shows the copy once the file is gone, and says so once both are", async ({ page }) => {
  await present(page, [OUTSIDE], "A shot.");
  await openList(page);
  const image = page.getByTestId("media-file").locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chord.media")))
    .toContain("/kept/1/shot.png");

  await goneNow(page, [OUTSIDE]);
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await row(page, "A shot.").getByTestId("media-item").click();
  await expect(image).toBeVisible();
  await expect(page.getByTestId("media-gone")).toHaveCount(0);
  await expect(page.getByTestId("media-remove")).toHaveCount(0);

  await goneNow(page, [OUTSIDE, "/kept/1/shot.png"]);
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await row(page, "A shot.").getByTestId("media-item").click();
  await expect(page.getByTestId("media-gone")).toHaveText("This file is gone");
  await expect(row(page, "A shot.").getByTestId("media-item-gone")).toBeVisible();
});

test("a gone row says so and is removed by its button", async ({ page }) => {
  await present(page, [`${PROJECT}/shots/kept.png`], "Still here.");
  await present(page, [`${PROJECT}/shots/missing.png`], "Deleted since.");
  await openList(page);
  const gone = row(page, "Deleted since.");
  await expect(gone.getByTestId("media-item-gone")).toHaveText("This file is gone");
  await expect(page.getByTestId("media-gone")).toHaveText("This file is gone");
  await expect(page.getByTestId("viewer")).not.toContainText("could not read");
  await expect(row(page, "Still here.").getByTestId("media-remove")).toHaveCount(0);

  // The button is in view without the pointer, inside its row, clear of
  // the words.
  const remove = gone.getByTestId("media-remove");
  await expect(remove).toBeVisible();
  await expect(remove.locator("..")).toHaveCSS("opacity", "1");
  const [button, whole, words] = await Promise.all(
    [remove, gone, gone.getByTestId("media-item-gone")].map(async (part) => (await part.boundingBox())!),
  );
  expect(button.x + button.width).toBeLessThanOrEqual(whole.x + whole.width + 0.5);
  expect(button.y).toBeGreaterThanOrEqual(whole.y - 0.5);
  expect(button.y + button.height).toBeLessThanOrEqual(whole.y + whole.height + 0.5);
  const text = await gone.getByTestId("media-item-gone").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().right;
  });
  expect(words.x).toBeLessThan(button.x);
  expect(text).toBeLessThanOrEqual(button.x);

  await remove.click();
  await expect(page.getByTestId("media-item")).toHaveCount(1);
  await expect(page.getByTestId("media-stack")).toHaveCount(0);
});

test("removing a gone row forgets its copy", async ({ page }) => {
  await present(page, [OUTSIDE], "A shot.");
  await openList(page);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chord.media")))
    .toContain("/kept/1/shot.png");
  await goneNow(page, [OUTSIDE, "/kept/1/shot.png"]);
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await row(page, "A shot.").getByTestId("media-item").click();
  await row(page, "A shot.").getByTestId("media-remove").click();
  await expect(page.getByTestId("media-section")).toHaveCount(0);
  expect(await forgotten(page)).toEqual(["/kept/1/shot.png"]);
});

test("Delete on a gone row under the cursor removes it", async ({ page }) => {
  await present(page, [`${PROJECT}/shots/kept.png`], "Still here.");
  await present(page, [`${PROJECT}/shots/missing.png`], "Deleted since.");
  await openList(page);
  await expect(row(page, "Deleted since.").getByTestId("media-item-gone")).toBeVisible();
  // A press on the row puts the cursor on it, with the keyboard in the tree.
  await page.getByTestId("file-tree").focus();
  await row(page, "Still here.").getByTestId("media-item").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("media-item")).toHaveCount(2);
  await row(page, "Deleted since.").getByTestId("media-item").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("media-item")).toHaveCount(1);
});
