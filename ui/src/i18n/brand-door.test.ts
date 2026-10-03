// The product name is applied where a string leaves the catalog, never by
// editing upstream's catalogs. This proves both halves: the catalogs still
// carry upstream's name, and nothing that reaches a screen does, except the
// keys listed as exempt.
import { describe, expect, it } from "vitest";
import { BRAND_EXEMPT_KEYS, PRODUCT_NAME, UPSTREAM_NAME, brandText } from "../lib/product-name.ts";
import { i18n, t } from "./index.ts";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, loadLazyLocaleTranslation } from "./lib/registry.ts";
import type { TranslationMap } from "./lib/types.ts";
import { en } from "./locales/en.ts";

function* leaves(map: TranslationMap, prefix = ""): Generator<[string, string]> {
  for (const [key, value] of Object.entries(map)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      yield [path, value];
    } else {
      yield* leaves(value, path);
    }
  }
}

describe("brand door", () => {
  it("leaves upstream's English catalog as upstream wrote it", () => {
    const named = [...leaves(en)].filter(([, value]) => value.includes(UPSTREAM_NAME));
    expect(named.length).toBeGreaterThan(0);
  });

  it("applies the product name to every English string that reaches a screen", async () => {
    await i18n.setLocale("en");
    const leaks = [...leaves(en)]
      .filter(([key]) => !BRAND_EXEMPT_KEYS.has(key))
      .map(([key]) => [key, t(key)] as const)
      .filter(([, shown]) => new RegExp(`\\b${UPSTREAM_NAME}\\b`).test(shown));
    expect(leaks).toEqual([]);
    expect(t("aboutPage.license")).toContain(`${UPSTREAM_NAME} Foundation`);
  });

  it.each(SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE))(
    "applies the product name to every %s string that reaches a screen",
    async (locale) => {
      const map = await loadLazyLocaleTranslation(locale);
      expect(map).not.toBeNull();
      const leaks = [...leaves(map!)]
        .filter(([key]) => !BRAND_EXEMPT_KEYS.has(key))
        .filter(([key, value]) => new RegExp(`\\b${UPSTREAM_NAME}\\b`).test(brandText(key, value)));
      expect(leaks).toEqual([]);
    },
  );

  it("touches only the exact display form", () => {
    expect(brandText("x", "Run `openclaw onboard` on the machine running OpenClaw.")).toBe(
      `Run \`openclaw onboard\` on the machine running ${PRODUCT_NAME}.`,
    );
    expect(brandText("x", "apps/shared/OpenClawKit/Sources")).toBe(
      "apps/shared/OpenClawKit/Sources",
    );
    expect(brandText("x", "OpenClaw's gateway")).toBe(`${PRODUCT_NAME}'s gateway`);
  });
});
