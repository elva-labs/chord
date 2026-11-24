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
    const html = drawn("Run `npm test`, **now**, *please*, see https://example.com\n```\nlet a = 1;\n```");
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

  it("draws a link only to the web, and anything else as typed", () => {
    const typed = '**Go** [here](javascript:alert(1)) [top](#top) [there](mailto:a@b.c) foo@bar.com <a@b.c> [c](&#106;avascript:alert(1)) [d](data:text/html,x)';
    const html = drawn(typed);
    expect(found(html, "a")).toHaveLength(0);
    expect(seen(html).trim()).toBe(typed.replaceAll("**", ""));
    expect(drawn("[top](#top) and mail foo@bar.com")).toBeNull();
  });

  it("keeps a hostile title and address inside their attributes", () => {
    const html = drawn('[a](<https://x.com/"q>) [b](https://x.com "t\\" onmouseover=\\"x")');
    const [a, b] = found(html, "a");
    expect(a.getAttribute("href")).toBe('https://x.com/"q');
    expect(b.getAttribute("title")).toBe('t" onmouseover="x (https://x.com)');
    expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "tabindex", "title"]);
    expect(b.getAttributeNames().sort()).toEqual(["href", "rel", "tabindex", "title"]);
  });

  it("shows where a link goes: in its title, and after words that name another address", () => {
    const html = drawn('Click [https://github.com/acme/app](https://evil.example/login "Docs") or ![https://good.com](https://evil.com/x.png)');
    const [link, image] = found(html, "a");
    expect(link.getAttribute("title")).toBe("Docs (https://evil.example/login)");
    expect(image.getAttribute("title")).toBe("https://evil.com/x.png");
    expect(seen(html)).toBe("Click https://github.com/acme/app (https://evil.example/login) or https://good.com (https://evil.com/x.png)\n");
    const same = drawn("[example.com](https://example.com/) [docs](https://example.com) https://example.com");
    expect(seen(same).trim()).toBe("example.com docs https://example.com");
    expect(found(drawn("[a](https://a.com/\u202Ecod.exe)"), "a")[0].getAttribute("title")).toBe("https://a.com/⟨U+202E⟩cod.exe");
  });

  it("makes emphasis only of * runs that stand around words", () => {
    expect(drawn("glob src/*.ts and lib/*.js please")).toBeNull();
    expect(drawn("edit __init__.py and _this_ and ls *.ts lib/*")).toBeNull();
    const html = drawn("`x` src/*.ts and lib/*.js, __init__.py, _no_, a*b*c, (*no*) **yes** *yes*, ***both***.");
    expect(seen(html).trim()).toBe("x src/*.ts and lib/*.js, __init__.py, _no_, a*b*c, (*no*) yes yes, both.");
    expect(found(html, "strong").map((el) => el.textContent)).toEqual(["yes", "both"]);
    expect(found(html, "em").map((el) => el.textContent)).toEqual(["yes", "both"]);
  });

  it("shows backslashes and character references as typed", () => {
    const typed = "Path C:\\Users\\me\\*.txt and C:\\tmp\\_cache\\\n&#106; &copy; &lt; https://a.com";
    const html = drawn(typed);
    expect(found(html, "a")).toHaveLength(1);
    expect(found(html, "p")[0].innerHTML.replace(/<br>/g, "\n").replace(/<[^>]+>/g, "")).toBe(
      typed.replaceAll("&", "&amp;"),
    );
  });

  it("shows every list item's marker as typed", () => {
    const html = drawn("Things:\n* one\n- two\n1. three\n2026. was a year");
    expect(found(html, "ul, ol")).toHaveLength(1);
    expect(found(html, "li").map((li) => li.textContent)).toEqual(["one", "two", "1. three", "2026. was a year"]);
    expect(found(html, "li > .marker.bullet")).toHaveLength(2);
    expect(seen(drawn("2026. was the year")).trim()).toBe("2026. was the year");
    expect(seen(drawn("7) seven\n9) nine")).trim()).toBe("7) seven9) nine");
  });

  it("makes a code block only of a fence", () => {
    const html = drawn("    indented prose here\n\tTabbed line\n**b**");
    expect(found(html, "pre")).toHaveLength(0);
    expect(seen(html).trim()).toBe("indented prose here\tTabbed lineb");
    expect(seen(html)).toContain("    indented prose here");
    expect(drawn("    indented prose here")).toBeNull();
  });

  it("keeps every blank line the user typed", () => {
    expect(found(drawn("**a**\n\n\n\nb"), "p + .gap + .gap + .gap + p")).toHaveLength(1);
    expect(found(drawn("**a**\n\nb"), ".gap")).toHaveLength(1);
    expect(found(drawn("> q\n\n\nafter"), "blockquote + .gap + .gap + p")).toHaveLength(1);
    expect(found(drawn("* a\n\n* b\n* c\n\nd"), ".gap")).toHaveLength(2);
    expect(found(drawn("```\nx\n```\n\n\n- l"), "pre + .gap + .gap + ul")).toHaveLength(1);
    expect(found(drawn("**a**\nb"), ".gap")).toHaveLength(0);
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

  it("draws a mention in a fence as its button, and one in a link as its plain @ word", () => {
    const at: SentPart = { text: "@a.ts", path: "a.ts" };
    const fence = sentHtml([{ text: "```\nsee " }, at, { text: "\n```" }], () => true);
    expect(found(fence, "pre button[data-testid='message-mention']").map((el) => el.textContent)).toEqual(["@a.ts"]);
    for (const parts of [
      [{ text: "https://x.com/" }, at],
      [{ text: "[see " }, at, { text: "](https://a.com)" }],
      [{ text: "![" }, at, { text: "](https://a.com/i.png)" }],
    ]) {
      const html = sentHtml(parts, () => true);
      expect(found(html, "a")).toHaveLength(1);
      expect(found(html, "a button, a [data-testid='message-mention']")).toHaveLength(0);
      expect(found(html, "a")[0].textContent).toContain("@a.ts");
    }
    expect(found(sentHtml([{ text: "https://x.com/" }, at], () => true), "a")[0].getAttribute("href")).toBe("https://x.com/@a.ts");
  });

  it("is found as it reads", () => {
    const text = `> quoted ${wire("a.ts")}\n* **one**\n* two`;
    expect(sentText(text, [{ start: 9, end: 9 + wire("a.ts").length, path: "a.ts" }])).toBe("quoted @a.ts\none\ntwo");
    expect(sentText("plain 2 * 3", [])).toBe("plain 2 * 3");
  });
});
