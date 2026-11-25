/**
 * The commands plugins put in the palette, per project.
 *
 * A plugin sends its whole list for a project whenever it changes, so the
 * window keeps the latest of each and never merges; an empty list is the
 * plugin's commands gone from that project, which is what a plugin stopping
 * looks like from here. The palette lists the commands of the project on
 * screen, and none while no project is.
 *
 * Picking one tells the plugin, which answers by what it already can do:
 * open its page, ask to start a session, or open an address. What goes
 * wrong is said in the status bar, at once when the core refuses the pick,
 * and later as the plugin's notice when it fails, stops or never answers.
 */

import { core, type PluginPaletteEvent } from "$lib/core";
import { say } from "$lib/flash.svelte";
import { activeSession } from "$lib/sessions.svelte";
import { workspace } from "$lib/workspace.svelte";

/** One plugin command as the palette lists it. */
export interface PluginCommand {
  source: string;
  plugin: string;
  project: string;
  /** The id the plugin knows the command by. */
  command: string;
  label: string;
}

export const pluginPalette = $state({
  lists: [] as PluginPaletteEvent[],
});

/** The latest list a plugin sent for a project. */
export function paletteChanged(event: PluginPaletteEvent) {
  const at = pluginPalette.lists.findIndex(
    (list) =>
      list.source === event.source &&
      list.plugin === event.plugin &&
      list.project === event.project,
  );
  if (event.commands.length === 0) {
    if (at !== -1) pluginPalette.lists.splice(at, 1);
    return;
  }
  if (at === -1) pluginPalette.lists.push(event);
  else pluginPalette.lists[at] = event;
}

/** The plugins' commands for the project on screen, plugin by plugin and
    each plugin's in the order it sent them. */
export function paletteCommands(): PluginCommand[] {
  const project = workspace.active;
  if (project === null) return [];
  return pluginPalette.lists
    .filter((list) => list.project === project)
    .sort(
      (a, b) =>
        a.plugin.localeCompare(b.plugin) || a.source.localeCompare(b.source),
    )
    .flatMap((list) =>
      list.commands.map((command) => ({
        source: list.source,
        plugin: list.plugin,
        project: list.project,
        command: command.id,
        label: command.label,
      })),
    );
}

/** Tells the plugin its command was picked, with the session on screen when
    it is the project's. A pick the core refuses is said in the status bar. */
export async function pickPluginCommand(command: PluginCommand) {
  const session = activeSession();
  try {
    await core().pluginPalettePick({
      source: command.source,
      plugin: command.plugin,
      command: command.command,
      project: command.project,
      session:
        session !== null && session.project === command.project
          ? session.token
          : null,
    });
  } catch (error) {
    say(`${command.label}: ${String(error)}`);
  }
}

/** Test seam. */
export function resetPluginPalette() {
  pluginPalette.lists = [];
}
