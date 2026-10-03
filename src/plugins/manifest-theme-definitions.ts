import {
  MAX_THEME_DEFINITION_BYTES,
  isThemeId,
  normalizeThemeDefinition,
} from "../../packages/gateway-protocol/src/theme.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";

/** Capture palettes so a published generation never reads changed files. */
export function loadManifestThemeDefinitions(params: {
  pluginId: string;
  rootDir: string;
  themes: readonly PluginManifestTheme[] | undefined;
  rejectHardlinks: boolean;
  diagnostics: PluginDiagnostic[];
}): PluginManifestRecord["themeDefinitions"] {
  if (!params.themes?.length) {
    return undefined;
  }
  return params.themes.flatMap((theme) => {
    try {
      if (params.pluginId === "user" || !isThemeId(`${params.pluginId}/${theme.id}`)) {
        throw new Error(
          "qualified theme ID must be portable, outside user/, and at most 256 characters",
        );
      }
      const file = readPluginCacheFile({
        rootDir: params.rootDir,
        relativePath: theme.source,
        rejectHardlinks: params.rejectHardlinks,
        // Formatting whitespace is allowed; normalized portable definitions remain <=4 KiB.
        maxBytes: MAX_THEME_DEFINITION_BYTES * 4,
      });
      if (!file.ok) {
        throw new Error("source must be a readable JSON file inside the plugin root");
      }
      const definition = normalizeThemeDefinition(JSON.parse(file.contents.toString("utf8")));
      if (definition.name !== theme.name || definition.description !== theme.description) {
        throw new Error("name and description must match the manifest declaration");
      }
      return [{ id: theme.id, definition }];
    } catch (error) {
      params.diagnostics.push({
        level: "warn",
        pluginId: params.pluginId,
        message: `theme ${theme.id} is unavailable: ${error instanceof Error ? error.message : "invalid definition"}`,
      });
      return [];
    }
  });
}
