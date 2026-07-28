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

## PostgreSQL to SQLite transform

Migration uses a declarative catalog export rather than executing a raw
PostgreSQL dump. Identifiers must match a strict allowlist and are always quoted.
Common mappings include UUID/text→TEXT, integer types→INTEGER,
boolean→INTEGER with a check, JSON/JSONB→TEXT with `json_valid`, and bytea→BLOB.

Arrays are stored as JSON text. Numeric/decimal emits a precision warning.
Unsupported types such as `tsvector`, Postgres functions, triggers, generated
defaults, RLS policies, and extensions stop transformation or appear as explicit
warnings; they are never silently executed as SQLite.
