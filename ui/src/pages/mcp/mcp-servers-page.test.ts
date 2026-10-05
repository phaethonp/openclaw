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

  it("opens a server and shows the tools the probe returned", async () => {
    const { element, request } = await mount({ pathname: "/settings/mcp/servers/boostt" });

    expect(request).toHaveBeenCalledWith("mcp.probe", { server: "boostt" });
    const detail = element.querySelector('[data-mcp-name="boostt"]');
    expect(text(element.querySelector(".plugins-settings-breadcrumb"))).toContain("MCP Servers");
    expect(text(element.querySelector("h1"))).toBe("Boostt marketplace");
    expect(text(detail)).toContain("About");
    expect(text(detail?.querySelector(".plugin-catalog-detail__readme") ?? null)).toContain(
      "Jobs, proposals and messages, as the signed-in member.",
    );
    // The tools come first; the server's document follows them, as a plugin's README follows its panel.
    const headings = Array.from(detail?.querySelectorAll(".settings-section__heading") ?? []).map(
      (heading) => text(heading),
    );
    expect(headings.indexOf("Tools")).toBeLessThan(headings.indexOf("About"));
    expect(text(detail)).toContain("2 tools");
    expect(text(detail)).toContain("Notifications");
    expect(text(detail)).toContain("Unread notifications.");
    expect(text(detail)).toContain("search_members");
  });

  it("opens a tool in the tool dialog with its description and inputs; a bare name has nothing to open", async () => {
    const { element } = await mount({ pathname: "/settings/mcp/servers/boostt" });

    const rows = Array.from(element.querySelectorAll(".plugin-capability"));
    expect(rows.map((row) => text(row.querySelector("strong")))).toEqual([
      "Notifications",
      "search_members",
    ]);
    expect(rows[0]?.querySelector("button")).toBeInstanceOf(HTMLButtonElement);
    expect(rows[1]?.querySelector("button")).toBeNull();

    rows[0]?.querySelector("button")?.click();
    await element.updateComplete;
    await Promise.resolve();
    const dialog = document.querySelector(".plugin-tool-preview");
    expect(text(dialog?.querySelector("h2") ?? null)).toBe("get_notifications");
    expect(text(dialog)).toContain("Unread notifications.");
    expect(text(dialog?.querySelector(".plugin-tool-preview__parameters") ?? null)).toContain(
      "unread",
    );
    expect(text(dialog?.querySelector(".plugin-tool-preview__parameters") ?? null)).toContain(
      "Only unread ones.",
    );
  });

  it("shows the server's connection error in place", async () => {
    const { element } = await mount({ pathname: "/settings/mcp/servers/docs" });

    const detail = element.querySelector('[data-mcp-name="docs"]');
    expect(text(detail)).toContain("Unreachable");
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

  it("publishes the opened server to the Ask panel for an admin who can chat", async () => {
    const { element, context } = await mount({
      pathname: "/settings/mcp/servers/boostt",
      methods: ["mcp.probe", "openclaw.chat"],
      scopes: ["operator.admin"],
    });

    const ask = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Ask OpenClaw",
    );
    expect(ask).toBeInstanceOf(HTMLButtonElement);
    expect(currentPluginHelpReference(context)).toEqual({
      id: "boostt",
      name: "Boostt marketplace",
      installed: true,
      declared: { mcpServers: ["boostt"], tools: ["get_notifications", "search_members"] },
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

  it("returns to the list from the breadcrumb", async () => {
    const { element, navigate } = await mount({ pathname: "/settings/mcp/servers/boostt" });

    const back = element.querySelector(".plugins-settings-breadcrumb__parent");
    expect(back).toBeInstanceOf(HTMLAnchorElement);
    (back as HTMLAnchorElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(navigate).toHaveBeenCalledWith("mcp-servers", { pathname: "/settings/mcp/servers" });
  });
});
