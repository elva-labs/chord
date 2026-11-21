/**
 * Media the agent presented: images, PDFs, documents, pages and diagrams, kept per session
 * as one item per set of files and opened in the changes pane's viewer,
 * every file of the set down the page. Presenting the same files again
 * brings the item to the top with the new caption and shows the files as
 * they are now, so a document worked on over many turns is one row.
 *
 * The agent's request names files and where the agent runs; the session on
 * that directory, in the project it is under, is the one the files belong
 * to, or the project itself when no session is. The list names files on
 * disk rather than keeping copies, so a file the agent later removes shows
 * as gone rather than stale, and it survives a restart the way session
 * names do. A session that goes on from its notes under a new conversation
 * keeps listing what its earlier conversations presented.
 */

import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";
import { marked, Parser, type Renderer, type TextRenderer, type Token } from "marked";
import { runnable } from "$lib/bang";
import { core, type Media, type PresentRequest } from "$lib/core";
import { wholeLineageOf } from "$lib/goingOn.svelte";
import { forProject, sessions } from "$lib/sessions.svelte";
import { held, projectFor, relativeTo, sessionFor } from "$lib/show.svelte";
import { activate, workspace } from "$lib/workspace.svelte";
import { showMedia } from "$lib/files.svelte";

export interface MediaItem {
  id: string;
  /** The agent's session id, which is the same after a restart, or
      `project:<path>` when no session with an id was found. */
  owner: string;
  project: string;
  /** The token of the session that presented it, when the owner is the
      project because the session's id was not known yet. */
  token?: string;
  files: string[];
  caption: string | null;
  /** Seconds since the epoch, of the latest call for these files. */
  at: number;
}

const KEY = "chord.media";
/** The most items kept in all. A session's media is never dropped for
    its own count; past this, the oldest items of conversations no open
    session lists go first. */
const KEEP = 1000;

export const media = $state({
  items: [] as MediaItem[],
  /** How many calls each item has had since the window opened, by its
      id: what draws a page again when it is presented again, however
      soon. Not kept across a restart. */
  calls: {} as Record<string, number>,
});

let loaded = false;

export function loadMedia() {
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    media.items = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is MediaItem =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as MediaItem).id === "string" &&
            Array.isArray((item as MediaItem).files),
        )
      : [];
  } catch {
    media.items = [];
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(media.items));
  } catch {
    // Non-fatal: the list does not survive a restart.
  }
}

/** The session the request is for, by its agent's id: the running one
    whose token the request names, anywhere in the window; else the project
    itself. A session whose id is not known yet cannot own
    anything, since the id is what the list is kept by. */
export function ownerFor(request: PresentRequest, project: string): string {
  return sessionFor(request)?.id ?? `project:${project}`;
}

/** The same files, in any order: the same item, whichever way the agent
    listed them this time. */
function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((file, i) => file === sorted[i]);
}

/** One string for a set of files, the same in any order. */
function filesKey(files: string[]): string {
  return JSON.stringify([...files].sort());
}

/** The owners whose media a session lists: the conversations it went on
    from and itself, or the project's own alone. */
function ownersOf(owner: string): Set<string> {
  return new Set(owner.startsWith("project:") ? [owner] : wholeLineageOf(owner));
}

/** The items for a session, newest first, and the project's own when it
    is asked for. A session lists the media of every conversation it went
    on from as well as its own, and what it presented before its id was
    known; a set of files presented in more than one
    of them is listed once, as its latest call has it. */
export function itemsFor(owner: string, token: string | null = null): MediaItem[] {
  const line = ownersOf(owner);
  const listed: MediaItem[] = [];
  const seen = new Set<string>();
  for (const item of [...media.items].reverse()) {
    const mine = token !== null && item.token === token;
    if (!line.has(item.owner) && !mine) continue;
    const key = filesKey(item.files);
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push(item);
  }
  return listed;
}

/** What the changes pane lists: the active session's, or with none the
    project's own. */
export function listed(): MediaItem[] {
  const project = workspace.active;
  if (project === null) return [];
  const active = forProject(project).find(
    (session) => session.key === sessions.active,
  );
  if (active !== undefined && active.id !== null) return itemsFor(active.id, active.token);
  return itemsFor(`project:${project}`);
}

/** The agent presented files: kept on the session, and opened, now or
    when the user switches to the session. */
export function presented(request: PresentRequest, now = Date.now()) {
  if (!loaded) loadMedia();
  const project = projectFor({
    ...request,
    path: request.files[0] ?? request.cwd,
    from: 1,
    to: 1,
    note: null,
  });
  if (project === null) return;
  const owner = ownerFor(request, project);
  const token = owner.startsWith("project:") ? sessionFor(request)?.token : undefined;
  // A row is reused only under the same owner: an earlier conversation's
  // item stays where it is for the other sessions that went on from it.
  const again = media.items.find(
    (candidate) =>
      candidate.owner === owner && sameFiles(candidate.files, request.files),
  );
  const item: MediaItem = {
    id:
      again?.id ??
      `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner,
    project,
    ...(token === undefined ? {} : { token }),
    files: request.files,
    caption: request.caption,
    at: Math.floor(now / 1000),
  };
  if (again !== undefined) {
    media.items = media.items.filter((candidate) => candidate !== again);
  }
  media.items.push(item);
  media.calls[item.id] = (media.calls[item.id] ?? 0) + 1;
  trim();
  save();
  const open = () => {
    if (workspace.active !== project) activate(project);
    showMedia(item);
  };
  if (held(request, open)) return;
  open();
}

/** Keeps the list under `KEEP`: the oldest items go, those of
    conversations an open session lists last of all, never one of them. */
function trim() {
  let extra = media.items.length - KEEP;
  if (extra <= 0) return;
  const open = new Set<string>();
  for (const session of sessions.all)
    if (session.id !== null) for (const id of wholeLineageOf(session.id)) open.add(id);
  const tokens = new Set(sessions.all.map((session) => session.token));
  const drop = new Set<string>();
  for (const item of media.items) {
    if (extra === 0) break;
    if (open.has(item.owner) || (item.token !== undefined && tokens.has(item.token))) continue;
    drop.add(item.id);
    extra -= 1;
  }
  media.items = media.items.filter((item) => !drop.has(item.id));
}

/** A call from the list, opened in the viewer again. */
export function openItem(item: MediaItem) {
  showMedia(item);
}

/** What the viewer shows for a file: an image or a PDF as a data URL, a
    Markdown document rendered to HTML, or the reason it cannot be shown. */
export type Loaded =
  | { mime: string; url: string }
  | { mime: string; html: string }
  /** An HTML page, shown in a frame of its own. */
  | { mime: string; page: string }
  /** A Mermaid diagram's source, drawn in the window. */
  | { mime: string; diagram: string }
  | { error: string };

/** Where a link or an image in a document may point: the web, mail, or a
    place in the document, and for a document's image also a file of its
    project (see `image`). Anything else, a `javascript:` link above all,
    is rendered as its text. */
const LINK = /^(?:https?:|mailto:|#)/i;
const IMAGE = /^(?:https?:|data:image\/)/i;

const renderer = new marked.Renderer();
renderer.link = ({ href, title, tokens }) => {
  const text = renderer.parser.parseInline(tokens);
  if (!LINK.test(href)) return text;
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(href)}"${named} rel="noopener noreferrer">${text}</a>`;
};
renderer.image = ({ href, title, text }) => {
  const src = image(href);
  if (src === null) return escapeText(text);
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(text)}"${named}>`;
};

/** The renderer for what an agent says in a conversation: the same, except
    that an image is loaded only from the text itself. One from anywhere
    else would be fetched the moment the words arrive, which would tell
    whoever serves it whatever the agent put in its address. */
const said = new marked.Renderer();
said.link = ({ href, title, tokens }) => {
  const text = said.parser.parseInline(tokens);
  if (!LINK.test(href)) return text;
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(href)}"${named} rel="noopener noreferrer">${text}</a>`;
};
said.image = ({ href, title, text }) => {
  if (/^data:image\//i.test(href)) {
    const named = title ? ` title="${escapeAttribute(title)}"` : "";
    return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${named}>`;
  }
  if (!/^https?:/i.test(href)) return escapeText(text);
  return `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${escapeText(text || href)}</a>`;
};

/** The languages a fenced block names when it holds words rather than
    code: such a block is a drafted message, a comment or a description
    for the reader to copy. A block with no language is one too, unless
    it holds text laid out by its lines (see `drawn`). Any other language
    is code, whose lines are kept as written. */
const PROSE = new Set(["text", "txt", "plain", "plaintext", "markdown", "md", "message", "email", "comment", "prose"]);

/** Whether a block's lines are laid out rather than written as prose: a
    table or tree drawn in text, aligned columns, command output, a stack
    trace, a diff. Such a block keeps its lines and scrolls sideways. */
function drawn(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      /[\u2500-\u257f]/.test(line) ||
      (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) ||
      /^(?:---|\+\+\+) |^@@ /.test(line) ||
      /\S(?: {2,}|\t+)\S/.test(line) ||
      /^\s*at \S.*:\d+(?::\d+)?\)?$|^\s*File ".*", line \d+|^Traceback /.test(line)
    );
  });
}

/** A line's hanging indent in characters: its leading whitespace and a
    list marker after it, so a continuation line starts under the words. */
function hang(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  const width = lead.replace(/\t/g, "        ").length;
  const marker = /^(?:[-*+]|\d{1,3}[.)]|>)[ \t]+/.exec(line.slice(lead.length));
  return width + (marker ? marker[0].length : 0);
}

/** Every code block the agent wrote, at the top or in a list or a quote,
    stands in a box of its own that the conversation puts its Copy in. A
    block of prose wraps at the box's width, each line a block of its own
    that hangs its continuation lines under its words; the text of the
    box is still the lines as written, line breaks included. A line that
    is a command for the user to run is marked for its Run (see `runLine`). */
const drawCode = said.code;
said.code = function (this: typeof said, token) {
  const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  if ((lang !== "" && !PROSE.has(lang)) || (lang === "" && drawn(token.text)))
    return `<div class="code" data-copy-host="code">${runLines(drawCode.call(this, token))}</div>`;
  const named = lang === "" ? "" : ` class="language-${escapeAttribute(lang)}"`;
  const lines = token.text
    .split("\n")
    .map((line) => `<span class="line" style="--hang:${hang(line)}ch">${runLine(escapeAttribute(line))}\n</span>`)
    .join("");
  return `<div class="code" data-copy-host="code" data-wrap><pre><code${named}>${lines}</code></pre></div>\n`;
};

/** What marks an element as holding a command for the user to run. The
    command is drawn left to right in the order it runs, so right-to-left
    letters in it cannot reorder or mirror what is around them. */
const RUN = 'data-run="" dir="ltr" style="unicode-bidi: bidi-override"';

/** A line of code as HTML, held in an element marked `data-run` when it is
    a command for the user to run, `!` and a space and then the command, so
    the conversation puts a Run after it. Escaping leaves a line's `!` and
    space as they are and an empty line empty, so the escaped line tells
    as well as the line itself. */
function runLine(html: string): string {
  return runnable(html) === null ? html : `<span ${RUN}>${html}</span>`;
}

/** A code block as marked draws it, each of its lines through `runLine`. */
function runLines(html: string): string {
  const block = /^(<pre><code[^>]*>)([\s\S]*)(<\/code><\/pre>\n?)$/.exec(html);
  if (block === null) return html;
  return block[1] + block[2].split("\n").map(runLine).join("\n") + block[3];
}

/** A code span is marked `data-run` when it holds a command for the user
    to run, as a line of a block is. */
const drawSpan = said.codespan;
said.codespan = function (this: typeof said, token) {
  const html = drawSpan.call(this, token);
  return runnable(token.text) === null ? html : html.replace(/^<code>/, `<code ${RUN}>`);
};

/** What an attribute's value may be: the value to write, or null when the
    tag may not be drawn with it. */
type Check = (value: string) => string | null;
const ANY: Check = (value) => value;
const HREF: Check = (value) => (LINK.test(value.trim()) ? value.trim() : null);
const SRC: Check = (value) => image(value);
/** A value that is one of `values`, in any case, written in lower case. */
const oneOf =
  (...values: string[]): Check =>
  (value) => {
    const kept = value.trim().toLowerCase();
    return values.includes(kept) ? kept : null;
  };
/** A size in whole pixels, at most 4096, or a percentage of at most 100. */
const SIZE: Check = (value) => {
  const size = /^(\d{1,4})(%?)$/.exec(value.trim());
  if (size === null) return null;
  const amount = Number(size[1]);
  return amount > (size[2] === "%" ? 100 : 4096) ? null : `${amount}${size[2]}`;
};
/** The query of a source for one colour scheme, light or dark. Any other
    would tell the image's host the window's width, density or settings,
    and when they change. */
const SCHEME: Check = (value) => {
  const scheme = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/i.exec(value.trim());
  return scheme === null ? null : `(prefers-color-scheme: ${scheme[1].toLowerCase()})`;
};
const ALIGN = new Map([["align", oneOf("left", "right", "center", "justify")]]);
const NONE = new Map<string, Check>();

/** The HTML a document may draw, a subset of what GitHub draws in a
    README: each element and the attributes it may carry. An image or a
    link points only where one written in Markdown may. No `id`, `name` or
    `class`, which could stand in for the app's own elements, no `style`,
    and no `srcset` on an image, which would load what its `src` was
    checked not to. */
const ALLOWED = new Map<string, Map<string, Check>>([
  ["p", ALIGN],
  ["div", ALIGN],
  ["h1", ALIGN],
  ["h2", ALIGN],
  ["h3", ALIGN],
  ["h4", ALIGN],
  ["h5", ALIGN],
  ["h6", ALIGN],
  [
    "img",
    new Map([
      ["src", SRC],
      ["alt", ANY],
      ["width", SIZE],
      ["height", SIZE],
      ["align", oneOf("left", "right", "top", "middle", "bottom")],
    ]),
  ],
  [
    "a",
    new Map([
      ["href", HREF],
      ["title", ANY],
    ]),
  ],
  ["details", new Map([["open", () => ""]])],
  ["summary", NONE],
  ["picture", NONE],
  [
    "source",
    new Map([
      ["srcset", sources],
      ["media", SCHEME],
    ]),
  ],
  ["br", NONE],
  ["hr", NONE],
  ["kbd", NONE],
  ["sub", NONE],
  ["sup", NONE],
  ["b", NONE],
  ["i", NONE],
  ["strong", NONE],
  ["em", NONE],
  ["code", NONE],
  ["pre", NONE],
]);

/** The elements that have no content and so are never closed. */
const VOID = new Set(["img", "br", "hr", "source"]);

/** The elements that close at the end of the block they were opened in,
    a paragraph, a heading, a list item, a table cell or a block of HTML,
    as Markdown's own links and emphasis do: one left open reaches no
    further than its block. */
const INLINE = new Set(["a", "b", "i", "strong", "em", "code", "kbd", "sub", "sup", "picture"]);

/** The most elements drawn open at once. An opening tag past them is
    shown as its text, which bounds both the work of a closing tag and the
    depth of what is drawn. */
const DEEPEST = 100;

/** A `srcset` with every image in it one `image` allows, written anew as
    the browser reads it: each address, and after it a width or a density
    if it has one. Null when an address or a descriptor is anything else.
    Every address is put to `image`, so each of the project's is read for
    the document even when one before it is not there yet. */
function sources(srcset: string): string | null {
  const space = (at: number) => /[\t\n\f\r ]/.test(srcset[at]);
  const candidates: string[] = [];
  let refused = false;
  let at = 0;
  for (;;) {
    while (at < srcset.length && (space(at) || srcset[at] === ",")) at++;
    if (at >= srcset.length) break;
    let end = at;
    while (end < srcset.length && !space(end)) end++;
    let url = srcset.slice(at, end);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      at = end;
    } else {
      const comma = srcset.indexOf(",", end);
      const stop = comma === -1 ? srcset.length : comma;
      descriptor = srcset.slice(end, stop).trim();
      at = stop + 1;
    }
    const src = image(url);
    if (src === null || (descriptor !== "" && !/^\d+(?:\.\d+)?[wx]$/.test(descriptor))) refused = true;
    else candidates.push(descriptor === "" ? src : `${src} ${descriptor}`);
  }
  return refused || candidates.length === 0 ? null : candidates.join(", ");
}

/** A file of its project read for a document: the image as a data URL,
    and its size in bytes. */
interface ProjectImage {
  src: string;
  size: number;
}

/** The files of its project that a document's images are drawn from while
    it renders, by the address the document names them by, and the
    addresses it names that are not among them. */
let local: ReadonlyMap<string, ProjectImage> = new Map();
let wanted = new Set<string>();

/** How many bytes of the project's images the document has drawn so far,
    an image counted every time it is drawn, and whether one did not fit
    in `IMAGE_BYTES`, after which none of the project's is drawn. */
let spent = 0;
let full = false;

/** For each `<picture>` drawn and still open, the innermost last, where
    its images come from: the web or the project, by the first it names,
    or null before it names one. */
let pictures: ("web" | "project" | null)[] = [];

/** Whether an image from `place` would mix the innermost open picture's
    images, which come from the other place. The browser draws a picture's
    first image it can, so a picture of both would fetch one from the web
    only when a file of the project was not there, and so tell the web
    whether it is. An image written into the document is from neither. */
function mixes(place: "web" | "project"): boolean {
  if (pictures.length === 0) return false;
  const first = pictures.at(-1) ?? place;
  pictures[pictures.length - 1] = first;
  return first !== place;
}

/** An image's address as it is drawn, or null when the image is shown as
    its text: an address `IMAGE` allows, or a path relative to the
    document, drawn from the file of its project `load` read for it while
    the images of the project drawn before it leave room for it. In a
    picture, an image from the web or the project is drawn only when the
    picture's others come from the same place. */
function image(address: string): string | null {
  const src = address.trim();
  if (/^data:image\//i.test(src)) return src;
  if (IMAGE.test(src)) return mixes("web") ? null : src;
  if (src === "" || /^[a-z][a-z0-9+.-]*:|^[/\\#?]/i.test(src) || mixes("project")) return null;
  const read = local.get(src);
  if (read === undefined) {
    wanted.add(src);
    return null;
  }
  full ||= spent + read.size > IMAGE_BYTES;
  if (full) return null;
  spent += read.size;
  return read.src;
}

/** The elements drawn from the document's HTML that are still open, the
    innermost last, and how many of each name. Raw HTML comes to the
    renderer a piece at a time, a `<details>` in one block and its
    `</details>` after the Markdown inside it, so what is open is kept
    across the pieces of one `render`. */
let opened: string[] = [];
const counted = new Map<string, number>();

function push(name: string) {
  opened.push(name);
  counted.set(name, (counted.get(name) ?? 0) + 1);
  if (name === "picture") pictures.push(null);
}

/** The closing tags of the elements open from `at` up, the innermost
    first, which are then open no longer. */
function closeFrom(at: number): string {
  let out = "";
  while (opened.length > at) {
    const name = opened.pop()!;
    counted.set(name, counted.get(name)! - 1);
    if (name === "picture") pictures.pop();
    out += `</${name}>`;
  }
  return out;
}

/** An opening tag as it is drawn, or null when it is shown as its text: an
    element `ALLOWED` names, with no attribute it does not name, none
    twice, and each value one its check keeps, within `DEEPEST` of what is
    open. A `<source>` is drawn only directly in a `<picture>`. */
function opening(name: string, attributes: [string, string][], closes: boolean): string | null {
  const allowed = ALLOWED.get(name);
  if (allowed === undefined) return null;
  if (name === "source" && opened.at(-1) !== "picture") return null;
  const stays = !VOID.has(name) && !closes;
  if (stays && opened.length >= DEEPEST) return null;
  const seen = new Set<string>();
  let tag = `<${name}`;
  for (const [attribute, value] of attributes) {
    const check = allowed.get(attribute);
    if (check === undefined || seen.has(attribute)) return null;
    seen.add(attribute);
    const kept = check(value);
    if (kept === null) return null;
    tag += ` ${attribute}="${escapeAttribute(kept)}"`;
  }
  if (name === "a") tag += ' rel="noopener noreferrer"';
  tag += ">";
  if (VOID.has(name)) return tag;
  // An element written as closing itself, `<b/>`, is drawn empty.
  if (closes) return `${tag}</${name}>`;
  push(name);
  return tag;
}

/** A closing tag as it is drawn, or null when it is shown as its text. It
    closes an element drawn here that is still open, and any opened inside
    it; `</br>` is a line break and the close of another empty element is
    nothing, as a browser reads them. One with none of its name open is
    refused without a look at what is. */
function closing(name: string): string | null {
  if (name === "br") return "<br>";
  if (VOID.has(name)) return "";
  if (!counted.get(name)) return null;
  return closeFrom(opened.lastIndexOf(name));
}

/** A piece of a document's raw HTML as HTML to draw. Each tag `opening`
    or `closing` allows is written anew from what was read of it; every
    other tag, a comment, and the text between are escaped and shown as
    the letters they are. Nothing of the source passes through as markup,
    so a malformed tag the tokenizer reads otherwise than a browser would
    can change only what is shown, never what runs. */
function markup(html: string): string {
  let out = "";
  /** Where the source not yet written out starts. */
  let from = 0;
  let tag: { start: number; name: string; attributes: [string, string][] } | null = null;
  let attribute: [string, string] | null = null;

  /** Writes the source up to `start` as text, then `drawn` for the tag
      that ends at `end`. */
  const draw = (start: number, end: number, drawn: string) => {
    out += escapeText(html.slice(from, start)) + drawn;
    from = end + 1;
  };
  const open = (end: number, closes: boolean) => {
    const read = tag;
    tag = null;
    if (read === null) return;
    const drawn = opening(read.name, read.attributes, closes);
    if (drawn !== null) draw(read.start, end, drawn);
  };

  const callbacks: TokenizerCallbacks = {
    onopentagname(start, end) {
      tag = { start: start - 1, name: html.slice(start, end).toLowerCase(), attributes: [] };
    },
    onattribname(start, end) {
      attribute = [html.slice(start, end).toLowerCase(), ""];
    },
    onattribdata(start, end) {
      if (attribute !== null) attribute[1] += html.slice(start, end);
    },
    onattribentity(codepoint) {
      if (attribute !== null) attribute[1] += String.fromCodePoint(codepoint);
    },
    onattribend() {
      if (tag !== null && attribute !== null) tag.attributes.push(attribute);
      attribute = null;
    },
    onopentagend: (end) => open(end, false),
    onselfclosingtag: (end) => open(end, true),
    onclosetag(start, end) {
      // The tokenizer passes over whatever follows the name, to the `>`.
      const close = html.indexOf(">", end);
      if (close === -1) return;
      const drawn = closing(html.slice(start, end).toLowerCase());
      if (drawn !== null) draw(start - 2, close, drawn);
    },
    ontext() {},
    ontextentity() {},
    oncomment() {},
    oncdata() {},
    ondeclaration() {},
    onprocessinginstruction() {},
    onend() {},
  };
  const tokenizer = new Tokenizer({ decodeEntities: true }, callbacks);
  tokenizer.write(html);
  tokenizer.end();
  return out + escapeText(html.slice(from));
}

/** Raw HTML in a document is drawn as far as `markup` allows, and in a
    conversation is shown as the text it is, never drawn. Text is always
    escaped here: marked leaves text unescaped once it believes a raw block
    such as `<code>` has opened, and only what `markup` writes may be
    markup. Code is escaped by marked itself. */
renderer.html = ({ text, block }) => {
  const mark = opened.length;
  const html = markup(text);
  if (!block) return html;
  const inline = opened.findIndex((name, at) => at >= mark && INLINE.has(name));
  return inline === -1 ? html : html + closeFrom(inline);
};
said.html = ({ text }) => escapeText(text);
renderer.text = (token) =>
  "tokens" in token && token.tokens ? renderer.parser.parseInline(token.tokens) : escapeText(token.text);
said.text = (token) =>
  "tokens" in token && token.tokens ? said.parser.parseInline(token.tokens) : escapeText(token.text);

/** Text as HTML that draws it as text: `<` and `>` always escaped, and
    `&` escaped unless it starts an entity, which then draws as its
    character, as Markdown means it to. An entity can only ever be text: it
    is decoded after the markup is read, so `&lt;b&gt;` is the letters,
    never a tag. */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The parser of a document. Each run of text, the inside of a paragraph,
    a heading, a list item, a table cell or a link, closes before it ends
    what its HTML opened in it, so an element left open reaches no further. */
class Scoped extends Parser {
  override parseInline(tokens: Token[], drawer?: Renderer | TextRenderer): string {
    const mark = opened.length;
    return super.parseInline(tokens, drawer) + closeFrom(mark);
  }
}

/** A document drawn as `render` draws it, except that an image named by a
    path relative to it is drawn from `images`, the files of its project
    read for it by that path, as far as `image` allows; and the addresses
    of the images it names in its project that are not among them. */
function drawDocument(
  markdown: string,
  images: ReadonlyMap<string, ProjectImage>,
): { html: string; wanted: string[] } {
  const clear = () => {
    opened = [];
    counted.clear();
    pictures = [];
    local = new Map();
    wanted = new Set();
    spent = 0;
    full = false;
  };
  clear();
  local = images;
  try {
    const options = { ...marked.defaults, async: false, gfm: true };
    const html = new Scoped({ ...options, renderer }).parse(marked.lexer(markdown, options));
    return { html: html + closeFrom(0), wanted: [...wanted] };
  } finally {
    clear();
  }
}

/** Markdown rendered for the viewer. Raw HTML in the document is drawn
    only as far as `ALLOWED` goes and shown as its text beyond that, and a
    link or an image may point only where `LINK` and `IMAGE` allow, since
    the document is the agent's and the window is the app's. An image
    named by a path relative to the document is shown as its text here;
    `load` draws it from the document's project. A `<picture>` draws
    images from the web or from the project, never both. An element the
    document leaves open is closed at the end of its block, or of the
    document. */
export function render(markdown: string): string {
  return drawDocument(markdown, new Map()).html;
}

/** Markdown an agent wrote in a conversation, rendered as `render` does,
    with an image from anywhere but the text itself shown as a link. */
export function renderSaid(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, renderer: said }) as string;
}

/** Markdown an agent wrote, rendered as `renderSaid` does, one top-level
    block at a time, so a block that is done is drawn once while the words
    after it still come. */
export function saidBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown, { gfm: true });
  const out: string[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    // Each block is parsed with the whole text's link definitions, so a
    // reference link finds its address wherever it is defined.
    const one = Object.assign([token], { links: tokens.links });
    out.push(marked.parser(one, { async: false, gfm: true, renderer: said }));
  }
  return out;
}

/** How much of Markdown that is still being written stands in whole
    blocks that nothing written after it can change: every block but the
    last, which may yet grow. Rendered on its own, that much renders as it
    does at the head of the whole text, so it need only be rendered once. */
export function settled(markdown: string): number {
  const tokens = marked.lexer(markdown, { gfm: true });
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === "space") last--;
  const whole = tokens
    .slice(0, Math.max(0, last))
    .map((token) => token.raw)
    .join("");
  // The lexer reads line ends its own way; what it read must be the text
  // as it stands for its length to say where the blocks end.
  return markdown.startsWith(whole) ? whole.length : 0;
}

function decode(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** How many of the images a document names in its project are read for
    it at most, and how many bytes of them it draws in all, an image
    counted every time it is named. Past the first, an image shows as its
    text; past the second, so does every image of the project after it,
    so which are drawn turns on the document and its files alone, never on
    the order their reads land in. */
const IMAGES_READ = 64;
const IMAGE_BYTES = 64 * 1024 * 1024;

/** The file an address relative to a document names: without a query or
    a fragment, and its escapes decoded. */
function named(address: string): string {
  const path = address.replace(/[?#][\s\S]*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The images a document at `at` in the project at `root` names by
    `addresses`, in the order it first names them, read where the project
    is, four at a time, by those addresses. One the document may not draw
    is left out. No read is begun once those read come to more than
    `IMAGE_BYTES`: the document names each of them before any address not
    yet begun, and `image` counts them as it draws them, so it can draw
    none named after them. Nor is one begun once `stale` says the document
    is no longer wanted. */
async function readImages(
  root: string,
  at: string,
  addresses: string[],
  stale: () => boolean,
): Promise<Map<string, ProjectImage>> {
  const read = new Map<string, ProjectImage>();
  const queue = addresses.slice(0, IMAGES_READ);
  let bytes = 0;
  const reader = async () => {
    for (
      let address = queue.shift();
      address !== undefined && bytes <= IMAGE_BYTES && !stale();
      address = queue.shift()
    ) {
      try {
        const found = await core().readDocumentImage(root, at, named(address));
        if (!found.mime.startsWith("image/")) continue;
        bytes += found.size;
        read.set(address, { src: `data:${found.mime};base64,${found.data}`, size: found.size });
      } catch {
        // Not an image the document may draw: it shows as its text.
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, reader));
  return read;
}

/** A file read for the viewer. A Markdown document in the project at
    `root` draws the images it names by a path relative to itself from the
    project, and stops reading them once `stale` says the file is no
    longer wanted; one outside it, or with no project, draws only those
    from the web or written in it. */
export async function load(
  path: string,
  root: string | null = null,
  stale: () => boolean = () => false,
): Promise<Loaded> {
  try {
    const found: Media = await core().readMedia(path);
    if (found.mime === "text/markdown") {
      const markdown = decode(found.data);
      const first = drawDocument(markdown, new Map());
      const at = root === null ? null : relativeTo(path, root);
      if (root === null || !at || first.wanted.length === 0) return { mime: found.mime, html: first.html };
      const images = await readImages(root, at, first.wanted, stale);
      return { mime: found.mime, html: images.size === 0 ? first.html : drawDocument(markdown, images).html };
    }
    if (found.mime === "text/html") {
      return { mime: found.mime, page: decode(found.data) };
    }
    if (found.mime === "text/vnd.mermaid") {
      return { mime: found.mime, diagram: decode(found.data) };
    }
    return { mime: found.mime, url: `data:${found.mime};base64,${found.data}` };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Test seam. */
export function resetMedia() {
  loaded = true;
  media.items = [];
  media.calls = {};
}
