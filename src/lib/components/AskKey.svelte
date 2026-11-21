<script lang="ts">
  /** The digit that picks an answer of an ask, shown on it. It is drawn
      for the eye alone: the answer it is on names its key to those who
      hear it. */
  let { n }: { n: number } = $props();
</script>

<span class="key" aria-hidden="true">{n}</span>

<style>
  .key {
    flex: none;
    display: inline-grid;
    place-items: center;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 4px;
    font: 600 10px/1 var(--sans);
    font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, currentColor 14%, transparent);
  }
</style>
