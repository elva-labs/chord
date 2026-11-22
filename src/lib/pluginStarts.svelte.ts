/**
 * The sessions a plugin started, by their rows, with the request the user
 * said yes to. Every run of such a row tells the core that request, which
 * is how the core knows the session as the plugin's own: the plugin is
 * told of it, by the `ref` it asked with, and may send it lines. The
 * record of open rows keeps it with the row, and the core keeps its own
 * on disk, so a row is the plugin's across a restart for as long as it is
 * open and the plugin's source is installed.
 */

export interface PluginStart {
  /** The machine the plugin runs on: the core's source. */
  source: string;
  plugin: string;
  project: string;
  /** The core's id for the request the user said yes to. */
  request: string;
}

const starts = $state({ byKey: {} as Record<string, PluginStart> });

/** A plugin started the session in this row. */
export function pluginStarted(key: string, start: PluginStart) {
  starts.byKey[key] = start;
}

/** What started the session in this row, when a plugin did. */
export function pluginStartOf(key: string): PluginStart | null {
  return starts.byKey[key] ?? null;
}

/** The row a plugin started for a request, when it did. */
export function rowOfRequest(source: string, plugin: string, request: string): string | null {
  return (
    Object.entries(starts.byKey).find(
      ([, start]) => start.source === source && start.plugin === plugin && start.request === request,
    )?.[0] ?? null
  );
}

const MARK = "plugin:";

/** What a line a plugin sends is kept under as its sender: no session's
    token, no folder and not the workbench can be it. */
export function pluginMark(source: string, plugin: string): string {
  return `${MARK}${JSON.stringify([source, plugin])}`;
}

/** The plugin a sender kept under its mark names, by its name; null for
    any other sender. */
export function pluginOfMark(from: string): string | null {
  if (!from.startsWith(MARK)) return null;
  try {
    const named: unknown = JSON.parse(from.slice(MARK.length));
    return Array.isArray(named) && typeof named[1] === "string" ? named[1] : null;
  } catch {
    return null;
  }
}

/** The mark of the plugin that started this row, when one did. */
export function pluginMarkFor(key: string): string | null {
  const start = pluginStartOf(key);
  return start === null ? null : pluginMark(start.source, start.plugin);
}

/** Test seam. */
export function resetPluginStarts() {
  starts.byKey = {};
}
