<script lang="ts">
  import { chats } from "$lib/chats.svelte";
  import { core } from "$lib/core";
  import { say } from "$lib/flash.svelte";
  import { refusal } from "$lib/refusal.svelte";

  /** Said once a start: dismissed, it stays away until the next. It waits
      while the settings' refusal is up, which sits in the same place. */
  let dismissed = $state(false);

  let files = $derived(chats.foreign.join(", "));

  async function reveal() {
    if (chats.dir === null) return;
    try {
      await core().revealPath(chats.dir);
    } catch (error) {
      say(`Could not show it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
</script>

{#if !dismissed && refusal.reason === null && (chats.error !== null || chats.foreign.length > 0)}
  <div
    class="notice"
    data-card
    role={chats.error !== null ? "alert" : "status"}
    data-testid="chats-notice"
  >
    {#if chats.error !== null}
      <p>Chats are off: {chats.error}.</p>
    {:else}
      <p>Every chat reads files in the chats folder that Chord did not write: {files}.</p>
      <button type="button" onclick={reveal} data-testid="chats-notice-reveal">Show folder</button>
    {/if}
    <button type="button" onclick={() => (dismissed = true)} data-testid="chats-notice-dismiss"
      >Dismiss</button
    >
  </div>
{/if}

<style>
  .notice {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: min(560px, calc(100% - 24px));
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.45;
  }

  /* Where the cards let a background through, the second surface is a
     fill let through, laid over the card's paint so this still covers
     what is under it. */
  :global(:root[data-cards]) .notice {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  p {
    flex: 1;
    margin: 0 4px 0 0;
    overflow-wrap: anywhere;
  }

  button {
    flex: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    border-radius: var(--radius);
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-2);
    padding: 3px 8px;
  }
</style>
