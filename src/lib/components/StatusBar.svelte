<script lang="ts">
  import { tick, untrack } from "svelte";
  import { accountLabel, hasAccounts } from "$lib/accounts.svelte";
  import { harnessLabel } from "$lib/harness.svelte";
  import { profileOf, profilesKnown, readProfiles } from "$lib/codexProfiles.svelte";
  import { core } from "$lib/core";
  import { flash } from "$lib/flash.svelte";
  import { fits } from "$lib/giveWay";
  import { layout, returnFocus } from "$lib/layout.svelte";
  import {
    ageOf,
    figuresOf,
    limitsOf,
    planName,
    resetWhen,
    resetWords,
    topFigure,
    type Figure,
  } from "$lib/limits.svelte";
  import { sessionState } from "$lib/orchestrator.svelte";
  import { hostOf } from "$lib/remote.svelte";
  import { activeSession, unreadCount } from "$lib/sessions.svelte";
  import { isChat } from "$lib/chats.svelte";
  import Icon from "./conversation/Icon.svelte";

  /**
   * The window's foot. At the left the branch the session on screen works
   * on, or for a chat that it is one; at its right the account it runs under, once there is more than one,
   * and the Codex profile where it runs under one, with that account's
   * allowance, the share used of each limit window the agent reported,
   * then how many sessions wait for you. A word in passing keeps its place
   * between the branch and the allowance. The window's mode is the corner's
   * switch to say, so the bar does not, and the model, the effort and the
   * mode belong to the composer. The profile's tooltip names the settings
   * of its file a session is not given, as its account's list last said.
   *
   * The allowance opens a popover with every window in full. A press opens
   * it, Escape or a press elsewhere puts it away, and the keyboard goes back
   * where it was; the keyboard going elsewhere by a chord puts it away too
   * and stays where it went. What is open stays above its control as the
   * window changes size.
   *
   * Short of room, the bar lets its parts go in order: the words "account:"
   * and "profile:", then every figure but the one nearest its end, then the
   * branch, then that figure's reset time. Only after that is the account's
   * name cut short; what waits for you never is. A word in passing takes no
   * room: it stands in the space before the allowance, and where that space
   * is too short it is drawn over the parts before it while it shows, so
   * nothing moves for it.
   */

  /** What gives way, first to last. */
  const STEPS = ["prefix", "fold", "branch", "reset"];
  const POPOVER_WIDTH = 540;
  const EDGE = 8;

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  let bar = $state<HTMLElement | null>(null);
  let layer = $state<HTMLElement | null>(null);
  let popover = $state<HTMLElement | null>(null);

  let session = $derived(activeSession());
  let chat = $derived(session !== null && isChat(session));
  /** What the session is doing, in the words its row and its dot use. */
  let doing = $derived(session === null ? null : sessionState(session));
  /** What a screen reader is told as the session starts asking: only the
      two states that wait on the user, so working and idle flips stay
      quiet. The words hold while the state does, so nothing is said twice. */
  let asked = $derived(doing === "asks you" || doing === "waits for permission" ? doing : "");
  /** Where the session works, which is what its branch is read from. */
  let dir = $derived(session === null ? null : (session.worktree ?? session.startIn ?? session.project));

  /** The branch last read, with where it was read, so another session's
      shows nothing until its own is read. */
  let read = $state<{ dir: string; branch: string | null } | null>(null);
  let branch = $derived(read !== null && read.dir === dir ? read.branch : null);
  $effect(() => {
    const from = dir;
    // Read again when a turn ends, since the agent may have switched it.
    void session?.working;
    if (from === null) return;
    let stale = false;
    core()
      .projectInfo(from)
      .then((info) => {
        if (!stale) read = { dir: from, branch: info.branch ?? null };
      })
      .catch(() => {
        if (!stale) read = { dir: from, branch: null };
      });
    return () => {
      stale = true;
    };
  });

  let account = $derived(session !== null && hasAccounts() ? accountLabel(session.account) : null);
  let profile = $derived(session?.profile ?? null);
  /** The keys of the profile's settings the session is not given. */
  let leftOut = $derived(
    session === null || profile === null ? [] : (profileOf(session.project, session.account, profile)?.leftOut ?? []),
  );
  let leftOutWords = $derived(
    leftOut.length === 0
      ? ""
      : `${leftOut.length === 1 ? "1 setting" : `${leftOut.length} settings`} left out: ${leftOut.join(", ")}`,
  );
  $effect(() => {
    if (session === null || profile === null) return;
    const { project, account } = session;
    if (!profilesKnown(project, account)) void readProfiles(project, account);
  });
  let report = $derived(session === null ? null : limitsOf(hostOf(session.project), session.agent, session.account));
  let figures = $derived(report === null ? [] : figuresOf(report, now));
  let top = $derived(topFigure(figures));
  let age = $derived(report === null ? null : ageOf(report, now));

  /** What a figure says in the bar: its share, or that it has reset. */
  function share(figure: Figure): string {
    return figure.percent === null ? "reset" : `${figure.percent}%`;
  }

  /** The allowance as a screen reader says it. */
  let spoken = $derived.by(() => {
    const parts = figures.map((figure) =>
      figure.percent === null
        ? `${figure.name} reset`
        : `${figure.name} ${figure.percent}% used${figure.reached ? ", reached" : ""}`,
    );
    const who =
      (account === null ? "" : `Account ${account}. `) +
      (profile === null ? "" : `Profile ${profile}${leftOutWords === "" ? "" : `, ${leftOutWords}`}. `);
    const old = age?.stale ? `. Figures from ${age.long}` : "";
    return `${who}Allowance: ${parts.join(", ")}${old}`;
  });

  // ---- what opens from the bar ----

  type Opened = "allowance";
  let open = $state<Opened | null>(null);
  let at = $state({ left: 0, bottom: 0, width: POPOVER_WIDTH });
  /** Where the keyboard was before the bar took it, to give it back. */
  let before: HTMLElement | null = null;
  let trigger: HTMLElement | null = null;
  /** What is open was opened with the pointer rather than a key. */
  let byPointer = $state(false);

  /** A press on the bar's controls leaves the keyboard where it is. */
  function keep(e: PointerEvent) {
    e.preventDefault();
  }

  function place(which: Opened, button: HTMLElement) {
    const box = button.getBoundingClientRect();
    const foot = bar?.getBoundingClientRect().top ?? window.innerHeight - 26;
    const bottom = window.innerHeight - foot + 6;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * EDGE);
    const left = Math.max(EDGE, Math.min(box.left - 10, window.innerWidth - EDGE - width));
    if (left !== at.left || bottom !== at.bottom || width !== at.width) at = { left, bottom, width };
  }

  function toggle(which: Opened, e: MouseEvent) {
    const button = e.currentTarget as HTMLElement;
    if (open === which) {
      close(true);
      return;
    }
    if (open === null) {
      const owner = document.activeElement;
      before = owner instanceof HTMLElement && owner !== document.body ? owner : null;
    }
    trigger = button;
    byPointer = e.detail > 0;
    now = Date.now();
    place(which, button);
    open = which;
    void tick().then(() => popover?.focus());
  }

  /** Puts away what is open; with `restore`, the keyboard goes back where
      it was, or to the focused pane when it was nowhere. */
  function close(restore: boolean) {
    open = null;
    const back = before;
    before = null;
    trigger = null;
    if (!restore) return;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
    else returnFocus();
  }

  /** Puts away what is open and leaves the keyboard where it is. */
  function drop() {
    open = null;
    before = null;
    trigger = null;
  }

  /** The keyboard goes to the control what is open came from, for Tab to
      go on from there. */
  function tabAway() {
    const control = trigger;
    drop();
    control?.focus();
  }

  /** The keyboard going elsewhere, by a chord or a click, puts the
      popover away and leaves it there. */
  function onPopoverBlur(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next !== null && !layer?.contains(next) && open === "allowance") drop();
  }

  /** Escape on one of the bar's controls, with nothing open, gives the
      keyboard back to the pane that has the focus, as it is given back
      when what opened goes. */
  function onBarKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || open !== null || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (target === null || !target.matches("button") || !bar?.contains(target)) return;
    e.preventDefault();
    e.stopPropagation();
    target.blur();
    returnFocus();
  }

  /** Escape, Enter and Space put the popover away as its control does,
      and Tab stops on the control. */
  function onPopoverKey(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      tabAway();
    }
  }

  // A press anywhere but on what is open and its control puts it away.
  $effect(() => {
    if (open === null) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target !== null && (trigger?.contains(target) || layer?.contains(target))) return;
      close(true);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

  // What is open stays above its control whenever the bar is laid out
  // again: as the window changes size, or a part of the bar changes.
  $effect(() => {
    const node = bar;
    if (node === null) return;
    const again = () => {
      if (open !== null && trigger !== null && trigger.isConnected) place(open, trigger);
    };
    node.addEventListener("fit", again);
    return () => node.removeEventListener("fit", again);
  });

  // What is open belongs to the session on screen and goes with it, and
  // with the control it came from.
  $effect(() => {
    void session?.key;
    untrack(() => {
      if (open !== null) close(false);
    });
  });

  $effect(() => {
    if (open === "allowance" && figures.length === 0) untrack(() => close(true));
  });

  let heading = $derived(account ?? (session === null ? "" : harnessLabel(session.agent)));
  let subheading = $derived(
    [account === null || session === null ? null : harnessLabel(session.agent), planName(report?.plan ?? null)]
      .filter((part) => part !== null)
      .join(" · "),
  );
  let updated = $derived.by(() => {
    if (age === null) return "";
    if (!age.stale) return `Updated ${age.long}`;
    return age.moved
      ? `Some figures are from ${age.newer}, the rest from ${age.long}`
      : `Figures from ${age.long}`;
  });
</script>

{#snippet clock()}
  <svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.2 1.4" /></svg>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<footer class="status no-select" bind:this={bar} use:fits={STEPS} onkeydown={onBarKey} data-testid="status-bar" data-focus={layout.focus} data-state={doing}>
  {#if session !== null}
    <span class="place" data-testid="session-place">
      <span class="sr" aria-live="polite" data-testid="state-said">{asked}</span>
      {#if chat}
        <span class="where" data-testid="chat-readout"><Icon name="chat" size={12} /><span class="txt">Chat</span></span>
      {:else if branch !== null}
        <span class="where branch" title="Branch {branch}" data-testid="branch-readout"
          ><Icon name="branch" size={12} /><span class="txt">{branch}</span></span
        >
      {/if}
    </span>
  {/if}

  {#if session !== null && (account !== null || profile !== null || figures.length > 0)}
    {#snippet who()}
      {#if account !== null}
        <span class="who" data-testid="account-readout"><span class="pre">{"account: "}</span><span class="name">{account}</span></span>
      {/if}
      {#if profile !== null}
        <span
          class="who"
          title={`Codex profile ${profile}.config.toml${leftOutWords === "" ? "" : `\n${leftOutWords}`}`}
          data-testid="profile-readout"><span class="pre">{"profile: "}</span><span class="name">{profile}</span></span
        >
      {/if}
    {/snippet}
    {#if figures.length > 0}
      <button
        class="acct"
        class:open={open === "allowance"}
        tabindex="0"
        onpointerdown={keep}
        onclick={(e) => toggle("allowance", e)}
        aria-haspopup="dialog"
        aria-expanded={open === "allowance"}
        aria-label={spoken}
        title="Allowance of this account"
        data-testid="account-group"
      >
        {@render who()}
        <span class="lims" data-testid="limits-readout">
          {#each figures as figure (figure.kind + figure.label)}
            <span
              class="lim"
              class:top={figure === top}
              class:warn={figure.tone === "warn"}
              class:error={figure.tone === "error"}
              data-kind={figure.kind}
              data-tone={figure.tone}
              data-testid="limit-figure"
              ><span class="lb">{figure.label}</span><span class="pc">{share(figure)}</span
              >{#if figure.reached && figure.resetsAt !== null && figure.percent !== null}<span class="rs"
                  >· resets {resetWhen(figure.resetsAt, now, true)}</span
                >{/if}</span
            >
          {/each}
        </span>
      </button>
    {:else}
      <span class="acct" data-testid="account-group">{@render who()}</span>
    {/if}
  {/if}

  <span class="grow">
    <span class="flash" class:on={(flash.text ?? flash.held ?? "") !== ""} role="status" data-testid="flash-readout">{flash.text ?? flash.held ?? ""}</span>
  </span>

  {#if unreadCount() > 0}
    <span class="waiting" data-testid="waiting-readout">{unreadCount()} waiting for you</span>
  {/if}

  <div class="layer" bind:this={layer}>
    {#if open === "allowance" && report !== null}
      <div
        bind:this={popover}
        class="pop"
        data-card
        role="dialog"
        tabindex="-1"
        aria-label="Allowance"
        onkeydown={onPopoverKey}
        onfocusout={onPopoverBlur}
        style:left="{at.left}px"
        style:bottom="{at.bottom}px"
        style:width="{at.width}px"
        data-testid="allowance-popover"
      >
        <div class="hd">
          <b data-testid="allowance-account">{heading}</b>
          {#if subheading !== ""}<span data-testid="allowance-plan">{subheading}</span>{/if}
        </div>
        <div class="rows">
          {#each figures as figure (figure.kind + figure.label)}
            <div
              class="row"
              class:warn={figure.tone === "warn"}
              class:error={figure.tone === "error"}
              data-kind={figure.kind}
              data-tone={figure.tone}
              data-testid="allowance-row"
            >
              <span class="nm">{figure.name}</span>
              <span class="m" aria-hidden="true"><b style:width="{figure.percent ?? 0}%"></b></span>
              <span class="pc">{figure.percent === null ? "" : `${figure.percent}%`}</span>
              <span class="rsl" data-testid="allowance-reset">{resetWords(figure, now)}</span>
            </div>
          {/each}
        </div>
        <div class="ft" data-testid="allowance-updated">
          {#if age?.stale}{@render clock()}{/if}<span>{updated}</span>
        </div>
      </div>
    {/if}
  </div>
</footer>

<style>
  /* At the window's foot wherever it stands in the page, under the
     dialogs and over the panes, which its menus open across. */
  .status {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 14px;
    height: calc(var(--status-height) + var(--status-reach));
    padding: 0 12px;
    border-top: var(--status-rule-width) solid var(--status-rule);
    background: var(--status-bg);
    font-family: var(--chrome);
    font-size: var(--status-size);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    --hover: color-mix(in srgb, var(--status-bg) 88%, var(--ink) 12%);
    /* The bar's quieter text and its warning tone, each held to 4.5:1
       against the bar in every look and theme. */
    --status-quiet: color-mix(in srgb, var(--ink-2) 60%, var(--ink-3));
    --status-warn: color-mix(in srgb, var(--ansi-yellow) 88%, var(--ink));
  }

  /* On the modern look's ground the bar's words start where the sessions
     column's do. */
  :global(:root[data-look="modern"]) .status {
    padding: 0 15px;
  }

  .status > * {
    flex: none;
  }

  /* Measured with every part whole, so what gives way is decided before
     anything is cut short. */
  .status:global([data-measuring]) > :global(*) {
    flex-shrink: 0;
  }

  .waiting,
  .flash {
    color: var(--accent);
  }

  .grow {
    position: relative;
    align-self: stretch;
    flex: 1 1 0;
    min-width: 0;
  }

  /* A word in passing stands at the end of the space before what waits,
     out of the row's measure, and covers what it overlaps where the space
     is too short. */
  .flash {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    background: var(--status-bg);
    pointer-events: none;
  }

  :global(:root[data-background]) .flash {
    background: linear-gradient(var(--tint-status), var(--tint-status)), var(--tint-backdrop);
  }

  .flash.on {
    padding-left: 14px;
  }

  .layer {
    display: contents;
  }

  /* ---- what the session is doing, and where ---- */

  .place {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 1 auto;
    min-width: 0;
    color: var(--ink-2);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .where {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 auto;
    min-width: 0;
  }

  .where :global(svg) {
    flex: none;
    color: var(--status-quiet);
  }

  .where .txt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- the account and its allowance ---- */

  .acct {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    flex: 0 1 auto;
    min-width: 0;
    color: var(--ink-2);
  }

  /* The readout opened as a button has no fill or border of its own: it sits
     on the bar's ground like the text around it. Its padding is its hover,
     bled into the gaps around it, so the text stays where plain text would. */
  button.acct {
    height: 20px;
    padding: 0 5px;
    margin: 0 -5px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    cursor: pointer;
  }

  button.acct:hover,
  button.acct.open {
    background: var(--hover);
    color: var(--ink);
  }

  button.acct:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .who {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pre {
    color: var(--status-quiet);
  }

  .name {
    color: var(--ink-2);
  }

  .lims {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 11px;
  }

  .lim {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }

  .lim .pc {
    font-weight: 500;
  }

  .lim.warn {
    color: var(--status-warn);
    font-weight: 600;
  }

  .lim.error {
    color: var(--del);
    font-weight: 600;
  }

  .lim.warn .pc,
  .lim.error .pc {
    font-weight: 600;
  }

  .lim .rs {
    font-weight: 400;
  }

  .ic {
    width: 11px;
    height: 11px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---- what gives way ---- */

  .status:global([data-fit~="prefix"]) .pre {
    display: none;
  }

  .status:global([data-fit~="branch"]) .branch {
    display: none;
  }

  .status:global([data-fit~="fold"]) .lim:not(.top) {
    display: none;
  }

  .status:global([data-fit~="reset"]) .rs {
    display: none;
  }

  /* ---- the popover ---- */

  .pop {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    padding: 10px 12px 8px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--paint-surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule-strong)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
    color: var(--ink-2);
    font-family: var(--chrome);
    font-size: var(--row-size);
    white-space: normal;
    cursor: default;
    outline: none;
  }

  .hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 8px;
  }

  .hd b {
    color: var(--ink);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hd span {
    flex: none;
  }

  .rows {
    display: grid;
    grid-template-columns: max-content minmax(48px, 96px) max-content minmax(0, 1fr);
    align-items: center;
    column-gap: 10px;
  }

  .row {
    display: contents;
  }

  .row > * {
    padding: 4px 0;
  }

  .nm {
    white-space: nowrap;
  }

  .row .pc {
    min-width: 4ch;
    text-align: right;
    color: var(--ink);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .rsl {
    min-width: 0;
  }

  .row.warn .pc,
  .row.warn .rsl {
    color: var(--status-warn);
    font-weight: 600;
  }

  .row.error .pc,
  .row.error .rsl {
    color: var(--del);
    font-weight: 600;
  }

  .m {
    position: relative;
    height: 4px;
    padding: 0;
    border-radius: var(--radius-tag);
    background: color-mix(in srgb, var(--ink) 16%, transparent);
    overflow: hidden;
  }

  .m b {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--ink-3);
  }

  .row.warn .m b {
    background: var(--status-warn);
  }

  .row.error .m b {
    background: var(--del);
  }

  .ft {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding-top: 7px;
    border-top: 1px solid var(--divider, var(--rule));
    font-size: calc(var(--row-size) - 1px);
    color: var(--ink-2);
  }
</style>
