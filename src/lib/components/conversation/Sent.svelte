<script lang="ts">
  import { core } from "$lib/core";
  import { sentHtml } from "$lib/media.svelte";
  import { sentParts, type Sent } from "$lib/mention";
  import Plain from "./Plain.svelte";

  interface Props {
    /** The message's words as they went, its mentions in their sent form. */
    text: string;
    /** Where its mentions stand in `text`. */
    mentions: readonly Sent[];
    /** What find marks the words by. */
    find: string;
    /** How a mentioned file is opened, or null when it cannot be. */
    opener?: (path: string) => (() => void) | null;
  }

  let { text, mentions, find, opener }: Props = $props();

  const parts = $derived(sentParts(text, mentions));
  const html = $derived(sentHtml(parts, (path) => (opener?.(path) ?? null) !== null));

  /** A mention opens its file, and a link opens in the browser. */
  function onclick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const mention = target?.closest<HTMLElement>("[data-mention]");
    if (mention) {
      const path = parts[Number(mention.dataset.mention)]?.path;
      if (path !== undefined) opener?.(path)?.();
      return;
    }
    const anchor = target?.closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) core().openUrl(href).catch(() => {});
  }
</script>

<!-- What the user typed: drawn as typed when it is plain text, and with
     its quotes, lists, code, emphasis and links drawn when it is not. -->
{#if html === null}<p class="typed" data-find={find}
    >{#each parts as part, at (at)}{#if part.path === undefined}<Plain text={part.text} />{:else}{@const open =
          opener?.(part.path) ?? null}{#if open === null}<span class="mention" data-testid="message-mention"
            ><Plain text={part.text} /></span
          >{:else}<button
            class="mention link-file"
            tabindex="-1"
            data-thread-item
            title="Open {part.path}"
            onclick={open}
            data-testid="message-mention"><Plain text={part.text} /></button
          >{/if}{/if}{/each}</p
  >{:else}<!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sent" data-find={find} {onclick} data-testid="sent-markdown">{@html html}</div>{/if}

<style>
  .typed {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The bubble's own ground differs by look, theme and background, so
     what stands on it is mixed from the ink and the accent over it. */
  .sent {
    --sent-fill: color-mix(in srgb, var(--ink) 7%, transparent);
    unicode-bidi: isolate;
    direction: ltr;
    overflow-wrap: anywhere;
  }

  .sent > :global(*:first-child) {
    margin-top: 0;
  }

  .sent > :global(*:last-child) {
    margin-bottom: 0;
  }

  /* A blank line the user typed is a line of its own, so the blocks
     themselves stand as close as the lines typed. */
  .sent :global(p) {
    margin: 0;
  }

  .sent :global(.gap) {
    height: 1lh;
  }

  .sent :global(blockquote) {
    margin: 0.3lh 0;
    padding: 0 0 0 10px;
    border-left: 3px solid color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--ink-2);
  }

  .sent :global(blockquote > :first-child),
  .sent :global(.item > :first-child) {
    margin-top: 0;
  }

  .sent :global(blockquote > :last-child),
  .sent :global(.item > :last-child) {
    margin-bottom: 0;
  }

  /* A list is two columns: the marker each item was typed with, and the
     item. */
  .sent :global(ul),
  .sent :global(ol) {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .sent :global(li) {
    display: contents;
  }

  .sent :global(.marker) {
    padding-left: 0.4em;
    white-space: pre;
    font-variant-numeric: tabular-nums;
  }

  .sent :global(.marker.bullet)::before {
    content: "\2022\a0";
  }

  .sent :global(.item) {
    display: block;
    min-width: 0;
  }

  .sent :global(code) {
    padding: 0.05em 0.3em;
    border-radius: var(--radius-sm);
    background: var(--sent-fill);
    font-family: var(--mono);
    font-size: 0.92em;
  }

  .sent :global(pre) {
    margin: 0.3lh 0;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    background: var(--sent-fill);
    overflow-x: auto;
    overflow-wrap: normal;
    line-height: 1.5;
  }

  .sent :global(pre code) {
    padding: 0;
    border-radius: 0;
    background: none;
    white-space: pre;
  }

  /* The accent alone falls under 4.5 to 1 on the bubble's ground in some
     palettes; a fifth of the ink lifts it there in every one. */
  .sent :global(a) {
    color: color-mix(in srgb, var(--accent) 80%, var(--ink));
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent);
    text-underline-offset: 2px;
  }

  .sent :global(strong) {
    font-weight: 600;
  }

  .sent :global(.plain) {
    unicode-bidi: isolate;
    direction: ltr;
    white-space: pre-wrap;
  }

  .sent :global(pre .plain) {
    white-space: inherit;
  }

  /* The address a link goes to, where its words name another. */
  .sent :global(.goes) {
    color: var(--ink-2);
  }

  .sent :global(.unseen) {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--del) 16%, transparent);
    color: var(--del);
    font-family: var(--mono);
  }

  /* A file the message mentions, in the accent; one the viewer shows
     opens there. */
  .mention,
  .sent :global(.mention) {
    color: var(--accent);
  }

  .link-file,
  .sent :global(.link-file) {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: inherit;
    white-space: inherit;
    overflow-wrap: inherit;
    cursor: pointer;
  }

  .link-file:hover,
  .sent :global(.link-file:hover) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
