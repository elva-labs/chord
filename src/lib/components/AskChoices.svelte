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

  /** How long an ask takes no answer after what it shows changed under the
      user: a new ask in place of another, or More opened. */
  export const SETTLE = 500;
</script>

<script lang="ts">
  import { onDestroy } from "svelte";

  /**
   * The answers of an ask, in a row: one stop for the keyboard, the arrows
   * and Home and End moving between them, and a digit picking the one it
   * is shown on. The first is the yes. Those behind More stay out of
   * sight until it is opened. A digit of one of them only opens More: the
   * keyboard stays where it was, and the row takes no answer for a moment
   * after, so a key pressed again, held down or followed by Enter answers
   * nothing the user has not had time to see. A held digit answers once at
   * most. While the ask takes no answer the buttons say so without being
   * disabled, so the keyboard stays on them.
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
    /** Whether More is open. */
    open?: boolean;
  }

  let { choices, armed = true, describedby, pointed = $bindable(null), label, open = $bindable(false) }: Props = $props();

  let row = $state<HTMLDivElement | null>(null);
  /** More was opened a moment ago, and the row takes no answer yet. */
  let settling = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  onDestroy(() => {
    if (timer !== null) clearTimeout(timer);
  });

  let takes = $derived(armed && !settling);

  let shown = $derived(choices.filter((each) => !each.more));
  let behind = $derived(choices.filter((each) => each.more));
  /** The one the Tab key lands on. */
  let stop = $derived(
    pointed === "more" && behind.length > 0
      ? "more"
      : [...shown, ...(open ? behind : [])].some((each) => each.id === pointed)
        ? pointed
        : (shown[0]?.id ?? null),
  );

  function pick(choice: AskChoice) {
    if (!takes || choice.disabled) return;
    choice.run();
  }

  /** Opens or closes More. The keyboard stays where it was; once opened,
      the row settles before it takes an answer. */
  function toggle() {
    open = !open;
    if (!open) {
      if (behind.some((each) => each.id === pointed)) pointed = "more";
      return;
    }
    settling = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      settling = false;
    }, SETTLE);
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
      if (e.repeat) return;
      if (choice.more && !open) toggle();
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
  {#if behind.length > 0}
    <button
      type="button"
      class="choice quiet more"
      tabindex={stop === "more" ? 0 : -1}
      aria-expanded={open}
      data-choice="more"
      data-testid="choice-more"
      onclick={toggle}
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
    aria-disabled={takes ? undefined : "true"}
    aria-describedby={describedby}
    aria-keyshortcuts={choice.key == null ? undefined : String(choice.key)}
    title={choice.title}
    data-choice={choice.id}
    data-testid={choice.testid}
    onclick={() => pick(choice)}
    onfocus={() => (pointed = choice.id)}
    onpointerenter={() => (pointed = choice.id)}
    >{#if choice.key != null}<span class="key" aria-hidden="true">{choice.key}</span>{/if}<span class="label"
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

  /* More open is drawn pressed, by the answers it shows. */
  .choice.more[aria-expanded="true"] {
    background: var(--surface-2);
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

  /* On the accent the key is set off toward the ink, which takes it further
     from the button's text rather than nearer. */
  .primary .key {
    background: color-mix(in srgb, var(--ink) 16%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    .choice[aria-disabled="true"],
    .choice:disabled {
      transition: none;
    }
  }
</style>
