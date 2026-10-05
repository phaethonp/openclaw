import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  createSessionMcpRuntime: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../../agents/agent-bundle-mcp-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-bundle-mcp-runtime.js")>(
    "../../agents/agent-bundle-mcp-runtime.js",
  );
  return { ...actual, createSessionMcpRuntime: mocks.createSessionMcpRuntime };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveDefaultAgentId: () => "main",
    resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
  };
});

import { mcpProbeHandlers } from "./mcp-probe.js";

const handler = expectDefined(
  mcpProbeHandlers["mcp.probe"],
  'mcpProbeHandlers["mcp.probe"] test invariant',
);

function catalog(partial: Partial<McpToolCatalog>): McpToolCatalog {
  return { version: 1, generatedAt: 1_791_200_000_000, servers: {}, tools: [], ...partial };
}

function runtimeWith(result: McpToolCatalog): SessionMcpRuntime {
  return {
    getCatalog: async () => result,
    peekCatalog: () => result,
    markUsed: () => undefined,
    callTool: async () => ({ content: [] }),
    dispose: mocks.dispose,
    resetStartupBackoff: () => undefined,
  } as unknown as SessionMcpRuntime;
}

function createOptions(params: Record<string, unknown>, cfg: OpenClawConfig) {
  const respond = vi.fn();
  const warn = vi.fn();
  return {
    options: {
      req: { type: "req", id: "probe-1", method: "mcp.probe", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { getRuntimeConfig: () => cfg, logGateway: { warn } } as never,
    } as GatewayRequestHandlerOptions,
    respond,
    warn,
  };
}

const cfg: OpenClawConfig = {
  mcp: {
    servers: {
      boostt: {
        transport: "streamable-http",
        url: "https://geo.example/marketplace/mcp",
        headers: { Authorization: "Bearer secret" },
      },
      paused: { transport: "streamable-http", url: "https://paused.example/mcp", enabled: false },
    },
  },
} as OpenClawConfig;

describe("mcp.probe", () => {
  beforeEach(() => {
    mocks.createSessionMcpRuntime.mockReset();
    mocks.dispose.mockReset().mockResolvedValue(undefined);
  });

  it("rejects invalid parameters before probing", async () => {
    const { options, respond } = createOptions({ server: "boostt", extra: true }, cfg);
    await handler(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.createSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("refuses a server that is not configured", async () => {
    const { options, respond } = createOptions({ server: "nope" }, cfg);
    await handler(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining('"nope"'),
      }),
    );
  });

  it("lists a server's tools, title and description as the server advertises them, and disposes the probe runtime", async () => {
    mocks.createSessionMcpRuntime.mockReturnValue(
      runtimeWith(
        catalog({
          servers: {
            boostt: {
              serverName: "boostt",
              launchSummary: "https://geo.example/marketplace/mcp",
              title: "Boostt marketplace",
              instructions: "Jobs, proposals and messages on Boostt, as the signed-in member.",
              toolCount: 2,
            },
          },
          tools: [
            {
              serverName: "boostt",
              safeServerName: "boostt",
              toolName: "get_notifications",
              title: "Your notifications",
              description: "Your Boostt notifications, newest first.",
              inputSchema: {} as never,
              fallbackDescription: "",
            },
            {
              serverName: "boostt",
              safeServerName: "boostt",
              toolName: "send_message",
              description: "Sends a message in a conversation.",
              inputSchema: {} as never,
              fallbackDescription: "",
            },
          ],
        }),
      ),
    );
    const { options, respond } = createOptions({ server: "boostt" }, cfg);
    await handler(options);

    const probeCfg = expectDefined(
      mocks.createSessionMcpRuntime.mock.calls[0],
      "probe call",
    )[0] as {
      cfg: OpenClawConfig;
      workspaceDir: string;
    };
    expect(probeCfg.workspaceDir).toBe("/tmp/workspace-main");
    // Only the named server is probed, with a bounded connect; the disabled one stays out.
    expect(Object.keys(probeCfg.cfg.mcp?.servers ?? {})).toEqual(["boostt"]);
    const probedBoostt = expectDefined(
      probeCfg.cfg.mcp?.servers?.boostt,
      "probed boostt",
    ) as Record<string, unknown>;
    expect(probedBoostt.connectionTimeoutMs).toBe(5_000);

    expect(respond).toHaveBeenCalledWith(true, {
      generatedAt: new Date(1_791_200_000_000).toISOString(),
      servers: [
        {
          name: "boostt",
          status: "ok",
          toolCount: 2,
          title: "Boostt marketplace",
          description: "Jobs, proposals and messages on Boostt, as the signed-in member.",
          tools: [
            {
              name: "get_notifications",
              title: "Your notifications",
              description: "Your Boostt notifications, newest first.",
            },
            { name: "send_message", description: "Sends a message in a conversation." },
          ],
        },
      ],
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(respond.mock.calls)).not.toContain("secret");
  });

  it("probes every enabled server when none is named, and reports one that did not connect", async () => {
    mocks.createSessionMcpRuntime.mockReturnValue(
      runtimeWith(
        catalog({
          servers: {},
          diagnostics: [
            {
              serverName: "boostt",
              safeServerName: "boostt",
              launchSummary: "https://geo.example/marketplace/mcp",
              message: "Connect Timeout Error",
            },
          ],
        }),
      ),
    );
    const { options, respond } = createOptions({}, cfg);
    await handler(options);
    const probeCfg = expectDefined(
      mocks.createSessionMcpRuntime.mock.calls[0],
      "probe call",
    )[0] as {
      cfg: OpenClawConfig;
    };
    expect(Object.keys(probeCfg.cfg.mcp?.servers ?? {})).toEqual(["boostt"]);
    expect(respond).toHaveBeenCalledWith(true, {
      generatedAt: expect.any(String),
      servers: [
        {
          name: "boostt",
          status: "error",
          toolCount: 0,
          tools: [],
          error: "Connect Timeout Error",
        },
      ],
    });
  });

  it("answers a failed probe without the failure's internals", async () => {
    mocks.createSessionMcpRuntime.mockReturnValue({
      ...runtimeWith(catalog({})),
      getCatalog: async () => {
        throw new Error("socket hang up at https://geo.example/marketplace/mcp?token=secret");
      },
    } as unknown as SessionMcpRuntime);
    const { options, respond, warn } = createOptions({ server: "boostt" }, cfg);
    await handler(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "The MCP probe failed." }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
