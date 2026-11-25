import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A presented file from outside the project has a copy kept, shown once the
 * file is gone. A file gone with no copy comes off its row, and a row with
 * no file left goes.
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
  await expect(page.getByTestId("media-kept")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chord.media")))
    .toContain("/kept/1/shot.png");

  await goneNow(page, [OUTSIDE]);
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await row(page, "A shot.").getByTestId("media-item").click();
  await expect(image).toBeVisible();
  await expect(page.getByTestId("media-gone")).toHaveCount(0);
  const kept = page.getByTestId("media-kept");
  await expect(kept).toHaveText("· kept copy");
  await expect(kept.locator("..")).toHaveAttribute(
    "title",
    /The file was removed\. This is the copy taken when it was presented\./,
  );
  // On the name's line, after the name and inside the file's section.
  const [name, label, section] = await Promise.all(
    [
      kept.locator("..").locator("span").first(),
      kept,
      page.getByTestId("media-file"),
    ].map(async (part) => (await part.boundingBox())!),
  );
  expect(Math.abs(label.y - name.y)).toBeLessThan(1);
  expect(label.x).toBeGreaterThanOrEqual(name.x + name.width);
  expect(label.x + label.width).toBeLessThanOrEqual(section.x + section.width + 0.5);

  await goneNow(page, [OUTSIDE, "/kept/1/shot.png"]);
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await row(page, "A shot.").getByTestId("media-item").click();
  // The viewer says so, and the row goes by itself, its copy forgotten.
  await expect(page.getByTestId("media-gone")).toHaveText("This file is gone");
  await expect(page.getByTestId("media-section")).toHaveCount(0);
  await expect(page.getByTestId("media-gone")).toBeVisible();
  await expect(page.getByTestId("viewer")).not.toContainText("could not read");
  expect(await forgotten(page)).toEqual(["/kept/1/shot.png"]);
});

test("a row whose files are gone leaves the list by itself", async ({ page }) => {
  await present(page, [`${PROJECT}/shots/kept.png`], "Still here.");
  await present(page, [`${PROJECT}/shots/missing.png`], "Deleted since.");
  await openList(page);
  await expect(row(page, "Deleted since.")).toHaveCount(1);
  await expect(row(page, "Deleted since.")).toHaveCount(0);
  await expect(page.getByTestId("media-item")).toHaveCount(1);
  await expect(page.getByTestId("media-section")).toContainText("Media (1)");
  await expect(page.getByTestId("media-gone")).toHaveText("This file is gone");
});

test("a row from before copies were kept goes at startup", async ({ page }) => {
  await present(page, [`${PROJECT}/shots/kept.png`], "Still here.");
  await page.evaluate((project) => {
    const rows = JSON.parse(localStorage.getItem("chord.media")!);
    rows.push({
      ...rows[0],
      id: "old",
      files: ["/private/tmp/out/missing.png"],
      caption: "From last week.",
      copies: undefined,
    });
    localStorage.setItem("chord.media", JSON.stringify(rows));
  }, PROJECT);
  await page.reload();
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chord.media")))
    .not.toContain("From last week.");
});

test("a row with a file left drops the gone one", async ({ page }) => {
  await present(page, [`${PROJECT}/shots/kept.png`, `${PROJECT}/shots/missing.png`], "Two shots.");
  await openList(page);
  const meta = row(page, "Two shots.").locator(".media-meta");
  await expect(meta).toContainText("2 files");
  await expect(meta).toContainText("kept.png");
  await row(page, "Two shots.").getByTestId("media-item").click();
  await expect(page.getByTestId("media-file")).toHaveCount(1);
  await expect(page.getByTestId("media-file").locator("img")).toBeVisible();
});
