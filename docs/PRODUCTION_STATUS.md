# Production status

Last verified: 2026-07-29

## Active resources

- Worker: `minibase-cloudflare`
- URL: `https://minibase-cloudflare.muriktl.workers.dev`
- Control D1: `minibase-control` (`3eeda905-1d62-4637-a9d3-80f37c218bd6`, EEUR)
- R2 Standard bucket: `minibase-files`
- Rate limit: namespace `22001`, 120 calls per 60 seconds per hashed identity
  and route class

All six control migrations are applied. Health, response security headers, a
generated correlation ID, and unauthenticated rejection were verified against
the deployed Worker.

## Remaining launch blockers

- Create a narrowly scoped Cloudflare API token with Account D1 Edit access.
- Store it interactively as Worker secret `CLOUDFLARE_D1_API_TOKEN`; never paste
  it into Git, chat, command arguments, client configuration, or logs.
- Run an authenticated management smoke request from a trusted secret-aware
  client.
- Provision one explicitly approved pilot project and verify its D1/file
  isolation before connecting an application.

The primary management key was issued once and only its SHA-256 is stored in D1.
Loss of the raw key requires an audited bootstrap/rotation procedure.
