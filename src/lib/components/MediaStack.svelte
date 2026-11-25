<script lang="ts">
  import { media, type MediaItem } from "$lib/media.svelte";
  import { files as changes } from "$lib/files.svelte";
  import { lastSegment } from "$lib/paths";
  import MediaFile from "$lib/components/MediaFile.svelte";

  /**
   * What one item of the media list holds, down the viewer: each file
   * under its name, rendered. The files are read again when the agent
   * presents them again, when the working tree moves, and when the core
   * sees one of them change where it is.
   */

  const KEPT = "The file was removed. This is the copy taken when it was presented.";

  interface Props {
    item: MediaItem;
  }

  let { item }: Props = $props();

  /** The row as the list has it now: its copies arrive after it does. */
  let copies = $derived((media.items.find((row) => row.id === item.id) ?? item).copies);

  /** The files shown from their copy. */
  let kept = $state<Record<string, boolean>>({});
</script>

<div class="stack" data-testid="media-stack">
  {#each item.files as file (file)}
    <section class="file" data-testid="media-file">
      <h3 title={kept[file] ? `${file}\n${KEPT}` : file}>
        <span class="name">{lastSegment(file)}</span>
        {#if kept[file]}<span class="kept" data-testid="media-kept">· kept copy</span>{/if}
      </h3>
      <MediaFile
        path={file}
        copy={copies?.[file] ?? null}
        alt={item.caption ?? lastSegment(file)}
        root={item.project}
        reload="{item.at}:{changes.treeReads}:{changes.shownReads}"
        again="{item.at}:{media.calls[item.id] ?? 0}"
        onshown={(copy) => (kept[file] = copy)}
      />
    </section>
  {/each}
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 12px 16px 24px;
  }

  .file {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    font-weight: 500;
    color: var(--ink-3);
    display: flex;
    gap: 0.5ch;
    white-space: nowrap;
  }

  /* A long name gives way, so what follows it stays in view. */
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kept {
    flex: none;
  }
</style>
