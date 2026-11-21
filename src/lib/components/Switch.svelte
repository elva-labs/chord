<script lang="ts">
  /**
   * The one control for a thing that is on or off. It carries its own name
   * for assistive technology, either as a label or as the id of the text
   * beside it, and says the new state when it is pressed.
   */
  let {
    on,
    onchange,
    label,
    labelledby,
    disabled = false,
    testid,
  }: {
    on: boolean;
    onchange: (next: boolean) => void;
    label?: string;
    labelledby?: string;
    disabled?: boolean;
    testid?: string;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  class="switch"
  class:on
  aria-checked={on}
  aria-label={label}
  aria-labelledby={labelledby}
  {disabled}
  onclick={() => onchange(!on)}
  data-testid={testid}><span class="knob"></span></button
>

<style>
  .switch {
    position: relative;
    flex: none;
    width: 30px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--rule-strong);
    cursor: pointer;
  }

  .switch.on {
    background: var(--accent);
  }

  .switch:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--surface);
    transition: transform 0.12s;
  }

  .switch.on .knob {
    transform: translateX(12px);
  }
</style>
