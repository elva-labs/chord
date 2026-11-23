<script lang="ts">
  /**
   * The mark at one frame of Blade: ink below the cut and the icon's pink
   * above it, in every palette, look and theme. With no frame it is the
   * finished mark.
   */
  import { CUT_MID, CUT_TOP, DONE, NORMAL, type Frame } from "$lib/blade";

  let { frame = DONE }: { frame?: Frame } = $props();

  const id = $props.id();
  const turned = "translate(512 512) rotate(42)";

  // Uncut, the disc is one shape, so no seam shows where the parts meet.
  const uncut = $derived(frame.gapHeight <= 0 || frame.gapWidth <= 0);
  // While the cut is still crossing, the lower shape draws the whole disc.
  const crossing = $derived(!uncut && frame.gapWidth < 1400);
  const wiped = $derived(270 * frame.wipe);
</script>

<svg viewBox="-64 -64 1152 1152" aria-hidden="true">
  <defs>
    <mask id="{id}-gap" maskUnits="userSpaceOnUse" x="-300" y="-300" width="1624" height="1624">
      <rect x="-300" y="-300" width="1624" height="1624" fill="#fff" />
      <g transform={turned}>
        <rect
          x={frame.gapX}
          y={CUT_MID - frame.gapHeight / 2}
          width={Math.max(0, frame.gapWidth)}
          height={frame.gapHeight}
          fill="#000"
        />
      </g>
    </mask>
    <clipPath id="{id}-below">
      <rect transform={turned} x="-700" y={CUT_MID - 1} width="1400" height="1000" />
    </clipPath>
    <clipPath id="{id}-above">
      <rect transform={turned} x="-700" y="-1000" width="1400" height={1000 + CUT_MID} />
    </clipPath>
    <clipPath id="{id}-disc">
      <circle cx="512" cy="512" r="480" />
    </clipPath>
    <clipPath id="{id}-wipe">
      <rect transform={turned} x="-700" y={CUT_TOP - wiped} width="1400" height={wiped + 0.01} />
    </clipPath>
  </defs>
  <g opacity={frame.opacity} transform="translate(512 512) scale({frame.scale}) translate(-512 -512)">
    {#if uncut}
      <circle class="ink" cx="512" cy="512" r="480" />
    {:else}
      <g clip-path={crossing ? undefined : `url(#${id}-below)`}>
        <circle class="ink" cx="512" cy="512" r="480" mask="url(#{id}-gap)" />
      </g>
    {/if}
    <g transform="translate({frame.lift * NORMAL.x} {frame.lift * NORMAL.y})">
      {#if !uncut && !crossing && !(frame.accent === 1 && frame.wipe === 1)}
        <g clip-path="url(#{id}-above)">
          <circle class="ink" cx="512" cy="512" r="480" mask="url(#{id}-gap)" />
        </g>
      {/if}
      <path
        class="accent"
        d="M374.55 52.1A480 480 0 0 1 983.75 600.62Z"
        opacity={frame.accent}
        clip-path="url(#{id}-wipe)"
      />
    </g>
    {#if frame.glint}
      <g clip-path="url(#{id}-disc)">
        <g transform={turned}>
          <line
            class="glint"
            x1={frame.glint.x}
            x2={frame.glint.x + 110}
            y1={CUT_MID}
            y2={CUT_MID}
            opacity={frame.glint.opacity}
            stroke-width="7"
            stroke-linecap="round"
          />
        </g>
      </g>
    {/if}
  </g>
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .ink {
    fill: var(--ink);
  }

  /* The icon's pink, whatever the palette. */
  .accent {
    fill: #f28db6;
  }

  .glint {
    stroke: var(--ink);
    fill: none;
  }
</style>
