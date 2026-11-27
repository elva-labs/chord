import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

// A team picked in the composer's agent list before the first message: the
// session starts again as the team's lead, reading only, and keeps the
// team for the run once something is said.

type Call = { method: string; options?: Record<string, unknown>; text?: string };

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls);
}

const SHIP = {
  name: "Ship with checks",
  members: [{ agent: "Researcher" }, { agent: "Developer" }, { agent: "Reviewer" }],
  gates: [
    { who: "Researcher", when: "plan" },
    { who: "Reviewer", when: "change" },
  ],
};

const chip = (page: Page, which: string) => page.locator(`[data-testid='${which}-chip']:visible`);

const starts = async (page: Page) => (await calls(page)).filter((call) => call.method === "start");

async function open(page: Page, teams: unknown[] = [SHIP], more: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], teams, ...more } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await chip(page, "more").click();
  await page.getByTestId("more-option").filter({ hasText: "Agent" }).click();
  await expect(page.getByTestId("agent-menu")).toBeVisible();
}

test("lists the teams under the agents, and a team picked starts the session again as its lead", async ({ page }) => {
  await open(page);
  // The teams show whole under their heading, past the agents cut short.
  await expect(page.getByTestId("agent-menu-section")).toHaveText("Teams");
  const team = page.getByTestId("agent-option").filter({ hasText: "Ship with checks" });
  await expect(team).toContainText("2 gates · 3 agents");

  await team.click();
  await expect(chip(page, "agent")).toHaveText("Ship with checks");
  await expect(chip(page, "agent")).toHaveAttribute("data-team", "Ship with checks");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "start").at(-1)?.options)
    .toMatchObject({ team: "Ship with checks" });
  const last = (await calls(page)).filter((call) => call.method === "start").at(-1);
  expect(last?.options?.joining).toBeUndefined();
  await expect(chip(page, "mode")).toHaveText("Reads only · Default");

  // Picked again, the list says it is the one in use; no agent leaves it.
  await chip(page, "agent").click();
  await expect(team).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("agent-option").filter({ hasText: "No agent" }).click();
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "start").at(-1)?.options?.team)
    .toBeUndefined();
});

test("no agent picked over a team ends the team's run before the session starts again", async ({ page }) => {
  const ended = () =>
    page.evaluate(() => (window as unknown as { __runsEnded?: { token: string }[] }).__runsEnded ?? []);
  await open(page);
  await page.getByTestId("agent-option").filter({ hasText: "Ship with checks" }).click();
  await expect.poll(async () => (await starts(page)).at(-1)?.options).toMatchObject({ team: "Ship with checks" });
  expect(await ended()).toEqual([]);

  const before = (await starts(page)).length;
  await chip(page, "agent").click();
  await page.getByTestId("agent-option").filter({ hasText: "No agent" }).click();
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThan(before);
  expect(await ended()).toHaveLength(1);
  expect((await starts(page)).at(-1)?.options?.team).toBeUndefined();
});

test("keeps the team for the run once something is said", async ({ page }) => {
  await open(page);
  await page.getByTestId("agent-option").filter({ hasText: "Ship with checks" }).click();
  await expect(chip(page, "agent")).toHaveText("Ship with checks");
  await page.getByTestId("composer-input").fill("Add refresh tokens");
  await page.keyboard.press("Enter");
  await expect(chip(page, "agent")).toBeDisabled();
  await expect(chip(page, "agent")).toHaveAttribute("title", "Team, kept for the run");
  // A team and a joining never go in one start.
  for (const start of await starts(page)) expect(start.options?.team && start.options?.joining).toBeFalsy();

  // After a reload the session is taken up again: the chip still shows
  // the team, and the start that resumes it names none, so the run the
  // core holds carries on with the team as it began.
  await page.reload();
  await expect(chip(page, "agent")).toHaveText("Ship with checks");
  await expect(chip(page, "agent")).toBeDisabled();
  await expect.poll(async () => (await starts(page)).at(-1)?.options?.session).toBeTruthy();
  for (const start of await starts(page)) expect(start.options?.team).toBeUndefined();
});

test("a team that does not start only leads without reading only", async ({ page }) => {
  await open(page, [SHIP, { ...SHIP, name: "Quick fix", gates: [], startOnly: false }]);
  await page.getByTestId("agent-option").filter({ hasText: "Quick fix" }).click();
  await expect(chip(page, "agent")).toHaveText("Quick fix");
  await expect.poll(async () => (await starts(page)).at(-1)?.options).toMatchObject({ team: "Quick fix" });
  // Nothing about the mode differs from the default, so no mode chip shows.
  await expect(chip(page, "mode")).toHaveCount(0);
  expect((await starts(page)).at(-1)?.options?.readsOnly).toBeFalsy();
});

test("with many teams the menu scrolls inside the room it has, the cursor's row in view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 560 });
  const teams = Array.from({ length: 16 }, (_, at) => ({ ...SHIP, name: `Team ${at + 1}` }));
  await open(page, teams);
  const menu = page.getByTestId("agent-menu");
  // Every team is in the list, none behind "more", and the menu ends on
  // the screen.
  await expect(page.getByTestId("agent-option").filter({ hasText: /^Team \d+/ })).toHaveCount(16);
  const box = await menu.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(560);
  expect(await menu.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  // The keyboard walks to the last team, and it is scrolled into view.
  const last = page.getByTestId("agent-option").filter({ hasText: "Team 16" });
  for (let step = 0; step < 40; step++) {
    if (await last.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(last).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(chip(page, "agent")).toHaveText("Team 16");
});

test("the editor of a team a session leads says runs in progress keep it as it was", async ({ page }) => {
  await open(page);
  await page.getByTestId("agent-option").filter({ hasText: "Ship with checks" }).click();
  await expect(chip(page, "agent")).toHaveText("Ship with checks");
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByTestId("settings-tab-agents").click();
  await page.getByTestId("team-row").filter({ hasText: "Ship with checks" }).click();
  await expect(page.getByTestId("team-in-use")).toHaveText(
    "A session leads this team. Runs in progress keep the team as it was.",
  );
});
