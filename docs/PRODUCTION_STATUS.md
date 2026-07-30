# Production status

Last verified: 2026-07-30

## Active resources

- Worker: `minibase-cloudflare`
- URL: `https://minibase-cloudflare.muriktl.workers.dev`
- Control D1: `minibase-control` (`3eeda905-1d62-4637-a9d3-80f37c218bd6`, EEUR)
- R2 Standard bucket: `minibase-files`
- Rate limit: namespace `22001`, 120 calls per 60 seconds per hashed identity
  and route class
- Worker secret `CLOUDFLARE_D1_API_TOKEN`: configured

All six control migrations are applied. Health, response security headers, a
generated correlation ID, unauthenticated rejection, and authenticated
management audit access were verified against the deployed Worker.

## Remaining launch blockers

- Provision one explicitly approved pilot project and verify its D1/file
  isolation before connecting an application.

The primary management key was issued once and only its SHA-256 is stored in D1.
The initially lost management key was revoked and replaced. Only the replacement
key hash is active in D1. Loss of its raw value requires another audited rotation.

Run the authenticated smoke without putting the key in command history:

```powershell
$env:MINIBASE_MANAGEMENT_KEY = Read-Host "Management key"
npm.cmd run smoke:production
Remove-Item Env:MINIBASE_MANAGEMENT_KEY
```

Last authenticated smoke: passed on 2026-07-29, service version `0.22.1`.

Onboarding regression note: version `0.22.2` permits approved project slugs
starting with an ASCII digit, including `1c-tutor-kz`. Deployment and
post-deployment smoke must pass before provisioning resumes.
