import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * The teams on the Agents settings page: those in use are listed over the
 * agents, and a team is made, changed and removed there, the first change
 * writing the whole list as the file's own and leaving its workflows be.
 */

const AGENT = "section[data-pane='agent']";

const file = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);

async function openAgents(page: Page) {
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByTestId("settings-tab-agents").click();
  await expect(page.getByTestId("settings-agents")).toBeVisible();
}

const SHIP = {
  name: "Ship with checks",
  members: [{ agent: "Researcher" }, { agent: "Developer" }, { agent: "Reviewer" }],
  gates: [
    { who: "Researcher", when: "plan" },
    { who: "Reviewer", when: "change" },
  ],
};

test("lists the teams the workflows give, and the first change keeps them all", async ({ page }) => {
  const workflows = [{ name: "Mine", steps: [] }];
  await installFakeCore(page, { settings: { workflows } });
  await page.addInitScript((ship) => {
    (window as unknown as { __teamsInUse: unknown[] }).__teamsInUse = [ship];
  }, SHIP);
  await page.goto("/");
  await openAgents(page);

  const row = page.getByTestId("team-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Ship with checks");
  await expect(row).toContainText("2 gates · 3 agents");

  await page.getByTestId("team-new").click();
  await expect(page.getByTestId("team-name")).toBeFocused();
  await page.getByTestId("team-save").click();
  await expect(page.getByTestId("team-problem")).toHaveText("A team needs a name.");
  await page.getByTestId("team-name").fill("Infra");

  // Add a gate opens on who approves, those that only read first, and
  // puts the one picked on the team.
  await page.getByTestId("team-gate-add").click();
  const who = page.getByTestId("team-who-option");
  await expect(who.first()).toContainText("Researcher");
  await expect(who.nth(4)).toContainText("Developer");
  await page.getByTestId("team-who-option").filter({ hasText: "Cloud architect" }).click();
  await expect(page.getByTestId("team-member")).toHaveCount(1);
  await expect(page.getByTestId("team-member")).toHaveAttribute("data-agent", "Cloud architect");
  await expect(page.getByTestId("team-gate-when")).toHaveText("before handing over");
  await expect(page.getByTestId("team-gate-who")).toBeFocused();

  await page.getByTestId("team-gate-when").click();
  await page.getByTestId("team-when-option").filter({ hasText: "Before building" }).click();
  await page.getByTestId("team-gate-more").click();
  // The core says what will not do, a path outside the project too.
  await page.getByTestId("team-gate-touches").fill("infra/**, /etc");
  await page.getByTestId("team-gate-touches-done").click();
  await page.getByTestId("team-save").click();
  await expect(page.getByTestId("team-problem")).toHaveText(
    'The gate of Cloud architect in Infra holds for paths in the project, such as infra/**, not "/etc".',
  );
  await page.getByTestId("team-gate-more").click();
  await page.getByTestId("team-gate-touches").fill("infra/**, deploy/*.yml");
  await page.getByTestId("team-gate-touches").press("Enter");
  await expect(page.getByTestId("team-gate-cond")).toHaveText("only when it touches infra/** or deploy/*.yml");
  await expect(page.getByTestId("team-problem")).toHaveCount(0);

  await page.getByTestId("team-member-add").click();
  await page.getByTestId("team-member-option").filter({ hasText: "Developer" }).click();
  await page.getByTestId("team-save").click();

  await expect(row).toHaveCount(2);
  await expect(page.locator("[data-team='Infra']")).toContainText("1 gate · 2 agents");
  await expect(page.locator("[data-team='Infra']")).toBeFocused();
  await expect.poll(() => file(page)).toMatchObject({
    workflows,
    teams: [
      SHIP,
      {
        name: "Infra",
        members: [{ agent: "Cloud architect" }, { agent: "Developer" }],
        gates: [{ who: "Cloud architect", when: "plan", touches: ["infra/**", "deploy/*.yml"] }],
      },
    ],
  });
});

test("taking an agent off takes its gates and says so, and a team is removed", async ({ page }) => {
  await installFakeCore(page, { settings: { teams: [SHIP] } });
  await page.goto("/");
  await openAgents(page);

  await page.locator("[data-team='Ship with checks']").click();
  const reviewer = page.locator("[data-testid='team-member'][data-agent='Reviewer']").getByTestId("team-member-remove");
  await expect(reviewer).toHaveAttribute("aria-label", "Take Reviewer off the team, with its 1 gate");
  await reviewer.click();
  await expect(page.getByTestId("team-gate")).toHaveCount(1);
  await expect(page.getByTestId("team-dropped")).toHaveText(/Took Reviewer off, with its 1 gate\.\s*Undo/);
  // Undo puts the agent and its gate back where they were.
  await page.getByTestId("team-dropped-undo").click();
  await expect(page.getByTestId("team-dropped")).toHaveCount(0);
  await expect(page.getByTestId("team-member")).toHaveCount(3);
  await expect(page.getByTestId("team-member").nth(2)).toHaveAttribute("data-agent", "Reviewer");
  await expect(page.getByTestId("team-gate")).toHaveCount(2);

  await reviewer.click();
  await page.getByTestId("team-gate-more").click();
  await page.getByTestId("team-gate-remove").click();
  await expect(page.getByTestId("team-gate")).toHaveCount(0);
  await expect(page.getByTestId("team-gate-add")).toBeFocused();
  await page.getByTestId("team-cancel").click();
  await page.getByTestId("team-discard-ask-confirm").click();
  await expect(page.locator("[data-team='Ship with checks']")).toContainText("2 gates · 3 agents");

  await page.locator("[data-team='Ship with checks']").click();
  await page.getByTestId("team-more").click();
  await page.getByTestId("team-more-option").click();
  await page.getByTestId("team-remove-ask-confirm").click();
  await expect(page.getByTestId("team-row")).toHaveCount(0);
  await expect(page.getByTestId("team-new")).toBeVisible();
  await expect(page.getByTestId("team-none")).toHaveText(
    "A team is the agents a lead may call and the gates their work passes.",
  );
  await expect.poll(async () => (await file(page))?.teams).toEqual([]);
});

test("Undo keeps the agent taken off with gates, and puts back no gate the team has again", async ({ page }) => {
  await installFakeCore(page, { settings: { teams: [SHIP] } });
  await page.goto("/");
  await openAgents(page);
  await page.locator("[data-team='Ship with checks']").click();
  const remove = (agent: string) =>
    page.locator(`[data-testid='team-member'][data-agent='${agent}']`).getByTestId("team-member-remove").click();

  // An agent with no gates taken off after it leaves the note as it was.
  await remove("Reviewer");
  await remove("Developer");
  await expect(page.getByTestId("team-dropped")).toHaveText(/Took Reviewer off, with its 1 gate\.\s*Undo/);
  await page.getByTestId("team-dropped-undo").click();
  await expect(page.getByTestId("team-member")).toHaveCount(2);
  await expect(page.getByTestId("team-gate")).toHaveCount(2);

  // Put back by hand with the same gate, Undo adds it no second time.
  await remove("Reviewer");
  await page.getByTestId("team-gate-add").click();
  await page.getByTestId("team-who-option").filter({ hasText: /^Reviewer/ }).click();
  await expect(page.getByTestId("team-gate")).toHaveCount(2);
  await page.getByTestId("team-dropped-undo").click();
  await expect(page.getByTestId("team-gate")).toHaveCount(2);
  await expect(page.locator("[data-testid='team-member'][data-agent='Reviewer']")).toHaveCount(1);
});

test("asks before an edit is dropped, by Back, Cancel or Escape, and only once something changed", async ({ page }) => {
  await installFakeCore(page, { settings: { teams: [SHIP] } });
  await page.goto("/");
  await openAgents(page);
  const ship = page.locator("[data-team='Ship with checks']");
  const editor = page.getByTestId("team-editor");
  const ask = page.getByTestId("team-discard-ask");

  // Unchanged, Escape goes back to the list and Settings stays open.
  await ship.click();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("settings-agents")).toBeVisible();

  for (const leave of ["Escape", "team-back", "team-cancel"]) {
    await ship.click();
    await page.getByTestId("team-name").fill("Ship it");
    if (leave === "Escape") await page.keyboard.press("Escape");
    else await page.getByTestId(leave).click();
    await expect(ask).toContainText('Discard changes to "Ship with checks"?');
    await expect(page.getByTestId("settings-agents")).toBeVisible();
    // Cancel keeps the edit; Escape on the question does the same.
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId("team-name")).toHaveValue("Ship it");
    if (leave === "Escape") await page.keyboard.press("Escape");
    else await page.getByTestId(leave).click();
    await page.getByTestId("team-discard-ask-confirm").click();
    await expect(editor).toHaveCount(0);
    await expect(ship).toBeVisible();
  }

  // With a gate's popover open, Escape puts it away and nothing more,
  // changed or not.
  await ship.click();
  for (const change of [false, true]) {
    if (change) await page.getByTestId("team-name").fill("Ship it");
    await page.getByTestId("team-gate-more").first().click();
    await expect(page.getByTestId("team-gate-touches")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("team-gate-touches")).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(ask).toHaveCount(0);
  }
  expect((await file(page)).teams).toEqual([SHIP]);
});

test("Enter in the name saves, and the core's problems show together, the weightiest first", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { teams: [SHIP] } });
  await page.goto("/");
  await openAgents(page);

  await page.getByTestId("team-new").click();
  await page.getByTestId("team-name").fill("ship with checks");
  await page.getByTestId("team-name").press("Enter");
  const problems = page.getByTestId("team-problem");
  await expect(problems).toHaveText([
    "There is already a team called ship with checks.",
    "Ship with checks needs at least one agent.",
  ]);
  await expect(problems.first()).toBeVisible();
  await expect(page.getByTestId("team-editor").locator("[role='alert']").first()).toBeAttached();

  await page.getByTestId("team-name").fill('Quote " team');
  await expect(problems.first()).toHaveText("A team's name has no quotation marks and nothing unprintable.");

  // A path no file matches yet is only a hint, and the team saves.
  await page.getByTestId("team-name").fill("Infra");
  await page.getByTestId("team-gate-add").click();
  await page.getByTestId("team-who-option").filter({ hasText: "Cloud architect" }).click();
  await page.getByTestId("team-gate-more").click();
  await page.getByTestId("team-gate-touches").fill("nowhere/**");
  await page.getByTestId("team-gate-touches").press("Enter");
  await expect(page.getByTestId("team-hint")).toHaveText("No file in the open projects matches nowhere/** yet.");
  await expect(problems).toHaveCount(0);
  await page.getByTestId("team-name").press("Enter");
  await expect(page.getByTestId("team-editor")).toHaveCount(0);
  await expect(page.locator("[data-team='Infra']")).toContainText("1 gate · 1 agent");
});

test("refuses a seventeenth team", async ({ page }) => {
  const teams = Array.from({ length: 16 }, (_, at) => ({ ...SHIP, name: `Team ${at + 1}` }));
  await installFakeCore(page, { settings: { teams } });
  await page.goto("/");
  await openAgents(page);
  await expect(page.getByTestId("team-row")).toHaveCount(16);
  await page.getByTestId("team-new").click();
  await page.getByTestId("team-name").fill("One more");
  await page.getByTestId("team-save").click();
  await expect(page.getByTestId("team-problem").first()).toHaveText("The settings hold 16 teams at most.");
  expect((await file(page)).teams).toHaveLength(16);
});
