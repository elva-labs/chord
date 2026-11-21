<script lang="ts" module>
  /** One answer an ask offers. */
  export interface AskChoice {
    /** Names the choice to the keyboard code, as its data-choice. */
    id: string;
    label: string;
    testid: string;
    /** The digit that picks it, shown on it; none for a choice the digits
        do not reach. */
    key?: number | null;
    /** Drawn filled: the yes, first. */
    primary?: boolean;
    /** Drawn without a border: the way out. */
    quiet?: boolean;
    /** Kept behind More until the user opens it. */
    more?: boolean;
    title?: string;
    /** Takes no click at all, such as an answer not yet given. */
    disabled?: boolean;
    run: () => void;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";

  /**
   * The answers of an ask, in a row: one stop for the keyboard, the arrows
   * and Home and End moving between them, and a digit picking the one it
   * is shown on. The first is the yes. Those behind More stay out of
   * sight until it is opened, and a digit of one of them opens More and
   * puts the keyboard on it without answering, so a key pressed out of
   * habit never answers with a choice the user has not seen. While the ask
   * takes no answer the buttons say so without being disabled, so the
   * keyboard stays on them.
   */
  interface Props {
    choices: AskChoice[];
    /** Whether the ask takes an answer now. */
    armed?: boolean;
    /** The line that says what the pointed choice does. */
    describedby?: string;
    /** The choice the keyboard or the pointer is on, by its id. */
    pointed?: string | null;
    /** The row's name, for those who hear it. */
    label?: string;
  }

  let { choices, armed = true, describedby, pointed = $bindable(null), label }: Props = $props();

  let row = $state<HTMLDivElement | null>(null);
  let open = $state(false);

  let shown = $derived(choices.filter((each) => !each.more));
  let behind = $derived(choices.filter((each) => each.more));
  /** The one the Tab key lands on. */
  let stop = $derived(
    [...shown, ...(open ? behind : [])].some((each) => each.id === pointed) ? pointed : (shown[0]?.id ?? null),
  );

  function pick(choice: AskChoice) {
    if (!armed || choice.disabled) return;
    choice.run();
  }

  async function reveal(at: string | null) {
    open = true;
    await tick();
    const target = at ?? behind[0]?.id ?? null;
    if (target === null) return;
    pointed = target;
    row?.querySelector<HTMLButtonElement>(`[data-choice="${CSS.escape(target)}"]`)?.focus();
  }

  function onKey(e: KeyboardEvent) {
    const buttons = [...(row?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const choice = choices.find((each) => each.key === Number(e.key));
      if (choice === undefined) return;
      e.preventDefault();
      if (choice.more && !open) void reveal(choice.id);
      else pick(choice);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const button = buttons[next];
    if (button === undefined) return;
    pointed = button.dataset.choice ?? null;
    button.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="choices" bind:this={row} role={label === undefined ? undefined : "group"} aria-label={label} onkeydown={onKey}>
  {#each shown as choice (choice.id)}{@render button(choice)}{/each}
  {#if behind.length > 0 && !open}
    <button
      type="button"
      class="choice quiet"
      tabindex={stop === "more" ? 0 : -1}
      aria-expanded="false"
      data-choice="more"
      data-testid="choice-more"
      onclick={() => void reveal(null)}
      onfocus={() => (pointed = "more")}
      onpointerenter={() => (pointed = "more")}>More</button
    >
  {/if}
  {#if open}{#each behind as choice (choice.id)}{@render button(choice)}{/each}{/if}
</div>

{#snippet button(choice: AskChoice)}
  <button
    type="button"
    class="choice"
    class:primary={choice.primary}
    class:quiet={choice.quiet}
    class:keyed={choice.key != null}
    tabindex={choice.id === stop ? 0 : -1}
    disabled={choice.disabled}
    aria-disabled={armed ? undefined : "true"}
    aria-describedby={describedby}
    aria-keyshortcuts={choice.key == null ? undefined : String(choice.key)}
    title={choice.title}
    data-choice={choice.id}
    data-testid={choice.testid}
    onclick={() => pick(choice)}
    onfocus={() => (pointed = choice.id)}
    onpointerenter={() => (pointed = choice.id)}
    >{#if choice.key != null}<span class="key">{choice.key}</span>{/if}<span class="label"
      >{choice.label}</span
    ></button
  >
{/snippet}

<style>
  .choices {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .choice {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    height: 28px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font: inherit;
    font-family: var(--chrome);
    font-size: var(--ask-size, 12.5px);
    font-weight: 500;
    letter-spacing: normal;
    text-transform: none;
    color: var(--ink);
    white-space: nowrap;
    cursor: pointer;
  }

  .choice.keyed {
    padding-left: 7px;
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .choice:hover:not([aria-disabled="true"], :disabled) {
    background: var(--surface-2);
  }

  .choice.primary {
    background: var(--accent);
    box-shadow: none;
    color: var(--surface);
  }

  .choice.primary:hover:not([aria-disabled="true"], :disabled) {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  }

  .choice.quiet {
    box-shadow: none;
    color: var(--ink-2);
  }

  .choice.quiet:hover:not([aria-disabled="true"], :disabled) {
    color: var(--ink);
  }

  .choice:active:not(:disabled, [aria-disabled="true"]) {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--ink-3);
  }

  .choice.primary:active:not(:disabled, [aria-disabled="true"]) {
    background: color-mix(in srgb, var(--accent) 78%, var(--ink));
  }

  .choice.primary:focus-visible {
    outline-offset: 2px;
  }

  /* An ask that takes no answer yet, settling in or with an answer on its
     way, says so by its buttons fading. One that takes an answer shows
     them whole at once, so no button that answers is ever drawn faint. */
  .choice[aria-disabled="true"],
  .choice:disabled {
    opacity: 0.5;
    cursor: default;
    transition: opacity 0.2s;
  }

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

  @media (prefers-reduced-motion: reduce) {
    .choice[aria-disabled="true"],
    .choice:disabled {
      transition: none;
    }
  }
</style>
