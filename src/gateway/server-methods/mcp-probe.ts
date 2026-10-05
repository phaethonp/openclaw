import {
  ErrorCodes,
  errorShape,
  type McpProbeResult,
  type McpProbeServerResult,
  type McpProbeTool,
  validateMcpProbeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { summarizeToolParameters } from "./tools-catalog.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The configured servers to probe: one by name, or every enabled one. */
function selectServers(
  servers: Record<string, unknown>,
  name: string | undefined,
): Record<string, Record<string, unknown>> {
  const selected: Record<string, Record<string, unknown>> = {};
  for (const [serverName, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (!server) {
      continue;
    }
    if (name ? serverName !== name : server.enabled === false) {
      continue;
    }
    selected[serverName] = server;
  }
  return selected;
}

/** A connect that never comes back must not hold the request; the CLI's doctor bounds it the same way. */
function withInitializeTimeout(
  server: Record<string, unknown>,
  timeoutMs: number,
): Record<string, unknown> {
  return typeof server.connectionTimeoutMs === "number" && server.connectionTimeoutMs > 0
    ? server
    : { ...server, connectionTimeoutMs: timeoutMs };
}

export const mcpProbeHandlers: GatewayRequestHandlers = {
  "mcp.probe": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMcpProbeParams, "mcp.probe", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const configured = asRecord(asRecord(cfg.mcp)?.servers) ?? {};
    const name = params.server?.trim();
    if (name && !configured[name]) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `MCP server "${name}" is not configured`),
      );
      return;
    }
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    const selected = selectServers(configured, name);
    const probed: Record<string, Record<string, unknown>> = {};
    for (const [serverName, server] of Object.entries(selected)) {
      probed[serverName] = withInitializeTimeout({ ...server, enabled: true }, timeoutMs);
    }
    const runtime = createSessionMcpRuntime({
      sessionId: `openclaw-gateway-mcp-probe-${Date.now()}`,
      workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
      cfg: { ...cfg, mcp: { ...cfg.mcp, servers: probed } },
      manifestRegistry: { plugins: [] },
    });
    try {
      const catalog = await runtime.getCatalog();
      const servers: McpProbeServerResult[] = Object.keys(probed)
        .toSorted((a, b) => a.localeCompare(b))
        .map((serverName) => {
          const diagnostic = catalog.diagnostics?.find((entry) => entry.serverName === serverName);
          if (diagnostic || !catalog.servers[serverName]) {
            return {
              name: serverName,
              status: "error",
              toolCount: 0,
              tools: [],
              error: diagnostic?.message ?? "The probe did not connect to this server.",
            };
          }
          const tools: McpProbeTool[] = [];
          for (const tool of catalog.tools) {
            if (tool.serverName !== serverName) {
              continue;
            }
            const entry: McpProbeTool = { name: tool.toolName };
            if (tool.title) {
              entry.title = tool.title;
            }
            if (tool.description) {
              entry.description = tool.description;
            }
            const parameters = summarizeToolParameters(tool.inputSchema);
            if (parameters?.length) {
              entry.parameters = parameters;
            }
            tools.push(entry);
          }
          const server = catalog.servers[serverName];
          const result: McpProbeServerResult = {
            name: serverName,
            status: "ok",
            toolCount: tools.length,
            tools,
          };
          if (server.title) {
            result.title = server.title;
          }
          if (server.instructions) {
            result.description = server.instructions;
          }
          return result;
        });
      const result: McpProbeResult = {
        generatedAt: new Date(catalog.generatedAt).toISOString(),
        servers,
      };
      respond(true, result);
    } catch (error) {
      context.logGateway.warn(`mcp.probe failed: ${String(error)}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "The MCP probe failed."));
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  },
};
