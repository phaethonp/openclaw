import { describe, expect, it } from "vitest";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import {
  isThemeId,
  normalizeThemeDefinition,
  normalizeThemeMode,
  parseThemeDefinition,
  resolveThemeBranding,
  THEME_COLOR_KEYS,
  type ThemePalette,
} from "./theme.js";

function createDarkTheme(palette: Partial<ThemePalette>) {
  return createThemeDefinitionFixture({ dark: createThemePaletteFixture(palette) });
}

describe("portable theme definition", () => {
  it("normalizes a complete dark-only palette and preserves supported color formats", () => {
    const definition = normalizeThemeDefinition(
      createThemeDefinitionFixture({
        name: " Xenovessel ",
        dark: createThemePaletteFixture({
          background: "oklch(15% 0.04 280deg)",
          foreground: "hsl(240 20% 95% / 0.9)",
          primary: "rgb(180, 255, 40)",
          accent: "color(display-p3 0.2 0.9 1)",
        }),
      }),
    );
    expect(definition.name).toBe("Xenovessel");
    expect(definition.light).toBeUndefined();
    expect(definition.dark?.accent).toBe("color(display-p3 0.2 0.9 1)");
    expect(definition).not.toHaveProperty("mascot");
    expect(definition).not.toHaveProperty("workingPhrases");
    expect(definition).not.toHaveProperty("critters");
    expect(definition).not.toHaveProperty("avatarHat");
  });

  it("ignores the retired mascot, critters and hat fields and normalizes custom working phrases", () => {
    const definition = normalizeThemeDefinition({
      ...createThemeDefinitionFixture({ workingPhrases: [" Building ", "x".repeat(24)] }),
      mascot: "claw",
      critters: ["fedora", "penguin"],
      avatarHat: "fedora",
    });
    expect(definition.workingPhrases).toEqual(["Building", "x".repeat(24)]);
    expect(definition).not.toHaveProperty("mascot");
    expect(definition).not.toHaveProperty("critters");
    expect(definition).not.toHaveProperty("avatarHat");
  });

  it.each([
    { workingPhrases: [] },
    { workingPhrases: Array.from({ length: 24 }, (_, index) => `Working ${index}`) },
  ])("accepts working phrases at the entry-count boundaries: %j", ({ workingPhrases }) => {
    expect(
      normalizeThemeDefinition(createThemeDefinitionFixture({ workingPhrases })).workingPhrases,
    ).toEqual(workingPhrases);
  });

  it.each([
    [{ workingPhrases: "Building" }, "must be an array"],
    [
      { workingPhrases: Array.from({ length: 25 }, (_, index) => `Working ${index}`) },
      "at most 24 entries",
    ],
    [{ workingPhrases: ["x".repeat(25)] }, "at most 24 characters"],
    [{ workingPhrases: ["Building", " Building "] }, "duplicate entries after trimming"],
    [{ workingPhrases: [" "] }, "nonempty text"],
    [{ workingPhrases: ["Build\ning"] }, "nonempty text"],
    [{ workingPhrases: ["Building\u007f"] }, "nonempty text"],
  ])("rejects invalid branding %j", (fields, message) => {
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), ...fields }),
    ).toThrow(message);
  });

  it.each([
    { background: "#000;display:none" },
    { background: "var(--other-theme)" },
    { background: "rgb()" },
    { background: "rgb(1, 2 3)" },
    { background: "rgb(1 2, 3)" },
    { background: "rgb(1, 2, 3 / .5)" },
    { background: "rgb(1%, 2, 3%)" },
    { background: "rgb(1. 2 3)" },
    { background: "rgb(1\u00a02\u00a03)" },
    { background: "hsl(180, 40, 50)" },
    { background: "hsl(180 40% 50% .5)" },
    { background: "lab(50%, 20, 10)" },
    { background: "color(srgb\u00a00 0 0)" },
    { background: "red/* hidden */" },
    { "font-sans": "var(--font-body)" },
    { "font-sans": "Roboto,,monospace" },
    { "font-sans": "123Font" },
    { "font-sans": "Foo.Bar" },
    { "font-sans": "-1font" },
    { "font-sans": "serif Foo" },
    { "font-sans": "Foo serif" },
    { "font-sans": "Foo inherit" },
    { "font-sans": "default Foo" },
    { "font-sans": "default" },
    { "font-sans": "-webkit-body Foo" },
  ])("rejects unsafe or malformed CSS values %j", (palette) => {
    expect(parseThemeDefinition(createDarkTheme(palette))).toBeNull();
  });

  it.each([
    "rgb(1 2 3)",
    "rgb(1e2 2 3)",
    "rgb(1% 2 3% / 50%)",
    "rgba(1, 2, 3, .5)",
    "rgb(1%, 2%, 3%, 50%)",
    "hsl(180 40 50 / .5)",
    "hsla(0.5turn, 40%, 50%, .5)",
    "lab(50% -20 10 / .5)",
    "lch(50% 20 180deg)",
    "oklab(50% -.2 .1 / 50%)",
    "oklch(50% 0.2 180)",
    "color(display-p3 .1 .2 .3 / .5)",
  ])("preserves supported color syntax: %s", (background) => {
    expect(normalizeThemeDefinition(createDarkTheme({ background })).dark?.background).toBe(
      background,
    );
  });

  it.each([
    "JetBrains Mono, monospace",
    "'A,B', monospace",
    "\"A'B\", 'C\"D'",
    '"123 Font", monospace',
    "'serif Foo', 'Foo serif', 'Foo inherit', 'default Foo', 'default', 'inherit'",
    "--font, Foo_Bar",
    '""',
  ])("preserves font family names: %s", (font) => {
    expect(
      normalizeThemeDefinition(createDarkTheme({ "font-sans": font })).dark?.["font-sans"],
    ).toBe(font);
  });

  it("rejects missing modes, incomplete palettes, unknown properties, and oversized stored values", () => {
    const { background: _background, ...incomplete } = createThemePaletteFixture();
    expect(() => normalizeThemeDefinition({ name: "Empty", description: "No colors" })).toThrow(
      "at least one",
    );
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), dark: incomplete }),
    ).toThrow("background");
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), css: "body {}" }),
    ).toThrow("unsupported field");
    const longColor = `rgb(0.${"1".repeat(85)} 0 0)`;
    const palette = createThemePaletteFixture(
      Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, longColor])),
    );
    expect(() =>
      normalizeThemeDefinition(createThemeDefinitionFixture({ light: palette, dark: palette })),
    ).toThrow("4096 bytes");
  });

  it.each([
    ["claw", true],
    ["custom", false],
    ["@scope/Pack/Entry/neon", true],
    ["user/xenovessel", true],
    ["space/../neon", false],
    ["space//neon", false],
    ["space\\entry/neon", false],
    ["space/entry/Neon", false],
    ["user/neon/more", false],
    [`${"a".repeat(251)}/neon`, true],
    [`${"a".repeat(252)}/neon`, false],
  ])("validates catalog identity %s", (id, expected) => {
    expect(isThemeId(id)).toBe(expected);
  });
});

it("resolves omitted branding to no working phrases and retains authored phrases", () => {
  expect(resolveThemeBranding(undefined)).toEqual({ workingPhrases: undefined });
  expect(resolveThemeBranding({})).toEqual({ workingPhrases: undefined });
  expect(resolveThemeBranding({ workingPhrases: [] })).toEqual({ workingPhrases: [] });
  expect(resolveThemeBranding({ workingPhrases: ["Building"] })).toEqual({
    workingPhrases: ["Building"],
  });
});

it.each([
  ["system", "system"],
  ["light", "light"],
  ["dark", "dark"],
  ["DARK", undefined],
  [" light ", undefined],
  [null, undefined],
])("normalizes only exact theme mode literals: %j", (input, expected) => {
  expect(normalizeThemeMode(input)).toBe(expected);
});
