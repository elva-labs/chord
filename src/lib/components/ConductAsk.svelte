<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { aboveFoot } from "$lib/aboveFoot.svelte";
  import { conductor } from "$lib/conductor.svelte";
  import { returnFocus } from "$lib/layout.svelte";
  import { askDockedIn } from "$lib/docked.svelte";
  import ConductCard from "$lib/components/ConductCard.svelte";
  import { SETTLE } from "$lib/components/AskChoices.svelte";

  /**
   * A session's question to the user, over the window: one that asks to
   * start a session, or for a round of review past its limit, while the
   * asking session is not on screen to dock it. It stands above the
 * composer and dock of the session on screen, never takes the
   * keyboard, and takes no answer for a moment after it comes, so a click
   * or key meant for what was there before answers nothing.
   */

  let ask = $derived(conductor.asking);
  let docked = $derived(askDockedIn() !== null);
  let shown = $derived(ask !== null && !docked ? ask : null);

  let armed = $state(false);
  let settling: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const now = shown;
    untrack(() => {
      if (settling !== null) clearTimeout(settling);
      settling = null;
      armed = false;
      if (now === null) return;
      settling = setTimeout(() => {
        settling = null;
        armed = true;
      }, SETTLE);
    });
  });
  onDestroy(() => {
    if (settling !== null) clearTimeout(settling);
  });
</script>

{#if shown !== null}
  {#key shown}
    <div class="over" data-card use:coversBrowser use:aboveFoot>
      <ConductCard
        ask={shown}
        who={shown.caller}
        {armed}
        id="conduct-ask"
        role="alertdialog"
        class="floating"
        testid="conduct-ask"
        onAnswered={returnFocus}
      />
    </div>
  {/key}
{/if}

<style>
  /* Over the window and a peeked sessions pane, standing above the
     composer and dock of the conversation on screen. The left, bottom and
     height here are where it starts. */
  .over {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    width: min(460px, calc(100vw - 48px));
    max-height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
  }

  .over > :global(.ask-card.floating) {
    min-height: 0;
    overflow: auto;
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--rule)),
      0 22px 50px -24px rgb(0 0 0 / 0.55);
  }

  /* Where the cards let a background through, the ask is laid over the
     card's paint so it still covers what is under it. */
  :global(:root[data-cards]) .over > :global(.ask-card.floating) {
    background: var(--paint-surface);
  }
</style>
