<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import Plain from "$lib/components/conversation/Plain.svelte";

  /**
   * One ask, drawn the one way every ask is: who wants what on a line of
   * its own, one line of fact under it, the thing itself in a block, and
   * the answers. An ask an agent makes carries the accent ring; an offer
   * the app makes, such as turning something on, has none; a sheet is an
   * ask the whole window waits on, centred over it.
   */
  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
    variant?: "ask" | "offer" | "sheet";
    /** Who wants what. */
    what: Snippet;
    whatId?: string;
    /** Beside who wants what: how many more wait, the way to the asker. */
    aside?: Snippet;
    /** One line of fact. */
    fact?: Snippet;
    factId?: string;
    /** The thing itself: a prompt, a change, a command. */
    thing?: Snippet;
    /** The thing is code, drawn in the code font. */
    code?: boolean;
    thingTestid?: string;
    /** More of the ask, between the thing and the answers. */
    children?: Snippet;
    /** The answers. */
    actions?: Snippet;
    /** What the pointed answer does, under the answers. */
    means?: Snippet;
    meansId?: string;
    error?: string | null;
    element?: HTMLDivElement | null;
  }

  let {
    variant = "ask",
    what,
    whatId,
    aside,
    fact,
    factId,
    thing,
    code = false,
    thingTestid,
    children,
    actions,
    means,
    meansId,
    error = null,
    element = $bindable(null),
    class: extra = "",
    ...rest
  }: Props = $props();
</script>

<div class="ask-card {variant} {extra}" bind:this={element} {...rest}>
  <div class="what">
    {#if variant === "ask"}<span class="ring"></span>{/if}
    <p id={whatId}>{@render what()}</p>
    {@render aside?.()}
  </div>
  {#if fact}<p class="fact" id={factId}>{@render fact()}</p>{/if}
  {#if thing}<div class="thing" class:code data-testid={thingTestid}>{@render thing()}</div>{/if}
  {@render children?.()}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if means}<p class="means" id={meansId} data-testid="choice-means">{@render means()}</p>{/if}
  {#if error !== null}<p class="error" data-testid="dock-error"><Plain text={error} /></p>{/if}
</div>

<style>
  .ask-card {
    --indent: calc(var(--ask-dot) + 9px);
    --ask-dot: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border-radius: calc(var(--radius) + 5px);
    background: var(--ask-surface, var(--surface));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--rule));
    font-family: var(--chrome);
    font-size: var(--ask-size, 12.5px);
    line-height: 1.5;
    color: var(--ink-2);
    text-align: left;
  }

  .ask-card.offer {
    --indent: 0px;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
  }

  .ask-card.sheet {
    --indent: 0px;
    padding: 18px 18px 16px;
    box-shadow:
      0 0 0 1px var(--rule),
      0 22px 50px -24px rgb(0 0 0 / 0.55);
  }

  .what,
  .fact,
  .thing,
  .actions,
  .means,
  .error {
    flex: none;
  }

  p {
    margin: 0;
  }

  .what {
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
    font-size: var(--ask-what-size, 13px);
    color: var(--ink);
  }

  .what p {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .what :global(b) {
    color: var(--ink);
    font-weight: 600;
  }

  .ring {
    flex: none;
    align-self: flex-start;
    margin-top: calc((1lh - var(--ask-dot)) / 2);
    width: var(--ask-dot);
    height: var(--ask-dot);
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.75px var(--accent);
  }

  .fact {
    margin: -4px 0 0 var(--indent);
    overflow-wrap: anywhere;
  }

  /* The thing asked about is never cut: a long one scrolls inside its
     block, so all of it can be read before it is answered. */
  .thing {
    margin-left: var(--indent);
    max-height: 9lh;
    overflow: auto;
    padding: 7px 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .thing.code {
    font-family: var(--mono);
    font-size: var(--ask-fine, 12px);
  }

  .actions,
  .means,
  .error {
    margin-left: var(--indent);
  }

  .means {
    margin-top: -2px;
    font-size: var(--ask-fine, 12px);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .error {
    font-size: var(--ask-fine, 12px);
    color: var(--del);
  }
</style>
