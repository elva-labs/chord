import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrived,
  itemsFor,
  listed,
  load,
  loadMedia,
  media,
  openItem,
  ownerFor,
  presented,
  render,
  renderSaid,
  resetMedia,
  saidBlocks,
  settled,
} from "$lib/media.svelte";
import { closeViewer, files } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import {
  sessions,
  create,
  located,
  reset as resetSessions,
  select,
  started,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { resetHeld, switched } from "$lib/show.svelte";
import { resetGoingOn } from "$lib/goingOn.svelte";

/** A README naming images of its project, and what was read for it. */
const project = vi.hoisted(() => ({
  readme: [
    "# Readme",
    "",
    '<img src="docs/icon.png" width="128" height="128" alt="">',
    "",
    "![shot](docs/shot.png?raw=1) ![again](docs/icon.png) ![spaced](docs/my%20icon.png) ![gone](docs/gone.png) ![said](docs/said.png)",
  ].join("\n"),
  reads: [] as { root: string; document: string; file: string }[],
  /** Other documents by their path, and other images of the project by
      their path in it: how large each is and how long its read takes. */
  documents: new Map<string, string>(),
  files: new Map<string, { size: number; wait: number }>(),
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async ptyCwd() {
      return null;
    },
    async readMedia(path: string) {
      const written = project.documents.get(path);
      if (written !== undefined) return { mime: "text/markdown", data: btoa(written), size: written.length };
      if (path.includes("missing")) throw new Error(`could not read ${path}`);
      if (path.endsWith("README.md"))
        return { mime: "text/markdown", data: btoa(project.readme), size: project.readme.length };
      if (path.endsWith(".md"))
        return { mime: "text/markdown", data: btoa("# Draft"), size: 7 };
      if (path.endsWith(".html"))
        return { mime: "text/html", data: btoa("<h1>Page</h1>"), size: 13 };
      if (path.endsWith(".mmd"))
        return {
          mime: "text/vnd.mermaid",
          data: btoa("graph TD; A-->B"),
          size: 15,
        };
      return {
        mime: path.endsWith(".pdf") ? "application/pdf" : "image/png",
        data: "AAAA",
        size: 3,
      };
    },
    async readDocumentImage(root: string, document: string, file: string) {
      project.reads.push({ root, document, file });
      const sized = project.files.get(file);
      if (sized !== undefined) {
        await new Promise((done) => setTimeout(done, sized.wait));
        return { mime: "image/png", data: "AAAA", size: sized.size };
      }
      if (file === "docs/said.png") return { mime: "text/plain", data: "AAAA", size: 3 };
      if (file.endsWith("icon.png") || file === "docs/shot.png")
        return { mime: "image/png", data: "AAAA", size: 3 };
      throw new Error(`${file} is not there`);
    },
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});
const request = (
  files: string[],
  cwd = "/one",
  caption: string | null = "Shots.",
  session: string | null = null,
) => ({ files, caption, cwd, session });

beforeEach(() => {
  localStorage.clear();
  project.reads.length = 0;
  project.documents.clear();
  project.files.clear();
  resetMedia();
  resetGoingOn();
  resetHeld();
  closeViewer();
  resetWorkspace();
  resetSessions();
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
});

describe("whose media it is", () => {
  it("is the session the request's token names, kept by the agent's id", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    // Two sessions in one directory: the request's token says which.
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, b.token), "/one"),
    ).toBe("s2");
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, a.token), "/one"),
    ).toBe("s1");
    // An agent's id names no session: the tools answer with ids.
    expect(ownerFor(request(["/one/x.png"], "/one", null, "s2"), "/one")).toBe(
      "project:/one",
    );
  });

  it("is the project for a call that names no session the window knows, wherever it is made", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    select(a.key);
    // Nothing is taken from the folder or from the session on screen.
    for (const session of [null, "made-up"]) {
      expect(ownerFor(request(["/one/x.png"], "/one", null, session), "/one")).toBe(
        "project:/one",
      );
    }
  });

  it("is the session that presents a file of a nested project", () => {
    workspace.open.push(repo("/one/sub"));
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const nested = create("/one/sub");
    started(nested.key, "pty-2", "s2");
    presented(request(["/one/sub/x.png"], "/one", "Shot.", a.token));
    expect(itemsFor("s1")).toHaveLength(1);
    expect(itemsFor("s1")[0].project).toBe("/one/sub");
    expect(itemsFor("s2")).toEqual([]);
    expect(itemsFor("project:/one/sub")).toEqual([]);
  });

  it("falls to the project while the session's id is not known", () => {
    const fresh = create("/one");
    select(fresh.key);
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, fresh.token), "/one"),
    ).toBe("project:/one");
  });
});

describe("presenting", () => {
  it("keeps the files on the session, brings the project forward and opens them in the viewer", () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    // Another project is in front than the one the files are in.
    workspace.active = "/two";
    presented(
      request(["/one/a.png", "/one/b.pdf"], "/one", "Shots.", session.token),
      1_700_000_000_000,
    );
    expect(workspace.active).toBe("/one");
    expect(files.media?.files).toEqual(["/one/a.png", "/one/b.pdf"]);
    expect(layout.mode).toBe("reviewing");
    expect(itemsFor("s1")).toHaveLength(1);
    expect(itemsFor("s1")[0].caption).toBe("Shots.");
    // Bringing the project forward opens no session.
    expect(sessions.active).toBeNull();
  });

  it("keeps the files on a session the user is not looking at, and opens them on switching", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    presented(
      request(["/one/a.png"], "/one", "Shot.", a.token),
      1_700_000_000_000,
    );
    expect(itemsFor("s1")).toHaveLength(1);
    expect(files.media).toBeNull();
    expect(layout.mode).not.toBe("reviewing");
    select(a.key);
    switched(a.key);
    expect(files.media?.files).toEqual(["/one/a.png"]);
    expect(layout.mode).toBe("reviewing");
  });

  it("keeps one item for the same files, newest, with the latest caption", () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    const mine = (files: string[], caption: string | null = "Shots.") =>
      request(files, "/one", caption, session.token);
    presented(mine(["/one/draft.md"], "First."), 1_700_000_000_000);
    presented(mine(["/one/other.png"], "Other."), 1_700_000_001_000);
    const first = itemsFor("s1")[1];
    // The same file again, however it is listed: the item, not another.
    presented(mine(["/one/draft.md"], "Second."), 1_700_000_002_000);
    expect(itemsFor("s1")).toHaveLength(2);
    expect(itemsFor("s1")[0].id).toBe(first.id);
    expect(itemsFor("s1")[0].caption).toBe("Second.");
    expect(itemsFor("s1")[0].at).toBe(1_700_000_002);
    expect(files.media?.id).toBe(first.id);
    // Each call is counted, however soon after the last, and the count is
    // not kept with the list.
    presented(mine(["/one/draft.md"], "Second."), 1_700_000_002_200);
    expect(media.calls[first.id]).toBe(3);
    expect(localStorage.getItem("chord.media")).not.toContain("calls");
    // A set is the same set in any order; a different set is another item.
    presented(mine(["/one/b.png", "/one/a.png"]), 1_700_000_003_000);
    presented(mine(["/one/a.png", "/one/b.png"]), 1_700_000_004_000);
    presented(mine(["/one/a.png"]), 1_700_000_005_000);
    expect(itemsFor("s1")).toHaveLength(4);
    expect(itemsFor("s1")[1].files).toEqual(["/one/a.png", "/one/b.png"]);
    // Another session's item is its own.
    const other = create("/one");
    started(other.key, "pty-2", "s2");
    presented(request(["/one/draft.md"], "/one", "Theirs.", other.token));
    expect(itemsFor("s1")).toHaveLength(4);
    expect(itemsFor("s2")).toHaveLength(1);
  });

  it("does nothing for files outside every open project", () => {
    presented(request(["/nowhere/a.png"], "/nowhere"));
    expect(files.media).toBeNull();
    expect(media.items).toEqual([]);
  });

  it("survives a restart, newest first, and keeps more than fifty for one owner", () => {
    for (let i = 0; i < 55; i += 1) {
      presented(request([`/one/${i}.png`]), 1_700_000_000_000 + i * 1000);
    }
    resetMedia();
    loadMedia();
    const mine = itemsFor("project:/one");
    expect(mine).toHaveLength(55);
    expect(mine[0].files).toEqual(["/one/54.png"]);
    expect(mine[54].files).toEqual(["/one/0.png"]);
  });

  it("drops the oldest items of unlisted owners past the total, never an open session's", () => {
    const row = create("/one");
    started(row.key, "pty-1", "live");
    presented(request(["/one/live.png"], "/one", "Live.", row.token), 1_700_000_000_000);
    for (let i = 0; i < 1005; i += 1) {
      media.items.push({ id: `gone-${i}`, owner: "gone", project: "/one", files: [`/one/${i}.png`], caption: null, at: i });
    }
    presented(request(["/one/live2.png"], "/one", "Live.", row.token), 1_700_000_001_000);
    expect(media.items).toHaveLength(1000);
    expect(itemsFor("live")).toHaveLength(2);
    expect(itemsFor("gone")).toHaveLength(1000 - 2);
    expect(itemsFor("gone")[0].files).toEqual(["/one/1004.png"]);
  });

  it("lists what a session presented before its id was known once the id arrives", () => {
    const row = create("/one");
    presented(request(["/one/early.png"], "/one", "Early.", row.token), 1_700_000_001_000);
    expect(media.items[0].owner).toBe("project:/one");
    started(row.key, "pty-1", "later-id");
    select(row.key);
    expect(listed().map((item) => item.caption)).toEqual(["Early."]);
    const other = create("/one");
    started(other.key, "pty-2", "other-id");
    expect(itemsFor("other-id", other.token)).toEqual([]);
  });


  describe("for a session that went on from another conversation", () => {
    /** A window that left media under a conversation which a later one went
        on from. */
    function wentOn(lineage: Record<string, string>) {
      localStorage.setItem("chord.wentOn", JSON.stringify(lineage));
      resetGoingOn();
    }

    it("lists what its earlier conversations presented, from what was stored before", () => {
      const row = create("/one");
      started(row.key, "pty-1", "old-id");
      presented(request(["/one/plan.md"], "/one", "Plan.", row.token), 1_700_000_001_000);
      resetMedia();
      loadMedia();
      wentOn({ "new-id": "old-id" });
      expect(itemsFor("new-id").map((item) => item.caption)).toEqual(["Plan."]);
      // The conversation it went on from lists only its own.
      expect(itemsFor("old-id")).toHaveLength(1);
      expect(itemsFor("other-id")).toEqual([]);
    });

    it("lists the whole line, newest first, and a call after going on joins it", () => {
      wentOn({ second: "first", third: "second" });
      const row = create("/one");
      started(row.key, "pty-1", "first");
      presented(request(["/one/a.png"], "/one", "One.", row.token), 1_700_000_001_000);
      started(row.key, "pty-1", "second");
      presented(request(["/one/b.png"], "/one", "Two.", row.token), 1_700_000_002_000);
      started(row.key, "pty-1", "third");
      presented(request(["/one/c.png"], "/one", "Three.", row.token), 1_700_000_003_000);
      expect(itemsFor("third").map((item) => item.caption)).toEqual(["Three.", "Two.", "One."]);
      select(row.key);
      expect(listed().map((item) => item.caption)).toEqual(["Three.", "Two.", "One."]);
    });

    it("keeps one row for a set of files presented again after going on", () => {
      wentOn({ "new-id": "old-id" });
      const row = create("/one");
      started(row.key, "pty-1", "old-id");
      presented(request(["/one/plan.md"], "/one", "Early.", row.token), 1_700_000_001_000);
      const first = itemsFor("old-id")[0];
      started(row.key, "pty-1", "new-id");
      presented(request(["/one/plan.md"], "/one", "Later.", row.token), 1_700_000_002_000);
      expect(itemsFor("new-id")).toHaveLength(1);
      expect(itemsFor("new-id")[0].caption).toBe("Later.");
      // The earlier conversation keeps its own item.
      expect(itemsFor("old-id").map((item) => item.id)).toEqual([first.id]);
      expect(itemsFor("old-id")[0].caption).toBe("Early.");
    });

    it("leaves each of two sessions that went on from one conversation its media", () => {
      wentOn({ "left-id": "root", "right-id": "root" });
      const row = create("/one");
      started(row.key, "pty-1", "root");
      presented(request(["/one/x.png"], "/one", "Root.", row.token), 1_700_000_001_000);
      started(row.key, "pty-1", "left-id");
      presented(request(["/one/x.png"], "/one", "Left.", row.token), 1_700_000_002_000);
      started(row.key, "pty-1", "right-id");
      presented(request(["/one/x.png"], "/one", "Right.", row.token), 1_700_000_003_000);
      expect(itemsFor("root")).toHaveLength(1);
      expect(itemsFor("root")[0].caption).toBe("Root.");
      expect(itemsFor("left-id")[0].caption).toBe("Left.");
      expect(itemsFor("right-id")[0].caption).toBe("Right.");
    });

    it("lists the media of a chain of more than eight conversations", () => {
      const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
      wentOn(Object.fromEntries(ids.slice(1).map((id, i) => [id, ids[i]])));
      const row = create("/one");
      ids.forEach((id, i) => {
        started(row.key, "pty-1", id);
        presented(request([`/one/${i}.png`], "/one", `n${i}`, row.token), 1_700_000_000_000 + i * 1000);
      });
      expect(itemsFor("c11")).toHaveLength(12);
      expect(itemsFor("c11")[11].caption).toBe("n0");
    });
  });

  it("opens a call again from the list, and closes with the viewer", () => {
    presented(request(["/one/a.png", "/one/b.png", "/one/c.png"]));
    closeViewer();
    expect(files.media).toBeNull();
    openItem(media.items[0]);
    expect(files.media?.id).toBe(media.items[0].id);
    expect(layout.mode).toBe("reviewing");
  });

  it("renders a Markdown document, the HTML a README may hold drawn and the rest as text", async () => {
    const html = render("# Draft\n\nHello *there*, <b>bold</b> <span>plain</span>.");
    expect(html).toContain("<h1>Draft</h1>");
    expect(html).toContain("<em>there</em>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("&lt;span&gt;plain&lt;/span&gt;");
    const loaded = await load("/one/draft.md");
    expect("html" in loaded && loaded.html).toContain("<h1>");
  });

  // A document is the agent's, or came with a repository from anywhere.
  it("lets a link point only at the web, and an image only at the web or data", () => {
    const html = render(
      '[run](javascript:alert(1)) [site](https://example.com "Ex") [mail](mailto:a@b.c)\n\n![x](javascript:alert(2)) ![y](https://example.com/y.png)',
    );
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<p>run <a /);
    expect(html).toContain(
      'href="https://example.com" title="Ex (https://example.com)" rel="noopener noreferrer"',
    );
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('<img src="https://example.com/y.png" alt="y">');
    expect(html).toContain("x");
  });

  it("hands a page and a diagram over as their source", async () => {
    expect(await load("/one/page.html")).toEqual({
      mime: "text/html",
      page: "<h1>Page</h1>",
    });
    expect(await load("/one/flow.mmd")).toEqual({
      mime: "text/vnd.mermaid",
      diagram: "graph TD; A-->B",
    });
  });

  it("draws a document's images from its project, each read once, and the rest as their text", async () => {
    project.reads.length = 0;
    const loaded = await load("/one/README.md", "/one");
    expect(project.reads.map((read) => read.file).sort()).toEqual(
      ["docs/gone.png", "docs/icon.png", "docs/my icon.png", "docs/said.png", "docs/shot.png"],
    );
    for (const read of project.reads) expect(read).toMatchObject({ root: "/one", document: "README.md" });
    const box = document.createElement("div");
    box.innerHTML = "html" in loaded ? loaded.html : "";
    expect([...box.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(
      Array(4).fill("data:image/png;base64,AAAA"),
    );
    expect(box.querySelector("img[width='128'][height='128']")).not.toBeNull();
    expect(box.textContent).toContain("gone");
    expect(box.textContent).toContain("said");
  });

  it("reads no image for a document with no project or outside its project", async () => {
    project.reads.length = 0;
    for (const [path, root] of [
      ["/one/README.md", null],
      ["/two/README.md", "/one"],
      ["/one/README.md", "/one/README.md"],
    ] as const) {
      const loaded = await load(path, root);
      expect("html" in loaded && loaded.html).toContain("<h1>Readme</h1>");
      expect("html" in loaded && loaded.html).not.toContain("<img");
    }
    expect(project.reads).toEqual([]);
  });

  it("reads a file as a data URL, or says why it cannot", async () => {
    expect(await load("/one/a.png")).toEqual({
      url: "data:image/png;base64,AAAA",
      mime: "image/png",
    });
    const gone = await load("/one/missing.png");
    expect("error" in gone && gone.error).toContain("could not read");
  });
});

describe("what an agent says in a conversation", () => {
  describe("a fenced block with no language", () => {
    const fence = (text: string) => renderSaid("```\n" + text + "\n```");
    const long = "word ".repeat(30).trim();

    it("wraps a drafted message and a list", () => {
      const html = fence(
        `Hi team,\n\n- first ${long}\n  - nested ${long}\n\nThanks`,
      );
      expect(html).toContain("data-wrap");
      expect(html).toContain('style="--hang:2ch"');
      expect(html).toContain('style="--hang:4ch"');
    });

    it.each([
      ["an ASCII table", `| name | note |\n|------|------|\n| a | ${long} |`],
      [
        "a directory tree",
        `src\n\u251c\u2500\u2500 lib\n\u2502   \u2514\u2500\u2500 ${long}.ts`,
      ],
      [
        "command output",
        `-rw-r--r--  1 user  staff  120 Nov 19 10:00 ${long}.txt\ndrwxr-xr-x  3 user  staff   96 Nov 19 10:01 src`,
      ],
      [
        "a stack trace",
        `Error: boom\n    at run (/app/src/index.ts:12:5)\n    at Object.<anonymous> (/app/src/main.ts:3:1)`,
      ],
      [
        "a Python traceback",
        `Traceback (most recent call last):\n  File "app.py", line 3, in run\n    boom()`,
      ],
      ["a diff", `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-let a = 1\n+let b = 2`],
    ])("keeps the lines of %s", (_, text) => {
      const html = fence(text);
      expect(html).not.toContain("data-wrap");
      expect(html).not.toContain('class="line"');
    });

    it("wraps a block marked as text", () => {
      expect(renderSaid("```text\nHello there\n```")).toContain("data-wrap");
    });
  });

  it("is rendered as a document is, with an image from an address shown as a link to it", () => {
    const html = renderSaid(
      "Look ![chart](https://example.com/leak?x=secret) and ![dot](data:image/png;base64,AAAA) and [docs](https://example.com) <img src=x>",
    );
    expect(html).not.toContain('src="https://example.com');
    expect(html).toContain('<a href="https://example.com/leak?x=secret" title="https://example.com/leak?x=secret" rel="noopener noreferrer">chart</a>');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="dot">');
    expect(html).toContain('<a href="https://example.com" title="https://example.com" rel="noopener noreferrer">docs</a>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(renderSaid("![x](javascript:alert(1))")).not.toContain("javascript:");
  });

  it("is drawn a block at a time as it is drawn whole, reference links and raw HTML included", () => {
    const md = [
      "## The plan\n\nRead [the docs][d] first, then <b>this</b>:",
      "- one\n- two\n\n  still two",
      "```rust\nlet x = 1;\n```",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "> quoted ![chart](https://example.com/c.png)",
      "    indented code",
      "[d]: https://example.com/docs",
    ].join("\n\n");
    const blocks = saidBlocks(md);
    expect(blocks.join("")).toBe(renderSaid(md));
    expect(blocks.join("")).toContain('<a href="https://example.com/docs"');
  });

  it("puts every code block in a box of its own, at the top, in a list and in a quote", () => {
    const box = document.createElement("div");
    box.innerHTML = renderSaid("```sh\nnpm test\n```\n\n1. Run this:\n\n   ```sh\n   npm run check\n   ```\n\n> ```\n> quoted\n> ```\n\n    indented");
    const codes = [...box.querySelectorAll("div.code[data-copy-host='code']")];
    expect(codes.map((code) => code.querySelector("pre code")?.textContent)).toEqual([
      "npm test\n",
      "npm run check\n",
      "quoted\n",
      "indented\n",
    ]);
    expect(box.querySelectorAll("pre")).toHaveLength(4);
    expect(codes.map((code) => code.closest("li, blockquote")?.tagName ?? null)).toEqual([null, "LI", "BLOCKQUOTE", null]);
  });

  it("draws a code block whose fence is still open as far as it has come", () => {
    const box = document.createElement("div");
    box.innerHTML = saidBlocks("Run:\n\n```sh\nnpm te").join("");
    expect(box.querySelector("div.code pre code")?.textContent).toBe("npm te\n");
  });
});

describe("Markdown that is still being written", () => {
  /** Every point the text could stop at while it streams, a piece at a time. */
  const prefixes = (text: string) => Array.from({ length: text.length }, (_, at) => text.slice(0, at + 1));

  it("keeps every whole block but the last, which may yet grow", () => {
    expect(settled("A first paragraph.\n\nA second one")).toBe("A first paragraph.\n\n".length);
    expect(settled("Only one paragraph")).toBe(0);
    expect(settled("")).toBe(0);
    expect(settled("# Title\n\n- one\n- two\n\nAfter")).toBe("# Title\n\n- one\n- two\n\n".length);
  });

  it("never settles a list, a fence, a table or a quote that the next line could still continue", () => {
    expect(settled("Intro\n\n- one\n- two\n\n")).toBe("Intro\n\n".length);
    expect(settled("Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;")).toBe("Intro\n\n".length);
    expect(settled("Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |")).toBe("Intro\n\n".length);
    expect(settled("Intro\n\n> quoted\n\n")).toBe("Intro\n\n".length);
  });

  it("renders what it keeps as the head of the whole text renders, wherever the text stops", () => {
    const text = [
      "## Found",
      "",
      "The **counter** is in `src/count.ts`, see [the docs](https://example.com).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "```ts",
      "let total = 0;",
      "",
      "total += 1;",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "> a quote",
      "> on two lines",
      "",
      "Setext title",
      "===",
      "",
      "The end.",
    ].join("\n");
    for (const now of prefixes(text)) {
      const kept = settled(now);
      expect(renderSaid(now.slice(0, kept)) + renderSaid(now.slice(kept))).toBe(renderSaid(now));
      expect([...saidBlocks(now.slice(0, kept)), ...saidBlocks(now.slice(kept))]).toEqual(saidBlocks(now));
    }
  });
});

describe("code in Markdown", () => {
  it("shows a less-than sign as itself, in fenced code, in inline code and in text", () => {
    const md = "If `a < b` then:\n\n```ts\nif (a < b && c > d) { return `<b>${a}</b>`; }\n```\n\nand 1 < 2.";
    for (const html of [renderSaid(md), render(md)]) {
      expect(html).not.toContain("&amp;lt;");
      expect(html).toContain("<code>a &lt; b</code>");
      expect(html).toContain("if (a &lt; b &amp;&amp; c &gt; d) { return `&lt;b&gt;${a}&lt;/b&gt;`; }");
      expect(html).toContain("1 &lt; 2");
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.querySelector("pre code")?.textContent).toBe("if (a < b && c > d) { return `<b>${a}</b>`; }\n");
      expect(box.querySelector("p code")?.textContent).toBe("a < b");
    }
  });

  it("draws allowed HTML in a conversation, and a tag with a handler as its text", () => {
    const box = document.createElement("div");
    box.innerHTML = renderSaid("Hi <b>there</b>\n\n<div onclick=x>block</div>");
    expect(box.querySelector("b")?.textContent).toBe("there");
    expect(box.querySelector("div")).toBeNull();
    expect(box.textContent).toContain("<div onclick=x>block</div>");
  });

  it("draws allowed HTML in a document, and a tag with a handler as its text", () => {
    const box = document.createElement("div");
    box.innerHTML = render("Hi <b>there</b>\n\n<div onclick=x>block</div>");
    expect(box.querySelector("b")?.textContent).toBe("there");
    expect(box.querySelector("div")).toBeNull();
    expect(box.textContent).toContain("<div onclick=x>block</div>");
  });
});

describe("a command the agent writes for the user to run", () => {
  const drawn = (html: string) => {
    const box = document.createElement("div");
    box.innerHTML = html;
    return box;
  };

  it("marks a code span that begins with ! and a space", () => {
    const box = drawn(renderSaid("Run `! npm test` to check."));
    const code = box.querySelector("code");
    expect(code?.hasAttribute("data-run")).toBe(true);
    expect(code?.textContent).toBe("! npm test");
  });

  it("leaves other code and prose unmarked", () => {
    for (const md of ["Use `!important` sparingly.", "Then `npm test`.", "Say ! npm test out loud.", "`!`"])
      expect(drawn(renderSaid(md)).querySelector("[data-run]"), md).toBeNull();
  });

  it("marks each line of a code block that is a command, as written, and no other line", () => {
    for (const fence of ["```", "```sh", "```text"]) {
      const md = `${fence}\n! npm test\nnpm run build\n# then ! npm run lint\n! git status\n\`\`\``;
      const box = drawn(renderSaid(md));
      const marked = [...box.querySelectorAll("[data-run]")];
      expect(
        marked.map((element) => element.textContent?.trim()),
        fence,
      ).toEqual(["! npm test", "! git status"]);
      expect(box.querySelector("pre code")?.textContent, fence).toBe("! npm test\nnpm run build\n# then ! npm run lint\n! git status\n");
    }
  });

  it("draws a command left to right as it runs, whatever letters it holds", () => {
    const box = drawn(renderSaid("Run `! sort א > 1`.\n\n```sh\n! sort א > 1\n```"));
    const marked = [...box.querySelectorAll<HTMLElement>("[data-run]")];
    expect(marked).toHaveLength(2);
    for (const element of marked) {
      expect(element.dir).toBe("ltr");
      expect(element.style.unicodeBidi).toBe("bidi-override");
    }
  });

  it("marks nothing in a document the viewer draws", () => {
    const box = drawn(render("Run `! npm test`.\n\n```sh\n! npm test\n```\n\n```\n! npm test\n```"));
    expect(box.querySelector("[data-run]")).toBeNull();
  });
});

describe("what Markdown may draw", () => {
  /** What Markdown draws, and the HTML written in it. */
  const DRAWN = new Set(
    (
      "P,BR,EM,STRONG,DEL,CODE,PRE,A,IMG,UL,OL,LI,BLOCKQUOTE,H1,H2,H3,H4,H5,H6,HR,TABLE,THEAD,TBODY,TR,TH,TD,INPUT," +
      "DIV,DETAILS,SUMMARY,KBD,SUB,SUP,B,I,PICTURE,SOURCE"
    ).split(","),
  );
  const PAYLOADS = [
    "x <code> <img/src=x onerror=alert(1)>",
    "<pre> <svg/onload=alert(1)>",
    "<kbd> <img/src=x onerror=1> </kbd>",
    "<script> <iframe/src=javascript:1>",
    "a <!-- x --> <img src=x onerror=1>",
    "`x` <b onmouseover=1>y</b>",
    "<details><summary>a</summary><img src=x onerror=1></details>",
    "[a](javascript:alert(1)) ![b](javascript:alert(1))",
    "* <code>\n* <img/src=x onerror=1>",
    "> <pre>\n> <img/src=x onerror=1>",
    "| <code> | <img/src=x onerror=1> |\n| --- | --- |\n| a | b |",
    // Entities that spell markup, before a raw tag and anywhere else.
    "&lt;img src=x onerror=alert(1)&gt;",
    "&#60;script&#62;alert(1)&#60;/script&#62;",
    "&#x3C;svg/onload=1&#x3E; <code> &lt;b onmouseover=1&gt;",
    "[a](&#106;avascript:alert(1)) [b](java&#115;cript:1)",
    "&amp;lt;img src=x onerror=1&amp;gt;",
    // Raw HTML a document draws in part.
    "<script>alert(1)</script>",
    "<img src=https://example.com/a.png onerror=alert(1)>",
    '<a href="javascript:alert(1)">a</a> <a href="java&#115;cript:alert(1)">b</a> <a href="javascript&colon;alert(1)">c</a>',
    '<a href=" &#x09;javascript:alert(1)">a</a> <a href="vbscript:msgbox(1)">b</a> <a href="data:text/html,<script>alert(1)</script>">c</a>',
    '<img src="https://example.com/a.png" srcset="javascript:alert(1) 1x, https://evil.example/b.png 2x">',
    '<picture><source srcset="https://example.com/a.png 1x, javascript:alert(1) 2x"><img src="https://example.com/a.png"></picture>',
    "<svg><script>alert(1)</script></svg> <svg/onload=alert(1)> <svg><a xlink:href=javascript:alert(1)>x</a></svg>",
    "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
    "<div>a</div></div></div><img src=x onerror=1>",
    "<p align=center>a</p></p></body></html><script>alert(1)</script>",
    '<b><i>x</b></i> <img alt="</p><script>alert(1)</script>" src=https://example.com/a.png>',
    "<style>*{display:none}</style><iframe src=https://example.com></iframe><object data=x></object><embed src=x>",
    "<form action=https://example.com><input name=a><button>go</button></form>",
    '<p style="background:url(javascript:alert(1))">a</p> <div class=x id=y name=z>b</div>',
    "<img src=https://example.com/a.png <script>alert(1)</script> <a href=https://example.com",
    "<details open ontoggle=alert(1)><summary>a</summary></details>",
    "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
    "<textarea><img src=x onerror=1></textarea> <title><b>x</b></title> <xmp><img src=x onerror=1></xmp>",
    '<picture><source media="(min-width: 1200px) and (prefers-color-scheme: dark)" srcset="https://track.example/wide-dark.png"><img src="https://track.example/else.png"></picture>',
    '<div align="javascript:alert(1)">x</div> <img src="https://example.com/a.png" height="expression(alert(1))">',
    '<img src="/etc/hosts.png"> <img src="file:///etc/a.png"> <img src="//evil.example/a.png"> ![a](../../.ssh/id.png)',
  ];

  it("draws only the elements it allows, with no handlers and no scripted links", () => {
    for (const markdown of PAYLOADS)
      for (const [html, sourced, linked] of [
        [render(markdown), /^(?:https?:|data:image\/)/, /^(?:https?:|mailto:|#)/],
        [renderSaid(markdown), /^data:image\//, /^https?:\/\//],
      ] as const) {
        const box = document.createElement("div");
        box.innerHTML = html;
        for (const element of box.querySelectorAll("*")) {
          expect(DRAWN.has(element.tagName) || element.matches("span.goes, span.line, div.code"), `${element.tagName} from ${markdown}`).toBe(true);
          expect(element.hasAttribute("style"), `style from ${markdown}`).toBe(false);
          const sources = [
            element.getAttribute("src"),
            ...(element.getAttribute("srcset")?.split(/,\s+/).map((candidate) => candidate.split(" ")[0]) ?? []),
          ];
          for (const src of sources)
            if (src !== null) expect(src, markdown).toMatch(sourced);
          const href = element.getAttribute("href");
          if (href !== null) expect(href, markdown).toMatch(linked);
          for (const attribute of element.attributes) {
            expect(attribute.name.startsWith("on"), `${attribute.name} from ${markdown}`).toBe(false);
            expect(/javascript:/i.test(attribute.value), `${attribute.value} from ${markdown}`).toBe(false);
          }
        }
      }
  });

  it("draws an entity as its character, and markup an entity spells as its letters", () => {
    for (const html of [render("AT&T &copy; &mdash; a&nbsp;b &amp;"), renderSaid("AT&T &copy; &mdash; a&nbsp;b &amp;")]) {
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.textContent?.trim()).toBe("AT&T © — a\u00a0b &");
    }
    for (const html of [render("&lt;b&gt;x&lt;/b&gt; &#60;i&#62;"), renderSaid("&lt;b&gt;x&lt;/b&gt; &#60;i&#62;")]) {
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.querySelector("b, i")).toBeNull();
      expect(box.textContent?.trim()).toBe("<b>x</b> <i>");
    }
    // In code an entity is the letters it is.
    const box = document.createElement("div");
    box.innerHTML = renderSaid("`&copy;`");
    expect(box.querySelector("code")?.textContent).toBe("&copy;");
  });

  it("escapes text once, after a raw tag as anywhere else", () => {
    const box = document.createElement("div");
    box.innerHTML = renderSaid("x <code> a & b < c <i");
    expect(box.querySelector("code")?.textContent).toBe(" a & b < c <i");
    box.innerHTML = render("x <code> a & b < c <i");
    expect(box.querySelector("code")?.textContent).toBe(" a & b < c <i");
  });
});

describe("the HTML a document may draw", () => {
  const drawn = (markdown: string) => {
    const box = document.createElement("div");
    box.innerHTML = render(markdown);
    return box;
  };
  /** A document of the project at /one loaded as the viewer loads it,
      its images read from the project. */
  const loaded = async (path: string) => {
    const read = await load(path, "/one");
    const box = document.createElement("div");
    box.innerHTML = "html" in read ? read.html : "";
    return box;
  };
  const HERO = '<p align="center">\n  <img src="https://example.com/icon.png" width="128" height="128" alt="">\n</p>';

  it("draws a README's centred hero image at its width", () => {
    const box = drawn(`${HERO}\n\n# Chord`);
    const image = box.querySelector("p[align='center'] > img");
    expect(image?.getAttribute("src")).toBe("https://example.com/icon.png");
    expect(image?.getAttribute("width")).toBe("128");
    expect(image?.getAttribute("height")).toBe("128");
    expect(box.querySelector("h1")?.textContent).toBe("Chord");
  });

  it("draws each element it allows, with the attributes it allows", () => {
    const box = drawn(
      [
        '<div align="right"><h2 align="center">Title</h2></div>',
        "",
        'Press <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <b>b</b> <i>i</i> <strong>s</strong> <em>e</em> <code>c</code>,<br>next<br/>line',
        "",
        '<a href="https://example.com" title="Site">site</a> <a href="#usage">usage</a> <a href="mailto:a@b.c">mail</a>',
        "",
        "<hr>",
        "",
        "<details open>\n<summary>More</summary>\n\nSome **bold** words.\n\n</details>",
        "",
        "<pre>x < y</pre>",
        "",
        '<picture>\n<source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png 1x,https://example.com/dark@2x.png 2x">\n<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo" align="left">\n</picture>',
      ].join("\n"),
    );
    expect(box.querySelector("div[align='right'] > h2[align='center']")?.textContent).toBe("Title");
    for (const [selector, text] of [
      ["kbd", "Ctrl"],
      ["sub", "2"],
      ["sup", "2"],
      ["b", "b"],
      ["i", "i"],
      ["strong", "s"],
      ["em", "e"],
      ["p > code", "c"],
      ["pre", "x < y"],
    ])
      expect(box.querySelector(selector)?.textContent, selector).toBe(text);
    expect(box.querySelectorAll("br")).toHaveLength(2);
    expect(box.querySelector("hr")).not.toBeNull();
    const links = [...box.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "#usage", "mailto:a@b.c"]);
    expect(links[0].title).toBe("Site");
    for (const link of links) expect(link.rel).toBe("noopener noreferrer");
    const details = box.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.querySelector("p > strong")?.textContent).toBe("bold");
    const source = box.querySelector("picture > source");
    expect(source?.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    expect(source?.getAttribute("srcset")).toBe("https://example.com/dark.png 1x, https://example.com/dark@2x.png 2x");
    expect(box.querySelector("picture > img")?.getAttribute("align")).toBe("left");
  });

  it("shows a refused tag whole as its text, never in part and never dropped", () => {
    for (const tag of [
      "<script>alert(1)</script>",
      '<img src="https://example.com/a.png" onerror="alert(1)">',
      '<img src="https://example.com/a.png" srcset="https://evil.example/b.png 2x">',
      '<img src="docs/icon.png" width="128">',
      '<img src="https://example.com/a.png" src="javascript:alert(1)">',
      '<a href="java&#115;cript:alert(1)">x</a>',
      '<a href="data:text/html,x">x</a>',
      '<p style="color: red">x</p>',
      '<div class="x">x</div>',
      '<a name="top">x</a>',
      "<svg onload=alert(1)>",
      "<input type=checkbox checked>",
      "<span>x</span>",
      "<!-- a note -->",
      '<source srcset="https://example.com/a.png">',
    ]) {
      const box = drawn(`a ${tag} b`);
      expect(box.querySelectorAll("p *"), tag).toHaveLength(0);
      expect(box.textContent?.trim(), tag).toBe(`a ${tag.replace(/&#115;/g, "s")} b`);
    }
  });

  it("shows a closing tag with nothing of its name open as its text, so it cannot break out", () => {
    const box = drawn("<div>a</div></div></details><script>alert(1)</script>\n\nafter");
    expect(box.querySelectorAll("div")).toHaveLength(1);
    expect(box.querySelector("script")).toBeNull();
    expect(box.textContent).toContain("</div></details><script>alert(1)</script>");
    expect(box.lastElementChild?.textContent).toBe("after");
  });

  it("closes what is open when its tag closes, and what is left open at the end", () => {
    const box = drawn("<b><i>x</b></i> y\n\n<details>\n<summary>s</summary>\n\nleft open");
    expect(box.querySelector("b > i")?.textContent).toBe("x");
    expect(box.textContent).toContain("</i> y");
    expect(box.querySelector("details")?.textContent).toContain("left open");
    expect(render("<details>\n<summary>s</summary>\n\nleft open")).toMatch(/<\/details>$/);
  });

  it("takes a size only in whole pixels or as a percentage, and an alignment only from its list", () => {
    const box = drawn(
      '<p align="CENTER"><img src="https://example.com/a.png" width="50%" height=" 64 " align="Middle"></p>',
    );
    const image = box.querySelector("p[align='center'] > img");
    expect(image?.getAttribute("width")).toBe("50%");
    expect(image?.getAttribute("height")).toBe("64");
    expect(image?.getAttribute("align")).toBe("middle");
    for (const tag of [
      '<img src="https://example.com/a.png" width="-5">',
      '<img src="https://example.com/a.png" width="12.5">',
      '<img src="https://example.com/a.png" width="128px">',
      '<img src="https://example.com/a.png" width="101%">',
      '<img src="https://example.com/a.png" height="99999999">',
      '<img src="https://example.com/a.png" height="expression(alert(1))">',
      '<img src="https://example.com/a.png" align="center">',
      "<p align>x</p>",
      '<div align="javascript:alert(1)">x</div>',
      '<h1 align="middle">x</h1>',
    ]) {
      const refused = drawn(`a ${tag} b`);
      expect(refused.querySelectorAll("p *"), tag).toHaveLength(0);
      expect(refused.textContent?.trim(), tag).toBe(`a ${tag} b`);
    }
  });

  it("draws a source only for a light or a dark colour scheme", () => {
    const box = drawn(
      [
        "<picture>",
        '<source media="( PREFERS-COLOR-SCHEME : Dark )" srcset="https://example.com/dark.png">',
        '<source media="(prefers-color-scheme: light)" srcset="https://example.com/light.png">',
        '<img src="https://example.com/light.png" alt="logo">',
        "</picture>",
      ].join("\n"),
    );
    expect([...box.querySelectorAll("picture > source")].map((source) => source.getAttribute("media"))).toEqual([
      "(prefers-color-scheme: dark)",
      "(prefers-color-scheme: light)",
    ]);
    for (const media of [
      "(min-width: 1200px) and (prefers-color-scheme: dark)",
      "(prefers-color-scheme: dark), (min-width: 1px)",
      "(prefers-color-scheme: no-preference)",
      "(min-resolution: 2dppx)",
      "screen",
    ]) {
      const refused = drawn(`<picture><source media="${media}" srcset="https://example.com/a.png"><img src="https://example.com/b.png"></picture>`);
      expect(refused.querySelector("source"), media).toBeNull();
      expect(refused.textContent, media).toContain(`<source media="${media}"`);
    }
  });

  it("closes a link or other inline element left open at the end of its block", () => {
    const box = drawn(
      '<a href="https://evil.example">\n\n# Heading\n\nSome paragraph.\n\n- item\n\n[real link](https://ok.example)',
    );
    for (const selector of ["h1", "p", "li"])
      expect(box.querySelector(selector)?.closest("a"), selector).toBeNull();
    expect([...box.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://evil.example",
      "https://ok.example",
    ]);
    expect(box.querySelector("a[href='https://ok.example']")?.textContent).toBe("real link");
    const inline = drawn('one <b>two <a href="https://evil.example">three\n\n# four\n\nx <i>y</i foo="a>b"> z\n\nfive');
    expect(inline.querySelector("p > b > a")?.textContent).toBe("three");
    for (const element of inline.querySelectorAll("h1, p"))
      expect(element.closest("b, a, i"), element.textContent ?? "").toBeNull();
    expect(inline.lastElementChild?.textContent).toBe("five");
  });

  it("draws at most a hundred elements open at once, and an opening tag past them as its text", () => {
    const box = drawn(`${"<div>".repeat(101)}deep`);
    expect(box.querySelectorAll("div")).toHaveLength(100);
    expect(box.textContent).toBe("<div>deep");
    expect(drawn(`${"<b>".repeat(100)}<br><img src="https://example.com/a.png"><i/>x`).querySelector("i")).not.toBeNull();
  });

  it("refuses a closing tag with nothing of its name open at once, however many there are", () => {
    const markdown = `x ${"<b>".repeat(100_000)}${"</i>".repeat(100_000)}`;
    const started = performance.now();
    const html = render(markdown);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(html.match(/<b>/g)).toHaveLength(100);
  });

  it("draws an image of the project once it is read, every one of a source's too, and as its text before", async () => {
    const DATA = "data:image/png;base64,AAAA";
    const markdown = [
      '<img src="docs/icon.png" width="128" height="128" alt="">',
      "",
      "![logo](docs/icon.png)",
      "",
      '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/dark.png 1x, docs/dark2.png 2x, docs/icon.png 3x"><img src="docs/icon.png"></picture>',
      "",
      "![other](docs/other.png)",
    ].join("\n");
    expect(drawn(markdown).querySelector("img, source")).toBeNull();
    project.documents.set("/one/docs.md", markdown);
    project.files.set("docs/dark.png", { size: 3, wait: 0 });
    project.files.set("docs/dark2.png", { size: 3, wait: 0 });
    const box = await loaded("/one/docs.md");
    expect(project.reads.map((read) => read.file).sort()).toEqual(
      ["docs/dark.png", "docs/dark2.png", "docs/icon.png", "docs/other.png"],
    );
    expect([...box.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([DATA, DATA, DATA]);
    expect(box.querySelector("source")?.getAttribute("srcset")).toBe(`${DATA} 1x, ${DATA} 2x, ${DATA} 3x`);
    expect(box.textContent).toContain("other");
  });

  // A picture's fallback from the web would otherwise load only when the
  // project's file was not there, and so tell the web whether it is.
  it("draws a picture's images from the web or from the project, never both", async () => {
    project.documents.set(
      "/one/docs.md",
      [
        '<picture><source srcset="docs/icon.png"><img src="https://evil.example/miss.png" alt="here"></picture>',
        '<picture><source srcset="docs/gone.png"><img src="https://evil.example/miss.png" alt="gone"></picture>',
        '<picture><source srcset="https://evil.example/a.png"><img src="docs/icon.png" alt="web"></picture>',
        '<picture><source srcset="docs/icon.png 1x, https://evil.example/b.png 2x"><img src="data:image/gif;base64,R0lGOD" alt="mixed"></picture>',
        '<picture><source srcset="https://evil.example/c.png"> ![markdown](docs/shot.png)</picture>',
      ].join("\n\n"),
    );
    const box = await loaded("/one/docs.md");
    const drawn = [...box.querySelectorAll("picture")].map((picture) =>
      [...picture.querySelectorAll("source, img")].flatMap((element) =>
        (element.getAttribute("srcset") ?? element.getAttribute("src") ?? "")
          .split(/,\s+/)
          .map((candidate) => candidate.split(" ")[0]),
      ),
    );
    expect(drawn).toEqual([
      ["data:image/png;base64,AAAA"],
      [],
      ["https://evil.example/a.png"],
      ["data:image/gif;base64,R0lGOD"],
      ["https://evil.example/c.png"],
    ]);
    expect(box.textContent).toContain('<img src="https://evil.example/miss.png" alt="here">');
    expect(box.textContent).toContain("markdown");
    // An image of the project in a picture from the web is not even read.
    expect(project.reads.map((read) => read.file).sort()).toEqual(["docs/gone.png", "docs/icon.png"]);
  });

  it("draws an image named thousands of times only while the 64 MB hold it, and reads it once", async () => {
    project.documents.set("/one/docs.md", "![big](docs/big.png) ".repeat(5000));
    project.files.set("docs/big.png", { size: 1024 * 1024, wait: 0 });
    const box = await loaded("/one/docs.md");
    expect(project.reads.map((read) => read.file)).toEqual(["docs/big.png"]);
    expect(box.querySelectorAll("img")).toHaveLength(64);
    expect(box.textContent).toContain("big");
  });

  it("draws the same images of a document whatever order their reads land in", async () => {
    const megabytes: Record<string, number> = { a: 40, b: 30 };
    project.documents.set("/one/docs.md", [..."abcdef"].map((name) => `![${name}](docs/${name}.png)`).join(" "));
    const drawnWith = async (waits: Record<string, number>) => {
      project.reads.length = 0;
      for (const name of "abcdef") {
        const size = (megabytes[name] ?? 1) * 1024 * 1024;
        project.files.set(`docs/${name}.png`, { size, wait: waits[name] ?? 0 });
      }
      return (await loaded("/one/docs.md")).innerHTML;
    };
    const early = await drawnWith({ c: 10, d: 10 });
    const late = await drawnWith({ a: 20, b: 20 });
    expect(late).toBe(early);
    const box = document.createElement("div");
    box.innerHTML = early;
    expect([...box.querySelectorAll("img")].map((image) => image.getAttribute("alt"))).toEqual(["a"]);
  });

  it("reads no more of a document's images once it is no longer wanted", async () => {
    project.documents.set("/one/docs.md", "![a](docs/icon.png) ![b](docs/shot.png)");
    const read = await load("/one/docs.md", "/one", () => true);
    expect(project.reads).toEqual([]);
    expect("html" in read && read.html).not.toContain("<img");
  });

  it("reads a tag as a browser does, its case, its entities and a quote in it", () => {
    const box = drawn('<IMG SRC="https://example.com/a.png?x=1&amp;y=2" ALT=\'say "hi" &lt;b&gt;\'> <A HREF=https://example.com>u</A>');
    const image = box.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.com/a.png?x=1&y=2");
    expect(image?.getAttribute("alt")).toBe('say "hi" <b>');
    expect(box.querySelector("a")?.textContent).toBe("u");
    expect(box.querySelector("b")).toBeNull();
  });
});

describe("the HTML a reply may draw", () => {
  const drawn = (markdown: string) => {
    const box = document.createElement("div");
    box.innerHTML = renderSaid(markdown);
    return box;
  };

  it("draws a key, and the rest of the subset a document draws", () => {
    const box = drawn(
      'Press <kbd>Cmd</kbd>+<kbd>K</kbd>, H<sub>2</sub>O, x<sup>2</sup>,<br><b>b</b> <i>i</i>\n\n<p align="center">middle</p>\n\n<details><summary>More</summary>\n\nSome **bold** words.\n\n</details>',
    );
    expect([...box.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["Cmd", "K"]);
    expect(box.querySelector("sub")?.textContent).toBe("2");
    expect(box.querySelector("sup")?.textContent).toBe("2");
    expect(box.querySelector("br + b + i")).not.toBeNull();
    expect(box.querySelector("p[align='center']")?.textContent).toBe("middle");
    expect(box.querySelector("details > summary")?.textContent).toBe("More");
    expect(box.querySelector("details strong")?.textContent).toBe("bold");
    expect(box.textContent).not.toContain("<");
  });

  it("shows a tag in code as its letters", () => {
    const box = drawn("`<kbd>` and\n\n```html\n<kbd>x</kbd>\n```");
    expect(box.querySelector("kbd")).toBeNull();
    expect(box.textContent).toContain("<kbd>x</kbd>");
  });

  it("shows what is outside the subset as its text", () => {
    for (const tag of [
      "<script>alert(1)</script>",
      "<style>*{display:none}</style>",
      '<iframe src="https://example.com"></iframe>',
      '<form action="https://example.com"><input name="a"><button>go</button></form>',
      '<link rel="stylesheet" href="https://example.com/a.css">',
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
      '<video src="https://example.com/a.mp4" autoplay></video>',
      '<object data="https://example.com"></object>',
      "<svg onload=alert(1)></svg>",
      '<kbd onclick="alert(1)">k',
      '<b style="background:url(https://example.com)">b',
      '<a href="javascript:alert(1)">a',
      '<div class="code" data-copy-host="code">',
      '<div id="x">',
      '<span data-run="">! rm -rf ~',
      '<kbd data-thread-item="">',
      '<code data-run="">! rm -rf ~',
      '<p data-find="">',
    ]) {
      const box = drawn(`${tag}\n\nafter ${tag}`);
      expect(box.querySelector("script, style, iframe, form, input, button, link, meta, video, object, svg, span, [data-run], [data-thread-item], [data-find], [data-copy-host], [id], [class], [onclick], [style], a"), tag).toBeNull();
      expect(box.textContent, tag).toContain(tag.slice(0, tag.indexOf(">") + 1));
    }
  });

  it("marks no command that HTML writes", () => {
    const box = drawn("<code>! rm -rf ~</code>\n\n<pre>! rm -rf ~</pre>");
    expect(box.querySelector("code")?.textContent).toBe("! rm -rf ~");
    expect(box.querySelector("[data-run], [data-copy-host]")).toBeNull();
  });

  it("draws no image that would be fetched, and one held in the text", () => {
    for (const html of [
      '<img src="https://example.com/a.png">',
      '<img src="//example.com/a.png">',
      '<img src="docs/a.png">',
      '<img src="/etc/a.png">',
      '<picture><source srcset="https://example.com/a.png"></picture>',
      '<picture><source media="(prefers-color-scheme: dark)" srcset="data:image/png;base64,AA== 1x, https://example.com/a.png 2x"></picture>',
      '<img src="data:image/png;base64,AA==" srcset="https://example.com/a.png">',
    ]) {
      const box = drawn(html);
      expect(box.querySelector("img[src^='http'], img[src^='/'], img[src^='docs'], img[srcset], source[srcset]"), html).toBeNull();
      expect(box.textContent, html).toContain(html.includes("<source") ? "<source" : "<img");
    }
    const held = drawn('<img src="data:image/png;base64,AA==" alt="held">');
    expect(held.querySelector("img")?.getAttribute("alt")).toBe("held");
  });

  it("says where a link goes, whether HTML or Markdown wrote it", () => {
    const box = drawn('<a href="https://example.com/x" title="Site">here</a>');
    expect(box.querySelector("a")?.getAttribute("title")).toBe("Site (https://example.com/x)");
    expect(box.querySelector(".goes")).toBeNull();
  });

  it("shows the address after a link whose words name another, however they are written", () => {
    for (const markdown of [
      '<a href="https://evil.example">google.com</a>',
      '<a href="https://evil.example"><b>google</b>.com</a>',
      '<a href="https://evil.example" title="https://google.com">https://google.com</a>',
      "[<b>google.com</b>](https://evil.example)",
      "[<kbd></kbd>google.com](https://evil.example)",
      '<a href="https://evil.example"><img src="data:image/png;base64,AA==" alt="google.com"></a>',
      '<a href="https://evil.example"><details><summary>google.com</summary>other words</details></a>',
      '<div><a href="https://evil.example"><details><summary>click</summary>google.com</details></a></div>',
      '<div><a href="https://evil.example"><details><summary>click</summary><b>google</b>.com</details></a></div>',
      '<div><a href="https://evil.example"><details><summary>click</summary>go here<b>google.com</b></details></a></div>',
      '<a href="https://example.com"><a href="https://evil.example">google.com</a></a>',
      "[![google.com](data:image/png;base64,AA==)](https://evil.example)",
    ]) {
      // A browser may split a link around a block inside it, so the address
      // follows whichever of its parts holds the words.
      const box = drawn(markdown);
      const said = box.querySelector("a[href='https://evil.example'] + .goes");
      expect(said?.textContent, markdown).toBe(" (https://evil.example)");
      for (const link of box.querySelectorAll("a[href='https://evil.example']"))
        expect(link.getAttribute("title"), markdown).toContain("https://evil.example");
    }
  });

  it("reads a link that holds folds nested deep without stalling", () => {
    const deep = 90;
    const box = drawn(`<div><a href="https://evil.example">${"<details>".repeat(deep)}google.com${"</details>".repeat(deep)}</a></div>`);
    expect(box.querySelectorAll("details")).toHaveLength(deep);
    expect(box.querySelector("a[href] + .goes")?.textContent).toBe(" (https://evil.example)");
  });

  it("holds a fold's blocks inside it, and closes one left open at the end", () => {
    for (const markdown of ["<details>\n\none\n\ntwo\n\n</details>\n\nafter", "<details>\n\none\n\ntwo"]) {
      const box = drawn(markdown);
      expect([...box.querySelectorAll("details > p")].map((p) => p.textContent)).toEqual(["one", "two"]);
    }
    expect(drawn("<details>\n\none\n\n</details>\n\nafter").querySelector("details + p")?.textContent).toBe("after");
    expect(saidBlocks("<details>\n\none\n\n</details>\n\nafter")).toHaveLength(2);
  });

  it("lets no tag in a list or a quote close an element opened outside it", () => {
    for (const inner of ["- </div>", "> </div>", "- a\n\n  </div>"]) {
      const box = drawn(`<div>\n\n${inner}\n\nstill inside\n\n</div>`);
      expect(box.querySelector("div > p:last-child")?.textContent, inner).toBe("still inside");
    }
  });

  it("closes a paragraph, a heading and a summary at the end of their block", () => {
    for (const name of ["p", "h1", "h2", "h3", "h4", "h5", "h6"]) {
      const box = drawn(`<${name} align="center">\n\nlater\n\n</${name}>`);
      expect(box.querySelector(`${name}[align]`)?.textContent?.trim(), name).toBe("");
      expect(box.querySelector(`p:not([align])`)?.textContent, name).toBe("later");
      expect(box.textContent, name).toContain(`</${name}>`);
    }
    const open = drawn("<details>\n<summary>s\n\nheld");
    expect(open.querySelector("summary")?.textContent?.trim()).toBe("s");
    expect(open.querySelector("details > p")?.textContent).toBe("held");
    for (const name of ["div", "pre"])
      expect(drawn(`<${name}></${name}>\n\n<div>\n\nheld`).querySelector("div > p")?.textContent).toBe("held");
    // A document keeps a paragraph open to the tag that closes it.
    const document = window.document.createElement("div");
    document.innerHTML = render("<h2>\n\nlater\n\n</h2>");
    expect(document.textContent).not.toContain("</h2>");
  });

  it("draws a link only to the web, since a click opens nothing else", () => {
    for (const markdown of [
      "[words](#usage)",
      "[words](mailto:a@b.c)",
      "[words](https:alert(1))",
      '<a href="#usage">words</a>',
      '<a href="mailto:a@b.c">words</a>',
      '<a href="https:alert(1)">words</a>',
      "write to a@b.com, words",
      "![words](https:a.png)",
    ]) {
      const box = drawn(markdown);
      expect(box.querySelector("a, img"), markdown).toBeNull();
      expect(box.textContent, markdown).toContain("words");
    }
    expect(drawn("[a](HTTPS://example.com) <a href='http://example.com'>b</a>").querySelectorAll("a")).toHaveLength(2);
  });

  it("draws every fold of a flat reply as a plain block that shows what it holds", () => {
    for (const markdown of [
      "<details>\n<summary>s</summary>\n\nstep\n\n</details>\n\nafter",
      "<details><summary>s</summary>step</details>\n\nafter",
      "<details open>\n<summary>s\n\nstep",
      "- <details><summary>s</summary>step</details>\n\n> <details/>after",
    ]) {
      const box = window.document.createElement("div");
      box.innerHTML = renderSaid(markdown, true);
      expect(box.querySelector("details, summary, [open]"), markdown).toBeNull();
      expect(box.textContent, markdown).toContain("step");
      expect(box.textContent, markdown).not.toContain("<");
    }
    expect(renderSaid("<details>x</details>")).toContain("<details>");
    expect(render("<details>x</details>")).toContain("<details>");
  });

  it("renders a reply with HTML in whole blocks as it renders it at once", () => {
    const text = "Press <kbd>K</kbd>.\n\n<details>\n<summary>s</summary>\n\none\n\n</details>\n\n<div>\n\ntwo\n\n</div>\n\nend";
    for (let length = 0; length <= text.length; length++) {
      const now = arrived(text.slice(0, length));
      const kept = settled(now);
      expect([...saidBlocks(now.slice(0, kept)), ...saidBlocks(now.slice(kept))], now).toEqual(saidBlocks(now));
    }
  });
});

describe("a tag half arrived", () => {
  it("is held back until it is whole", () => {
    for (const half of ["<", "</", "<k", "<kbd", "</kb", "<details open", '<a href="https://exa', "<br /", "<IMG src="])
      expect(arrived(`Press ${half}`), half).toBe("Press ");
  });

  it("is left when it can draw nothing, or is no tag", () => {
    for (const text of [
      "Press <kbd>",
      "a < b",
      "Vec<String",
      "<script",
      '<iframe src="x',
      "<kbdx y",
      "in `<kbd",
      "```\n<kbd",
      "    <kbd",
    ])
      expect(arrived(text), text).toBe(text);
  });

  it("is waited for no further than its attributes reach", () => {
    for (const text of [
      "if a <b then it stops\n\nmore",
      "if a <b then\nmore words",
      "<b\n\nmore",
      "<a href=x\n\n",
      "<a\nhref is a word\nand more",
      "<details\nopening",
    ])
      expect(arrived(text), JSON.stringify(text)).toBe(text);
    for (const half of ["<a\n", "<a\nhr", '<a\n  href="https://exa', '<img\n src="a"\n alt', "<details\nopen\n", "<br\n/"])
      expect(arrived(`Press ${half}`), JSON.stringify(half)).toBe("Press ");
  });

  it("never shows its letters as an allowed tag streams in", () => {
    const text = 'Press <kbd>Cmd</kbd> or <a href="https://example.com">go</a>.';
    for (let length = 0; length <= text.length; length++) {
      const box = document.createElement("div");
      box.innerHTML = renderSaid(arrived(text.slice(0, length)));
      expect(box.textContent, text.slice(0, length)).not.toContain("<");
    }
  });
});
