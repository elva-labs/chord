<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { Choice } from "$lib/settingChoices";
  import Icon from "./conversation/Icon.svelte";
  import Plain from "./conversation/Plain.svelte";

  /**
   * A small menu of one setting's choices, each with its name, a line on
   * what it does where there is one, and a tick on the one in use: the
   * model, the mode or the effort of an integrated session, wherever it is
   * offered. It opens with the keyboard on the choice in use, and is walked
   * with the arrows, Home and End; Enter picks, and Escape or Tab puts it
   * away, with the owner saying where the keyboard goes then. The choice
   * under the pointer takes the keyboard, so the pointer and the keyboard
   * are one mark. The keyboard going anywhere outside what holds the menu,
   * by a chord or a press, puts it away and leaves the keyboard there.
   *
   * A choice that cannot be taken here is walked to like the others and
   * says why in its line, but picking it does nothing.
   *
   * A long list can show only its first few, the one in use among them,
   * with a line on how many more there are; with `filter`, typing narrows
   * the whole list to the names that hold what is typed, Backspace widens
   * it again, and Escape clears it before it puts the menu away. Actions
   * after the choices, under a rule, stay whatever is typed.
   *
   * It opens above what holds it, or with `below` under it, from its left edge or with `end` from
   * its right, or at a place the owner gives, where what holds it cuts off
   * what overflows it. Opened from the right edge it moves as far as it
   * takes to stay inside the box the owner names, as when what holds it
   * has wrapped to the left of a narrow row. It is never taller than the
   * room between what holds it and the window's edge it opens toward; a
   * list longer than that scrolls inside it, with the choice the keyboard
   * is on kept in view.
   */
  interface Props {
    label: string;
    /** A heading over the choices, where the menu shows one. */
    heading?: string | null;
    choices: Choice[];
    /** A line under the choices. */
    note?: string | null;
    onpick: (value: string) => void;
    /** Escape or Tab put it away, or the keyboard went elsewhere. */
    onclose: (how: "escape" | "tab" | "away") => void;
    /** Where it stands in the window, by its left edge and its foot. */
    at?: { left: number; bottom: number } | null;
    /** It opens from the right edge of what holds it, for a holder near
        the right of a row. */
    end?: boolean;
    /** It opens under what holds it, as in a page that scrolls. */
    below?: boolean;
    /** What it stays inside when it opens from the right edge. */
    within?: HTMLElement | null;
    /** Opened with the pointer: the choice the keyboard is on is marked
        only while the pointer is on it or once a key is pressed, so a
        menu opened by a press marks nothing until the pointer or a key
        says where. */
    pointer?: boolean;
    /** The entries are actions, not choices with one in use. */
    actions?: boolean;
    /** Typing narrows the choices by name. */
    filter?: boolean;
    /** The most choices shown before typing narrows them. */
    most?: number | null;
    /** Actions under a rule after the choices, picked through `onpick`. */
    extra?: Choice[];
    testid: string;
    optionTestid: string;
  }

  let {
    label,
    heading = null,
    choices,
    note = null,
    onpick,
    onclose,
    at = null,
    end = false,
    below = false,
    within = null,
    pointer = false,
    actions = false,
    filter = false,
    most = null,
    extra = [],
    testid,
    optionTestid,
  }: Props = $props();

  let menu = $state<HTMLDivElement | null>(null);
  let pointing = $state(untrack(() => pointer));

  /** What is typed to narrow the choices. */
  let query = $state("");
  let matching = $derived.by(() => {
    const words = query.trim().toLowerCase();
    return words === "" ? choices : choices.filter((choice) => choice.name.toLowerCase().includes(words));
  });
  /** The choices on screen: the first few until something is typed, with
      the one in use kept among them. The parts of the list under their own
      headings always show whole, after them. */
  let shown = $derived.by(() => {
    const split = choices.findIndex((choice) => choice.section !== undefined);
    const head = split === -1 ? choices : choices.slice(0, split);
    const parts = split === -1 ? [] : choices.slice(split);
    if (query !== "" || most === null || head.length <= most) return matching;
    const first = head.slice(0, most);
    const using = head.find((choice) => choice.on);
    if (using === undefined || first.includes(using)) return [...first, ...parts];
    return [...first.slice(0, most - 1), using, ...parts];
  });
  let left = $derived(choices.length - shown.length);
  let said = $derived(
    query === "" ? (left > 0 ? `${left} more` : null) : matching.length === 0 ? `Nothing matches "${query}"` : `Matching "${query}"`,
  );

  /** Narrows the choices to what is typed, with the keyboard on the first
      left, or on the menu where none is. */
  async function narrow(next: string) {
    query = next;
    await tick();
    (items()[0] ?? menu)?.focus();
  }

  function items(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']") ?? [])];
  }

  /** Opened from the right edge, where its left edge stands from what
      holds it, once measured. */
  let shift = $state<number | null>(null);

  /** Puts it at the right edge of what holds it, or as near as it can be
      while inside `within`. */
  function place() {
    if (!end || menu === null) return;
    const holder = menu.parentElement?.getBoundingClientRect();
    if (holder === undefined) return;
    const width = menu.offsetWidth;
    const room = (within ?? document.documentElement).getBoundingClientRect();
    const left = Math.max(room.left, Math.min(holder.right - width, room.right - width));
    shift = left - holder.left;
  }

  /** How tall it may be, once measured. */
  let room = $state<number | null>(null);

  /** Measures the room between what holds it and the window's edge it
      opens toward, leaving a little to spare. */
  function fit() {
    if (menu === null) return;
    const spare = 8;
    if (at !== null) {
      room = window.innerHeight - at.bottom - spare;
      return;
    }
    const holder = menu.parentElement?.getBoundingClientRect();
    if (holder === undefined) return;
    room = below ? window.innerHeight - holder.bottom - 6 - spare : holder.top - 6 - spare;
  }

  onMount(() => {
    place();
    fit();
    void tick().then(() => {
      (menu?.querySelector<HTMLButtonElement>("[aria-checked='true']") ?? items()[0])?.focus();
    });
  });

  $effect(() => {
    const resized = () => {
      place();
      fit();
    };
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  });

  function onkeydown(e: KeyboardEvent) {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    // Where nothing is marked, the first arrow marks the choice the
    // keyboard is on rather than moving past it unseen.
    const unmarked = pointing && !(all[index]?.matches(":hover") ?? false);
    pointing = false;
    if (filter && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const typed = e.key.length === 1 && (e.key !== " " || query !== "");
      if (typed || (e.key === "Backspace" && query !== "")) {
        e.preventDefault();
        void narrow(typed ? query + e.key : query.slice(0, -1));
        return;
      }
      if (e.key === "Escape" && query !== "") {
        e.preventDefault();
        e.stopPropagation();
        void narrow("");
        return;
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (unmarked && index >= 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      all[(index + step + all.length) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose("escape");
    } else if (e.key === "Tab") {
      onclose("tab");
    }
  }

  function onpointermove(e: PointerEvent) {
    pointing = true;
    const choice = (e.target as Element | null)?.closest<HTMLButtonElement>("[role^='menuitem']");
    if (choice != null && choice !== document.activeElement) choice.focus({ preventScroll: true });
  }

  function onfocusout(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    const holder = menu?.parentElement ?? menu;
    if (next !== null && holder !== null && !holder.contains(next)) onclose("away");
  }
</script>

{#snippet entry(choice: Choice, action: boolean)}
  <button
    role={action ? "menuitem" : "menuitemradio"}
    aria-checked={action ? undefined : (choice.on ?? false)}
    aria-disabled={choice.off ? "true" : undefined}
    class:on={choice.on}
    class:off={choice.off}
    onclick={() => {
      if (!choice.off) onpick(choice.value);
    }}
    data-testid={optionTestid}
  >
    <span class="name" class:marked={choice.icon !== undefined || choice.lock}
      >{#if choice.icon !== undefined}<Icon name={choice.icon} size={13} />{/if}<Plain text={choice.name} />{#if choice.lock}<span
          class="lock"
          title="Reads only"
          data-testid="{optionTestid}-lock"><Icon name="lock" size={11} /></span
        >{/if}</span
    >
    {#if choice.about}<span class="about"><Plain text={choice.about} /></span>{/if}
    {#if choice.on}<span class="tick"><Icon name="check" size={12} /></span>{/if}
  </button>
{/snippet}

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  bind:this={menu}
  class="menu"
  data-card
  class:placed={at !== null}
  class:end
  class:below
  class:pointing
  {onpointermove}
  {onfocusout}
  style:left={at !== null ? `${at.left}px` : shift !== null ? `${shift}px` : undefined}
  style:right={shift !== null ? "auto" : undefined}
  style:bottom={at === null ? undefined : `${at.bottom}px`}
  style:max-height={room === null ? undefined : `${Math.max(room, 96)}px`}
  role="menu"
  tabindex="-1"
  aria-label={label}
  {onkeydown}
  data-testid={testid}
>
  {#if heading !== null}<p class="heading" data-testid="{testid}-heading">{heading}</p>{/if}
  {#each shown as choice, at (choice.value)}
    {@const starts = choice.section !== undefined && shown[at - 1]?.section !== choice.section}
    {#if choice.rule || starts}<div class="rule" role="separator" data-testid="{testid}-rule"></div>{/if}
    {#if starts}<p class="heading" data-testid="{testid}-section">{choice.section}</p>{/if}
    {@render entry(choice, actions)}
  {/each}
  {#if said !== null}
    <p class="menu-note" data-testid="{testid}-said">{said}</p>
  {/if}
  {#if extra.length > 0}
    <div class="rule"></div>
    {#each extra as choice (choice.value)}
      {@render entry(choice, true)}
    {/each}
  {/if}
  {#if note !== null}
    <p class="menu-note">{note}</p>
  {/if}
</div>

<style>
  .menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    min-width: 220px;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--paint-surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
    font-family: var(--chrome);
    white-space: normal;
    text-transform: none;
    letter-spacing: normal;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .menu > :global(*) {
    flex-shrink: 0;
  }

  .menu.below {
    top: calc(100% + 6px);
    bottom: auto;
  }

  .menu.placed {
    position: fixed;
    z-index: 30;
  }

  /* Wide enough for a line on each choice to sit on one line, and no
     wider than the conversation it opens over, whose width the view gives
     it, or the window where there is none. */
  .menu.end {
    left: auto;
    right: 0;
    width: min(330px, calc(var(--conv-width, 100vw) - 32px));
    max-width: none;
  }

  button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 16px;
    align-items: center;
    column-gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--row-size);
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }

  /* The one mark: the choice with the keyboard, which the pointer moves
     too. Opened by a press, it shows only while the pointer is on it,
     until a key is pressed. */
  button:focus {
    background: var(--accent-soft);
    color: var(--ink);
    outline: none;
  }

  .pointing button:focus:not(:hover) {
    background: none;
    color: var(--ink-2);
  }

  .on,
  .pointing .on:focus:not(:hover) {
    color: var(--ink);
  }

  .off,
  .off:focus,
  .pointing .off:focus:not(:hover) {
    color: var(--ink-3);
    cursor: default;
  }

  .off .about {
    color: var(--ink-3);
  }

  .name {
    grid-column: 1;
  }

  .name.marked {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .lock {
    display: flex;
    margin-left: auto;
    color: var(--ink-3);
  }

  .menu:focus {
    outline: none;
  }

  .about {
    grid-column: 1;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-2);
  }

  .tick {
    grid-column: 2;
    grid-row: 1;
    color: var(--accent);
  }

  .rule {
    height: 1px;
    margin: 4px 6px;
    background: var(--divider, var(--rule));
  }

  .heading {
    margin: 2px 8px 2px;
    font-size: calc(var(--meta-size) - 0.5px);
    font-weight: 600;
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .menu-note {
    margin: 4px 8px 2px;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-2);
  }
</style>
