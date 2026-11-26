<script lang="ts">
  /**
   * The question before the window closes or the app quits while sessions
   * run, shells are busy or the editor holds unsaved edits: the one sheet,
   * centred over the whole window whatever the panes under it show. It
   * says what goes: how many sessions stop and how many of them wait on
   * the user, what runs in each busy shell, and every unsaved file. It
   * tells the core it is up from here, once it is on the page: the core
   * takes that as the question being in front of the user, and lets the
   * window go when it does not hear it. Cancel has the keyboard, so Return
   * alone does no harm; Tab stays inside the sheet, and Escape cancels.
   */
  import { tick } from "svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import AskChoices, { type AskChoice } from "$lib/components/AskChoices.svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { core } from "$lib/core";
  import {
    editor,
    leaveCancelled,
    leaveWithoutSaving,
    saveAllAndLeave,
    unsavedNames,
  } from "$lib/editor.svelte";
  import { leaving, running, runningAside, runningQuestion } from "$lib/leaving.svelte";
  import { tabWithin } from "$lib/tabStops";

  let ask = $derived(editor.asking?.kind === "leave" ? editor.asking : null);
  let names = $derived(ask === null ? [] : unsavedNames());
  let live = $derived(running());
  let busy = $derived(ask === null ? null : runningQuestion(ask.leave, live, leaving.busy));
  /** How many files have edits not yet saved, the count and its noun kept
      together on one line. */
  let files = $derived(names.length === 1 ? "1\u00a0file has" : `${names.length}\u00a0files have`);
  let quit = $derived(ask?.leave === "quit");

  let question = $derived(
    names.length > 0 ? (quit ? "Quit with unsaved edits?" : "Close the window with unsaved edits?") : (busy?.question ?? ""),
  );
  let detail = $derived(
    names.length > 0 ? `${files} edits: ${names.join(", ")}.${runningAside(live, leaving.busy)}` : (busy?.detail ?? ""),
  );

  const cancel: AskChoice = {
    id: "cancel",
    label: "Cancel",
    testid: "close-window-cancel",
    quiet: true,
    run: leaveCancelled,
  };
  let choices = $derived<AskChoice[]>(
    names.length > 0
      ? [
          {
            id: "save",
            label: quit ? "Save all and quit" : "Save all and close",
            testid: "close-window-alternative",
            primary: true,
            run: () => void saveAllAndLeave(),
          },
          {
            id: "leave",
            label: quit ? "Quit without saving" : "Close without saving",
            testid: "close-window-confirm",
            run: leaveWithoutSaving,
          },
          cancel,
        ]
      : [
          { id: "leave", label: busy?.action ?? "", testid: "close-window-confirm", primary: true, run: leaveWithoutSaving },
          cancel,
        ],
  );
  let pointed = $state<string | null>("cancel");

  /** Says the question numbered `generation` is on the page: each time a
      new one is drawn, a close asked again while it is up included. */
  function heard(node: HTMLElement, generation: number) {
    const tell = (number: number) => {
      if (node.isConnected) void core().leaveHeard(number).catch(() => {});
    };
    tell(generation);
    return { update: tell };
  }

  /** Cancel takes the keyboard as the sheet comes. */
  function cancelFirst(node: HTMLElement) {
    pointed = "cancel";
    void tick().then(() => node.querySelector<HTMLButtonElement>('[data-choice="cancel"]')?.focus());
  }

  /** The sheet holds the keyboard while it is up: Tab goes round its
      stops, and Escape cancels. */
  function keys(event: KeyboardEvent) {
    if (event.key === "Tab") {
      tabWithin(event, event.currentTarget as HTMLElement);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    leaveCancelled();
  }
</script>

{#if ask !== null && (names.length > 0 || busy !== null)}
  <div class="scrim" aria-hidden="true" data-testid="leave-scrim"></div>
  <div class="leave" data-card use:coversBrowser use:heard={ask.generation} use:cancelFirst data-testid="leave-ask">
    <AskCard
      variant="sheet"
      role="alertdialog"
      aria-labelledby="close-window-what"
      aria-describedby="close-window-fact"
      whatId="close-window-what"
      factId="close-window-fact"
      tabindex={-1}
      onkeydown={keys}
      data-testid="close-window"
    >
      {#snippet what()}<b>{question}</b>{/snippet}
      {#snippet fact()}{detail}{/snippet}
      {#snippet actions()}<AskChoices {choices} bind:pointed />{/snippet}
    </AskCard>
  </div>
{/if}

<style>
  /* Over every pane, in the middle of the window, where it is read before
     anything under it. */
  .leave {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 40;
    width: min(380px, calc(100vw - 48px));
  }

  .leave > :global(.ask-card) {
    outline: none;
  }

  /* A faint veil over the window takes the clicks meant for what is under
     the sheet, so the sheet reads as the one thing to answer. */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 39;
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }

  /* Where the cards let a background through, the sheet is laid over the
     card's paint so it still covers what is under it. */
  :global(:root[data-cards]) .leave > :global(.ask-card) {
    background: var(--paint-surface);
  }
</style>
