import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  PersonalConnectionStateError,
  listPersonalConnectionSecrets,
  readPersonalConnectionSecret,
  writePersonalConnectionSecret,
} from "../secrets/store/secret-store-personal-connection.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolvePersonalGitHubOwner } from "./user-github-connections.js";

// The Boostt account a Gateway profile is connected to: a personal
// connection in the same shape as My GitHub. One record per profile in the
// secret store under identity scope. It holds the account Rails named and
// the tokens Rails issued. It is a credential the profile uses; it is not a
// profile identity and changes nothing about who the profile is.

export const BOOSTT_CONNECTION_NAME = "boostt-connection";

const timestamp = z.number().int().nonnegative().safe();
const secret = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n]+$/u);
const text = (max: number) => z.string().min(1).max(max);

const account = z.strictObject({
  userId: z.number().int().positive().safe(),
  email: text(320),
  displayName: text(256).nullable(),
  handle: text(128).nullable(),
});

const pending = z.strictObject({
  requestId: z.string().uuid(),
  state: text(128),
  codeVerifier: z.string().min(43).max(128),
  clientId: text(256),
  redirectUri: z.string().url(),
  apiUrl: z.string().url(),
  authorizeUrl: z.string().url(),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
});

const connected = z.strictObject({
  kind: z.literal("connected"),
  account,
  /** The Rails OAuth client this Gateway registered as; the refresh grant names it. */
  clientId: text(256),
  accessToken: secret,
  refreshToken: secret.nullable(),
  /** Null when Rails issued a token without an expiry. */
  accessExpiresAtMs: timestamp.nullable(),
  connectedAtMs: timestamp,
  /** The authorization request this connection completed; the poll answers it. */
  completedRequestId: z.string().uuid(),
  /** Set when a refresh grant was refused; cleared by a reconnect. */
  refreshFailure: z.enum(["expired", "failed"]).optional(),
});

const connectionSchema = z.strictObject({
  version: z.literal(1),
  generation: z.string().uuid(),
  selection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("disconnected") }),
    connected,
  ]),
  pending: pending.optional(),
});

export type UserBoosttConnection = z.infer<typeof connectionSchema>;
export type UserBoosttConnected = z.infer<typeof connected>;
export type UserBoosttPending = z.infer<typeof pending>;
export type BoosttAccount = z.infer<typeof account>;

function parseConnection(raw: string): UserBoosttConnection {
  const result = connectionSchema.safeParse(safeParseJson(raw));
  if (!result.success) {
    throw new PersonalConnectionStateError(BOOSTT_CONNECTION_NAME);
  }
  const record = result.data;
  if (record.selection.kind === "connected") {
    registerSecretValueForRedaction(record.selection.accessToken);
    if (record.selection.refreshToken) {
      registerSecretValueForRedaction(record.selection.refreshToken);
    }
  }
  return record;
}

function requireOwner(db: DatabaseSync, owner: string): void {
  if (resolvePersonalGitHubOwner(owner, db) !== owner) {
    throw new Error("The profile changed; reconnect and try again.");
  }
}

function readConnection(db: DatabaseSync, owner: string): UserBoosttConnection | undefined {
  const raw = readPersonalConnectionSecret(db, owner, BOOSTT_CONNECTION_NAME);
  return raw === undefined ? undefined : parseConnection(raw);
}

// Only explicit replacement may repair corruption: a broken record counts as
// disconnected so it never carries its credentials into a merge.
function readConnectionForReplacement(
  db: DatabaseSync,
  owner: string,
): UserBoosttConnection | undefined {
  try {
    return readConnection(db, owner);
  } catch (error) {
    if (!(error instanceof PersonalConnectionStateError)) {
      throw error;
    }
    return undefined;
  }
}

export function disconnectedUserBoosttConnection(): UserBoosttConnection {
  return { version: 1, generation: randomUUID(), selection: { kind: "disconnected" } };
}

export function readUserBoosttConnection(
  owner: string,
  database?: OpenClawStateDatabaseOptions,
): UserBoosttConnection | undefined {
  return readConnection(openOpenClawStateDatabase(database).db, owner);
}

/** The bearer the profile's Boostt tools send to Rails; null until connected. */
export function readUserBoosttAccessToken(
  owner: string,
  database?: OpenClawStateDatabaseOptions,
): string | null {
  const selection = readUserBoosttConnection(owner, database)?.selection;
  return selection?.kind === "connected" ? selection.accessToken : null;
}

/**
 * Replaces the record under the writer lock. `update` sees the current record
 * (undefined when none) and returns the next one; `assertCurrent` runs inside
 * the transaction so a caller whose connection or profile moved on writes nothing.
 */
export function updateUserBoosttConnection(
  owner: string,
  update: (current: UserBoosttConnection | undefined) => UserBoosttConnection,
  assertCurrent: () => void,
  database?: OpenClawStateDatabaseOptions,
): UserBoosttConnection {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requireOwner(db, owner);
      const current = readConnection(db, owner);
      const next = parseConnection(JSON.stringify(update(current)));
      assertCurrent();
      writePersonalConnectionSecret(db, owner, BOOSTT_CONNECTION_NAME, JSON.stringify(next));
      return next;
    },
    database,
    { operationLabel: "users.boostt.update" },
  );
}

export function disconnectUserBoosttConnection(
  owner: string,
  assertCurrent: () => void,
  database?: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requireOwner(db, owner);
      assertCurrent();
      writePersonalConnectionSecret(
        db,
        owner,
        BOOSTT_CONNECTION_NAME,
        JSON.stringify(disconnectedUserBoosttConnection()),
      );
    },
    database,
    { operationLabel: "users.boostt.disconnect" },
  );
}

/** On a profile merge the surviving profile keeps its own connection, else the source's. */
export function mergeUserBoosttConnection(db: DatabaseSync, source: string, target: string): void {
  requireOwner(db, source);
  requireOwner(db, target);
  const sourceRecord = readConnectionForReplacement(db, source);
  const targetRecord = readConnectionForReplacement(db, target);
  const selected = targetRecord ?? sourceRecord;
  if (!selected) {
    return;
  }
  const next: UserBoosttConnection = { ...selected, generation: randomUUID(), pending: undefined };
  writePersonalConnectionSecret(db, target, BOOSTT_CONNECTION_NAME, JSON.stringify(next));
  if (sourceRecord) {
    writePersonalConnectionSecret(db, source, BOOSTT_CONNECTION_NAME, null);
  }
}

/** The OAuth redirect names only the state; this finds whose pending request it is. */
export function findUserBoosttPendingByState(
  state: string,
  database?: OpenClawStateDatabaseOptions,
): { owner: string; record: UserBoosttConnection; pending: UserBoosttPending } | undefined {
  const { db } = openOpenClawStateDatabase(database);
  const now = Date.now();
  for (const row of listPersonalConnectionSecrets(db, BOOSTT_CONNECTION_NAME)) {
    let record: UserBoosttConnection;
    try {
      record = parseConnection(row.value);
    } catch {
      continue;
    }
    const candidate = record.pending;
    if (candidate && candidate.state === state && candidate.expiresAtMs > now) {
      return { owner: row.profileId, record, pending: candidate };
    }
  }
  return undefined;
}
