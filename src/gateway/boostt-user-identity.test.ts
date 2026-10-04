import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { syncBoosttIdentity } from "../state/user-profile-writes.worker.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  createAuthenticatedBoosttIdentitySync,
  resolveBoosttAccount,
} from "./boostt-user-identity.js";

// A trusted proxy signed the person in against Boostt and forwarded their
// email and their Boostt token. The Gateway asks Boostt whose token it is,
// requires the same email, and gives the person's profile its identity.

vi.mock("../state/user-profile-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-profile-writes.js")>();
  return {
    ...actual,
    syncCanonicalBoosttIdentity: async (input: Parameters<typeof syncBoosttIdentity>[0]) =>
      syncBoosttIdentity(input),
  };
});

let rails: Server;
let apiUrl: string;
let state: OpenClawTestState;
const TOKEN = "doorkeeper-access-token-0123456789";
const meBearers: string[] = [];

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  rails = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/auth/me") {
      const auth = req.headers.authorization ?? "";
      meBearers.push(auth);
      if (auth !== `Bearer ${TOKEN}`) {
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

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
});

afterEach(async () => {
  await state.cleanup();
});

function authConfig(): GatewayAuthConfig {
  return {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto", "x-boostt-assertion"],
      boostt: { apiUrl, assertionHeader: "x-boostt-assertion" },
    },
  };
}

function admitted(user: string): GatewayAuthResult {
  return { ok: true, method: "trusted-proxy", user };
}

describe("boostt sign-in identity", () => {
  it("asks Boostt whose token it is and requires the proxy's principal", async () => {
    await expect(resolveBoosttAccount({ apiUrl }, TOKEN, "member@example.com")).resolves.toEqual({
      userId: 14145,
      email: "member@example.com",
      handle: "linna-hunt",
      displayName: "Linna Hunt",
    });
    await expect(
      resolveBoosttAccount({ apiUrl }, TOKEN, "someone-else@example.com"),
    ).rejects.toThrow(/principal did not match/);
    await expect(
      resolveBoosttAccount({ apiUrl }, "wrong-token", "member@example.com"),
    ).rejects.toThrow(/lookup failed/);
  });

  it("is absent unless the proxy is configured for Boostt and sent the assertion", () => {
    const base = { authResult: admitted("member@example.com"), authConfig: authConfig() };
    expect(createAuthenticatedBoosttIdentitySync({ ...base, requestHeaders: {} })).toBeUndefined();
    expect(
      createAuthenticatedBoosttIdentitySync({
        authResult: { ok: true, method: "token" },
        authConfig: authConfig(),
        requestHeaders: { "x-boostt-assertion": TOKEN },
      }),
    ).toBeUndefined();
    expect(
      createAuthenticatedBoosttIdentitySync({
        authResult: admitted("member@example.com"),
        authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
        requestHeaders: { "x-boostt-assertion": TOKEN },
      }),
    ).toBeUndefined();
    expect(
      createAuthenticatedBoosttIdentitySync({
        ...base,
        requestHeaders: { "x-boostt-assertion": TOKEN },
      }),
    ).toBeTypeOf("function");
  });

  it("gives the signed-in person a profile with the verified Boostt identity", async () => {
    const sync = createAuthenticatedBoosttIdentitySync({
      authResult: admitted("member@example.com"),
      authConfig: authConfig(),
      requestHeaders: { "x-boostt-assertion": TOKEN },
    })!;
    const result = await sync();
    const profile = getUserProfileListItem(result.profileId);
    expect(profile.emails).toEqual(["member@example.com"]);
    expect(profile.displayName).toBe("Linna Hunt");
    expect(profile.boosttIdentity).toEqual({ userId: 14145, handle: "linna-hunt" });
    expect(profile.id).not.toBe("gateway-owner");
    // The sync is resolved once per connection.
    const before = meBearers.length;
    expect(await sync()).toEqual(result);
    expect(meBearers.length).toBe(before);
  });

  it("refuses when Boostt names a different person than the proxy did", async () => {
    const sync = createAuthenticatedBoosttIdentitySync({
      authResult: admitted("impostor@example.com"),
      authConfig: authConfig(),
      requestHeaders: { "x-boostt-assertion": TOKEN },
    })!;
    await expect(sync()).rejects.toThrow(/principal did not match/);
  });
});
