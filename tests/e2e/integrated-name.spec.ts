import { expect, test } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

const AGENT = "section[data-pane='agent']";

// A conversation's first message names its row by its first line with
// words, passing over a lone address, until the conversation's agent
// names it with its name tool; that name then holds.
test("a conversation's row takes the name its agent gives over the first words", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await page.getByTestId("composer-input").fill("https://example.com/crash.log\nWhy does it crash on start?");
  await page.keyboard.press("Enter");
  const row = page.getByTestId("session-row");
  await expect(row).toHaveAttribute("title", "Why does it crash on start?");

  const ask = (name: string) =>
    page.evaluate(
      ({ name, cwd }) => {
        const fake = window as unknown as {
          __integrated: { events: { type: string; sessionId?: string }[] };
          __nameRequest: (request: unknown) => void;
        };
        const session = fake.__integrated.events.find((event) => event.type === "ready")?.sessionId;
        fake.__nameRequest({ name, cwd, session });
      },
      { name, cwd: PROJECT },
    );
  await ask("Find the crash on start");
  await expect(row).toHaveAttribute("title", "Find the crash on start");
  await expect(page.locator(`${AGENT} > header .title`)).toHaveText("Find the crash on start");

  await ask("Something else");
  await expect(row).toHaveAttribute("title", "Find the crash on start");
});
