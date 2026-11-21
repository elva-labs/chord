<script lang="ts">
  import { hook, setEverywhere } from "$lib/hook.svelte";
  import { dismissHooksNotice, hooksNoticeDue, retireHooksNotice } from "$lib/notice.svelte";
  import { hookedProjects } from "$lib/workspace.svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import AskChoices, { type AskChoice } from "$lib/components/AskChoices.svelte";

  /**
   * The offer to turn agent hooks on, drawn as the asks are but without
   * their ring: the app offers it, no agent asks. Turning them on here is
   * the same as turning them on for every project in the settings.
   */

  let due = $derived(hooksNoticeDue());

  // Hooks turned on while the notice was up, from here, the settings or
  // anywhere else, is the notice taken.
  let shown = false;
  $effect(() => {
    if (due) shown = true;
  });
  $effect(() => {
    if (hook.everywhere && shown) retireHooksNotice();
  });

  const choices: AskChoice[] = [
    {
      id: "on",
      label: "Turn on",
      testid: "hooks-notice-turn-on",
      primary: true,
      run: () => void setEverywhere(true, hookedProjects()),
    },
    { id: "later", label: "Not now", testid: "hooks-notice-dismiss", quiet: true, run: dismissHooksNotice },
  ];
</script>

{#if due}
  <div class="notice" data-card>
    <AskCard
      variant="offer"
      role="status"
      aria-labelledby="hooks-notice-what"
      whatId="hooks-notice-what"
      factId="hooks-notice-fact"
      data-testid="hooks-notice"
    >
      {#snippet what()}<b>Let agents talk to Chord?</b>{/snippet}
      {#snippet fact()}Shows when an agent works, waits or asks. In every project.{/snippet}
      {#snippet actions()}<AskChoices {choices} describedby="hooks-notice-fact" />{/snippet}
    </AskCard>
  </div>
{/if}

<style>
  /* Over the top of the terminal, where old output is, so the prompt at
     the bottom stays clear. */
  .notice {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 2;
    width: min(380px, calc(100% - 24px));
  }

  .notice > :global(.ask-card) {
    box-shadow:
      inset 0 0 0 1px var(--rule-strong),
      0 14px 34px -20px rgb(0 0 0 / 0.5);
  }

  /* Where the cards let a background through, the offer is laid over the
     card's paint so it still covers what is under it. */
  :global(:root[data-cards]) .notice > :global(.ask-card) {
    background: linear-gradient(var(--surface), var(--surface)), var(--paint-surface);
  }
</style>
