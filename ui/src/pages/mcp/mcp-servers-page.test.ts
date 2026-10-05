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
import { currentPluginHelpReference } from "../custodian/plugin-help.ts";
import "./mcp-servers-page.ts";

const probed: McpProbeResult = {
  generatedAt: "2026-10-06T00:00:00.000Z",
  servers: [
    {
      name: "boostt",
      status: "ok",
      title: "Boostt marketplace",
      description: "# Boostt\n\nJobs, proposals and messages, as the signed-in member.",
      toolCount: 2,
      tools: [
        {
          name: "get_notifications",
          title: "Notifications",
          description: "Unread notifications.",
          parameters: [
            { name: "unread", required: true, type: "boolean", description: "Only unread ones." },
          ],
        },
        { name: "search_members" },
      ],
    },
  ],
};

const unreachable: McpProbeResult = {
  generatedAt: "2026-10-06T00:00:00.000Z",
  servers: [
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

type TestPage = OpenClawLightDomElement & {
  routeData?: { location: { pathname: string; search: string; hash: string } };
};

async function mount(
  options: {
    methods?: string[];
    scopes?: string[];
    pathname?: string;
    result?: Promise<McpProbeResult>;
  } = {},
) {
  const request = createGatewayRequestMock((method, params) => {
    if (method !== "mcp.probe") {
      return Promise.resolve({});
    }
    if (options.result) {
      return options.result;
    }
    const server = (params as { server?: string }).server;
    return Promise.resolve(server === "docs" ? unreachable : probed);
  });
  const client = createTestGatewayClient(request);
  const snapshot = {
    phase: "connected",
    client,
    hello: gatewayHelloForMethods(
      options.methods ?? ["mcp.probe"],
      options.scopes ?? ["operator.read"],
    ),
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
  const navigate = vi.fn();
  const pathname = options.pathname ?? "/settings/mcp/servers";
  const context = {
    basePath: "",
    gateway: gateway.gateway,
    runtimeConfig: runtime,
    router: { getState: () => ({ location: { pathname } }), subscribe: () => () => {} },
    navigate,
  } as unknown as ApplicationContext;
  const host = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-mcp-servers-page") as TestPage;
  element.routeData = { location: { pathname, search: "", hash: "" } };
  host.append(element);
  document.body.append(host);
  await settle(element);
  return { element, request, navigate, context };
}

async function settle(element: OpenClawLightDomElement) {
  await element.updateComplete;
  await Promise.resolve();
  await Promise.resolve();
  await element.updateComplete;
}

function text(node: Element | null): string {
  return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("openclaw-mcp-servers-page", () => {
  it("lists every configured server by name without probing any", async () => {
    const { element, request, navigate } = await mount();

    expect(request).not.toHaveBeenCalledWith("mcp.probe", expect.anything());
    const rows = Array.from(element.querySelectorAll(".settings-row--nav"));
    expect(rows.map((row) => text(row.querySelector("[data-mcp-name]")))).toEqual([
      "boostt",
      "docs",
      "local",
    ]);
    expect(text(rows[0] ?? null)).toContain(
      "https://marketplace.example.com/mcp · streamable-http",
    );
    expect(text(rows[2] ?? null)).toContain("Disabled");

    (rows[0] as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith("mcp-servers", {
      pathname: "/settings/mcp/servers/boostt",
    });
  });

  it("opens a server on the detail shell: title, tools, and its document after them", async () => {
    const { element, request, navigate } = await mount({
      pathname: "/settings/mcp/servers/boostt",
    });

    expect(request).toHaveBeenCalledWith("mcp.probe", { server: "boostt" });
    const detail = element.querySelector('[data-mcp-name="boostt"] .plugin-catalog-detail');
    expect(detail).not.toBeNull();
    expect(text(detail?.querySelector(".plugins-settings-breadcrumb") ?? null)).toContain(
      "MCP Servers",
    );
    expect(text(detail?.querySelector("h1") ?? null)).toBe("Boostt marketplace");
    expect(text(detail?.querySelector(".plugin-catalog-detail__publisher") ?? null)).toContain(
      "https://marketplace.example.com/mcp · streamable-http",
    );

    const rows = Array.from(detail?.querySelectorAll(".plugin-capability") ?? []);
    expect(rows.map((row) => text(row.querySelector("strong")))).toEqual([
      "Notifications",
      "search_members",
    ]);
    expect(text(detail?.querySelector(".plugin-catalog-detail__readme") ?? null)).toContain(
      "Jobs, proposals and messages, as the signed-in member.",
    );
    expect(
      detail
        ?.querySelector(".plugin-catalog-detail__panel")
        ?.compareDocumentPosition(
          detail.querySelector(".plugin-catalog-detail__readme-section") as Node,
        ) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    rows[1]?.querySelector("button")?.click();
    expect(navigate).toHaveBeenCalledWith("mcp-servers", {
      pathname: "/settings/mcp/servers/boostt/search_members",
    });
  });

  it("opens a tool on the detail shell: title, its id and server, inputs, and the full description", async () => {
    const { element, request, navigate } = await mount({
      pathname: "/settings/mcp/servers/boostt/get_notifications",
    });

    expect(request).toHaveBeenCalledWith("mcp.probe", { server: "boostt" });
    const detail = element.querySelector(
      '[data-mcp-tool="get_notifications"] .plugin-catalog-detail',
    );
    expect(detail).not.toBeNull();
    expect(text(detail?.querySelector("h1") ?? null)).toBe("Notifications");
    expect(text(detail?.querySelector(".plugin-catalog-detail__publisher") ?? null)).toContain(
      "get_notifications",
    );
    expect(text(detail?.querySelector(".plugin-catalog-detail__publisher") ?? null)).toContain(
      "Boostt marketplace",
    );
    const inputs = text(detail?.querySelector(".plugin-catalog-detail__panel") ?? null);
    expect(inputs).toContain("Inputs");
    expect(inputs).toContain("unread");
    expect(inputs).toContain("Required · boolean · Only unread ones.");
    expect(text(detail?.querySelector(".plugin-catalog-detail__readme") ?? null)).toContain(
      "Unread notifications.",
    );

    const back = detail?.querySelector(".plugins-settings-breadcrumb__parent");
    expect(text(back ?? null)).toBe("Boostt marketplace");
    back?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(navigate).toHaveBeenCalledWith("mcp-servers", {
      pathname: "/settings/mcp/servers/boostt",
    });
  });

  it("says when the server lists no tool by that name, and when a tool takes no inputs", async () => {
    const missing = await mount({ pathname: "/settings/mcp/servers/boostt/ghost" });
    expect(text(missing.element)).toContain("This server lists no tool named “ghost”.");
    document.body.replaceChildren();

    const bare = await mount({ pathname: "/settings/mcp/servers/boostt/search_members" });
    expect(text(bare.element.querySelector("h1"))).toBe("search_members");
    expect(text(bare.element)).toContain("This tool takes no inputs.");
    expect(bare.element.querySelector(".plugin-catalog-detail__readme")).toBeNull();
  });

  it("shows the server's connection error in place", async () => {
    const { element } = await mount({ pathname: "/settings/mcp/servers/docs" });

    const detail = element.querySelector('[data-mcp-name="docs"]');
    expect(text(detail)).toContain("connect ECONNREFUSED");
  });

  it("does not probe a disabled server", async () => {
    const { element, request } = await mount({ pathname: "/settings/mcp/servers/local" });

    expect(request).not.toHaveBeenCalledWith("mcp.probe", expect.anything());
    expect(text(element.querySelector('[data-mcp-name="local"]'))).toContain(
      "Disabled servers are not read.",
    );
  });

  it("says when the name is not a configured server", async () => {
    const { element, request } = await mount({ pathname: "/settings/mcp/servers/ghost" });

    expect(request).not.toHaveBeenCalledWith("mcp.probe", expect.anything());
    expect(text(element)).toContain("MCP server “ghost” was not found in the configuration.");
  });

  it("does not probe a gateway that lacks the method and says so", async () => {
    const { element, request } = await mount({
      pathname: "/settings/mcp/servers/boostt",
      methods: ["mcp.authLogin"],
    });

    expect(request).not.toHaveBeenCalledWith("mcp.probe", expect.anything());
    expect(text(element)).toContain("This gateway does not list server tools.");
  });

  it("shows the probe failure with a retry", async () => {
    const { element } = await mount({
      pathname: "/settings/mcp/servers/boostt",
      result: Promise.reject(new Error("probe exploded")),
    });

    const alert = element.querySelector('[role="alert"]');
    expect(text(alert)).toContain("probe exploded");
    expect(alert?.querySelector("button")?.textContent?.trim()).toBe("Retry");
  });

  it("publishes the opened server, then the opened tool, to the Ask panel for an admin who can chat", async () => {
    const admin = { methods: ["mcp.probe", "openclaw.chat"], scopes: ["operator.admin"] };
    const server = await mount({ pathname: "/settings/mcp/servers/boostt", ...admin });
    expect(
      Array.from(server.element.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Ask OpenClaw",
      ),
    ).toBe(true);
    expect(currentPluginHelpReference(server.context)).toEqual({
      id: "boostt",
      name: "Boostt marketplace",
      installed: true,
      declared: { mcpServers: ["boostt"], tools: ["get_notifications", "search_members"] },
    });
    document.body.replaceChildren();

    const tool = await mount({
      pathname: "/settings/mcp/servers/boostt/get_notifications",
      ...admin,
    });
    expect(
      Array.from(tool.element.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Ask OpenClaw",
      ),
    ).toBe(true);
    expect(currentPluginHelpReference(tool.context)).toEqual({
      id: "boostt/get_notifications",
      name: "Notifications",
      installed: true,
      declared: { mcpServers: ["boostt"], tools: ["get_notifications"] },
    });
  });

  it("offers no Ask action to a reader, and none on the list", async () => {
    const reader = await mount({ pathname: "/settings/mcp/servers/boostt" });
    expect(
      Array.from(reader.element.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Ask OpenClaw",
      ),
    ).toBe(false);
    expect(currentPluginHelpReference(reader.context)).toBeUndefined();
    document.body.replaceChildren();

    const list = await mount({
      methods: ["mcp.probe", "openclaw.chat"],
      scopes: ["operator.admin"],
    });
    expect(currentPluginHelpReference(list.context)).toBeUndefined();
  });

  it("returns to the list from the server's breadcrumb", async () => {
    const { element, navigate } = await mount({ pathname: "/settings/mcp/servers/boostt" });

    const back = element.querySelector(".plugins-settings-breadcrumb__parent");
    expect(back).toBeInstanceOf(HTMLAnchorElement);
    (back as HTMLAnchorElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(navigate).toHaveBeenCalledWith("mcp-servers", { pathname: "/settings/mcp/servers" });
  });
});
