import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";

let branding: ThemeBranding = {};

export function setCurrentThemeBranding(value: ThemeBranding): void {
  branding = value;
}

export function currentThemeBranding(): ThemeBranding {
  return branding;
}
