import { consume } from "@lit/context";
import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type {
  McpProbeResult,
  McpProbeServerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
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
import { renderPluginCapabilitySection } from "../plugins/overview.ts";

registerMcpEnglish();

/**
 * Every configured MCP server with the tools it offers, read live through
 * mcp.probe. The config summary renders at once; the tool lists arrive when
 * the probe answers, so a server that is down shows its error next to the
 * servers that answered.
 */
class McpServersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: McpProbeResult | null = null;
  @state() private error = "";
  @state() private loading = false;
  private generation = 0;

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

  override disconnectedCallback() {
    this.invalidate();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private invalidate() {
    this.generation++;
    this.result = null;
    this.error = "";
    this.loading = false;
  }

  private get canProbe(): boolean {
    return canCallGatewayMethod(this.context?.gateway.snapshot, "mcp.probe", "operator.read");
  }

  private async load() {
    const scope = this.gateway.capture();
    if (!scope || !this.canProbe) {
      return;
    }
    const generation = ++this.generation;
    const current = () =>
      this.isConnected && generation === this.generation && this.gateway.isCurrent(scope);
    this.loading = true;
    this.error = "";
    void this.context.runtimeConfig.ensureLoaded().catch(() => undefined);
    try {
      const result = await scope.client.request<McpProbeResult>("mcp.probe", {});
      if (current()) {
        this.result = result;
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

  private renderServer(server: McpServerSummary, probe: McpProbeServerResult | undefined) {
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
      : probe
        ? this.renderTools(probe)
        : this.loading
          ? renderSettingsLoadingSkeleton({ rows: 2 })
          : nothing;
    return html`<div class="mcp-server" data-mcp-name=${server.name}>
      ${renderSettingsSection(
        {
          title: server.name,
          description: [server.target || t("mcpServers.missingTransport"), server.transport].join(
            " · ",
          ),
          actions: status,
        },
        body,
      )}
    </div>`;
  }

  override render() {
    if (!this.context) {
      return nothing;
    }
    const config = currentConfigObject(this.context.runtimeConfig.state);
    const servers = summarizeMcpServers(config);
    const probed = new Map((this.result?.servers ?? []).map((server) => [server.name, server]));
    const connected = this.gateway.connected;
    const body = renderSettingsWorkspace(
      renderSettingsPage(html`
        ${!connected ? renderSettingsEmpty(t("mcpPage.offline")) : nothing}
        ${connected && !this.canProbe ? renderSettingsEmpty(t("mcpPage.probeUnavailable")) : nothing}
        ${
          this.error
            ? html`<div role="alert" class="callout danger">
                ${this.error}
                <button type="button" class="btn btn--sm" @click=${() => void this.load()}>
                  ${t("common.retry")}
                </button>
              </div>`
            : nothing
        }
        ${
          !servers
            ? renderSettingsLoadingSkeleton({ rows: 3 })
            : servers.length === 0
              ? renderSettingsEmpty(t("mcpPage.noServers"))
              : servers.map((server) => this.renderServer(server, probed.get(server.name)))
        }
      `),
    );
    return html`${renderSettingsPageHeader({
      title: t("tabs.mcpServers"),
      subtitle: t("subtitles.mcpServers"),
      actions: html`<button
        type="button"
        class="btn btn--sm"
        ?disabled=${this.loading || !this.canProbe}
        @click=${() => void this.load()}
      >
        ${this.loading ? t("mcpPage.probing") : t("mcpPage.probeAgain")}
      </button>`,
    })}${body}`;
  }
}

customElements.define("openclaw-mcp-servers-page", McpServersPage);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-servers-page": McpServersPage;
  }
}
