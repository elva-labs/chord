<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import Icon from "$lib/components/conversation/Icon.svelte";
  import { chatCount, chatMark, chatOnScreen, chats, footEntries, olderCount, type ChatMark } from "$lib/chats.svelte";
  import type { HistoryEntry, Session } from "$lib/sessions.svelte";
  import { sessions } from "$lib/sessions.svelte";

  /**
   * The chats line pinned at the foot of the sessions pane, below the
   * projects and never scrolled away with them: "Chats" and how many, with
   * a mark while one asks, waits unread or works. It opens a tray of the
   * recent chats, with the way to the older ones under them; picking a chat
   * closes it, and the chat on screen keeps its row under the closed line.
   * The rows are the pane's own, handed in, so a chat's row is a session's.
   */
  interface Props {
    /** The row under the pane's keyboard cursor. */
    current: string | null;
    /** What counts as at work for the mark, as a row's dot has it. */
    atWork: (session: Session) => boolean;
    chevron: Snippet<[boolean]>;
    row: Snippet<[Session]>;
    past: Snippet<[HistoryEntry]>;
    older: Snippet<[number]>;
    onNew: () => void;
    newTitle: string;
  }

  let { current, atWork, chevron, row, past, older, onNew, newTitle }: Props = $props();

  let count = $derived(chatCount());
  let entries = $derived(footEntries());
  let rest = $derived(chats.tray ? olderCount() : 0);
  let mark = $derived(chats.tray ? null : chatMark(atWork));

  const MARK_WORDS: Record<ChatMark, string> = {
    asking: "A chat is asking",
    unread: "A chat is waiting for you",
    working: "A chat is at work",
  };

  /** What a screen reader hears for the line: its name, the count and the
      mark's words, which the mark alone would not say. */
  let label = $derived(
    ["Chats", ...(count > 0 ? [String(count)] : []), ...(mark === null ? [] : [MARK_WORDS[mark]])].join(", "),
  );

  // A chat coming in front, however it was picked, closes the tray.
  let shown = sessions.active;
  $effect(() => {
    const key = sessions.active;
    untrack(() => {
      if (key === shown) return;
      shown = key;
      if (chatOnScreen() !== null) chats.tray = false;
    });
  });

  /** A click on a chat's row in the tray closes it, even on the chat
      already in front. */
  function onBodyClick(e: MouseEvent) {
    if (!chats.tray) return;
    const target = e.target as Element;
    if (target.closest('[data-testid="session-row"], [data-testid="past-session"]') !== null) chats.tray = false;
  }
</script>

<div class="foot" class:open={chats.tray} data-testid="chats-foot">
  <div class="fhead">
    <button
      class="line"
      class:cursor={current === "chats"}
      tabindex="-1"
      onclick={() => (chats.tray = !chats.tray)}
      aria-expanded={chats.tray}
      title={chats.tray ? "Close the chats" : "Show the recent chats"}
      aria-label={label}
      data-row="chats"
      data-testid="chats-line"
    >
      <span class="lead">
        <span class="chev-slot">{@render chevron(chats.tray)}</span>
        <span class="bubble"><Icon name="chat" size={13} /></span>
      </span>
      <span class="t">Chats</span>
      {#if count > 0}<span class="c" data-testid="chats-count">· {count}</span>{/if}
      {#if mark !== null}
        <span class="mark {mark}" title={MARK_WORDS[mark]} data-testid="chats-mark"></span>
      {/if}
    </button>
    <button
      class="plus"
      class:hover-only={!chats.tray}
      tabindex="-1"
      onclick={onNew}
      aria-label="New chat"
      title={newTitle}
      data-testid="new-chat-here"><Icon name="plus" size={12} /></button
    >
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fold-body" onclick={onBodyClick} data-testid="chats-rows">
    {#each entries as entry (entry.kind === "row" ? `row:${entry.session.key}` : `past:${entry.transcript.id}`)}
      {#if entry.kind === "row"}{@render row(entry.session)}{:else}{@render past(entry.transcript)}{/if}
    {/each}
    {#if rest > 0}{@render older(rest)}{/if}
    {#if chats.tray && count === 0}
      <p class="none" data-testid="chats-none">No chats yet.</p>
    {/if}
  </div>
</div>

<style>
  /* Pinned under the scrolling projects, behind a hairline. Open, it
     casts a little shadow up over them. */
  .foot {
    flex: none;
    position: relative;
    border-top: 1px solid var(--divider);
    padding: 6px 0 8px;
    background: var(--pane-bg);
  }

  .foot.open {
    box-shadow: 0 -10px 18px -14px rgb(0 0 0 / 0.18);
    max-height: 60%;
    overflow-y: auto;
  }

  .fhead {
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
  }

  .fhead:hover {
    background: var(--surface-2);
  }

  /* Laid out in a session row's columns: the chevron centred over the
     dots, the words where the names start. */
  .line {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: calc(var(--dot) + 10px) auto auto auto;
    justify-content: start;
    align-items: center;
    column-gap: 7px;
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    line-height: 1.5;
    text-align: left;
    color: var(--ink-2);
    cursor: pointer;
  }

  .lead {
    display: flex;
    align-items: center;
  }

  .chev-slot {
    display: flex;
    margin-left: calc(var(--dot) / 2 - 7px);
  }

  /* The folded column has no room for words: the chats are a bubble
     there, in the dots' column. */
  .bubble {
    display: none;
    color: var(--ink-3);
    margin-left: calc(var(--dot) / 2 - 6.5px);
  }

  .t {
    font-weight: var(--project-weight);
  }

  .c {
    color: var(--ink-3);
    margin-left: -3px;
  }

  /* The mark says what the dots would: asking a hollow ring, unread the
     accent, at work the live green breathing. */
  .mark {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .mark.asking {
    background: var(--clear-surface, var(--ground));
    border: 1px solid var(--accent);
    width: 7px;
    height: 7px;
    box-sizing: border-box;
  }

  .mark.working {
    background: var(--add);
    box-shadow: none;
    animation: breathe 1.2s ease-in-out infinite;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  .plus {
    flex: none;
    width: 22px;
    height: 22px;
    margin-right: calc(var(--row-pad-x) - 6px);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .plus:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .plus.hover-only {
    opacity: 0;
  }

  .fhead:hover .plus.hover-only,
  :global(.nav:focus-within) .line.cursor + .plus.hover-only,
  .plus:focus-visible {
    opacity: 1;
  }

  .fold-body {
    padding-top: 2px;
  }

  .none {
    margin: 0;
    padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y) calc(var(--row-inset) + var(--row-pad-x) + var(--dot) + 17px);
    font-family: var(--chrome);
    font-size: var(--fold-size);
    color: var(--ink-3);
  }

  /* The keyboard's cursor, the pane's bar at its left edge. */
  .cursor {
    position: relative;
  }

  :global(.nav:focus-within) .cursor::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 3px;
    bottom: 3px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }

  :global(.nav.folded) .t,
  :global(.nav.folded) .c,
  :global(.nav.folded) .plus,
  :global(.nav.folded) .chev-slot,
  :global(.nav.folded) .none,
  :global(.nav.folded) .cursor::before {
    display: none;
  }

  :global(.nav.folded) .bubble {
    display: flex;
  }

  /* Folded, the mark sits on the bubble's shoulder. */
  :global(.nav.folded) .mark {
    position: absolute;
    left: calc(var(--row-pad-x) + var(--dot) / 2 + 3px);
    top: calc(var(--row-pad-y) + 1px);
  }

  :global(.nav.folded) .fhead:hover {
    background: none;
  }
</style>
