<script module lang="ts">
  /** The columns of settings, one on screen at a time. */
  type Tab = "appearance" | "sessions" | "workflows" | "accounts" | "plugins" | "keys" | "notifications";

  /** The tab last chosen. It belongs to the module rather than the dialog, so
      closing the settings and opening them again lands where you were; a new
      window starts on the first. */
  let remembered: Tab = "appearance";
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import {
    ACTIONS,
    PRESET_LABELS,
    PRESETS,
    applyPreset,
    chordFromEvent,
    describe,
    keys,
    resetBinding,
    sameChord,
    setBinding,
    type ActionKey,
    type PresetName,
  } from "$lib/keys.svelte";
  import { closeAlso } from "$lib/keymap";
  import { returnFocus } from "$lib/layout.svelte";
  import { closeSettings, settings } from "$lib/settings.svelte";
  import {
    addSource,
    checkAll,
    checkSource,
    enablePlugin,
    fetchSource,
    fetched,
    loadPlugins,
    plugins,
    removeSource,
    stateLabel,
    summary,
    listensFor,
    trust,
    trusted,
    updateSource,
  } from "$lib/plugins.svelte";
  import { lastSegment } from "$lib/paths";
  import type { AgentId, PluginInfo, PluginSource } from "$lib/core";
  import { hook, overrideOf, reapply, setEverywhere, setOverride } from "$lib/hook.svelte";
  import {
    OWN_LABEL,
    accounts,
    addAccount,
    names,
    overrideOf as accountOverrideOf,
    removeAccount,
    setEverywhere as setAccountEverywhere,
    setOverride as setAccountOverride,
    suggest,
  } from "$lib/accounts.svelte";
  import { hookedProjects, workspace, projectLabel } from "$lib/workspace.svelte";
  import { PAST_SESSIONS, sessions, setPastSessions } from "$lib/sessions.svelte";
  import { canIntegrate, kindFor, setKind } from "$lib/sessionKind.svelte";
  import { AGENTS, agentLabel, installed } from "$lib/agent.svelte";
  import { INACTIVE_AFTER, projects, setInactiveAfter } from "$lib/projects.svelte";
  import {
    INTERFACE_FONTS,
    LOOKS,
    PALETTES,
    TERMINAL_FONTS,
    resolvedTheme,
    setLook,
    setMono,
    setPalette,
    setSans,
    setTheme,
    deleteTheme,
    theme,
    type ThemeChoice,
  } from "$lib/theme.svelte";
  import { DEFAULTS } from "$lib/customThemes";
  import { setUserStyles, userStyles } from "$lib/userStyles.svelte";
  import { compact, setCompact } from "$lib/compact.svelte";
  import { notify, setChime, setNotifications } from "$lib/notify.svelte";
  import { setAskEveryStart, startAsk } from "$lib/startAsk.svelte";
  import { anyChosen, chosenFor, forget as forgetChosen } from "$lib/lastChosen.svelte";
  import { modelLabel } from "$lib/models";
  import { modeName } from "$lib/modeFit";
  import { effortName } from "$lib/settingChoices";
  import Switch from "$lib/components/Switch.svelte";
  import BackgroundPicker from "$lib/components/BackgroundPicker.svelte";
  import UnreadEntries from "$lib/components/UnreadEntries.svelte";
  import WorkflowsTab from "$lib/components/WorkflowsTab.svelte";

  /**
   * The settings, over the workbench. Reached from the native menu or its
   * shortcut; closed on Escape or a click outside. Everything in it takes effect
   * as it is changed and is kept, so there is nothing to save or cancel.
   */

  const THEMES: { choice: ThemeChoice; label: string; hint: string }[] = [
    { choice: "system", label: "System", hint: "Follows the desktop" },
    { choice: "light", label: "Light", hint: "" },
    { choice: "dark", label: "Dark", hint: "" },
  ];

  const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

  const TABS: { name: Tab; label: string }[] = [
    { name: "appearance", label: "Appearance" },
    { name: "sessions", label: "Sessions" },
    { name: "workflows", label: "Workflows" },
    { name: "accounts", label: "Accounts" },
    { name: "plugins", label: "Plugins" },
    { name: "keys", label: "Keys" },
    { name: "notifications", label: "Notifications" },
  ];

  let dialog: HTMLElement;
  /** The action whose shortcut is being recorded, if any. */
  let recording = $state<ActionKey | null>(null);
  let problem = $state<{ action: ActionKey; text: string } | null>(null);

  let tabs: HTMLElement;
  let tab = $state<Tab>(remembered);

  function show(next: Tab) {
    tab = next;
    remembered = next;
  }

  /** The tabs are one stop for Tab, on the tab shown. The arrows walk the
      list from whichever tab has the keyboard, along it and across it, and
      the tab they reach takes both the column and the keyboard. A shortcut
      being recorded owns every key, so they stand down. */
  function onTabKeys(e: KeyboardEvent, index: number) {
    if (recording !== null) return;
    const step =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = (index + step + TABS.length) % TABS.length;
    show(TABS[next].name);
    tabs.querySelectorAll("button")[next]?.focus();
  }

  // The keyboard is taken on the way in and handed back on the way out,
  // whichever way the dialog closed.
  onMount(() => {
    dialog.focus();
    return returnFocus;
  });

  /** The plugin sources, read when the dialog opens. */
  onMount(() => {
    void loadPlugins();
  });

  let sourceLocation = $state("");
  let sourceReference = $state("");
  /** Whether the form for a source of your own is on screen. It stays
      open for as long as the dialog is. */
  let addingSource = $state(false);
  /** The plugin whose question is on screen: enabling it means agreeing
      to what it declares. Asked once per plugin. */
  let asking = $state<{ id: string; name: string } | null>(null);
  /** The sources the app offers first, then the ones you added. */
  const ordered = $derived([
    ...plugins.sources.filter((source) => source.known),
    ...plugins.sources.filter((source) => !source.known),
  ]);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const location = sourceLocation.trim();
    if (location === "" || plugins.busy) return;
    const added = await addSource(location, sourceReference.trim() || null);
    if (added) {
      sourceLocation = "";
      sourceReference = "";
      addingSource = false;
    }
  }

  function turn(id: string, name: string, on: boolean) {
    if (!on) {
      asking = null;
      void enablePlugin(id, name, false);
      return;
    }
    if (trusted(id, name)) {
      void start(id, name);
      return;
    }
    asking = { id, name };
  }

  function agree(id: string, name: string) {
    trust(id, name);
    asking = null;
    void start(id, name);
  }

  /** Turning a plugin on. A source the app offers is fetched first, and
      nothing is enabled when the fetch fails. */
  async function start(id: string, name: string) {
    const source = plugins.sources.find((s) => s.id === id);
    if (source !== undefined && !fetched(source) && !(await fetchSource(id)))
      return;
    await enablePlugin(id, name, true);
  }

  /** What a plugin's row says of it, and nothing while there is nothing
      to say: a plugin of a source that has not been fetched has neither a
      process nor a manifest behind it. */
  function rowState(source: PluginSource, plugin: PluginInfo): string | null {
    if (plugins.fetching === source.id) return "fetching";
    if (!fetched(source)) return null;
    return `${summary(plugin)} · ${stateLabel(plugin)}`;
  }

  /** The row for agents talking to Chord, lit for a moment when the dialog
      was opened to point at it. */
  let live = $state<HTMLElement | null>(null);
  let lit = $state(false);
  onMount(() => {
    if (settings.highlight !== "hooks") return;
    settings.highlight = null;
    show("sessions");
    void tick().then(() => live?.scrollIntoView({ block: "center" }));
    lit = true;
    const timer = setTimeout(() => (lit = false), 2600);
    return () => clearTimeout(timer);
  });

  /** Whether the "More" fold of the appearance tab is open. */
  let moreOpen = $state(
    Object.keys(theme.backgrounds ?? {}).length > 0 || userStyles.on || userStyles.problem !== null,
  );
  /** How many things inside the fold are in use. */
  let moreSet = $derived(
    Object.keys(theme.backgrounds ?? {}).length + (userStyles.on ? 1 : 0) + (userStyles.problem !== null ? 1 : 0),
  );

  /** The projects the hooks answer covers: the open ones, and the
      orchestrator folder while the sessions pane lists it. */
  let hooked = $derived(hookedProjects());

  /** How many of them have a word of their own. */
  let overridden = $derived(hooked.filter((path) => overrideOf(path) !== null).length);
  // The per-project words are the rare case: folded away unless one is in use.
  let overridesOpen = $state(false);
  $effect(() => {
    if (overridden > 0) overridesOpen = true;
  });

  /** The answer for every project, applied at once to the ones it covers
      now. */
  function setHooksEverywhere(on: boolean) {
    if (hook.everywhere !== on) void setEverywhere(on, hookedProjects());
  }

  /** A project's own word, or none to follow the rest; asking for what it has is nothing. */
  function setHooks(path: string, value: boolean | null) {
    if (overrideOf(path) !== value) void setOverride(path, value);
  }

  /** The form for an account of your own: a name, and the two directories
      it suggests, each shown as it will be and opened for editing with
      the pencil. A directory not opened follows the name as it is typed;
      one that was keeps what was typed into it. */
  let addingAccount = $state(false);
  let accountName = $state("");
  let ownClaude = $state<string | null>(null);
  let ownCodex = $state<string | null>(null);
  let accountProblem = $state<string | null>(null);
  const suggested = $derived(suggest(accountName));
  const claudeDir = $derived(ownClaude ?? suggested.claude ?? "");
  const codexDir = $derived(ownCodex ?? suggested.codex ?? "");

  function openAccountForm() {
    accountName = "";
    ownClaude = null;
    ownCodex = null;
    accountProblem = null;
    addingAccount = true;
  }

  /** The account is added, and every project the hooks answer covers is
      brought to it again, since the server goes into each account's state. */
  function submitAccount(e: SubmitEvent) {
    e.preventDefault();
    const problem = addAccount(accountName, { claude: claudeDir, codex: codexDir });
    if (problem !== null) {
      accountProblem = problem;
      return;
    }
    addingAccount = false;
    void reapply(hookedProjects());
  }

  function dropAccount(name: string) {
    removeAccount(name);
    void reapply(hookedProjects());
  }

  /** How many open projects have an account of their own. */
  let accountOverridden = $derived(
    workspace.open.filter((project) => accountOverrideOf(project.path) !== undefined).length,
  );
  let accountOverridesOpen = $state(false);
  $effect(() => {
    if (accountOverridden > 0) accountOverridesOpen = true;
  });

  /** What new sessions of an agent start on, as its row says it. */
  function chosenLine(agent: AgentId): string {
    const kept = chosenFor(agent);
    const parts = [
      kept.model === undefined ? null : modelLabel(agent, kept.model),
      // A terminal takes no effort from the workbench.
      kept.effort === undefined
        ? null
        : kindFor(agent) === "terminal"
          ? `${effortName(kept.effort)} in conversations`
          : effortName(kept.effort),
      kept.mode === undefined ? null : modeName(agent, kept.mode),
    ].filter((part) => part !== null);
    return parts.length === 0 ? "Its own defaults" : parts.join(" · ");
  }

  function dirsLine(name: string): string {
    const dirs = accounts.list[name];
    return [
      dirs.claude === null ? null : `Claude Code ${dirs.claude}`,
      dirs.codex === null ? null : `Codex ${dirs.codex}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function record(action: ActionKey) {
    recording = action;
    problem = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (recording !== null) {
      // Every key is ours while recording: the shortcut, or Escape to give up.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = null;
        return;
      }
      const chord = chordFromEvent(e);
      if (chord === null) return;
      const text = setBinding(recording, chord);
      problem = text === null ? null : { action: recording, text };
      recording = null;
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    }
  }

  function reset(action: ActionKey) {
    const text = resetBinding(action);
    problem = text === null ? null : { action, text };
  }

  /** Whether a shortcut is something other than the default's. */
  function changed(action: ActionKey): boolean {
    return !sameChord(keys.bindings[action], PRESETS.default[action]);
  }

  function resetAll() {
    problem = null;
    applyPreset("default");
  }

  /** Off macOS, the close shortcut with Shift added, which closes from a
      terminal too. */
  const also = $derived(closeAlso());

  const groups = $derived(
    ACTIONS.reduce<{ name: string; actions: typeof ACTIONS }[]>((out, action) => {
      const last = out[out.length - 1];
      if (last?.name === action.group) last.actions.push(action);
      else out.push({ name: action.group, actions: [action] });
      return out;
    }, []),
  );
</script>

<!-- A click on the scrim closes, as Escape does; the dialog itself takes
     the keyboard, so Escape is handled there. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="scrim" onclick={closeSettings} use:coversBrowser data-testid="settings-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="settings"
    data-card
  >
    <header>
      <h2 id="settings-title">Settings</h2>
      <button
        class="close"
        onclick={closeSettings}
        aria-label="Close"
        title="Close (Esc)"
        data-testid="settings-close"
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 2.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="body">
      <nav aria-label="Settings sections" bind:this={tabs}>
        {#each TABS as item, index (item.name)}
          <button
            class="tab"
            class:on={tab === item.name}
            aria-current={tab === item.name ? "page" : undefined}
            tabindex={tab === item.name ? 0 : -1}
            onclick={() => show(item.name)}
            onkeydown={(e) => onTabKeys(e, index)}
            data-testid="settings-tab-{item.name}">{item.label}</button
          >
        {/each}
      </nav>

      <div class="panel" class:fill={tab === "workflows"}>
        {#if tab === "appearance"}
          <UnreadEntries field={["appearance", "look", "compact", "themes", "palette"]} />
          <div class="row">
            <span class="name">Mode</span>
            <div class="seg" role="radiogroup" aria-label="Mode">
              {#each THEMES as option (option.choice)}
                <button
                  role="radio"
                  aria-checked={theme.choice === option.choice}
                  class:on={theme.choice === option.choice}
                  onclick={() => setTheme(option.choice)}
                  title={option.hint}
                  data-testid="theme-{option.choice}">{option.label}</button
                >
              {/each}
            </div>
          </div>
          <div class="row">
            <span class="name">Look</span>
            <div class="seg" role="radiogroup" aria-label="Look">
              {#each LOOKS as look (look.name)}
                <button
                  role="radio"
                  aria-checked={theme.look === look.name}
                  class:on={theme.look === look.name}
                  onclick={() => setLook(look.name)}
                  title={look.hint}
                  data-testid="look-{look.name}">{look.label}</button
                >
              {/each}
            </div>
          </div>
          <div class="row">
            <span class="name">Colour</span>
            <div class="swatches" role="radiogroup" aria-label="Colour">
              {#each PALETTES as palette (palette.name)}
                <button
                  class="swatch"
                  role="radio"
                  aria-checked={theme.palette === palette.name}
                  class:on={theme.palette === palette.name}
                  onclick={() => setPalette(palette.name)}
                  data-testid="palette-{palette.name}"
                >
                  <span
                    class="dot"
                    style:background={resolvedTheme() === "dark" ? palette.swatch.dark : palette.swatch.light}
                  ></span>
                  {palette.label}
                </button>
              {/each}
              {#each Object.entries(theme.themes) as [name, own] (name)}
                <span class="own" class:on={theme.palette === name}>
                  <button
                    class="swatch"
                    role="radio"
                    aria-checked={theme.palette === name}
                    class:on={theme.palette === name}
                    onclick={() => setPalette(name)}
                    data-testid="palette-{name}"
                  >
                    <span
                      class="dot"
                      style:background={own[resolvedTheme()].accent ?? DEFAULTS[resolvedTheme()].accent}
                    ></span>
                    {own.label}
                  </button>
                  <button
                    class="forget"
                    onclick={() => deleteTheme(name)}
                    aria-label="Delete the theme {own.label}"
                    title="Delete the theme"
                    data-testid="theme-delete-{name}">×</button
                  >
                </span>
              {/each}
            </div>
          </div>
          <div class="row">
            <span class="name" id="compact-label">Compact</span>
            <Switch on={compact.on} onchange={setCompact} labelledby="compact-label" testid="compact" />
          </div>
          <UnreadEntries field={["terminalFont", "interfaceFont"]} />
          <div class="row">
            <span class="name">Terminal font</span>
            <div class="swatches" role="radiogroup" aria-label="Terminal font">
              {#each TERMINAL_FONTS as font (font.name)}
                <button
                  class="swatch face"
                  role="radio"
                  aria-checked={theme.mono === font.name}
                  class:on={theme.mono === font.name}
                  onclick={() => setMono(font.name)}
                  data-testid="mono-{font.name}"
                >
                  <span style:font-family={font.family}>{font.label}</span>
                  {#if font.hint}<span class="face-hint">{font.hint}</span>{/if}
                </button>
              {/each}
            </div>
          </div>
          <div class="row">
            <span class="name">Interface font</span>
            <div class="swatches" role="radiogroup" aria-label="Interface font">
              {#each INTERFACE_FONTS as font (font.name)}
                <button
                  class="swatch face"
                  role="radio"
                  aria-checked={theme.sans === font.name}
                  class:on={theme.sans === font.name}
                  onclick={() => setSans(font.name)}
                  data-testid="sans-{font.name}"
                >
                  <span style:font-family={font.family}>{font.label}</span>
                  {#if font.hint}<span class="face-hint">{font.hint}</span>{/if}
                </button>
              {/each}
            </div>
          </div>

          <button
            class="fold"
            onclick={() => (moreOpen = !moreOpen)}
            aria-expanded={moreOpen}
            data-testid="appearance-more"
          >
            <span class="chevron">{moreOpen ? "▾" : "▸"}</span>
            More
            {#if !moreOpen && moreSet > 0}<span class="count">, {moreSet} set</span>{/if}
          </button>
          {#if moreOpen}
            <UnreadEntries field="backgrounds" />
            <div class="row stack">
              <span class="name">Background image</span>
              <BackgroundPicker />
            </div>
            <UnreadEntries field="userStyles" />
            <div class="row">
              <span class="name" id="styles-label"
                >Custom styles<small data-testid="styles-note">
                  {#if userStyles.problem !== null}
                    Not used, for the reason below.
                  {:else if userStyles.css === ""}
                    None yet in ~/.chord/user.css.
                  {:else}
                    {@const lines = userStyles.css.trimEnd().split("\n").length}
                    ~/.chord/user.css has {lines} {lines === 1 ? "line" : "lines"}.
                  {/if}
                </small></span
              >
              <Switch on={userStyles.on} onchange={setUserStyles} labelledby="styles-label" testid="styles" />
            </div>
            {#if userStyles.problem !== null}
              <p class="note problem" data-testid="styles-problem">
                {userStyles.problem[0].toUpperCase()}{userStyles.problem.slice(1)}.
              </p>
            {/if}
          {/if}
        {:else if tab === "sessions"}
          <section data-testid="settings-sessions">
            <h3>Run</h3>
            <div data-testid="session-kinds">
              {#each installed().length > 0 ? installed() : AGENTS as id (id)}
                <div class="row" data-testid="session-kind" data-agent={id}>
                  <span class="name">{agentLabel(id)}</span>
                  {#if canIntegrate(id)}
                    <div class="seg" role="radiogroup" aria-label="Where {agentLabel(id)} sessions run">
                      <button
                        role="radio"
                        aria-checked={kindFor(id) === "integrated"}
                        class:on={kindFor(id) === "integrated"}
                        onclick={() => setKind(id, "integrated")}
                        data-testid="session-kind-integrated">In Chord</button
                      >
                      <button
                        role="radio"
                        aria-checked={kindFor(id) === "terminal"}
                        class:on={kindFor(id) === "terminal"}
                        onclick={() => setKind(id, "terminal")}
                        data-testid="session-kind-terminal">In a terminal</button
                      >
                    </div>
                  {:else}
                    <span class="value fixed" title="Runs only in a terminal" data-testid="session-kind-only">In a terminal</span>
                  {/if}
                </div>
              {/each}
            </div>
            <div class="hooks" class:lit bind:this={live} data-testid="settings-live">
              <UnreadEntries field="hooks" />
              <div class="row" data-testid="hooks-everywhere-row">
                <span class="name"
                  ><span id="hooks-label">Let agents talk to Chord</span
                  ><small id="hooks-hint">Shows when an agent works, waits or asks.</small></span
                >
                <Switch
                  on={hook.everywhere}
                  onchange={setHooksEverywhere}
                  disabled={hook.busy}
                  labelledby="hooks-label"
                  describedby="hooks-hint"
                  testid="hooks-everywhere"
                />
              </div>
              {#if hooked.length > 0}
                <button
                  class="fold"
                  onclick={() => (overridesOpen = !overridesOpen)}
                  aria-expanded={overridesOpen}
                  data-testid="hooks-overrides"
                >
                  <span class="chevron">{overridesOpen ? "▾" : "▸"}</span>
                  By project{overridden > 0 ? ` (${overridden})` : ""}
                </button>
              {/if}
              {#if overridesOpen}
                {#each hooked as path (path)}
                  {@const own = overrideOf(path)}
                  <div class="row sub" data-testid="hooks-row" data-project={path}>
                    <span class="name" title={path}>{projectLabel(path)}</span>
                    <div class="seg" role="radiogroup" aria-label="Talk to Chord in {projectLabel(path)}">
                      <button
                        role="radio"
                        aria-checked={own === null}
                        class:on={own === null}
                        onclick={() => setHooks(path, null)}
                        disabled={hook.busy}
                        data-testid="hooks-default">As above</button
                      >
                      <button
                        role="radio"
                        aria-checked={own === false}
                        class:on={own === false}
                        onclick={() => setHooks(path, false)}
                        disabled={hook.busy}
                        data-testid="hooks-off">Off</button
                      >
                      <button
                        role="radio"
                        aria-checked={own === true}
                        class:on={own === true}
                        onclick={() => setHooks(path, true)}
                        disabled={hook.busy}
                        data-testid="hooks-on">On</button
                      >
                    </div>
                  </div>
                {/each}
              {/if}
              {#if hook.error}
                <p class="error" data-testid="hook-error">{hook.error}</p>
              {/if}
            </div>

            <h3>New sessions</h3>
            <UnreadEntries field="lastChosen" />
            <div data-testid="chosen-list">
              {#each installed().length > 0 ? installed() : AGENTS as id (id)}
                <div class="row" data-testid="chosen" data-agent={id}>
                  <span class="name">Start {agentLabel(id)} on</span>
                  <span class="value" data-testid="chosen-line">{chosenLine(id)}</span>
                  {#if anyChosen(id)}
                    <button
                      class="tool"
                      onclick={() => forgetChosen(id)}
                      aria-label="Start new {agentLabel(id)} sessions on its own defaults"
                      data-testid="chosen-forget">Use defaults</button
                    >
                  {/if}
                </div>
              {/each}
            </div>
            <UnreadEntries field="askEveryStart" />
            <div class="row">
              <span class="name">Ask before a session starts another</span>
              <div class="seg" role="radiogroup" aria-label="Ask before a session starts another">
                <button
                  role="radio"
                  aria-checked={!startAsk.every}
                  class:on={!startAsk.every}
                  onclick={() => setAskEveryStart(false)}
                  data-testid="ask-start-outside">Outside its project</button
                >
                <button
                  role="radio"
                  aria-checked={startAsk.every}
                  class:on={startAsk.every}
                  onclick={() => setAskEveryStart(true)}
                  data-testid="ask-start-every">Every time</button
                >
              </div>
            </div>

            <h3>Past sessions</h3>
            <UnreadEntries field="pastSessions" />
            <div class="row">
              <label class="name" for="past-sessions"
                >Keep listed<small>Older ones move to Earlier. Nothing is deleted.</small></label
              >
              <select
                id="past-sessions"
                class="pick"
                value={sessions.pastSessions}
                onchange={(e) => setPastSessions(e.currentTarget.value as typeof sessions.pastSessions)}
                data-testid="past-sessions"
              >
                {#each PAST_SESSIONS as span (span.choice)}
                  <option value={span.choice}>{span.label}</option>
                {/each}
              </select>
            </div>
            <UnreadEntries field="inactiveAfter" />
            <div class="row">
              <label class="name" for="inactive-after">Fold inactive projects after</label>
              <select
                id="inactive-after"
                class="pick"
                value={projects.inactiveAfter}
                onchange={(e) => setInactiveAfter(e.currentTarget.value as typeof projects.inactiveAfter)}
                data-testid="inactive-after"
              >
                {#each INACTIVE_AFTER as span (span.choice)}
                  <option value={span.choice}>{span.label}</option>
                {/each}
              </select>
            </div>
          </section>
        {:else if tab === "workflows"}
          <WorkflowsTab />
        {:else if tab === "accounts"}
          <section data-testid="settings-accounts">
            <UnreadEntries field="accounts" />
            <p class="note">Each account keeps its own sign-in.</p>
            <div class="account" data-testid="account-row" data-account="">
              <span class="account-name">{OWN_LABEL}</span>
              <span class="account-meta">Claude Code ~/.claude · Codex ~/.codex</span>
            </div>
            {#each names() as name (name)}
              <div class="account" data-testid="account-row" data-account={name}>
                <span class="account-name">{name}</span>
                <span class="account-meta">{dirsLine(name)}</span>
                <button class="tool" onclick={() => dropAccount(name)} data-testid="account-remove">Remove</button>
              </div>
            {/each}
            {#if addingAccount}
              <form class="account-form" onsubmit={submitAccount} data-testid="account-form">
                <label class="field">
                  <span class="field-what">Name</span>
                  <input
                    type="text"
                    bind:value={accountName}
                    placeholder="Work"
                    data-testid="account-name"
                  />
                </label>
                {#each [["claude", "Claude Code"], ["codex", "Codex"]] as [agent, what] (agent)}
                  {@const own = agent === "claude" ? ownClaude : ownCodex}
                  {@const dir = agent === "claude" ? claudeDir : codexDir}
                  <div class="field">
                    <span class="field-what">{what}</span>
                    {#if own === null}
                      <span class="path" data-testid="account-{agent}">{dir}</span>
                      <button
                        type="button"
                        class="pencil"
                        aria-label="Change the {what} directory"
                        onclick={() => {
                          if (agent === "claude") ownClaude = dir;
                          else ownCodex = dir;
                        }}
                        data-testid="account-{agent}-edit">✎</button
                      >
                    {:else if agent === "claude"}
                      <input type="text" class="dir" bind:value={ownClaude} data-testid="account-claude-dir" />
                    {:else}
                      <input type="text" class="dir" bind:value={ownCodex} data-testid="account-codex-dir" />
                    {/if}
                  </div>
                {/each}
                {#if accountProblem !== null}
                  <p class="error" data-testid="account-problem">{accountProblem}</p>
                {/if}
                <div class="form-actions">
                  <button type="submit" class="go" disabled={accountName.trim() === ""} data-testid="account-add">Add</button>
                  <button type="button" class="tool" onclick={() => (addingAccount = false)} data-testid="account-cancel">Cancel</button>
                </div>
              </form>
            {:else}
              <button class="link" onclick={openAccountForm} data-testid="account-add-open">Add account</button>
            {/if}

            <h3>Use</h3>
            <div class="row" data-testid="account-everywhere">
              <span class="name">Every project</span>
              <div class="seg" role="radiogroup" aria-label="The account for every project">
                {#each [null, ...names()] as account (account ?? "")}
                  <button
                    role="radio"
                    aria-checked={accounts.everywhere === account}
                    class:on={accounts.everywhere === account}
                    onclick={() => setAccountEverywhere(account)}
                    data-testid="account-everywhere-option"
                    data-account={account ?? ""}>{account ?? OWN_LABEL}</button
                  >
                {/each}
              </div>
            </div>
            {#if workspace.open.length > 0}
              <button
                class="fold"
                onclick={() => (accountOverridesOpen = !accountOverridesOpen)}
                aria-expanded={accountOverridesOpen}
                data-testid="account-overrides"
              >
                <span class="chevron">{accountOverridesOpen ? "▾" : "▸"}</span>
                By project{accountOverridden > 0 ? ` (${accountOverridden})` : ""}
              </button>
            {/if}
            {#if accountOverridesOpen}
              {#each workspace.open as project (project.path)}
                {@const own = accountOverrideOf(project.path)}
                <div class="row sub" data-testid="account-project-row" data-project={project.path}>
                  <span class="name" title={project.path}>{projectLabel(project.path)}</span>
                  <div class="seg" role="radiogroup" aria-label="The account for {projectLabel(project.path)}">
                    <button
                      role="radio"
                      aria-checked={own === undefined}
                      class:on={own === undefined}
                      onclick={() => setAccountOverride(project.path, undefined)}
                      data-testid="account-project-default">As above</button
                    >
                    {#each [null, ...names()] as account (account ?? "")}
                      <button
                        role="radio"
                        aria-checked={own === account}
                        class:on={own === account}
                        onclick={() => setAccountOverride(project.path, account)}
                        data-testid="account-project-option"
                        data-account={account ?? ""}>{account ?? OWN_LABEL}</button
                      >
                    {/each}
                  </div>
                </div>
              {/each}
            {/if}
          </section>
        {:else if tab === "plugins"}
          <p class="note">Plugins run with your privileges. Turn on only ones you trust.</p>
          {#if plugins.error}
            <p class="error" data-testid="plugin-error">{plugins.error}</p>
          {/if}
          {#if plugins.sources.some(fetched)}
            <div class="sources-tools">
              <button class="tool" onclick={() => void checkAll()} disabled={plugins.busy} data-testid="plugins-check-all"
                >Check for updates</button
              >
            </div>
          {/if}
          {#each ordered as source (source.id)}
            <div
              class="source"
              data-testid="plugin-source"
              data-source={source.id}
              data-known={source.known ? "true" : null}
              data-fetched={fetched(source) ? "true" : "false"}
            >
              <div class="source-head">
                <span class="source-name" title={source.location}>{lastSegment(source.location)}</span>
                <span class="source-meta">
                  {[
                    source.known ? "known" : null,
                    source.kind === "dir" ? "directory" : (source.commit?.slice(0, 7) ?? null),
                    source.reference,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {#if source.newer}
                  <button class="tool accent" onclick={() => void updateSource(source.id)} disabled={plugins.busy} data-testid="plugin-update"
                    >Update to {source.newer.slice(0, 7)}</button
                  >
                {/if}
                {#if source.kind === "git" && fetched(source)}
                  <button class="tool" onclick={() => void checkSource(source.id)} disabled={plugins.busy} data-testid="plugin-check"
                    >Check</button
                  >
                {/if}
                {#if fetched(source)}
                  <button
                    class="tool"
                    onclick={() => void removeSource(source.id)}
                    disabled={plugins.busy}
                    title={source.known ? "Removes the fetched copy; the source stays listed" : null}
                    data-testid="plugin-remove">Remove</button
                  >
                {/if}
              </div>
              {#if source.error}
                <p class="error">{source.error}</p>
              {/if}
              {#each source.plugins as plugin (plugin.name)}
                {@const state = rowState(source, plugin)}
                {@const hears = listensFor(plugin)}
                <div class="row plugin" data-testid="plugin-row" data-plugin={plugin.name}>
                  <div class="plugin-text">
                    <span class="name" id="plugin-{source.id}-{plugin.name}"
                      >{plugin.name}
                      {#if plugin.version}<span class="version">{plugin.version}</span>{/if}</span
                    >
                    {#if plugin.description}<span class="plugin-desc">{plugin.description}</span>{/if}
                    {#if hears !== null}
                      <span class="plugin-meta" data-testid="plugin-listens">{hears}</span>
                    {/if}
                    {#if state}
                      <span class="plugin-meta" data-testid="plugin-state">{state}</span>
                    {/if}
                  </div>
                  <Switch
                    on={plugin.enabled}
                    onchange={(next) => turn(source.id, plugin.name, next)}
                    disabled={plugins.busy}
                    labelledby="plugin-{source.id}-{plugin.name}"
                    testid="plugin"
                  />
                </div>
                {#if asking !== null && asking.id === source.id && asking.name === plugin.name}
                  <div class="ask" data-testid="plugin-ask">
                    <p>
                      {#if fetched(source)}
                        {plugin.name} runs <code>{plugin.run[0]}</code> with your privileges: {summary(plugin)}.{#if hears !== null}
                          {hears}, and is told that command's own words, its folder and whether it worked; its output
                          too, unless another command in the same line prints.{/if}
                      {:else}
                        {plugin.name} is fetched from <code>{lastSegment(source.location)}</code> and runs
                        with your privileges: {plugin.description}
                      {/if}
                      Turn it on?
                    </p>
                    <div class="ask-actions">
                      <button class="go" onclick={() => agree(source.id, plugin.name)} data-testid="plugin-agree">Turn on</button>
                      <button class="tool" onclick={() => (asking = null)} data-testid="plugin-cancel">Not now</button>
                    </div>
                  </div>
                {/if}
              {/each}
            </div>
          {/each}
          {#if addingSource}
            <form class="add-source" onsubmit={add}>
              <input
                type="text"
                placeholder="Repository URL or directory"
                bind:value={sourceLocation}
                disabled={plugins.busy}
                data-testid="plugin-location"
              />
              <input
                type="text"
                class="reference"
                placeholder="ref"
                bind:value={sourceReference}
                disabled={plugins.busy}
                data-testid="plugin-reference"
              />
              <button type="submit" disabled={plugins.busy || sourceLocation.trim() === ""} data-testid="plugin-add"
                >{plugins.busy ? "Working…" : "Add"}</button
              >
            </form>
          {:else}
            <button class="link" onclick={() => (addingSource = true)} data-testid="plugin-add-source"
              >Add a source…</button
            >
          {/if}
        {:else if tab === "notifications"}
          <UnreadEntries field={["notifications", "chime"]} />
          <div class="row">
            <span class="name" id="notifications-label">System notifications</span>
            <Switch
              on={notify.notifications}
              onchange={setNotifications}
              labelledby="notifications-label"
              testid="notifications"
            />
          </div>
          <div class="row">
            <span class="name" id="chime-label">Chime</span>
            <Switch on={notify.chime} onchange={setChime} labelledby="chime-label" testid="chime" />
          </div>
        {:else}
          <UnreadEntries field="keys" />
          <p class="note">
            Every shortcut uses {describe({ key: "", shift: false, alt: false }).replace(/\+$/, "")}; the keys
            without it belong to the agent.
          </p>
          <div class="row">
            <span class="name">Preset</span>
            <div class="seg" role="radiogroup" aria-label="Preset">
              {#each PRESET_NAMES as name (name)}
                <button
                  role="radio"
                  aria-checked={keys.preset === name}
                  class:on={keys.preset === name}
                  onclick={() => applyPreset(name)}
                  data-testid="preset-{name}">{PRESET_LABELS[name]}</button
                >
              {/each}
              {#if keys.preset === "custom"}
                <span class="custom" data-testid="preset-custom">Custom</span>
              {/if}
            </div>
          </div>

          {#each groups as group (group.name)}
            <h3>{group.name}</h3>
            {#each group.actions as action (action.key)}
              <div class="row" class:problem={problem?.action === action.key}>
                <span class="name"
                  >{action.label}{#if action.key === "file.close" && also !== null}<small
                      data-testid="chord-also">Also {describe(also)}, which works in a terminal</small
                    >{/if}</span
                >
                {#if changed(action.key)}
                  <button
                    class="link reset"
                    onclick={() => reset(action.key)}
                    aria-label="Reset the shortcut for {action.label}"
                    data-testid="reset-{action.key}">Reset</button
                  >
                {/if}
                <button
                  class="chord"
                  class:recording={recording === action.key}
                  onclick={() => record(action.key)}
                  aria-label="Change the shortcut for {action.label}"
                  data-testid="chord-{action.key}"
                >
                  {recording === action.key ? "Press keys…" : describe(keys.bindings[action.key])}
                </button>
              </div>
              {#if problem?.action === action.key}
                <p class="explain" data-testid="chord-problem">{problem.text}</p>
              {/if}
            {/each}
          {/each}
          <div class="row end">
            <button class="tool" onclick={resetAll} data-testid="reset-all">Reset all shortcuts</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* One size for every tab, so nothing moves when the tab changes; it is
     what the workflows' diagram and a step's settings need side by side. */
  .dialog {
    width: min(1100px, 92vw);
    height: min(820px, 92vh);
    display: flex;
    flex-direction: column;
    background: var(--paint-surface);
    border: 1px solid var(--pane-border-on);
    border-radius: var(--radius-pane);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    overflow: hidden;
    outline: none;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  h2 {
    margin: 0;
    font-family: var(--chrome);
    font-size: var(--title-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--title-weight);
    color: var(--accent);
  }

  .close {
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

  .close:hover {
    background: var(--accent-soft);
    color: var(--ink);
  }

  .close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 168px minmax(0, 1fr);
  }

  /* The tabs stand on a ground a shade below the dialog's own, with the
     column they open beside them, scrolling on its own. */
  nav {
    --pane-bg: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--pane-bg);
    border-right: 1px solid var(--divider, var(--rule));
    overflow-y: auto;
  }

  .tab {
    text-align: left;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-2);
    cursor: pointer;
  }

  .tab:hover {
    background: var(--paint-surface);
    color: var(--ink);
  }

  .tab.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .panel {
    min-width: 0;
    overflow-y: auto;
    padding: 6px var(--pane-pad) 16px;
  }

  /* The other tabs keep the width they read at, centred in the panel. */
  .panel:not(.fill) > * {
    max-width: 640px;
    margin-inline: auto;
  }

  /* The workflows fill the panel and scroll their own parts. */
  .panel.fill {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel > h3:first-child {
    margin-top: 0;
  }

  h3 {
    margin: 14px 0 6px;
    font-family: var(--chrome);
    font-size: var(--heading-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
  }


  /* The row lights up when the dialog was opened to point at it. */
  .hooks {
    margin: 0 -10px;
    padding: 0 10px;
    border-radius: var(--radius);
    outline: 1px solid transparent;
    outline-offset: -1px;
  }

  .hooks.lit {
    animation: lit 2.6s ease-out forwards;
  }

  @keyframes lit {
    0%,
    45% {
      outline-color: var(--accent);
    }
    100% {
      outline-color: transparent;
    }
  }

  /* A setting is its name and its control, with at most one short line
     under the name. */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 36px;
    padding: 5px 0;
    border-top: 1px solid var(--divider, var(--rule));
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink);
  }

  .row.sub {
    padding-left: 14px;
  }

  .row.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .row.end {
    justify-content: flex-end;
    border-top: 0;
    padding-top: 14px;
  }

  .row.problem .name {
    color: var(--del);
  }

  .name {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }

  .name small {
    font-family: var(--sans);
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .value {
    font-size: 12px;
    color: var(--ink-3);
    text-align: right;
  }

  .value.fixed {
    font-style: italic;
    opacity: 0.8;
  }

  .count {
    color: var(--ink-3);
  }

  .pick {
    padding: 3px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
    color: var(--ink);
    font-family: var(--chrome);
    font-size: var(--field-size);
  }

  .reset {
    margin: 0;
    padding: 0 4px;
  }

  .explain {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--del);
  }

  .note {
    margin: 0 0 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .note.problem {
    color: var(--del);
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 12px 0 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 0;
  }

  .fold:hover {
    color: var(--ink);
  }

  .error {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--del);
    max-width: 64ch;
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .seg button {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button:last-of-type {
    border-right: 0;
  }

  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  /* The name of a family is set in that family, so the choice can be seen. */
  .swatch.face {
    gap: 6px;
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    padding: 4px 10px;
  }

  .face-hint {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--ink-3);
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .swatch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .swatch.on {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }

  /* One of the user's own themes: its swatch, and a way to delete it, held
     together so the pair wraps as one. */
  .own {
    display: inline-flex;
    align-items: stretch;
  }

  .own .swatch {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .forget {
    padding: 0 7px;
    border: 1px solid var(--rule);
    border-left: none;
    border-radius: 0 var(--radius) var(--radius) 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .own.on .forget {
    border-color: var(--accent);
  }

  .forget:hover {
    color: var(--del);
  }

  .custom {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    color: var(--accent);
    border-left: 1px solid var(--rule);
  }

  .chord {
    min-width: 72px;
    font-family: var(--mono);
    font-size: var(--field-size);
    padding: 2px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
  }

  .chord.recording {
    border-color: var(--accent);
    color: var(--accent);
  }

  .tool {
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--accent);
  }
  /* Accounts: a row per account, and the form for one of your own under
     them, its directories shown as they will be until the pencil opens one. */
  .account {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 0;
    border-top: 1px solid var(--rule);
  }

  .account:first-of-type {
    border-top: 0;
  }

  .account-name {
    flex: 0 0 90px;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-meta {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 0;
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    max-width: 520px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .field-what {
    flex: 0 0 76px;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink-2);
  }

  .field input,
  .field .path {
    flex: 0 0 260px;
    width: 260px;
    min-width: 0;
    box-sizing: border-box;
    padding: 5px 8px;
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  .field input {
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--clear-surface);
  }

  .field input.dir,
  .field .path {
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .field .path {
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pencil {
    flex: none;
    border: 0;
    background: none;
    font-size: 12px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 4px;
  }

  .pencil:hover {
    color: var(--accent);
  }

  .form-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .form-actions button,
  .account .tool {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .form-actions .go {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .form-actions .go:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Plugin sources: each source with its plugins, and a form under them
     for one of your own. */
  .add-source {
    display: flex;
    gap: 6px;
    margin: 8px 0 0;
  }

  .link {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    margin: 8px 0 0;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .link:hover {
    color: var(--accent);
  }

  .add-source input {
    flex: 1;
    min-width: 0;
    font-family: var(--chrome);
    font-size: var(--field-size);
    padding: 5px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--clear-surface);
    color: var(--ink);
  }

  .add-source input.reference {
    flex: 0 0 80px;
  }

  .add-source button,
  .sources-tools .tool,
  .source-head .tool,
  .ask .tool,
  .ask .go {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .add-source button:disabled,
  .source-head .tool:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .source-head .tool.accent,
  .ask .go {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .sources-tools {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 6px;
  }

  .source {
    border-top: 1px solid var(--divider, var(--rule));
    padding: 8px 0 4px;
  }

  .source-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
  }

  .source-name {
    font-family: var(--chrome);
    font-size: 11.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .source-meta {
    flex: 1;
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .plugin {
    align-items: flex-start;
  }

  .plugin :global(.switch) {
    margin-top: 2px;
  }

  .plugin-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .plugin-text .version {
    font-size: 10.5px;
    color: var(--ink-3);
    font-weight: 400;
  }

  .plugin-desc {
    font-size: 12px;
    color: var(--ink-2);
  }

  .plugin-meta {
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .ask {
    margin: 0 0 8px;
    padding: 8px 10px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
  }

  .ask p {
    margin: 0 0 8px;
    font-size: 12.5px;
    color: var(--ink);
  }

  .ask-actions {
    display: flex;
    gap: 6px;
  }
</style>
