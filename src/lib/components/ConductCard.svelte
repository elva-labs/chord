<script lang="ts">
  import type { Snippet } from "svelte";
  import { installed } from "$lib/harness.svelte";
  import { agentByKey, allAgents } from "$lib/agents.svelte";
  import {
    accountWords,
    answerConduct,
    pickForPlugin,
    pluginPickOf,
    roleForPlugin,
    roundQuestion,
    type Ask,
    type Choice,
  } from "$lib/conductor.svelte";
  import type { HarnessId } from "$lib/core";
  import { HARNESS_LABELS, modelFromKey, modelKey, offeredHarnesses, offeredModels } from "$lib/models";
  import { kindFor } from "$lib/sessionKind.svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import AskChoices, { type AskChoice } from "$lib/components/AskChoices.svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";
  import Icon from "$lib/components/conversation/Icon.svelte";

  /**
   * A session's question to the user: to start a session, or to let a
   * review run a round past what its workflow gives a piece. The same card
   * in the asking session's dock and over the window. The first answer
   * remembers nothing; one that stands from now on is never first. A
   * plugin's start offers this one session or none, and picks the agent it
   * works as and the harness and model it runs on.
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
    if (ask.plugin !== undefined) return "Starts nothing. The plugin hears nothing back.";
    return `Starts nothing, and ${who} is told you did not allow it.`;
  });

  /** What a plugin's start runs on, as picked on the card. */
  let pick = $derived(ask.plugin === undefined ? null : pluginPickOf(ask));
  let harnesses = $derived(pick === null ? [] : offeredHarnesses(installed(), [pick.agent]));

  /** The models offered for a harness: its own default first, where the
      list does not hold it, then those it offers, then the one picked
      when the list does not hold it either. */
  function modelsFor(harness: HarnessId) {
    const offered = offeredModels(harness);
    const own = offered.some((option) => option.model === "default")
      ? []
      : [{ agent: harness, model: "default", label: "Default" }];
    const listed = [...own, ...offered];
    const held =
      pick !== null && pick.agent === harness && !listed.some((option) => option.model === pick!.model)
        ? [{ agent: harness, model: pick.model, label: pick.model }]
        : [];
    return [...listed, ...held];
  }

  /** The agents a plugin's start may work as, in the order menus list them. */
  let roles = $derived(pick === null ? [] : allAgents(ask.project));
  /** A terminal is never told an agent's description. */
  let roleless = $derived(pick !== null && kindFor(pick.agent) === "terminal");
  /** Whether the picked agent starts the session reading only. */
  let readsOnly = $derived(
    pick !== null && !roleless && agentByKey(pick.role, ask.project)?.readsOnly === true,
  );

  function pickedRole(event: Event) {
    const key = (event.currentTarget as HTMLSelectElement).value;
    roleForPlugin(ask, key === "" ? null : key);
  }

  function picked(event: Event) {
    const chosen = modelFromKey((event.currentTarget as HTMLSelectElement).value);
    if (chosen !== null) pickForPlugin(ask, chosen);
  }

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
           workbench cannot tell which session makes it, so each start it asks
           for is asked about. --><span data-testid="conduct-outside"
        >It runs in <Plain text={ask.outside} /> and does not say which session it is: Claude Code or Codex run outside the
        workbench, or a session that left its name out. Each new session it asks for is put to you.</span
      >{:else}{@render where()}{/if}
  {/snippet}
  {#if ask.round === null && ask.outside !== null}
    {#if saysWhere || ask.worktree || ask.named !== null}<p class="where">{@render where()}</p>{/if}
  {/if}
  {#if pick !== null}
    <div class="runs">
      <label>
        <span>As</span>
        <select
          value={roleless ? "" : (pick.role ?? "")}
          onchange={pickedRole}
          disabled={roleless}
          title={roleless ? "A session in a terminal works as no agent" : undefined}
          class="as"
          data-testid="conduct-agent"
        >
          <option value="">No agent</option>
          {#each roles as role (role.key)}
            <option value={role.key}>{role.title}</option>
          {/each}
        </select>
        {#if readsOnly}<span class="lock" title="Reads only" data-testid="conduct-agent-lock"
            ><Icon name="lock" size={11} /></span
          >{/if}
      </label>
      <label>
        <span>Runs on</span>
        <select value={modelKey(pick)} onchange={picked} data-testid="conduct-model">
          {#each harnesses as harness (harness)}
            <optgroup label={HARNESS_LABELS[harness]}>
              {#each modelsFor(harness) as option (option.model)}
                <option value={modelKey(option)}>{option.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </label>
    </div>
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

  .runs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    margin-left: var(--indent);
  }

  .runs label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .runs select {
    box-sizing: border-box;
    height: 24px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  /* A native select is as wide as its widest option: the agent's is held
     to a width of its own, so a long title anywhere in the list is cut
     short rather than widening the card. */
  .runs .as {
    min-width: 0;
    max-width: 14em;
    text-overflow: ellipsis;
  }

  .lock {
    display: flex;
    margin-left: -2px;
    color: var(--ink-3);
  }

  .runs select:disabled {
    color: var(--ink-3);
  }
</style>
