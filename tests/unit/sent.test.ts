import { describe, expect, it } from "vitest";
import { sentHtml, type SentPart } from "$lib/media.svelte";
import { sentText } from "$lib/find.svelte";
import { wire } from "$lib/mention";

/** A message of words alone as the bubble draws it. */
const drawn = (text: string) => sentHtml([{ text }]);

/** The drawing read as text, as a person sees it. */
function seen(html: string | null): string {
  const made = document.createElement("template");
  made.innerHTML = html ?? "";
  return made.content.textContent ?? "";
}

/** The elements of a drawing that match `selector`. */
function found(html: string | null, selector: string): Element[] {
  const made = document.createElement("template");
  made.innerHTML = html ?? "";
  return [...made.content.querySelectorAll(selector)];
}

describe("a message the user typed", () => {
  it("is drawn as typed when it holds no Markdown", () => {
    expect(drawn("Hello there.\nA second line.\n\n\nAfter a gap.")).toBeNull();
    expect(drawn("2 * 3 * 4 is 24, snake_case_name stays, and a < b > c.")).toBeNull();
    expect(drawn("Keep the \\* and <b>tags</b> as typed.")).toBeNull();
    expect(drawn("# Not a heading\n---\n| a | b |\n|---|---|\n~gone~")).toBeNull();
  });

  it("draws a quote as only its own lines, and the line typed after it as its own", () => {
    const html = drawn("> Quoted line one\n> and two\nMy answer to it.");
    const [quote] = found(html, "blockquote");
    expect(quote.textContent?.trim()).toBe("Quoted line oneand two");
    expect(quote.querySelectorAll("br")).toHaveLength(1);
    expect(found(html, "blockquote ~ p").map((p) => p.textContent)).toEqual(["My answer to it."]);
  });

  it("draws lists, and ends one at a line that is not an item", () => {
    const html = drawn("Things:\n* one\n* two\nAfter.");
    expect(found(html, "ul > li").map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(found(html, "ul ~ p").map((p) => p.textContent)).toEqual(["After."]);
    expect(found(drawn("- a\n- b"), "ul > li")).toHaveLength(2);
    expect(found(drawn("1. a\n2. b"), "ol > li")).toHaveLength(2);
  });

  it("keeps a line break the user typed", () => {
    const html = drawn("**Two** lines\nkept apart");
    expect(found(html, "p br")).toHaveLength(1);
  });

  it("draws code, bold, italic and links", () => {
    const html = drawn("Run `npm test`, **now**, _please_, see https://example.com\n```\nlet a = 1;\n```");
    expect(found(html, "p code")[0].textContent).toBe("npm test");
    expect(found(html, "strong")[0].textContent).toBe("now");
    expect(found(html, "em")[0].textContent).toBe("please");
    const [link] = found(html, "a");
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("tabindex")).toBe("-1");
    expect(found(html, "pre code")[0].textContent).toBe("let a = 1;");
  });

  it("shows headings, rules, tables and strikes as typed when it holds Markdown too", () => {
    const html = drawn("**Note**\n# Title\n---\n~~gone~~");
    expect(found(html, "h1, hr, del, table")).toHaveLength(0);
    expect(seen(html).trim()).toBe("Note# Title---~~gone~~");
    expect(found(html, "p")).toHaveLength(1);
    expect(found(html, "p br")).toHaveLength(3);
  });

  it("loads no image and draws no HTML", () => {
    const html = drawn("**Look** ![a cat](https://example.com/cat.png) ![x](/etc/x.png) <img src=x onerror=alert(1)> <b>no</b>");
    expect(found(html, "img, b, script")).toHaveLength(0);
    expect(found(html, "a").map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["https://example.com/cat.png", "a cat"],
    ]);
    expect(seen(html)).toContain("<img src=x onerror=alert(1)> <b>no</b>");
  });

  it("draws a link only where a link may point", () => {
    const html = drawn("**Go** [here](javascript:alert(1)) or [there](mailto:a@b.c)");
    expect(found(html, "a").map((a) => a.getAttribute("href"))).toEqual(["mailto:a@b.c"]);
    expect(seen(html)).toContain("here");
  });

  it("shows an unseen character as its marker, in code too, isolated left to right", () => {
    const html = drawn("`echo ‮fr- mr‬` and **safe​**\n```\nrm‮ -rf\n```");
    const marks = found(html, "[data-testid='unseen-character']").map((mark) => mark.textContent);
    expect(marks).toEqual(["⟨U+202E⟩", "⟨U+202C⟩", "⟨U+200B⟩", "⟨U+202E⟩"]);
    expect(html).not.toMatch(/[‮‬​]/);
    expect(found(html, "code .plain, strong .plain")).toHaveLength(3);
  });

  it("draws a mention as its @ word, wherever it stands", () => {
    const parts: SentPart[] = [{ text: "> See " }, { text: "@src/a_b.ts", path: "src/a_b.ts" }, { text: "\nand *this*" }];
    const html = sentHtml(parts, (path) => path === "src/a_b.ts");
    const [mention] = found(html, "blockquote [data-testid='message-mention']");
    expect(mention.tagName).toBe("BUTTON");
    expect(mention.getAttribute("data-mention")).toBe("1");
    expect(mention.textContent).toBe("@src/a_b.ts");
    expect(found(sentHtml(parts), "span.mention")).toHaveLength(1);
    expect(sentHtml([{ text: "See " }, { text: "@a.ts", path: "a.ts" }])).toBeNull();
  });

  it("is found as it reads", () => {
    const text = `> quoted ${wire("a.ts")}\n* **one**\n* two`;
    expect(sentText(text, [{ start: 9, end: 9 + wire("a.ts").length, path: "a.ts" }])).toBe("quoted @a.ts\none\ntwo");
    expect(sentText("plain 2 * 3", [])).toBe("plain 2 * 3");
  });
});
