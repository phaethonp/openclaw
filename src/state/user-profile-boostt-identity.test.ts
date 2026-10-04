import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  applyBoosttIdentity,
  BOOSTT_PROVIDER,
  selectUserProfileBoosttIdentities,
} from "./user-profile-boostt-identity.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import { syncBoosttIdentity } from "./user-profile-writes.worker.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileListItem,
} from "./user-profiles.js";

// A Boostt-backed sign-in leaves the person's profile its verified Boostt
// identity: provider `boostt`, subject the Boostt user id, projected as
// `boosttIdentity` beside `githubIdentity`. The owner profile never gets one.

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-boostt-identity-"), "openclaw.sqlite") };
}

function identityRows(options: ReturnType<typeof stateOptions>) {
  const { db } = openOpenClawStateDatabase(options);
  return db
    .prepare(
      "SELECT provider, subject, profile_id, canonical_login FROM user_profile_identities WHERE provider = ? ORDER BY subject",
    )
    .all(BOOSTT_PROVIDER);
}

const account = {
  userId: 14145,
  email: "Member@Example.com",
  handle: "linna-hunt",
  displayName: "Linna Hunt",
};

describe("boostt sign-in identity", () => {
  it("creates the person by verified email with the identity and Boostt's name", () => {
    const options = stateOptions();
    const profile = syncBoosttIdentity({ account }, options);
    expect(profile.emails).toEqual(["member@example.com"]);
    expect(profile.displayName).toBe("Linna Hunt");
    expect(profile.boosttIdentity).toEqual({ userId: 14145, handle: "linna-hunt" });
    expect(identityRows(options)).toEqual([
      {
        provider: "boostt",
        subject: "14145",
        profile_id: profile.id,
        canonical_login: "linna-hunt",
      },
    ]);
    expect(getUserProfileListItem(profile.id, options).boosttIdentity).toEqual({
      userId: 14145,
      handle: "linna-hunt",
    });
    expect(listUserProfilesSync(options).find((p) => p.id === profile.id)?.boosttIdentity).toEqual({
      userId: 14145,
      handle: "linna-hunt",
    });
    // A saved name is never overwritten; a repeated sign-in changes nothing.
    const again = syncBoosttIdentity({ account: { ...account, displayName: "Other" } }, options);
    expect(again.id).toBe(profile.id);
    expect(again.displayName).toBe("Linna Hunt");
  });

  it("signs in to an existing email profile and moves the account between profiles", () => {
    const options = stateOptions();
    const existing = ensureProfileForEmail("member@example.com", options);
    const profile = syncBoosttIdentity({ account }, options);
    expect(profile.id).toBe(existing.id);

    const other = ensureProfileForEmail("other@example.com", options);
    syncBoosttIdentity({ account: { ...account, email: "other@example.com" } }, options);
    expect(identityRows(options)).toEqual([
      { provider: "boostt", subject: "14145", profile_id: other.id, canonical_login: "linna-hunt" },
    ]);
    expect(getUserProfileListItem(existing.id, options).boosttIdentity).toBeNull();

    syncBoosttIdentity(
      { account: { userId: 777, email: "other@example.com", handle: null, displayName: null } },
      options,
    );
    expect(identityRows(options)).toEqual([
      { provider: "boostt", subject: "777", profile_id: other.id, canonical_login: null },
    ]);
    const { db } = openOpenClawStateDatabase(options);
    expect(selectUserProfileBoosttIdentities(db, [other.id]).get(other.id)).toEqual({
      userId: 777,
      handle: null,
    });
  });

  it("refuses the shared owner profile and an invalid user id", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    expect(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          applyBoosttIdentity({
            db,
            profileId: owner.id,
            identity: { userId: 14145, handle: null },
          }),
        options,
        { operationLabel: "test" },
      ),
    ).toThrow(UserProfileOwnerError);
    expect(() => syncBoosttIdentity({ account: { ...account, userId: 0 } }, options)).toThrow(
      TypeError,
    );
    expect(identityRows(options)).toEqual([]);
  });
});
