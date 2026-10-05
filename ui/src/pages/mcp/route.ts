import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("mcp-servers"),
  component: () =>
    import("./mcp-servers-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-mcp-servers-page></openclaw-mcp-servers-page>`,
    })),
});
