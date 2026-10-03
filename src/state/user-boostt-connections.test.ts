import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  BOOSTT_IDENTITY_PROVIDER,
  beginUserBoosttAuthorization,
  cancelUserBoosttAuthorization,
  completeUserBoosttAuthorization,
  disconnectUserBoosttAccount,
  findUserBoosttPendingByState,
  readBoosttIdentityForProfile,
  readUserBoosttAccessToken,
  readUserBoosttConnection,
  type BoosttPendingAuthorization,
} from "./user-boostt-connections.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "./user-profiles.js";

// A Gateway profile, the owner profile included, connects to one Boostt
// account and then carries the `boostt` identity for it.

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-boostt-"), "openclaw.sqlite") };
}

function pending(overrides: Partial<BoosttPendingAuthorization> = {}): BoosttPendingAuthorization {
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

const account = {
  userId: 14145,
  email: "member@example.com",
  displayName: "Linna Hunt",
  handle: "linna-hunt",
};
const tokens = {
  accessToken: "access-token-value-1234567890",
  refreshToken: "refresh-token-value-123",
  expiresAtMs: null,
};

function identities(options: ReturnType<typeof stateOptions>) {
  const { db } = openOpenClawStateDatabase(options);
  return executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["provider", "subject", "profile_id"])
      .where("provider", "=", BOOSTT_IDENTITY_PROVIDER),
  ).rows;
}

describe("user boostt connections", () => {
  it("connects the owner profile to a Boostt account and stamps the identity on it", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const begun = beginUserBoosttAuthorization(owner.id, pending(), options);
    expect(begun.account).toBeNull();
    expect(begun.pending?.state).toBe("state-0123456789abcdef");
    expect(findUserBoosttPendingByState("state-0123456789abcdef", options)).toEqual({
      profileId: owner.id,
      pending: pending(begun.pending!),
    });
    expect(findUserBoosttPendingByState("other", options)).toBeUndefined();

    const connected = completeUserBoosttAuthorization(
      { profileId: owner.id, requestId: begun.pending!.requestId, account, tokens },
      options,
    );
    expect(connected.account).toEqual(account);
    expect(connected.pending).toBeNull();
    expect(connected.completedRequestId).toBe(begun.pending!.requestId);
    expect(readUserBoosttAccessToken(owner.id, options)).toBe(tokens.accessToken);
    expect(identities(options)).toEqual([
      { provider: "boostt", subject: "14145", profile_id: owner.id },
    ]);
    expect(readBoosttIdentityForProfile(owner.id, options)).toEqual({
      userId: 14145,
      handle: "linna-hunt",
    });
    const { db } = openOpenClawStateDatabase(options);
    const row = db.prepare("SELECT display_name FROM user_profiles WHERE id = ?").get(owner.id) as {
      display_name: string | null;
    };
    expect(row.display_name).toBe("Linna Hunt");
  });

  it("refuses to complete an authorization that is not the pending one", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    beginUserBoosttAuthorization(owner.id, pending(), options);
    expect(() =>
      completeUserBoosttAuthorization(
        { profileId: owner.id, requestId: "00000000-0000-4000-8000-000000000000", account, tokens },
        options,
      ),
    ).toThrow(/changed/);
    expect(identities(options)).toEqual([]);
  });

  it("moves a Boostt account to the profile that connected it last, and cancels a pending request", () => {
    const options = stateOptions();
    const first = ensureProfileForEmail("first@example.com", options);
    const second = ensureProfileForEmail("second@example.com", options);
    const a = beginUserBoosttAuthorization(first.id, pending(), options);
    completeUserBoosttAuthorization(
      { profileId: first.id, requestId: a.pending!.requestId, account, tokens },
      options,
    );
    const b = beginUserBoosttAuthorization(
      second.id,
      pending({
        requestId: "7a9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d5f",
        state: "state-second-0123456789",
      }),
      options,
    );
    expect(cancelUserBoosttAuthorization(second.id, "not-the-request", options)).toBe(false);
    expect(cancelUserBoosttAuthorization(second.id, b.pending!.requestId, options)).toBe(true);
    expect(readUserBoosttConnection(second.id, options)?.pending).toBeNull();
    const c = beginUserBoosttAuthorization(
      second.id,
      pending({
        requestId: "8a9b0d9e-2a2e-4f1a-9f5e-0c1a2b3c4d60",
        state: "state-third-01234567890",
      }),
      options,
    );
    completeUserBoosttAuthorization(
      { profileId: second.id, requestId: c.pending!.requestId, account, tokens },
      options,
    );
    expect(identities(options)).toEqual([
      { provider: "boostt", subject: "14145", profile_id: second.id },
    ]);
  });

  it("disconnect removes the account, the token and the identity", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    const begun = beginUserBoosttAuthorization(owner.id, pending(), options);
    completeUserBoosttAuthorization(
      { profileId: owner.id, requestId: begun.pending!.requestId, account, tokens },
      options,
    );
    expect(disconnectUserBoosttAccount(owner.id, options)).toBe(true);
    expect(readUserBoosttConnection(owner.id, options)).toBeUndefined();
    expect(readUserBoosttAccessToken(owner.id, options)).toBeNull();
    expect(identities(options)).toEqual([]);
    expect(disconnectUserBoosttAccount(owner.id, options)).toBe(false);
  });
});
