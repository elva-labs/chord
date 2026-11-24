<script lang="ts">
  import type { IntegratedImage } from "$lib/core";

  interface Props {
    /** The images a message carried, in the order they were attached. */
    images: readonly IntegratedImage[];
    /** Opens one at full size in the viewer, by its source and the name it
        is shown under. Without it the images are drawn but not pressed. */
    onOpen?: (picture: { src: string; caption: string }) => void;
  }

  let { images, onOpen }: Props = $props();
</script>

<div class="images">
  {#each images as image, at (at)}
    {@const src = `data:${image.mediaType};base64,${image.data}`}
    {@const name = `Open image ${at + 1} of ${images.length}`}
    {#if image.data === ""}
      <span class="gone" data-testid="sent-image-gone">Image {at + 1} is no longer available</span>
    {:else if onOpen === undefined}
      <img {src} alt="Attached image {at + 1}" />
    {:else}
      <!-- Walked with the thread's other controls: the arrows reach it. -->
      <button
        class="thumb"
        tabindex="-1"
        data-thread-item
        aria-label={name}
        title={name}
        onclick={() => onOpen({ src, caption: images.length === 1 ? "Sent image" : `Sent image ${at + 1} of ${images.length}` })}
        data-testid="sent-image"><img {src} alt="" /></button
      >
    {/if}
  {/each}
</div>

<style>
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  img {
    display: block;
    max-width: 160px;
    max-height: 120px;
    border-radius: var(--radius-sm);
    object-fit: cover;
  }

  .thumb {
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
  }

  .thumb:hover img {
    opacity: 0.85;
  }

  .gone {
    align-self: center;
    font-size: var(--conv-fine);
    color: var(--ink-3);
  }
</style>
