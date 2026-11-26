<script lang="ts">
  import { tick } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import type { Conversation } from "$lib/conversation.svelte";
  import { core, type GateStanding, type RunGateState } from "$lib/core";
  import { clock } from "$lib/limits.svelte";
  import { endRun, followRun, leadGone, readRun, runs, waive } from "$lib/runs.svelte";
  import { byToken, select } from "$lib/sessions.svelte";
  import Icon from "./Icon.svelte";

  /**
   * The gates of the run a session is in, as one line over the composer:
   * how many have passed and, while one holds, why, in the core's words.
   * Opened, it lists each gate as it stands, and a gate opens to the
   * record behind it. A gate that holds is waived from its row, saying why
   * in no more than the core takes. Where the run's lead has no row, the
   * run is ended from here once the user says so, and a refusal of either
   * is said where it was asked.
   */
  interface Props {
    sessionKey: string;
    conversation: Conversation;
    active: boolean;
  }

  let { sessionKey, conversation, active }: Props = $props();

  $effect(() => followRun(sessionKey));

  // Read again when the view comes into sight and when a turn ends: a
  // change of the tree is not told.
  $effect(() => {
    if (active && conversation.current === null) void readRun(sessionKey);
  });

  let run = $derived(runs.of[sessionKey] ?? null);
  let open = $state(false);
  /** The gate whose waiver is being asked for, by id. */
  let waiving = $state<number | null>(null);
  let reason = $state("");
  let refused = $state<string | null>(null);
  /** The gate whose record is open, by id. */
  let record = $state<number | null>(null);
  /** Whether ending the run is being asked, and why the core refused it. */
  let ending = $state(false);
  let endRefused = $state<string | null>(null);
  /** The summary was just copied. */
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /** The line split where the core puts its reason. */
  let line = $derived.by(() => {
    if (run === null) return null;
    const [count, ...why] = run.line.split(" · ");
    return { count: count.replace(/^Gates\s*/, ""), why: why.join(" · ") };
  });
  let gone = $derived(run !== null && leadGone(run));
  let shown = $derived(run?.gates.find((gate) => gate.gate.id === record) ?? null);

  const WORDS: Record<GateStanding, string> = {
    waiting: "Waiting",
    approved: "Approved",
    outOfDate: "Out of date",
    waived: "Waived",
    notNeeded: "Not needed",
  };
  const ICONS: Record<GateStanding, string> = {
    waiting: "circle",
    approved: "check",
    outOfDate: "circle",
    waived: "dash",
    notNeeded: "skip",
  };

  const when = (gate: RunGateState) => (gate.gate.when === "plan" ? "before building" : "before handing over");
  const holds = (gate: RunGateState) => gate.standing === "waiting" || gate.standing === "outOfDate";
  const at = (seconds: number) => clock(seconds * 1000);
  const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

  let field = $state<HTMLTextAreaElement | null>(null);
  let sheet = $state<HTMLDivElement | null>(null);
  /** Where the keyboard goes back to when a popover or the record closes. */
  let from: HTMLElement | null = null;

  async function askWhy(gate: number, event: MouseEvent) {
    from = event.currentTarget as HTMLElement;
    waiving = gate;
    reason = "";
    refused = null;
    await tick();
    field?.focus();
  }

  function back() {
    const to = from;
    from = null;
    if (to?.isConnected) to.focus();
  }

  function cancelWaive() {
    waiving = null;
    back();
  }

  async function askEnd(event: MouseEvent) {
    from = event.currentTarget as HTMLElement;
    ending = true;
    endRefused = null;
    await tick();
    endSheet?.querySelector<HTMLButtonElement>("[data-testid='gate-end-confirm']")?.focus();
  }

  function cancelEnd() {
    ending = false;
    back();
  }

  async function confirmEnd() {
    const said = await endRun(sessionKey);
    if (said !== null) {
      endRefused = said;
      return;
    }
    ending = false;
    from = null;
  }

  function endKeys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEnd();
    }
  }

  let endSheet = $state<HTMLDivElement | null>(null);

  async function copySummary(gate: RunGateState) {
    await core().copyText(summary(gate));
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }

  async function submitWaive(event: SubmitEvent) {
    event.preventDefault();
    if (waiving === null || reason.trim() === "") return;
    const said = await waive(sessionKey, waiving, reason.trim());
    if (said !== null) {
      refused = said;
      return;
    }
    waiving = null;
    back();
  }

  function waiveKeys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelWaive();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).closest("form")?.requestSubmit();
    }
  }

  async function openRecord(gate: number, event: MouseEvent) {
    from = event.currentTarget as HTMLElement;
    record = gate;
    details = false;
    brief = false;
    copied = false;
    await tick();
    sheet?.focus();
  }

  function closeRecord() {
    record = null;
    back();
  }

  function sheetKeys(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeRecord();
    }
  }

  let details = $state(false);
  let brief = $state(false);

  function title(gate: RunGateState): string {
    const who = gate.gate.who;
    const plan = gate.gate.when === "plan";
    if (gate.standing === "waived") return `${who} ${when(gate)}: waived`;
    if (gate.standing === "notNeeded") return `${who} ${when(gate)}: not needed`;
    if (gate.verdict === null) return `${who} ${when(gate)}: waiting`;
    if (gate.verdict.approved && gate.standing === "outOfDate") return `${who} approved an earlier ${plan ? "plan" : "change"}`;
    if (gate.verdict.approved) return `${who} approved the ${plan ? "plan" : "change"}`;
    return plan ? `${who} asked for changes to the plan` : `${who} asked for changes`;
  }

  /** What a verdict was given on: the plan by its version, or the change. */
  function reviewed(gate: RunGateState): string {
    if (gate.gate.when !== "plan") return "The change";
    return gate.verdict?.plan != null ? `Plan v${gate.verdict.plan}` : "The plan";
  }

  function summary(gate: RunGateState): string {
    const lines = [title(gate)];
    if (gate.verdict !== null) {
      lines.push(reviewed(gate));
      if (gate.verdict.findings.trim() !== "") lines.push("", gate.verdict.findings.trim());
    } else if (gate.waiver !== null) {
      lines.push(`Waived: ${gate.waiver.reason}`);
    } else {
      lines.push(gate.reason);
    }
    return lines.join("\n");
  }

  /** The session that gave the verdict, where it still has a row. */
  let giver = $derived(shown?.verdict ? byToken(shown.verdict.token) : null);

  function openSession() {
    if (giver === null) return;
    select(giver.key);
    record = null;
    from = null;
  }
</script>

{#if run !== null && line !== null}
  <div class="gbox" class:open class:quiet={!open && line.why === ""} data-testid="gate-line">
    <div class="gbar">
      <button
        type="button"
        class="toggle"
        aria-expanded={open}
        onclick={() => (open = !open)}
        title={open ? "Hide the gates" : "Show the gates"}
        data-testid="gate-line-toggle"
      >
        <span class="shield"><Icon name="shield" size={13} /></span>
        <b>Gates</b>
        <span data-testid="gate-line-count">{line.count}</span>
        {#if line.why !== ""}<span class="why" data-testid="gate-line-why">{line.why}</span>{/if}
        <span class="tg"><Icon name={open ? "down" : "upc"} size={12} /></span>
      </button>
      {#if gone}
        <button
          type="button"
          class="end"
          aria-expanded={ending}
          onclick={(event) => void askEnd(event)}
          title="Its lead is closed: end the run here"
          data-testid="gate-line-end">End run</button
        >
      {/if}
    </div>
    {#if ending}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="wpop" role="group" aria-labelledby="gate-end-{sessionKey}" bind:this={endSheet} onkeydown={endKeys} data-testid="gate-end-ask">
        <p id="gate-end-{sessionKey}"><b>End this run?</b> Its gates stop holding, for good.</p>
        {#if endRefused !== null}<p class="refused" role="alert" data-testid="gate-end-problem">{endRefused}</p>{/if}
        <div class="acts">
          <button type="button" class="quiet" onclick={cancelEnd}>Cancel</button>
          <button type="button" class="primary" onclick={() => void confirmEnd()} data-testid="gate-end-confirm">End run</button>
        </div>
      </div>
    {/if}
    {#if open}
      <ul class="rows" aria-label="Gates" data-testid="gate-rows">
        {#each run.gates as gate (gate.gate.id)}
          <li class="row {gate.standing}" data-testid="gate-row" data-standing={gate.standing}>
            <span class="gs"><Icon name={ICONS[gate.standing]} size={13} /></span>
            <span class="gn"><b>{gate.gate.who}</b><span class="on">{when(gate)}</span></span>
            {#if holds(gate)}
              <button type="button" class="wv" onclick={(event) => void askWhy(gate.gate.id, event)} data-testid="gate-waive">Waive</button>
            {/if}
            <span class="gv" data-testid="gate-standing">{WORDS[gate.standing]}</span>
            <button
              type="button"
              class="op"
              aria-label="The record of {gate.gate.who} {when(gate)}"
              onclick={(event) => void openRecord(gate.gate.id, event)}
              data-testid="gate-open"><Icon name="chev" size={12} /></button
            >
            {#if gate.gate.added}<span class="gsub">Added by the lead</span>{/if}
            {#if holds(gate) && gate.atLimit}<span class="gsub">{gate.reason}</span>{/if}
            {#if gate.folders.length > 1}
              {#each gate.folders as place (place.folder)}
                <span class="gsub" title={place.folder}><span class="place">{place.folder.split("/").at(-1)}</span>: {WORDS[place.standing].toLowerCase()}</span>
              {/each}
            {/if}
            {#if waiving === gate.gate.id}
              <form class="wpop" onsubmit={submitWaive} data-testid="gate-waive-ask">
                <label for="gate-why-{sessionKey}"><b>Why?</b></label>
                <textarea
                  id="gate-why-{sessionKey}"
                  bind:this={field}
                  bind:value={reason}
                  rows="2"
                  maxlength={run.reasonMost}
                  onkeydown={waiveKeys}
                  data-testid="gate-waive-why"></textarea>
                {#if refused !== null}<p class="refused" role="alert" data-testid="gate-waive-problem">{refused}</p>{/if}
                <div class="acts">
                  <button type="button" class="quiet" onclick={cancelWaive}>Cancel</button>
                  <button type="submit" class="primary" disabled={reason.trim() === ""} data-testid="gate-waive-confirm">Waive</button>
                </div>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#if shown !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={closeRecord} use:coversBrowser>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-record-{sessionKey}"
      tabindex="-1"
      bind:this={sheet}
      onclick={(event) => event.stopPropagation()}
      onkeydown={sheetKeys}
      data-testid="gate-record"
    >
      <div class="head">
        <span class="gs {shown.standing}"><Icon name={ICONS[shown.standing]} size={14} /></span>
        <h2 id="gate-record-{sessionKey}">{title(shown)}</h2>
        <button type="button" class="quiet copy" onclick={() => void copySummary(shown!)} data-testid="gate-record-copy"
          ><Icon name={copied ? "check" : "copy"} size={12} /><span aria-live="polite">{copied ? "Copied" : "Copy summary"}</span></button
        >
      </div>
      {#if shown.waiver !== null}
        <p class="note" data-testid="gate-record-waiver"><b>Waived by you, {at(shown.waiver.at)}.</b> {shown.waiver.reason}</p>
      {/if}
      {#if shown.verdict !== null}
        {@const verdict = shown.verdict}
        <p class="what">
          <Icon name={verdict.plan !== null ? "file" : "branch"} size={13} />
          <b>{reviewed(shown)}</b>
          <span>· {at(verdict.at)}</span>
        </p>
        <p class="vd" data-testid="gate-record-verdict">
          <b>{shown.standing === "outOfDate" ? "Out of date." : verdict.approved ? "Approved." : "Asked for changes."}</b>
          {shown.reason}
        </p>
        {#if verdict.findings.trim() !== ""}
          <p class="sub">Findings</p>
          <p class="find" data-testid="gate-record-findings">{verdict.findings.trim()}</p>
        {/if}
        <button type="button" class="fold" aria-expanded={details} onclick={() => (details = !details)} data-testid="gate-record-details">
          <span class="chev" class:turned={details}><Icon name="chev" size={12} /></span>Details
        </button>
        {#if details}
          <table class="rec">
            <tbody>
              <tr><th>Reviewed</th><td><code>{verdict.on.slice(0, 7)}</code>{#if verdict.folder !== null}<span class="m">{" · in "}<code>{verdict.folder}</code></span>{/if}</td></tr>
              <tr><th>Agent</th><td data-testid="gate-record-agent">{verdict.agent}</td></tr>
              <tr>
                <th>Brief</th>
                <td>
                  {#if brief}<p class="brief">{verdict.brief}</p>{/if}
                  <button type="button" class="link" onclick={() => (brief = !brief)}>{brief ? "Hide" : "Show"}</button>
                </td>
              </tr>
              <tr><th>Time</th><td>{at(verdict.at)}</td></tr>
            </tbody>
          </table>
        {/if}
      {:else if shown.waiver === null}
        <p class="vd">{shown.reason}</p>
      {/if}
      {#if shown.gate.added}
        <p class="what"><Icon name="shield" size={13} /><span>Added by the lead.</span></p>
      {/if}
      {#if shown.waiver !== null || shown.asks > 0 || shown.standing === "approved" || giver !== null}
        <div class="foot">
          <span>
            {#if shown.waiver !== null}For this run only
            {:else if shown.asks > 0}Asked for changes {times(shown.asks)}
            {:else if shown.standing === "approved"}
              Out of date if {shown.gate.when === "plan" ? "the plan" : "the tree"} changes
            {/if}
          </span>
          {#if giver !== null}
            <button type="button" class="btn" onclick={openSession} data-testid="gate-record-session">
              Open session
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gbox {
    position: relative;
    max-width: 740px;
    margin: 0 auto 6px;
    border-radius: calc(var(--radius) + 5px);
    background: var(--clear-surface);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font-family: var(--chrome);
  }

  .gbox.quiet {
    background: none;
    box-shadow: none;
  }

  .gbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 6px;
  }

  .gbox.open .gbar {
    border-bottom: 1px solid var(--divider, var(--rule));
  }

  .toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px 6px 12px;
    border: 0;
    border-radius: calc(var(--radius) + 5px);
    background: none;
    font: inherit;
    font-size: var(--conv-meta);
    letter-spacing: normal;
    text-transform: none;
    color: var(--ink-2);
    white-space: nowrap;
    text-align: left;
    cursor: pointer;
  }

  .quiet .toggle {
    padding-block: 2px;
    color: var(--ink-3);
  }

  .shield {
    flex: none;
    color: var(--accent);
  }

  .quiet .shield {
    color: var(--ink-3);
  }

  .toggle b {
    color: var(--ink);
    font-weight: 600;
  }

  .quiet .toggle b {
    color: var(--ink-3);
    font-weight: 500;
  }

  .why {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
  }

  .why::before {
    content: "·";
    margin-right: 8px;
    color: var(--ink-3);
  }

  .tg {
    margin-left: auto;
    flex: none;
    color: var(--ink-3);
  }

  .end {
    flex: none;
    font-size: var(--conv-meta);
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    position: relative;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto auto auto;
    column-gap: 9px;
    align-items: center;
    padding: 5px 8px 5px 12px;
    font-size: var(--conv-small);
  }

  .row + .row {
    border-top: 1px solid var(--divider, var(--rule));
  }

  .row:hover {
    background: var(--surface-2);
  }

  .gs {
    display: grid;
    place-items: center;
    width: 16px;
    color: var(--ink-3);
  }

  .gs.approved {
    color: var(--add);
  }

  .gn {
    grid-column: 2;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 7px;
    white-space: nowrap;
    overflow: hidden;
  }

  .gn b {
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
    color: var(--ink);
  }

  .on {
    flex: 0 1000 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--conv-meta);
    color: var(--ink-3);
  }

  .wv {
    grid-column: 3;
    opacity: 0;
    font-size: var(--conv-meta);
  }

  .row:hover .wv,
  .wv:focus-visible,
  .row:has(.wpop) .wv {
    opacity: 1;
  }

  .gv {
    grid-column: 4;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    white-space: nowrap;
  }

  .approved .gv {
    color: var(--add);
  }

  .notNeeded .gn b,
  .notNeeded .gv {
    color: var(--ink-3);
    font-weight: 400;
  }

  .op {
    grid-column: 5;
    display: grid;
    place-items: center;
    padding: 2px 4px;
    color: var(--accent);
  }

  .gsub {
    grid-column: 2 / -1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--conv-meta);
    line-height: 1.4;
    color: var(--ink-3);
  }

  .place {
    color: var(--ink-2);
  }

  button {
    border: 0;
    background: none;
    font: inherit;
    letter-spacing: normal;
    text-transform: none;
    cursor: pointer;
  }

  .wv,
  .end,
  .btn {
    padding: 1px 7px;
    border-radius: var(--radius-sm);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink);
    white-space: nowrap;
  }

  .wv:hover,
  .end:hover,
  .btn:hover {
    background: var(--surface-2);
  }

  .wpop {
    position: absolute;
    z-index: 6;
    right: 8px;
    bottom: calc(100% + 4px);
    width: min(300px, calc(100% - 16px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 11px 12px 12px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--paint-surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
    font-size: var(--conv-small);
    color: var(--ink-2);
  }

  .wpop p {
    margin: 0;
  }

  .wpop b {
    color: var(--ink);
    font-weight: 600;
  }

  textarea {
    min-height: 54px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    font: inherit;
    color: var(--ink);
    resize: vertical;
  }

  textarea:focus {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .refused {
    margin: 0;
    color: var(--del);
  }

  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .acts button {
    height: 26px;
    padding: 0 10px;
    border-radius: var(--radius);
    font-weight: 500;
  }

  .primary {
    background: var(--accent);
    color: var(--surface);
  }

  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .quiet {
    color: var(--ink-2);
  }

  .quiet:hover {
    color: var(--ink);
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }

  .sheet {
    width: min(560px, calc(100vw - 48px));
    max-height: 80vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px 14px;
    border-radius: calc(var(--radius) * 2);
    background: var(--paint-surface, var(--surface));
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 18px 48px color-mix(in srgb, black 35%, transparent);
    font-family: var(--chrome);
    font-size: var(--conv-small);
    line-height: 1.5;
    color: var(--ink-2);
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: calc(var(--conv-size) + 0.5px);
    font-weight: 600;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .copy {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--conv-meta);
    white-space: nowrap;
  }

  .sheet p {
    margin: 0;
  }

  .what {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--ink-2);
  }

  .what b {
    color: var(--ink);
    font-weight: 600;
  }

  .vd,
  .note {
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .vd b,
  .note b {
    color: var(--ink);
  }

  .sub {
    font-size: var(--conv-meta);
    color: var(--ink-3);
  }

  .find,
  .brief {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink);
  }

  .sheet .fold {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    color: var(--ink-2);
  }

  .chev {
    display: grid;
    transition: transform 120ms ease;
  }

  .chev.turned {
    transform: rotate(90deg);
  }

  .rec {
    width: 100%;
    border-collapse: collapse;
  }

  .rec th {
    width: 96px;
    padding: 5px 12px 5px 0;
    text-align: left;
    font-weight: 400;
    color: var(--ink-3);
    vertical-align: top;
    white-space: nowrap;
  }

  .rec td {
    padding: 5px 0;
    color: var(--ink);
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  .rec tr + tr th,
  .rec tr + tr td {
    border-top: 1px solid var(--divider, var(--rule));
  }

  .m {
    color: var(--ink-2);
  }

  code {
    font-family: var(--mono);
    font-size: var(--conv-fine);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }

  .link {
    padding: 0;
    color: var(--accent);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--divider, var(--rule));
    font-size: var(--conv-meta);
    color: var(--ink-3);
  }

  .foot .btn {
    margin-left: auto;
    height: 26px;
    padding: 0 10px;
  }
</style>
