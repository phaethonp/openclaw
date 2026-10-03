import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UsersBoosttAuthorizePollResult,
  UsersBoosttAuthorizeStartResult,
  UsersBoosttStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerBoosttEnglish } from "../../i18n/locales/en-boostt.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

// Settings → Profile → Boostt account. The profile this connection is signed
// in as connects to one Boostt member. The Gateway runs the OAuth exchange;
// this element opens Boostt's approval page and waits for the answer.

const POLL_MS = 2000;

export class BoosttAccount extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @state() private status: UsersBoosttStatusResult | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private pending: UsersBoosttAuthorizeStartResult | null = null;
  @state() private popupBlocked = false;

  private snapshot: ApplicationGatewaySnapshot | null = null;
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private canRead = false;
  private profileId: string | null = null;
  private revision = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applySnapshot(snapshot)),
    ];
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.stopPolling();
    this.revision += 1;
    super.disconnectedCallback();
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const previous = this.snapshot;
    const profileId = snapshot.phase === "connected" ? (snapshot.selfUser?.id ?? null) : null;
    const changed =
      !previous ||
      previous.client !== snapshot.client ||
      previous.phase !== snapshot.phase ||
      this.profileId !== profileId;
    this.snapshot = snapshot;
    this.client = snapshot.client;
    this.connected = snapshot.phase === "connected";
    this.profileId = profileId;
    this.canRead =
      this.connected &&
      Boolean(snapshot.hello?.auth) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    if (changed) {
      this.revision += 1;
      this.stopPolling();
      this.status = null;
      this.pending = null;
      this.error = null;
      this.busy = false;
      this.loading = false;
      if (this.readable) {
        void this.load();
      }
    }
    this.requestUpdate();
  }

  private get readable(): boolean {
    return this.connected && this.client !== null && this.canRead && this.profileId !== null;
  }

  private capture() {
    const client = this.client;
    const revision = this.revision;
    return client
      ? { client, isCurrent: () => this.client === client && this.revision === revision }
      : null;
  }

  private async load() {
    const owner = this.capture();
    if (!owner || this.loading) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const status = await owner.client.request<UsersBoosttStatusResult>("users.boostt.status", {});
      if (!owner.isCurrent()) {
        return;
      }
      this.status = status;
      if (status.pending) {
        this.pending = status.pending;
        this.schedulePoll();
      }
    } catch (error) {
      if (owner.isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (owner.isCurrent()) {
        this.loading = false;
      }
    }
  }

  private async connect() {
    const owner = this.capture();
    if (!owner || this.busy || !this.readable) {
      return;
    }
    this.busy = true;
    this.error = null;
    this.popupBlocked = false;
    try {
      const started = await owner.client.request<UsersBoosttAuthorizeStartResult>(
        "users.boostt.authorize.start",
        { redirectOrigin: window.location.origin },
      );
      if (!owner.isCurrent()) {
        return;
      }
      this.pending = started;
      const opened = openExternalUrlSafe(started.authorizeUrl);
      this.popupBlocked = opened === null;
      this.schedulePoll();
    } catch (error) {
      if (owner.isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (owner.isCurrent()) {
        this.busy = false;
      }
    }
  }

  private schedulePoll() {
    this.stopPolling();
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll() {
    const owner = this.capture();
    const pending = this.pending;
    if (!owner || !pending) {
      return;
    }
    try {
      const result = await owner.client.request<UsersBoosttAuthorizePollResult>(
        "users.boostt.authorize.poll",
        { requestId: pending.requestId },
      );
      if (!owner.isCurrent() || this.pending !== pending) {
        return;
      }
      if (result.status === "pending") {
        this.pollTimer = setTimeout(() => void this.poll(), result.retryAfterMs);
        return;
      }
      this.pending = null;
      if (result.status === "success") {
        await this.load();
      } else if (result.status === "expired") {
        this.error = t("boosttAccount.expired");
      } else {
        this.error = t("boosttAccount.failed", { reason: result.reason });
      }
    } catch (error) {
      if (owner.isCurrent()) {
        this.pending = null;
        this.error = formatUiError(error);
      }
    }
  }

  private async cancel() {
    const owner = this.capture();
    const pending = this.pending;
    if (!owner || !pending) {
      return;
    }
    this.stopPolling();
    this.pending = null;
    try {
      await owner.client.request("users.boostt.authorize.cancel", { requestId: pending.requestId });
    } catch {
      /* The pending record expires on its own. */
    }
  }

  private async disconnect() {
    const owner = this.capture();
    if (!owner || this.busy) {
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t("boosttAccount.disconnectConfirmTitle"),
      message: t("boosttAccount.disconnectConfirmMessage"),
      confirmLabel: t("boosttAccount.disconnect"),
      danger: true,
    });
    if (!confirmed || !owner.isCurrent()) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await owner.client.request("users.boostt.disconnect", {});
      if (owner.isCurrent()) {
        await this.load();
      }
    } catch (error) {
      if (owner.isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (owner.isCurrent()) {
        this.busy = false;
      }
    }
  }

  private renderStatus() {
    if (!this.readable) {
      return renderSettingsStatus({
        kind: "muted",
        label:
          this.connected && !this.canRead
            ? t("boosttAccount.readRequired")
            : t("boosttAccount.signInRequired"),
      });
    }
    if (this.loading && !this.status) {
      return renderSettingsStatus({ kind: "muted", label: t("boosttAccount.checking") });
    }
    if (this.pending) {
      return renderSettingsStatus({ kind: "warn", label: t("boosttAccount.connecting") });
    }
    return this.status?.state === "connected"
      ? renderSettingsStatus({ kind: "ok", label: t("boosttAccount.connected") })
      : renderSettingsStatus({ kind: "muted", label: t("boosttAccount.disconnected") });
  }

  private renderControl() {
    if (!this.readable) {
      return nothing;
    }
    if (this.pending) {
      return html`<div class="settings-row__actions">
        ${
          this.popupBlocked
            ? html`<a
                class="settings-link"
                href=${this.pending.authorizeUrl}
                target=${EXTERNAL_LINK_TARGET}
                rel=${buildExternalLinkRel()}
                >${t("boosttAccount.openBoostt")}</a
              >`
            : nothing
        }
        <button class="btn btn--ghost" type="button" @click=${() => void this.cancel()}>
          ${t("boosttAccount.cancel")}
        </button>
      </div>`;
    }
    if (this.status?.state === "connected") {
      return html`<button
        class="btn btn--ghost btn--danger"
        type="button"
        ?disabled=${this.busy}
        @click=${() => void this.disconnect()}
      >
        ${t("boosttAccount.disconnect")}
      </button>`;
    }
    return html`<button
      class="btn btn--primary"
      type="button"
      ?disabled=${this.busy || this.loading}
      @click=${() => void this.connect()}
    >
      ${t("boosttAccount.connect")}
    </button>`;
  }

  override render() {
    const account = this.status?.account ?? null;
    return renderSettingsSection(
      { title: t("boosttAccount.title"), description: t("boosttAccount.description") },
      html`
        ${renderSettingsRow({
          title: t("boosttAccount.status"),
          description: this.popupBlocked ? t("boosttAccount.popupBlocked") : undefined,
          control: html`<div class="settings-row__controls">
            ${this.renderStatus()} ${this.renderControl()}
          </div>`,
        })}
        ${
          account
            ? html`
                ${renderSettingsRow({
                  title: t("boosttAccount.account"),
                  control: renderSettingsValue(
                    [account.displayName, account.email].filter(Boolean).join(" · "),
                  ),
                })}
                ${renderSettingsRow({
                  title: t("boosttAccount.memberId"),
                  control: renderSettingsValue(String(account.userId), { mono: true }),
                })}
                ${
                  this.status?.connectedAtMs
                    ? renderSettingsRow({
                        title: t("boosttAccount.connectedSince"),
                        control: renderSettingsValue(formatDateTimeMs(this.status.connectedAtMs)),
                      })
                    : nothing
                }
              `
            : nothing
        }
        ${
          this.error
            ? renderSettingsRow({
                title: renderSettingsStatus({ kind: "danger", label: this.error }),
                role: "alert",
              })
            : nothing
        }
      `,
    );
  }
}

if (!customElements.get("urbicana-boostt-account")) {
  customElements.define("urbicana-boostt-account", BoosttAccount);
}

registerBoosttEnglish();
