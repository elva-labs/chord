import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * The Agents settings page: the shipped agents and the ones installed for the
 * harnesses are read there, and the user's own are made, changed and removed
 * there, each change kept in the settings file.
 */

const AGENT = "section[data-pane='agent']";

const kept = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.agents, SETTINGS_FILE);

async function openAgents(page: Page) {
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByTestId("settings-tab-agents").click();
  await expect(page.getByTestId("settings-agents")).toBeVisible();
}

test("makes, changes and removes the user's own agent", async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await openAgents(page);
  const rows = page.getByTestId("agent-list").getByTestId("agent-row");
  await expect(rows).toHaveCount(8);

  await page.getByTestId("agent-new").click();
  await page.getByTestId("agent-save").click();
  await expect(page.getByTestId("agent-problem")).toHaveText("A title is needed.");
  await page.getByTestId("agent-title").fill("Migrations checker");
  await page.getByTestId("agent-description").fill("Checks migrations for locks.\n\nYou read each migration.");
  await page.getByTestId("agent-fold").click();
  await page.getByTestId("agent-files").selectOption("changes");
  await page.getByTestId("agent-save").click();

  const mine = page.locator("[data-agent='own:Migrations checker']");
  await expect(mine).toContainText("Checks migrations for locks.");
  await expect(rows).toHaveCount(9);
  await expect.poll(() => kept(page)).toEqual([
    {
      title: "Migrations checker",
      description: "Checks migrations for locks.\n\nYou read each migration.",
      model: { harness: "claude-code", model: "sonnet" },
      effort: "high",
      readsOnly: false,
    },
  ]);

  await mine.click();
  await page.getByTestId("agent-title").fill("Migrations");
  await page.getByTestId("agent-save").click();
  await expect(page.locator("[data-agent='own:Migrations']")).toBeVisible();
  await expect.poll(async () => (await kept(page))?.[0]?.title).toBe("Migrations");

  await page.locator("[data-agent='own:Migrations']").click();
  await page.getByTestId("agent-remove").click();
  await page.getByTestId("agent-remove-ask-confirm").click();
  await expect(rows).toHaveCount(8);
  await expect.poll(() => kept(page)).toEqual([]);
});

test("reads the shipped and installed agents without changing them", async ({ page }) => {
  await page.addInitScript((path) => {
    (window as unknown as { __installedAgents: unknown[] }).__installedAgents = [
      {
        source: "project",
        name: "release-notes",
        description: "Writes the release notes.",
        model: null,
        effort: null,
        readsOnly: true,
        text: "You write release notes from the merged pull requests.",
        path,
      },
    ];
  }, `${PROJECT}/.claude/agents/release-notes.md`);
  await installFakeCore(page);
  await page.goto("/");
  await openAgents(page);

  await page.locator("[data-agent='chord:Reviewer']").click();
  await expect(page.getByTestId("agent-text")).toContainText("Checks a change for bugs, design and fit.");
  await expect(page.getByTestId("agent-facts")).toHaveText(/Runs on Opus\s·\sHigh\s·\sReads only/);
  await expect(page.getByTestId("agent-whence")).toContainText("Chord ships this agent");
  await expect(page.getByTestId("agent-save")).toHaveCount(0);
  await page.getByTestId("agent-back").click();

  const installed = page.locator("[data-testid='agent-installed'][data-source='project']");
  await expect(installed).toContainText("Writes the release notes.");
  await installed.locator("[data-agent='project:release-notes']").click();
  await expect(page.getByTestId("agent-text")).toHaveText(
    "Writes the release notes.\n\nYou write release notes from the merged pull requests.",
  );
  await expect(page.getByTestId("agent-whence")).toContainText(".claude/agents/release-notes.md");
});
