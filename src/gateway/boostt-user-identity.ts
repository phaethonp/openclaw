import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { VerifiedBoosttAccount } from "../state/user-profile-boostt-identity.js";
import { syncCanonicalBoosttIdentity } from "../state/user-profile-writes.js";
import type { GatewayAuthResult } from "./auth.js";
import type { AuthenticatedIdentitySync } from "./github-user-identity.types.js";
import { firstHeaderValue } from "./http-header-value.js";

// Boostt as a sign-in identity behind a trusted proxy.
//
// The proxy signs the person in against Boostt and forwards two headers: the
// user header trusted-proxy auth already reads (the person's email), and an
// assertion header carrying the person's Boostt access token. The Gateway does
// what it does for a Cloudflare Access assertion: it does not trust the
// header alone, it asks the identity provider. `GET /api/v1/auth/me` with that
// token must name the same email the proxy did; then the person's profile
// gets its verified Boostt identity at admission, the way a GitHub-backed
// sign-in gives a profile its verified GitHub account.
//
// Configuration: gateway.auth.trustedProxy.boostt { apiUrl, assertionHeader },
// with the assertion header also listed in trustedProxy.requiredHeaders.

const ME_PATH = "/api/v1/auth/me";
const ME_MAX_BYTES = 64 * 1024;
const ME_TIMEOUT_MS = 10_000;
const ASSERTION_MAX_BYTES = 8 * 1024;

type BoosttConfig = NonNullable<NonNullable<GatewayAuthConfig["trustedProxy"]>["boostt"]>;

function boosttAssertion(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
}): { config: BoosttConfig; assertion: string; principal: string } | undefined {
  const trustedProxy = params.authConfig?.trustedProxy;
  const config = trustedProxy?.boostt;
  if (
    !config ||
    !params.authResult.ok ||
    params.authResult.method !== "trusted-proxy" ||
    params.authConfig?.mode !== "trusted-proxy"
  ) {
    return undefined;
  }
  const header = normalizeLowercaseStringOrEmpty(config.assertionHeader);
  // The proxy must be made to send the assertion: a missing required header already fails auth.
  if (!trustedProxy.requiredHeaders?.some((h) => normalizeLowercaseStringOrEmpty(h) === header)) {
    return undefined;
  }
  const principal = params.authResult.user?.trim();
  const assertion = firstHeaderValue(params.requestHeaders?.[header])?.trim();
  if (!principal || !assertion || Buffer.byteLength(assertion, "utf8") > ASSERTION_MAX_BYTES) {
    return undefined;
  }
  return { config, assertion, principal };
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Boostt identity response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Asks Boostt whose token this is; the answer must name the proxy's principal. */
export async function resolveBoosttAccount(
  config: Pick<BoosttConfig, "apiUrl">,
  assertion: string,
  principal: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedBoosttAccount> {
  let payload: unknown;
  try {
    const response = await fetchImpl(`${config.apiUrl.replace(/\/$/, "")}${ME_PATH}`, {
      headers: { Authorization: `Bearer ${assertion}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(ME_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("identity response was not successful");
    }
    payload = JSON.parse(await readBounded(response, ME_MAX_BYTES));
  } catch {
    // Never attach the underlying error: it may carry the bearer.
    throw new Error("Boostt identity lookup failed");
  }
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.user)) {
    throw new Error("Boostt identity response is invalid");
  }
  const user = payload.user;
  const userId = Number(user.id);
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (!Number.isSafeInteger(userId) || userId <= 0 || !email) {
    throw new Error("Boostt identity response is invalid");
  }
  if (email.toLowerCase() !== principal.trim().toLowerCase()) {
    throw new Error("Boostt identity principal did not match");
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const profile = isRecord(user.profile) ? user.profile : undefined;
  return {
    userId,
    email: email.toLowerCase(),
    handle: text(user.slug) ?? text(profile?.slug) ?? text(user.handle),
    displayName:
      text(user.name) ??
      ([text(user.first_name), text(user.last_name)].filter(Boolean).join(" ") || null) ??
      text(user.business_name),
  };
}

/**
 * The connection-held sync for a Boostt-backed sign-in, or undefined when this
 * connection did not arrive through a proxy configured for Boostt.
 */
export function createAuthenticatedBoosttIdentitySync(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
  assertCurrent?: () => void;
  fetchImpl?: typeof fetch;
}): AuthenticatedIdentitySync | undefined {
  const found = boosttAssertion(params);
  if (!found) {
    return undefined;
  }
  let pending: Promise<{ profileId: string; updatedAt: number }> | undefined;
  return () => {
    pending ??= (async () => {
      params.assertCurrent?.();
      const account = await resolveBoosttAccount(
        found.config,
        found.assertion,
        found.principal,
        params.fetchImpl,
      );
      params.assertCurrent?.();
      const profile = await syncCanonicalBoosttIdentity(
        { account },
        { assertCurrent: params.assertCurrent },
      );
      params.assertCurrent?.();
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    })();
    return pending;
  };
}
