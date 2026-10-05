/**
 * The Boostt marketplace, reached by the agent as its owner.
 *
 * The manifest declares the `boostt` MCP server statically (name, URL). Its
 * connection is bound per requester: when the person asking is the owner,
 * the transport carries the owner's Boostt token, which the marketplace MCP
 * accepts as a bearer (it asks Boostt whose token it is). Any other requester,
 * a peer's task on the A2A channel for one, gets no marketplace at all: the
 * resolver answers null and the Gateway omits the server for that run. The
 * Gateway never logs or persists the headers it is given here.
 */
import type { BoosttSettings } from "./account.js";
import type { OwnerStore } from "./service.js";
import { OWNER_KEY } from "./service.js";

export const MARKETPLACE_SERVER_NAME = "boostt";

export type ResolveContext = {
  requesterSenderId: string;
  agentAccountId?: string;
  messageChannel?: string;
};
export type ResolvedConnection = { url: string; headers?: Record<string, string> };

export function createMarketplaceConnectionResolver(opts: {
  settings: Pick<BoosttSettings, "marketplaceMcpUrl">;
  store: Pick<OwnerStore, "lookup">;
}) {
  return {
    serverName: MARKETPLACE_SERVER_NAME,
    async resolve(ctx: ResolveContext): Promise<ResolvedConnection | null> {
      const owner = await opts.store.lookup(OWNER_KEY);
      if (!owner) {
        return null;
      }
      // The Control UI names the requester by the proxy's user header, the owner's email.
      if (ctx.requesterSenderId.trim().toLowerCase() !== owner.email) {
        return null;
      }
      return {
        url: opts.settings.marketplaceMcpUrl,
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      };
    },
  };
}
