import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  McpProbeResult,
  McpProbeServerResult,
  McpProbeTool,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  mcpServerRouteFromPath,
  pathForMcpServer,
  pathForMcpServerTool,
  pathForRoute,
} from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { summarizeMcpServers, type McpServerSummary } from "../../lib/config/mcp-servers.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderPluginReadme } from "../plugins/catalog-detail.ts";
import { renderPluginDetailShell } from "../plugins/detail-shell.ts";
import { renderPluginAskAction, renderPluginCapabilitySection } from "../plugins/overview.ts";
import type { McpServersRouteData } from "./route.ts";
import { McpServerHelpController } from "./server-help-controller.ts";
import "../../styles/plugins.css";

registerMcpEnglish();

/**
 * Settings › MCP › Servers. The list names every configured server from the
 * config. A server opens at /settings/mcp/servers/<name> and a tool at
 * /settings/mcp/servers/<name>/<tool>, both on the plugin detail shell; the
 * opened server's tools are read live through mcp.probe, once per server.
 */
class McpServersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: McpServersRouteData;

  @state() private probe: McpProbeServerResult | null = null;
  @state() private error = "";
  @state() private loading = false;
  private generation = 0;
  private probedName: string | null = null;
  private readonly help = new McpServerHelpController(this);

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.invalidate(),
    ensureInitialData: () => {
      void this.load();
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).watchStore(
    () => this.context?.runtimeConfig,
  );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData") && this.selected?.server !== this.probedName) {
      this.invalidate();
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.invalidate();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private get selected(): { server: string; tool: string | null } | null {
    const pathname = this.routeData?.location.pathname;
    return pathname ? mcpServerRouteFromPath(pathname, this.context?.basePath ?? "") : null;
  }

  private invalidate() {
    this.generation++;
    this.probe = null;
    this.probedName = null;
    this.error = "";
    this.loading = false;
  }

  private get canProbe(): boolean {
    return canCallGatewayMethod(this.context?.gateway.snapshot, "mcp.probe", "operator.read");
  }

  private configuredServer(name: string): McpServerSummary | undefined {
    const servers = summarizeMcpServers(currentConfigObject(this.context.runtimeConfig.state));
    return servers?.find((server) => server.name === name);
  }

  /** Only a configured, enabled server is probed; the others render from the config alone. */
  private async load() {
    const name = this.selected?.server;
    const scope = this.gateway.capture();
    if (!name || !scope || !this.canProbe || !this.configuredServer(name)?.enabled) {
      return;
    }
    const generation = ++this.generation;
    const current = () =>
      this.isConnected && generation === this.generation && this.gateway.isCurrent(scope);
    this.probedName = name;
    this.loading = true;
    this.error = "";
    void this.context.runtimeConfig.ensureLoaded().catch(() => undefined);
    try {
      const result = await scope.client.request<McpProbeResult>("mcp.probe", { server: name });
      if (current()) {
        this.probe = result.servers.find((server) => server.name === name) ?? null;
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.loading = false;
      }
    }
  }

  private navigateTo(pathname: string) {
    this.context.navigate("mcp-servers", { pathname });
  }

  private serverTarget(server: McpServerSummary): string {
    return [server.target || t("mcpServers.missingTransport"), server.transport].join(" · ");
  }

  private renderList(servers: McpServerSummary[] | null): TemplateResult {
    const body = !servers
      ? renderSettingsLoadingSkeleton({ rows: 3 })
      : servers.length === 0
        ? renderSettingsEmpty(t("mcpPage.noServers"))
        : renderSettingsGroup(
            servers.map((server) =>
              renderSettingsNavRow({
                title: html`<span data-mcp-name=${server.name}>${server.name}</span>`,
                description: this.serverTarget(server),
                control: renderSettingsStatus({
                  kind: server.enabled ? "ok" : "muted",
                  label: server.enabled ? t("common.enabled") : t("common.disabled"),
                }),
                onClick: () =>
                  this.navigateTo(pathForMcpServer(server.name, this.context.basePath)),
              }),
            ),
          );
    return html`${renderSettingsPageHeader({
      title: t("tabs.mcpServers"),
      subtitle: t("subtitles.mcpServers"),
    })}${renderSettingsWorkspace(renderSettingsPage(body))}`;
  }

  /** The identity line under a detail title, in the plugin detail's own markup. */
  private renderIdentity(primary: TemplateResult | string, secondary?: string): TemplateResult {
    return html`<div class="plugin-catalog-detail__publisher">
      <span class="plugin-catalog-detail__publisher-name"><strong>${primary}</strong></span>
      ${secondary ? html`<span>${secondary}</span>` : nothing}
    </div>`;
  }

  /** What the server's Tools panel holds before, instead of, or as its tools. */
  private renderToolsPanel(server: McpServerSummary): TemplateResult {
    const probe = this.probe;
    if (!server.enabled) {
      return renderSettingsEmpty(t("mcpPage.serverDisabled"));
    }
    if (!this.gateway.connected) {
      return renderSettingsEmpty(t("mcpPage.offline"));
    }
    if (!this.canProbe) {
      return renderSettingsEmpty(t("mcpPage.probeUnavailable"));
    }
    if (this.error) {
      return html`<div role="alert" class="callout danger">
        ${this.error}
        <button type="button" class="btn btn--sm" @click=${() => void this.load()}>
          ${t("common.retry")}
        </button>
      </div>`;
    }
    if (!probe) {
      return renderSettingsLoadingSkeleton({ rows: 3 });
    }
    if (probe.status === "error") {
      return html`<div role="alert" class="callout danger">
        ${probe.error ?? t("mcpPage.probeFailed")}
      </div>`;
    }
    if (probe.tools.length === 0) {
      return renderSettingsEmpty(t("mcpPage.noTools"));
    }
    return renderPluginCapabilitySection(
      t("mcpPage.tools"),
      probe.tools.map((tool) => ({
        name: tool.title ?? tool.name,
        description: tool.description,
        onOpen: () =>
          this.navigateTo(pathForMcpServerTool(server.name, tool.name, this.context.basePath)),
      })),
      icons.wrench,
    );
  }

  private renderServer(name: string, server: McpServerSummary | undefined): TemplateResult {
    const probe = this.probe;
    const title = probe?.title ?? name;
    this.help.update({
      context: this.context,
      connected: this.gateway.connected,
      subject: server
        ? {
            id: name,
            name: title,
            server: name,
            tools: probe?.tools.map((tool) => tool.name) ?? [],
          }
        : null,
    });
    const ask = this.help.available ? this.help.ask : undefined;
    const back = {
      backHref: pathForRoute("mcp-servers", this.context.basePath),
      backLabel: t("tabs.mcpServers"),
      onBack: () => this.navigateTo(pathForRoute("mcp-servers", this.context.basePath)),
    };
    if (!server) {
      return renderSettingsPage(
        renderPluginDetailShell({
          ...back,
          id: `mcp-server-${name}`,
          name,
          identity: nothing,
          panel: renderSettingsEmpty(t("mcpServers.missing", { name })),
        }),
      );
    }
    return html`<div data-mcp-name=${server.name}>
      ${renderSettingsPage(
        renderPluginDetailShell({
          ...back,
          id: `mcp-server-${server.name}`,
          name: title,
          identity: this.renderIdentity(server.name, this.serverTarget(server)),
          titleAction: html`${renderPluginAskAction(ask ? () => void ask() : undefined)}<button
              type="button"
              class="btn oc-action oc-action-secondary"
              ?disabled=${this.loading || !server.enabled || !this.canProbe}
              @click=${() => void this.load()}
            >
              ${this.loading ? t("mcpPage.probing") : t("mcpPage.probeAgain")}
            </button>`,
          panel: this.renderToolsPanel(server),
          readme: probe?.description ? renderPluginReadme(probe.description) : undefined,
        }),
      )}
    </div>`;
  }

  private renderTool(serverName: string, toolName: string): TemplateResult {
    const server = this.configuredServer(serverName);
    const probe = this.probe;
    const tool: McpProbeTool | undefined = probe?.tools.find((entry) => entry.name === toolName);
    const serverTitle = probe?.title ?? serverName;
    this.help.update({
      context: this.context,
      connected: this.gateway.connected,
      subject: tool
        ? {
            id: `${serverName}/${tool.name}`,
            name: tool.title ?? tool.name,
            server: serverName,
            tools: [tool.name],
          }
        : null,
    });
    const ask = this.help.available ? this.help.ask : undefined;
    const back = {
      backHref: pathForMcpServer(serverName, this.context.basePath),
      backLabel: serverTitle,
      onBack: () => this.navigateTo(pathForMcpServer(serverName, this.context.basePath)),
    };
    const id = `mcp-tool-${serverName}-${toolName}`;
    if (!server || !tool) {
      const panel = !server
        ? renderSettingsEmpty(t("mcpServers.missing", { name: serverName }))
        : this.loading || (!probe && !this.error && this.canProbe && server.enabled)
          ? renderSettingsLoadingSkeleton({ rows: 3 })
          : this.error
            ? html`<div role="alert" class="callout danger">${this.error}</div>`
            : renderSettingsEmpty(t("mcpPage.toolNotFound", { name: toolName }));
      return renderSettingsPage(
        renderPluginDetailShell({ ...back, id, name: toolName, identity: nothing, panel }),
      );
    }
    const inputs = tool.parameters?.length
      ? renderPluginCapabilitySection(
          t("pluginsPage.detailToolInputs"),
          tool.parameters.map((parameter) => ({
            name: parameter.name,
            description: [
              t(parameter.required ? "pluginsPage.detailRequired" : "pluginsPage.detailOptional"),
              parameter.type,
              parameter.description,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · "),
          })),
          icons.wrench,
        )
      : renderSettingsEmpty(t("mcpPage.noInputs"));
    return html`<div data-mcp-tool=${tool.name}>
      ${renderSettingsPage(
        renderPluginDetailShell({
          ...back,
          id,
          name: tool.title ?? tool.name,
          identity: this.renderIdentity(html`<code>${tool.name}</code>`, serverTitle),
          titleAction: ask ? html`${renderPluginAskAction(() => void ask())}` : undefined,
          panel: inputs,
          readme: tool.description ? renderPluginReadme(tool.description) : undefined,
        }),
      )}
    </div>`;
  }

  override render() {
    if (!this.context) {
      return nothing;
    }
    const selected = this.selected;
    if (!selected) {
      this.help.update({ context: this.context, connected: this.gateway.connected, subject: null });
      return this.renderList(
        summarizeMcpServers(currentConfigObject(this.context.runtimeConfig.state)),
      );
    }
    if (selected.tool) {
      return this.renderTool(selected.server, selected.tool);
    }
    return this.renderServer(selected.server, this.configuredServer(selected.server));
  }
}

customElements.define("openclaw-mcp-servers-page", McpServersPage);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-servers-page": McpServersPage;
  }
}
