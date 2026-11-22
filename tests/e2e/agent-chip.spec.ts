import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

// The composer's agent chip: a list of agents beside the model, effort
// and mode, which runs the session as the one picked from the next
// message, and the lock the mode chip shows while it reads only.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

type Call = { method: string; text?: string; settings?: Record<string, unknown> };

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls);
}

/** Three agents installed in the project, past the eight shipped. */
async function open(page: Page) {
  await page.addInitScript((project) => {
    (window as unknown as { __installedAgents: unknown[] }).__installedAgents = ["triage", "release-notes", "migrator"].map(
      (name) => ({
        source: "project",
        name,
        description: `The ${name} agent.`,
        model: null,
        effort: null,
        readsOnly: false,
        text: `You do ${name}.`,
        path: `${project}/.claude/agents/${name}.md`,
      }),
    );
  }, PROJECT);
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

const chip = (page: Page, which: string) => page.locator(`[data-testid='${which}-chip']:visible`);
const names = (page: Page) => page.getByTestId("agent-menu").getByRole("menuitemradio").locator(".name");

async function openAgents(page: Page) {
  await chip(page, "more").click();
  await page.getByTestId("more-option").filter({ hasText: "Agent" }).click();
  await expect(page.getByTestId("agent-menu")).toBeVisible();
}

test("lists the agents before the first message, narrows them as the user types, and runs the session as the one picked", async ({
  page,
}) => {
  await open(page);
  await openAgents(page);
  await expect(page.getByTestId("agent-menu-heading")).toHaveText("Agents");
  await expect(names(page)).toHaveCount(9);
  await expect(names(page).first()).toHaveText("No agent");
  await expect(page.getByTestId("agent-menu-said")).toHaveText("3 more");
  await expect(page.getByTestId("agent-option").filter({ hasText: "Reviewer" }).first().getByTestId("agent-option-lock")).toBeVisible();
  await expect(page.getByTestId("agent-option").filter({ hasText: "Developer" }).getByTestId("agent-option-lock")).toHaveCount(0);
  await expect(page.getByTestId("agent-menu").getByRole("menuitem", { name: "New agent…" })).toBeVisible();

  await page.keyboard.type("migr");
  await expect(names(page)).toHaveText(["migrator"]);
  await expect(page.getByTestId("agent-menu-said")).toHaveText('Matching "migr"');
  await page.keyboard.press("Escape");
  await expect(names(page)).toHaveCount(9);

  await page.getByTestId("agent-option").filter({ hasText: /^Reviewer/ }).click();
  await expect(page.getByTestId("agent-menu")).toHaveCount(0);
  await expect(chip(page, "agent")).toHaveText("Reviewer");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
    settings: { model: "opus", effort: "high", readsOnly: true },
  });
  // The mode chip says the session reads only, with the lock.
  await expect(chip(page, "mode")).toHaveText("Reads only");
  await expect(chip(page, "mode")).toHaveAttribute("data-reads-only", "");

  await page.getByTestId("composer-input").fill("Look at the cache change");
  await page.keyboard.press("Enter");
  const sent = (await calls(page)).find((call) => call.method === "send");
  expect(sent?.text).toMatch(/^From the workbench, not the user: from this message on, work as the agent "Reviewer"/);
  expect(sent?.text?.endsWith("\n\nLook at the cache change")).toBe(true);
  await agent(page, `f.turn("${H}", "The cache change holds.");`);
  const mine = page.getByTestId("user-message").last();
  await expect(mine.locator(".bubble")).toHaveText("Look at the cache change");
  await expect(mine.getByTestId("workbench-agent")).toHaveText("As Reviewer");
  await mine.getByTestId("workbench-agent").click();
  await expect(mine.getByTestId("workbench-agent-text")).toBeVisible();
  await expect(page.getByTestId("agent-run-as").last()).toHaveText("Reviewer");
});

test("offers only agents mid-session, from the next message, and picking a mode ends reading only", async ({ page }) => {
  await open(page);
  await openAgents(page);
  await page.getByTestId("agent-option").filter({ hasText: /^Reviewer/ }).click();
  await page.getByTestId("composer-input").fill("Read it");
  await page.keyboard.press("Enter");
  await agent(page, `f.turn("${H}", "Read.");`);

  await chip(page, "agent").click();
  await expect(page.getByTestId("agent-menu-heading")).toHaveText("Agent, from your next message");
  await expect(names(page)).toHaveCount(8);
  await expect(names(page).first()).not.toHaveText("No agent");
  await expect(page.getByTestId("agent-option").filter({ hasText: /^Reviewer/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("agent-menu-said")).toHaveText("3 more");
  await expect(page.getByTestId("agent-menu").getByRole("menuitem", { name: "New agent…" })).toHaveCount(0);
  await page.getByTestId("agent-option").filter({ hasText: /^Developer/ }).click();
  await expect(chip(page, "agent")).toHaveText("Developer");
  expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
    settings: { readsOnly: false },
  });

  await chip(page, "agent").click();
  await page.getByTestId("agent-option").filter({ hasText: /^Security reviewer/ }).click();
  await expect(chip(page, "mode")).toHaveText("Reads only");
  await chip(page, "mode").click();
  await page.getByTestId("mode-option").first().click();
  expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
    settings: { readsOnly: false },
  });
  await expect(chip(page, "mode")).not.toHaveText("Reads only");
});

test("opens Settings on a new agent from the list", async ({ page }) => {
  await open(page);
  await openAgents(page);
  await page.getByTestId("agent-menu").getByRole("menuitem", { name: "New agent…" }).click();
  await expect(page.getByTestId("agent-title")).toBeFocused();
});
