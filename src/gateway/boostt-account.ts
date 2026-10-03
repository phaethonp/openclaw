import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "../infra/errors.js";
import { OAUTH_PAGE_CSP } from "../infra/oauth-page-csp.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { renderOAuthPage } from "../shared/oauth-page.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  disconnectedUserBoosttConnection,
  disconnectUserBoosttConnection,
  findUserBoosttPendingByState,
  readUserBoosttConnection,
  updateUserBoosttConnection,
  type BoosttAccount,
  type UserBoosttConnected,
  type UserBoosttConnection,
  type UserBoosttPending,
} from "../state/user-boostt-connections.js";
import type { PersonalGitHubAction } from "./github-personal-oauth.js";
import { preparePersonalConnectionAction } from "./server-methods/github-personal-authorization.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

// Settings → Profile → Boostt account: connecting a Gateway profile to a
// Boostt account, the way My GitHub connects it to a GitHub account.
//
// Rails is the authorization server (app_v2 Oauth::McpController: dynamic
// registration of a public client, authorization code with PKCE S256,
// Doorkeeper tokens, refresh_token grant). The flow:
//
//   users.boostt.authorize.start   register this Gateway as a client for its
//                                  redirect URI, build the authorize URL,
//                                  record the pending request on the profile
//   the member approves at Boostt in the browser
//   GET /oauth/boostt/callback     exchange the code with the verifier, ask
//                                  Rails whose token it is, store the account
//                                  and tokens as the profile's connection
//   users.boostt.authorize.poll    the Profile page sees the connection
//
// The connection is a credential the profile holds. It is not a profile
// identity; nothing here writes to user_profile_identities.

export const BOOSTT_CALLBACK_PATH = "/oauth/boostt/callback";
export const DEFAULT_BOOSTT_API_URL = "https://api.boostt.org";
const FEATURE = "Boostt account";
const CLIENT_NAME = "Urbicana";
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 60_000;
const CALLBACK_MAX_URL_BYTES = 8 * 1024;

export function resolveBoosttApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BOOSTT_API_URL?.trim() || DEFAULT_BOOSTT_API_URL).replace(/\/$/, "");
}

export type BoosttAccountAction = PersonalGitHubAction;

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

/** The acting profile comes from the live connection, as for every personal connection. */
export function prepareBoosttAccountAction(options: Request): BoosttAccountAction {
  return preparePersonalConnectionAction(options, "operator.read", FEATURE);
}

// ---------------------------------------------------------------------------
// Rails OAuth

type Endpoints = { authorization: string; token: string; registration: string };

const endpointCache = new Map<string, Promise<Endpoints>>();

/** RFC 8414 metadata, which Rails serves; Doorkeeper's default paths otherwise. */
export async function discoverBoosttEndpoints(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Endpoints> {
  const defaults: Endpoints = {
    authorization: `${apiUrl}/oauth/authorize`,
    token: `${apiUrl}/oauth/token`,
    registration: `${apiUrl}/oauth/register`,
  };
  return getOrCreatePromise(
    endpointCache,
    apiUrl,
    async () => {
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
    },
    { evictOnSettled: false },
  );
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

/** The browser origin the member is on; Boostt redirects back to it. */
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

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
};

type IssuedTokens = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAtMs: number | null;
};

async function requestTokens(
  apiUrl: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<{ status: "issued"; tokens: IssuedTokens } | { status: "refused"; code: string }> {
  const endpoints = await discoverBoosttEndpoints(apiUrl, fetchImpl);
  const res = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!res.ok || !accessToken) {
    return {
      status: "refused",
      code: typeof body?.error === "string" ? body.error : `http_${res.status}`,
    };
  }
  const expiresIn =
    typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return {
    status: "issued",
    tokens: {
      accessToken,
      refreshToken: typeof body?.refresh_token === "string" ? body.refresh_token : null,
      accessExpiresAtMs: expiresIn ? Date.now() + expiresIn * 1000 : null,
    },
  };
}

function exchangeCode(pending: UserBoosttPending, code: string, fetchImpl: typeof fetch) {
  return requestTokens(
    pending.apiUrl,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.codeVerifier,
    }),
    fetchImpl,
  );
}

function refreshTokens(
  apiUrl: string,
  clientId: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
) {
  return requestTokens(
    apiUrl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    fetchImpl,
  );
}

/** Rails says whose token it is; that answer is the account. */
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

// ---------------------------------------------------------------------------
// The service behind users.boostt.*

export type BoosttAccountStatus = {
  state: "connected" | "disconnected";
  account: BoosttAccount | null;
  connectedAtMs: number | null;
  accessExpiresAtMs: number | null;
  refreshState: "available" | "not_applicable" | "expired" | "failed";
  pending: { requestId: string; authorizeUrl: string; expiresAtMs: number } | null;
};

export type BoosttAuthorizePollResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "success"; account: BoosttAccount }
  | { status: "expired" };

function projectStatus(record: UserBoosttConnection | undefined, now: number): BoosttAccountStatus {
  const selection = record?.selection;
  const pending = record?.pending;
  const connected = selection?.kind === "connected" ? selection : undefined;
  return {
    state: connected ? "connected" : "disconnected",
    account: connected?.account ?? null,
    connectedAtMs: connected?.connectedAtMs ?? null,
    accessExpiresAtMs: connected?.accessExpiresAtMs ?? null,
    refreshState: !connected
      ? "not_applicable"
      : connected.refreshFailure
        ? connected.refreshFailure
        : connected.refreshToken && connected.accessExpiresAtMs !== null
          ? "available"
          : "not_applicable",
    pending:
      pending && pending.expiresAtMs > now
        ? {
            requestId: pending.requestId,
            authorizeUrl: pending.authorizeUrl,
            expiresAtMs: pending.expiresAtMs,
          }
        : null,
  };
}

function needsRefresh(selection: UserBoosttConnected, now: number): boolean {
  return (
    selection.refreshToken !== null &&
    selection.accessExpiresAtMs !== null &&
    selection.accessExpiresAtMs - REFRESH_AHEAD_MS <= now &&
    !selection.refreshFailure
  );
}

export function createBoosttAccountService(
  opts: {
    fetchImpl?: typeof fetch;
    apiUrl?: string;
    now?: () => number;
    database?: OpenClawStateDatabaseOptions;
  } = {},
) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = (opts.apiUrl ?? resolveBoosttApiUrl()).replace(/\/$/, "");
  const now = opts.now ?? (() => Date.now());
  const database = opts.database;
  const refreshes = new Map<string, Promise<void>>();

  const guard = (action: BoosttAccountAction) => action.assertCurrent();

  /** Refreshes an expiring token once per owner at a time; a refused grant is recorded, not retried. */
  const refresh = async (action: BoosttAccountAction): Promise<void> => {
    const initial = readUserBoosttConnection(action.owner, database);
    if (initial?.selection.kind !== "connected" || !needsRefresh(initial.selection, now())) {
      return;
    }
    await getOrCreatePromise(
      refreshes,
      action.owner,
      async () => {
        const record = readUserBoosttConnection(action.owner, database);
        const selection = record?.selection;
        if (!record || selection?.kind !== "connected" || !needsRefresh(selection, now())) {
          return;
        }
        const result = await refreshTokens(
          apiUrl,
          selection.clientId,
          selection.refreshToken!,
          fetchImpl,
        );
        // Compare-and-set on the generation read above: a disconnect or reconnect in
        // between wins, and this result is dropped.
        updateUserBoosttConnection(
          action.owner,
          (current) => {
            if (
              current?.generation !== record.generation ||
              current.selection.kind !== "connected"
            ) {
              throw new Error(`${FEATURE} changed during refresh.`);
            }
            if (result.status === "refused") {
              return {
                ...current,
                selection: {
                  ...current.selection,
                  refreshFailure: result.code === "invalid_grant" ? "expired" : "failed",
                },
              };
            }
            return {
              ...current,
              generation: randomUUID(),
              selection: {
                ...current.selection,
                accessToken: result.tokens.accessToken,
                refreshToken: result.tokens.refreshToken ?? current.selection.refreshToken,
                accessExpiresAtMs: result.tokens.accessExpiresAtMs,
                refreshFailure: undefined,
              },
            };
          },
          () => guard(action),
          database,
        );
      },
      { evictOnSettled: true },
    );
  };

  return {
    apiUrl,
    status(action: BoosttAccountAction): BoosttAccountStatus {
      guard(action);
      return projectStatus(readUserBoosttConnection(action.owner, database), now());
    },
    async startAuthorization(
      action: BoosttAccountAction,
      params: { redirectOrigin: string },
    ): Promise<{ requestId: string; authorizeUrl: string; expiresAtMs: number }> {
      guard(action);
      const origin = normalizeRedirectOrigin(params.redirectOrigin);
      const redirectUri = `${origin}${BOOSTT_CALLBACK_PATH}`;
      const endpoints = await discoverBoosttEndpoints(apiUrl, fetchImpl);
      guard(action);
      const clientId = await registerClient(endpoints, apiUrl, redirectUri, fetchImpl);
      guard(action);
      const { verifier, challenge } = createPkcePair();
      const state = base64url(randomBytes(24));
      const authorize = new URL(endpoints.authorization);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      const createdAtMs = now();
      const pending: UserBoosttPending = {
        requestId: randomUUID(),
        state,
        codeVerifier: verifier,
        clientId,
        redirectUri,
        apiUrl,
        authorizeUrl: authorize.toString(),
        createdAtMs,
        expiresAtMs: createdAtMs + PENDING_TTL_MS,
      };
      updateUserBoosttConnection(
        action.owner,
        (current) => ({ ...(current ?? disconnectedUserBoosttConnection()), pending }),
        () => guard(action),
        database,
      );
      return {
        requestId: pending.requestId,
        authorizeUrl: pending.authorizeUrl,
        expiresAtMs: pending.expiresAtMs,
      };
    },
    pollAuthorization(action: BoosttAccountAction, requestId: string): BoosttAuthorizePollResult {
      guard(action);
      const record = readUserBoosttConnection(action.owner, database);
      const selection = record?.selection;
      if (selection?.kind === "connected" && selection.completedRequestId === requestId) {
        return { status: "success", account: selection.account };
      }
      const pending = record?.pending;
      if (pending?.requestId === requestId && pending.expiresAtMs > now()) {
        return { status: "pending", retryAfterMs: 2000 };
      }
      return { status: "expired" };
    },
    cancelAuthorization(action: BoosttAccountAction, requestId: string): boolean {
      guard(action);
      const current = readUserBoosttConnection(action.owner, database);
      if (current?.pending?.requestId !== requestId) {
        return false;
      }
      updateUserBoosttConnection(
        action.owner,
        (record) => {
          if (record?.pending?.requestId !== requestId) {
            throw new Error(`${FEATURE} authorization changed.`);
          }
          return { ...record, pending: undefined };
        },
        () => guard(action),
        database,
      );
      return true;
    },
    disconnect(action: BoosttAccountAction): void {
      guard(action);
      disconnectUserBoosttConnection(action.owner, () => guard(action), database);
    },
    /** The bearer for this profile's Boostt tools, refreshed first when it is about to expire. */
    async accessToken(action: BoosttAccountAction): Promise<string | null> {
      guard(action);
      await refresh(action);
      guard(action);
      const selection = readUserBoosttConnection(action.owner, database)?.selection;
      return selection?.kind === "connected" ? selection.accessToken : null;
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

/** GET /oauth/boostt/callback?code=…&state=…; true when this handler owned the request. */
export async function handleBoosttOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    log: Pick<Console, "warn">;
    fetchImpl?: typeof fetch;
    database?: OpenClawStateDatabaseOptions;
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
  const found = state ? findUserBoosttPendingByState(state, params.database) : undefined;
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
    const exchange = await exchangeCode(found.pending, code, fetchImpl);
    if (exchange.status === "refused") {
      throw new Error(`Boostt refused the code (${exchange.code}).`);
    }
    const account = await readBoosttAccount(
      found.pending.apiUrl,
      exchange.tokens.accessToken,
      fetchImpl,
    );
    const connectedAtMs = Date.now();
    updateUserBoosttConnection(
      found.owner,
      (current) => {
        if (current?.pending?.requestId !== found.pending.requestId) {
          throw new Error(`${FEATURE} authorization changed.`);
        }
        return {
          version: 1,
          generation: randomUUID(),
          pending: undefined,
          selection: {
            kind: "connected",
            account,
            clientId: found.pending.clientId,
            accessToken: exchange.tokens.accessToken,
            refreshToken: exchange.tokens.refreshToken,
            accessExpiresAtMs: exchange.tokens.accessExpiresAtMs,
            connectedAtMs,
            completedRequestId: found.pending.requestId,
          },
        };
      },
      () => {},
      params.database,
    );
    respondHtml(res, 200, CONNECTED_HTML);
  } catch (error) {
    params.log.warn(`Boostt account connection failed: ${formatErrorMessage(error)}`);
    respondHtml(res, 400, RETRY_HTML);
  }
  return true;
}
