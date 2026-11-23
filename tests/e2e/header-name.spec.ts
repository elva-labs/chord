import { expect, test } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

const AGENT = "section[data-pane='agent']";
const PROMPT = "Refactor the session scanner so that the slow start disappears for large workspaces everywhere";

test.describe("the name in the conversation header", () => {
  test("shows a name whole where the header has the room, and cuts it with an ellipsis where it has not", async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await startNew(page);
    await page.getByTestId("composer-input").fill(PROMPT);
    await page.keyboard.press("Enter");
    const title = page.locator(`${AGENT} > header .title`);
    await expect(title).toHaveText(PROMPT);
    const fits = () => title.evaluate((node) => node.scrollWidth <= node.clientWidth);

    await page.setViewportSize({ width: 1900, height: 900 });
    await expect.poll(fits).toBe(true);

    await page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(fits).toBe(false);
    expect(await title.evaluate((node) => getComputedStyle(node).textOverflow)).toBe("ellipsis");
  });
});
