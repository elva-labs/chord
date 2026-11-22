import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWN_LABEL,
  accountOf,
  accountToStart,
  accounts,
  accountsSettings,
  addAccount,
  adoptAccounts,
  dirFor,
  dirsOf,
  loadPicked,
  names,
  overrideOf,
  pickAccount,
  removeAccount,
  reset,
  setEverywhere,
  setOverride,
  slug,
  suggest,
} from "$lib/accounts.svelte";

const sent: unknown[] = [];

vi.mock("$lib/persist", () => ({
  persist: (change: unknown) => {
    sent.push(change);
  },
}));

const A = "/repo/one";
const B = "/repo/two";

beforeEach(() => {
  reset();
  sent.length = 0;
});

describe("a name suggests its directories", () => {
  it("spells the name the way a directory does", () => {
    expect(slug("Work")).toBe("work");
    expect(slug("Elva Labs")).toBe("elva-labs");
    expect(slug("  --Ünïcode & more!  ")).toBe("ünïcode-more");
    expect(slug("")).toBe("account");
  });

  it("puts each beside the agent's own, under the home", () => {
    expect(suggest("Work")).toEqual({
      claude: "~/.claude-work",
      codex: "~/.codex-work",
    });
  });
});

describe("adding and removing", () => {
  it("adds an account and sends the accounts whole", () => {
    expect(addAccount("Work", suggest("Work"))).toBeNull();
    expect(names()).toEqual(["Work"]);
    expect(dirFor("Work", "claude-code")).toBe("~/.claude-work");
    expect(dirFor("Work", "codex")).toBe("~/.codex-work");
    expect(sent).toEqual([
      {
        accounts: {
          list: { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } },
          everywhere: null,
          overrides: {},
        },
      },
    ]);
  });

  it("takes a directory left blank as the agent's own", () => {
    expect(addAccount(" Lab ", { claude: " /srv/claude ", codex: "  " })).toBeNull();
    expect(names()).toEqual(["Lab"]);
    expect(dirFor("Lab", "claude-code")).toBe("/srv/claude");
    expect(dirFor("Lab", "codex")).toBeUndefined();
  });

  it("refuses a name that will not do, and says why", () => {
    expect(addAccount("", suggest(""))).toMatch(/needs a name/);
    expect(addAccount("Work", suggest("Work"))).toBeNull();
    expect(addAccount("work", suggest("work"))).toMatch(/already/);
    // The harnesses' own login goes by Default, in any case, which no account
    // can take.
    for (const own of [OWN_LABEL, OWN_LABEL.toLowerCase(), ` ${OWN_LABEL.toUpperCase()} `])
      expect(addAccount(own, suggest("x"))).toBe("Default is the harnesses' own login, so no account can be called that.");
    expect(addAccount("x".repeat(41), suggest("x"))).toMatch(/at most/);
    expect(addAccount("Blank", { claude: "", codex: null })).toMatch(
      /at least one harness/,
    );
    expect(names()).toEqual(["Work"]);
  });

  it("removing an account sends its projects back to the rest", () => {
    addAccount("Work", suggest("Work"));
    addAccount("Lab", suggest("Lab"));
    setEverywhere("Work");
    setOverride(A, "Work");
    setOverride(B, "Lab");
    removeAccount("Work");
    expect(names()).toEqual(["Lab"]);
    expect(accountOf(A)).toBeNull();
    expect(overrideOf(A)).toBeUndefined();
    expect(accountOf(B)).toBe("Lab");
    expect(accountsSettings().everywhere).toBeNull();
  });
});

describe("which account a project runs under", () => {
  beforeEach(() => {
    addAccount("Work", suggest("Work"));
    addAccount("Lab", suggest("Lab"));
  });

  it("is the one for every project unless the project has a word of its own", () => {
    expect(accountOf(A)).toBeNull();
    setEverywhere("Work");
    expect(accountOf(A)).toBe("Work");
    expect(accountOf(B)).toBe("Work");
    setOverride(B, null);
    expect(accountOf(B)).toBeNull();
    expect(overrideOf(B)).toBeNull();
    setOverride(B, "Lab");
    expect(accountOf(B)).toBe("Lab");
    setOverride(B, undefined);
    expect(accountOf(B)).toBe("Work");
    expect(overrideOf(B)).toBeUndefined();
  });

  it("ignores a choice naming an account there is not", () => {
    setEverywhere("Nope");
    expect(accountsSettings().everywhere).toBeNull();
    setOverride(A, "Nope");
    expect(overrideOf(A)).toBeUndefined();
  });

  it("lists every account's directories for the agents' state", () => {
    expect(dirsOf()).toEqual([
      { claude: "~/.claude-lab", codex: "~/.codex-lab" },
      { claude: "~/.claude-work", codex: "~/.codex-work" },
    ]);
  });
});

describe("which account a new session starts under", () => {
  beforeEach(() => {
    localStorage.clear();
    addAccount("Work", suggest("Work"));
    addAccount("Lab", suggest("Lab"));
  });

  it("is the one picked there last where the project names none, else the project's", () => {
    setEverywhere("Work");
    expect(accountToStart(A)).toBe("Work");
    pickAccount(A, "Lab");
    expect(accountToStart(A)).toBe("Lab");
    expect(accountToStart(B)).toBe("Work");
    pickAccount(A, null);
    expect(accountToStart(A)).toBeNull();
    setOverride(A, "Work");
    expect(accountToStart(A)).toBe("Work");
  });

  it("forgets a pick whose account is gone", () => {
    pickAccount(A, "Lab");
    removeAccount("Lab");
    expect(accountToStart(A)).toBeNull();
    pickAccount(B, "Nope");
    expect(accounts.picked[B]).toBeUndefined();
  });

  it("keeps the picks between runs, dropping what does not read", () => {
    pickAccount(A, "Lab");
    pickAccount(B, null);
    accounts.picked = {};
    loadPicked();
    expect(accounts.picked).toEqual({ [A]: "Lab", [B]: null });
    localStorage.setItem("chord.pickedAccounts", JSON.stringify({ [A]: 3, [B]: "Work" }));
    loadPicked();
    expect(accounts.picked).toEqual({ [B]: "Work" });
    localStorage.setItem("chord.pickedAccounts", "{");
    loadPicked();
    expect(accounts.picked).toEqual({ [B]: "Work" });
  });
});

describe("taking the core's word", () => {
  it("keeps what is well formed and drops a choice the list does not hold", () => {
    adoptAccounts({
      list: {
        Work: { claude: "~/.claude-work", codex: null },
        Bad: "nope" as unknown as { claude: null; codex: null },
      },
      everywhere: "Gone",
      overrides: { [A]: "Work", [B]: "Gone", "/c": null },
    });
    expect(names()).toEqual(["Work"]);
    expect(accountsSettings().everywhere).toBeNull();
    expect(accountOf(A)).toBe("Work");
    expect(overrideOf(B)).toBeUndefined();
    expect(overrideOf("/c")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("reads a settings object without accounts as none", () => {
    addAccount("Work", suggest("Work"));
    adoptAccounts(undefined);
    expect(names()).toEqual([]);
    expect(accountOf(A)).toBeNull();
  });
});
