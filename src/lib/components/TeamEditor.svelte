<script lang="ts">
  /**
   * One team on the Agents tab, made or edited on one screen: its name,
   * its agents as chips ending in Add, and its gates, each a sentence with
   * two picks, who approves and when. A gate's ⋯ holds the one thing a
   * gate may add, the paths it waits on, and Remove gate; the condition
   * shows under the sentence once set. Add a gate opens straight onto who
   * approves, the agents that only read first; picking one adds the
   * sentence, before handing over, and puts the agent on the team. Taking
   * an agent off the team takes its gates with it.
   *
   * A team kept before has Remove team in the ⋯ by its name. Save, or
   * Enter in the name, keeps the team once the core finds nothing that
   * keeps it from being saved; what it finds is listed, most important
   * first, from the first Save on, and its hints all along. Cancel, Back
   * and Escape leave the team as it was, asking first when anything was
   * changed.
   */
  import { onMount, tick } from "svelte";
  import type { GateWhen, Team, TeamGate, TeamProblem } from "$lib/core";
  import type { Choice } from "$lib/settingChoices";
  import Icon from "$lib/components/conversation/Icon.svelte";
  import ChoiceMenu from "$lib/components/ChoiceMenu.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import { type Agent, allAgents, initials } from "$lib/agents.svelte";
  import { sessions } from "$lib/sessions.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { isRemote } from "$lib/remote.svelte";
  import {
    checkTeam,
    globsOf,
    hasMember,
    newGate,
    newTeam,
    refuses,
    removeTeam,
    saveTeam,
    teamByName,
    WHEN,
  } from "$lib/teams.svelte";

  interface Props {
    /** The team edited, by name, or null for a new one. */
    editing: string | null;
    /** The project whose installed agents are offered too. */
    project: string | null;
    /** Back to the lists, with the team kept or removed: its name, or
        null where none was kept. */
    onclose: (kept: string | null) => void;
  }

  let { editing, project, onclose }: Props = $props();

  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  // svelte-ignore state_referenced_locally
  let draft = $state<Team>(clone((editing === null ? undefined : teamByName(editing)) ?? newTeam()));
  const begun = JSON.stringify(draft);
  const changed = $derived(JSON.stringify(draft) !== begun);
  let removing = $state(false);
  let discarding = $state(false);

  /** What the core last found with the draft. Its hints show all along;
      what keeps the draft from being saved, once Save was tried. */
  let found = $state<TeamProblem[]>([]);
  let tried = $state(false);
  let saving = false;
  let asked = 0;
  const refusals = $derived(tried ? found.filter((problem) => !problem.quiet) : []);
  const hints = $derived(found.filter((problem) => problem.quiet));

  /** Where the open projects are on this machine, which a gate's paths
      are matched against. */
  const folders = (): string[] => workspace.open.map((open) => open.path).filter((path) => !isRemote(path));

  // The core is asked again a moment after the draft last changed.
  $effect(() => {
    const now = JSON.stringify(draft);
    const mine = ++asked;
    const timer = setTimeout(() => {
      void checkTeam(JSON.parse(now) as Team, editing, folders()).then((said) => {
        if (mine === asked) found = said;
      });
    }, 250);
    return () => clearTimeout(timer);
  });

  /** The agent last taken off the team, and the gates that went with it,
      where it stood, for Undo. */
  let dropped = $state<{ at: number; agent: string; gates: { at: number; gate: TeamGate }[] } | null>(null);

  /** How many sessions in the window lead the team: each has a run that
      lasts until its session is closed for good, asleep or not. */
  const leading = $derived(
    editing === null
      ? 0
      : sessions.all.filter((session) => session.team?.trim().toLowerCase() === editing.trim().toLowerCase())
          .length,
  );

  /** The menu open, and for which gate; "new" is Add a gate. */
  type Menu =
    | { kind: "member" }
    | { kind: "who"; gate: number | "new" }
    | { kind: "when"; gate: number }
    | { kind: "more"; gate: number }
    | { kind: "team" };
  let menu = $state<Menu | null>(null);
  /** What the ⋯ of a gate holds typed in its paths field. */
  let globText = $state("");

  let page: HTMLElement;

  const agents = $derived(allAgents(project));
  const agentOf = (title: string): Agent | undefined =>
    agents.find((agent) => agent.title.toLowerCase() === title.trim().toLowerCase());

  onMount(() => {
    page.querySelector<HTMLElement>('[data-testid="team-name"]')?.focus();
  });

  /** Puts the keyboard on the element marked with `testid`, the `at`-th
      where there are several. */
  async function focusOn(testid: string, at = 0) {
    await tick();
    page.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)[at]?.focus();
  }

  function open(next: Menu) {
    if (next.kind === "more") {
      const touches = draft.gates[next.gate].touches;
      globText = touches?.join(", ") ?? "";
    }
    menu = next;
  }

  /** Puts a menu away, the keyboard back on what opened it unless it
      went elsewhere. */
  function close(how: "escape" | "tab" | "away" = "escape") {
    const was = menu;
    menu = null;
    if (was === null || how === "away") return;
    if (was.kind === "member") void focusOn("team-member-add");
    else if (was.kind === "team") void focusOn("team-more");
    else if (was.kind === "who")
      void (was.gate === "new" ? focusOn("team-gate-add") : focusOn("team-gate-who", was.gate));
    else if (was.kind === "when") void focusOn("team-gate-when", was.gate);
    else void focusOn("team-gate-more", was.gate);
  }

  function addMember(title: string) {
    if (!hasMember(draft, title)) draft.members.push({ agent: title });
  }

  function pickMember(title: string) {
    addMember(title);
    close();
  }

  /** The gates an agent on the team approves. */
  function gatesOf(title: string): number {
    const wanted = title.trim().toLowerCase();
    return draft.gates.filter((gate) => gate.who.trim().toLowerCase() === wanted).length;
  }

  const gateCount = (count: number) => `${count} ${count === 1 ? "gate" : "gates"}`;

  function dropMember(at: number) {
    const agent = draft.members[at].agent;
    const title = agent.trim().toLowerCase();
    const gates = draft.gates.flatMap((gate, index) =>
      gate.who.trim().toLowerCase() === title ? [{ at: index, gate: clone($state.snapshot(gate)) }] : [],
    );
    draft.members.splice(at, 1);
    draft.gates = draft.gates.filter((gate) => gate.who.trim().toLowerCase() !== title);
    if (gates.length > 0) dropped = { at, agent, gates };
    void focusOn("team-member-remove", Math.min(at, draft.members.length - 1));
    if (draft.members.length === 0) void focusOn("team-member-add");
  }

  /** Puts the agent last taken off with gates back, with those gates where
      they were; one the draft has again since, for the same agent at the
      same moment, is not added twice. */
  function undoDrop() {
    if (dropped === null) return;
    const { at, agent, gates } = dropped;
    dropped = null;
    if (!hasMember(draft, agent)) draft.members.splice(Math.min(at, draft.members.length), 0, { agent });
    const same = (a: TeamGate, b: TeamGate) =>
      a.who.trim().toLowerCase() === b.who.trim().toLowerCase() && a.when === b.when;
    for (const { at: index, gate } of gates)
      if (!draft.gates.some((had) => same(had, gate)))
        draft.gates.splice(Math.min(index, draft.gates.length), 0, gate);
    void focusOn("team-member-remove", draft.members.findIndex((member) => member.agent === agent));
  }

  function pickWho(title: string) {
    if (menu?.kind !== "who") return;
    addMember(title);
    if (menu.gate === "new") {
      draft.gates.push(newGate(title));
      const at = draft.gates.length - 1;
      menu = null;
      void focusOn("team-gate-who", at);
      return;
    }
    draft.gates[menu.gate].who = title;
    close();
  }

  function pickWhen(value: string) {
    if (menu?.kind !== "when") return;
    draft.gates[menu.gate].when = value as GateWhen;
    close();
  }

  /** Keeps the paths typed for the gate the ⋯ is open on; none waits on
      every change. The core says what is wrong with one. */
  function keepGlobs() {
    if (menu?.kind !== "more") return;
    const globs = globsOf(globText);
    const gate = draft.gates[menu.gate];
    if (globs.length === 0) delete gate.touches;
    else gate.touches = globs;
    close();
  }

  function removeGate() {
    if (menu?.kind !== "more") return;
    const at = menu.gate;
    draft.gates.splice(at, 1);
    menu = null;
    void (draft.gates.length === 0
      ? focusOn("team-gate-add")
      : focusOn("team-gate-more", Math.min(at, draft.gates.length - 1)));
  }

  async function save() {
    if (saving) return;
    saving = true;
    tried = true;
    asked++;
    const said = await saveTeam($state.snapshot(draft) as Team, editing, folders());
    saving = false;
    found = said;
    if (!refuses(said)) onclose(draft.name.trim());
  }

  /** Back to the lists, asking first when anything was changed. */
  function leave() {
    if (changed) discarding = true;
    else onclose(editing);
  }

  async function keepEditing() {
    discarding = false;
    await focusOn("team-cancel");
  }

  /** Escape that nothing in the editor took puts away an open menu, and
      with none open is Back. */
  function keys(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (menu !== null) close();
    else leave();
  }

  function remove() {
    if (editing !== null) removeTeam(editing);
    onclose(null);
  }

  async function keepTeam() {
    removing = false;
    await focusOn("team-more");
  }

  /** The agents not on the team, for Add. */
  const addable = $derived<Choice[]>(
    agents
      .filter((agent) => !hasMember(draft, agent.title))
      .map((agent) => ({
        value: agent.title,
        name: agent.title,
        about: agent.firstLine || null,
        lock: agent.readsOnly,
      })),
  );

  /** Who may approve: every agent, those that only read first. */
  const approvers = $derived.by<Choice[]>(() => {
    const current = menu?.kind === "who" && menu.gate !== "new" ? draft.gates[menu.gate]?.who : undefined;
    const sorted = [...agents.filter((agent) => agent.readsOnly), ...agents.filter((agent) => !agent.readsOnly)];
    const listed = sorted.map((agent) => ({
      value: agent.title,
      name: agent.title,
      about: agent.firstLine || null,
      lock: agent.readsOnly,
      on: current !== undefined && agent.title.toLowerCase() === current.trim().toLowerCase(),
    }));
    // A member no agent stands for any more is still shown where it approves.
    if (current !== undefined && !listed.some((choice) => choice.on))
      listed.unshift({ value: current, name: current, about: null, lock: false, on: true });
    return listed;
  });

  const whenChoices = $derived<Choice[]>(
    (["plan", "change"] as GateWhen[]).map((when) => ({
      value: when,
      name: WHEN[when].name.replace(/^./, (first) => first.toUpperCase()),
      about: WHEN[when].about,
      on: menu?.kind === "when" && draft.gates[menu.gate]?.when === when,
    })),
  );

  /** The ⋯ of a gate is put away when the keyboard leaves it. */
  function leaveMore(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next !== null && !(e.currentTarget as HTMLElement).parentElement?.contains(next)) menu = null;
  }

  function moreKeys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="team" bind:this={page} onkeydown={keys} data-testid="team-editor">
  <div class="pg-h">
    <button type="button" class="back" onclick={leave} data-testid="team-back">Agents /</button>
    <h4>{editing ?? "New team"}</h4>
    {#if editing !== null}
      <span class="picker head">
        <button
          type="button"
          class="btn quiet icon"
          aria-label="More for this team"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "team"}
          onclick={() => open({ kind: "team" })}
          data-testid="team-more"><Icon name="dots" size={14} /></button
        >
        {#if menu?.kind === "team"}
          <ChoiceMenu
            label="More for this team"
            choices={[{ value: "remove", name: "Remove team", about: null }]}
            actions
            below
            end
            onpick={() => {
              menu = null;
              removing = true;
            }}
            onclose={close}
            testid="team-more-menu"
            optionTestid="team-more-option"
          />
        {/if}
      </span>
    {/if}
  </div>

  <label class="f">
    <span class="lab">Name</span>
    <input
      type="text"
      bind:value={draft.name}
      spellcheck="false"
      autocomplete="off"
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      }}
      data-testid="team-name"
    />
  </label>

  {#if leading > 0}
    <p class="note" data-testid="team-in-use">
      {leading === 1 ? "A session leads" : `${leading} sessions lead`} this team. Runs in progress keep the team as
      it was.
    </p>
  {/if}

  <div class="f">
    <span class="lab" id="team-agents">Agents</span>
    <div class="mems" role="group" aria-labelledby="team-agents" data-testid="team-members">
      {#each draft.members as member, at (member.agent)}
        <span class="mem" data-testid="team-member" data-agent={member.agent}>
          <span class="av" aria-hidden="true">{initials(member.agent)}</span>
          <span class="mt">{member.agent}</span>
          <button
            type="button"
            class="mx"
            aria-label={gatesOf(member.agent) === 0
              ? `Take ${member.agent} off the team`
              : `Take ${member.agent} off the team, with its ${gateCount(gatesOf(member.agent))}`}
            title={gatesOf(member.agent) === 0
              ? "Take off the team"
              : `Take off the team, with its ${gateCount(gatesOf(member.agent))}`}
            onclick={() => dropMember(at)}
            data-testid="team-member-remove"><Icon name="x" size={10} /></button
          >
        </span>
      {/each}
      <span class="picker">
        <button
          type="button"
          class="mem add"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "member"}
          onclick={() => open({ kind: "member" })}
          data-testid="team-member-add"><Icon name="plus" size={12} />Add</button
        >
        {#if menu?.kind === "member"}
          <ChoiceMenu
            label="Add an agent"
            heading="Add an agent"
            choices={addable}
            note={addable.length === 0 ? "Every agent is on the team." : null}
            actions
            below
            filter
            most={8}
            onpick={pickMember}
            onclose={close}
            testid="team-member-menu"
            optionTestid="team-member-option"
          />
        {/if}
      </span>
    </div>
    {#if dropped !== null}
      <p class="note" role="status" data-testid="team-dropped">
        Took {dropped.agent} off, with its {gateCount(dropped.gates.length)}.
        <button type="button" class="undo" onclick={undoDrop} data-testid="team-dropped-undo">Undo</button>
      </p>
    {/if}
  </div>

  <div class="f">
    <span class="lab" id="team-gates">Gates</span>
    <div role="group" aria-labelledby="team-gates" data-testid="team-gates">
      {#each draft.gates as gate, at (at)}
        <div class="sent" data-testid="team-gate">
          <span class="gi" aria-hidden="true"><Icon name="shield" size={14} /></span>
          <span class="picker">
            <button
              type="button"
              class="pick"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "who" && menu.gate === at}
              aria-label="Who approves: {gate.who}"
              onclick={() => open({ kind: "who", gate: at })}
              data-testid="team-gate-who"><span class="pt">{gate.who}</span><Icon name="down" size={11} /></button
            >
            {#if menu?.kind === "who" && menu.gate === at}
              <ChoiceMenu
                label="Who approves"
                heading="Who approves"
                choices={approvers}
                below
                filter
                most={8}
                onpick={pickWho}
                onclose={close}
                testid="team-who-menu"
                optionTestid="team-who-option"
              />
            {/if}
          </span>
          approves
          <span class="picker">
            <button
              type="button"
              class="pick"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "when" && menu.gate === at}
              aria-label="When: {WHEN[gate.when].name}"
              onclick={() => open({ kind: "when", gate: at })}
              data-testid="team-gate-when"><span class="pt">{WHEN[gate.when].name}</span><Icon name="down" size={11} /></button
            >
            {#if menu?.kind === "when" && menu.gate === at}
              <ChoiceMenu
                label="When"
                choices={whenChoices}
                below
                onpick={pickWhen}
                onclose={close}
                testid="team-when-menu"
                optionTestid="team-when-option"
              />
            {/if}
          </span>
          <span class="picker x">
            <button
              type="button"
              class="more"
              aria-label="More for this gate"
              aria-haspopup="dialog"
              aria-expanded={menu?.kind === "more" && menu.gate === at}
              onclick={() => (menu?.kind === "more" && menu.gate === at ? close() : open({ kind: "more", gate: at }))}
              data-testid="team-gate-more"><Icon name="dots" size={13} /></button
            >
            {#if menu?.kind === "more" && menu.gate === at}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div class="fmenu" role="dialog" aria-label="More for this gate" tabindex="-1" onfocusout={leaveMore} onkeydown={moreKeys} data-testid="team-gate-menu">
                <label class="gl">
                  <span class="gl-l">Only when it touches</span>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    type="text"
                    class="glob"
                    bind:value={globText}
                    placeholder="infra/**"
                    spellcheck="false"
                    autocomplete="off"
                    autofocus
                    onkeydown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        keepGlobs();
                      }
                    }}
                    data-testid="team-gate-touches"
                  />
                </label>
                <div class="gl-a">
                  <button type="button" class="btn pri" onclick={keepGlobs} data-testid="team-gate-touches-done">Done</button>
                </div>
                <div class="sep"></div>
                <button type="button" class="rm" onclick={removeGate} data-testid="team-gate-remove">Remove gate</button>
              </div>
            {/if}
          </span>
          {#if gate.touches !== undefined}
            <span class="cond" data-testid="team-gate-cond"
              >only when it touches {#each gate.touches as glob, i (i)}{#if i > 0}{i === gate.touches.length - 1 ? " or " : ", "}{/if}<code
                  >{glob}</code
                >{/each}</span
            >
          {/if}
        </div>
      {/each}
    </div>
    <span class="picker">
      <button
        type="button"
        class="addg"
        aria-haspopup="menu"
        aria-expanded={menu?.kind === "who" && menu.gate === "new"}
        onclick={() => open({ kind: "who", gate: "new" })}
        data-testid="team-gate-add"><Icon name="plus" size={12} />Add a gate</button
      >
      {#if menu?.kind === "who" && menu.gate === "new"}
        <ChoiceMenu
          label="Who approves"
          heading="Who approves"
          choices={approvers}
          actions
          below
          filter
          most={8}
          onpick={pickWho}
          onclose={close}
          testid="team-who-menu"
          optionTestid="team-who-option"
        />
      {/if}
    </span>
  </div>

  <div class="problems" role="alert">
    {#each refusals as problem, at (at)}
      <p class="error" data-testid="team-problem">{problem.text}</p>
    {/each}
  </div>
  {#each hints as hint, at (at)}
    <p class="hint" data-testid="team-hint">{hint.text}</p>
  {/each}

  {#if discarding}
    <ConfirmStrip
      question={editing === null ? "Discard this new team?" : `Discard changes to "${editing}"?`}
      action="Discard"
      onConfirm={() => onclose(editing)}
      onCancel={keepEditing}
      testid="team-discard-ask"
    />
  {:else if removing && editing !== null}
    <ConfirmStrip
      question={`Remove the team "${editing}"?`}
      action="Remove"
      onConfirm={remove}
      onCancel={keepTeam}
      testid="team-remove-ask"
    />
  {:else}
    <div class="foot">
      <span class="acts">
        <button type="button" class="btn quiet" onclick={leave} data-testid="team-cancel">Cancel</button>
        <button type="button" class="btn pri" onclick={() => void save()} data-testid="team-save">Save</button>
      </span>
    </div>
  {/if}
</div>

<style>
  .team {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-family: var(--chrome);
  }

  .picker {
    position: relative;
    display: inline-flex;
  }

  .pg-h {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .pg-h h4 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pg-h .head {
    margin-left: auto;
    align-self: center;
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

  input {
    box-sizing: border-box;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  .mems {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .mem {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    max-width: 100%;
    box-sizing: border-box;
    padding: 0 4px 0 4px;
    border: 0;
    border-radius: calc(var(--radius) * 1.15);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    background: none;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink);
  }

  .mem .av {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: var(--radius);
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--ink-2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .mt {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mx {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .mx:hover {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }

  .mem.add {
    padding: 0 10px 0 8px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .mem.add:hover {
    color: var(--ink);
  }

  .sent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 7px 8px 7px 10px;
    border-radius: calc(var(--radius) * 1.3);
    background: var(--surface-2);
    font-size: 13px;
    color: var(--ink-2);
  }

  .sent + .sent {
    margin-top: 6px;
  }

  .gi {
    display: inline-flex;
    color: var(--ink-3);
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 24px;
    max-width: 260px;
    padding: 0 5px 0 8px;
    border: 0;
    border-radius: var(--radius);
    background: var(--clear-surface);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font-family: var(--chrome);
    font-size: 13px;
    font-weight: 500;
    color: var(--ink);
    cursor: pointer;
  }

  .pick :global(svg) {
    flex: none;
    color: var(--ink-3);
  }

  .pt {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .x {
    margin-left: auto;
  }

  .more {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .more:hover,
  .more[aria-expanded="true"] {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }

  .cond {
    flex-basis: 100%;
    margin-left: 22px;
    font-size: 12px;
    color: var(--ink-3);
    overflow-wrap: anywhere;
  }

  .cond code,
  .glob {
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .addg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    padding: 5px 10px;
    border: 0;
    border-radius: calc(var(--radius) * 1.15);
    background: none;
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .addg:hover,
  .addg[aria-expanded="true"] {
    color: var(--ink);
  }

  .fmenu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 5;
    width: 260px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--paint-surface, var(--surface));
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
  }

  .gl {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .gl-l {
    font-size: 12px;
    color: var(--ink-3);
  }

  .gl-a {
    display: flex;
    justify-content: flex-end;
  }

  .sep {
    height: 1px;
    margin: 2px -8px;
    background: var(--divider, var(--rule));
  }

  .rm {
    padding: 4px 2px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: 13px;
    text-align: left;
    color: var(--del);
    cursor: pointer;
  }

  .rm:hover {
    background: color-mix(in srgb, var(--del) 8%, transparent);
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

  .btn.icon {
    padding: 0 6px;
  }

  input:focus-visible,
  .back:focus-visible,
  .btn:focus-visible,
  .mem.add:focus-visible,
  .mx:focus-visible,
  .pick:focus-visible,
  .more:focus-visible,
  .addg:focus-visible,
  .rm:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .problems {
    display: contents;
  }

  .error,
  .hint,
  .note {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
  }

  .error {
    color: var(--del);
  }

  .hint,
  .note {
    color: var(--ink-3);
  }

  .undo {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }

  .undo:hover {
    text-decoration: underline;
  }

  .undo:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
