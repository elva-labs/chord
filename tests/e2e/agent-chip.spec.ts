import { expect, test, type Page } from "@playwright/test";
import { PROJECT, fromPlus, installFakeCore, leaveRow, startNew } from "./fake";

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
  await expect(chip(page, "mode")).toHaveText("Reads only · Default");
  await expect(chip(page, "mode")).toHaveAttribute("data-reads-only", "");
  await expect(chip(page, "mode")).toHaveAttribute("title", /Set by Reviewer\. Reads only: .* A command it runs is left to Default\.$/);
  // The model chip names the model as the workbench does where the harness
  // offers none by that name.
  await expect(chip(page, "model")).toHaveText("Opus");

  await page.getByTestId("composer-input").fill("Look at the cache change");
  await page.keyboard.press("Enter");
  const sent = (await calls(page)).find((call) => call.method === "send");
  expect(sent?.text).toMatch(/^From the workbench, not the user: from this message on, work as the agent "Reviewer"/);
  expect(sent?.text?.endsWith("\n\nLook at the cache change")).toBe(true);
  expect(sent?.text).toContain("\nYou read only: change no files, whether by editing them or by a command you run.\nEnd of the agent's description.");
  await agent(page, `f.turn("${H}", "The cache change holds.");`);
  const mine = page.getByTestId("user-message").last();
  await expect(mine.locator(".bubble")).toHaveText("Look at the cache change");
  await expect(mine.getByTestId("workbench-agent")).toHaveText("As Reviewer · Runs on Opus · High · Reads only");
  await expect(mine.getByTestId("workbench-agent")).toHaveAttribute("aria-expanded", "false");
  await mine.getByTestId("workbench-agent").click();
  await expect(mine.getByTestId("workbench-agent")).toHaveAttribute("aria-expanded", "true");
  await expect(mine.getByTestId("workbench-agent-text")).toBeVisible();
  await expect(page.getByTestId("agent-run-as").last()).toHaveText("Reviewer");

  // An ask reading only made says so.
  await agent(page, `f.ask("${H}", "mcp__github__create_issue", { title: "x" }, { readsOnly: true });`);
  await expect(page.getByTestId("permission-reads-only")).toHaveText(
    "This session reads only. Allowing this lets it change files.",
  );
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
  await expect(chip(page, "mode")).toHaveText("Reads only · Default");
  await chip(page, "mode").click();
  await page.getByTestId("mode-option").first().click();
  expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
    settings: { readsOnly: false },
  });
  // Default goes behind the plus once the row is left, and is read there.
  await leaveRow(page);
  await expect(chip(page, "mode")).toHaveCount(0);
  await fromPlus(page, "Mode");
  await expect(chip(page, "mode")).toHaveText("Default");
  await expect(chip(page, "mode")).not.toHaveAttribute("data-reads-only");
});

test("opens Settings on a new agent from the list", async ({ page }) => {
  await open(page);
  await openAgents(page);
  await page.getByTestId("agent-menu").getByRole("menuitem", { name: "New agent…" }).click();
  await expect(page.getByTestId("agent-title")).toBeFocused();
});

test("the palette's new session asks which agent it works as, starts as the one picked, and offers it next time", async ({
  page,
}) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  const as = page.locator("[data-testid='palette-row'][data-kind='as']");
  await expect(as.getByTestId("palette-detail")).toHaveText("No agent");
  await expect(page.getByTestId("palette-field")).toHaveAttribute(
    "placeholder",
    "Enter starts it, or type an agent, team, harness or account",
  );

  await as.click();
  await expect(page.getByTestId("palette-field")).toHaveAttribute("placeholder", "As which agent");
  await expect(page.getByTestId("palette-group")).toHaveText(["Agents"]);
  const chosen = page.locator("[data-testid='palette-row'][aria-selected='true']");
  await expect(chosen).toContainText("No agent");
  await page.keyboard.type("reviewer");
  const reviewer = page
    .getByTestId("palette-row")
    .filter({ has: page.locator("[data-testid='palette-label']", { hasText: /^Reviewer$/ }) });
  await expect(reviewer.getByTestId("palette-lock")).toBeVisible();
  await expect(reviewer.getByTestId("palette-icon")).toHaveAttribute("data-icon", "agent");
  await reviewer.click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(chip(page, "agent")).toHaveText("Reviewer");

  await page.getByTestId("composer-input").fill("Look at the cache change");
  await page.keyboard.press("Enter");
  const sent = (await calls(page)).find((call) => call.method === "send");
  expect(sent?.text).toMatch(/^From the workbench, not the user: from this message on, work as the agent "Reviewer"/);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("new session");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid='palette-row'][data-kind='ready'] [data-testid='palette-detail']")).toHaveText(
    "Claude Code · Reviewer",
  );
  await expect(as.getByTestId("palette-detail")).toHaveText("Reviewer");
  await expect(as.getByTestId("palette-end")).toHaveText("last picked");
  // The row reads at the size and colour of the line above it.
  const line = page.locator("[data-testid='palette-row'][data-kind='ready'] [data-testid='palette-detail']");
  for (const property of ["font-size", "color"])
    await expect(as.getByTestId("palette-detail")).toHaveCSS(
      property,
      await line.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property),
    );
});
