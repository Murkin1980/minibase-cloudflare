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
