import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import StatusBar from "$lib/components/StatusBar.svelte";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { create, reset as resetSessions, select, started } from "$lib/sessions.svelte";
import { resetProfiles } from "$lib/codexProfiles.svelte";

/** What the core says of each folder asked about, in order. */
const asked: string[] = [];
let isRepository = true;
/** The Codex profiles the core lists, for any account. */
let listedProfiles: unknown[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    projectInfo: async (path: string) => {
      asked.push(path);
      if (!isRepository) throw new Error("not a repository");
      return { path, name: "repo", repository: path, isGit: true, branch: "main" };
    },
    codexProfiles: async () => listedProfiles,
  }),
}));

beforeEach(() => {
  resetSessions();
  resetAccounts();
  asked.length = 0;
  isRepository = true;
  listedProfiles = [];
  resetProfiles();
});

function open() {
  const session = create("/home/ada/dev/repo", null, "claude-code", null);
  started(session.key, "pty-1", "sid-1");
  select(session.key);
  return session;
}

describe("the status bar's session words", () => {
  it("names the account only once there is more than one", async () => {
    open();
    render(StatusBar);
    expect(screen.queryByTestId("account-readout")).toBeNull();
  });

  it("names the account when the user has accounts of their own", async () => {
    accounts.list.Work = { claude: "~/.claude-work", codex: null };
    open();
    render(StatusBar);
    expect(screen.getByTestId("account-readout")).toHaveTextContent("account: Default");
  });

  it("names the Codex profile the session runs under, and none for a session under none", async () => {
    const session = create("/home/ada/dev/repo", null, "codex", null);
    started(session.key, "pty-1", "sid-1");
    select(session.key);
    render(StatusBar);
    expect(screen.queryByTestId("profile-readout")).toBeNull();
    session.profile = "fast";
    await waitFor(() => expect(screen.getByTestId("profile-readout")).toHaveTextContent("profile: fast"));
    expect(screen.getByTestId("profile-readout")).toHaveAttribute("title", "Codex profile fast.config.toml");
  });

  it("names the settings of the profile's file the session is not given", async () => {
    listedProfiles = [
      { name: "fast", model: null, effort: null, provider: null, leftOut: ["approval_policy", "mcp_servers"] },
    ];
    const session = create("/home/ada/dev/repo", null, "codex", null);
    session.profile = "fast";
    started(session.key, "pty-1", "sid-1");
    select(session.key);
    render(StatusBar);
    await waitFor(() =>
      expect(screen.getByTestId("profile-readout")).toHaveAttribute(
        "title",
        "Codex profile fast.config.toml\n2 settings left out: approval_policy, mcp_servers",
      ),
    );
  });

  it("reads the branch for a folder, and shows none for one that is no repository", async () => {
    open();
    render(StatusBar);
    await waitFor(() => expect(screen.getByTestId("branch-readout")).toHaveTextContent("main"));
    expect(asked).toContain("/home/ada/dev/repo");
  });

  it("shows no branch when the folder cannot be read", async () => {
    isRepository = false;
    open();
    render(StatusBar);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("folder-readout")).toBeNull();
    expect(screen.queryByTestId("branch-readout")).toBeNull();
  });

  it("tells a screen reader politely only when the session asks", async () => {
    const session = open();
    session.kind = "integrated";
    render(StatusBar);
    const said = screen.getByTestId("state-said");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveTextContent("");

    session.working = true;
    expect(screen.queryByTestId("state-readout")).toBeNull();
    expect(said).toHaveTextContent("");

    session.working = false;
    session.needs = "permission";
    await waitFor(() => expect(said).toHaveTextContent("waits for permission"));

    session.needs = null;
    await waitFor(() => expect(said).toHaveTextContent(""));
  });
});
