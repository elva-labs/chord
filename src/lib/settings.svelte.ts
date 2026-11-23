/**
 * Whether the settings are open. Reached from the native menu, from its
 * accelerator, or from the app's own chord; all three land here, and opening
 * what is open is nothing, so a menu accelerator the webview also saw does
 * not open it twice.
 *
 * The composer's agent list opens them on a new agent, on the Agents tab,
 * and "Check setup" in the palette opens them on the Setup tab.
 */
export const settings = $state({
  open: false,
  /** The settings open on a new agent's form. */
  newAgent: false,
  /** The settings open on the Setup tab. */
  setup: false,
});

export function openSettings() {
  settings.open = true;
}

export function openNewAgent() {
  settings.newAgent = true;
  settings.open = true;
}

export function openSetup() {
  settings.setup = true;
  settings.open = true;
}

export function closeSettings() {
  settings.open = false;
}
