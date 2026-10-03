import type { ThemeCatalogEntry } from "../../../packages/gateway-protocol/src/theme.js";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";

export function pluginTheme(): ThemeCatalogEntry {
  const definition = createThemeDefinitionFixture({
    workingPhrases: ["Building"],
  });
  return {
    id: "space-pack/xenovessel",
    name: definition.name,
    description: definition.description,
    workingPhrases: definition.workingPhrases,
    source: "plugin",
    pluginId: "space-pack",
    modes: ["dark"],
    definition,
  };
}
