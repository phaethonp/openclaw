import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { publishUserProfileIdentityChange } from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import {
  requireResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

// The Boostt account a Gateway profile is connected to. One row per profile,
// one Boostt account per row, and the `boostt` identity row on
// user_profile_identities so the profile IS that member (provider `boostt`,
// subject = the Rails users.id). The owner profile may carry it: in a cell
// there is one person, and that person is the member.
//
// Feature-local additive schema, like user_profile_emails: created on first
// use, never part of the startup schema.

export const BOOSTT_IDENTITY_PROVIDER = "boostt";

const USER_BOOSTT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_boostt_connections (
  profile_id TEXT NOT NULL PRIMARY KEY,
  boostt_user_id INTEGER,
  email TEXT,
  display_name TEXT,
  handle TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at_ms INTEGER,
  connected_at_ms INTEGER,
  completed_request_id TEXT,
  pending_json TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_user_boostt_connections_user_id
  ON user_boostt_connections(boostt_user_id);
`;

type UserBoosttConnectionRow = {
  profile_id: string;
  boostt_user_id: number | null;
  email: string | null;
  display_name: string | null;
  handle: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at_ms: number | null;
  connected_at_ms: number | null;
  completed_request_id: string | null;
  pending_json: string | null;
  updated_at: number;
};

type UserBoosttDatabase = { user_boostt_connections: UserBoosttConnectionRow };

const pendingSchema = z.strictObject({
  requestId: z.string().uuid(),
  state: z.string().min(16).max(128),
  codeVerifier: z.string().min(43).max(128),
  clientId: z.string().min(1).max(256),
  redirectUri: z.string().url(),
  apiUrl: z.string().url(),
  authorizeUrl: z.string().url(),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

export type BoosttPendingAuthorization = z.infer<typeof pendingSchema>;

export type BoosttAccount = {
  userId: number;
  email: string;
  displayName: string | null;
  handle: string | null;
};

export type BoosttTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
};

export type UserBoosttConnection = {
  profileId: string;
  account: BoosttAccount | null;
  connectedAtMs: number | null;
  completedRequestId: string | null;
  pending: BoosttPendingAuthorization | null;
};

const ensuredDatabases = new WeakSet<DatabaseSync>();

export function ensureUserBoosttSchema(options: UserProfileMutationOptions = {}): void {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runUserProfileWriteTransaction(
    ({ db }) => {
      db.exec(USER_BOOSTT_SCHEMA_SQL); // sqlite-allow-raw -- Feature-local additive DDL on first use.
    },
    options,
    { operationLabel: "user-boostt.ensure-schema" },
  );
  ensuredDatabases.add(database.db);
}

function boosttDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserBoosttDatabase>(db);
}

function parsePending(raw: string | null): BoosttPendingAuthorization | null {
  if (!raw) {
    return null;
  }
  const parsed = pendingSchema.safeParse(safeParseJson(raw));
  return parsed.success ? parsed.data : null;
}

function toConnection(row: UserBoosttConnectionRow): UserBoosttConnection {
  const account =
    row.boostt_user_id !== null && row.email
      ? {
          userId: row.boostt_user_id,
          email: row.email,
          displayName: row.display_name,
          handle: row.handle,
        }
      : null;
  return {
    profileId: row.profile_id,
    account,
    connectedAtMs: account ? row.connected_at_ms : null,
    completedRequestId: row.completed_request_id,
    pending: parsePending(row.pending_json),
  };
}

function selectRow(db: DatabaseSync, profileId: string): UserBoosttConnectionRow | undefined {
  if (!tableExists(db, "user_boostt_connections")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    boosttDb(db)
      .selectFrom("user_boostt_connections")
      .selectAll()
      .where("profile_id", "=", profileId),
  );
}

export function readUserBoosttConnection(
  profileId: string,
  options: UserProfileMutationOptions = {},
): UserBoosttConnection | undefined {
  const { db } = openOpenClawStateDatabase(options);
  const row = selectRow(db, profileId);
  return row ? toConnection(row) : undefined;
}

/** The bearer the member's tools send to Rails; null until connected. */
export function readUserBoosttAccessToken(
  profileId: string,
  options: UserProfileMutationOptions = {},
): string | null {
  const { db } = openOpenClawStateDatabase(options);
  return selectRow(db, profileId)?.access_token ?? null;
}

/** Records the authorization the member is about to approve at Boostt. */
export function beginUserBoosttAuthorization(
  profileId: string,
  pending: BoosttPendingAuthorization,
  options: UserProfileMutationOptions = {},
): UserBoosttConnection {
  ensureUserBoosttSchema(options);
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, profileId);
      const pendingJson = JSON.stringify(pendingSchema.parse(pending));
      executeSqliteQuerySync(
        db,
        boosttDb(db)
          .insertInto("user_boostt_connections")
          .values({
            profile_id: profile.id,
            boostt_user_id: null,
            email: null,
            display_name: null,
            handle: null,
            access_token: null,
            refresh_token: null,
            token_expires_at_ms: null,
            connected_at_ms: null,
            completed_request_id: null,
            pending_json: pendingJson,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .column("profile_id")
              .doUpdateSet({ pending_json: pendingJson, updated_at: now }),
          ),
      );
      return toConnection(selectRow(db, profile.id)!);
    },
    options,
    { operationLabel: "user-boostt.begin-authorization" },
  );
}

/** The redirect names only the OAuth state; this finds whose authorization it is. */
export function findUserBoosttPendingByState(
  state: string,
  options: UserProfileMutationOptions = {},
): { profileId: string; pending: BoosttPendingAuthorization } | undefined {
  const { db } = openOpenClawStateDatabase(options);
  if (!tableExists(db, "user_boostt_connections")) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    db,
    boosttDb(db)
      .selectFrom("user_boostt_connections")
      .select(["profile_id", "pending_json"])
      .where("pending_json", "is not", null),
  ).rows;
  const now = Date.now();
  for (const row of rows) {
    const pending = parsePending(row.pending_json);
    if (pending && pending.state === state && pending.expiresAtMs > now) {
      return { profileId: row.profile_id, pending };
    }
  }
  return undefined;
}

export function cancelUserBoosttAuthorization(
  profileId: string,
  requestId: string,
  options: UserProfileMutationOptions = {},
): boolean {
  ensureUserBoosttSchema(options);
  const now = Date.now();
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const row = selectRow(db, profileId);
      const pending = parsePending(row?.pending_json ?? null);
      if (!row || !pending || pending.requestId !== requestId) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        boosttDb(db)
          .updateTable("user_boostt_connections")
          .set({ pending_json: null, updated_at: now })
          .where("profile_id", "=", profileId),
      );
      return true;
    },
    options,
    { operationLabel: "user-boostt.cancel-authorization" },
  );
}

/**
 * The member approved at Boostt and the code was exchanged: the profile now
 * carries the account, the tokens, and the `boostt` identity. A Boostt account
 * belongs to one profile, so an identity row elsewhere moves here; a profile
 * holds one Boostt account, so an older identity on it is dropped.
 */
export function completeUserBoosttAuthorization(
  params: {
    profileId: string;
    requestId: string;
    account: BoosttAccount;
    tokens: BoosttTokens;
  },
  options: UserProfileMutationOptions = {},
): UserBoosttConnection {
  ensureUserBoosttSchema(options);
  const now = Date.now();
  registerSecretValueForRedaction(params.tokens.accessToken);
  if (params.tokens.refreshToken) {
    registerSecretValueForRedaction(params.tokens.refreshToken);
  }
  const subject = String(params.account.userId);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileMetadataById(db, params.profileId);
      const row = selectRow(db, profile.id);
      const pending = parsePending(row?.pending_json ?? null);
      if (!row || !pending || pending.requestId !== params.requestId) {
        throw new Error("Boostt authorization changed; start again.");
      }
      const kysely = boosttDb(db);
      const profiles = userProfilesDb(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("user_boostt_connections")
          .set({
            boostt_user_id: params.account.userId,
            email: params.account.email,
            display_name: params.account.displayName,
            handle: params.account.handle,
            access_token: params.tokens.accessToken,
            refresh_token: params.tokens.refreshToken,
            token_expires_at_ms: params.tokens.expiresAtMs,
            connected_at_ms: now,
            completed_request_id: params.requestId,
            pending_json: null,
            updated_at: now,
          })
          .where("profile_id", "=", profile.id),
      );
      options.mutation?.before(db, profile.id);
      const previousHolder = executeSqliteQueryTakeFirstSync(
        db,
        profiles
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", BOOSTT_IDENTITY_PROVIDER)
          .where("subject", "=", subject),
      );
      executeSqliteQuerySync(
        db,
        profiles
          .deleteFrom("user_profile_identities")
          .where("provider", "=", BOOSTT_IDENTITY_PROVIDER)
          .where("profile_id", "=", profile.id)
          .where("subject", "!=", subject),
      );
      executeSqliteQuerySync(
        db,
        profiles
          .insertInto("user_profile_identities")
          .values({
            provider: BOOSTT_IDENTITY_PROVIDER,
            subject,
            profile_id: profile.id,
            canonical_login: params.account.handle,
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["provider", "subject"])
              .doUpdateSet({ profile_id: profile.id, canonical_login: params.account.handle }),
          ),
      );
      if (!profile.display_name?.trim() && params.account.displayName?.trim()) {
        executeSqliteQuerySync(
          db,
          profiles
            .updateTable("user_profiles")
            .set({ display_name: params.account.displayName.trim(), updated_at: now })
            .where("id", "=", profile.id),
        );
      }
      const touched = [profile.id];
      if (previousHolder && previousHolder.profile_id !== profile.id) {
        touched.push(previousHolder.profile_id);
      }
      publishUserProfileIdentityChange(db, ...touched);
      options.mutation?.publish(profile.id);
      publishUserProfilesChange(db, ...touched);
      return toConnection(selectRow(db, profile.id)!);
    },
    options,
    { operationLabel: "user-boostt.complete-authorization" },
  );
}

export function disconnectUserBoosttAccount(
  profileId: string,
  options: UserProfileMutationOptions = {},
): boolean {
  ensureUserBoosttSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const row = selectRow(db, profileId);
      if (!row) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        boosttDb(db).deleteFrom("user_boostt_connections").where("profile_id", "=", profileId),
      );
      options.mutation?.before(db, profileId);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .deleteFrom("user_profile_identities")
          .where("provider", "=", BOOSTT_IDENTITY_PROVIDER)
          .where("profile_id", "=", profileId),
      );
      publishUserProfileIdentityChange(db, profileId);
      options.mutation?.publish(profileId);
      publishUserProfilesChange(db, profileId);
      return true;
    },
    options,
    { operationLabel: "user-boostt.disconnect" },
  );
}

/** The `boostt` identity on a profile, read through the identities table. */
export function readBoosttIdentityForProfile(
  profileId: string,
  options: UserProfileMutationOptions = {},
): { userId: number; handle: string | null } | undefined {
  const { db } = openOpenClawStateDatabase(options);
  if (!tableExists(db, "user_profile_identities")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["subject", "canonical_login"])
      .where("provider", "=", BOOSTT_IDENTITY_PROVIDER)
      .where("profile_id", "=", profileId),
  );
  if (!row) {
    return undefined;
  }
  const userId = Number(row.subject);
  return Number.isInteger(userId) && userId > 0
    ? { userId, handle: row.canonical_login ?? null }
    : undefined;
}
