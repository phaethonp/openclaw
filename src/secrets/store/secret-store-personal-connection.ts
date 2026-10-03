import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import {
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

// A personal connection record: one aggregate per profile, stored in the
// secret store under identity scope, the same place and shape as the
// `github-connection` record. Identity-scope rows are never listed by the
// generic secret metadata reads, never exported to exec environments, and
// never purged by the expiry sweep, so a connection stays private to the
// gateway's own readers.

type PersonalConnectionDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;
type PersonalConnectionRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;

const PERSONAL_CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9]*-connection$/u;

export class PersonalConnectionStateError extends Error {
  constructor(readonly connectionName: string) {
    super(`Personal connection state for ${connectionName} is invalid; disconnect and reconnect.`);
    this.name = "PersonalConnectionStateError";
  }
}

function assertConnectionName(name: string): void {
  if (!PERSONAL_CONNECTION_NAME_PATTERN.test(name)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      "Personal connection record name must match <provider>-connection.",
    );
  }
}

function validateValue(value: string): void {
  if (Buffer.byteLength(value, "utf8") > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_TOO_LARGE",
      `Secret store value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (value.length === 0) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_EMPTY",
      "Secret store value is empty. Secret entries require a value; check the command that produced it.",
    );
  }
}

function acceptRow(
  row: Pick<PersonalConnectionRow, "value" | "kind" | "allowed_hosts">,
  name: string,
): string {
  if (row.kind !== "secret" || row.allowed_hosts !== null) {
    throw new PersonalConnectionStateError(name);
  }
  try {
    validateValue(row.value);
  } catch (error) {
    if (error instanceof SecretStoreValidationError) {
      throw new PersonalConnectionStateError(name);
    }
    throw error;
  }
  registerSecretValueForRedaction(row.value);
  return row.value;
}

/** Reads one profile's record. Undefined when none exists or the store has no table yet. */
export function readPersonalConnectionSecret(
  db: DatabaseSync,
  profileId: string,
  name: string,
): string | undefined {
  assertConnectionName(name);
  try {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<PersonalConnectionDatabase>(db)
        .selectFrom("secret_store_entries")
        .select(["value", "kind", "allowed_hosts"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where("name", "=", name)
        .where("deleted_at_ms", "is", null),
    );
    return row ? acceptRow(row, name) : undefined;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Lists every profile's record of one connection kind; a broken record is skipped. */
export function listPersonalConnectionSecrets(
  db: DatabaseSync,
  name: string,
): Array<{ profileId: string; value: string }> {
  assertConnectionName(name);
  try {
    const rows = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<PersonalConnectionDatabase>(db)
        .selectFrom("secret_store_entries")
        .select(["scope_id", "value", "kind", "allowed_hosts"])
        .where("scope_kind", "=", "identity")
        .where("name", "=", name)
        .where("deleted_at_ms", "is", null),
    ).rows;
    const out: Array<{ profileId: string; value: string }> = [];
    for (const row of rows) {
      try {
        out.push({ profileId: row.scope_id, value: acceptRow(row, name) });
      } catch (error) {
        if (!(error instanceof PersonalConnectionStateError)) {
          throw error;
        }
      }
    }
    return out;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

/** The caller owns the transaction and its preconditions. null deletes the record. */
export function writePersonalConnectionSecret(
  db: DatabaseSync,
  profileId: string,
  name: string,
  value: string | null,
): void {
  assertConnectionName(name);
  const query = getNodeSqliteKysely<PersonalConnectionDatabase>(db);
  if (value === null) {
    executeSqliteQuerySync(
      db,
      query
        .deleteFrom("secret_store_entries")
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where("name", "=", name),
    );
    return;
  }
  validateValue(value);
  ensureSecretStoreSchema(db);
  const now = Date.now();
  const values = {
    value,
    updated_by: null,
    kind: "secret",
    allowed_hosts: null,
    deleted_at_ms: null,
    updated_at_ms: now,
  };
  executeSqliteQuerySync(
    db,
    query
      .insertInto("secret_store_entries")
      .values({ scope_kind: "identity", scope_id: profileId, name, ...values, created_at_ms: now })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(values),
      ),
  );
  registerSecretValueForRedaction(value);
}
