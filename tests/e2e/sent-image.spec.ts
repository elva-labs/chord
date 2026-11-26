import { expect, test, type Page } from "@playwright/test";
import { PROJECT, columnsAtRest, installFakeCore, startNew } from "./fake";

// A picture the user sent opens at full size in the viewer beside the
// conversation, from the thumbnail in the message's bubble.

const AGENT = "section[data-pane='agent']";
const PNG = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" };

async function open(page: Page, images: number) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await page.evaluate(
    ({ images, png }) => {
      const f = (window as unknown as { __integrated: { send(...a: unknown[]): void; turn(...a: unknown[]): void } }).__integrated;
      for (let i = 0; i < 12; i++) {
        f.send("int-1", crypto.randomUUID(), `Question ${i}`);
        f.turn("int-1", `Answer ${i}`);
      }
      f.send("int-1", crypto.randomUUID(), "Look at these", Array.from({ length: images }, () => png));
      f.turn("int-1", "Seen.");
    },
    { images, png: PNG },
  );
  await expect(page.getByTestId("sent-image")).toHaveCount(images);
}

test("a click on a sent image opens it in the viewer and leaves the thread where it was", async ({ page }) => {
  await open(page, 3);
  const thumb = page.getByTestId("sent-image").nth(1);
  await expect(thumb).toHaveAttribute("aria-label", "Open image 2 of 3");
  await expect(thumb).toHaveCSS("cursor", "pointer");
  await expect(page.getByTestId("shell")).not.toHaveAttribute("data-mode", "reviewing");
  const before = await page.evaluate(() => document.querySelector("[data-testid='thread']")!.scrollTop);
  const top = (await thumb.boundingBox())!.y;
  await thumb.click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "picture");
  await expect(page.getByTestId("picture-caption")).toHaveText("Sent image 2 of 3");
  const shown = page.getByTestId("viewer-picture").locator("img");
  await expect(shown).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.locator(AGENT)).toBeVisible();
  // The viewer opening narrows the conversation; the thread is read where
  // that leaves it.
  await columnsAtRest(page);
  const after = await page.evaluate(() => document.querySelector("[data-testid='thread']")!.scrollTop);
  expect(after).toBe(before);
  expect(Math.abs((await thumb.boundingBox())!.y - top)).toBeLessThan(2);
});

test("a thumbnail opens with Enter and with Space", async ({ page }) => {
  await open(page, 1);
  const thumb = page.getByTestId("sent-image");
  await thumb.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "picture");
  await page.getByRole("button", { name: "Close the viewer" }).click();
  await expect(page.getByTestId("shell")).not.toHaveAttribute("data-mode", "reviewing");
  await thumb.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "picture");
  await expect(page.getByTestId("picture-caption")).toHaveText("Sent image");
});
