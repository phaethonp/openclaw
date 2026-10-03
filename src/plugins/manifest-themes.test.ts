import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createThemeDefinitionFixture } from "../../test/helpers/theme-fixture.js";
import { loadManifestThemeDefinitions } from "./manifest-theme-definitions.js";
import { normalizeManifestThemes } from "./manifest-themes.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const definition = createThemeDefinitionFixture();
const declaration: PluginManifestTheme = {
  id: "redhat",
  name: definition.name,
  description: definition.description,
  source: "theme.json",
};

function fixture() {
  const rootDir = tempDirs.make("openclaw-theme-");
  fs.writeFileSync(path.join(rootDir, "theme.json"), JSON.stringify(definition));
  const capture = () => {
    const diagnostics: PluginDiagnostic[] = [];
    const themes = withPluginCache(createPluginCache(), () =>
      loadManifestThemeDefinitions({
        pluginId: "theme-pack",
        rootDir,
        themes: [declaration],
        rejectHardlinks: true,
        diagnostics,
      }),
    );
    return { themes, diagnostics };
  };
  return { rootDir, capture };
}

describe("manifest themes", () => {
  it("normalizes a package-relative source path", () => {
    expect(
      normalizeManifestThemes([{ ...declaration, source: "./assets/theme.json" }], "theme-pack"),
    ).toEqual({ ok: true, themes: [{ ...declaration, source: "assets/theme.json" }] });
  });

  it("accepts and ignores the retired hats and critters keys", () => {
    expect(
      normalizeManifestThemes(
        [
          {
            ...declaration,
            hats: { beret: "beret.svg" },
            critters: { ferris: { source: "ferris.svg", title: "a crab", crossMs: 15000 } },
          },
        ],
        "theme-pack",
      ),
    ).toEqual({ ok: true, themes: [declaration] });
  });

  it("rejects unknown theme keys", () => {
    expect(normalizeManifestThemes([{ ...declaration, mascot: "claw" }], "theme-pack")).toEqual({
      ok: false,
      error: expect.stringContaining("themes[0]"),
    });
  });

  it("retains captured palettes after disk changes and reads replacements in the next generation", () => {
    const plugin = fixture();
    const before = plugin.capture();
    expect(before.diagnostics).toEqual([]);
    expect(before.themes?.[0]).toEqual({ id: "redhat", definition });
    const changed = { ...definition, description: "Changed on disk" };
    fs.writeFileSync(path.join(plugin.rootDir, "theme.json"), JSON.stringify(changed));
    const after = plugin.capture();
    expect(before.themes?.[0]?.definition.description).toBe(definition.description);
    expect(after.themes).toEqual([]);
    expect(after.diagnostics).toEqual([
      expect.objectContaining({
        level: "warn",
        pluginId: "theme-pack",
        message: expect.stringContaining("name and description must match"),
      }),
    ]);
  });
});
