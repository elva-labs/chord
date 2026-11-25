import { expect, test, type Page } from "@playwright/test";
import { CHATS_FOLDER, NO_WORKFLOW, PROJECT, installFakeCore, startNew } from "./fake";

/**
 * Chats: conversations with an agent that belong to no project.
 *
 * The fake core runs every chat in its chats folder and reports the past
 * chats a test gives it there. The sessions pane keeps them on one line at
 * its foot, the line opens a tray of the recent ones, and a chat on screen
 * is the conversation alone.
 */

const AGENT = "section[data-pane='agent']";
const SESSIONS = "section[data-pane='sessions']";
/** A new chat's chord: Shift+C on macOS, Shift+M elsewhere, where
    Ctrl+Shift+C is a terminal's copy. */
const NEW_CHAT = process.platform === "darwin" ? "Meta+Shift+C" : "Control+Shift+M";

const NOW = Math.floor(Date.now() / 1000);

/** Seven past chats, the newest first, an hour apart. */
const PAST = [
  "Invoice export formats",
  "Plan the export rework",
  "Weekend reading list",
  "Regex for dates",
  "Name for the new tool",
  "Draft the release note",
  "Ask about the lease",
].map((title, index) => ({ id: `chat-${index + 1}`, modified: NOW - 3600 * (index + 1), size: 2048, title }));

const foot = (page: Page) => page.getByTestId("chats-foot");
const line = (page: Page) => page.getByTestId("chats-line");
const agentTitle = (page: Page) => page.locator(`${AGENT} > header`);

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

const answerTo = async (page: Page, id: string) =>
  (
    await page.evaluate(() => (window as unknown as { __conductAnswers?: Answer[] }).__conductAnswers ?? [])
  ).find((answer) => answer.id === id) ?? null;

async function begin(page: Page, past = PAST, settings: Record<string, unknown> = NO_WORKFLOW) {
  await installFakeCore(page, { open: [PROJECT], settings, chatTranscripts: past });
  await page.goto("/");
  await expect(line(page)).toBeVisible();
}

/** A chat on screen: its mark in the header, "Chat" in the status bar, and
    neither the changes pane nor the project's terminal. */
async function chatOnScreen(page: Page) {
  await expect(page.getByTestId("chat-mark")).toBeVisible();
  await expect(page.getByTestId("chat-readout")).toHaveText("Chat");
  await expect(page.locator("section[data-pane='changes']")).toBeHidden();
  await expect(page.locator("section[data-pane='terminal']")).toBeHidden();
}

/** The palette asking for a new chat, its one Enter away. */
async function askingChat(page: Page) {
  await expect(page.getByTestId("palette-chip")).toHaveText("New chat");
  await expect(page.locator("[data-testid='palette-row'][data-kind='ready']")).toBeVisible();
}

test.describe("the chats line", () => {
  test("counts the chats at the foot and opens a tray of the recent ones", async ({ page }) => {
    await begin(page);
    await expect(page.getByTestId("chats-count")).toHaveText("· 7");
    await expect(line(page)).toHaveAttribute("aria-expanded", "false");
    await expect(foot(page).getByTestId("past-session")).toHaveCount(0);

    await line(page).click();
    await expect(line(page)).toHaveAttribute("aria-expanded", "true");
    await expect(foot(page).getByTestId("past-session")).toHaveCount(5);
    await expect(foot(page).getByTestId("past-session").first()).toContainText("Invoice export formats");
    await expect(page.getByTestId("older-chats")).toHaveText("2 more from before…");
    await expect(page.getByTestId("new-chat-here")).toBeVisible();

    await line(page).click();
    await expect(foot(page).getByTestId("past-session")).toHaveCount(0);
  });

  test("says there are none yet with no chats at all", async ({ page }) => {
    await begin(page, []);
    await expect(page.getByTestId("chats-count")).toHaveCount(0);
    await line(page).click();
    await expect(page.getByTestId("chats-none")).toHaveText("No chats yet.");
    await expect(page.getByTestId("older-chats")).toHaveCount(0);
  });

  test("keeps no chats folder among the projects", async ({ page }) => {
    await begin(page);
    await expect(page.getByTestId("project-section")).toHaveCount(1);
    await expect(page.locator(`${SESSIONS} [data-row='project:${CHATS_FOLDER}']`)).toHaveCount(0);
  });
});

test.describe("a new chat", () => {
  test("starts from the tray's plus with one Enter, and is the conversation alone", async ({ page }) => {
    await begin(page);
    await line(page).click();
    await page.getByTestId("new-chat-here").click();
    await askingChat(page);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);

    await chatOnScreen(page);
    await expect(agentTitle(page)).toContainText("New chat");
    await expect(agentTitle(page)).not.toContainText(/sonnet|opus|fable/i);
    await expect(page.getByTestId("chats-count")).toHaveText("· 8");
    // Picked, the tray closes and keeps the chat on screen under the line.
    await expect(line(page)).toHaveAttribute("aria-expanded", "false");
    await expect(foot(page).getByTestId("session-row")).toHaveCount(1);
    await expect(foot(page).getByTestId("past-session")).toHaveCount(0);
  });

  test("starts from its own key", async ({ page }) => {
    await begin(page);
    await expect(async () => {
      if ((await page.getByTestId("palette").count()) === 0) await page.keyboard.press(NEW_CHAT);
      await expect(page.getByTestId("palette-chip")).toHaveText("New chat", { timeout: 1000 });
    }).toPass();
    await askingChat(page);
    await startNew(page);
    await chatOnScreen(page);
  });

  test("starts from the palette's command", async ({ page }) => {
    await begin(page);
    await expect(async () => {
      if ((await page.getByTestId("palette").count()) === 0) await page.keyboard.press("ControlOrMeta+Shift+P");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("New chat");
      await expect(page.getByTestId("palette-row").first()).toContainText("New chat", { timeout: 1000 });
    }).toPass();
    await page.keyboard.press("Enter");
    await askingChat(page);
    await startNew(page);
    await chatOnScreen(page);
  });

  test("is offered quietly beside New session in a project with none", async ({ page }) => {
    await begin(page);
    const offer = page.getByTestId("start-chat");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText("New chat");
    await expect(page.getByTestId("start-agent")).toBeVisible();
    await offer.click();
    await askingChat(page);
  });

  test("closes back to its project, which keeps its terminal", async ({ page }) => {
    await begin(page);
    await page.getByTestId("start-agent").click();
    await startNew(page);
    await expect(page.getByTestId("chat-mark")).toHaveCount(0);
    await expect(page.getByTestId("chat-readout")).toHaveCount(0);

    await line(page).click();
    await page.getByTestId("new-chat-here").click();
    await startNew(page);
    await chatOnScreen(page);

    await page.getByTestId("project-section").getByTestId("session-row").first().click();
    await expect(page.getByTestId("chat-readout")).toHaveCount(0);
  });
});

test.describe("a chat in front", () => {
  /** A new chat on screen, started from the tray. */
  async function newChat(page: Page) {
    await begin(page);
    await line(page).click();
    await page.getByTestId("new-chat-here").click();
    await startNew(page);
    await chatOnScreen(page);
  }
  const menu = (page: Page) =>
    page.evaluate(() => (window as unknown as { __menuEnabled?: Record<string, boolean> }).__menuEnabled ?? {});
  const MOD = process.platform === "darwin" ? "Meta" : "Control";

  test("greys out New File, whose key starts no file", async ({ page }) => {
    await newChat(page);
    await expect.poll(async () => (await menu(page))["file.new"]).toBe(false);
    await page.getByTestId("mode-editor").click();
    await page.keyboard.press(`${MOD}+Alt+n`);
    await expect(page.getByTestId("name-field")).toHaveCount(0);
  });

  test("greys out New Untitled, whose key opens no tab", async ({ page }) => {
    await newChat(page);
    await expect.poll(async () => (await menu(page))["file.untitled"]).toBe(false);
    await page.getByTestId("mode-editor").click();
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  });

  test("greys out New Shell, whose key opens no terminal", async ({ page }) => {
    await newChat(page);
    await expect.poll(async () => (await menu(page))["terminal.new"]).toBe(false);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+t" : "Control+Shift+t");
    await expect(page.locator("section[data-pane='terminal']")).toBeHidden();
    // Back in the project, the three can act again.
    await page.getByTestId("project-head").first().click();
    await expect.poll(async () => (await menu(page))["terminal.new"]).toBe(true);
    expect((await menu(page))["file.new"]).toBe(true);
    expect((await menu(page))["file.untitled"]).toBe(true);
  });

  test("leaves the editor as it is with no project, never the chats folder's tree", async ({ page }) => {
    await newChat(page);
    await page.getByTestId("mode-editor").click();
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
    await expect(page.locator("section[data-pane='changes'] > header .title")).toHaveText("Files");
    await expect(page.getByTestId("file-tree")).not.toContainText("chats");
    await expect(page.getByTestId("file-tree").getByRole("treeitem")).toHaveCount(0);
  });
});

test.describe("past chats", () => {
  test("are all in the older chats list, filtered by name, and resume", async ({ page }) => {
    await begin(page);
    await line(page).click();
    await page.getByTestId("older-chats").click();
    const dialog = page.getByTestId("resume");
    await expect(dialog.locator("h2")).toHaveText("Chats: all 7");
    await expect(dialog.getByTestId("resume-chat")).toHaveCount(7);

    await page.getByTestId("resume-filter").fill("about the");
    await expect(dialog.getByTestId("resume-chat")).toHaveCount(1);
    await dialog.getByTestId("resume-chat").click();
    await expect(dialog).toHaveCount(0);
    await chatOnScreen(page);
    await expect(agentTitle(page)).toContainText("Ask about the lease");
  });

  test("resume from the tray, which closes on the pick", async ({ page }) => {
    await begin(page);
    await line(page).click();
    await foot(page).getByTestId("past-session").filter({ hasText: "Regex for dates" }).click();
    await chatOnScreen(page);
    await expect(line(page)).toHaveAttribute("aria-expanded", "false");
    await expect(foot(page).getByTestId("session-row")).toHaveCount(1);
    await expect(foot(page).getByTestId("session-row")).toContainText("Regex for dates");
  });

  test("are found by go to in a group of their own", async ({ page }) => {
    await begin(page);
    await expect(async () => {
      if ((await page.getByTestId("palette").count()) === 0) await page.keyboard.press("ControlOrMeta+p");
      await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "goto", { timeout: 1000 });
    }).toPass();
    await page.keyboard.type("invoice");
    const row = page.getByTestId("palette-row").filter({ hasText: "Invoice export formats" });
    await expect(row).toHaveAttribute("data-kind", "past");
    await expect(row.getByTestId("palette-detail")).toHaveText("chat");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await chatOnScreen(page);
    await expect(agentTitle(page)).toContainText("Invoice export formats");
  });
});

test.describe("sessions a chat starts", () => {
  test("are drawn in their own project, tagged, and counted on the chat's row", async ({ page }) => {
    await begin(page, [], { ...NO_WORKFLOW, integrated: ["claude-code"] });
    await line(page).click();
    await page.getByTestId("new-chat-here").click();
    await startNew(page);
    await chatOnScreen(page);
    await expect(page.getByTestId("composer-input")).toBeEnabled();

    // The chat's agent calls start, and the window, asked once for a
    // project of the user's, lets it.
    await page.evaluate(
      `(() => { const f = window.__integrated; f.startTurn("int-1");
         window.__startCall = f.startTool("int-1", "mcp__chord__start", { project: "${PROJECT}", prompt: "Look at the export" }, { kind: "mcp" }); })()`,
    );
    await page.evaluate(
      ({ cwd, project }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id: "c-1",
          tool: "start",
          arguments: { project, prompt: "Look at the export" },
          cwd,
          session: "integrated-session-1",
        }),
      { cwd: CHATS_FOLDER, project: PROJECT },
    );
    const allow = page.getByTestId("conduct-allow");
    await expect
      .poll(async () => {
        if (await allow.isVisible()) await allow.click();
        return (await answerTo(page, "c-1")) !== null;
      })
      .toBe(true);
    const content = (await answerTo(page, "c-1"))!.content!;
    expect(content).toMatch(/Started session \S+/);
    await page.evaluate((content) => {
      const f = (
        window as unknown as { __integrated: { finishTool(id: string, call: string, output: string): void; endTurn(id: string): void } }
      ).__integrated;
      f.finishTool("int-1", (window as unknown as { __startCall: string }).__startCall, content);
      f.endTurn("int-1");
    }, content);

    const project = page.getByTestId("project-section");
    await expect(project.getByTestId("chat-tag")).toBeVisible();
    await expect(foot(page).getByTestId("started-dots").locator(".dot")).toHaveCount(1);
    await expect(page.getByTestId("started-session")).toHaveCount(1);
    await expect(page.getByTestId("open-started")).toBeVisible();

    await page.getByTestId("open-started").click();
    await expect(page.getByTestId("chat-readout")).toHaveCount(0);
    await project.getByTestId("chat-tag").click();
    await chatOnScreen(page);
  });
});
