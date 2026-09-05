import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { validateCollection, validateRecordData, validateRecordId } from "./data-api";
import { queryProjectD1 } from "./d1-http";
import { decideIdempotentReplay, fingerprintRequest } from "./idempotency";
import { sha256 } from "./security";

/** The only CP-05 command type. This is intentionally not a command DSL. */
export const RECORDS_UPSERT_MANY_COMMAND_TYPE = "records:upsert-many";

/**
 * v6 installs this exact static trigger. The command statement checks that both
 * its authoritative schema-version row and trigger are present before it can
 * insert a marker. That makes an interrupted v6 migration fail closed without
 * adding a separate project-D1 schema preflight round trip.
 */
export const RECORDS_UPSERT_MANY_TRIGGER_NAME = "mb_commands_records_upsert_many_apply";
export const RECORDS_UPSERT_MANY_SCHEMA_VERSION = 6;

export interface RecordsUpsertManyOperation {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

/** Validated and canonicalized command input. Operation order is intentional. */
export interface RecordsUpsertManyCommand {
  operations: RecordsUpsertManyOperation[];
}

export interface RecordsUpsertManyRecordRef {
  collection: string;
  id: string;
}

/** The response persisted in `mb_commands.response_json`; it deliberately has no replay flag. */
export interface PersistedRecordsUpsertManyResponse {
  commandId: string;
  status: "applied";
  operationCount: number;
  records: RecordsUpsertManyRecordRef[];
}

export interface RecordsUpsertManyResponse extends PersistedRecordsUpsertManyResponse {
  replayed: boolean;
}

interface StoredCommandRow {
  command_id: string;
  request_fingerprint: string;
  response_json: string;
  status: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const commandFields = ["operations"] as const;
const operationFields = ["collection", "id", "data"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((field) => !allowed.includes(field))) throw new Error("invalid_command");
}

/**
 * Recursively canonicalizes JSON object keys. Arrays deliberately retain their
 * order: the order of command operations is part of the idempotency contract.
 * A null-prototype result prevents a JSON `__proto__` field from changing the
 * prototype while it is being canonicalized.
 */
function canonicalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_record_data");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!isObject(value)) throw new Error("invalid_record_data");

  const canonical = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalizeJson(value[key]);
  return canonical;
}

function validateCommandCollection(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_collection");
  const collection = validateCollection(value);
  // `mb_` is reserved for MiniBase's physical/internal namespace. Existing
  // legacy record routes stay untouched; the new command surface never accepts
  // an internal-looking logical collection.
  if (collection.startsWith("mb_")) throw new Error("invalid_collection");
  return collection;
}

function validateCommandRecordId(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_record_id");
  return validateRecordId(value);
}

/**
 * Parses before hashing. Unknown fields, duplicate targets, invalid identifiers,
 * non-object data, and excessive operation counts fail before project D1 is
 * contacted. The returned object has a deterministic object-key order.
 */
export function parseRecordsUpsertManyCommand(
  value: unknown,
  maxBulkRecords: number,
): RecordsUpsertManyCommand {
  if (!isObject(value)) throw new Error("invalid_command");
  rejectUnknownFields(value, commandFields);
  if (!Array.isArray(value.operations) || value.operations.length === 0) throw new Error("invalid_command");
  if (!Number.isInteger(maxBulkRecords) || maxBulkRecords < 1) throw new Error("invalid_command");
  if (value.operations.length > maxBulkRecords) throw new Error("bulk_limit_exceeded");

  const targets = new Set<string>();
  const operations = value.operations.map((candidate): RecordsUpsertManyOperation => {
    if (!isObject(candidate)) throw new Error("invalid_command");
    rejectUnknownFields(candidate, operationFields);
    const collection = validateCommandCollection(candidate.collection);
    const id = validateCommandRecordId(candidate.id);
    const data = validateRecordData(candidate.data);
    const canonicalData = canonicalizeJson(data);
    if (!isObject(canonicalData)) throw new Error("invalid_record_data");

    const target = `${collection}\u0000${id}`;
    if (targets.has(target)) throw new Error("invalid_command");
    targets.add(target);
    return { collection, id, data: canonicalData };
  });

  return { operations };
}

/** The one canonical payload persisted in v6 and included in the request fingerprint. */
export function normalizedRecordsUpsertManyPayload(input: RecordsUpsertManyCommand): RecordsUpsertManyCommand {
  return {
    operations: input.operations.map((operation) => ({
      collection: operation.collection,
      id: operation.id,
      data: operation.data,
    })),
  };
}

/**
 * The fingerprint is project-scoped even though uniqueness is also naturally
 * scoped by the one-D1-per-project architecture. Keeping the project and static
 * command type in this fixed-order value makes the binding explicit.
 */
export async function recordsUpsertManyFingerprint(
  projectId: string,
  input: RecordsUpsertManyCommand,
): Promise<string> {
  return fingerprintRequest({
    projectId,
    commandType: RECORDS_UPSERT_MANY_COMMAND_TYPE,
    payload: normalizedRecordsUpsertManyPayload(input),
  });
}

function persistedResponse(commandId: string, input: RecordsUpsertManyCommand): PersistedRecordsUpsertManyResponse {
  return {
    commandId,
    status: "applied",
    operationCount: input.operations.length,
    records: input.operations.map(({ collection, id }) => ({ collection, id })),
  };
}

function parsePersistedResponse(
  value: string,
  commandId: string,
): PersistedRecordsUpsertManyResponse {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed) || parsed.commandId !== commandId || parsed.status !== "applied" ||
      !Number.isInteger(parsed.operationCount) || (parsed.operationCount as number) < 1 ||
      !Array.isArray(parsed.records) || parsed.records.length !== parsed.operationCount) {
      throw new Error("invalid stored command response");
    }
    const records = parsed.records.map((record): RecordsUpsertManyRecordRef => {
      if (!isObject(record) || typeof record.collection !== "string" || typeof record.id !== "string") {
        throw new Error("invalid stored command response");
      }
      return { collection: record.collection, id: record.id };
    });
    return {
      commandId,
      status: "applied",
      operationCount: parsed.operationCount as number,
      records,
    };
  } catch {
    // A command marker is internal project-D1 state. Never reflect a malformed
    // stored response or its contents to a caller.
    throw new Error("cloudflare_api_error");
  }
}

/**
 * Exactly one project-D1 statement for execute, replay, and conflict attempts.
 *
 * - The `SELECT ... WHERE EXISTS` predicates are an in-statement readiness
 *   guard, not a schema preflight. They require the authoritative v6 version row
 *   and the static trigger name. A partial migration with the table but without
 *   the trigger returns no row and therefore cannot write a marker.
 * - `ON CONFLICT ... DO UPDATE` returns the existing marker without changing
 *   any persisted value. Because the trigger is AFTER INSERT, it runs only for
 *   a genuinely new marker and never on replay or conflict.
 */
export const recordsUpsertManyStatement = `INSERT INTO mb_commands
  (command_id, command_type, idempotency_key_hash, request_fingerprint,
   normalized_payload, response_json, status, created_at, completed_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
 WHERE EXISTS (
   SELECT 1 FROM mb_schema_versions WHERE version = ${RECORDS_UPSERT_MANY_SCHEMA_VERSION}
 )
   AND EXISTS (
     SELECT 1 FROM sqlite_master
      WHERE type = 'trigger' AND name = '${RECORDS_UPSERT_MANY_TRIGGER_NAME}'
   )
ON CONFLICT(command_type, idempotency_key_hash) DO UPDATE SET
  command_id = mb_commands.command_id
RETURNING command_id, request_fingerprint, response_json, status`;

/**
 * Executes the only CP-05 command. The raw idempotency key is parsed by the
 * route before this function and is never persisted or returned; only its
 * SHA-256 digest is stored as opaque data in the project D1.
 */
export async function executeRecordsUpsertMany(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  idempotencyKey: string,
  input: RecordsUpsertManyCommand,
): Promise<RecordsUpsertManyResponse> {
  const commandId = crypto.randomUUID();
  const now = new Date().toISOString();
  const normalizedPayload = normalizedRecordsUpsertManyPayload(input);
  const [idempotencyKeyHash, requestFingerprint] = await Promise.all([
    sha256(idempotencyKey),
    recordsUpsertManyFingerprint(principal.projectId, normalizedPayload),
  ]);
  const storedResponse = persistedResponse(commandId, normalizedPayload);

  const result = await queryProjectD1<StoredCommandRow>(
    env,
    principal.databaseId,
    recordsUpsertManyStatement,
    [
      commandId,
      RECORDS_UPSERT_MANY_COMMAND_TYPE,
      idempotencyKeyHash,
      requestFingerprint,
      JSON.stringify(normalizedPayload),
      JSON.stringify(storedResponse),
      "completed",
      now,
      now,
    ],
  );
  const stored = result.results[0];
  if (!stored) {
    // The query itself was successful, but v6's authoritative version marker
    // and/or trigger was absent. No INSERT was selected, so no marker or record
    // mutation happened. A missing table still surfaces as cloudflare_api_error
    // through queryProjectD1, because it cannot be safely distinguished here.
    throw new Error("command_schema_not_ready");
  }
  if (stored.status !== "completed" || typeof stored.command_id !== "string" ||
    typeof stored.request_fingerprint !== "string" || typeof stored.response_json !== "string") {
    throw new Error("cloudflare_api_error");
  }

  // The RETURNING marker ID is the single-statement state signal. A marker
  // created by this attempt has no *prior* fingerprint, so the shared primitive
  // correctly calls it `execute`; an existing marker is then replay or conflict.
  const fresh = stored.command_id === commandId;
  const decision = decideIdempotentReplay(
    fresh ? null : stored.request_fingerprint,
    requestFingerprint,
  );
  if (decision === "conflict") throw new Error("idempotency_conflict");
  if ((fresh && decision !== "execute") || (!fresh && decision !== "replay")) {
    throw new Error("cloudflare_api_error");
  }

  const response = parsePersistedResponse(stored.response_json, stored.command_id);
  return {
    ...response,
    replayed: !fresh,
  };
}
