import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, PROJECT, type GitFixture } from "./fake";

/**
 * A README's hero, an image of the repository in a paragraph aligned to the
 * centre, reads in the viewer as it does on GitHub: the image drawn from the
 * project at the width it was given, in the middle of the document, in
 * either look. An image wider than the viewer fits it in its own shape.
 */

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";
const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const ICON = readFileSync(new URL("../../docs/app-icon.png", import.meta.url));
const IMAGES = {
  "docs/app-icon.png": { mime: "image/png", data: ICON.toString("base64"), size: ICON.length },
};
const HERO = [
  '<p align="center">',
  '  <img src="docs/app-icon.png" width="128" height="128" alt="">',
  "</p>",
  "",
  "# Chord",
  "",
  '<img src="docs/app-icon.png" width="4000" alt="wide">',
].join("\n");

const FIXTURE: GitFixture = {
  status: [{ path: "README.md", status: "M", add: 1, del: 1, binary: false }],
  files: ["README.md"],
};

async function preview(page: Page, look: string, markdown: string) {
  await installFakeCore(page, { open: [PROJECT], fixture: FIXTURE, settings: { look } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  // The terminal look is the one the styles are written in, stamped as none.
  if (look === "terminal") await expect(page.locator("html")).not.toHaveAttribute("data-look");
  else await expect(page.locator("html")).toHaveAttribute("data-look", look);
  await page.evaluate(
    ([text, images]) => {
      const w = window as unknown as { __markdown?: string; __images?: unknown };
      w.__markdown = text;
      w.__images = images;
    },
    [markdown, IMAGES] as const,
  );
  await page.getByTestId("file-tree").getByText("README.md").first().click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("preview");
  await page.keyboard.press("Enter");
}

for (const look of ["modern", "terminal"]) {
  test(`draws this repository's README hero from its project at 128 by 128, ${look}`, async ({ page }) => {
    await preview(page, look, README);
    const document = page.getByTestId("media-document");
    await expect(document.getByRole("heading", { name: "Chord", exact: true })).toBeVisible();
    const image = document.locator('img[src^="data:image/png"]').first();
    await expect(image).toHaveJSProperty("complete", true);
    await expect(image).toHaveJSProperty("naturalWidth", 256);
    const box = (await image.boundingBox())!;
    expect(box.width).toBe(128);
    expect(box.height).toBe(128);
    const reads = await page.evaluate(
      () => (window as unknown as { __imageReads?: unknown[] }).__imageReads,
    );
    expect(reads).toContainEqual({ root: PROJECT, document: "README.md", file: "docs/app-icon.png" });
  });

  test(`centres a hero, and fits a wide image to the viewer in its shape, ${look}`, async ({ page }) => {
    await preview(page, look, HERO);
    const document = page.getByTestId("media-document");
    await expect(document.getByRole("heading", { name: "Chord" })).toBeVisible();
    await expect(document.locator("p > img")).toHaveJSProperty("complete", true);
    await expect(document.getByAltText("wide")).toHaveJSProperty("complete", true);
    // Read in one frame: the viewer may still be sliding in.
    const { area, hero, wide } = await document.evaluate((element) => {
      const box = (target: Element) => {
        const { x, width, height } = target.getBoundingClientRect();
        return { x, width, height };
      };
      return {
        area: box(element),
        hero: box(element.querySelector("p > img")!),
        wide: box(element.querySelector("img[alt='wide']")!),
      };
    });
    expect(hero.width).toBe(128);
    expect(hero.height).toBe(128);
    expect(Math.abs(hero.x + hero.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(1);
    expect(wide.width).toBeLessThanOrEqual(area.width);
    expect(wide.width).toBeGreaterThan(128);
    // The icon is square, so drawn in its own shape it is as tall as wide.
    expect(Math.abs(wide.height - wide.width)).toBeLessThanOrEqual(1);
  });
}
