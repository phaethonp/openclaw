import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  createPluginHelpRequest,
  publishPluginHelpContext,
  type PluginHelpReference,
} from "../custodian/plugin-help.ts";

/** What the Ask panel is about: a server with all its tools, or one tool of a server. */
export type McpHelpSubject = {
  id: string;
  name: string;
  server: string;
  tools: string[];
};

/**
 * The opened server or tool as the Ask panel's subject. The reference is the
 * same shape a plugin publishes: its name, and what it declares (its tools,
 * the server as an MCP server), so the custodian answers "what does it do"
 * from what the server lists rather than from a guess.
 */
export class McpServerHelpController implements ReactiveController {
  private context?: ApplicationContext;
  private reference?: PluginHelpReference;
  private release?: () => void;

  constructor(host: ReactiveControllerHost) {
    host.addController(this);
  }

  get available(): boolean {
    return this.reference !== undefined;
  }

  update(model: {
    context: ApplicationContext;
    connected: boolean;
    subject: McpHelpSubject | null;
  }): void {
    const context = model.context;
    if (context !== this.context) {
      this.release?.();
      this.release = undefined;
      this.context = context;
    }
    const subject = model.subject;
    this.reference =
      subject &&
      model.connected &&
      canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin")
        ? {
            id: subject.id,
            name: subject.name,
            declared: { mcpServers: [subject.server], tools: subject.tools },
          }
        : undefined;
    if (!this.reference) {
      this.release?.();
      this.release = undefined;
      return;
    }
    this.release = publishPluginHelpContext(context, this, this.reference, {
      installed: true,
      overview: true,
    });
  }

  get ask(): () => Promise<void> {
    if (!this.context || !this.reference) {
      return async () => {};
    }
    const request = createPluginHelpRequest(this.context, this.reference);
    return () => request();
  }

  hostDisconnected(): void {
    this.release?.();
    this.release = undefined;
    this.reference = undefined;
  }
}
