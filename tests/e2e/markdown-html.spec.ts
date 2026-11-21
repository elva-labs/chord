import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, PROJECT, type GitFixture } from "./fake";

/**
 * A README's hero, an image in a paragraph aligned to the centre, reads in
 * the viewer as it does on GitHub: the image at the width it was given,
 * in the middle of the document, in either look.
 */

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";
const ICON = "https://example.com/icon.png";
const HERO = `<p align="center">\n  <img src="${ICON}" width="128" height="128" alt="">\n</p>\n\n# Chord\n`;
/** A one-pixel PNG, what the address serves. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const FIXTURE: GitFixture = {
  status: [{ path: "README.md", status: "M", add: 1, del: 1, binary: false }],
  files: ["README.md"],
};

async function preview(page: Page, look: string) {
  await page.route(ICON, (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  await installFakeCore(page, { open: [PROJECT], fixture: FIXTURE, settings: { look } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  // The terminal look is the one the styles are written in, stamped as none.
  if (look === "terminal") await expect(page.locator("html")).not.toHaveAttribute("data-look");
  else await expect(page.locator("html")).toHaveAttribute("data-look", look);
  await page.evaluate((text) => {
    (window as unknown as { __markdown?: string }).__markdown = text;
  }, HERO);
  await page.getByTestId("file-tree").getByText("README.md").first().click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("preview");
  await page.keyboard.press("Enter");
}

for (const look of ["modern", "terminal"])
  test(`draws a README's hero as a centred image of its width, ${look}`, async ({ page }) => {
    await preview(page, look);
    const document = page.getByTestId("media-document");
    await expect(document.getByRole("heading", { name: "Chord" })).toBeVisible();
    const image = document.locator("p > img");
    await expect(image).toHaveJSProperty("complete", true);
    await expect(image).toHaveJSProperty("naturalWidth", 1);
    const box = (await image.boundingBox())!;
    const area = (await document.boundingBox())!;
    expect(box.width).toBe(128);
    expect(box.height).toBe(128);
    expect(Math.abs(box.x + box.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(1);
  });
