import {
  ErrorCodes,
  errorShape,
  validateUsersBoosttAuthorizeCancelParams,
  validateUsersBoosttAuthorizePollParams,
  validateUsersBoosttAuthorizeStartParams,
  validateUsersBoosttDisconnectParams,
  validateUsersBoosttStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareBoosttAccountAction, type BoosttAccountAction } from "../boostt-account.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

// Settings → Profile → Boostt account. The same shape as users.github.*: the
// acting profile comes from the live connection, never from a parameter.

function runBoostt(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal" | "respond">,
  fallbackError: string,
  run: (
    action: BoosttAccountAction,
    service: NonNullable<GatewayRequestContext["boosttAccountService"]>,
  ) => unknown,
): void | Promise<void> {
  const fail = (error: unknown) =>
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : fallbackError),
    );
  try {
    const action = prepareBoosttAccountAction(options);
    const service = options.context.boosttAccountService;
    if (!service) {
      throw new Error("Boostt accounts are unavailable; retry after Gateway startup.");
    }
    const result = run(action, service);
    if (result instanceof Promise) {
      return result
        .then((value) => {
          action.assertCurrent();
          options.respond(true, value);
        })
        .catch(fail);
    }
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}

export const usersBoosttHandlers: GatewayRequestHandlers = {
  "users.boostt.status": defineValidatedGatewayMethod(
    "users.boostt.status",
    validateUsersBoosttStatusParams,
    (options) =>
      runBoostt(options, "The Boostt account status is unavailable.", (action, service) =>
        service.status(action),
      ),
  ),
  "users.boostt.authorize.start": defineValidatedGatewayMethod(
    "users.boostt.authorize.start",
    validateUsersBoosttAuthorizeStartParams,
    (options) =>
      runBoostt(options, "The Boostt connection could not start.", (action, service) =>
        service.startAuthorization(action, { redirectOrigin: options.params.redirectOrigin }),
      ),
  ),
  "users.boostt.authorize.poll": defineValidatedGatewayMethod(
    "users.boostt.authorize.poll",
    validateUsersBoosttAuthorizePollParams,
    (options) =>
      runBoostt(options, "The Boostt connection could not be read.", (action, service) =>
        service.pollAuthorization(action, options.params.requestId),
      ),
  ),
  "users.boostt.authorize.cancel": defineValidatedGatewayMethod(
    "users.boostt.authorize.cancel",
    validateUsersBoosttAuthorizeCancelParams,
    (options) =>
      runBoostt(options, "The Boostt connection could not be cancelled.", (action, service) => ({
        cancelled: service.cancelAuthorization(action, options.params.requestId),
      })),
  ),
  "users.boostt.disconnect": defineValidatedGatewayMethod(
    "users.boostt.disconnect",
    validateUsersBoosttDisconnectParams,
    (options) =>
      runBoostt(options, "The Boostt account could not be disconnected.", (action, service) => {
        service.disconnect(action);
        return { disconnected: true };
      }),
  ),
};
