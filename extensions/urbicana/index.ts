/**
 * Urbicana plugin entry. It connects this Gateway to its owner's Boostt
 * account without touching the Gateway's own identity code: the owner's
 * Boostt user id lives in this plugin's state, and the owner's A2A card lives
 * in the agent workspace as a file of its own, loaded by the bundled
 * bootstrap-extra-files hook. The Urbicana proxy hands this plugin the
 * owner's Boostt token at sign-in; nothing is asked of the person.
 */
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/health";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveBoosttSettings, type BoosttAccount } from "./src/account.js";
import { createUrbicanaRouteHandler } from "./src/routes.js";
import { createUrbicanaService } from "./src/service.js";

export default definePluginEntry({
  id: "urbicana",
  name: "Urbicana",
  description:
    "Connects this Gateway to its owner's Boostt account and keeps the owner's A2A card in the agent workspace.",
  register(api) {
    const settings = resolveBoosttSettings(api.pluginConfig);
    const store = api.runtime.state.openKeyedStore<BoosttAccount>({
      namespace: "owner",
      retention: "retained",
    });
    const service = createUrbicanaService({
      settings,
      store: {
        lookup: (key) => store.lookup(key),
        register: (key, value) => store.register(key, value),
        delete: (key) => store.delete(key),
      },
      workspaceDir: () => resolveAgentWorkspaceDir(api.config, resolveDefaultAgentId(api.config)),
      log: { info: (m) => api.logger.info(m), warn: (m) => api.logger.warn(m) },
    });
    api.registerHttpRoute({
      path: "/plugins/urbicana",
      auth: "gateway",
      match: "prefix",
      handler: createUrbicanaRouteHandler(service),
    });
    if (!settings.railsUrl) {
      api.logger.warn(
        "urbicana: no Boostt API origin configured (plugins.entries.urbicana.config.railsUrl); the owner cannot be connected",
      );
    }
  },
});
