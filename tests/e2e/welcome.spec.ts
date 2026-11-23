import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, paletteChoice } from "./fake";

/**
 * The welcome, About and the Setup tab, on the fake core: what the checks
 * say, when Continue shows, and what each window asks of the core.
 */

const check = (id: string, binary: string, agent: boolean, found: boolean) => ({
  id,
  name: id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : "git",
  binary,
  agent,
  path: found ? `/usr/local/bin/${binary}` : null,
  version: found ? "1.0.0" : null,
  signedIn: agent && found ? true : null,
  install: { command: `install ${binary}`, link: `https://example.com/${binary}` },
});

/** A machine with the agents and git named in `found`. */
const machine = (...found: string[]) => ({
  checks: [
    check("claude-code", "claude", true, found.includes("claude")),
    check("codex", "codex", true, found.includes("codex")),
    check("git", "git", false, found.includes("git")),
  ],
  fromLoginShell: true,
});

async function holding(page: Page, setup: unknown) {
  await page.addInitScript((setup) => {
    (window as unknown as { __setup: unknown }).__setup = setup;
  }, setup);
}

const commands = (page: Page) =>
  page.evaluate(() => (window as unknown as { __windowCommands?: string[] }).__windowCommands ?? []);

test.describe("the welcome", () => {
  test.use({ reducedMotion: "reduce" });

  test("lists what was found and goes on with Continue", async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "Welcome to Chord" })).toBeVisible();
    await expect(page.locator('[data-check="claude-code"]')).toContainText("2.1.34");
    await expect(page.locator('[data-check="git"]')).toContainText("2.51.0");
    await expect(page.getByText("Kept in Settings, under Setup.")).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    expect(await commands(page)).toEqual(["welcome_continue"]);
  });

  test("lets the user go on when the checks could not tell", async ({ page }) => {
    await holding(page, { ...machine("git"), fromLoginShell: false });
    await installFakeCore(page);
    await page.goto("/welcome?again");
    await expect(page.getByTestId("welcome-unsure")).toHaveText(
      "Chord could not read your shell's setup, so an agent may be here all the same.",
    );
    await expect(page.getByRole("heading", { name: "Welcome to Chord" })).toBeVisible();
    await expect(page.getByText("Install Claude Code or Codex, then check again.")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    expect(await commands(page)).toEqual(["welcome_continue"]);
  });

  test("lets the user go on when the checks fail", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __setupFails: boolean }).__setupFails = true;
    });
    await installFakeCore(page);
    await page.goto("/welcome");
    await expect(page.getByTestId("welcome-unsure")).toHaveText(
      "Chord could not check this machine, so an agent may be here all the same.",
    );
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  });

  test("with no agent, demands one and holds Continue back until a check finds one", async ({ page }) => {
    await holding(page, machine("git"));
    await installFakeCore(page);
    await page.goto("/welcome?again");
    await expect(page.getByRole("heading", { name: "Chord needs an agent" })).toBeVisible();
    await expect(page.getByText("Install Claude Code or Codex, then check again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(page.locator('[data-check="codex"]')).toContainText("install codex");

    await page.evaluate((setup) => {
      (window as unknown as { __setup: unknown }).__setup = setup;
    }, machine("codex", "git"));
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome to Chord" })).toBeVisible();
    await expect(page.locator('[data-check="claude-code"]')).not.toContainText("install claude");
    expect(await page.evaluate(() => (window as unknown as { __setupFresh: boolean[] }).__setupFresh)).toEqual([
      false,
      true,
    ]);
  });

  test("opens a quiet row's steps on Install and copies its command", async ({ page }) => {
    await holding(page, machine("claude", "git"));
    await installFakeCore(page);
    await page.goto("/welcome");
    const codex = page.locator('[data-check="codex"]');
    await expect(codex).toContainText("Not found");
    await expect(codex.locator("code", { hasText: "install codex" })).toHaveCount(0);

    await codex.getByRole("button", { name: "Install" }).click();
    await codex.getByRole("button", { name: "Copy the command" }).click();
    await expect(codex.getByRole("status")).toHaveText("Copied");
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["install codex"]);

    await codex.getByRole("link", { name: "Install guide" }).click();
    expect(await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)).toEqual([
      "https://example.com/codex",
    ]);
  });
});

test("the welcome brings the checks in after the mark", async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/welcome");
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Chord" })).not.toHaveAttribute("style", /opacity/, {
    timeout: 6000,
  });
});

test("About shows the version, copies it with the system, and closes on Escape", async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/about");
  await expect(page.getByTestId("about-version")).toHaveText("1.0.0-test");
  await page.getByRole("button", { name: "Copy the version" }).click();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([
    "Chord 1.0.0-test (abcd1234), macOS 27.2, arm64",
  ]);

  await page.getByRole("link", { name: /github.com\/elva-labs\/chord/ }).click();
  expect(await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)).toEqual([
    "https://github.com/elva-labs/chord",
  ]);

  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as unknown as { __windowControls: string[] }).__windowControls)).toContain(
    "close",
  );
});

test("Check setup in the palette opens the Setup tab, which reads the machine again and shows the welcome", async ({
  page,
}) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Check setup");
  await paletteChoice(page, "Check setup").click();

  const tab = page.getByTestId("settings-setup");
  await expect(tab).toBeVisible();
  await expect(tab.locator('[data-check="codex"]')).toContainText("0.118.0");
  const reads = () => page.evaluate(() => (window as unknown as { __setupReads: number }).__setupReads);
  expect(await reads()).toBe(1);
  await tab.getByTestId("setup-check").click();
  await expect.poll(reads).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __setupFresh: boolean[] }).__setupFresh)).toEqual([
    false,
    true,
  ]);

  await tab.getByTestId("setup-welcome").click();
  expect(await commands(page)).toEqual(["welcome_show"]);
});
