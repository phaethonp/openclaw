import { definePage, type RouteLoaderOptions, type RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import {
  INTERNAL_MCP_SERVERS_PATH_PARAM,
  restoreBridgedRouteLocation,
  routePageSpec,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type McpServersRouteData = {
  location: RouteLocation;
};

export function mcpServersRouteLocation(location: RouteLocation): RouteLocation {
  return restoreBridgedRouteLocation(location, INTERNAL_MCP_SERVERS_PATH_PARAM);
}

export const page = definePage({
  ...routePageSpec("mcp-servers"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    mcpServersRouteLocation(location).pathname,
  loader: (_context: ApplicationContext, options: RouteLoaderOptions): McpServersRouteData => ({
    location: mcpServersRouteLocation(options.location),
  }),
  component: () =>
    import("./mcp-servers-page.ts").then(() => ({
      header: true,
      render: (data: McpServersRouteData | undefined) =>
        html`<openclaw-mcp-servers-page .routeData=${data}></openclaw-mcp-servers-page>`,
    })),
});
