<script lang="ts">
  import {
    autoResume,
    chooseHere,
    continueAfterLimit,
    followed,
    offered,
    resumesAt,
  } from "$lib/autoResume.svelte";
  import type { Conversation } from "$lib/conversation.svelte";
  import { clock, resetWhen } from "$lib/limits.svelte";
  import { byKey } from "$lib/sessions.svelte";

  /**
   * The usage limit refused the conversation's last turn: a calm line over
   * the composer that says so and when it resets, until another turn
   * begins. Where the conversation can go on by itself, its one button
   * turns that on for this conversation alone and waits for this turn;
   * while it waits, the line says when it goes on and the button cancels,
   * for this conversation alone too. The choice a new conversation takes
   * is left as it was. It never takes the keyboard.
   */
  interface Props {
    sessionKey: string;
    conversation: Conversation;
  }

  let { sessionKey, conversation }: Props = $props();

  let stopped = $derived(conversation.stoppedAt);
  let row = $derived(byKey(sessionKey));
  /** When the limit resets, in milliseconds, where the agent said. */
  let resets = $derived(stopped?.resetsAt == null ? null : stopped.resetsAt * 1000);
  /** The wait for this turn, while the conversation waits to go on. */
  let waiting = $derived(resumesAt(row) !== null);
  /** Whether the conversation's own choice says, here, whether it goes on:
      a session another started goes by that one's. */
  let own = $derived(row !== null && offered(row) && followed(row) === null);

  let now = $state(Date.now());
  $effect(() => {
    if (stopped === null) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 20_000);
    return () => clearInterval(timer);
  });

  let ahead = $derived(resets !== null && resets > now);
  /** It can still be waited for from here. */
  let waitable = $derived(
    own && stopped?.window === "session" && ahead && autoResume.limited[sessionKey] !== undefined,
  );

  let line = $derived.by(() => {
    if (resets === null) return "Usage limit reached.";
    if (waiting) return ahead ? `Continues ${resetWhen(resets, now)}, when the limit resets.` : "Continues now that the limit has reset.";
    return ahead ? `Usage limit reached. Resets ${resetWhen(resets, now)}.` : `Usage limit reached. It reset at ${clock(resets)}.`;
  });

  /** What is said aloud as it comes and as it changes, without the
      minutes ticking down. It is put in the live line just after the
      notice is drawn, so it is heard rather than found already there. */
  let spoken = $derived.by(() => {
    if (stopped === null) return "";
    if (resets === null) return "Usage limit reached.";
    if (waiting) return `Continues at ${clock(resets)}, when the usage limit resets.`;
    return ahead ? `Usage limit reached. Resets at ${clock(resets)}.` : `Usage limit reached. It reset at ${clock(resets)}.`;
  });
  let heard = $state("");
  $effect(() => {
    const text = spoken;
    const later = setTimeout(() => (heard = text));
    return () => clearTimeout(later);
  });
</script>

{#if stopped !== null}
  <div class="limit" data-testid="usage-limit-notice">
    <p class="line" data-testid="usage-limit-line">{line}</p>
    {#if waiting && own}
      <button class="quiet" type="button" onclick={() => chooseHere(sessionKey, false)} data-testid="usage-limit-cancel">Cancel</button>
    {:else if !waiting && waitable}
      <button
        class="primary"
        type="button"
        onclick={() => continueAfterLimit(sessionKey)}
        title="Turns auto-resume on for this conversation: it goes on by itself, from its notes, when the limit resets."
        data-testid="usage-limit-continue">Continue when it resets</button
      >
    {/if}
    <p class="told" aria-live="polite">{heard}</p>
  </div>
{/if}

<style>
  /* Drawn as the asks are drawn over the composer, but calm: no ring, no
     rule, the conversation's second surface. */
  .limit {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 8px;
    padding: 10px 12px 10px 14px;
    border-radius: calc(var(--radius) + 5px);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--conv-small);
    line-height: 1.5;
    color: var(--ink);
  }

  .line {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  button {
    flex: none;
    height: 28px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius);
    font: inherit;
    font-weight: 500;
    letter-spacing: normal;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
  }

  .primary {
    background: var(--accent);
    color: var(--surface);
  }

  .primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  }

  .primary:active {
    background: color-mix(in srgb, var(--accent) 78%, var(--ink));
  }

  .primary:focus-visible {
    outline-offset: 2px;
  }

  .quiet {
    background: none;
    color: var(--ink-2);
  }

  .quiet:hover {
    color: var(--ink);
  }

  .told {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
