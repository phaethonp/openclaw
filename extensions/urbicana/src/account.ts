/**
 * What the plugin keeps about the Gateway's owner, and how it reads it from
 * Boostt. The owner is the person who signed in through the Urbicana proxy;
 * the proxy hands this plugin that person's Boostt access token once per
 * sign-in (POST /plugins/urbicana/account), and the plugin asks Boostt whose
 * token it is before keeping anything.
 */

export type BoosttAccount = {
  /** Boostt `users.id`: the immutable identity of the owner. */
  userId: number;
  email: string;
  /** The owner's public handle (profile slug), when they have one. */
  handle: string | null;
  displayName: string | null;
  /** The owner's Boostt access token, used to read the owner's own card. */
  accessToken: string;
  connectedAt: string;
  /** When the card was last written into the workspace, and its version. */
  cardWrittenAt?: string;
  cardVersion?: string | null;
};

export type BoosttSettings = {
  railsUrl: string;
  cardFile: string;
  /** The Boostt marketplace MCP server, as the Gateway's host reaches it. */
  marketplaceMcpUrl: string;
};

export const DEFAULT_CARD_FILE = "urbicana/IDENTITY.md";
/** The same URL the manifest declares for the `boostt` MCP server. */
export const DEFAULT_MARKETPLACE_MCP_URL = "https://geo.boostt.org/marketplace/mcp";

const ME_PATH = "/api/v1/auth/me";
const CARD_PATH = "/api/v1/a2a/card";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;

export function resolveBoosttSettings(pluginConfig: unknown): BoosttSettings {
  const record =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string).trim() : "";
  const railsUrl = text("railsUrl").replace(/\/+$/u, "");
  const cardFile = text("cardFile") || DEFAULT_CARD_FILE;
  const marketplaceMcpUrl = text("marketplaceMcpUrl") || DEFAULT_MARKETPLACE_MCP_URL;
  return { railsUrl, cardFile, marketplaceMcpUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Boostt answered more than the plugin reads");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function boosttGet(
  railsUrl: string,
  path: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${railsUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Never attach the underlying error: it may carry the bearer.
    throw new Error(`Boostt did not answer ${path}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Boostt refused ${path} (${response.status})`);
  }
  return JSON.parse(await readBounded(response)) as unknown;
}

/** Asks Boostt whose token this is. */
export async function whoIs(
  settings: Pick<BoosttSettings, "railsUrl">,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<BoosttAccount, "accessToken" | "connectedAt">> {
  const payload = await boosttGet(settings.railsUrl, ME_PATH, accessToken, fetchImpl);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.user)) {
    throw new Error("Boostt's answer about the token had no user");
  }
  const user = payload.user;
  const userId = Number(user.id);
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!Number.isSafeInteger(userId) || userId <= 0 || !email) {
    throw new Error("Boostt's answer about the token had no usable user");
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    userId,
    email,
    // auth/me carries no handle; the card's interface url does (see handleOf).
    handle: null,
    displayName:
      text(user.name) ??
      ([text(user.first_name), text(user.last_name)].filter(Boolean).join(" ") || null),
  };
}

export type OwnerCard = { card: Record<string, unknown>; missing: string[] };

/** The owner's handle as Boostt fills it into the card's JSON-RPC interface url, `/a2a/agents/<handle>/jsonrpc`. */
export function handleOf(card: Record<string, unknown>): string | null {
  const interfaces = Array.isArray(card.supported_interfaces) ? card.supported_interfaces : [];
  for (const iface of interfaces) {
    const url = isRecord(iface) && typeof iface.url === "string" ? iface.url : "";
    const handle = /\/a2a\/agents\/([^/]+)\/jsonrpc$/u.exec(url)?.[1];
    if (handle) {
      return decodeURIComponent(handle);
    }
  }
  return null;
}

/** Reads the owner's own A2A card as Boostt holds it: the whole document, draft or not. */
export async function readOwnerCard(
  settings: Pick<BoosttSettings, "railsUrl">,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerCard> {
  const payload = await boosttGet(settings.railsUrl, CARD_PATH, accessToken, fetchImpl);
  if (!isRecord(payload) || !isRecord(payload.card)) {
    throw new Error("Boostt's answer had no card");
  }
  const missing = Array.isArray(payload.missing)
    ? payload.missing.filter((m): m is string => typeof m === "string")
    : [];
  return { card: payload.card, missing };
}
