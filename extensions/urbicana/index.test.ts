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
import { bundleSkillDir, skillPublication, treeSha256Of, type SkillChange } from "./src/skills.js";
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
  const bodies: unknown[] = [];
  const methods: string[] = [];
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
    if (url.startsWith(`${RAILS}/api/v1/registry_skills`)) {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      methods.push(init?.method ?? "GET");
      return Response.json({ skill: { skill_key: "deeds-digest" } }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, bodies, methods };
}

/** A committed skill tree on disk, as Skill Workshop leaves it. */
function committedSkill(dir: string, opts: { binary?: boolean } = {}) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".clawhub"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".clawhub", "origin.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: deeds-digest\ndescription: Summarise the deeds.\nversion: v1\n---\n# deeds-digest\n",
  );
  fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  if (opts.binary) {
    fs.writeFileSync(path.join(dir, "seal.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  }
  const after = {
    name: "deeds-digest",
    skillKey: "deeds-digest",
    description: "Summarise the deeds.",
    skillFile: path.join(dir, "SKILL.md"),
    skillDir: dir,
    source: "workshop",
    revision: {
      declaredVersion: "v1",
      contentSha256: "sha256:" + "b".repeat(64),
      treeSha256: "sha256:" + "a".repeat(64),
    },
  };
  return after;
}

let workspace: string;
/** An in-memory agent config; the mutator applies the extension's writes to it. */
let config: Record<string, unknown>;
let writes = 0;
const mutateConfig: ConfigMutator = {
  current: () => config as ReturnType<ConfigMutator["current"]>,
  mutate: async (mutate) => {
    writes += 1;
    mutate(config as Parameters<typeof mutate>[0]);
  },
};
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "urbicana-ws-"));
  config = {};
  writes = 0;
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
    expect(text.startsWith("# Agent Card\n")).toBe(true);
    expect(text).not.toContain("acts for");
    const json = /```json\n([\s\S]*?)\n```/u.exec(text)?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(CARD);
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

    // A restore that finds the entry already right writes nothing: a write reloads the Gateway.
    const before = writes;
    await service.reconcile();
    await service.reconcile();
    expect(writes).toBe(before);
  });

  it("a config write that fails does not fail the sign-in", async () => {
    const failing: ConfigMutator = {
      current: () => ({}),
      mutate: async () => {
        throw new Error("config locked");
      },
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

describe("a skill authored here goes to Boostt", () => {
  it("bundles the committed tree with the Gateway's rules", () => {
    const dir = path.join(workspace, "workshop-skills", "deeds-digest");
    committedSkill(dir, { binary: true });
    const files = bundleSkillDir(dir);
    expect(files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh", "seal.bin"]);
    expect(files.find((f) => f.path === "scripts/run.sh")?.executable).toBe(true);
    expect(files.find((f) => f.path === "SKILL.md")?.executable).toBe(false);
    const bin = files.find((f) => f.path === "seal.bin");
    expect(bin?.encoding).toBe("base64");
    expect(Buffer.from(bin?.content ?? "", "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    expect(treeSha256Of(files)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a tree without SKILL.md and a symlink inside it", () => {
    const empty = path.join(workspace, "empty");
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, "README.md"), "x");
    expect(() => bundleSkillDir(empty)).toThrow(/no SKILL.md/);
    const linked = path.join(workspace, "linked");
    committedSkill(linked);
    fs.symlinkSync("/etc/hosts", path.join(linked, "hosts"));
    expect(() => bundleSkillDir(linked)).toThrow(/unsupported entry/);
  });

  it("posts the publication as the owner, hashes bare", async () => {
    const dir = path.join(workspace, "workshop-skills", "deeds-digest");
    const after = committedSkill(dir);
    const { fetchImpl, bodies, methods, calls } = stubBoostt();
    const store = memoryStore();
    const service = createUrbicanaService({
      settings: {
        railsUrl: RAILS,
        cardFile: "urbicana/IDENTITY.md",
        marketplaceMcpUrl: "https://geo.boostt.org/marketplace/mcp",
      },
      store,
      workspaceDir: () => workspace,
      fetchImpl,
      mutateConfig,
    });
    await service.connect("tok-1");
    const change: SkillChange = { action: "created", source: "workshop", after };
    await service.skillChanged(change);
    expect(methods.at(-1)).toBe("POST");
    expect(calls.at(-1)).toBe(`${RAILS}/api/v1/registry_skills Bearer tok-1`);
    const body = bodies.at(-1) as { skill: ReturnType<typeof skillPublication> };
    expect(body.skill.skill_key).toBe("deeds-digest");
    expect(body.skill.action).toBe("created");
    expect(body.skill.revision).toEqual({
      tree_sha256: "a".repeat(64),
      content_sha256: "b".repeat(64),
      declared_version: "v1",
    });
    expect(body.skill.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]);

    await service.skillChanged({ action: "removed", source: "workshop", before: after });
    expect(methods.at(-1)).toBe("DELETE");
    expect(calls.at(-1)).toBe(`${RAILS}/api/v1/registry_skills/deeds-digest Bearer tok-1`);
  });

  it("sends nothing without an owner, and a refusal does not throw", async () => {
    const dir = path.join(workspace, "workshop-skills", "deeds-digest");
    const after = committedSkill(dir);
    const { fetchImpl, methods } = stubBoostt();
    const warnings: string[] = [];
    const service = createUrbicanaService({
      settings: {
        railsUrl: RAILS,
        cardFile: "urbicana/IDENTITY.md",
        marketplaceMcpUrl: "https://geo.boostt.org/marketplace/mcp",
      },
      store: memoryStore(),
      workspaceDir: () => workspace,
      fetchImpl,
      mutateConfig,
      log: { info: () => undefined, warn: (m) => warnings.push(m) },
    });
    await service.skillChanged({ action: "created", source: "workshop", after });
    expect(methods).toEqual([]);

    const refusing: typeof fetch = async () => new Response("no", { status: 422 });
    const refused = createUrbicanaService({
      settings: {
        railsUrl: RAILS,
        cardFile: "urbicana/IDENTITY.md",
        marketplaceMcpUrl: "https://geo.boostt.org/marketplace/mcp",
      },
      store: {
        ...memoryStore(),
        lookup: async () => ({
          userId: 42,
          email: "p@x",
          handle: null,
          displayName: null,
          accessToken: "tok-1",
          connectedAt: "now",
        }),
      },
      workspaceDir: () => workspace,
      fetchImpl: refusing,
      mutateConfig,
      log: { info: () => undefined, warn: (m) => warnings.push(m) },
    });
    await expect(
      refused.skillChanged({ action: "created", source: "workshop", after }),
    ).resolves.toBeUndefined();
    expect(warnings.at(-1)).toMatch(/refused POST \/api\/v1\/registry_skills \(422\)/);
  });
});
