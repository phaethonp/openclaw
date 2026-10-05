// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { ToolCatalogEntrySchema } from "./tools-catalog.js";

/** Probe one configured MCP server, or every enabled one, for the tools it advertises. */
export const McpProbeParamsSchema = closedObject({
  server: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** One tool as the server lists it: its name, what the server says it does, and its inputs in the tools catalog's shape. */
export const McpProbeToolSchema = closedObject({
  name: NonEmptyString,
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  parameters: ToolCatalogEntrySchema.properties.parameters,
});

/** Secret-free outcome for one server: how it names and describes itself, its tools, or why it could not be reached. */
export const McpProbeServerResultSchema = closedObject({
  name: NonEmptyString,
  status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  toolCount: Type.Integer({ minimum: 0 }),
  tools: Type.Array(McpProbeToolSchema),
  error: Type.Optional(Type.String()),
});

export const McpProbeResultSchema = closedObject({
  generatedAt: NonEmptyString,
  servers: Type.Array(McpProbeServerResultSchema),
});

export type McpProbeParams = Static<typeof McpProbeParamsSchema>;
export type McpProbeTool = Static<typeof McpProbeToolSchema>;
export type McpProbeServerResult = Static<typeof McpProbeServerResultSchema>;
export type McpProbeResult = Static<typeof McpProbeResultSchema>;
