<script lang="ts">
  /**
   * The Agents tab of the settings. Over the agents, the teams in use, each
   * with how many gates and agents it has, ending in a row that makes a new
   * one; a team opens in place of the lists to edit.
   *
   * The agents Chord ships and the user's
   * own stand in one list, each with its first line and a lock where it
   * only reads, ending in a row that makes a new one. Under it, the agents
   * installed for the active project's harnesses, a list for each place
   * they are read from, shown only when there are some.
   *
   * A row opens its agent in place of the lists. A shipped one and one of
   * the user's own open to edit: its title, its description and, folded
   * into one line, what it runs on, kept on Save and left as it was on
   * Cancel. A shipped one the user changed is put back as it ships with
   * Reset to shipped, where one of the user's own has Remove. An installed
   * one opens to read: its description, how it works, what it runs on and
   * where it is kept.
   */
  import { tick } from "svelte";
  import type { HarnessId, InstalledAgent, OwnAgent } from "$lib/core";
  import Icon from "$lib/components/conversation/Icon.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import UnreadEntries from "$lib/components/UnreadEntries.svelte";
  import TeamEditor from "$lib/components/TeamEditor.svelte";
  import { loadTeams, teams, teamSummary } from "$lib/teams.svelte";
  import {
    type Agent,
    agentByKey,
    agentEfforts,
    agentFacts,
    agents,
    changeOf,
    initials,
    installedAgents,
    LONGEST_TITLE,
    loadInstalled,
    newAgent,
    ownAgents,
    READS_ONLY_ABOUT,
    removeAgent,
    resetShipped,
    saveAgent,
    SHIPPED,
    shippedAgents,
  } from "$lib/agents.svelte";
  import { isChatsFolder } from "$lib/chats.svelte";
  import { installed } from "$lib/harness.svelte";
  import { HARNESS_LABELS, modelFromKey, modelKey, modelLabel, offeredHarnesses, offeredModels } from "$lib/models";
  import { askCodexCatalog } from "$lib/modelCatalog.svelte";
  import { hostOf } from "$lib/remote.svelte";
  import { effortName } from "$lib/settingChoices";
  import { workspace } from "$lib/workspace.svelte";

  /** The project the tab is about: none with a chat in front, which
      belongs to no project. */
  const project = $derived(isChatsFolder(workspace.active) ? null : workspace.active);

  // The installed agents are read again each time the tab opens, and for
  // each project made active while it is open.
  $effect(() => {
    if (project !== null) void loadInstalled(project);
  });

  // The teams in use are asked of the core each time the tab opens.
  $effect(() => {
    void loadTeams();
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
      (`editing` null) or edited, a shipped one edited (`shipped` the title
      it ships under), an installed one to read, or a team made or
      edited. */
  type View =
    | { kind: "list" }
    | { kind: "edit"; editing: string | null; shipped?: string }
    | { kind: "read"; key: string }
    | { kind: "team"; editing: string | null };
  let view = $state<View>({ kind: "list" });
  /** The agent last opened or kept, marked in the list. */
  let last = $state<string | null>(null);
  /** The team last opened or kept, marked in its list. */
  let lastTeam = $state<string | null>(null);

  let draft = $state<OwnAgent>(newAgent());
  let folded = $state(true);
  let problem = $state<string | null>(null);
  /** Remove, or Reset to shipped, asked and not yet confirmed. */
  let removing = $state(false);

  const reading = $derived(view.kind === "read" ? agentByKey(view.key, project) : undefined);
  const editing = $derived(view.kind === "edit" ? view.editing : null);
  const shipped = $derived(view.kind === "edit" ? (view.shipped ?? null) : null);
  const changed = $derived(shipped !== null && changeOf(shipped) !== undefined);
  /** The button in the foot that asks before it acts, if any. */
  const asker = $derived(shipped !== null ? "agent-reset" : "agent-remove");

  let section: HTMLElement;

  /** Shows a view and puts the keyboard in it: the title of a form, Back
      over an agent read, and in the lists the team or agent last opened
      or kept, else New agent. A team's form puts the keyboard in itself. */
  async function show(next: View, focus = true) {
    view = next;
    folded = true;
    problem = null;
    removing = false;
    if (!focus || next.kind === "team") return;
    await tick();
    const marked =
      lastTeam !== null
        ? `[data-testid="team-row"][data-team="${CSS.escape(lastTeam)}"]`
        : last === null
          ? null
          : `[data-testid="agent-row"][data-agent="${CSS.escape(last)}"]`;
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

  function openTeam(name: string | null) {
    lastTeam = name;
    void show({ kind: "team", editing: name });
  }

  /** Back from a team to the lists, the team kept marked. */
  function closeTeam(kept: string | null) {
    lastTeam = kept;
    void show({ kind: "list" });
  }

  function open(agent: Agent) {
    lastTeam = null;
    last = agent.key;
    if (agent.kind === "installed") {
      void show({ kind: "read", key: agent.key });
      return;
    }
    if (agent.kind === "shipped") {
      const title = agent.key.slice("chord:".length);
      const as = changeOf(title) ?? SHIPPED.find((one) => one.title === title);
      if (as === undefined) return;
      draft = { shipped: title, ...JSON.parse(JSON.stringify(as)) };
      void show({ kind: "edit", editing: agent.title, shipped: title });
      return;
    }
    const own = agents.own.find((one) => one.shipped === undefined && one.title === agent.title);
    if (own === undefined) return;
    draft = $state.snapshot(own);
    void show({ kind: "edit", editing: own.title });
  }

  /** The form for a new agent, as New agent opens it. */
  export function create() {
    lastTeam = null;
    draft = newAgent();
    void show({ kind: "edit", editing: null });
  }

  function save() {
    const said = saveAgent($state.snapshot(draft), editing);
    if (said !== null) {
      problem = said;
      return;
    }
    last = shipped !== null ? `chord:${shipped}` : `own:${draft.title.trim()}`;
    void show({ kind: "list" });
  }

  function remove() {
    if (shipped !== null) {
      resetShipped(shipped);
      last = `chord:${shipped}`;
    } else if (editing !== null) {
      removeAgent(editing);
      last = null;
    }
    void show({ kind: "list" });
  }

  /** Remove or Reset to shipped asked and not confirmed: the keyboard goes
      back to the button that asked. */
  async function keep() {
    removing = false;
    await tick();
    section.querySelector<HTMLElement>(`[data-testid="${asker}"]`)?.focus();
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

  /** How an installed agent works: its text, less the first line where the
      text starts with it. */
  function workings(agent: Pick<Agent, "firstLine" | "text">): string {
    return agent.text.startsWith(agent.firstLine) ? agent.text.slice(agent.firstLine.length).trim() : agent.text;
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
        <span class="lock" title={READS_ONLY_ABOUT} data-testid="agent-reads-only"><Icon name="lock" size={13} /></span>
        <span class="hidden">Reads only</span>
      {/if}
    </span>
  </button>
{/snippet}

<section class="agents" data-testid="settings-agents" bind:this={section}>
  {#if view.kind === "list"}
    <h3>Teams</h3>
    <div class="alist" data-testid="team-list">
      {#each teams.inUse as team (team.name)}
        <button
          type="button"
          class="arow"
          class:on={team.name === lastTeam}
          onclick={() => openTeam(team.name)}
          data-testid="team-row"
          data-team={team.name}
        >
          <span class="av" aria-hidden="true"><Icon name="team" size={14} /></span>
          <span class="txt">
            <b class="t1">{team.name}</b>
            <span class="t2">{teamSummary(team)}</span>
          </span>
          <span></span>
        </button>
      {/each}
      <button type="button" class="arow dim" onclick={() => openTeam(null)} data-testid="team-new">
        <span class="av" aria-hidden="true"><Icon name="plus" size={13} /></span>
        <span class="txt"><b class="t1">New team</b></span>
        <span></span>
      </button>
    </div>
    {#if teams.inUse.length === 0}
      <p class="note teams-none" data-testid="team-none">
        A team is the agents a lead may call and the gates their work passes.
      </p>
    {/if}
    <UnreadEntries field="teams" />
    {#if teams.refused !== null}
      <p class="error" role="alert" data-testid="team-refused">{teams.refused}</p>
    {/if}

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
  {:else if view.kind === "team"}
    <TeamEditor editing={view.editing} {project} onclose={closeTeam} />
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
        maxlength={LONGEST_TITLE}
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
          title={draft.readsOnly ? READS_ONLY_ABOUT : "The agent may change files, as the mode allows."}
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

    {#if removing && shipped !== null}
      <ConfirmStrip
        question={`Put "${shipped}" back as Chord ships it?`}
        action="Reset"
        onConfirm={remove}
        onCancel={keep}
        testid="agent-reset-ask"
      />
    {:else if removing && editing !== null}
      <ConfirmStrip
        question={`Remove the agent "${editing}"?`}
        action="Remove"
        onConfirm={remove}
        onCancel={keep}
        testid="agent-remove-ask"
      />
    {:else}
      <div class="foot">
        {#if shipped !== null}
          {#if changed}
            <button type="button" class="btn quiet" onclick={() => (removing = true)} data-testid="agent-reset"
              >Reset to shipped</button
            >
          {/if}
        {:else if editing !== null}
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
      <div class="ro" data-testid="agent-lead">{reading.firstLine}</div>
    </div>
    {#if workings(reading) !== ""}
      <div class="f">
        <span class="lab">How it works</span>
        <div class="ro" data-testid="agent-text">{workings(reading)}</div>
      </div>
    {/if}
    <p class="runs" data-testid="agent-facts">{@render facts(reading)}</p>
    <p class="whence note" data-testid="agent-whence">
      Read from <code>{reading.path}</code>; it is changed where it is kept.
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
  /* The column the other tabs read on, edge to edge. */
  .agents {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 4px;
  }

  /* A section's name: 22px under the card above it, 6px over its own. */
  h3 {
    display: flex;
    align-items: center;
    min-height: 22px;
    margin: 10px 2px -6px;
    font-family: var(--chrome);
    font-size: var(--heading-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
  }

  h3:first-child {
    margin-top: 6px;
  }

  .alist {
    display: flex;
    flex-direction: column;
    background: var(--s-card-fill, var(--clear-surface));
    border: 1px solid var(--s-card-edge, var(--rule));
    border-radius: var(--card-radius);
    box-shadow: var(--s-card-shadow, none);
    overflow: hidden;
  }

  .arow {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: center;
    width: 100%;
    min-height: 42px;
    padding: 7px 14px;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--s-row-label, 13px);
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
    background: var(--paint-surface);
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

  /* Under a rule as the form's foot is, but running as one line of text. */
  .whence {
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

  /* A note on the section, under its card. */
  .teams-none {
    margin: -5px 2px 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ground-quiet);
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
