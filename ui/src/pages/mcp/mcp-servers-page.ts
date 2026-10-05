import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  McpProbeResult,
  McpProbeServerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { mcpServerNameFromPath, pathForMcpServer, pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsSection,
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
import { renderPluginDetailBreadcrumb } from "../plugins/detail-shell.ts";
import { renderPluginCapabilitySection } from "../plugins/overview.ts";
import type { McpServersRouteData } from "./route.ts";
import "../../styles/plugins.css";

registerMcpEnglish();

/**
 * Settings › MCP › Servers. The list names every configured server from the
 * config; a server opens at /settings/mcp/servers/<name>, where its tools are
 * read live through mcp.probe. Only the opened server is probed.
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
    if (changed.has("routeData") && this.selectedName !== this.probedName) {
      this.invalidate();
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.invalidate();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private get selectedName(): string | null {
    const pathname = this.routeData?.location.pathname;
    return pathname ? mcpServerNameFromPath(pathname, this.context?.basePath ?? "") : null;
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
    const name = this.selectedName;
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

  private open(name: string) {
    this.context.navigate("mcp-servers", {
      pathname: pathForMcpServer(name, this.context.basePath),
    });
  }

  private back() {
    this.context.navigate("mcp-servers", {
      pathname: pathForRoute("mcp-servers", this.context.basePath),
    });
  }

  private renderStatus(server: McpServerSummary): TemplateResult {
    return renderSettingsStatus({
      kind: server.enabled ? "ok" : "muted",
      label: server.enabled ? t("common.enabled") : t("common.disabled"),
    });
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
                description: [
                  server.target || t("mcpServers.missingTransport"),
                  server.transport,
                ].join(" · "),
                control: this.renderStatus(server),
                onClick: () => this.open(server.name),
              }),
            ),
          );
    return html`${renderSettingsPageHeader({
      title: t("tabs.mcpServers"),
      subtitle: t("subtitles.mcpServers"),
    })}${renderSettingsWorkspace(renderSettingsPage(body))}`;
  }

  private renderTools(probe: McpProbeServerResult): TemplateResult {
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
        details: html`<p><code>${tool.name}</code></p>
          ${tool.description ? html`<p>${tool.description}</p>` : nothing}`,
      })),
      icons.wrench,
    );
  }

  private renderDetail(name: string, server: McpServerSummary | undefined): TemplateResult {
    const breadcrumb = renderPluginDetailBreadcrumb({
      name,
      backHref: pathForRoute("mcp-servers", this.context.basePath),
      backLabel: t("tabs.mcpServers"),
      onBack: () => this.back(),
    });
    if (!server) {
      return html`${breadcrumb}${renderSettingsWorkspace(
        renderSettingsPage(renderSettingsEmpty(t("mcpServers.missing", { name }))),
      )}`;
    }
    const probe = this.probe;
    const status = !server.enabled
      ? renderSettingsStatus({ kind: "muted", label: t("common.disabled") })
      : probe?.status === "ok"
        ? renderSettingsStatus({
            kind: "ok",
            label: t("mcpPage.toolCount", { count: String(probe.toolCount) }),
          })
        : probe?.status === "error"
          ? renderSettingsStatus({ kind: "danger", label: t("mcpPage.unreachable") })
          : this.loading
            ? renderSettingsStatus({ kind: "muted", label: t("mcpPage.probing") })
            : undefined;
    const body = !server.enabled
      ? renderSettingsEmpty(t("mcpPage.serverDisabled"))
      : !this.gateway.connected
        ? renderSettingsEmpty(t("mcpPage.offline"))
        : !this.canProbe
          ? renderSettingsEmpty(t("mcpPage.probeUnavailable"))
          : this.error
            ? html`<div role="alert" class="callout danger">
                ${this.error}
                <button type="button" class="btn btn--sm" @click=${() => void this.load()}>
                  ${t("common.retry")}
                </button>
              </div>`
            : probe
              ? this.renderTools(probe)
              : renderSettingsLoadingSkeleton({ rows: 3 });
    return html`${breadcrumb}${renderSettingsPageHeader({
      title: server.name,
      subtitle: [server.target || t("mcpServers.missingTransport"), server.transport].join(" · "),
      actions: html`<button
        type="button"
        class="btn btn--sm"
        ?disabled=${this.loading || !server.enabled || !this.canProbe}
        @click=${() => void this.load()}
      >
        ${this.loading ? t("mcpPage.probing") : t("mcpPage.probeAgain")}
      </button>`,
    })}${renderSettingsWorkspace(
      renderSettingsPage(
        html`<div data-mcp-name=${server.name}>
          ${renderSettingsSection({ title: t("mcpPage.tools"), actions: status }, body)}
        </div>`,
      ),
    )}`;
  }

  override render() {
    if (!this.context) {
      return nothing;
    }
    const servers = summarizeMcpServers(currentConfigObject(this.context.runtimeConfig.state));
    const name = this.selectedName;
    if (!name) {
      return this.renderList(servers);
    }
    return this.renderDetail(name, this.configuredServer(name));
  }
}

customElements.define("openclaw-mcp-servers-page", McpServersPage);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-servers-page": McpServersPage;
  }
}
