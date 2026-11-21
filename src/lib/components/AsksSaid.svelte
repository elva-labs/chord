<script lang="ts">
  import { untrack } from "svelte";
  import { openAsks, sayAsks } from "$lib/askNotices.svelte";

  /**
   * The one polite live line for every question that waits on the user,
   * out of sight: a new one is said once, by who asks and what for, where
   * it is docked and where it floats over the window alike. The line is
   * emptied first, so a question worded as the last one is heard too.
   */
  let line = $state("");

  $effect(() => {
    const now = openAsks();
    const text = untrack(() => sayAsks(now));
    if (text === "") return;
    line = "";
    setTimeout(() => (line = text));
  });
</script>

<p class="sr" role="status" aria-live="polite" data-testid="asks-said">{line}</p>

<style>
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
