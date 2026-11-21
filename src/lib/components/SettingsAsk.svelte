<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import AskChoices, { SETTLE, type AskChoice } from "$lib/components/AskChoices.svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { aboveFoot } from "$lib/aboveFoot.svelte";
  import { conductor } from "$lib/conductor.svelte";
  import { askDockedIn } from "$lib/docked.svelte";
  import { DEFAULTS, type CustomTheme } from "$lib/customThemes";
  import {
    allowChange,
    declineChange,
    dismissUndo,
    settingsAsk,
    undoChange,
    UNDO_FOR,
  } from "$lib/settingsTools.svelte";

  /**
   * An agent's ask to change the settings, in the place over the window
   * where the asks float, above the composer and dock of the session on
   * screen: what changes from what to what, and Allow or Don't allow. It
   * waits while a session's own ask to start a session or for a round
   * shows, docked or floating, so two asks never stand at once. It never
   * takes the keyboard, and takes no answer for a moment after it comes,
   * so a click or key meant for what was there before answers nothing.
   */

  let ask = $derived(conductor.asking !== null ? null : settingsAsk.asking);
  /** A session's own ask floats in the place the undo shows in. */
  let floating = $derived(conductor.asking !== null && askDockedIn() === null);
  let undo = $derived(settingsAsk.undo);

  let pointed = $state<string | null>(null);

  let armed = $state(false);
  let settling: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const now = ask;
    untrack(() => {
      if (settling !== null) clearTimeout(settling);
      settling = null;
      armed = false;
      pointed = null;
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

  const choices: AskChoice[] = [
    { id: "allow", label: "Allow", testid: "settings-allow", key: 1, primary: true, run: allowChange },
    { id: "decline", label: "Don't allow", testid: "settings-decline", key: 2, run: declineChange },
  ];

  /** A colour of a theme being saved, the default palette's where it sets none. */
  function tone(shown: CustomTheme, appearance: "light" | "dark", token: string): string {
    return shown[appearance][token] ?? DEFAULTS[appearance][token];
  }
</script>

{#if ask !== null}
  {#key ask}
    <div class="over" data-card use:coversBrowser use:aboveFoot>
      <AskCard
        class="floating"
        role="alertdialog"
        aria-labelledby="settings-ask-what"
        aria-describedby={ask.reason === null ? undefined : "settings-ask-fact"}
        whatId="settings-ask-what"
        factId="settings-ask-fact"
        meansId="settings-ask-means"
        fact={ask.reason === null ? undefined : reason}
        {thing}
        data-testid="settings-ask"
      >
        {#snippet what()}<b><Plain text={ask.caller} /></b> wants to change settings{/snippet}
        {#if ask.css !== null && ask.css.trim() !== ""}
          <pre class="css" data-testid="settings-ask-css">{ask.css}</pre>
        {/if}
        {#if ask.theme !== null}
          {@const shown = ask.theme}
          <div class="previews" data-testid="settings-ask-theme">
            {#each ["light", "dark"] as const as appearance (appearance)}
              <div
                class="preview"
                data-appearance={appearance}
                style:background={ask.ground?.[appearance] ?? tone(shown, appearance, "bg")}
                style:border-radius={shown.shape.radius ?? "var(--radius)"}
              >
                <div
                  class="card"
                  style:background={tone(shown, appearance, "surface")}
                  style:border-color={tone(shown, appearance, "rule")}
                  style:border-radius={shown.shape["radius-sm"] ?? "var(--radius-sm)"}
                >
                  <span class="bar" style:background={tone(shown, appearance, "accent")}></span>
                  <span class="ink" style:color={tone(shown, appearance, "ink")}
                    >{appearance === "light" ? "Light" : "Dark"}</span
                  >
                  <span class="ink-2" style:color={tone(shown, appearance, "ink-2")}>Aa</span>
                  <span class="add" style:color={tone(shown, appearance, "add")}>+2</span>
                  <span class="del" style:color={tone(shown, appearance, "del")}>−1</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
        {#snippet actions()}
          <AskChoices {choices} {armed} bind:pointed describedby="settings-ask-means" />
        {/snippet}
        {#snippet means()}{#if pointed === "decline"}Changes nothing, and <Plain text={ask.caller} /> is told you did not
            allow it.{:else}Makes the change now. It can be undone for {UNDO_FOR / 1000} seconds after.{/if}{/snippet}
      </AskCard>
    </div>
  {/key}
{/if}

{#snippet reason()}<span data-testid="settings-ask-reason">{ask?.reason}</span>{/snippet}

{#snippet thing()}
  <ul class="changes">
    {#each ask?.changes ?? [] as change (change.field)}
      <li data-testid="settings-ask-change" data-field={change.field}>
        <span class="name">{change.label}</span>
        <span class="from">{change.from}</span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="sr">to</span>
        <span class="to"><Plain text={change.to} /></span>
      </li>
    {/each}
  </ul>
{/snippet}

<!-- The asks and the undo share a place: an ask there hides the undo until
     it is answered. -->
{#if undo !== null && settingsAsk.asking === null && !floating}
  <div class="over undo-over" data-card use:coversBrowser use:aboveFoot>
    <div class="undo" role="status" data-testid="settings-undo">
      <span class="said">
        <Plain text={undo.caller} /> changed {undo.changes.length === 1
          ? undo.changes[0].label.toLowerCase()
          : "the settings"}
      </span>
      <button type="button" class="go" onclick={undoChange} data-testid="settings-undo-button">Undo</button>
      <button
        type="button"
        class="close"
        onclick={dismissUndo}
        aria-label="Keep the change"
        data-testid="settings-undo-close">×</button
      >
    </div>
  </div>
{/if}

<style>
  /* Over the window and a peeked sessions pane, standing above the
     composer and dock of the conversation on screen, the same place a
     session's own ask floats. The left, bottom and height here are where
     it starts. */
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

  /* Where the cards let a background through, the ask and the undo are
     laid over the card's paint so they still cover what is under them. */
  :global(:root[data-cards]) .over > :global(.ask-card.floating) {
    background: linear-gradient(var(--surface), var(--surface)), var(--paint-surface);
  }

  :global(:root[data-cards]) .undo {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  .changes {
    margin: 0;
    padding: 0;
    list-style: none;
    white-space: normal;
  }

  .changes li {
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  .name {
    min-width: 54px;
    color: var(--ink-2);
  }

  .from {
    color: var(--ink-2);
  }

  .arrow {
    color: var(--ink-3);
  }

  .to {
    color: var(--ink);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  /* The sheet as it would be written, to be read before it is allowed. */
  .css {
    flex: none;
    margin: 0 0 0 var(--indent);
    max-height: 220px;
    overflow: auto;
    padding: 7px 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: var(--ask-fine, 12px);
    line-height: 1.45;
    color: var(--ink);
    white-space: pre;
  }

  /* The theme as it would paint, one small card on its ground for each
     appearance, the ground carrying the background it keeps. */
  .previews {
    flex: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-left: var(--indent);
  }

  .preview {
    padding: 8px;
    border: 1px solid var(--rule);
  }

  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid;
    font-size: 12px;
  }

  .bar {
    width: 3px;
    height: 14px;
    border-radius: 1px;
  }

  .ink {
    font-weight: 600;
  }

  /* Where the question was, clear of the composer, for as long as the
     change can be undone. */
  .undo-over {
    width: auto;
    max-width: calc(100vw - 48px);
  }

  .undo {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 14px;
    border-radius: calc(var(--radius) + 5px);
    background: var(--surface-2);
    box-shadow:
      inset 0 0 0 1px var(--rule-strong),
      0 22px 50px -24px rgb(0 0 0 / 0.55);
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink);
  }

  .said {
    overflow-wrap: anywhere;
  }

  .undo button {
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
  }

  .go {
    height: 26px;
    padding: 0 11px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink);
    font-weight: 500;
  }

  .go:hover {
    background: var(--surface);
  }

  .close {
    padding: 0 4px;
    color: var(--ink-3);
    font-size: 15px;
    line-height: 1;
  }

  .close:hover {
    color: var(--ink);
  }
</style>
