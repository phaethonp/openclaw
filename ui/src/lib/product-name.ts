/** The product name shown in the UI. */
export const PRODUCT_NAME = "Urbicana";

/** Upstream's name for the project, as it appears in its catalogs and messages. */
export const UPSTREAM_NAME = "OpenClaw";

/**
 * Catalog keys that keep upstream's name on purpose. The MIT notice must stay
 * as written; add a key here only with a reason beside it.
 */
export const BRAND_EXEMPT_KEYS: ReadonlySet<string> = new Set([
  "aboutPage.license", // "© 2026 OpenClaw Foundation — MIT License."
]);

const UPSTREAM_NAME_RE = /\bOpenClaw\b/g;

/**
 * The catalog's door: every string that leaves the translation lookup passes
 * through here. Upstream's catalogs keep their wording; the product name is
 * applied as the string is read, so new upstream strings are covered without
 * editing them. Only the exact display form is touched; glued identifiers
 * such as "OpenClawKit" and lowercase names such as "openclaw" are not.
 */
export function brandText(key: string, value: string): string {
  if (BRAND_EXEMPT_KEYS.has(key) || !value.includes(UPSTREAM_NAME)) {
    return value;
  }
  return value.replace(UPSTREAM_NAME_RE, PRODUCT_NAME);
}
