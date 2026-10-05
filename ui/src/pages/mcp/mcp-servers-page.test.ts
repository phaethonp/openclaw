/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpProbeResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import type { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./mcp-servers-page.ts";

const probed: McpProbeResult = {
  generatedAt: "2026-10-06T00:00:00.000Z",
  servers: [
    {
      name: "boostt",
      status: "ok",
      toolCount: 2,
      tools: [
        { name: "get_notifications", title: "Notifications", description: "Unread notifications." },
        { name: "search_members" },
      ],
    },
    { name: "docs", status: "error", toolCount: 0, tools: [], error: "connect ECONNREFUSED" },
  ],
};

const config = {
  mcp: {
    servers: {
      boostt: { url: "https://marketplace.example.com/mcp", transport: "streamable-http" },
      docs: { url: "https://docs.example.com/mcp" },
      local: { command: "node", enabled: false },
    },
  },
};

async function mount(options: { methods?: string[]; result?: Promise<McpProbeResult> } = {}) {
  const request = createGatewayRequestMock((method) =>
    method === "mcp.probe" ? (options.result ?? Promise.resolve(probed)) : Promise.resolve({}),
  );
  const client = createTestGatewayClient(request);
  const snapshot = {
    phase: "connected",
    client,
    hello: gatewayHelloForMethods(options.methods ?? ["mcp.probe"], ["operator.read"]),
  } as ApplicationGatewaySnapshot;
  const gateway = createApplicationGateway(snapshot);
  const configState = {
    ...createInitialConfigState(snapshot),
    configForm: config,
    configSnapshot: { config, hash: "one", valid: true, issues: [] },
  };
  const runtime = {
    state: configState,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    subscribe: () => () => {},
  };
  const context = {
    basePath: "",
    gateway: gateway.gateway,
    runtimeConfig: runtime,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const host = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-mcp-servers-page") as OpenClawLightDomElement;
  host.append(element);
  document.body.append(host);
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
  return { element, request };
}

function text(node: Element | null): string {
  return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("openclaw-mcp-servers-page", () => {
  it("lists every configured server with the tools the probe returned", async () => {
    const { element, request } = await mount();

    expect(request).toHaveBeenCalledWith("mcp.probe", {});
    const boostt = element.querySelector('[data-mcp-name="boostt"]');
    expect(text(boostt)).toContain("2 tools");
    expect(text(boostt)).toContain("Notifications");
    expect(text(boostt)).toContain("Unread notifications.");
    expect(text(boostt)).toContain("search_members");

    const docs = element.querySelector('[data-mcp-name="docs"]');
    expect(text(docs)).toContain("Unreachable");
    expect(text(docs)).toContain("connect ECONNREFUSED");

    const local = element.querySelector('[data-mcp-name="local"]');
    expect(text(local)).toContain("Disabled servers are not read.");
  });

  it("does not probe a gateway that lacks the method and says so", async () => {
    const { element, request } = await mount({ methods: ["mcp.authLogin"] });

    expect(request).not.toHaveBeenCalledWith("mcp.probe", expect.anything());
    expect(text(element)).toContain("This gateway does not list server tools.");
    expect(element.querySelectorAll("[data-mcp-name]")).toHaveLength(3);
  });

  it("shows the probe failure with a retry", async () => {
    const { element } = await mount({ result: Promise.reject(new Error("probe exploded")) });

    const alert = element.querySelector('[role="alert"]');
    expect(text(alert)).toContain("probe exploded");
    expect(alert?.querySelector("button")?.textContent?.trim()).toBe("Retry");
  });
});
