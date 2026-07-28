# Agent instructions

MiniBase is a standalone Cloudflare backend platform.

- Never expose `mb_secret_*`, `mb_management_*` or Cloudflare API tokens to a browser.
- Use a separate D1 database per project.
- All provisioning operations must be idempotent and audited.
- Store only hashes of secret and management API keys.
- Do not deploy or create paid resources without the owner's explicit approval.
- A Supabase migration must include export manifest, checksums, verification and rollback.
- Run lint, typecheck and tests before commit or deployment.
