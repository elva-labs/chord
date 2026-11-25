import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, startNew, sessionBox, sessionRowOf } from "./fake";

/**
 * The notes a session keeps of its conversation are read from its row's
 * menu, and only there: the item is offered for a session that keeps any,
 * brings that session on screen and opens them in the viewer as a document.
 */

const ROW = "[data-testid='session-row']";

/** A nameless row reads "New session", so "session N" is found by its number and any other row by its name. */
const row = (page: Page, name: string) =>
  /^session \d+$/.test(name)
    ? sessionRowOf(page, Number(name.replace("session ", "")))
    : page.locator(ROW).filter({ hasText: name });

const OTHER = "/home/ada/dev/other";

/** Has the first session keep notes. */
const keepNotes = (page: Page, session = "session-1") =>
  page.evaluate((session) => {
    const fake = window as unknown as { __notes: unknown; __markdown: string };
    fake.__notes = { [session]: { standing: 1, brief: true } };
    fake.__markdown = "# Notes\n\n## Brief\n\nA desktop app for agents.\n";
  }, session);

async function showNotes(page: Page, project?: string) {
  await sessionRowOf(page, 1, project).click({ button: "right" });
  await page.getByTestId("session-menu-notes").click();
}

async function notesShown(page: Page) {
  await expect(page.getByTestId("media-caption")).toHaveText("Notes");
  await expect(page.getByTestId("media-file").getByRole("heading", { name: "Brief" })).toBeVisible();
}

test("opens a session's notes in the viewer from its menu, offered only when it keeps some", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await startNew(page);
  await expect(row(page, "session 1")).toContainText("running");
  await page.getByTestId("new-session").click();
  await startNew(page);
  await expect(page.locator(ROW)).toHaveCount(2);

  // None kept: the menu is as it was.
  await row(page, "session 1").click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  await expect(page.getByTestId("session-menu-notes")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Open items alone are enough to offer them.
  await page.evaluate(() => {
    (window as unknown as { __notes: unknown }).__notes = { "session-1": { standing: 0, brief: false, open: 1 } };
  });
  await row(page, "session 1").click({ button: "right" });
  await expect(page.getByTestId("session-menu-notes")).toHaveText("Show notes");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.evaluate(() => {
    const fake = window as unknown as { __notes: unknown; __markdown: string };
    fake.__notes = { "session-1": { standing: 2, brief: true } };
    fake.__markdown = "# Notes\n\n## Brief\n\nA desktop app for agents.\n\n## Notes\n\n### Default model\n\nOne tier below the starter.\n";
  });
  await row(page, "session 1").click({ button: "right" });
  const item = page.getByTestId("session-menu-notes");
  await expect(item).toHaveText("Show notes");
  // Quiet: it sits above the stop, never first.
  await expect(menu.getByRole("menuitem").first()).not.toHaveText("Show notes");
  await expect(menu.getByRole("menuitem").last()).not.toHaveText("Show notes");
  await expect(sessionBox(page, 2)).toHaveClass(/\bon\b/);
  await item.click();
  await expect(menu).toHaveCount(0);
  await expect(sessionBox(page, 1)).toHaveClass(/\bon\b/);
  await expect(page.getByTestId("media-caption")).toHaveText("Notes");
  const viewer = page.getByTestId("media-file");
  await expect(viewer.getByRole("heading", { name: "Default model" })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Notes.md" })).toBeVisible();
});

for (const mode of ["agent", "editor"] as const) {
  test(`switching project in ${mode} mode, the notes stand over the file the session had open`, async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT, OTHER] });
    await page.goto("/");
    await expect(page.locator("section[data-pane='agent']")).toBeVisible();
    for (const project of [PROJECT, OTHER]) {
      const header = page.locator(`[data-row='project:${project}']`);
      await header.hover();
      await header.getByTestId("project-new-session").click();
      await startNew(page);
      await expect(sessionRowOf(page, 1, project)).toContainText("running");
    }
    if (mode === "editor") {
      await page.keyboard.press("ControlOrMeta+Shift+E");
      await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
    }
    // The file each session has open: a tab while editing, else the viewer's.
    const open = (name: string) =>
      mode === "editor"
        ? page.locator(`[data-testid='editor-tab'][data-path$='${name}']`)
        : page.getByTestId("viewer").getByText(name).first();
    // Reading a file in the viewer folds the sessions pane: its rows are
    // picked from the pane peeked.
    const unfold = async () => {
      const button = page.getByTestId("unfold-sessions");
      if (await button.isVisible()) await button.click();
    };
    for (const [project, name] of [
      [PROJECT, "mod.rs"],
      [OTHER, "lib.rs"],
    ]) {
      await unfold();
      await sessionRowOf(page, 1, project).click();
      await expect(sessionBox(page, 1, project)).toHaveClass(/\bon\b/);
      const file = page.locator("section[data-pane='changes']").getByText(name, { exact: true }).first();
      if (mode === "editor") await file.dblclick();
      else await file.click();
      await expect(open(name)).toBeVisible();
    }

    await keepNotes(page);
    await unfold();
    await showNotes(page, PROJECT);
    await expect(sessionBox(page, 1, PROJECT)).toHaveClass(/\bon\b/);
    await notesShown(page);
    if (mode === "editor") await expect(open("mod.rs")).toBeVisible();
  });
}

test("in compact mode, brings the session on screen with its notes and puts the pane away", async ({ page }) => {
  // A binding of its own, so the test presses what is bound.
  const bound = { key: "y", shift: false, alt: false };
  await installFakeCore(page, { open: [PROJECT], settings: { compact: true, keys: { "focus.sessions": bound } } });
  await page.goto("/");
  const pane = page.locator("[data-testid='sessions-slot'] section[data-pane='sessions']");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await expect(pane).toBeHidden();
  for (const _ of [1, 2]) {
    await page.keyboard.press("ControlOrMeta+y");
    await expect(pane).toBeVisible();
    await page.getByTestId("new-session").click();
    await startNew(page);
    await expect(pane).toBeHidden();
  }
  await keepNotes(page);
  await page.keyboard.press("ControlOrMeta+y");
  await showNotes(page);
  await expect(pane).toBeHidden();
  await notesShown(page);
  await page.keyboard.press("ControlOrMeta+y");
  await expect(sessionBox(page, 1)).toHaveClass(/\bon\b/);
});

test("opens the notes of a session left from the last quit without starting it", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  for (const count of [1, 2]) {
    await page.getByTestId("new-session").click();
    await startNew(page);
    await expect(page.locator(ROW)).toHaveCount(count);
    await expect(sessionRowOf(page, count)).toContainText("running");
  }
  // After a reload the fake knows a row's notes by its token alone.
  const token = await page.evaluate(
    () => (window as unknown as { __spawns: { token: string }[] }).__spawns[0].token,
  );
  await page.reload();
  await expect(sessionBox(page, 1).locator(".dot.dormant")).toBeVisible();
  const spawns = () =>
    page.evaluate(() => (window as unknown as { __spawns?: { session?: string }[] }).__spawns?.map((s) => s.session));
  await expect.poll(spawns).toEqual(["session-2"]);

  await keepNotes(page, token);
  await showNotes(page);
  await notesShown(page);
  await expect(sessionBox(page, 2)).toHaveClass(/\bon\b/);
  await expect(sessionBox(page, 1).locator(".dot.dormant")).toBeVisible();
  expect(await spawns()).toEqual(["session-2"]);
});

test("a terminal row goes on from its notes in its first prompt, and its menu resumes the old conversation whole", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const head =
    "From the workbench, not the user: this conversation goes on from an earlier one of yours, which was not read again, since reading all of it with its cache lapsed would cost far more. What you need to go on is below.";
  const briefing = `${head}\n\nNo notes were kept of the earlier conversation.\nEnd of the workbench's briefing.`;
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [{ id: "past-1", modified: now - 7200, size: 100, title: "Count things" }],
  });
  await page.addInitScript(
    ({ project, briefing }) => {
      localStorage.setItem("chord.mine", JSON.stringify({ [project]: ["past-1"] }));
      (window as unknown as { __goingOn: unknown }).__goingOn = { context: 412_000, idle: 7200, goesOn: true, briefing };
    },
    { project: PROJECT, briefing },
  );
  await page.goto("/");
  const spawns = () =>
    page.evaluate(
      () => (window as unknown as { __spawns?: { session?: string; prompt?: string }[] }).__spawns ?? [],
    );
  await page.getByTestId("past-session").click();
  await expect.poll(async () => (await spawns()).length).toBe(1);
  const [fresh] = await spawns();
  expect(fresh.session).toBeUndefined();
  expect(fresh.prompt).toBe(`${briefing}\n\nTake in the above, say in one line that you have it, and wait for the user.`);
  // The same name, and the old conversation is the row's, not listed beside it.
  await expect(row(page, "Count things")).toHaveCount(1);
  await expect(page.getByTestId("past-session")).toHaveCount(0);

  await row(page, "Count things").click({ button: "right" });
  await expect(page.getByTestId("session-menu-whole")).toHaveText("Resume whole, reads 412k tokens");
  await page.getByTestId("session-menu-whole").click();
  await expect.poll(async () => (await spawns()).length, { timeout: 10_000 }).toBe(2);
  const whole = (await spawns())[1];
  expect(whole.session).toBe("past-1");
  expect(whole.prompt).toBeUndefined();
});
