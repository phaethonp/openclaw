/**
 * The Boostt marketplace, reached by the agent as its owner.
 *
 * The owner's chat in the Control UI is the operator's own and carries no
 * requester id, so a per-requester binding never fires there. The marketplace
 * is therefore a static MCP server in the agent's config, `mcp.servers.boostt`,
 * whose Authorization header is the owner's Boostt token: a sensitive field the
 * Gateway masks in its UI and hot-reloads without a restart. The extension
 * writes that entry at each sign-in and disables it when the owner leaves.
 * The marketplace accepts a Boostt account token as a bearer and asks Boostt
 * whose it is. Peers on the A2A channel are kept away from these tools by the
 * tool policy the helper writes (`tools.toolsBySender`, `channel:a2a:<peer>`).
 */
import type { BoosttAccount, BoosttSettings } from "./account.js";

export const MARKETPLACE_SERVER_NAME = "boostt";

export type MarketplaceServerEntry = {
  transport: "streamable-http";
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
};

/** The config entry for the marketplace: connected as the owner, or present but disabled. */
export function marketplaceServerEntry(
  settings: Pick<BoosttSettings, "marketplaceMcpUrl">,
  owner: Pick<BoosttAccount, "accessToken"> | null,
): MarketplaceServerEntry {
  return owner
    ? {
        transport: "streamable-http",
        url: settings.marketplaceMcpUrl,
        enabled: true,
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      }
    : { transport: "streamable-http", url: settings.marketplaceMcpUrl, enabled: false };
}

type ConfigDraft = {
  mcp?: { servers?: Record<string, unknown> } & Record<string, unknown>;
} & Record<string, unknown>;

/** Writes the entry into a config draft; the caller persists through the runtime's config mutation. */
export function writeMarketplaceEntry(draft: ConfigDraft, entry: MarketplaceServerEntry): void {
  const mcp = (draft.mcp ??= {});
  const servers = (mcp.servers ??= {});
  servers[MARKETPLACE_SERVER_NAME] = entry;
}

export type ConfigMutator = (mutate: (draft: ConfigDraft) => void) => Promise<void>;

/** The runtime's config mutation, narrowed to what this extension uses. */
export function createConfigMutator(runtimeConfig: {
  mutateConfigFile: (params: {
    base: "runtime";
    afterWrite: { mode: "auto" };
    mutate: (draft: ConfigDraft) => void;
  }) => Promise<unknown>;
}): ConfigMutator {
  return async (mutate) => {
    await runtimeConfig.mutateConfigFile({ base: "runtime", afterWrite: { mode: "auto" }, mutate });
  };
}

/** Applies the owner's marketplace entry to the agent's config. */
export async function applyMarketplace(
  mutateConfig: ConfigMutator,
  settings: Pick<BoosttSettings, "marketplaceMcpUrl">,
  owner: Pick<BoosttAccount, "accessToken"> | null,
): Promise<void> {
  const entry = marketplaceServerEntry(settings, owner);
  await mutateConfig((draft) => writeMarketplaceEntry(draft, entry));
}
