<script lang="ts">
  import type { Snippet } from "svelte";
  import { accountWords, answerConduct, roundQuestion, type Ask, type Choice } from "$lib/conductor.svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import AskChoices, { type AskChoice } from "$lib/components/AskChoices.svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";

  /**
   * A session's question to the user: to start a session, or to let a
   * review run a round past what its workflow gives a piece. The same card
   * in the asking session's dock and over the window. The first answer
   * remembers nothing; one that stands from now on is never first.
   */
  interface Props {
    ask: Ask;
    /** Who asks, as the card names it. */
    who: string;
    /** Whether the card takes an answer now. */
    armed: boolean;
    /** Names the card's parts apart from any other on screen. */
    id: string;
    /** Called once the answer is given. */
    onAnswered?: () => void;
    aside?: Snippet;
    element?: HTMLDivElement | null;
    class?: string;
    role?: "group" | "alertdialog";
    testid: string;
  }

  let {
    ask,
    who,
    armed,
    id,
    onAnswered,
    aside,
    element = $bindable(null),
    class: extra = "",
    role = "group",
    testid,
  }: Props = $props();

  let pointed = $state<string | null>(null);

  function run(choice: Choice) {
    if (!armed) return;
    if (answerConduct(ask, choice)) onAnswered?.();
  }

  let choices = $derived<AskChoice[]>(
    ask.round !== null
      ? [
          { id: "round-allow", label: "Allow one more", testid: "conduct-allow-round", key: 1, primary: true, run: () => run("once") },
          { id: "round-stop", label: "Stop here", testid: "conduct-no", key: 2, run: () => run("no") },
        ]
      : [
          { id: "once", label: "Allow once", testid: "conduct-once", key: 1, primary: true, run: () => run("once") },
          ...(ask.once
            ? []
            : [{ id: "allow", label: "Allow its starts in this project", testid: "conduct-allow", key: 2, run: () => run("allow") }]),
          { id: "no", label: "Don't allow", testid: "conduct-no", key: ask.once ? 2 : 3, run: () => run("no") },
        ],
  );

  /** What the pointed answer does. */
  let said = $derived.by(() => {
    const at = choices.find((each) => each.id === pointed)?.id ?? choices[0].id;
    if (at === "round-allow") return "Starts this one round. A round after it is asked about again.";
    if (at === "round-stop") return `Refuses the start, and ${who} is told to ask you how to go on.`;
    if (at === "once") return "Starts this one session. The next one is asked about again.";
    if (at === "allow") return `Starts it, and ${who} starts sessions in this project without asking from now on.`;
    return `Starts nothing, and ${who} is told you did not allow it.`;
  });

  /** The folder the session would run in, unless the line above says it. */
  let saysWhere = $derived(ask.round !== null || ask.outside !== ask.project);
</script>

<AskCard
  bind:element
  class={extra}
  {role}
  aria-labelledby="{id}-what"
  aria-describedby="{id}-fact"
  whatId="{id}-what"
  factId="{id}-fact"
  meansId="{id}-means"
  thing={ask.prompt === "" ? undefined : prompt}
  thingTestid="conduct-prompt"
  {aside}
  data-testid={testid}
>
  {#snippet what()}
    {#if ask.round !== null}<b><Plain text={who} /></b> wants another round of <Plain
        text={ask.round.step}
      />{:else}<b><Plain text={who} /></b> wants to start a session{/if}
  {/snippet}
  {#snippet fact()}
    {#if ask.round !== null}{#if saysWhere || ask.worktree || ask.named !== null}{@render where()}{" "}{/if}<span
        data-testid="conduct-round"><Plain text={roundQuestion(ask.round)} /></span
      >{:else if ask.outside !== null}<!-- A call that names no session: the
           workbench cannot tell which agent makes it, so each start it asks
           for is asked about. --><span data-testid="conduct-outside"
        >It runs in <Plain text={ask.outside} /> and does not say which session it is: an agent run outside the
        workbench, or a session that left its name out. Each new session it asks for is put to you.</span
      >{:else}{@render where()}{/if}
  {/snippet}
  {#if ask.round === null && ask.outside !== null}
    {#if saysWhere || ask.worktree || ask.named !== null}<p class="where">{@render where()}</p>{/if}
  {/if}
  {#snippet actions()}
    <AskChoices {choices} {armed} bind:pointed describedby="{id}-means" />
  {/snippet}
  {#snippet means()}<Plain text={said} />{/snippet}
</AskCard>

{#snippet where()}{#if saysWhere}In <Plain text={ask.project} />{ask.worktree ? ", in a worktree of its own" : ""}.{:else if ask.worktree}In
    a worktree of its own.{/if}{#if ask.named !== null}{" "}<span data-testid="conduct-account">{accountWords(ask.named)}</span
    >{/if}{/snippet}

{#snippet prompt()}<Plain text={ask.prompt} />{/snippet}

<style>
  .where {
    margin: -4px 0 0 var(--indent);
    overflow-wrap: anywhere;
  }
</style>
