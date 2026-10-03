import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readBoosttIdentityForProfile } from "../state/user-boostt-connections.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import {
  BOOSTT_CALLBACK_PATH,
  createBoosttAccountService,
  createPkcePair,
  handleBoosttOAuthCallback,
  normalizeRedirectOrigin,
} from "./boostt-account.js";

// The whole connection against a stub of Rails's OAuth server: register the
// client, build the authorize URL with PKCE, take the redirect, exchange the
// code with the verifier, ask who the token belongs to, and land the account
// and the `boostt` identity on the owner profile.

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

let rails: Server;
let apiUrl: string;
const seen = {
  registrations: [] as Array<Record<string, unknown>>,
  tokenRequests: [] as URLSearchParams[],
  meBearers: [] as string[],
};
const ISSUED_CODE = "code-42";
const ACCESS_TOKEN = "doorkeeper-access-token-0123456789";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: apiUrl,
        authorization_endpoint: `${apiUrl}/oauth/authorize`,
        token_endpoint: `${apiUrl}/oauth/token`,
        registration_endpoint: `${apiUrl}/oauth/register`,
      });
    }
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      seen.registrations.push(body);
      return json(res, 201, { client_id: "client-abc", redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      seen.tokenRequests.push(form);
      if (form.get("code") !== ISSUED_CODE || !form.get("code_verifier")) {
        return json(res, 400, { error: "invalid_grant" });
      }
      return json(res, 200, {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: "doorkeeper-refresh-token-0123456789",
      });
    }
    if (url.pathname === "/api/v1/auth/me") {
      const auth = req.headers.authorization ?? "";
      seen.meBearers.push(auth);
      if (auth !== `Bearer ${ACCESS_TOKEN}`) {
        return json(res, 401, { success: false });
      }
      return json(res, 200, {
        success: true,
        user: {
          id: 14145,
          email: "Member@Example.com",
          first_name: "Linna",
          last_name: "Hunt",
          slug: "linna-hunt",
        },
      });
    }
    json(res, 404, {});
  };
  rails = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => {
    rails.listen(0, "127.0.0.1", () => resolve());
  });
  apiUrl = `http://127.0.0.1:${(rails.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    rails.close(() => resolve());
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-boostt-account-"), "openclaw.sqlite") };
}

function fakeResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 0,
    body: "",
    setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
    end: (chunk?: string) => {
      res.body = chunk ?? "";
    },
    headers,
  };
  return res;
}

describe("boostt account", () => {
  it("normalizes the browser origin and refuses anything that is not a bare origin", () => {
    expect(normalizeRedirectOrigin("http://127.0.0.1:19102/")).toBe("http://127.0.0.1:19102");
    expect(normalizeRedirectOrigin("https://cell.example.com")).toBe("https://cell.example.com");
    expect(() => normalizeRedirectOrigin("http://127.0.0.1:19102/chat")).toThrow(/bare/);
    expect(() => normalizeRedirectOrigin("ftp://x")).toThrow(/http/);
    expect(() => normalizeRedirectOrigin("nonsense")).toThrow(/origin/);
  });

  it("creates an S256 PKCE pair", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("connects the owner profile through start, redirect, exchange, and me", async () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const action = { owner: owner.id, assertCurrent: () => {} };
    const service = createBoosttAccountService({ apiUrl, stateOptions: options });

    expect(service.status(action)).toEqual({
      state: "disconnected",
      account: null,
      connectedAtMs: null,
      pending: null,
    });

    const started = await service.startAuthorization(action, {
      redirectOrigin: "http://127.0.0.1:19102",
    });
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${apiUrl}/oauth/authorize`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("client_id")).toBe("client-abc");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:19102${BOOSTT_CALLBACK_PATH}`,
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorize.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(seen.registrations.at(-1)).toMatchObject({
      client_name: "Urbicana",
      token_endpoint_auth_method: "none",
      redirect_uris: [`http://127.0.0.1:19102${BOOSTT_CALLBACK_PATH}`],
    });
    expect(service.pollAuthorization(action, started.requestId)).toEqual({
      status: "pending",
      retryAfterMs: 2000,
    });
    expect(service.status(action).pending?.requestId).toBe(started.requestId);

    // The member approved at Boostt; Rails redirects the browser to the cell.
    const res = fakeResponse();
    const handled = await handleBoosttOAuthCallback(
      {
        method: "GET",
        url: `${BOOSTT_CALLBACK_PATH}?code=${ISSUED_CODE}&state=${encodeURIComponent(state!)}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      { log: { warn: () => {} }, stateOptions: options },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("connected");
    const exchange = seen.tokenRequests.at(-1)!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("client_id")).toBe("client-abc");
    expect(exchange.get("redirect_uri")).toBe(`http://127.0.0.1:19102${BOOSTT_CALLBACK_PATH}`);
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(seen.meBearers.at(-1)).toBe(`Bearer ${ACCESS_TOKEN}`);

    const account = {
      userId: 14145,
      email: "member@example.com",
      displayName: "Linna Hunt",
      handle: "linna-hunt",
    };
    expect(service.pollAuthorization(action, started.requestId)).toEqual({
      status: "success",
      account,
    });
    const status = service.status(action);
    expect(status.state).toBe("connected");
    expect(status.account).toEqual(account);
    expect(status.pending).toBeNull();
    expect(readBoosttIdentityForProfile(owner.id, options)).toEqual({
      userId: 14145,
      handle: "linna-hunt",
    });

    service.disconnect(action);
    expect(service.status(action).state).toBe("disconnected");
    expect(readBoosttIdentityForProfile(owner.id, options)).toBeUndefined();
  });

  it("answers an unknown or reused state with the expired page and never calls Rails", async () => {
    const options = stateOptions();
    ensureGatewayOwnerProfile(null, options);
    const before = seen.tokenRequests.length;
    const res = fakeResponse();
    const handled = await handleBoosttOAuthCallback(
      {
        method: "GET",
        url: `${BOOSTT_CALLBACK_PATH}?code=x&state=unknown-state-value`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      { log: { warn: () => {} }, stateOptions: options },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(seen.tokenRequests.length).toBe(before);
  });

  it("ignores other paths and methods", async () => {
    const res = fakeResponse();
    expect(
      await handleBoosttOAuthCallback(
        { method: "GET", url: "/oauth/mcp/callback" } as IncomingMessage,
        res as unknown as ServerResponse,
        { log: { warn: () => {} } },
      ),
    ).toBe(false);
    expect(
      await handleBoosttOAuthCallback(
        { method: "POST", url: BOOSTT_CALLBACK_PATH } as IncomingMessage,
        res as unknown as ServerResponse,
        { log: { warn: () => {} } },
      ),
    ).toBe(false);
  });

  it("a denied approval lands on the retry page and leaves nothing connected", async () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const action = { owner: owner.id, assertCurrent: () => {} };
    const service = createBoosttAccountService({ apiUrl, stateOptions: options });
    const started = await service.startAuthorization(action, {
      redirectOrigin: "http://127.0.0.1:19102",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const res = fakeResponse();
    await handleBoosttOAuthCallback(
      {
        method: "GET",
        url: `${BOOSTT_CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(state)}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      { log: { warn: () => {} }, stateOptions: options },
    );
    expect(res.statusCode).toBe(400);
    expect(service.status(action).state).toBe("disconnected");
    expect(service.cancelAuthorization(action, started.requestId)).toBe(true);
    expect(service.pollAuthorization(action, started.requestId)).toEqual({ status: "expired" });
  });
});
