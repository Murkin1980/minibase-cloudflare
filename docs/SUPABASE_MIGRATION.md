# Supabase to MiniBase migration

Every migration is an immutable package described by
`migration-manifest.schema.json`. Data tables use UTF-8 NDJSON (one JSON object
per line); small metadata documents may use JSON.

The manifest records byte length, row count where applicable, and SHA-256 for
every file. Generate checksum records offline:

```bash
npm run migration:checksum -- tables/lessons.ndjson
```

Supabase project refs are represented only by SHA-256 in the manifest. Service
role keys, database passwords, JWT secrets, sessions, refresh tokens, and raw or
hashed user passwords must never be included.

Auth migration supports only:

- `password-reset`: import identity/profile metadata, then users establish a new
  MiniBase password through a verified reset flow;
- `dual-auth-handoff`: temporarily verify credentials against the existing
  Supabase Auth service server-side and establish a new MiniBase credential
  after successful authentication.

Both strategies avoid manually copying `auth.users.encrypted_password`.

### Auth identity export

The sanitizer allowlists only source user UUID, normalized email/phone,
confirmation timestamp, creation timestamp, and required handoff action. It
does not copy `encrypted_password`, access/refresh/recovery/confirmation tokens,
sessions, OTPs, secrets, `user_metadata`, or `app_metadata`.

`user_metadata` is never used for authorization because it is user-editable.
Application profile tables and authorization assignments require separate,
explicit transforms and review.

Password-reset identities remain unable to authenticate until a future verified
reset flow establishes a new MiniBase credential. Dual-auth handoff requires a
fresh, server-verified Supabase authentication event; possession of an exported
row is never accepted as proof.

## PostgreSQL to SQLite transform

Migration uses a declarative catalog export rather than executing a raw
PostgreSQL dump. Identifiers must match a strict allowlist and are always quoted.
Common mappings include UUID/text→TEXT, integer types→INTEGER,
boolean→INTEGER with a check, JSON/JSONB→TEXT with `json_valid`, and bytea→BLOB.

Arrays are stored as JSON text. Numeric/decimal emits a precision warning.
Unsupported types such as `tsvector`, Postgres functions, triggers, generated
defaults, RLS policies, and extensions stop transformation or appear as explicit
warnings; they are never silently executed as SQLite.

### Offline table import

Each table is exported as UTF-8 NDJSON with one complete object per line. Before
any SQL is generated, MiniBase verifies the manifest byte length, SHA-256, row
count, exact column set, supported value types, and a single primary key.

The importer builds one atomic D1 batch: create and clear a deterministic
staging table, insert transformed rows with bound parameters, upsert them into
the destination table, record the file checksum in `mb_migration_imports`, and
drop staging. A completed file with the same checksum and row count is skipped.
A changed file under the same migration ID and path is rejected as a conflict.

The import contract never executes SQL embedded in NDJSON and never derives
identifiers from row values. The transformed destination schema must be reviewed
and applied before its table data batch.
