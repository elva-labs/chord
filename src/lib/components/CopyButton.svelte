<script lang="ts">
  /** A small copy button: the icon alone, and "Copied" for a moment after. */
  import { core } from "$lib/core";

  let { text, label, class: extra = "" }: { text: string; label: string; class?: string } = $props();

  let done = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    try {
      await core().copyText(text);
    } catch {
      return;
    }
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      done = false;
      timer = null;
    }, 1400);
  }

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });
</script>

<button type="button" class="copy {extra}" class:done aria-label={label} onclick={copy}>
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.3" />
    <path d="M8 4V2.8A1.3 1.3 0 0 0 6.7 1.5H2.8A1.3 1.3 0 0 0 1.5 2.8v3.9A1.3 1.3 0 0 0 2.8 8H4" />
  </svg>
  {#if done}<span role="status">Copied</span>{/if}
</button>

<style>
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--ink-3);
    font-size: 11px;
    font-family: var(--chrome);
  }

  .copy:hover {
    color: var(--ink);
  }

  .copy.done {
    color: var(--add);
  }

  svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
