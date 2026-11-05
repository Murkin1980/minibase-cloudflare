import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { validateCollection, validateRecordData, validateRecordId } from "./data-api";
import { queryProjectD1 } from "./d1-http";
import { decideIdempotentReplay, fingerprintRequest } from "./idempotency";
import { sha256 } from "./security";

/** A deliberately narrow server-only command: allocate one sequence and create one record. */
export const RECORDS_ALLOCATE_SEQUENCE_COMMAND_TYPE = "records:allocate-sequence";
export const RECORDS_ALLOCATE_SEQUENCE_TRIGGER_NAME = "mb_sequence_commands_allocate_apply";
export const RECORDS_ALLOCATE_SEQUENCE_SCHEMA_VERSION = 8;

export interface RecordsAllocateSequenceCommand {
  counter: { collection: string; id: string };
  record: { collection: string; id: string; data: Record<string, unknown> };
  sequenceField: string;
  prefix: string;
}

export interface RecordsAllocateSequenceResponse {
  commandId: string;
  status: "applied";
  record: { collection: string; id: string };
  replayed: boolean;
}

interface StoredRow { command_id: string; request_fingerprint: string; response_json: string; status: string; }
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const fieldPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("invalid_record_data"); return value; }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) throw new Error("invalid_record_data");
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}
function collection(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_collection");
  const result = validateCollection(value);
  if (result.startsWith("mb_")) throw new Error("invalid_collection");
  return result;
}
function id(value: unknown): string { if (typeof value !== "string") throw new Error("invalid_record_id"); return validateRecordId(value); }

export function parseRecordsAllocateSequenceCommand(value: unknown): RecordsAllocateSequenceCommand {
  if (!isObject(value) || Object.keys(value).some((key) => !["counter", "record", "sequenceField", "prefix"].includes(key))) throw new Error("invalid_command");
  if (!isObject(value.counter) || Object.keys(value.counter).some((key) => !["collection", "id"].includes(key))) throw new Error("invalid_command");
  if (!isObject(value.record) || Object.keys(value.record).some((key) => !["collection", "id", "data"].includes(key))) throw new Error("invalid_command");
  const counter = { collection: collection(value.counter.collection), id: id(value.counter.id) };
  const canonicalData = canonicalize(validateRecordData(value.record.data));
  if (!isObject(canonicalData)) throw new Error("invalid_record_data");
  const record = { collection: collection(value.record.collection), id: id(value.record.id), data: canonicalData as Record<string, unknown> };
  if (counter.collection === record.collection && counter.id === record.id) throw new Error("invalid_command");
  if (typeof value.sequenceField !== "string" || !fieldPattern.test(value.sequenceField)) throw new Error("invalid_command");
  if (typeof value.prefix !== "string" || value.prefix.length > 128) throw new Error("invalid_command");
  return { counter, record, sequenceField: value.sequenceField, prefix: value.prefix };
}

export async function recordsAllocateSequenceFingerprint(projectId: string, input: RecordsAllocateSequenceCommand): Promise<string> {
  return fingerprintRequest({ projectId, commandType: RECORDS_ALLOCATE_SEQUENCE_COMMAND_TYPE, payload: input });
}

export const recordsAllocateSequenceStatement = `INSERT INTO mb_sequence_commands
  (command_id, command_type, idempotency_key_hash, request_fingerprint, normalized_payload, response_json, status, created_at, completed_at)
SELECT ?, ?, ?, ?, ?, ?, 'completed', ?, ?
 WHERE EXISTS (SELECT 1 FROM mb_schema_versions WHERE version = ${RECORDS_ALLOCATE_SEQUENCE_SCHEMA_VERSION})
   AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = '${RECORDS_ALLOCATE_SEQUENCE_TRIGGER_NAME}')
ON CONFLICT(command_type, idempotency_key_hash) DO UPDATE SET command_id = mb_sequence_commands.command_id
RETURNING command_id, request_fingerprint, response_json, status`;

function parseResponse(value: string, commandId: string): Omit<RecordsAllocateSequenceResponse, "replayed"> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed) || parsed.commandId !== commandId || parsed.status !== "applied" || !isObject(parsed.record) || typeof parsed.record.collection !== "string" || typeof parsed.record.id !== "string") throw new Error("invalid");
    return { commandId, status: "applied", record: { collection: parsed.record.collection, id: parsed.record.id } };
  } catch { throw new Error("cloudflare_api_error"); }
}

export async function executeRecordsAllocateSequence(env: MiniBaseEnv, principal: DataPrincipal, idempotencyKey: string, input: RecordsAllocateSequenceCommand): Promise<RecordsAllocateSequenceResponse> {
  const commandId = crypto.randomUUID();
  const now = new Date().toISOString();
  const [keyHash, fingerprint] = await Promise.all([sha256(idempotencyKey), recordsAllocateSequenceFingerprint(principal.projectId, input)]);
  const response = { commandId, status: "applied", record: { collection: input.record.collection, id: input.record.id } };
  const result = await queryProjectD1<StoredRow>(env, principal.databaseId, recordsAllocateSequenceStatement, [commandId, RECORDS_ALLOCATE_SEQUENCE_COMMAND_TYPE, keyHash, fingerprint, JSON.stringify(input), JSON.stringify(response), now, now]);
  const stored = result.results[0];
  if (!stored) throw new Error("command_schema_not_ready");
  if (stored.status !== "completed" || typeof stored.command_id !== "string" || typeof stored.request_fingerprint !== "string" || typeof stored.response_json !== "string") throw new Error("cloudflare_api_error");
  const fresh = stored.command_id === commandId;
  const decision = decideIdempotentReplay(fresh ? null : stored.request_fingerprint, fingerprint);
  if (decision === "conflict") throw new Error("idempotency_conflict");
  if ((fresh && decision !== "execute") || (!fresh && decision !== "replay")) throw new Error("cloudflare_api_error");
  return { ...parseResponse(stored.response_json, stored.command_id), replayed: !fresh };
}
