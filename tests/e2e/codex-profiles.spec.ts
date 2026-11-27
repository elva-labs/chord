import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore, paletteChoice } from "./fake";

// A Codex session runs under a profile picked as a step of the palette's new
// session flow: the step, the readout in the status bar and the model menu
// of the conversation that runs under it.

const PROFILES = [
  { name: "fast", model: "gpt-5-codex", effort: "low", provider: null, leftOut: ["approval_policy", "query_params"] },
  { name: "review", model: null, effort: null, provider: "lab", leftOut: [] },
];

async function open(page: Page, profiles: unknown[] = PROFILES) {
  await installFakeCore(page, {
    open: [PROJECT],
    agents: ["codex"],
    integrable: ["codex"],
    settings: { integrated: ["codex"] },
  });
  await page.addInitScript((listed) => {
    (window as unknown as { __codexProfiles: unknown }).__codexProfiles = { "": listed };
  }, profiles);
  await page.goto("/");
  await page.getByTestId("start-agent").click();
}

test("asks which profile a Codex session runs under, and says what each sets", async ({ page }) => {
  await open(page);
  await page.locator("[data-testid='palette-row'][data-kind='change']").click();
  const rows = page.getByTestId("palette-row");
  await expect(page.getByTestId("palette-label")).toHaveText(["No profile", "fast", "review"]);
  const fast = paletteChoice(page, "fast");
  await expect(fast.getByTestId("palette-detail")).toHaveText("fast.config.toml · 2 settings left out");
  await expect(fast.getByTestId("palette-end")).toContainText("low");
  await expect(paletteChoice(page, "review").getByTestId("palette-end")).toContainText("lab");
  // Each line is drawn whole, inside the palette, and none sits on another.
  const palette = (await page.getByTestId("palette").boundingBox())!;
  let below = 0;
  for (const box of await Promise.all([0, 1, 2].map((at) => rows.nth(at).boundingBox()))) {
    expect(box!.x).toBeGreaterThanOrEqual(palette.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(palette.x + palette.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(below - 1);
    below = box!.y + box!.height;
  }
  await fast.click();
  // The agent comes last, and Enter on it starts the session.
  await expect(page.getByTestId("palette-field")).toHaveAttribute("placeholder", "As which agent");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

test("names the profile in the status bar, with what was left out", async ({ page }) => {
  await open(page);
  await page.locator("[data-testid='palette-row'][data-kind='change']").click();
  await paletteChoice(page, "fast").click();
  await paletteChoice(page, "No agent").click();
  const readout = page.getByTestId("profile-readout");
  await expect(readout).toBeVisible();
  await expect(readout).toHaveText("profile: fast");
  await expect(readout).toHaveAttribute("title", /fast\.config\.toml[\s\S]*approval_policy/);
  const bar = (await page.getByTestId("profile-readout").boundingBox())!;
  const view = page.viewportSize()!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(view.width);
});

test("leads the model menu with the profile's model, above a rule and the provider's list", async ({ page }) => {
  await open(page);
  await page.locator("[data-testid='palette-row'][data-kind='change']").click();
  await paletteChoice(page, "fast").click();
  await paletteChoice(page, "No agent").click();
  await page.getByTestId("model-chip").click();
  const menu = page.getByTestId("model-menu");
  await expect(page.getByTestId("model-menu-heading")).toHaveText("Models of the fast profile's provider");
  const options = page.getByTestId("model-option");
  await expect(options).toHaveCount(2);
  const first = options.first();
  await expect(first).toContainText("Codex default");
  await expect(first).toContainText("GPT-5-Codex, as fast.config.toml sets it");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(1)).toContainText("GPT-5-Codex");
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "false");
  // The rule sits between the default and the list, inside the menu.
  const [one, rule, two, box] = await Promise.all([
    first.boundingBox(),
    page.getByTestId("model-menu-rule").boundingBox(),
    options.nth(1).boundingBox(),
    menu.boundingBox(),
  ]);
  expect(rule!.y).toBeGreaterThanOrEqual(one!.y + one!.height - 1);
  expect(rule!.y + rule!.height).toBeLessThanOrEqual(two!.y + 1);
  expect(rule!.x).toBeGreaterThanOrEqual(box!.x);
  expect(rule!.x + rule!.width).toBeLessThanOrEqual(box!.x + box!.width);
});

test("asks nothing and shows no profile where the account has none", async ({ page }) => {
  await open(page, []);
  await page.locator("[data-testid='palette-row'][data-kind='ready']").click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("profile-readout")).toHaveCount(0);
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-menu-heading")).toHaveText("Model · Codex");
  await expect(page.getByTestId("model-menu-rule")).toHaveCount(0);
});
