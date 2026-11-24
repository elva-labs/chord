<script lang="ts">
  /**
   * The core's checks in their two groups, the agents and source control,
   * as the welcome and the Setup tab show them. Before the first answer
   * every row says it is checking; while a later read runs, the last
   * answers stay in place, dimmed.
   */
  import { SvelteSet } from "svelte/reactivity";
  import { risen } from "$lib/blade";
  import { core } from "$lib/core";
  import { setup } from "$lib/setup.svelte";
  import { groups, type Icon, type SetupRow } from "$lib/setupRows";
  import CopyButton from "./CopyButton.svelte";

  /** How far each group has come in, from 0 to 1. */
  let { arrived = [1, 1] }: { arrived?: number[] } = $props();

  const PATHS: Record<Icon, string> = {
    ok: "M4.9 8.3l2.1 2.1 4.1-4.6",
    need: "M8 4.6v4.1M8 11.2v.2",
    none: "M5.6 8h4.8",
    busy: "M8 2.2a5.8 5.8 0 0 1 5.8 5.8",
  };
  const RADII: Record<Icon, number> = { ok: 8, need: 8, none: 7.2, busy: 5.8 };

  /** The rows before the first answer. */
  const pending = (id: string, name: string, binary: string | null): SetupRow => ({
    id,
    name,
    binary,
    icon: "busy",
    version: null,
    status: "Checking",
    extra: null,
    command: null,
    say: null,
    guide: null,
    open: false,
  });
  const PENDING = {
    agents: [pending("claude-code", "Claude Code", "claude"), pending("codex", "Codex", "codex")],
    tools: [pending("git", "git", null)],
  };

  const shown = $derived.by(() => {
    if (setup.found) return groups(setup.found);
    if (setup.busy) return PENDING;
    const failed = (row: SetupRow): SetupRow => ({ ...row, icon: "need", status: "Could not check" });
    return { agents: PENDING.agents.map(failed), tools: PENDING.tools.map(failed) };
  });
  const stale = $derived(setup.found !== null && setup.busy);

  /** The rows whose steps were asked for. */
  const opened = new SvelteSet<string>();

  function open(event: MouseEvent, url: string) {
    event.preventDefault();
    void core().openUrl(url);
  }
</script>

{#snippet icon(kind: Icon)}
  <svg class="ic {kind}" viewBox="0 0 16 16" aria-hidden="true">
    <circle class="bg" cx="8" cy="8" r={RADII[kind]} />
    <path class="st" d={PATHS[kind]} />
  </svg>
{/snippet}

{#snippet line(row: SetupRow)}
  {@const steps = row.open || opened.has(row.id)}
  <div class="row" class:stale data-check={row.id}>
    {@render icon(stale ? "busy" : row.icon)}
    <span class="name">{row.name}{#if row.binary}<code>{row.binary}</code>{/if}</span>
    <span class="meta">
      {#if row.version}<span class="v">{row.version}</span>{/if}
      {#if row.status}
        {#if row.version}<i class="dotsep"></i>{/if}
        <span class="q">{row.status}</span>
      {/if}
      {#if row.extra}
        {#if row.version || row.status}<i class="dotsep"></i>{/if}
        <span class:w={row.extra.tone === "warn"}>{row.extra.text}</span>
      {/if}
      {#if row.command && !steps}
        <button type="button" class="more" onclick={() => opened.add(row.id)}>Install</button>
      {/if}
      {#if row.guide && (steps || !row.command)}
        <a class="link" href={row.guide} onclick={(event) => open(event, row.guide!)}>
          Install guide<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5l-6 6" /></svg>
        </a>
      {/if}
    </span>
    {#if steps && (row.command || row.say)}
      <div class="do">
        {#if row.say}<p>{row.say}</p>{/if}
        {#if row.command}
          <div class="cmd">
            <code>{row.command}</code>
            <CopyButton text={row.command} label="Copy the command" />
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="group" style={risen(arrived[0] ?? 1)} data-testid="setup-agents">
  <div class="label">Agents<span>One is needed</span></div>
  <div class="card">
    {#each shown.agents as row (row.id)}{@render line(row)}{/each}
  </div>
</div>
<div class="group" style={risen(arrived[1] ?? 1)} data-testid="setup-tools">
  <div class="label">Source control<span>For worktrees and diffs</span></div>
  <div class="card">
    {#each shown.tools as row (row.id)}{@render line(row)}{/each}
  </div>
</div>

<style>
  .label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 2px 6px;
    font-size: var(--label-size);
    text-transform: var(--label-case);
    letter-spacing: var(--label-track);
    color: var(--ground-quiet);
    font-weight: 500;
  }

  .label span {
    font-weight: 400;
  }

  .card {
    background: var(--surface);
    border-radius: var(--card-radius);
    box-shadow: inset 0 0 0 1px var(--rule);
    margin-bottom: 10px;
  }

  :global(:root[data-look="modern"]) .card {
    box-shadow:
      var(--card-shadow),
      inset 0 0 0 1px var(--card-edge);
  }

  .row {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: center;
    padding: 7px 12px;
    min-height: 36px;
  }

  .row + .row {
    border-top: 1px solid var(--divider);
  }

  /* In the settings the groups stand on the grid the other tabs use. */
  :global(.s-dialog) .label {
    align-items: center;
    min-height: 22px;
    font-size: var(--heading-size);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
  }

  :global(.s-dialog) .group:first-child .label {
    margin-top: 6px;
  }

  :global(.s-dialog) .label span {
    font-size: var(--label-size);
    color: var(--ground-quiet);
  }

  :global(.s-dialog) .card {
    margin-bottom: 22px;
  }

  :global(.s-dialog) .row {
    padding: 7px 14px;
    min-height: 42px;
  }

  .name {
    font-size: var(--row-size);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name code {
    font: 400 11.5px var(--mono);
    color: var(--ink-3);
    margin-left: 6px;
  }

  .meta {
    font-size: var(--meta-size);
    color: var(--ink-2);
    white-space: nowrap;
    text-align: right;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .meta .link,
  .meta .more {
    margin-left: 3px;
  }

  .v {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .q {
    color: var(--ink-3);
  }

  .w {
    color: var(--dormant);
  }

  .dotsep {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: var(--ink-3);
  }

  .more {
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    color: var(--ink-2);
    text-decoration: underline;
    text-decoration-color: var(--rule-strong);
    text-underline-offset: 3px;
    font-size: var(--meta-size);
    font-family: var(--chrome);
  }

  .more:hover {
    color: var(--ink);
  }

  .do {
    grid-column: 1 / 4;
    min-width: 0;
    margin: 6px 0 2px;
  }

  .do p {
    margin: 0 0 5px;
    color: var(--ink-2);
    font-size: var(--meta-size);
  }

  .cmd {
    display: flex;
    align-items: center;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    min-height: 26px;
  }

  .cmd code {
    flex: 1;
    min-width: 0;
    font: 11px/1.45 var(--mono);
    padding: 5px 0 5px 9px;
    color: var(--ink);
    overflow-wrap: break-word;
    user-select: all;
    -webkit-user-select: all;
  }

  .cmd code::before {
    content: "$ ";
    color: var(--ink-3);
    user-select: none;
    -webkit-user-select: none;
  }

  .cmd :global(.copy) {
    align-self: stretch;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
    font-size: var(--meta-size);
    text-decoration: none;
    white-space: nowrap;
  }

  .link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .link svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ic {
    width: 16px;
    height: 16px;
    display: block;
  }

  .ic .bg {
    stroke: none;
  }

  .ic .st {
    fill: none;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ic.ok .bg {
    fill: color-mix(in srgb, var(--add) 16%, transparent);
  }

  .ic.ok .st {
    stroke: var(--add);
  }

  .ic.need .bg {
    fill: color-mix(in srgb, var(--dormant) 18%, transparent);
  }

  .ic.need .st {
    stroke: var(--dormant);
  }

  .ic.none .bg {
    fill: none;
    stroke: var(--rule-strong);
    stroke-width: 1.2;
  }

  .ic.none .st {
    stroke: var(--ink-3);
  }

  .ic.busy .bg {
    fill: none;
    stroke: var(--rule);
    stroke-width: 1.6;
  }

  .ic.busy .st {
    stroke: var(--ink-3);
    stroke-width: 1.6;
    transform-origin: 8px 8px;
    animation: spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ic.busy .st {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .row.stale .name,
  .row.stale .meta,
  .row.stale .do {
    opacity: 0.5;
  }
</style>
