import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOf, resolveBoosttSettings, whoIs, type BoosttAccount } from "./src/account.js";
import {
  applyMarketplace,
  marketplaceServerEntry,
  writeMarketplaceEntry,
  type ConfigMutator,
} from "./src/marketplace.js";
import { createUrbicanaRouteHandler } from "./src/routes.js";
import { createUrbicanaService, OWNER_KEY, type OwnerStore } from "./src/service.js";
import { assertCardFileName, writeCardFile } from "./src/workspace.js";

const RAILS = "https://boostt.test";

/** Refuses what the Gateway's state store refuses: a value with an undefined field anywhere. */
function assertStorable(value: unknown, at = "value"): void {
  if (value === undefined) {
    throw new Error(`plugin state value at ${at} must be JSON-serializable`);
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertStorable(v, `${at}.${k}`);
    }
  }
}

function memoryStore(): OwnerStore & { map: Map<string, BoosttAccount> } {
  const map = new Map<string, BoosttAccount>();
  return {
    map,
    lookup: async (k) => map.get(k),
    register: async (k, v) => {
      assertStorable(v);
      map.set(k, structuredClone(v));
    },
    delete: async (k) => map.delete(k),
  };
}

const CARD = {
  name: "Phae",
  version: "2026-10-05T10:00:00Z",
  supported_interfaces: [
    { url: "https://geo.boostt.org/a2a/agents/phae/jsonrpc", protocol_binding: "JSONRPC" },
  ],
  skills: [{ id: "deeds", name: "Deeds", tags: ["service"] }],
};

/** A stub Boostt: one valid token, one user, one card. */
function stubBoostt(
  opts: { token?: string; card?: Record<string, unknown>; missing?: string[] } = {},
) {
  const token = opts.token ?? "tok-1";
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push(`${url} ${auth}`);
    if (auth !== `Bearer ${token}`) {
      return new Response("{}", { status: 401 });
    }
    if (url === `${RAILS}/api/v1/auth/me`) {
      return Response.json({
        success: true,
        user: { id: 42, email: "Phae@Example.com", name: "Phae" },
      });
    }
    if (url === `${RAILS}/api/v1/a2a/card`) {
      return Response.json({ card: opts.card ?? CARD, missing: opts.missing ?? [] });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

let workspace: string;
/** An in-memory agent config; the mutator applies the extension's writes to it. */
let config: Record<string, unknown>;
const mutateConfig: ConfigMutator = async (mutate) => {
  mutate(config as Parameters<typeof mutate>[0]);
};
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "urbicana-ws-"));
  config = {};
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("settings", () => {
  it("strips the trailing slash and defaults the card file", () => {
    expect(resolveBoosttSettings({ railsUrl: "https://boostt.test/" })).toEqual({
      railsUrl: "https://boostt.test",
      cardFile: "urbicana/IDENTITY.md",
      marketplaceMcpUrl: "https://geo.boostt.org/marketplace/mcp",
    });
    expect(resolveBoosttSettings(undefined)).toEqual({
      railsUrl: "",
      cardFile: "urbicana/IDENTITY.md",
      marketplaceMcpUrl: "https://geo.boostt.org/marketplace/mcp",
    });
    expect(
      resolveBoosttSettings({ marketplaceMcpUrl: "http://host.docker.internal:4110/mcp" })
        .marketplaceMcpUrl,
    ).toBe("http://host.docker.internal:4110/mcp");
  });
});

describe("card file name", () => {
  it("accepts only a bootstrap basename inside the workspace", () => {
    expect(() => assertCardFileName("urbicana/IDENTITY.md")).not.toThrow();
    expect(() => assertCardFileName("urbicana/card.md")).toThrow(
      /bootstrap hook loads no other name/,
    );
    expect(() => assertCardFileName("../IDENTITY.md")).toThrow(/relative path/);
    expect(() => assertCardFileName("/etc/IDENTITY.md")).toThrow(/relative path/);
  });
  it("writes atomically inside the workspace", () => {
    const target = writeCardFile(workspace, "urbicana/IDENTITY.md", "x");
    expect(fs.readFileSync(target, "utf8")).toBe("x");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["IDENTITY.md"]);
  });
});

describe("Boostt answers", () => {
  it("reads the owner from auth/me, email lowercased", async () => {
    const { fetchImpl } = stubBoostt();
    await expect(whoIs({ railsUrl: RAILS }, "tok-1", fetchImpl)).resolves.toEqual({
      userId: 42,
      email: "phae@example.com",
      handle: null,
      displayName: "Phae",
    });
  });
  it("refuses a token Boostt refuses, without the token in the message", async () => {
    const { fetchImpl } = stubBoostt();
    await expect(whoIs({ railsUrl: RAILS }, "tok-wrong", fetchImpl)).rejects.toThrow(
      /refused .*401/,
    );
    await expect(whoIs({ railsUrl: RAILS }, "tok-wrong", fetchImpl)).rejects.not.toThrow(
      /tok-wrong/,
    );
  });
  it("takes the handle from the card's interface url", () => {
    expect(handleOf(CARD)).toBe("phae");
    expect(handleOf({})).toBeNull();
  });
});

describe("service", () => {
  it("connects the owner, writes the card verbatim, and reports without the token", async () => {
    const { fetchImpl } = stubBoostt();
    const store = memoryStore();
    const now = new Date("2026-10-05T12:00:00Z");
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store,
      workspaceDir: () => workspace,
      fetchImpl,
      now: () => now,
    });

    const status = await service.connect("tok-1");
    expect(status).toEqual({
      connected: true,
      userId: 42,
      email: "phae@example.com",
      handle: "phae",
      displayName: "Phae",
      connectedAt: now.toISOString(),
      cardWrittenAt: now.toISOString(),
      cardVersion: CARD.version,
      cardFile: "urbicana/IDENTITY.md",
    });
    expect(JSON.stringify(status)).not.toContain("tok-1");
    expect(store.map.get(OWNER_KEY)?.accessToken).toBe("tok-1");

    const text = fs.readFileSync(path.join(workspace, "urbicana", "IDENTITY.md"), "utf8");
    expect(text).toContain("acts for @phae (Boostt user 42), phae@example.com");
    const json = /```json\n([\s\S]*?)\n```/u.exec(text)?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(CARD);
  });

  it("names what the card still lacks", async () => {
    const { fetchImpl } = stubBoostt({ missing: ["description"] });
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl,
    });
    await service.connect("tok-1");
    expect(fs.readFileSync(path.join(workspace, "urbicana", "IDENTITY.md"), "utf8")).toContain(
      "still missing: description",
    );
  });

  it("keeps the owner when the card cannot be read, and refresh retries", async () => {
    let cardDown = true;
    const inner = stubBoostt().fetchImpl;
    const fetchImpl: typeof fetch = (input, init) =>
      cardDown && String(input).endsWith("/a2a/card")
        ? Promise.resolve(new Response("", { status: 503 }))
        : inner(input, init);
    const warn = vi.fn();
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl,
      log: { info: () => undefined, warn },
    });

    const status = await service.connect("tok-1");
    expect(status.connected).toBe(true);
    expect(status.cardWrittenAt).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("card could not be written"));
    expect(fs.existsSync(path.join(workspace, "urbicana", "IDENTITY.md"))).toBe(false);

    cardDown = false;
    const refreshed = await service.refresh();
    expect(refreshed.cardWrittenAt).toBeDefined();
    expect(fs.existsSync(path.join(workspace, "urbicana", "IDENTITY.md"))).toBe(true);
  });

  it("refuses a second owner, and the same owner's new token replaces the old", async () => {
    const store = memoryStore();
    const first = stubBoostt({ token: "tok-1" }).fetchImpl;
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store,
      workspaceDir: () => workspace,
      fetchImpl: first,
    });
    await service.connect("tok-1");

    const other: typeof fetch = async (input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(input).endsWith("/auth/me") && auth === "Bearer tok-other") {
        return Response.json({ success: true, user: { id: 7, email: "other@example.com" } });
      }
      return first(input, init);
    };
    const asOther = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store,
      workspaceDir: () => workspace,
      fetchImpl: other,
    });
    await expect(asOther.connect("tok-other")).rejects.toThrow(/acts for Boostt user 42/);
    expect(store.map.get(OWNER_KEY)?.userId).toBe(42);

    const renewed = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store,
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt({ token: "tok-2" }).fetchImpl,
    });
    await renewed.connect("tok-2");
    expect(store.map.get(OWNER_KEY)?.accessToken).toBe("tok-2");
  });

  it("disconnect forgets the owner and removes the card file", async () => {
    const store = memoryStore();
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store,
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt().fetchImpl,
    });
    await service.connect("tok-1");
    expect(await service.disconnect()).toEqual({
      connected: false,
      cardFile: "urbicana/IDENTITY.md",
    });
    expect(store.map.size).toBe(0);
    expect(fs.existsSync(path.join(workspace, "urbicana", "IDENTITY.md"))).toBe(false);
  });

  it("refuses to connect without a Boostt origin", async () => {
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: "", cardFile: "urbicana/IDENTITY.md" },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt().fetchImpl,
    });
    await expect(service.connect("tok-1")).rejects.toThrow(/railsUrl/);
  });
});

describe("routes", () => {
  type Sent = { status: number; body: unknown };
  function call(
    handler: ReturnType<typeof createUrbicanaRouteHandler>,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ handled: boolean; sent: Sent | null }> {
    const { Readable } = require("node:stream") as typeof import("node:stream");
    const req = Object.assign(
      Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      { method, url, headers: {} },
    );
    let sent: Sent | null = null;
    let status = 0;
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: (payload?: string) => {
        sent = { status, body: payload ? JSON.parse(payload) : null };
      },
    };
    return handler(req as never, res as never).then((handled) => ({ handled, sent }));
  }

  it("serves status, connect, refresh and disconnect under /plugins/urbicana, and leaves other paths alone", async () => {
    const service = createUrbicanaService({
      mutateConfig,
      settings: { railsUrl: RAILS, cardFile: "urbicana/IDENTITY.md" },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt().fetchImpl,
    });
    const handler = createUrbicanaRouteHandler(service);

    expect(await call(handler, "GET", "/plugins/urbicana/account")).toEqual({
      handled: true,
      sent: { status: 200, body: { connected: false, cardFile: "urbicana/IDENTITY.md" } },
    });
    expect((await call(handler, "POST", "/plugins/urbicana/account", {})).sent).toEqual({
      status: 422,
      body: { error: "access_token is required" },
    });
    const connected = await call(handler, "POST", "/plugins/urbicana/account", {
      access_token: "tok-1",
    });
    expect(connected.sent?.status).toBe(200);
    expect(connected.sent?.body).toMatchObject({ userId: 42 });
    expect(JSON.stringify(connected.sent)).not.toContain("tok-1");
    expect((await call(handler, "POST", "/plugins/urbicana/account/refresh")).sent?.status).toBe(
      200,
    );
    expect(
      (await call(handler, "POST", "/plugins/urbicana/account", { access_token: "tok-wrong" })).sent
        ?.status,
    ).toBe(409);
    expect((await call(handler, "DELETE", "/plugins/urbicana/account")).sent?.status).toBe(200);
    expect(await call(handler, "GET", "/plugins/urbicana/elsewhere")).toEqual({
      handled: false,
      sent: null,
    });
  });
});

describe("the marketplace, a config entry the extension owns", () => {
  const settings = { marketplaceMcpUrl: "http://host.docker.internal:4110/mcp" };

  it("is connected as the owner with the token as the Authorization header, and present but disabled without an owner", () => {
    expect(marketplaceServerEntry(settings, { accessToken: "tok-1" })).toEqual({
      transport: "streamable-http",
      url: "http://host.docker.internal:4110/mcp",
      enabled: true,
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(marketplaceServerEntry(settings, null)).toEqual({
      transport: "streamable-http",
      url: "http://host.docker.internal:4110/mcp",
      enabled: false,
    });
  });

  it("writes mcp.servers.boostt into the draft and keeps other servers", async () => {
    const draft = { mcp: { servers: { other: { url: "http://x" } } } };
    writeMarketplaceEntry(draft, marketplaceServerEntry(settings, null));
    expect(Object.keys(draft.mcp.servers)).toEqual(["other", "boostt"]);
    await applyMarketplace(mutateConfig, settings, { accessToken: "tok-9" });
    expect(
      (config as { mcp: { servers: { boostt: { headers: Record<string, string> } } } }).mcp.servers
        .boostt.headers,
    ).toEqual({ Authorization: "Bearer tok-9" });
  });

  it("follows the sign-in: connected on connect, disabled on disconnect, restored by reconcile", async () => {
    const store = memoryStore();
    const service = createUrbicanaService({
      mutateConfig,
      settings: {
        railsUrl: RAILS,
        cardFile: "urbicana/IDENTITY.md",
        marketplaceMcpUrl: settings.marketplaceMcpUrl,
      },
      store,
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt().fetchImpl,
    });
    const entry = () =>
      (
        config as {
          mcp?: { servers?: { boostt?: { enabled: boolean; headers?: Record<string, string> } } };
        }
      ).mcp?.servers?.boostt;

    await service.reconcile();
    expect(entry()).toEqual({
      transport: "streamable-http",
      url: settings.marketplaceMcpUrl,
      enabled: false,
    });

    await service.connect("tok-1");
    expect(entry()).toEqual({
      transport: "streamable-http",
      url: settings.marketplaceMcpUrl,
      enabled: true,
      headers: { Authorization: "Bearer tok-1" },
    });

    config = {};
    await service.reconcile();
    expect(entry()?.headers).toEqual({ Authorization: "Bearer tok-1" });

    await service.disconnect();
    expect(entry()).toEqual({
      transport: "streamable-http",
      url: settings.marketplaceMcpUrl,
      enabled: false,
    });
  });

  it("a config write that fails does not fail the sign-in", async () => {
    const failing: ConfigMutator = async () => {
      throw new Error("config locked");
    };
    const warn = vi.fn();
    const service = createUrbicanaService({
      mutateConfig: failing,
      settings: {
        railsUrl: RAILS,
        cardFile: "urbicana/IDENTITY.md",
        marketplaceMcpUrl: settings.marketplaceMcpUrl,
      },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl: stubBoostt().fetchImpl,
      log: { info: () => undefined, warn },
    });
    const status = await service.connect("tok-1");
    expect(status.connected).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("marketplace entry not written: config locked"),
    );
  });
});
