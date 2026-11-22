<script lang="ts">
  /**
   * The Agents tab of the settings. The agents Chord ships and the user's
   * own stand in one list, each with its first line and a lock where it
   * only reads, ending in a row that makes a new one. Under it, the agents
   * installed for the active project's harnesses, a list for each place
   * they are read from, shown only when there are some.
   *
   * A row opens its agent in place of the lists. One of the user's own
   * opens to edit: its title, its description and, folded into one line,
   * what it runs on, kept on Save and left as it was on Cancel. The others
   * open to read.
   */
  import { tick } from "svelte";
  import type { HarnessId, InstalledAgent, OwnAgent } from "$lib/core";
  import Icon from "$lib/components/conversation/Icon.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import UnreadEntries from "$lib/components/UnreadEntries.svelte";
  import {
    type Agent,
    agentByKey,
    agentEfforts,
    agentFacts,
    agents,
    initials,
    installedAgents,
    loadInstalled,
    newAgent,
    ownAgents,
    removeAgent,
    saveAgent,
    shippedAgents,
  } from "$lib/agents.svelte";
  import { installed } from "$lib/harness.svelte";
  import { HARNESS_LABELS, modelFromKey, modelKey, modelLabel, offeredHarnesses, offeredModels } from "$lib/models";
  import { askCodexCatalog } from "$lib/modelCatalog.svelte";
  import { hostOf } from "$lib/remote.svelte";
  import { effortName } from "$lib/settingChoices";
  import { workspace } from "$lib/workspace.svelte";

  const project = $derived(workspace.active);

  // The installed agents are read again each time the tab opens, and for
  // each project made active while it is open.
  $effect(() => {
    if (project !== null) void loadInstalled(project);
  });

  /** The places installed agents are read from, in the order listed. */
  const SOURCES: { source: InstalledAgent["source"]; label: string }[] = [
    { source: "claude", label: "From Claude Code" },
    { source: "project", label: "From this project" },
    { source: "codex", label: "From Codex" },
  ];

  const listed = $derived([...shippedAgents(), ...ownAgents()]);
  const groups = $derived.by(() => {
    const found = installedAgents(project);
    return SOURCES.map((place) => ({ ...place, agents: found.filter((agent) => agent.source === place.source) })).filter(
      (group) => group.agents.length > 0,
    );
  });

  /** What the tab shows: the lists, one of the user's agents being made
      (`editing` null) or edited, or another agent to read. */
  type View = { kind: "list" } | { kind: "edit"; editing: string | null } | { kind: "read"; key: string };
  let view = $state<View>({ kind: "list" });
  /** The agent last opened or kept, marked in the list. */
  let last = $state<string | null>(null);

  let draft = $state<OwnAgent>(newAgent());
  let folded = $state(true);
  let problem = $state<string | null>(null);
  let removing = $state(false);

  const reading = $derived(view.kind === "read" ? agentByKey(view.key, project) : undefined);
  const editing = $derived(view.kind === "edit" ? view.editing : null);

  let section: HTMLElement;

  /** Shows a view and puts the keyboard in it: the title of a form, Back
      over an agent read, and in the lists the agent last opened or kept,
      else New agent. */
  async function show(next: View, focus = true) {
    view = next;
    folded = true;
    problem = null;
    removing = false;
    if (!focus) return;
    await tick();
    const marked = last === null ? null : `[data-testid="agent-row"][data-agent="${CSS.escape(last)}"]`;
    const target =
      next.kind === "edit"
        ? section.querySelector<HTMLElement>('[data-testid="agent-title"]')
        : next.kind === "read"
          ? section.querySelector<HTMLElement>('[data-testid="agent-back"]')
          : ((marked === null ? null : section.querySelector<HTMLElement>(marked)) ??
            section.querySelector<HTMLElement>('[data-testid="agent-new"]'));
    target?.focus();
  }

  /** Back to the lists, as when the tab is picked again; the keyboard
      stays where it is. */
  export function home() {
    void show({ kind: "list" }, false);
  }

  function open(agent: Agent) {
    last = agent.key;
    if (agent.kind !== "own") {
      void show({ kind: "read", key: agent.key });
      return;
    }
    const own = agents.own.find((one) => one.title === agent.title);
    if (own === undefined) return;
    draft = $state.snapshot(own);
    void show({ kind: "edit", editing: own.title });
  }

  function create() {
    draft = newAgent();
    void show({ kind: "edit", editing: null });
  }

  function save() {
    const said = saveAgent($state.snapshot(draft), editing);
    if (said !== null) {
      problem = said;
      return;
    }
    last = `own:${draft.title.trim()}`;
    void show({ kind: "list" });
  }

  function remove() {
    if (editing === null) return;
    removeAgent(editing);
    last = null;
    void show({ kind: "list" });
  }

  /** Remove asked and not confirmed: the keyboard goes back to Remove. */
  async function keep() {
    removing = false;
    await tick();
    section.querySelector<HTMLElement>('[data-testid="agent-remove"]')?.focus();
  }

  // The harnesses whose models the editor offers: those installed, and the
  // one the agent names so its model can be shown.
  const harnesses = $derived(offeredHarnesses(installed(), draft.model === null ? [] : [draft.model.harness]));

  // Where Codex is offered, the models it lists for the active project's
  // account, asked once.
  $effect(() => {
    if (view.kind !== "edit" || project === null || !harnesses.includes("codex")) return;
    void askCodexCatalog(project, hostOf(project));
  });

  /** A harness's models in the menu: those it offers, then the agent's own
      where the list does not hold it. */
  function modelsOf(harness: HarnessId) {
    const known = offeredModels(harness);
    const held = draft.model;
    if (held === null || held.harness !== harness || known.some((option) => option.model === held.model)) return known;
    return [...known, { agent: harness, model: held.model, label: held.model }];
  }

  const modelValue = $derived(draft.model === null ? "" : modelKey({ agent: draft.model.harness, model: draft.model.model }));

  function pickModel(value: string) {
    const chosen = modelFromKey(value);
    draft.model = chosen === null ? null : { harness: chosen.agent, model: chosen.model };
  }

  /** The efforts the menu offers: the harness's, then the agent's own
      where they do not hold it. */
  const efforts = $derived.by(() => {
    const known = agentEfforts(draft.model?.harness ?? null);
    return draft.effort === null || known.includes(draft.effort) ? known : [...known, draft.effort];
  });

  /** What an agent runs on, as the line under its description says it. */
  function runsOn(agent: Pick<Agent, "model">): string {
    return agent.model === null ? "the session's model" : modelLabel(agent.model.harness, agent.model.model);
  }

  /** An agent's whole description: an installed one keeps its first line apart from its text. */
  function described(agent: Pick<Agent, "firstLine" | "text">): string {
    return agent.text.startsWith(agent.firstLine) ? agent.text : `${agent.firstLine}\n\n${agent.text}`;
  }
</script>

{#snippet facts(agent: Pick<Agent, "model" | "effort" | "readsOnly">)}
  Runs on <b>{runsOn(agent)}</b>{#each agentFacts(agent).slice(1) as fact (fact)}&ensp;·&ensp;{fact}{/each}
{/snippet}

{#snippet row(agent: Agent)}
  <button
    type="button"
    class="arow"
    class:on={agent.key === last}
    onclick={() => open(agent)}
    data-testid="agent-row"
    data-agent={agent.key}
  >
    <span class="av" aria-hidden="true">{initials(agent.title)}</span>
    <span class="txt">
      <b class="t1">{agent.title}</b>
      <span class="t2">{agent.firstLine}</span>
    </span>
    <span class="dfl">
      {#if agent.readsOnly}
        <span class="lock" title="Reads only" data-testid="agent-reads-only"><Icon name="lock" size={13} /></span>
        <span class="hidden">Reads only</span>
      {/if}
    </span>
  </button>
{/snippet}

<section class="agents" data-testid="settings-agents" bind:this={section}>
  {#if view.kind === "list"}
    <h3>Agents</h3>
    <div class="alist" data-testid="agent-list">
      {#each listed as agent (agent.key)}
        {@render row(agent)}
      {/each}
      <button type="button" class="arow dim" onclick={create} data-testid="agent-new">
        <span class="av" aria-hidden="true"><Icon name="plus" size={13} /></span>
        <span class="txt"><b class="t1">New agent</b></span>
        <span></span>
      </button>
    </div>
    <UnreadEntries field="agents" />
    {#if agents.refused !== null}
      <p class="error" role="alert" data-testid="agent-refused">{agents.refused}</p>
    {/if}

    {#each groups as group (group.source)}
      <h3>{group.label}</h3>
      <div class="alist" data-testid="agent-installed" data-source={group.source}>
        {#each group.agents as agent (agent.key)}
          {@render row(agent)}
        {/each}
      </div>
    {/each}
  {:else if view.kind === "edit"}
    <div class="pg-h">
      <button type="button" class="back" onclick={() => void show({ kind: "list" })} data-testid="agent-back"
        >Agents /</button
      >
      <h4>{editing ?? "New agent"}</h4>
    </div>

    <label class="f">
      <span class="lab">Title</span>
      <input
        type="text"
        bind:value={draft.title}
        maxlength={80}
        spellcheck="false"
        autocomplete="off"
        data-testid="agent-title"
      />
    </label>
    <label class="f">
      <span class="lab">Description</span>
      <textarea
        bind:value={draft.description}
        rows="9"
        placeholder="Its first line says what it does; the rest, how it works."
        data-testid="agent-description"
      ></textarea>
    </label>

    <button
      type="button"
      class="fold"
      aria-expanded={!folded}
      onclick={() => (folded = !folded)}
      data-testid="agent-fold"
    >
      <span class="chev" class:rot={!folded}><Icon name="chev" size={12} /></span>
      <span>{@render facts(draft)}</span>
    </button>
    {#if !folded}
      <div class="dgrid" data-testid="agent-defaults">
        <label for="agent-model">Model</label>
        <select
          id="agent-model"
          value={modelValue}
          onchange={(event) => pickModel(event.currentTarget.value)}
          data-testid="agent-model"
        >
          <option value="">Session's model</option>
          {#each harnesses as harness (harness)}
            <optgroup label={HARNESS_LABELS[harness]}>
              {#each modelsOf(harness) as option (option.model)}
                <option value={modelKey(option)}>{option.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <label for="agent-effort">Effort</label>
        <select
          id="agent-effort"
          value={draft.effort ?? ""}
          onchange={(event) => (draft.effort = event.currentTarget.value === "" ? null : event.currentTarget.value)}
          data-testid="agent-effort"
        >
          <option value="">Session's effort</option>
          {#each efforts as effort (effort)}
            <option value={effort}>{effortName(effort)}</option>
          {/each}
        </select>
        <label for="agent-files">Files</label>
        <select
          id="agent-files"
          value={draft.readsOnly ? "reads" : "changes"}
          onchange={(event) => (draft.readsOnly = event.currentTarget.value === "reads")}
          data-testid="agent-files"
        >
          <option value="reads">Reads only</option>
          <option value="changes">Changes files</option>
        </select>
      </div>
    {/if}

    {#if problem !== null}
      <p class="error" role="alert" data-testid="agent-problem">{problem}</p>
    {/if}

    {#if removing && editing !== null}
      <ConfirmStrip
        question={`Remove the agent "${editing}"?`}
        action="Remove"
        onConfirm={remove}
        onCancel={keep}
        testid="agent-remove-ask"
      />
    {:else}
      <div class="foot">
        {#if editing !== null}
          <button type="button" class="btn danger" onclick={() => (removing = true)} data-testid="agent-remove"
            >Remove</button
          >
        {/if}
        <span class="acts">
          <button type="button" class="btn quiet" onclick={() => void show({ kind: "list" })} data-testid="agent-cancel"
            >Cancel</button
          >
          <button type="button" class="btn pri" onclick={save} data-testid="agent-save">Save</button>
        </span>
      </div>
    {/if}
  {:else if reading !== undefined}
    <div class="pg-h">
      <button type="button" class="back" onclick={() => void show({ kind: "list" })} data-testid="agent-back"
        >Agents /</button
      >
      <h4>{reading.title}</h4>
    </div>
    <div class="f">
      <span class="lab">Description</span>
      <div class="ro" data-testid="agent-text">{described(reading)}</div>
    </div>
    <p class="runs" data-testid="agent-facts">{@render facts(reading)}</p>
    <p class="foot note" data-testid="agent-whence">
      {#if reading.kind === "shipped"}
        Chord ships this agent; it cannot be changed here.
      {:else}
        Read from <code>{reading.path}</code>; it is changed where it is kept.
      {/if}
    </p>
  {:else}
    <div class="pg-h">
      <button type="button" class="back" onclick={() => void show({ kind: "list" })} data-testid="agent-back"
        >Agents /</button
      >
    </div>
    <p class="note">This agent is no longer installed.</p>
  {/if}
</section>

<style>
  /* The width the other tabs read at, centred in the panel. */
  .agents {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 640px;
    margin-inline: auto;
    padding-bottom: 4px;
  }

  h3 {
    margin: 6px 0 -4px;
    font-family: var(--chrome);
    font-size: var(--heading-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
  }

  h3:first-child {
    margin-top: 0;
  }

  /* Rounder than a field where the look rounds, square where it does not. */
  .alist {
    display: flex;
    flex-direction: column;
    border-radius: calc(var(--radius) * 1.43);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    overflow: hidden;
  }

  .arow {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: center;
    width: 100%;
    padding: 7px 12px 7px 10px;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 13px;
    text-align: left;
    color: var(--ink);
    cursor: pointer;
  }

  .arow + .arow {
    border-top: 1px solid var(--divider, var(--rule));
  }

  .arow:hover {
    background: color-mix(in srgb, var(--ink) 4%, transparent);
  }

  .arow.on {
    background: var(--accent-soft);
  }

  .arow:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .arow.dim {
    color: var(--ink-2);
  }

  .arow.dim .av,
  .arow.dim .t1 {
    opacity: 0.6;
  }

  .arow.dim:hover .av,
  .arow.dim:hover .t1 {
    opacity: 1;
  }

  .av {
    width: 24px;
    height: 24px;
    border-radius: var(--radius);
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--ink-2);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .arow.on .av {
    background: var(--surface);
    color: var(--accent);
  }

  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .t1 {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .t2 {
    font-size: 12px;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dfl {
    color: var(--ink-3);
  }

  .lock {
    display: block;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .pg-h {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .pg-h h4 {
    margin: 0;
    font-family: var(--chrome);
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .back {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .back:hover {
    color: var(--ink);
  }

  .f {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .lab {
    font-size: 12px;
    color: var(--ink-3);
  }

  input,
  textarea,
  select {
    box-sizing: border-box;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    color: var(--ink);
  }

  input {
    height: 28px;
    padding: 0 9px;
    font-size: var(--field-size);
  }

  textarea {
    min-height: 196px;
    padding: 8px 10px;
    font-size: 12.5px;
    line-height: 1.6;
    resize: vertical;
  }

  select {
    height: 28px;
    padding: 0 6px 0 8px;
    font-size: 12.5px;
  }

  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible,
  .fold:focus-visible,
  .back:focus-visible,
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ro {
    padding: 8px 10px;
    font-family: var(--chrome);
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    padding: 2px 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 12.5px;
    text-align: left;
    color: var(--ink-2);
    cursor: pointer;
  }

  .fold:hover {
    color: var(--ink);
  }

  .chev {
    display: inline-flex;
    color: var(--ink-3);
    transition: transform 0.12s;
  }

  .chev.rot {
    transform: rotate(90deg);
  }

  .fold b,
  .runs b {
    font-weight: 500;
    color: var(--ink);
  }

  .runs {
    margin: 0;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .dgrid {
    display: grid;
    grid-template-columns: 64px minmax(0, 220px);
    gap: 8px 10px;
    align-items: center;
    margin: -2px 0 0 18px;
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--divider, var(--rule));
  }

  .foot .acts {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    white-space: nowrap;
    cursor: pointer;
  }

  .btn.pri {
    background: var(--accent);
    color: var(--surface);
  }

  .btn.quiet {
    padding: 0 8px;
    color: var(--ink-2);
  }

  .btn.quiet:hover {
    color: var(--ink);
  }

  .btn.danger {
    padding: 0 6px;
    color: var(--del);
  }

  .note {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
  }

  .note code {
    font-family: var(--mono);
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }

  .error {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--del);
  }
</style>
