/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./boostt-account.ts";

const connected = {
  state: "connected",
  account: {
    userId: 14145,
    email: "member@example.com",
    displayName: "Linna Hunt",
    handle: "linna-hunt",
  },
  connectedAtMs: 1_700_000_000_000,
  pending: null,
} as const;
const disconnected = {
  state: "disconnected",
  account: null,
  connectedAtMs: null,
  pending: null,
} as const;

function mount(scopes: string[], profileId: string | null, request: ReturnType<typeof vi.fn>) {
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods([], scopes),
    selfUser: profileId ? { id: profileId } : null,
  } as ApplicationGatewaySnapshot;
  const context = {
    basePath: "/ui",
    navigate: vi.fn(),
    gateway: { snapshot, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("urbicana-boostt-account");
  provider.append(element);
  document.body.append(provider);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

it("reads the status for a signed-in profile and shows the connected account", async () => {
  const request = vi.fn(async () => connected);
  const element = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(request).toHaveBeenCalledWith("users.boostt.status", {}));
  await waitForFast(() => {
    expect(element.textContent).toContain("Linna Hunt");
    expect(element.textContent).toContain("member@example.com");
    expect(element.textContent).toContain("14145");
    expect(element.textContent).toContain("Disconnect");
  });
});

it("offers Connect when no account is connected", async () => {
  const request = vi.fn(async () => disconnected);
  const element = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("Connect Boostt account"));
});

it("asks for nothing without a profile on the connection", async () => {
  const request = vi.fn(async () => disconnected);
  const element = mount(["operator.read"], null, request);
  await waitForFast(() => expect(element.textContent).toContain("Connect from an authenticated"));
  expect(request).not.toHaveBeenCalled();
});
