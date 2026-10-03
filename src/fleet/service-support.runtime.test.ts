import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./registry.js", () => ({ withFleetCellOperationLease: acquire }));

import { prepareCellConfig, withFleetCellOperation } from "./service-support.runtime.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fleet operation lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([{ allowedOrigins: undefined }, { allowedOrigins: [] }])(
    "preserves public-origin inheritance only for omitted origins (%j)",
    async ({ allowedOrigins }) => {
      const dataDir = tempDirs.make("fleet-origin-");
      const configPath = path.join(dataDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            publicOrigin: "https://team.example.com",
            controlUi: { allowedOrigins },
          },
        }),
      );
      await prepareCellConfig({
        tenantId: "team",
        createdAtMs: 1,
        image: "openclaw:test",
        runtime: "docker",
        hostPort: 19100,
        containerName: "openclaw-cell-team",
        dataDir,
      });
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(config.gateway.publicOrigin).toBe("https://team.example.com");
      expect(config.gateway.controlUi.allowedOrigins).toEqual(
        allowedOrigins === undefined
          ? undefined
          : ["http://localhost:19100", "http://127.0.0.1:19100"],
      );
      expect(config.gateway.auth).toEqual({ mode: "token" });
    },
  );

  it("adds the marketplace MCP server when the cell config has none", async () => {
    const dataDir = tempDirs.make("fleet-mcp-");
    await prepareCellConfig({
      tenantId: "team",
      createdAtMs: 1,
      image: "openclaw:test",
      runtime: "docker",
      hostPort: 19100,
      containerName: "openclaw-cell-team",
      dataDir,
    });
    const config = JSON.parse(await fs.readFile(path.join(dataDir, "openclaw.json"), "utf8"));
    expect(config.mcp.servers.marketplace).toEqual({
      url: "https://geo.boostt.org/marketplace/mcp",
      transport: "streamable-http",
      auth: "oauth",
    });
  });

  it("keeps a marketplace MCP server the cell config already has", async () => {
    const dataDir = tempDirs.make("fleet-mcp-keep-");
    const configPath = path.join(dataDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          servers: {
            marketplace: { url: "http://127.0.0.1:4110/mcp", transport: "streamable-http" },
            other: { url: "https://example.com/mcp", transport: "sse" },
          },
        },
      }),
    );
    await prepareCellConfig({
      tenantId: "team",
      createdAtMs: 1,
      image: "openclaw:test",
      runtime: "docker",
      hostPort: 19100,
      containerName: "openclaw-cell-team",
      dataDir,
    });
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.mcp.servers.marketplace).toEqual({
      url: "http://127.0.0.1:4110/mcp",
      transport: "streamable-http",
    });
    expect(config.mcp.servers.other.url).toBe("https://example.com/mcp");
  });

  it("awaits acquisition, checkpoints, timer renewal, and release before reporting success", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    acquire.mockImplementation(async (_params, operation) => {
      await Promise.resolve();
      events.push("acquired");
      const lease = {
        owner: "fixture-owner",
        heartbeat: async () => {
          await Promise.resolve();
          events.push("renewed");
        },
        release: async () => {
          await Promise.resolve();
          events.push("released");
        },
      };
      try {
        return await operation(lease);
      } finally {
        await lease.release();
      }
    });

    const result = await withFleetCellOperation({
      env: {},
      tenantId: "fixture",
      operationName: "start",
      operation: async (checkpoint) => {
        await checkpoint();
        events.push("effect");
        await vi.advanceTimersByTimeAsync(60_000);
        events.push("completed");
        return "started";
      },
    });

    expect(result).toBe("started");
    expect(events).toEqual([
      "acquired",
      "renewed",
      "effect",
      "renewed",
      "completed",
      "renewed",
      "released",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
