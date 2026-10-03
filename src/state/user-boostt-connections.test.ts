import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSecretStoreEntries } from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  BOOSTT_CONNECTION_NAME,
  disconnectUserBoosttConnection,
  disconnectedUserBoosttConnection,
  findUserBoosttPendingByState,
  mergeUserBoosttConnection,
  readUserBoosttAccessToken,
  readUserBoosttConnection,
  updateUserBoosttConnection,
  type UserBoosttConnection,
  type UserBoosttPending,
} from "./user-boostt-connections.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "./user-profiles.js";

// A Boostt connection is a personal connection in the shape of My GitHub: one
// record per profile in the secret store under identity scope. The owner
// profile may hold one. It never touches user_profile_identities.

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-boostt-"), "openclaw.sqlite") };
}

const account = {
  userId: 14145,
  email: "member@example.com",
  displayName: "Linna Hunt",
  handle: "linna-hunt",
};

function pending(overrides: Partial<UserBoosttPending> = {}): UserBoosttPending {
  const now = Date.now();
  return {
    requestId: "6f9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5e",
    state: "state-0123456789abcdef",
    codeVerifier: "v".repeat(64),
    clientId: "client-1",
    redirectUri: "http://127.0.0.1:19102/oauth/boostt/callback",
    apiUrl: "https://api.boostt.org",
    authorizeUrl: "https://api.boostt.org/oauth/authorize?state=state-0123456789abcdef",
    createdAtMs: now,
    expiresAtMs: now + 600_000,
    ...overrides,
  };
}

function connected(requestId: string): UserBoosttConnection {
  return {
    version: 1,
    generation: "11111111-1111-4111-8111-111111111111",
    selection: {
      kind: "connected",
      account,
      clientId: "client-1",
      accessToken: "access-token-value-1234567890",
      refreshToken: "refresh-token-value-123",
      accessExpiresAtMs: null,
      connectedAtMs: Date.now(),
      completedRequestId: requestId,
    },
  };
}

function identityRows(options: ReturnType<typeof stateOptions>) {
  const { db } = openOpenClawStateDatabase(options);
  return db.prepare("SELECT provider, subject, profile_id FROM user_profile_identities").all();
}

describe("user boostt connections", () => {
  it("records a pending request on the owner profile and finds it by state", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const begun = updateUserBoosttConnection(
      owner.id,
      (current) => ({ ...(current ?? disconnectedUserBoosttConnection()), pending: pending() }),
      () => {},
      options,
    );
    expect(begun.selection.kind).toBe("disconnected");
    expect(begun.pending?.state).toBe("state-0123456789abcdef");
    const found = findUserBoosttPendingByState("state-0123456789abcdef", options);
    expect(found?.owner).toBe(owner.id);
    expect(found?.pending.requestId).toBe(begun.pending?.requestId);
    expect(found?.pending.codeVerifier).toBe("v".repeat(64));
    expect(findUserBoosttPendingByState("other", options)).toBeUndefined();
    expect(readUserBoosttAccessToken(owner.id, options)).toBeNull();
  });

  it("stores the connection as a hidden identity-scope secret and leaves identities untouched", async () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const before = identityRows(options);
    const record = updateUserBoosttConnection(
      owner.id,
      () => connected("6f9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5e"),
      () => {},
      options,
    );
    expect(record.selection.kind).toBe("connected");
    expect(readUserBoosttAccessToken(owner.id, options)).toBe("access-token-value-1234567890");
    expect(readUserBoosttConnection(owner.id, options)?.selection).toMatchObject({ account });
    expect(identityRows(options)).toEqual(before);
    expect(before).toEqual([{ provider: "gateway.local", subject: "owner", profile_id: owner.id }]);

    const { db } = openOpenClawStateDatabase(options);
    const row = db
      .prepare(
        "SELECT scope_kind, scope_id, kind, allowed_hosts FROM secret_store_entries WHERE name = ?",
      )
      .get(BOOSTT_CONNECTION_NAME) as Record<string, unknown>;
    expect(row).toEqual({
      scope_kind: "identity",
      scope_id: owner.id,
      kind: "secret",
      allowed_hosts: null,
    });
    // The generic listing reads team scope only; the connection never appears there.
    const listed = await listSecretStoreEntries({ scope: { kind: "team" }, database: options });
    expect(listed.map((entry) => entry.name)).not.toContain(BOOSTT_CONNECTION_NAME);
  });

  it("refuses a write when the caller's assertion fails and when the profile is not durable", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    expect(() =>
      updateUserBoosttConnection(
        owner.id,
        () => connected("6f9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5e"),
        () => {
          throw new Error("connection moved on");
        },
        options,
      ),
    ).toThrow(/moved on/);
    expect(readUserBoosttConnection(owner.id, options)).toBeUndefined();
    expect(() =>
      updateUserBoosttConnection(
        "not-a-profile",
        () => connected("x"),
        () => {},
        options,
      ),
    ).toThrow();
  });

  it("disconnect replaces the record with a disconnected one", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    updateUserBoosttConnection(
      owner.id,
      () => connected("6f9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5e"),
      () => {},
      options,
    );
    disconnectUserBoosttConnection(owner.id, () => {}, options);
    expect(readUserBoosttConnection(owner.id, options)?.selection).toEqual({
      kind: "disconnected",
    });
    expect(readUserBoosttAccessToken(owner.id, options)).toBeNull();
  });

  it("a profile merge keeps the target's connection, else carries the source's", () => {
    const options = stateOptions();
    const first = ensureProfileForEmail("first@example.com", options);
    const second = ensureProfileForEmail("second@example.com", options);
    updateUserBoosttConnection(
      first.id,
      () => connected("6f9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5e"),
      () => {},
      options,
    );
    runOpenClawStateWriteTransaction(
      ({ db }) => mergeUserBoosttConnection(db, first.id, second.id),
      options,
      { operationLabel: "test.merge" },
    );
    expect(readUserBoosttConnection(second.id, options)?.selection).toMatchObject({
      kind: "connected",
      account,
    });
    expect(readUserBoosttConnection(first.id, options)).toBeUndefined();
  });
});
