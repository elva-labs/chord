<script lang="ts">
  /**
   * About, a small window of its own: the mark arriving after a beat, the
   * version, which copies with the system for an issue, and the project's
   * page. While the system asks for reduced motion the mark is there at
   * once. Escape closes it.
   */
  import { onMount } from "svelte";
  import { BEAT, DONE, DURATION, blade } from "$lib/blade";
  import BladeMark from "$lib/components/BladeMark.svelte";
  import CopyButton from "$lib/components/CopyButton.svelte";
  import { core, type AboutInfo } from "$lib/core";
  import { reduced } from "$lib/motion";
  import { isMac } from "$lib/platform";

  const PAGE = "https://github.com/elva-labs/chord";
  const mac = isMac();

  let info = $state<AboutInfo | null>(null);
  let elapsed = $state(reduced() ? Infinity : 0);
  const frame = $derived(Number.isFinite(elapsed) ? blade(Math.max(0, elapsed - BEAT)) : DONE);
  const copied = $derived(info ? `Chord ${info.version}, ${info.os} ${info.arch}` : "");

  onMount(() => {
    core()
      .aboutInfo()
      .then((answer) => (info = answer))
      .catch(() => {});
    if (!Number.isFinite(elapsed)) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      if (t >= BEAT + DURATION) {
        elapsed = Infinity;
        return;
      }
      elapsed = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") void core().windowControl("close");
  }

  function open(event: MouseEvent) {
    event.preventDefault();
    void core().openUrl(PAGE);
  }
</script>

<svelte:head><title>About Chord</title></svelte:head>
<svelte:window {onkeydown} />

<div class="window no-select" data-testid="about">
  {#if mac}<div class="strip" data-tauri-drag-region></div>{/if}
  <div class="body">
    <div class="mark"><BladeMark {frame} /></div>
    <h2>Chord</h2>
    <div class="version">
      <span data-testid="about-version">{info?.version ?? ""}</span>
      {#if info}<CopyButton text={copied} label="Copy the version" />{/if}
    </div>
    <a class="link" href={PAGE} onclick={open}>
      github.com/elva-labs/chord<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5l-6 6" /></svg>
    </a>
    <small>© 2026 Elva Labs. MIT licence.</small>
  </div>
</div>

<style>
  .window {
    --h1-size: 15px;
    --h1-weight: 500;
    --h1-track: 0;
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--chrome);
  }

  :global(:root[data-look="modern"]) .window {
    --h1-size: 21px;
    --h1-weight: 600;
    --h1-track: -0.012em;
  }

  /* The title bar is drawn over the page on macOS: this is where the
     window is held to move it. */
  .strip {
    flex: none;
    height: 30px;
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 14px 20px 16px;
    text-align: center;
  }

  .mark {
    width: 84px;
    height: 84px;
  }

  h2 {
    margin: 14px 0 3px;
    font-size: var(--h1-size);
    font-weight: var(--h1-weight);
    letter-spacing: var(--h1-track);
    line-height: 1.25;
    color: var(--ink);
  }

  /* The copy button hangs to the right, so the version alone is centred. */
  .version {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: 20px;
    margin-left: 20px;
    font: 11.5px var(--mono);
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }

  .version span {
    user-select: text;
    -webkit-user-select: text;
  }

  .version :global(.copy) {
    position: relative;
    padding: 4px;
    border-radius: var(--radius-sm);
  }

  .version :global(.copy span) {
    position: absolute;
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    padding-left: 2px;
    font-size: 11px;
    font-family: var(--chrome);
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-top: 14px;
    color: var(--accent);
    font-size: var(--meta-size);
    text-decoration: none;
    white-space: nowrap;
  }

  .link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .link svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  small {
    margin-top: auto;
    font-size: 11px;
    color: var(--ink-3);
  }
</style>
