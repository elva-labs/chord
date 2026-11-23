<script lang="ts">
  /**
   * The welcome, a small window of its own. After a beat the mark arrives
   * in the middle, moves up to its place, and the checks come in under it,
   * one piece after another. The core reads the machine while the mark
   * plays, so the list mostly arrives with its answers.
   *
   * Continue shows once an agent is found, or when the checks could not
   * tell, and goes on to the main window. Opened at a later launch that
   * found no agent, the welcome says Chord needs one, for as long as the
   * checks say so, and shows them at once, without the mark's arrival; so
   * does any opening while the system asks for reduced motion.
   */
  import { onMount } from "svelte";
  import { BEAT, DONE, DURATION, arrived, blade, moved, risen, welcomeEnds } from "$lib/blade";
  import BladeMark from "$lib/components/BladeMark.svelte";
  import SetupChecks from "$lib/components/SetupChecks.svelte";
  import { core } from "$lib/core";
  import { reduced } from "$lib/motion";
  import { isMac } from "$lib/platform";
  import { checkSetup, setup } from "$lib/setup.svelte";
  import { agentFound, blocked, unsure } from "$lib/setupRows";

  const again = new URLSearchParams(location.search).has("again");
  const mac = isMac();

  /** The heading, the lede, the two groups and the footer. */
  const PIECES = 5;
  /** Where the mark sits once it has moved: the slot's height and middle. */
  const SLOT = 44;
  const SLOT_MIDDLE = 8 + SLOT / 2;

  /** Milliseconds since the window opened; past the motion, it is over. */
  let elapsed = $state(again || reduced() ? Infinity : 0);
  let width = $state(440);
  let height = $state(400);

  const after = $derived(elapsed - BEAT - DURATION);
  const frame = $derived(Number.isFinite(elapsed) ? blade(Math.max(0, elapsed - BEAT)) : DONE);
  const mark = $derived.by(() => {
    const p = moved(after);
    const from = Math.min(148, width * 0.36);
    const size = from * Math.pow(SLOT / from, p);
    const y = height * 0.44 + (SLOT_MIDDLE - height * 0.44) * p;
    return `width: ${size}px; height: ${size}px; transform: translate(${width / 2 - size / 2}px, ${y - size / 2}px)`;
  });
  const piece = (index: number) => risen(arrived(after, index));

  const found = $derived(setup.found !== null && agentFound(setup.found));
  const doubt = $derived(unsure(setup.found, setup.error));
  const demand = $derived(setup.found && doubt === null ? blocked(setup.found) : null);
  /** Before the first answer the opening decides; after it, the checks. */
  const missing = $derived(setup.found === null && setup.error === null ? again : demand !== null);

  onMount(() => {
    void checkSetup();
    if (!Number.isFinite(elapsed)) return;
    const start = performance.now();
    const end = welcomeEnds(PIECES);
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      if (t >= end) {
        elapsed = Infinity;
        return;
      }
      elapsed = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<svelte:head><title>Welcome to Chord</title></svelte:head>

<div class="window no-select" class:mac data-testid="welcome">
  {#if mac}<div class="strip" data-tauri-drag-region></div>{/if}
  <div class="welcome" bind:clientWidth={width} bind:clientHeight={height}>
    <div class="scroll">
      <div class="inner">
        <div class="slot"></div>
        <h1 style={piece(0)}>{missing ? "Chord needs an agent" : "Welcome to Chord"}</h1>
        <p class="lede" style={piece(1)}>Here is what Chord found on this machine.</p>
        <SetupChecks arrived={[arrived(after, 2), arrived(after, 3)]} />
        <div class="mark" style={mark}><BladeMark {frame} /></div>
      </div>
    </div>
    <div class="footbar">
      <div class="foot" style={piece(4)}>
        {#if demand}
          <p class="must" role="status">{demand}</p>
        {:else if doubt}
          <p class="must" role="status" data-testid="welcome-unsure">{doubt}</p>
        {:else if found}
          <p>Kept in Settings, under Setup.</p>
        {:else}
          <p></p>
        {/if}
        <div class="btns">
          <button
            type="button"
            class="btn"
            class:pri={!found && !doubt}
            disabled={setup.busy}
            onclick={() => void checkSetup(true)}
          >
            {#if setup.busy}
              <svg class="spin" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5.8" />
                <path d="M8 2.2a5.8 5.8 0 0 1 5.8 5.8" />
              </svg>
              Checking
            {:else}
              Check again
            {/if}
          </button>
          {#if found || doubt}
            <button type="button" class="btn pri" onclick={() => void core().welcomeContinue(!reduced())}
              >Continue</button
            >
          {/if}
        </div>
      </div>
    </div>
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

  .welcome {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .inner {
    position: relative;
    min-height: 100%;
    padding: 8px 20px 4px;
  }

  .slot {
    height: 44px;
  }

  .mark {
    position: absolute;
    left: 0;
    top: 0;
    width: 44px;
    height: 44px;
    pointer-events: none;
    will-change: transform, width, height;
  }

  h1 {
    margin: 10px 0 2px;
    text-align: center;
    font-size: var(--h1-size);
    font-weight: var(--h1-weight);
    letter-spacing: var(--h1-track);
    line-height: 1.25;
  }

  .lede {
    margin: 0 0 12px;
    text-align: center;
    color: var(--ink-2);
    font-size: var(--row-size);
  }

  .footbar {
    flex: none;
    padding: 8px 20px 16px;
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 14px;
    min-height: 30px;
  }

  .foot p {
    margin: 0;
    flex: 1 1 0;
    min-width: 0;
    color: var(--ground-quiet);
    font-size: var(--meta-size);
    line-height: 1.35;
  }

  .foot p.must {
    color: var(--ink);
  }

  .btns {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 13px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    cursor: pointer;
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    font-family: var(--chrome);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    white-space: nowrap;
    text-transform: var(--label-case);
    letter-spacing: var(--label-track);
  }

  .btn:hover {
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }

  .btn.pri {
    background: var(--accent);
    color: var(--surface);
    box-shadow: none;
  }

  .btn.pri:hover {
    background: color-mix(in srgb, var(--accent) 90%, var(--ink));
  }

  .btn:focus-visible {
    outline-offset: 2px;
  }

  .btn[disabled] {
    opacity: 0.6;
    cursor: default;
  }

  .spin {
    width: 13px;
    height: 13px;
    fill: none;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .spin circle {
    stroke: color-mix(in srgb, currentColor 25%, transparent);
  }

  .spin path {
    stroke: currentColor;
    transform-origin: 8px 8px;
    animation: spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .spin path {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
