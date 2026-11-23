import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew } from "./fake";

// A session in a team run shows the run's gates on one line above the
// composer: how many stand, why the next holds, each gate behind it with
// its record, a waiver that says why, and an end where the lead is gone.

type Call = { method: string; options?: Record<string, unknown> };

async function token(page: Page): Promise<string> {
  const calls = await page.evaluate(
    () => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls,
  );
  const start = calls.filter((call) => call.method === "start").at(-1);
  return start?.options?.token as string;
}

const VERDICT = {
  id: "v1",
  gate: 1,
  token: "reviewer-token",
  agent: "Researcher",
  agentVersion: null,
  on: "a1b2c3d4e5f6",
  plan: 2,
  folder: null,
  brief: "Review the plan for the refresh tokens.",
  approved: true,
  findings: "The plan covers expiry and rotation.",
  at: 1_790_000_000,
};

function run(lead: string, line: string) {
  return {
    run: { lead, team: "Ship with checks", folder: "/projects/demo", base: "abc", at: 1_790_000_000 },
    plan: 2,
    places: [],
    gone: [],
    paths: [],
    gates: [
      {
        gate: { id: 1, who: "Researcher", when: "plan", touches: [], rounds: 3, added: false },
        standing: "approved",
        asks: 0,
        atLimit: false,
        reason: null,
        verdict: VERDICT,
        waiver: null,
        folders: [],
      },
      {
        gate: { id: 2, who: "Reviewer", when: "change", touches: [], rounds: 3, added: false },
        standing: "waiting",
        asks: 0,
        atLimit: false,
        reason: "Reviewer has not reviewed the change",
        verdict: null,
        waiver: null,
        folders: [],
      },
      {
        gate: { id: 3, who: "Security", when: "change", touches: ["src/auth/**"], rounds: 3, added: true },
        standing: "notNeeded",
        asks: 0,
        atLimit: false,
        reason: null,
        verdict: null,
        waiver: null,
        folders: [],
      },
    ],
    line,
    buildingHeld: false,
    handingOverHeld: true,
    uncommittedHeld: false,
    waitsForTheUser: false,
  };
}

async function open(page: Page, lead?: string) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await startNew(page);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("gate-line")).toHaveCount(0);
  const own = await token(page);
  await page.evaluate(
    ([own, state]) => {
      const w = window as unknown as {
        __runs?: Record<string, unknown>;
        __runChanged: (changed: { lead: string }) => void;
      };
      (w.__runs ??= {})[own] = state;
      w.__runChanged({ lead: own });
    },
    [own, run(lead ?? own, "Gates 1 of 2 · Reviewer has not reviewed the change")] as const,
  );
  await expect(page.getByTestId("gate-line")).toBeVisible();
  return own;
}

test("shows the run's gates in one line, and each gate's standing behind it", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("gate-line-count")).toHaveText("1 of 2");
  await expect(page.getByTestId("gate-line-why")).toHaveText("Reviewer has not reviewed the change");
  await expect(page.getByTestId("gate-line-end")).toHaveCount(0);

  const toggle = page.getByTestId("gate-line-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const rows = page.getByTestId("gate-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId("gate-standing")).toHaveText("Approved");
  await expect(rows.nth(1).getByTestId("gate-standing")).toHaveText("Waiting");
  await expect(rows.nth(2).getByTestId("gate-standing")).toHaveText("Not needed");
  await expect(rows.nth(2)).toContainText("Added by the lead");
  // Only a gate that holds can be waived.
  await expect(rows.nth(0).getByTestId("gate-waive")).toHaveCount(0);

  // The record says what was reviewed, the verdict, the findings, and
  // keeps the rest behind Details.
  await rows.nth(0).getByTestId("gate-open").click();
  const record = page.getByTestId("gate-record");
  await expect(record).toBeVisible();
  await expect(record.locator("h2")).toHaveText("Researcher approved the plan");
  await expect(page.getByTestId("gate-record-verdict")).toContainText("Approved.");
  await expect(page.getByTestId("gate-record-findings")).toHaveText("The plan covers expiry and rotation.");
  await expect(record).toContainText("Plan v2");
  await expect(record).not.toContainText("a1b2c3d");
  await page.getByTestId("gate-record-details").click();
  await expect(record).toContainText("a1b2c3d");
  await expect(page.getByTestId("gate-record-agent")).toHaveText("Researcher");
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  await expect(rows.nth(0).getByTestId("gate-open")).toBeFocused();
});

test("waives a gate, asking only why", async ({ page }) => {
  const own = await open(page);
  await page.getByTestId("gate-line-toggle").click();
  const waiting = page.getByTestId("gate-row").nth(1);
  await waiting.hover();
  await waiting.getByTestId("gate-waive").click();
  const ask = page.getByTestId("gate-waive-ask");
  await expect(ask).toBeVisible();
  await expect(page.getByTestId("gate-waive-why")).toBeFocused();
  await expect(page.getByTestId("gate-waive-confirm")).toBeDisabled();

  // Escape leaves it as it was.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(waiting.getByTestId("gate-waive")).toBeFocused();

  await waiting.getByTestId("gate-waive").click();
  await page.getByTestId("gate-waive-why").fill("Docs only, nothing to review");
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  const waivers = await page.evaluate(
    () => (window as unknown as { __waivers?: unknown[] }).__waivers ?? [],
  );
  expect(waivers).toEqual([{ token: own, gate: 2, reason: "Docs only, nothing to review" }]);

  // The run is read again: the gate stands waived, the line counts it,
  // and its record says why.
  await expect(page.getByTestId("gate-line-count")).toHaveText("2 of 2");
  await expect(page.getByTestId("gate-line-why")).toHaveCount(0);
  await expect(waiting.getByTestId("gate-standing")).toHaveText("Waived");
  await expect(waiting.getByTestId("gate-waive")).toHaveCount(0);
  await waiting.getByTestId("gate-open").click();
  await expect(page.getByTestId("gate-record-waiver")).toContainText("Docs only, nothing to review");
});

test("keeps a waiver's reason to the core's limit, and says why one is refused", async ({ page }) => {
  await open(page);
  await page.getByTestId("gate-line-toggle").click();
  const waiting = page.getByTestId("gate-row").nth(1);
  await waiting.hover();
  await waiting.getByTestId("gate-waive").click();
  const why = page.getByTestId("gate-waive-why");
  await expect(why).toHaveAttribute("maxlength", "500");
  // A run gone before the waiver lands is refused, out loud.
  await page.evaluate(() => {
    delete (window as unknown as { __runs: Record<string, unknown> }).__runs[
      Object.keys((window as unknown as { __runs: Record<string, unknown> }).__runs)[0]
    ];
  });
  await why.fill("Docs only");
  await page.keyboard.press("Enter");
  const problem = page.getByTestId("gate-waive-problem");
  await expect(problem).toHaveText("That session is in no run.");
  await expect(problem).toHaveAttribute("role", "alert");
});

test("reads the run once for a burst of moves, and never while the user types", async ({ page }) => {
  const own = await open(page);
  const reads = () =>
    page.evaluate((own) => (window as unknown as { __runReads: Record<string, number> }).__runReads[own], own);
  await expect.poll(reads).toBeGreaterThan(0);
  const before = await reads();
  await page.evaluate((own) => {
    const w = window as unknown as { __runChanged: (changed: { lead: string }) => void };
    for (let at = 0; at < 5; at++) w.__runChanged({ lead: own });
  }, own);
  await expect.poll(reads).toBe(before + 1);
  await page.getByTestId("composer-input").pressSequentially("a plan for the tokens", { delay: 10 });
  await page.waitForTimeout(300);
  expect(await reads()).toBe(before + 1);
});

test("shows an approval of an earlier plan as out of date, in the waiting colour", async ({ page }) => {
  const own = await open(page);
  await page.evaluate((own) => {
    const w = window as unknown as {
      __runs: Record<string, { gates: { standing: string }[] }>;
      __runChanged: (changed: { lead: string }) => void;
    };
    w.__runs[own].gates[0].standing = "outOfDate";
    w.__runChanged({ lead: own });
  }, own);
  await page.getByTestId("gate-line-toggle").click();
  const row = page.getByTestId("gate-row").nth(0);
  await expect(row.getByTestId("gate-standing")).toHaveText("Out of date");
  const waiting = page.getByTestId("gate-row").nth(1).getByTestId("gate-standing");
  const colour = (locator: typeof waiting) => locator.evaluate((node) => getComputedStyle(node).color);
  expect(await colour(row.getByTestId("gate-standing"))).toBe(await colour(waiting));
  await row.getByTestId("gate-open").click();
  await expect(page.getByTestId("gate-record").locator("h2")).toHaveText("Researcher approved an earlier plan");
  await expect(page.getByTestId("gate-record-verdict")).toContainText("Out of date.");
  await expect(page.getByTestId("gate-record-verdict")).not.toContainText("Approved.");
});

test("says Copied once a gate's summary is copied", async ({ page }) => {
  await open(page);
  await page.getByTestId("gate-line-toggle").click();
  await page.getByTestId("gate-row").nth(0).getByTestId("gate-open").click();
  const copy = page.getByTestId("gate-record-copy");
  await expect(copy).toHaveText("Copy summary");
  await copy.click();
  await expect(copy).toHaveText("Copied");
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
  expect(copied.at(-1)).toContain("Researcher approved the plan");
  await expect(copy).toHaveText("Copy summary", { timeout: 3000 });
});

test("offers to end the run from a member when its lead has no row", async ({ page }) => {
  const own = await open(page, "gone-lead-token");
  const end = page.getByTestId("gate-line-end");
  await expect(end).toBeVisible();
  // The fake keeps the run under the member's token, so ending it by the
  // lead's token is what the test reads.
  await end.click();
  // It asks first; Escape leaves the run as it was.
  const ask = page.getByTestId("gate-end-ask");
  await expect(ask).toContainText("End this run?");
  await expect(page.getByTestId("gate-end-confirm")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(end).toBeFocused();
  const ended = () =>
    page.evaluate(() => (window as unknown as { __runsEnded?: unknown[] }).__runsEnded ?? []);
  expect(await ended()).toEqual([]);

  // A refusal is said where the question was, and the run stands.
  await page.evaluate(() => {
    (window as unknown as { __runEndFails?: string }).__runEndFails = "The run store is busy.";
  });
  await end.click();
  await page.getByTestId("gate-end-confirm").click();
  await expect(page.getByTestId("gate-end-problem")).toHaveText("The run store is busy.");
  await expect(ask).toBeVisible();

  await page.evaluate(() => delete (window as unknown as { __runEndFails?: string }).__runEndFails);
  await page.getByTestId("gate-end-confirm").click();
  await expect.poll(ended).toEqual([{ project: PROJECT, token: "gone-lead-token" }]);
  await expect(ask).toHaveCount(0);
  expect(own).not.toBe("gone-lead-token");
});
