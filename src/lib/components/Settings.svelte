<script module lang="ts">
  /** The columns of settings, one on screen at a time. */
  type Tab = "appearance" | "sessions" | "agents" | "setup" | "accounts" | "plugins" | "keys" | "notifications";

  /** The tab last chosen. It belongs to the module rather than the dialog, so
      closing the settings and opening them again lands where you were; a new
      window starts on the first. */
  let remembered: Tab = "appearance";
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import {
    ACTIONS,
    PRESET_LABELS,
    PRESETS,
    applyPreset,
    describe,
    firstStepFromEvent,
    keys,
    resetBinding,
    sameChord,
    secondStepFromEvent,
    setBinding,
    type ActionKey,
    type Chord,
    type PresetName,
  } from "$lib/keys.svelte";
  import { SEQUENCE_TIMEOUT, closeAlso } from "$lib/keymap";
  import { isMac } from "$lib/platform";
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
  import { core, type HarnessId, type PluginInfo, type PluginSource } from "$lib/core";
  import { checkSetup, setup } from "$lib/setup.svelte";
  import { blocked, unsure } from "$lib/setupRows";
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
  import { HARNESSES, harnessLabel, installed } from "$lib/harness.svelte";
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
  import { wrap, setWrap } from "$lib/wrap.svelte";
  import { notify, setChime, setNotifications } from "$lib/notify.svelte";
  import { setAskEveryStart, startAsk } from "$lib/startAsk.svelte";
  import { setAgentsOn, setNotesOn, switches } from "$lib/switches.svelte";
  import { anyChosen, chosenFor, forget as forgetChosen } from "$lib/lastChosen.svelte";
  import { modelLabel } from "$lib/models";
  import { modeName } from "$lib/modeFit";
  import { effortName } from "$lib/settingChoices";
  import Switch from "$lib/components/Switch.svelte";
  import Icon from "$lib/components/conversation/Icon.svelte";
  import BackgroundPicker from "$lib/components/BackgroundPicker.svelte";
  import UnreadEntries from "$lib/components/UnreadEntries.svelte";
  import AgentsTab from "$lib/components/AgentsTab.svelte";
  import SetupChecks from "$lib/components/SetupChecks.svelte";

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

  const ALL_TABS: { name: Tab; label: string }[] = [
    { name: "appearance", label: "Appearance" },
    { name: "sessions", label: "Sessions" },
    { name: "agents", label: "Agents" },
    { name: "setup", label: "Setup" },
    { name: "accounts", label: "Accounts" },
    { name: "plugins", label: "Plugins" },
    { name: "keys", label: "Keys" },
    { name: "notifications", label: "Notifications" },
  ];

  /** The tabs shown: the Agents tab only while agents are switched on. */
  const TABS = $derived(ALL_TABS.filter((item) => item.name !== "agents" || switches.agents));

  let dialog: HTMLElement;
  /** The action whose shortcut is being recorded, if any. */
  let recording = $state<ActionKey | null>(null);
  /** The action and first step just recorded, while a second key may
      still follow to make a sequence of them, and what is wrong with the
      first step alone, shown only if it stays alone. */
  let following = $state<{ action: ActionKey; first: Chord; problem: string | null } | null>(null);
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  let problem = $state<{ action: ActionKey; text: string } | null>(null);

  let tabs: HTMLElement;
  let tab = $state<Tab>(landing(settings.setup ? "setup" : settings.newAgent ? "agents" : remembered));

  /** The tab to land on for the one wanted: Sessions for the Agents tab
      while agents are switched off. */
  function landing(wanted: Tab): Tab {
    return wanted === "agents" && !switches.agents ? "sessions" : wanted;
  }

  // Agents switched off from elsewhere while the Agents tab is shown.
  $effect(() => {
    if (tab !== landing(tab)) tab = landing(tab);
  });

  let agentsTab: AgentsTab | undefined = $state();

  /** The tab picked again goes back to its top: the Agents tab to its lists. */
  function show(next: Tab) {
    if (next === tab && next === "agents") agentsTab?.home();
    if (next === "setup" && next !== tab) void checkSetup();
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

  /** Opened on a new agent: its form, on the Agents tab. */
  onMount(() => {
    if (!settings.newAgent) return;
    settings.newAgent = false;
    if (!switches.agents) return;
    remembered = "agents";
    agentsTab?.create();
  });

  /** Opened on the Setup tab, or landing on it: the machine read again. */
  onMount(() => {
    if (settings.setup) {
      settings.setup = false;
      remembered = "setup";
    }
    if (tab === "setup") void checkSetup();
  });

  /** What stands between the machine and a session, once read, or that
      the read could not tell. */
  const setupDemand = $derived(
    unsure(setup.found, setup.error) ?? (setup.found ? blocked(setup.found) : null),
  );

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

  /** Whether the background image's row is open: from the start while
      the palette in use has an image, which is what the row's end says. */
  let backgroundOpen = $state(Object.hasOwn(theme.backgrounds ?? {}, theme.palette));

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
  function chosenLine(agent: HarnessId): string {
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
    stopFollowing();
    recording = action;
    problem = null;
  }

  function stopFollowing() {
    if (followTimer !== null) clearTimeout(followTimer);
    followTimer = null;
    following = null;
  }

  /** No second key came: the first step stays alone, with its problem. */
  function endFollowing() {
    const ended = following;
    stopFollowing();
    if (ended?.problem != null) problem = { action: ended.action, text: ended.problem };
  }

  function bind(action: ActionKey, chord: Chord) {
    const text = setBinding(action, chord);
    problem = text === null ? null : { action, text };
  }

  /** Keys that are never a second step: they end the recording and do what
      they always do, move on, close, or open and close the settings. */
  function endsRecording(e: KeyboardEvent): boolean {
    if (e.key === "Tab" || e.key === "Escape") return true;
    return (e.metaKey || e.ctrlKey) && ["w", ","].includes(e.key.toLowerCase());
  }

  $effect(() => stopFollowing);

  function onKeydown(e: KeyboardEvent) {
    if (recording !== null) {
      // Every key is ours while recording: the shortcut, or Escape to give up.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = null;
        return;
      }
      const first = firstStepFromEvent(e);
      if (first === null) return;
      // The chord is bound as it is, and for as long as a sequence waits a
      // second key makes a sequence of it instead.
      // What is wrong with it alone waits until no second key comes.
      const action = recording;
      recording = null;
      problem = null;
      following = { action, first, problem: setBinding(action, first) };
      followTimer = setTimeout(endFollowing, SEQUENCE_TIMEOUT);
      return;
    }
    if (following !== null && endsRecording(e)) {
      endFollowing();
    } else if (following !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const second = secondStepFromEvent(e, following.first);
      if (second === undefined) return;
      const { action, first } = following;
      if (second === null) {
        endFollowing();
        return;
      }
      stopFollowing();
      bind(action, { ...first, then: second });
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
    class="dialog s-dialog"
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
    <nav aria-label="Settings sections" bind:this={tabs}>
      <h2 class="title" id="settings-title" data-testid="settings-title">Settings</h2>
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

    <div class="main">
      <div class="head">
        <h2 class="title page" data-testid="settings-heading">{TABS.find((item) => item.name === tab)?.label}</h2>
        {#if tab === "setup"}
          <button class="s-btn ground" onclick={() => void core().welcomeShow()} data-testid="setup-welcome"
            >Show welcome</button
          >
          <button
            class="s-btn ground"
            onclick={() => void checkSetup(true)}
            disabled={setup.busy}
            data-testid="setup-check">{setup.busy ? "Checking" : "Check again"}</button
          >
        {:else if tab === "plugins" && plugins.sources.some(fetched)}
          <button
            class="s-btn ground"
            onclick={() => void checkAll()}
            disabled={plugins.busy}
            data-testid="plugins-check-all">Check for updates</button
          >
        {/if}
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
      </div>

      <div class="scroll" data-testid="settings-scroll">
        <div class="col">
          {#if tab === "appearance"}
            <div class="s-grp">
              <UnreadEntries field={["appearance", "look", "compact", "wordWrap", "themes", "palette"]} />
              <div class="s-card">
                <div class="s-row">
                  <span class="s-name">Mode</span>
                  <div class="s-ctl">
                    <div class="s-seg" role="radiogroup" aria-label="Mode">
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
                </div>
                <div class="s-row">
                  <span class="s-name">Look</span>
                  <div class="s-ctl">
                    <div class="s-seg" role="radiogroup" aria-label="Look">
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
                </div>
                <div class="s-row">
                  <span class="s-name">Colour</span>
                  <div class="s-ctl s-chips" role="radiogroup" aria-label="Colour">
                    {#each PALETTES as palette (palette.name)}
                      <button
                        class="s-chip"
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
                      <span class="s-own" class:on={theme.palette === name}>
                        <button
                          class="s-chip"
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
                          class="del"
                          onclick={() => deleteTheme(name)}
                          aria-label="Delete the theme {own.label}"
                          title="Delete the theme"
                          data-testid="theme-delete-{name}"><Icon name="x" size={10} /></button
                        >
                      </span>
                    {/each}
                  </div>
                </div>
                <div class="s-row">
                  <span class="s-name" id="compact-label">Compact</span>
                  <div class="s-ctl">
                    <Switch on={compact.on} onchange={setCompact} labelledby="compact-label" testid="compact" />
                  </div>
                </div>
                <div class="s-row">
                  <span class="s-name" id="wrap-label">Wrap long lines in the editor</span>
                  <div class="s-ctl">
                    <Switch on={wrap.on} onchange={setWrap} labelledby="wrap-label" testid="wrap" />
                  </div>
                </div>
              </div>
            </div>

            <div class="s-grp">
              <UnreadEntries field={["terminalFont", "interfaceFont"]} />
              <div class="s-card">
                <div class="s-row">
                  <span class="s-name"
                    >Terminal font{#each TERMINAL_FONTS.filter((font) => font.hint) as font (font.name)}<small
                        id="mono-hint-{font.name}"
                        data-testid="mono-hint">{font.label} is {font.hint}.</small
                      >{/each}</span
                  >
                  <div class="s-ctl">
                    <div class="s-seg" role="radiogroup" aria-label="Terminal font">
                      {#each TERMINAL_FONTS as font (font.name)}
                        <button
                          class="face"
                          role="radio"
                          aria-checked={theme.mono === font.name}
                          class:on={theme.mono === font.name}
                          onclick={() => setMono(font.name)}
                          aria-describedby={font.hint ? `mono-hint-${font.name}` : null}
                          style:font-family={font.family}
                          data-testid="mono-{font.name}">{font.label}</button
                        >
                      {/each}
                    </div>
                  </div>
                </div>
                <div class="s-row">
                  <span class="s-name"
                    >Interface font{#each INTERFACE_FONTS.filter((font) => font.hint) as font (font.name)}<small
                        id="sans-hint-{font.name}"
                        data-testid="sans-hint">{font.label} is {font.hint}.</small
                      >{/each}</span
                  >
                  <div class="s-ctl">
                    <div class="s-seg" role="radiogroup" aria-label="Interface font">
                      {#each INTERFACE_FONTS as font (font.name)}
                        <button
                          class="face"
                          role="radio"
                          aria-checked={theme.sans === font.name}
                          class:on={theme.sans === font.name}
                          onclick={() => setSans(font.name)}
                          aria-describedby={font.hint ? `sans-hint-${font.name}` : null}
                          style:font-family={font.family}
                          data-testid="sans-{font.name}">{font.label}</button
                        >
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="s-grp">
              <UnreadEntries field={["backgrounds", "userStyles"]} />
              <div class="s-card">
                <button
                  class="s-row s-fold"
                  onclick={() => (backgroundOpen = !backgroundOpen)}
                  aria-expanded={backgroundOpen}
                  data-testid="background-fold"
                >
                  <span class="s-name">
                    <span class="s-chev" class:rot={backgroundOpen}><Icon name="chev" size={12} /></span>
                    Background image
                  </span>
                  <span class="s-value" data-testid="background-fold-value"
                    >{Object.hasOwn(theme.backgrounds ?? {}, theme.palette) ? "On" : "None"}</span
                  >
                </button>
                {#if backgroundOpen}
                  <div class="s-inset form picker">
                    <BackgroundPicker />
                  </div>
                {/if}
                <div class="s-row">
                  <span class="s-name" id="styles-label"
                    ><span>Custom styles</span><small data-testid="styles-note">
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
                  <div class="s-ctl">
                    <Switch on={userStyles.on} onchange={setUserStyles} labelledby="styles-label" testid="styles" />
                  </div>
                </div>
                {#if userStyles.problem !== null}
                  <p class="s-problem" data-testid="styles-problem">
                    {userStyles.problem[0].toUpperCase()}{userStyles.problem.slice(1)}.
                  </p>
                {/if}
              </div>
            </div>
          {:else if tab === "sessions"}
            <section data-testid="settings-sessions">
              <div class="s-grp">
                <div class="s-head"><h3 class="s-title">Run</h3></div>
                <UnreadEntries field={["hooks", "notesOn", "agentsOn"]} />
                <div class="s-part" data-testid="session-kinds">
                  <div class="s-card">
                    {#each installed().length > 0 ? installed() : HARNESSES as id (id)}
                      <div class="s-row" data-testid="session-kind" data-agent={id}>
                        <span class="s-name">{harnessLabel(id)}</span>
                        <div class="s-ctl">
                          {#if canIntegrate(id)}
                            <div class="s-seg" role="radiogroup" aria-label="Where {harnessLabel(id)} sessions run">
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
                            <span class="s-fixed" title="Runs only in a terminal" data-testid="session-kind-only"
                              >In a terminal</span
                            >
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                  <p class="s-after" data-testid="session-kind-when">
                    A change also moves that harness's open sessions, each the next time it is at rest and opened. To
                    move a session now, right-click it and choose Reopen.
                  </p>
                </div>
                <div class="s-card">
                  <div class="s-wrap" data-testid="settings-live">
                    <div class="s-row" data-testid="hooks-everywhere-row">
                      <span class="s-name"
                        ><span id="hooks-label">Let sessions talk to Chord</span
                        ><small id="hooks-hint">Shows when a session works, waits or asks.</small></span
                      >
                      <div class="s-ctl">
                        <Switch
                          on={hook.everywhere}
                          onchange={setHooksEverywhere}
                          disabled={hook.busy}
                          labelledby="hooks-label"
                          describedby="hooks-hint"
                          testid="hooks-everywhere"
                        />
                      </div>
                    </div>
                    {#if hooked.length > 0}
                      <button
                        class="s-row s-fold"
                        onclick={() => (overridesOpen = !overridesOpen)}
                        aria-expanded={overridesOpen}
                        data-testid="hooks-overrides"
                      >
                        <span class="s-name">
                          <span class="s-chev" class:rot={overridesOpen}><Icon name="chev" size={12} /></span>
                          By project
                        </span>
                        <span class="s-value" data-testid="hooks-overrides-count">{overridden} of their own</span>
                      </button>
                    {/if}
                    {#if overridesOpen && hooked.length > 0}
                      <div class="s-subs">
                        {#each hooked as path (path)}
                          {@const own = overrideOf(path)}
                          <div class="s-row" data-testid="hooks-row" data-project={path}>
                            <span class="s-name" title={path}>{projectLabel(path)}</span>
                            <div class="s-ctl">
                              <div class="s-seg" role="radiogroup" aria-label="Talk to Chord in {projectLabel(path)}">
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
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {#if hook.error}
                      <p class="s-problem alone" data-testid="hook-error">{hook.error}</p>
                    {/if}
                  </div>
                  <div class="s-row" data-testid="notes-on-row">
                    <span class="s-name"
                      ><span id="notes-label">Keep notes</span
                      ><small id="notes-hint">Sessions keep notes, and a long conversation goes on from them.</small
                      ></span
                    >
                    <div class="s-ctl">
                      <Switch
                        on={switches.notes}
                        onchange={setNotesOn}
                        labelledby="notes-label"
                        describedby="notes-hint"
                        testid="notes-on"
                      />
                    </div>
                  </div>
                  <div class="s-row" data-testid="agents-on-row">
                    <span class="s-name"
                      ><span id="agents-label">Agents and teams</span
                      ><small id="agents-hint"
                        >Sessions can work as an agent, and teams hold a change to their gates.</small
                      ></span
                    >
                    <div class="s-ctl">
                      <Switch
                        on={switches.agents}
                        onchange={setAgentsOn}
                        labelledby="agents-label"
                        describedby="agents-hint"
                        testid="agents-on"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div class="s-grp">
                <div class="s-head"><h3 class="s-title">New sessions</h3></div>
                <UnreadEntries field={["lastChosen", "askEveryStart"]} />
                <div class="s-card">
                  <div class="s-wrap" data-testid="chosen-list">
                    {#each installed().length > 0 ? installed() : HARNESSES as id (id)}
                      <div class="s-row" data-testid="chosen" data-agent={id}>
                        <span class="s-name">Start {harnessLabel(id)} on</span>
                        <div class="s-ctl">
                          <span class="s-value" data-testid="chosen-line">{chosenLine(id)}</span>
                          {#if anyChosen(id)}
                            <button
                              class="s-btn"
                              onclick={() => forgetChosen(id)}
                              aria-label="Start new {harnessLabel(id)} sessions on its own defaults"
                              data-testid="chosen-forget">Use defaults</button
                            >
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                  <div class="s-row">
                    <span class="s-name">Ask before a session starts another</span>
                    <div class="s-ctl">
                      <div class="s-seg" role="radiogroup" aria-label="Ask before a session starts another">
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
                  </div>
                </div>
              </div>

              <div class="s-grp">
                <div class="s-head"><h3 class="s-title">Past sessions</h3></div>
                <UnreadEntries field={["pastSessions", "inactiveAfter"]} />
                <div class="s-card">
                  <div class="s-row">
                    <label class="s-name" for="past-sessions"
                      >Keep listed<small>Older ones move to Earlier. Nothing is deleted.</small></label
                    >
                    <div class="s-ctl">
                      <select
                        id="past-sessions"
                        class="s-sel"
                        value={sessions.pastSessions}
                        onchange={(e) => setPastSessions(e.currentTarget.value as typeof sessions.pastSessions)}
                        data-testid="past-sessions"
                      >
                        {#each PAST_SESSIONS as span (span.choice)}
                          <option value={span.choice}>{span.label}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                  <div class="s-row">
                    <label class="s-name" for="inactive-after">Fold inactive projects after</label>
                    <div class="s-ctl">
                      <select
                        id="inactive-after"
                        class="s-sel"
                        value={projects.inactiveAfter}
                        onchange={(e) => setInactiveAfter(e.currentTarget.value as typeof projects.inactiveAfter)}
                        data-testid="inactive-after"
                      >
                        {#each INACTIVE_AFTER as span (span.choice)}
                          <option value={span.choice}>{span.label}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          {:else if tab === "agents"}
            <AgentsTab bind:this={agentsTab} />
          {:else if tab === "setup"}
            <section data-testid="settings-setup">
              <SetupChecks />
              {#if setupDemand}
                <p class="s-after" role="status" data-testid="setup-demand">{setupDemand}</p>
              {/if}
            </section>
          {:else if tab === "accounts"}
            <section data-testid="settings-accounts">
              <p class="s-lede">Each account keeps its own sign-in.</p>
              <div class="s-grp">
                <UnreadEntries field="accounts" />
                <div class="s-card">
                  <div class="s-row" data-testid="account-row" data-account="">
                    <span class="s-name"
                      >{OWN_LABEL}<small class="s-mono">Claude Code ~/.claude · Codex ~/.codex</small></span
                    >
                  </div>
                  {#each names() as name (name)}
                    <div class="s-row" data-testid="account-row" data-account={name}>
                      <span class="s-name">{name}<small class="s-mono">{dirsLine(name)}</small></span>
                      <div class="s-ctl">
                        <button class="s-quiet" onclick={() => dropAccount(name)} data-testid="account-remove"
                          >Remove</button
                        >
                      </div>
                    </div>
                  {/each}
                  {#if names().length === 0 && !addingAccount}
                    <div class="s-empty" data-testid="accounts-empty">
                      <b>No accounts of your own yet</b>
                      An account is a second sign-in, kept in directories of its own.
                    </div>
                  {/if}
                  {#if addingAccount}
                    <form class="s-inset form" onsubmit={submitAccount} data-testid="account-form">
                      <div class="s-fgrid">
                        <label for="account-name">Name</label>
                        <input
                          id="account-name"
                          class="s-field"
                          type="text"
                          bind:value={accountName}
                          placeholder="Work"
                          data-testid="account-name"
                        />
                        {#each [["claude", "Claude Code"], ["codex", "Codex"]] as [agent, what] (agent)}
                          {@const own = agent === "claude" ? ownClaude : ownCodex}
                          {@const dir = agent === "claude" ? claudeDir : codexDir}
                          <span>{what}</span>
                          {#if own === null}
                            <span class="s-line">
                              <span class="s-mono path" data-testid="account-{agent}">{dir}</span>
                              <button
                                type="button"
                                class="s-quiet icon"
                                aria-label="Change the {what} directory"
                                title="Change the directory"
                                onclick={() => {
                                  if (agent === "claude") ownClaude = dir;
                                  else ownCodex = dir;
                                }}
                                data-testid="account-{agent}-edit"><Icon name="edit" size={13} /></button
                              >
                            </span>
                          {:else if agent === "claude"}
                            <input
                              type="text"
                              class="s-field s-mono"
                              aria-label="The Claude Code directory"
                              bind:value={ownClaude}
                              data-testid="account-claude-dir"
                            />
                          {:else}
                            <input
                              type="text"
                              class="s-field s-mono"
                              aria-label="The Codex directory"
                              bind:value={ownCodex}
                              data-testid="account-codex-dir"
                            />
                          {/if}
                        {/each}
                      </div>
                      {#if accountProblem !== null}
                        <p class="bad" data-testid="account-problem">{accountProblem}</p>
                      {/if}
                      <div class="s-line">
                        <button
                          type="submit"
                          class="s-btn pri"
                          disabled={accountName.trim() === ""}
                          data-testid="account-add">Add</button
                        >
                        <button
                          type="button"
                          class="s-quiet"
                          onclick={() => (addingAccount = false)}
                          data-testid="account-cancel">Cancel</button
                        >
                      </div>
                    </form>
                  {:else}
                    <button class="s-row s-add" onclick={openAccountForm} data-testid="account-add-open">
                      <span class="s-name"><span class="s-plus"><Icon name="plus" size={12} /></span>Add account</span>
                    </button>
                  {/if}
                </div>
              </div>

              <div class="s-grp">
                <div class="s-head"><h3 class="s-title">Use</h3></div>
                <div class="s-card">
                  <div class="s-row" data-testid="account-everywhere">
                    <span class="s-name">Every project</span>
                    <div class="s-ctl">
                      <div class="s-seg" role="radiogroup" aria-label="The account for every project">
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
                  </div>
                  {#if workspace.open.length > 0}
                    <button
                      class="s-row s-fold"
                      onclick={() => (accountOverridesOpen = !accountOverridesOpen)}
                      aria-expanded={accountOverridesOpen}
                      data-testid="account-overrides"
                    >
                      <span class="s-name">
                        <span class="s-chev" class:rot={accountOverridesOpen}><Icon name="chev" size={12} /></span>
                        By project
                      </span>
                      <span class="s-value" data-testid="account-overrides-count"
                        >{accountOverridden} of their own</span
                      >
                    </button>
                  {/if}
                  {#if accountOverridesOpen && workspace.open.length > 0}
                    <div class="s-subs">
                      {#each workspace.open as project (project.path)}
                        {@const own = accountOverrideOf(project.path)}
                        <div class="s-row" data-testid="account-project-row" data-project={project.path}>
                          <span class="s-name" title={project.path}>{projectLabel(project.path)}</span>
                          <div class="s-ctl">
                            <div
                              class="s-seg"
                              role="radiogroup"
                              aria-label="The account for {projectLabel(project.path)}"
                            >
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
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            </section>
          {:else if tab === "plugins"}
            <p class="s-lede">Plugins run with your privileges. Turn on only ones you trust.</p>
            {#if plugins.error}
              <p class="s-after bad" data-testid="plugin-error">{plugins.error}</p>
            {/if}
            {#each ordered as source (source.id)}
              <div
                class="s-grp"
                data-testid="plugin-source"
                data-source={source.id}
                data-known={source.known ? "true" : null}
                data-fetched={fetched(source) ? "true" : "false"}
              >
                <div class="s-head">
                  <h3 class="s-title" title={source.location}>{lastSegment(source.location)}</h3>
                  <span class="s-meta">
                    {[
                      source.known ? "known" : null,
                      source.kind === "dir" ? "directory" : (source.commit?.slice(0, 7) ?? null),
                      source.reference,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <div class="s-tools">
                    {#if source.newer}
                      <button
                        class="s-quiet accent"
                        onclick={() => void updateSource(source.id)}
                        disabled={plugins.busy}
                        data-testid="plugin-update">Update to {source.newer.slice(0, 7)}</button
                      >
                    {/if}
                    {#if source.kind === "git" && fetched(source)}
                      <button
                        class="s-quiet"
                        onclick={() => void checkSource(source.id)}
                        disabled={plugins.busy}
                        data-testid="plugin-check">Check</button
                      >
                    {/if}
                    {#if fetched(source)}
                      <button
                        class="s-quiet"
                        onclick={() => void removeSource(source.id)}
                        disabled={plugins.busy}
                        title={source.known ? "Removes the fetched copy; the source stays listed" : null}
                        data-testid="plugin-remove">Remove</button
                      >
                    {/if}
                  </div>
                </div>
                {#if source.error}
                  <p class="s-after bad" data-testid="plugin-source-error">{source.error}</p>
                {/if}
                {#if source.plugins.length > 0}
                  <div class="s-card">
                    {#each source.plugins as plugin (plugin.name)}
                      {@const state = rowState(source, plugin)}
                      {@const hears = listensFor(plugin)}
                      <div class="s-row top plugin" data-testid="plugin-row" data-plugin={plugin.name}>
                        <div class="s-name">
                          <span class="plugin-name" id="plugin-{source.id}-{plugin.name}"
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
                        <div class="s-ctl">
                          <Switch
                            on={plugin.enabled}
                            onchange={(next) => turn(source.id, plugin.name, next)}
                            disabled={plugins.busy}
                            labelledby="plugin-{source.id}-{plugin.name}"
                            testid="plugin"
                          />
                        </div>
                      </div>
                      {#if asking !== null && asking.id === source.id && asking.name === plugin.name}
                        <div class="s-inset" data-testid="plugin-ask">
                          <p>
                            {#if fetched(source)}
                              {plugin.name} runs <code>{plugin.run[0]}</code> with your privileges: {summary(
                                plugin,
                              )}.{#if hears !== null}
                                {hears}, and is told that command's own words, its folder and whether it worked; its
                                output too, unless another command in the same line prints.{/if}
                            {:else}
                              {plugin.name} is fetched from <code>{lastSegment(source.location)}</code> and runs with
                              your privileges: {plugin.description}
                            {/if}
                            Turn it on?
                          </p>
                          <div class="s-line">
                            <button
                              class="s-btn pri"
                              onclick={() => agree(source.id, plugin.name)}
                              data-testid="plugin-agree">Turn on</button
                            >
                            <button class="s-quiet" onclick={() => (asking = null)} data-testid="plugin-cancel"
                              >Not now</button
                            >
                          </div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
            <div class="s-grp">
              <div class="s-card">
                {#if ordered.length === 0}
                  <div class="s-empty" data-testid="plugins-empty">
                    <b>No plugin sources yet</b>
                    A source is a repository or a directory that holds plugins.
                  </div>
                {/if}
                {#if addingSource}
                  <form class="s-inset form s-line" onsubmit={add}>
                    <input
                      type="text"
                      class="s-field grow"
                      placeholder="Repository URL or directory"
                      aria-label="Repository URL or directory"
                      bind:value={sourceLocation}
                      disabled={plugins.busy}
                      data-testid="plugin-location"
                    />
                    <input
                      type="text"
                      class="s-field reference"
                      placeholder="ref"
                      aria-label="Branch, tag or commit"
                      bind:value={sourceReference}
                      disabled={plugins.busy}
                      data-testid="plugin-reference"
                    />
                    <button
                      type="submit"
                      class="s-btn pri"
                      disabled={plugins.busy || sourceLocation.trim() === ""}
                      data-testid="plugin-add">{plugins.busy ? "Working…" : "Add"}</button
                    >
                  </form>
                {:else}
                  <button class="s-row s-add" onclick={() => (addingSource = true)} data-testid="plugin-add-source">
                    <span class="s-name"><span class="s-plus"><Icon name="plus" size={12} /></span>Add a source…</span>
                  </button>
                {/if}
              </div>
            </div>
          {:else if tab === "notifications"}
            <div class="s-grp">
              <UnreadEntries field={["notifications", "chime"]} />
              <div class="s-card">
                <div class="s-row">
                  <span class="s-name" id="notifications-label">System notifications</span>
                  <div class="s-ctl">
                    <Switch
                      on={notify.notifications}
                      onchange={setNotifications}
                      labelledby="notifications-label"
                      testid="notifications"
                    />
                  </div>
                </div>
                <div class="s-row">
                  <span class="s-name" id="chime-label">Chime</span>
                  <div class="s-ctl">
                    <Switch on={notify.chime} onchange={setChime} labelledby="chime-label" testid="chime" />
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <p class="s-lede">
              {#if isMac()}
                Every shortcut uses ⌘, or ⌃ when a second key follows it; the keys without them belong to the agent.
              {:else}
                Every shortcut uses Ctrl; the keys without it belong to the agent.
              {/if}
              A second key pressed right after the first makes a shortcut of two steps.
            </p>
            <div class="s-grp">
              <UnreadEntries field="keys" />
              <div class="s-card">
                <div class="s-row">
                  <span class="s-name">Preset</span>
                  <div class="s-ctl">
                    {#if keys.preset === "custom"}
                      <span class="s-value" data-testid="preset-custom">Custom</span>
                    {/if}
                    <div class="s-seg" role="radiogroup" aria-label="Preset">
                      {#each PRESET_NAMES as name (name)}
                        <button
                          role="radio"
                          aria-checked={keys.preset === name}
                          class:on={keys.preset === name}
                          onclick={() => applyPreset(name)}
                          data-testid="preset-{name}">{PRESET_LABELS[name]}</button
                        >
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {#each groups as group (group.name)}
              <div class="s-grp">
                <div class="s-head"><h3 class="s-title">{group.name}</h3></div>
                <div class="s-card dense">
                  {#each group.actions as action (action.key)}
                    <div class="s-row" class:problem={problem?.action === action.key}>
                      <span class="s-name"
                        >{action.label}{#if action.key === "file.close" && also !== null}<small
                            data-testid="chord-also">Also {describe(also)}, which works in a terminal</small
                          >{/if}</span
                      >
                      <div class="s-ctl">
                        {#if changed(action.key)}
                          <button
                            class="s-quiet"
                            onclick={() => reset(action.key)}
                            aria-label="Reset the shortcut for {action.label}"
                            data-testid="reset-{action.key}">Reset</button
                          >
                        {/if}
                        <button
                          class="s-kbd"
                          class:rec={recording === action.key || following?.action === action.key}
                          onclick={() => record(action.key)}
                          aria-label="Change the shortcut for {action.label}"
                          data-testid="chord-{action.key}"
                        >
                          {recording === action.key
                            ? "Press keys…"
                            : following?.action === action.key
                              ? `${describe(following.first)}, then…`
                              : describe(keys.bindings[action.key])}
                        </button>
                      </div>
                    </div>
                    {#if problem?.action === action.key}
                      <p class="s-problem" data-testid="chord-problem">{problem.text}</p>
                    {/if}
                  {/each}
                </div>
              </div>
            {/each}
            <div class="s-foot">
              <button class="s-btn ground" onclick={resetAll} data-testid="reset-all">Reset all shortcuts</button>
            </div>
          {/if}
        </div>
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

  /* One size for every tab, so nothing moves when the tab changes: the
     tabs in a column on the left, and the tab shown beside them. */
  /* The gutter is measured from the dialog's outer edge, so what meets
     the border takes its line off, and --title-top puts the titles'
     capitals a gutter from the top in either look. */
  .dialog {
    --gutter: 28px;
    --edge: 1px;
    --title-top: 16px;
    width: min(940px, 92vw);
    height: min(740px, 92vh);
    display: grid;
    grid-template-columns: 196px minmax(0, 1fr);
    background: var(--s-ground);
    border: var(--edge) solid var(--pane-border-on);
    border-radius: var(--radius-pane);
    font-family: var(--chrome);
    color: var(--ink);
    overflow: hidden;
    outline: none;
  }

  :global(:root[data-look="modern"]) .dialog {
    --title-top: 18px;
  }

  /* The tabs stand on a ground a shade below the dialog's own. A tab's
     words start as far from the edge as the panel's do. */
  nav {
    --pane-bg: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    padding: 0 calc(var(--gutter) / 2) 12px calc(var(--gutter) / 2 - var(--edge));
    background: var(--pane-bg);
    border-right: 1px solid var(--divider, var(--rule));
    overflow-y: auto;
    scrollbar-width: thin;
  }

  /* The dialog's name and the name of the tab shown stand on one line,
     whatever size either is set in: each is a row 26px high, 18px down,
     whose words sit on the baseline of the same unseen letter. The tops
     of the larger letters come as far under the dialog's edge as the
     gutter is wide. */
  .title {
    display: flex;
    flex: none;
    align-items: baseline;
    height: 26px;
    margin: var(--title-top) 0 calc(32px - var(--title-top));
    padding: 0 calc(var(--gutter) / 2);
    font-family: var(--chrome);
    font-size: var(--title-size);
    font-weight: var(--title-weight);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    white-space: nowrap;
    color: var(--ink);
  }

  .title::before {
    content: "\200b";
    font: 600 15px/26px var(--sans);
    letter-spacing: 0;
  }

  .title.page {
    margin: 0 auto 0 0;
    padding: 0;
    font-size: var(--s-page-title);
    font-weight: 600;
    color: var(--s-page-title-color);
  }

  .tab {
    display: flex;
    flex: none;
    align-items: center;
    height: 28px;
    padding: 0 calc(var(--gutter) / 2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    text-align: left;
    color: var(--ink-2);
    cursor: pointer;
  }

  .tab:hover {
    background: color-mix(in srgb, var(--ink) 5%, transparent);
    color: var(--ink);
  }

  .tab.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .tab:focus-visible,
  .close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* The tab's name, what the whole tab can do, and the way out: they stay
     while the tab scrolls under them. */
  .head,
  .col {
    box-sizing: border-box;
    width: 100%;
    max-width: 776px;
    margin-inline: auto;
    padding-inline: var(--gutter) calc(var(--gutter) - var(--edge));
  }

  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 26px;
    margin-top: var(--title-top);
    margin-bottom: calc(32px - var(--title-top));
  }

  .close {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    margin-right: -4px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .close:hover {
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    color: var(--ink);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .col {
    padding-top: 2px;
    padding-bottom: 32px;
  }

  /* A font's button is set in the font it chooses. */
  .face {
    text-transform: none;
    letter-spacing: 0;
  }

  .picker {
    padding-left: 34px;
  }

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }

  .icon {
    padding: 0 5px;
  }

  .bad {
    margin: 0 0 10px;
    color: var(--del);
  }

  .alone {
    margin-top: 0;
    padding-top: 6px;
  }

  .grow {
    flex: 1;
  }

  .reference {
    width: 88px;
  }

  .plugin-name {
    font-weight: 600;
  }

  .version {
    margin-left: 6px;
    font: 400 11.5px var(--mono);
    color: var(--ink-3);
  }

  .plugin-desc {
    max-width: 62ch;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }

  .plugin-meta {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink-3);
  }
</style>
