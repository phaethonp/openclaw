import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import {
  requireResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";

// The verified Boostt account on a profile: an identity row with provider
// `boostt` and the Boostt user id as subject, the way a GitHub-backed sign-in
// leaves a profile its verified GitHub account. It is written at sign-in,
// after the Gateway has asked Boostt whose token the trusted proxy forwarded
// and Boostt has named the same person the proxy did (see
// gateway/boostt-user-identity.ts; the writer is syncBoosttIdentity in
// user-profile-writes.worker.ts).
//
// One Boostt account belongs to one profile, so a row held elsewhere moves;
// one profile holds one Boostt account, so an older row on it goes. The
// shared owner profile never carries one: a sign-in identity names a person.

export const BOOSTT_PROVIDER = "boostt";

export type UserProfileBoosttIdentity = { userId: number; handle: string | null };

/** What Boostt said about the token the proxy forwarded. */
export type VerifiedBoosttAccount = {
  userId: number;
  email: string;
  handle: string | null;
  displayName: string | null;
};

function toSubject(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError("Boostt user id must be a positive safe integer");
  }
  return String(userId);
}

/** Current verified Boostt identities, by profile id. */
export function selectUserProfileBoosttIdentities(
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, UserProfileBoosttIdentity> {
  if (!tableExists(db, "user_profile_identities") || profileIds?.length === 0) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .select(["profile_id", "subject", "canonical_login"])
    .where("provider", "=", BOOSTT_PROVIDER);
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const out = new Map<string, UserProfileBoosttIdentity>();
  for (const row of executeSqliteQuerySync(db, query).rows) {
    const userId = Number(row.subject);
    if (Number.isSafeInteger(userId) && userId > 0) {
      out.set(row.profile_id, { userId, handle: row.canonical_login ?? null });
    }
  }
  return out;
}

/** Caller owns the transaction. Refuses the shared owner, as every sign-in identity writer does. */
export function applyBoosttIdentity(params: {
  db: DatabaseSync;
  profileId: string;
  identity: UserProfileBoosttIdentity;
  mutation?: UserProfileMutationContext;
}): { changed: boolean } {
  const { db } = params;
  const kysely = userProfilesDb(db);
  const subject = toSubject(params.identity.userId);
  const handle = params.identity.handle?.trim() || null;
  const profile = requireResolvedUserProfileMetadataById(db, params.profileId);
  if (params.profileId === GATEWAY_OWNER_PROFILE_ID || profile.id === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("merge");
  }
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select(["profile_id", "subject", "canonical_login"])
      .where("provider", "=", BOOSTT_PROVIDER)
      .where((eb) => eb.or([eb("subject", "=", subject), eb("profile_id", "=", profile.id)])),
  ).rows;
  const current = rows.find((row) => row.subject === subject);
  const displaced = rows.filter((row) => row.profile_id === profile.id && row.subject !== subject);
  if (
    current?.profile_id === profile.id &&
    (current.canonical_login ?? null) === handle &&
    displaced.length === 0
  ) {
    return { changed: false };
  }
  const affected = [
    profile.id,
    ...(current && current.profile_id !== profile.id ? [current.profile_id] : []),
  ];
  params.mutation?.before(db, ...affected);
  if (displaced.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("user_profile_identities")
        .where("provider", "=", BOOSTT_PROVIDER)
        .where("profile_id", "=", profile.id)
        .where("subject", "!=", subject),
    );
  }
  const binding = { profile_id: profile.id, canonical_login: handle };
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({ provider: BOOSTT_PROVIDER, subject, ...binding, created_at: Date.now() })
      .onConflict((conflict) => conflict.columns(["provider", "subject"]).doUpdateSet(binding)),
  );
  params.mutation?.authority(...affected);
  publishUserProfileAuthorityChange(db, ...affected);
  publishUserProfileIdentityChange(db, ...affected);
  params.mutation?.publish(...affected);
  publishUserProfilesChange(db, ...affected);
  return { changed: true };
}
