import {
  isThemeId,
  THEME_LOCAL_ID_PATTERN,
  THEME_NAME_MAX_LENGTH,
  THEME_DESCRIPTION_MAX_LENGTH,
} from "../../packages/gateway-protocol/src/theme.ts";
import type { PluginManifestTheme } from "./manifest-types.js";

const MAX_PLUGIN_THEMES = 32;

export function normalizeManifestThemes(
  value: unknown,
  pluginId: string,
  _manifestSource?: string,
): { ok: true; themes?: PluginManifestTheme[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_THEMES) {
    return {
      ok: false,
      error: `themes must be an array with at most ${MAX_PLUGIN_THEMES} entries`,
    };
  }
  if (value.length && (pluginId === "user" || !isThemeId(`${pluginId}/x`))) {
    return {
      ok: false,
      error: "themes require a portable plugin ID outside the reserved user namespace",
    };
  }
  const themes: PluginManifestTheme[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `themes[${index}] must be an object` };
    }
    // SAFETY: entry is a non-null, non-array object; every field is validated below.
    const { id, name, description, source } = entry as Record<string, unknown>;
    // hats and critters are retired artwork keys: accepted and ignored.
    if (
      Object.keys(entry).some(
        (key) => !["id", "name", "description", "source", "hats", "critters"].includes(key),
      ) ||
      typeof id !== "string" ||
      !THEME_LOCAL_ID_PATTERN.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > THEME_NAME_MAX_LENGTH ||
      typeof description !== "string" ||
      !description.trim() ||
      description.trim().length > THEME_DESCRIPTION_MAX_LENGTH ||
      Array.from(name + description).some(
        (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
      ) ||
      typeof source !== "string"
    ) {
      return {
        ok: false,
        error: `themes[${index}] requires a unique safe id, name, description, and JSON source`,
      };
    }
    const relativePath = source.replace(/^\.\//, "");
    if (!/^(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.json$/i.test(relativePath)) {
      return {
        ok: false,
        error: `themes[${index}].source must be a JSON file inside the plugin root`,
      };
    }
    themes.push({
      id,
      name: name.trim(),
      description: description.trim(),
      source: relativePath,
    });
    ids.add(id);
  }
  return { ok: true, themes };
}
