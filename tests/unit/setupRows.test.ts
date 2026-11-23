import { describe, expect, it } from "vitest";
import type { Setup, SetupCheck } from "$lib/core";
import { BLOCKED, agentFound, blocked, groups } from "$lib/setupRows";

const check = (id: string, binary: string, agent: boolean, over: Partial<SetupCheck> = {}): SetupCheck => ({
  id,
  name: id,
  binary,
  agent,
  path: `/usr/local/bin/${binary}`,
  version: "1.0.0",
  signedIn: agent ? true : null,
  install: { command: `install ${binary}`, link: `https://example.com/${binary}` },
  ...over,
});

const missing = { path: null, version: null, signedIn: null };

const machine = (...checks: SetupCheck[]): Setup => ({ checks, fromLoginShell: true });

describe("setup rows", () => {
  it("lets the app go on with one agent, and demands one when there is none", () => {
    const one = machine(check("claude-code", "claude", true), check("codex", "codex", true, missing));
    expect(agentFound(one)).toBe(true);
    expect(blocked(one)).toBeNull();

    const none = machine(
      check("claude-code", "claude", true, missing),
      check("codex", "codex", true, missing),
      check("git", "git", false),
    );
    expect(agentFound(none)).toBe(false);
    expect(blocked(none)).toBe(BLOCKED);
  });

  it("keeps a missing agent quiet beside a found one, and loud when none is found", () => {
    const quiet = groups(machine(check("claude-code", "claude", true), check("codex", "codex", true, missing)));
    expect(quiet.agents[1]).toMatchObject({ icon: "none", status: "Not found", open: false, command: "install codex" });

    const loud = groups(machine(check("claude-code", "claude", true, missing), check("codex", "codex", true, missing)));
    expect(loud.agents.map((row) => [row.icon, row.open])).toEqual([
      ["need", true],
      ["need", true],
    ]);
  });

  it("asks a found agent that is not signed in to be run once", () => {
    const { agents } = groups(machine(check("codex", "codex", true, { signedIn: false })));
    expect(agents[0]).toMatchObject({
      icon: "need",
      extra: { text: "Not signed in", tone: "warn" },
      command: "codex",
      open: true,
      guide: null,
    });
  });

  it("says Found for a program that gave no version, and Signed in for a signed-in agent", () => {
    const { agents } = groups(machine(check("claude-code", "claude", true, { version: null })));
    expect(agents[0]).toMatchObject({ icon: "ok", status: "Found", extra: { text: "Signed in", tone: "plain" } });
  });

  it("puts git under source control and asks for it without holding the app back", () => {
    const setup = machine(check("claude-code", "claude", true), check("git", "git", false, { ...missing, install: { command: null, link: "https://git-scm.com" } }));
    const { agents, tools } = groups(setup);
    expect(agents.map((row) => row.id)).toEqual(["claude-code"]);
    expect(tools[0]).toMatchObject({ icon: "need", binary: null, command: null, guide: "https://git-scm.com", open: true });
    expect(blocked(setup)).toBeNull();
  });
});
