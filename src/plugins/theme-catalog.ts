import type { ThemeCatalogEntry } from "../../packages/gateway-protocol/src/theme.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

const catalogByPlugin = new WeakMap<PluginManifestRecord, ThemeCatalogEntry[]>();

function currentSnapshot() {
  // Appearance follows the live Gateway even when an agent retains an older runtime scope.
  return getProcessGatewayPluginMetadataSnapshot() ?? getCurrentPluginMetadataSnapshot();
}

function pluginThemes(plugin: PluginManifestRecord): ThemeCatalogEntry[] {
  const cached = catalogByPlugin.get(plugin);
  if (cached) {
    return cached;
  }
  const themes: ThemeCatalogEntry[] = [];
  for (const { id, definition } of plugin.themeDefinitions ?? []) {
    themes.push({
      id: `${plugin.id}/${id}`,
      name: definition.name,
      description: definition.description,
      ...(definition.workingPhrases !== undefined
        ? { workingPhrases: definition.workingPhrases }
        : {}),
      source: "plugin",
      pluginId: plugin.id,
      modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
      definition,
    });
  }
  catalogByPlugin.set(plugin, themes);
  return themes;
}

/** Reads the published inventory only; explicit plugin lifecycle operations replace its palettes. */
export function listPluginThemes(): ThemeCatalogEntry[] {
  const snapshot = currentSnapshot();
  if (!snapshot) {
    return [];
  }
  const enabled = new Set(
    snapshot.index.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.pluginId),
  );
  return snapshot.plugins
    .flatMap((plugin): ThemeCatalogEntry[] => {
      if (!enabled.has(plugin.id)) {
        return [];
      }
      return pluginThemes(plugin);
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
