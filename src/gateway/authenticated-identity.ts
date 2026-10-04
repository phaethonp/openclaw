import type { IncomingHttpHeaders } from "node:http";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { GatewayAuthResult } from "./auth.js";
import { createAuthenticatedBoosttIdentitySync } from "./boostt-user-identity.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import type { AuthenticatedIdentitySync } from "./github-user-identity.types.js";

/**
 * The one verified-identity sync a connection may carry: GitHub through
 * Cloudflare Access or Tailscale, or Boostt through a trusted proxy. Admission
 * resolves whichever applies; a connection with neither gets its profile from
 * the proxy's email or Tailscale login as before.
 */
export function createAuthenticatedIdentitySync(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
  assertCurrent?: () => void;
}): AuthenticatedIdentitySync | undefined {
  return (
    createAuthenticatedGitHubIdentitySync(params) ?? createAuthenticatedBoosttIdentitySync(params)
  );
}
