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
 * disk and shows them as they are now, and it survives a restart the way
 * session names do. A file outside the project and the session's worktree
 * also has a copy kept for it, which is shown only once the file is gone;
 * a copy lasts as long as its row. A row whose files are gone with no copy
 * says so and can be removed. A session that goes on from its notes under
 * a new conversation keeps listing what its earlier conversations
 * presented.
 */

import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";
import {
  Lexer,
  marked,
  Tokenizer as Lexing,
  Parser,
  type Renderer,
  type TextRenderer,
  type Token,
  type Tokens,
  type TokensList,
} from "marked";
import { runnable } from "$lib/bang";
import { core, type Media, type PresentRequest } from "$lib/core";
import { wholeLineageOf } from "$lib/goingOn.svelte";
import { forProject, sessions } from "$lib/sessions.svelte";
import { held, projectFor, relativeTo, sessionFor, within } from "$lib/show.svelte";
import { activate, workspace } from "$lib/workspace.svelte";
import { closeViewer, files as viewer, showMedia } from "$lib/files.svelte";
import { revealed, shown } from "$lib/unseen";

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
  /** The copy kept of a file, by the file's path, on the same machine.
      Only files outside the project have one. */
  copies?: Record<string, string>;
}

/** The core's words for a file that is not there. */
const GONE = "this file is gone";

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
  /** The rows whose files are all gone with no copy to show, by id, as
      last looked. */
  gone: {} as Record<string, boolean>,
  /** Counts the reads that found a file gone: the rows are then looked at
      again. */
  missed: 0,
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
  const carried = again?.copies;
  const item: MediaItem = {
    ...(carried === undefined ? {} : { copies: { ...carried } }),
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
  delete media.gone[item.id];
  trim();
  save();
  const worktree = sessionFor(request)?.worktree ?? null;
  const outside = request.files.filter(
    (file) => !within(file, project) && !(worktree !== null && within(file, worktree)),
  );
  if (outside.length > 0) void keepCopies(item.id, outside);
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
  for (const item of media.items) if (drop.has(item.id)) forget(Object.values(item.copies ?? {}));
  media.items = media.items.filter((item) => !drop.has(item.id));
}

/** Copies the files a row holds from outside its project. A file the core
    made no copy of keeps the one it had. */
async function keepCopies(id: string, files: string[]) {
  const call = media.calls[id];
  let kept: (string | null)[];
  try {
    kept = await core().keepMedia(files);
  } catch {
    // A machine whose core keeps no copies: the files are shown live.
    return;
  }
  const made = kept.filter((copy): copy is string => copy !== null);
  const item = media.items.find((candidate) => candidate.id === id);
  // A later call for these files, or the row's removal, leaves these
  // copies with no row to belong to.
  if (item === undefined || media.calls[id] !== call) {
    forget(made);
    return;
  }
  if (made.length === 0) return;
  const copies = { ...item.copies };
  const replaced: string[] = [];
  files.forEach((file, i) => {
    const copy = kept[i];
    if (copy === null || copy === undefined) return;
    if (copies[file] !== undefined) replaced.push(copies[file]);
    copies[file] = copy;
  });
  item.copies = copies;
  save();
  forget(replaced);
}

/** Removes copies no row holds any longer. */
function forget(copies: string[]) {
  if (copies.length === 0) return;
  void core()
    .forgetMedia(copies)
    .catch(() => {});
}

/** The latest look for gone rows: an earlier one's answer is dropped. */
let look = 0;

/** Finds which of the rows have every file gone and no copy of any. */
export async function lookForGone(items: MediaItem[]) {
  const current = ++look;
  // One question for each project, so each goes to a single machine.
  const asked = new Map<string, Set<string>>();
  const rows = items.map((item) => ({
    id: item.id,
    project: item.project,
    // What each file could be shown from.
    places: item.files.map((file) => {
      const copy = item.copies?.[file];
      return copy === undefined ? [file] : [file, copy];
    }),
  }));
  for (const row of rows) {
    const paths = asked.get(row.project) ?? new Set<string>();
    for (const path of row.places.flat()) paths.add(path);
    asked.set(row.project, paths);
  }
  const gone = new Map<string, Set<string>>();
  await Promise.all(
    [...asked].map(async ([project, paths]) => {
      const list = [...paths];
      try {
        const answers = await core().mediaGone(list);
        gone.set(project, new Set(list.filter((_, i) => answers[i] === true)));
      } catch {
        // Not known: the rows stay as they are.
      }
    }),
  );
  if (current !== look) return;
  for (const row of rows) {
    const missing = gone.get(row.project);
    if (missing === undefined) continue;
    if (row.places.every((places) => places.every((path) => missing.has(path))))
      media.gone[row.id] = true;
    else delete media.gone[row.id];
  }
}

/** Takes a row off the list, with the same files' rows from the earlier
    conversations it stands for, and their copies. */
export function removeItem(item: MediaItem) {
  const line = ownersOf(item.owner);
  const active = sessions.all.find((session) => session.key === sessions.active);
  if (active !== undefined && active.id !== null && ownersOf(active.id).has(item.owner))
    for (const owner of ownersOf(active.id)) line.add(owner);
  const key = filesKey(item.files);
  const drop = media.items.filter(
    (candidate) =>
      candidate.id === item.id ||
      (filesKey(candidate.files) === key &&
        (line.has(candidate.owner) ||
          (active !== undefined && candidate.token === active.token))),
  );
  const ids = new Set(drop.map((candidate) => candidate.id));
  for (const candidate of drop) {
    forget(Object.values(candidate.copies ?? {}));
    delete media.gone[candidate.id];
  }
  media.items = media.items.filter((candidate) => !ids.has(candidate.id));
  save();
  if (viewer.media !== null && ids.has(viewer.media.id)) closeViewer();
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
  /** The file is not there, and no copy of it is. */
  | { gone: true }
  | { error: string };

/** Where a link or an image in a document may point: the web, mail, or a
    place in the document, and for a document's image also a file of its
    project (see `image`). Anything else, a `javascript:` link above all,
    is rendered as its text. */
const LINK = /^(?:https?:|mailto:|#)/i;
const IMAGE = /^(?:https?:|data:image\/)/i;

/** Whether a link's words read as an address: one with its scheme or
    `www.`, or a host under one of the common endings. */
const ADDRESS = /^(?:https?:\/\/|www\.)\S|^[^\s/@:]+\.(?:com|org|net|io|dev|app|ai|co|edu|gov|me|info|xyz)(?:[/:?#]\S*)?$/i;

/** Whether a link's words name an address other than the one it goes to. */
function elsewhere(words: string, href: string): boolean {
  const bare = (address: string) =>
    address
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return ADDRESS.test(words.trim()) && bare(words) !== bare(href);
}

/** A link drawn so that where it goes can be read: the window has no
    status bar, so the address stands in the link's title, after the
    title its Markdown gave it, and after the link itself when its words
    name another address. `text` is the link's words as HTML and `words`
    the same as text; `more` is further attributes. */
function anchor(href: string, title: string | null | undefined, text: string, words: string, more = ""): string {
  const named = escapeAttribute(shown(title ? `${title} (${href})` : href));
  const after = elsewhere(words, href) ? `<span class="goes"> (${escapeAttribute(shown(href))})</span>` : "";
  return `<a href="${escapeAttribute(href)}" title="${named}" rel="noopener noreferrer"${more}>${text}</a>${after}`;
}

const renderer = new marked.Renderer();
renderer.link = ({ href, title, tokens }) => {
  const text = renderer.parser.parseInline(tokens);
  if (!LINK.test(href)) return text;
  return anchor(href, title, text, renderer.parser.parseInline(tokens, renderer.parser.textRenderer));
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
  return WEB.test(href) ? unnamed(href, title, text) : text;
};
said.image = ({ href, title, text }) => {
  if (/^data:image\//i.test(href)) {
    const named = title ? ` title="${escapeAttribute(title)}"` : "";
    return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${named}>`;
  }
  if (!WEB.test(href)) return escapeText(text);
  return unnamed(href, null, escapeText(text || href));
};

/** A link of a reply before `addressed` says where it goes. */
function unnamed(href: string, title: string | null | undefined, text: string): string {
  return `<a href="${escapeAttribute(href)}" title="${escapeAttribute(title ?? "")}" rel="noopener noreferrer">${text}</a>`;
}

/** Everything a link may read as: its words with every fold inside it as
    it is drawn, and what each shut fold holds, together and a child at a
    time, which shows once it opens. Each is read without and with its
    images' words. Every element is read once, however deep the folds go. */
function readings(link: Element): string[] {
  const out: string[] = [];
  type Words = [string, string];
  const note = (words: Words) => (out.push(...words), words);
  const joined = (parts: Words[]): Words => [parts.map((part) => part[0]).join(""), parts.map((part) => part[1]).join("")];
  const read = (node: Node): Words => {
    if (node instanceof Text) return [node.data, node.data];
    if (!(node instanceof Element)) return ["", ""];
    if (node.tagName === "IMG") return ["", node.getAttribute("alt") ?? ""];
    const children = [...node.childNodes];
    if (node.tagName !== "DETAILS" || node.hasAttribute("open")) return joined(children.map(read));
    const summary = (child: Node) => child instanceof Element && child.tagName === "SUMMARY";
    note(joined(children.filter((child) => !summary(child)).map((child) => note(read(child)))));
    return joined(children.filter(summary).map(read));
  };
  note(read(link));
  return out;
}

/** A block of a reply with where each of its links goes said as `anchor`
    says it, whether Markdown or HTML wrote the link. It is read from the
    elements the block makes, so no markup among a link's words can pass
    one address off as another. */
function addressed(html: string): string {
  if (!html.includes("<a ")) return html;
  const made = document.createElement("template");
  made.innerHTML = html;
  for (const link of made.content.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href")!;
    const title = link.getAttribute("title");
    link.setAttribute("title", shown(title ? `${title} (${href})` : href));
    if (!readings(link).some((words) => elsewhere(words, href))) continue;
    const goes = document.createElement("span");
    goes.className = "goes";
    goes.textContent = ` (${shown(href)})`;
    link.after(goes);
  }
  return made.innerHTML;
}

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
/** A conversation's links lead only to the web, which is all a click in one
    opens. */
const HREF: Check = (value) => {
  const href = value.trim();
  return (speaking ? WEB : LINK).test(href) ? href : null;
};
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

/** The HTML a document or a reply may draw, a subset of what GitHub draws
    in a README: each element and the attributes it may carry. An image or
    a link points only where one written in Markdown may. No `id`, `name` or
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

/** The elements of a reply's HTML that may hold the blocks after the one
    they were opened in. Any other closes at the end of its own. */
const HOLDING = new Set(["div", "details", "pre"]);

/** Whether a reply's folds are drawn as plain blocks, which show all they
    hold and cannot be shut. */
let unfolded = false;

/** The name an element is written with. */
function written(name: string): string {
  return unfolded && (name === "details" || name === "summary") ? "div" : name;
}

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

/** Whether what is drawn is a reply in a conversation, whose HTML may draw
    an image only from the text itself, as its Markdown may. */
let speaking = false;

/** An image's address as it is drawn, or null when the image is shown as
    its text: an address `IMAGE` allows, or a path relative to the
    document, drawn from the file of its project `load` read for it while
    the images of the project drawn before it leave room for it. In a
    picture, an image from the web or the project is drawn only when the
    picture's others come from the same place. A conversation draws only an
    image held in the address itself. */
function image(address: string): string | null {
  const src = address.trim();
  if (/^data:image\//i.test(src)) return src;
  if (speaking) return null;
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

/** How many of the elements open were opened outside the block being
    drawn, which its closing tags leave open. */
let floor = 0;

/** The closing tags of the elements open from `at` up, the innermost
    first, which are then open no longer. */
function closeFrom(at: number): string {
  let out = "";
  while (opened.length > at) {
    const name = opened.pop()!;
    counted.set(name, counted.get(name)! - 1);
    if (name === "picture") pictures.pop();
    out += `</${written(name)}>`;
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
  let tag = `<${written(name)}`;
  for (const [attribute, value] of attributes) {
    const check = allowed.get(attribute);
    if (check === undefined || seen.has(attribute)) return null;
    seen.add(attribute);
    const kept = check(value);
    if (kept === null) return null;
    if (written(name) === name) tag += ` ${attribute}="${escapeAttribute(kept)}"`;
  }
  if (name === "a") tag += ' rel="noopener noreferrer"';
  tag += ">";
  if (VOID.has(name)) return tag;
  // An element written as closing itself, `<b/>`, is drawn empty.
  if (closes) return `${tag}</${written(name)}>`;
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
  const at = opened.lastIndexOf(name);
  return at < floor ? null : closeFrom(at);
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

/** Raw HTML, in a document and in a reply, is drawn as far as `markup`
    allows. Text is always escaped here: marked leaves text unescaped once
    it believes a raw block such as `<code>` has opened, and only what
    `markup` writes may be markup. Code is escaped by marked itself. */
const rawHtml =
  (ends: (name: string) => boolean) =>
  ({ text, block }: Tokens.HTML | Tokens.Tag) => {
    const mark = opened.length;
    const html = markup(text);
    if (!block) return html;
    const first = opened.findIndex((name, at) => at >= mark && ends(name));
    return first === -1 ? html : html + closeFrom(first);
  };
renderer.html = rawHtml((name) => INLINE.has(name));
said.html = rawHtml((name) => !HOLDING.has(name));
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

/** Forgets what the last rendering left open and read. */
function clear() {
  opened = [];
  counted.clear();
  floor = 0;
  speaking = false;
  unfolded = false;
  pictures = [];
  local = new Map();
  wanted = new Set();
  spent = 0;
  full = false;
}

/** A document drawn as `render` draws it, except that an image named by a
    path relative to it is drawn from `images`, the files of its project
    read for it by that path, as far as `image` allows; and the addresses
    of the images it names in its project that are not among them. */
function drawDocument(
  markdown: string,
  images: ReadonlyMap<string, ProjectImage>,
): { html: string; wanted: string[] } {
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

/** The top-level tokens of a reply drawn in order, `each` called with what
    one draws, its source, and whether nothing is open after it. A `<div>`,
    `<details>` or `<pre>` a block of HTML leaves open holds the blocks after it, up to the one
    that closes it or the end of the reply; any other block closes what was
    opened in it and nothing opened before it. */
function speak(
  tokens: TokensList,
  count: number,
  each: (html: string, raw: string, whole: boolean) => void,
  flat = false,
) {
  clear();
  speaking = true;
  unfolded = flat;
  try {
    const options = { ...marked.defaults, async: false, gfm: true, renderer: said };
    for (let at = 0; at < count; at++) {
      const token = tokens[at];
      if (token.type === "space") {
        each("", token.raw, opened.length === 0);
        continue;
      }
      const mark = opened.length;
      floor = token.type === "html" ? 0 : mark;
      // Each block is parsed with the whole text's link definitions, so a
      // reference link finds its address wherever it is defined.
      const one = Object.assign([token], { links: tokens.links });
      let html = new Scoped(options).parse(one);
      if (token.type !== "html") html += closeFrom(mark);
      each(html, token.raw, opened.length === 0);
    }
    if (count === tokens.length && opened.length > 0) each(closeFrom(0), "", true);
  } finally {
    clear();
  }
}

/** Markdown an agent wrote in a conversation, rendered as `render` does,
    raw HTML included, except that an image from anywhere but the text
    itself is not drawn: Markdown's shows as a link to it and HTML's as the
    tag's text. A link is drawn only to the web, and where it goes can be
    read from it. With `flat`, a fold is drawn as a plain block. */
export function renderSaid(markdown: string, flat = false): string {
  return saidBlocks(markdown, flat).join("");
}

/** Markdown an agent wrote, rendered as `renderSaid` does, a piece at a
    time, so a piece that is done is drawn once while the words after it
    still come. A piece is a top-level block, or the blocks an element of
    its HTML holds. */
export function saidBlocks(markdown: string, flat = false): string[] {
  const tokens = marked.lexer(markdown, { gfm: true });
  const out: string[] = [];
  let piece = "";
  let drawn = false;
  speak(
    tokens,
    tokens.length,
    (html, _, whole) => {
      piece += html;
      drawn ||= html !== "";
      if (!whole || !drawn) return;
      out.push(addressed(piece));
      piece = "";
      drawn = false;
    },
    flat,
  );
  return out;
}

/** How much of Markdown that is still being written stands in whole
    blocks that nothing written after it can change: every block but the
    last, which may yet grow, up to where no element of its HTML is open.
    Rendered on its own, that much renders as it does at the head of the
    whole text, so it need only be rendered once. */
export function settled(markdown: string): number {
  const tokens = marked.lexer(markdown, { gfm: true });
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === "space") last--;
  let read = "";
  let whole = "";
  speak(tokens, Math.max(0, last), (_, raw, closed) => {
    read += raw;
    if (closed) whole = read;
  });
  // The lexer reads line ends its own way; what it read must be the text
  // as it stands for its length to say where the blocks end.
  return markdown.startsWith(whole) ? whole.length : 0;
}

/** The end of a text that may be the start of a tag: `<` or `</`, then a
    name, then what may be attributes, with no `>` yet. */
const HALF = /<\/?(?:([a-z][a-z0-9]*)([\s/][^<>]{0,500})?)?$/i;

/** Whether what follows a half tag's name may still be its attributes: each
    further line of it starts as one of the element's attributes or a `/`,
    and only the last, still being written, is empty or part of a name. A
    blank line ends it. */
function attributes(name: string, rest: string): boolean {
  const names = [...(ALLOWED.get(name)?.keys() ?? [])];
  return rest
    .split("\n")
    .slice(1)
    .every((line, at, lines) => {
      const last = at === lines.length - 1;
      const said = line.trim();
      if (said === "") return last;
      if (said.startsWith("/")) return true;
      const [, word, after] = /^([a-z]*)(.*)$/i.exec(said)!;
      const known = word.toLowerCase();
      if (last && after === "") return names.some((attribute) => attribute.startsWith(known));
      return names.includes(known) && /^(?:$|[\s=/])/.test(after);
    });
}

/** Markdown still being written without a tag at its end that has only half
    arrived and may yet be drawn, so its letters do not show and then give
    way to the element. Code, where a tag is its letters, is left whole. */
export function arrived(markdown: string): string {
  const half = HALF.exec(markdown);
  if (half === null) return markdown;
  const name = half[1]?.toLowerCase();
  if (name !== undefined) {
    const may = half[2] === undefined ? [...ALLOWED.keys()].some((known) => known.startsWith(name)) : ALLOWED.has(name);
    if (!may || !attributes(name, half[2] ?? "")) return markdown;
  }
  const line = markdown.slice(markdown.lastIndexOf("\n", half.index) + 1, half.index);
  if ((line.split("`").length - 1) % 2 === 1) return markdown;
  if (marked.lexer(markdown, { gfm: true }).findLast((token) => token.type !== "space")?.type === "code") return markdown;
  return markdown.slice(0, half.index);
}

// ---- what the user sent ----

/** Where a link in a message the user sent may point: the web. */
const WEB = /^https?:\/\//i;

/** How the lexer reads a message the user typed. A message is not a
    document, and what is not plainly meant as Markdown shows as typed: a
    `#` line, a `---` line, a table, a `~`, a reference definition, HTML,
    an indented line, a backslash, a character reference, a `_`, and a
    link or an image that points anywhere but the web. A quote is only
    its own `>` lines and a list ends at a line that is neither a list
    item nor indented under one, so the line typed after either is a line
    of its own and never drawn into it. */
class Typed extends Lexing {
  /** The lengths of `*` run that nothing closes from here on, in the
      text they were last looked for in. */
  #unclosed = { text: "", runs: new Set<number>() };

  override heading(): undefined {}
  override lheading(): undefined {}
  override hr(): undefined {}
  override table(): undefined {}
  override def(): undefined {}
  override html(): undefined {}
  override del(): undefined {}
  override code(): undefined {}
  override escape(): undefined {}
  override blockquote(src: string): Tokens.Blockquote | undefined {
    const lines = /^(?: {0,3}>[^\n]*(?:\n|$))+/.exec(src);
    return lines === null ? undefined : super.blockquote(lines[0]);
  }
  override list(src: string): Tokens.List | undefined {
    const lines = src.split("\n");
    const end = lines.findIndex((line, at) => at > 0 && /^\S/.test(line) && !/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line));
    return super.list(end === -1 ? src : lines.slice(0, end).join("\n") + "\n");
  }
  override link(src: string): Tokens.Link | Tokens.Image | undefined {
    const token = super.link(src);
    return token !== undefined && WEB.test(typedBack(token.href)) ? token : undefined;
  }
  override autolink(src: string): Tokens.Link | undefined {
    const token = super.autolink(src);
    return token !== undefined && WEB.test(typedBack(token.href)) ? token : undefined;
  }
  override url(src: string): Tokens.Link | undefined {
    const token = super.url(src);
    return token !== undefined && WEB.test(typedBack(token.href)) ? token : undefined;
  }
  /** A line break is the end of a line, and what stands around it,
      a backslash before it or spaces after it, is text. */
  override br(src: string): Tokens.Br | undefined {
    const raw = /^ *\n/.exec(src)?.[0];
    return raw === undefined ? undefined : { type: "br", raw };
  }
  override inlineText(src: string): Tokens.Text | undefined {
    const token = super.inlineText(src);
    if (token !== undefined) token.text = token.raw;
    return token;
  }
  /** Emphasis is only a run of one to three `*` that opens after the
      start of a line or a space, before a word, and closes after a word,
      before a space, a mark other than `/`, or the end. A glob such as
      `src/*.ts` and a name such as `__init__.py` are neither. */
  override emStrong(src: string, maskedSrc: string): Tokens.Em | Tokens.Strong | undefined {
    const run = /^(\*{1,3})(?![\s*./])./.exec(src)?.[1].length;
    if (run === undefined) return undefined;
    const at = maskedSrc.length - src.length;
    if (at > 0 && !/\s/.test(maskedSrc[at - 1])) return undefined;
    if (this.#unclosed.text !== maskedSrc) this.#unclosed = { text: maskedSrc, runs: new Set() };
    if (this.#unclosed.runs.has(run)) return undefined;
    const runs = /\*+/g;
    runs.lastIndex = at + run;
    for (let found = runs.exec(maskedSrc); found !== null; found = runs.exec(maskedSrc)) {
      if (found[0].length !== run) continue;
      const before = maskedSrc[found.index - 1];
      const after = maskedSrc[found.index + run] ?? "";
      if (/\s/.test(before)) {
        // A run that opens in its turn: this one was never closed.
        if (after !== "" && !/\s/.test(after)) return undefined;
        continue;
      }
      if (before === "/" || before === "\\") continue;
      if (after !== "" && !/\s/.test(after) && (after === "/" || !/[\p{P}\p{S}]/u.test(after))) continue;
      const raw = src.slice(0, found.index - at + run);
      const text = raw.slice(run, -run);
      const strong = (): Tokens.Strong => ({
        type: "strong",
        raw: raw.slice(run - 2, raw.length - (run - 2)),
        text,
        tokens: this.lexer.inlineTokens(text),
      });
      if (run === 2) return strong();
      return { type: "em", raw, text: raw.slice(1, -1), tokens: run === 3 ? [strong()] : this.lexer.inlineTokens(text) };
    }
    this.#unclosed.runs.add(run);
    return undefined;
  }
}

/** The options a message is read and drawn with: GFM, and a line break
    where the user typed one. */
const TYPED = { async: false as const, gfm: true, breaks: true };

/** A message's text drawn as text: escaped, isolated left to right, each
    character that would change how it reads without being seen shown as
    its marker, as `Plain` draws it, in code as anywhere else. */
function reveal(text: string): string {
  const parts = revealed(text).map((part) =>
    part.unseen
      ? `<span class="unseen" data-testid="unseen-character">${escapeAttribute(part.text)}</span>`
      : escapeAttribute(part.text),
  );
  return `<span class="plain">${parts.join("")}</span>`;
}

/** The renderer for a message the user sent. It draws text only as text,
    loads nothing, and draws a link only to the web. */
const sent = new marked.Renderer();
sent.text = (token) =>
  "tokens" in token && token.tokens ? sent.parser.parseInline(token.tokens) : reveal(token.text);
sent.html = ({ text }) => reveal(text);
sent.codespan = ({ text }) => `<code>${reveal(text)}</code>`;
sent.code = ({ text }) => `<pre><code>${reveal(text)}</code></pre>\n`;
sent.checkbox = ({ checked }) => reveal(checked ? "[x] " : "[ ] ");
sent.link = ({ href, title, tokens }) => {
  const text = worded(sent.parser.parseInline(tokens));
  const address = typedBack(href);
  if (!WEB.test(address)) return text;
  const words = typedBack(sent.parser.parseInline(tokens, sent.parser.textRenderer));
  return anchor(address, title ? typedBack(title) : null, text, words, ' tabindex="-1"');
};
sent.image = ({ href, text }) => {
  const address = typedBack(href);
  const words = typedBack(text);
  if (!WEB.test(address)) return reveal(words);
  return anchor(address, null, reveal(words || address), words || address, ' tabindex="-1"');
};
/** Each blank line the user typed stands as a line of its own. */
sent.space = ({ raw }) => '<div class="gap"></div>'.repeat(raw.length);
/** Every item shows the marker the user typed: its number as typed, or a
    bullet. */
sent.list = ({ ordered, items }) => {
  const drawn = items.map((item) => {
    const number = /^[ \t]*(\d{1,9}[.)])/.exec(item.raw)?.[1];
    const marker =
      number === undefined ? '<span class="marker bullet"></span>' : `<span class="marker">${reveal(`${number} `)}</span>`;
    return `<li>${marker}<span class="item">${sent.parser.parse(item.tokens)}</span></li>`;
  });
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${drawn.join("")}</${tag}>\n`;
};

/** A piece of a message as `sentParts` splits it: words, or a mention of
    a file or folder by its path. */
export interface SentPart {
  text: string;
  path?: string;
}

/** The mentions of the message being drawn, each by the character that
    stands in for it while it is read (see `sentHtml`). */
let standIns = new Map<string, SentPart>();

/** Text with every mention standing in it as its `@` word again, for an
    address or a title, where it can only be text. */
function typedBack(text: string): string {
  let out = "";
  for (const char of text) out += standIns.get(char)?.text ?? char;
  return out;
}

/** A link's words as HTML with every mention in them as its plain `@`
    word: a link holds no button. */
function worded(html: string): string {
  let out = "";
  for (const char of html) {
    const part = standIns.get(char);
    out += part === undefined ? char : escapeAttribute(shown(part.text));
  }
  return out;
}

/** A mention as the bubble draws it, as a button that opens its file
    when it can be opened. */
function mentioned(part: SentPart, at: number, opens: boolean): string {
  const word = reveal(part.text);
  if (!opens) return `<span class="mention" data-testid="message-mention">${word}</span>`;
  const title = escapeAttribute(`Open ${shown(part.path!)}`);
  return `<button class="mention link-file" tabindex="-1" data-thread-item data-mention="${at}" title="${title}" data-testid="message-mention">${word}</button>`;
}

/** Whether what was read draws anything a plain paragraph would not: a
    message of plain paragraphs, line breaks and `<` words is drawn as
    typed instead. */
function plain(tokens: Token[]): boolean {
  return tokens.every(
    (token) =>
      token.type === "space" ||
      (token.type === "paragraph" && (token.tokens ?? []).every((inline) => ["text", "br", "html"].includes(inline.type))),
  );
}

/** The blank lines that end `text`, given that a line ends before them. */
function blanks(text: string): number {
  const lines = /\s*$/.exec(text)![0].split("\n").length - 1;
  return Math.max(0, lines - 1);
}

/** The blocks of a message as they are drawn. Every blank line between
    two blocks, and before the first, stands as a line (see `sent.space`).
    Paragraphs with no blank line between them are one paragraph, so the
    user's line break stays a line break where the lexer split them at a
    line it would have read as a heading or a rule. Lists with no blank
    line between them are one list, whatever marker each was typed with. */
function joined(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const gap = (lines: number): Token => ({ type: "space", raw: "\n".repeat(lines) });
  let between = "";
  for (const token of tokens) {
    if (token.type === "space") {
      between += token.raw;
      continue;
    }
    if (token.type === "blockquote") token.tokens = joined(token.tokens ?? []);
    if (token.type === "list") {
      const items = token.items as Tokens.ListItem[];
      items.forEach((item, at) => {
        item.tokens = joined(item.tokens);
        const under = blanks(item.raw);
        if (under > 0 && at < items.length - 1) item.tokens.push(gap(under));
      });
    }
    const last = out.at(-1);
    const empty = last === undefined ? between.split("\n").length - 1 : blanks(between);
    if (empty > 0) out.push(gap(empty));
    else if (token.type === "paragraph" && last?.type === "paragraph") {
      last.tokens!.push({ type: "br", raw: "\n" }, ...token.tokens!);
      last.raw += token.raw;
      last.text += "\n" + token.text;
      between = /\s*$/.exec(token.raw)![0];
      continue;
    } else if (token.type === "list" && last?.type === "list") {
      (last.items as Tokens.ListItem[]).push(...(token.items as Tokens.ListItem[]));
      last.raw += token.raw;
      between = /\s*$/.exec(token.raw)![0];
      continue;
    }
    out.push(token);
    between = /\s*$/.exec(token.raw)![0];
  }
  return out;
}

/** A message the user typed as HTML, or null when it is plain text and
    is drawn as typed. Quotes, lists, fenced and inline code, bold, italic
    and links to the web are drawn; anything else shows as typed. A
    mention is drawn as its `@` word, a button marked with its part's
    place in `parts` when `opens` says its file can be opened. */
export function sentHtml(parts: readonly SentPart[], opens: (path: string) => boolean = () => false): string | null {
  const text = parts.map((part) => part.text).join("");
  if (text === "") return null;
  // Each mention stands in the text as a character of its own that the
  // text does not hold, so the Markdown around it is read as typed.
  const used = new Set(text);
  let next = 0xe000;
  const standing = new Map<string, number>();
  let source = "";
  parts.forEach((part, at) => {
    if (part.path === undefined) {
      source += part.text;
      return;
    }
    while (used.has(String.fromCodePoint(next))) next++;
    const char = String.fromCodePoint(next++);
    standing.set(char, at);
    source += char;
  });
  standIns = new Map([...standing].map(([char, at]) => [char, parts[at]]));
  try {
    const tokens = new Lexer({ ...marked.defaults, ...TYPED, tokenizer: new Typed() }).lex(source);
    if (plain(tokens)) return null;
    const html = new Parser({ ...marked.defaults, ...TYPED, renderer: sent }).parse(joined(tokens));
    let out = "";
    for (const char of html) {
      const at = standing.get(char);
      out += at === undefined ? char : mentioned(parts[at], at, opens(parts[at].path!));
    }
    return out;
  } finally {
    standIns = new Map();
  }
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
    from the web or written in it. When the file is gone, the `copy` kept
    of it is read in its place. */
export async function load(
  path: string,
  root: string | null = null,
  stale: () => boolean = () => false,
  copy: string | null = null,
): Promise<Loaded & { from?: string }> {
  const found = await loadAt(path, root, stale);
  if (!("gone" in found)) return found;
  if (copy !== null) {
    const kept = await loadAt(copy, null, stale);
    if (!("gone" in kept)) return { ...kept, from: copy };
  }
  media.missed += 1;
  return found;
}

async function loadAt(
  path: string,
  root: string | null,
  stale: () => boolean,
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
    return String(error).endsWith(GONE) ? { gone: true } : { error: String(error) };
  }
}

/** Test seam. */
export function resetMedia() {
  loaded = true;
  media.items = [];
  media.calls = {};
  media.gone = {};
  media.missed = 0;
}
