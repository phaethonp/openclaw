import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "../infra/errors.js";
import { OAUTH_PAGE_CSP } from "../infra/oauth-page-csp.js";
import { renderOAuthPage } from "../shared/oauth-page.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  beginUserBoosttAuthorization,
  cancelUserBoosttAuthorization,
  completeUserBoosttAuthorization,
  disconnectUserBoosttAccount,
  findUserBoosttPendingByState,
  readUserBoosttConnection,
  type BoosttAccount,
  type BoosttPendingAuthorization,
} from "../state/user-boostt-connections.js";
import { resolvePersonalGitHubOwner } from "../state/user-github-connections.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import { isIneligiblePersonalGatewayCaller } from "./server-methods/gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

// Connecting a Gateway profile to a Boostt account, from Settings → Profile.
//
// Rails is the authorization server (app_v2 Oauth::McpController): dynamic
// client registration of a public client, authorization code with PKCE S256,
// Doorkeeper access tokens. The flow here:
//
//   users.boostt.authorize.start  registers this Gateway as a client for its
//                                 redirect URI, builds the authorize URL,
//                                 records the pending state on the profile
//   the member approves at Boostt in their browser
//   GET /oauth/boostt/callback    exchanges the code, asks Rails who the
//                                 token belongs to (GET /api/v1/auth/me),
//                                 writes the account, tokens and the `boostt`
//                                 identity onto the profile
//   users.boostt.authorize.poll   the Profile page sees the connection
//
// The profile may be the cell's owner profile: the one person in a cell is
// the member, and nothing here asks for a second one.

export const BOOSTT_CALLBACK_PATH = "/oauth/boostt/callback";
export const DEFAULT_BOOSTT_API_URL = "https://api.boostt.org";
const PENDING_TTL_MS = 10 * 60_000;
const CLIENT_NAME = "Urbicana";
const CALLBACK_MAX_URL_BYTES = 8 * 1024;

export function resolveBoosttApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BOOSTT_API_URL?.trim();
  return (configured || DEFAULT_BOOSTT_API_URL).replace(/\/$/, "");
}

type Endpoints = { authorization: string; token: string; registration: string };

const endpointCache = new Map<string, Promise<Endpoints>>();

/** RFC 8414 metadata, which Rails serves; the Doorkeeper defaults otherwise. */
export async function discoverBoosttEndpoints(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Endpoints> {
  const defaults: Endpoints = {
    authorization: `${apiUrl}/oauth/authorize`,
    token: `${apiUrl}/oauth/token`,
    registration: `${apiUrl}/oauth/register`,
  };
  const cached = endpointCache.get(apiUrl);
  if (cached) {
    return cached;
  }
  const lookup = (async () => {
    try {
      const res = await fetchImpl(`${apiUrl}/.well-known/oauth-authorization-server`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        return defaults;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const pick = (key: string, fallback: string) =>
        typeof body[key] === "string" && /^https?:\/\//.test(body[key] as string)
          ? (body[key] as string)
          : fallback;
      return {
        authorization: pick("authorization_endpoint", defaults.authorization),
        token: pick("token_endpoint", defaults.token),
        registration: pick("registration_endpoint", defaults.registration),
      };
    } catch {
      return defaults;
    }
  })();
  endpointCache.set(apiUrl, lookup);
  lookup.catch(() => endpointCache.delete(apiUrl));
  return lookup;
}

const clientIdCache = new Map<string, string>();

async function registerClient(
  endpoints: Endpoints,
  apiUrl: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const key = `${apiUrl}\0${redirectUri}`;
  const known = clientIdCache.get(key);
  if (known) {
    return known;
  }
  const res = await fetchImpl(endpoints.registration, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = typeof body?.client_id === "string" ? body.client_id : "";
  if (!res.ok || !clientId) {
    throw new Error(
      `Boostt did not register this Gateway as a client (${res.status}${
        typeof body?.error_description === "string" ? `: ${body.error_description}` : ""
      }).`,
    );
  }
  clientIdCache.set(key, clientId);
  return clientId;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The browser origin the member is using; the callback must come back to it. */
export function normalizeRedirectOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("redirectOrigin must be an http(s) origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("redirectOrigin must be a bare http(s) origin.");
  }
  return url.origin;
}

export type BoosttAccountAction = { owner: string; assertCurrent: () => void };

export type BoosttAccountStatus = {
  state: "connected" | "disconnected";
  account: BoosttAccount | null;
  connectedAtMs: number | null;
  pending: { requestId: string; authorizeUrl: string; expiresAtMs: number } | null;
};

export type BoosttAuthorizePollResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "success"; account: BoosttAccount }
  | { status: "expired" }
  | { status: "failed"; reason: string };

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

/** Authority stays in this connection closure; a profile id alone grants nothing. */
export function prepareBoosttAccountAction(options: Request): BoosttAccountAction {
  const { client, context } = options;
  const resolveOwner = () => {
    if (
      !client?.connId ||
      client.connect?.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      options.signal?.aborted ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId)
    ) {
      throw new Error("A Boostt account is connected from a signed-in Gateway connection.");
    }
    if (isGatewayClientProfilePending(client)) {
      throw new Error("Profile verification is still running; retry in a moment.");
    }
    if (!operatorScopeSatisfied("operator.read", client.connect.scopes ?? [])) {
      throw new Error("Connecting a Boostt account requires operator.read access.");
    }
    const profile = client.authenticatedUserProfile?.profileId;
    const owner = profile ? resolvePersonalGitHubOwner(profile) : undefined;
    if (!owner) {
      throw new Error("This connection has no durable profile to connect a Boostt account to.");
    }
    return owner;
  };
  const owner = resolveOwner();
  return {
    owner,
    assertCurrent: () => {
      if (resolveOwner() !== owner) {
        throw new Error("The profile changed; retry from your current profile.");
      }
    },
  };
}

function projectPending(pending: BoosttPendingAuthorization | null, now: number) {
  return pending && pending.expiresAtMs > now
    ? {
        requestId: pending.requestId,
        authorizeUrl: pending.authorizeUrl,
        expiresAtMs: pending.expiresAtMs,
      }
    : null;
}

export function createBoosttAccountService(
  opts: {
    fetchImpl?: typeof fetch;
    apiUrl?: string;
    now?: () => number;
    stateOptions?: OpenClawStateDatabaseOptions;
  } = {},
) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = (opts.apiUrl ?? resolveBoosttApiUrl()).replace(/\/$/, "");
  const now = opts.now ?? (() => Date.now());
  const state = opts.stateOptions ?? {};

  function status(action: BoosttAccountAction): BoosttAccountStatus {
    action.assertCurrent();
    const connection = readUserBoosttConnection(action.owner, state);
    const account = connection?.account ?? null;
    return {
      state: account ? "connected" : "disconnected",
      account,
      connectedAtMs: connection?.connectedAtMs ?? null,
      pending: projectPending(connection?.pending ?? null, now()),
    };
  }

  return {
    apiUrl,
    status,
    async startAuthorization(
      action: BoosttAccountAction,
      params: { redirectOrigin: string },
    ): Promise<{ requestId: string; authorizeUrl: string; expiresAtMs: number }> {
      action.assertCurrent();
      const origin = normalizeRedirectOrigin(params.redirectOrigin);
      const redirectUri = `${origin}${BOOSTT_CALLBACK_PATH}`;
      const endpoints = await discoverBoosttEndpoints(apiUrl, fetchImpl);
      action.assertCurrent();
      const clientId = await registerClient(endpoints, apiUrl, redirectUri, fetchImpl);
      action.assertCurrent();
      const { verifier, challenge } = createPkcePair();
      const oauthState = base64url(randomBytes(24));
      const authorize = new URL(endpoints.authorization);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", oauthState);
      const createdAtMs = now();
      const pending: BoosttPendingAuthorization = {
        requestId: randomUUID(),
        state: oauthState,
        codeVerifier: verifier,
        clientId,
        redirectUri,
        apiUrl,
        authorizeUrl: authorize.toString(),
        createdAtMs,
        expiresAtMs: createdAtMs + PENDING_TTL_MS,
      };
      beginUserBoosttAuthorization(action.owner, pending, state);
      return {
        requestId: pending.requestId,
        authorizeUrl: pending.authorizeUrl,
        expiresAtMs: pending.expiresAtMs,
      };
    },
    pollAuthorization(action: BoosttAccountAction, requestId: string): BoosttAuthorizePollResult {
      action.assertCurrent();
      const connection = readUserBoosttConnection(action.owner, state);
      if (connection?.completedRequestId === requestId && connection.account) {
        return { status: "success", account: connection.account };
      }
      const pending = connection?.pending;
      if (pending && pending.requestId === requestId) {
        return pending.expiresAtMs > now()
          ? { status: "pending", retryAfterMs: 2000 }
          : { status: "expired" };
      }
      return { status: "expired" };
    },
    cancelAuthorization(action: BoosttAccountAction, requestId: string): boolean {
      action.assertCurrent();
      return cancelUserBoosttAuthorization(action.owner, requestId, state);
    },
    disconnect(action: BoosttAccountAction): void {
      action.assertCurrent();
      disconnectUserBoosttAccount(action.owner, state);
    },
  };
}

export type BoosttAccountService = ReturnType<typeof createBoosttAccountService>;

// ---------------------------------------------------------------------------
// The redirect from Boostt

const CONNECTED_HTML = renderOAuthPage({
  title: "Boostt account connected",
  heading: "Your Boostt account is connected.",
  message: "Return to Urbicana. The Profile page now shows your account.",
});
const RETRY_HTML = renderOAuthPage({
  title: "Connection incomplete",
  heading: "The Boostt connection was not completed.",
  message: "Return to Urbicana and connect again from Settings → Profile.",
});
const EXPIRED_HTML = renderOAuthPage({
  title: "Link expired",
  heading: "This connection link expired or was already used.",
  message: "Return to Urbicana and connect again from Settings → Profile.",
});

function respondHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", OAUTH_PAGE_CSP);
  res.end(body);
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

async function exchangeCode(
  pending: BoosttPendingAuthorization,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAtMs: number | null }> {
  const endpoints = await discoverBoosttEndpoints(pending.apiUrl, fetchImpl);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
  });
  const res = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!res.ok || !accessToken) {
    throw new Error(
      `Boostt refused the code (${res.status}${
        typeof body?.error === "string" ? `: ${body.error}` : ""
      }).`,
    );
  }
  const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof body?.refresh_token === "string" ? body.refresh_token : null,
    expiresAtMs: expiresIn ? Date.now() + expiresIn * 1000 : null,
  };
}

/** Rails says who the token belongs to; that answer is the account. */
export async function readBoosttAccount(
  apiUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoosttAccount> {
  const res = await fetchImpl(`${apiUrl}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const user = (body?.user ?? null) as Record<string, unknown> | null;
  const userId = Number(user?.id);
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!res.ok || body?.success !== true || !Number.isInteger(userId) || userId <= 0 || !email) {
    throw new Error(`Boostt did not name the account for this token (${res.status}).`);
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const displayName =
    text(user?.name) ??
    ([text(user?.first_name), text(user?.last_name)].filter(Boolean).join(" ") || null) ??
    text(user?.business_name);
  const profile = (user?.profile ?? null) as Record<string, unknown> | null;
  const handle = text(user?.slug) ?? text(profile?.slug) ?? text(user?.handle);
  return { userId, email, displayName, handle };
}

/** GET /oauth/boostt/callback?code=…&state=…; true when this handler owned the request. */
export async function handleBoosttOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    log: Pick<Console, "warn">;
    fetchImpl?: typeof fetch;
    stateOptions?: OpenClawStateDatabaseOptions;
  },
): Promise<boolean> {
  if (req.method !== "GET") {
    return false;
  }
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname !== BOOSTT_CALLBACK_PATH) {
    return false;
  }
  if (Buffer.byteLength(rawUrl, "utf8") > CALLBACK_MAX_URL_BYTES) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const state = url.searchParams.get("state")?.trim();
  const found = state ? findUserBoosttPendingByState(state, params.stateOptions) : undefined;
  if (!found) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }
  if (url.searchParams.has("error")) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  try {
    const tokens = await exchangeCode(found.pending, code, fetchImpl);
    const account = await readBoosttAccount(found.pending.apiUrl, tokens.accessToken, fetchImpl);
    completeUserBoosttAuthorization(
      { profileId: found.profileId, requestId: found.pending.requestId, account, tokens },
      params.stateOptions,
    );
    respondHtml(res, 200, CONNECTED_HTML);
  } catch (error) {
    params.log.warn(`Boostt account connection failed: ${formatErrorMessage(error)}`);
    respondHtml(res, 400, RETRY_HTML);
  }
  return true;
}
