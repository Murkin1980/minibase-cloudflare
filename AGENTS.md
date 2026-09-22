<!-- MPE:SCOPE-CHANGE-CONTROL:START -->
## Mandatory first read — MPE Scope & Change Control

Before planning, coding, refactoring, dependency changes, testing strategy, deployment, or checkpoint execution, read:

- `docs/governance/SCOPE-CHANGE-CONTROL.md`

Read it before project-specific source-of-truth documents. Then follow this repository's local rules and the current checkpoint/spec.

The scope policy governs minimal change, reuse, checkpoint boundaries, deep-change, testing, evidence, merge/deploy authority, and stopping conditions.

If a local rule appears to conflict with the scope policy, apply the documented source-of-truth priority. Do not silently weaken either rule; surface a deep-change conflict when required.
<!-- MPE:SCOPE-CHANGE-CONTROL:END -->

# Agent instructions

MiniBase is a standalone Cloudflare backend platform.

- Never expose `mb_secret_*`, `mb_management_*` or Cloudflare API tokens to a browser.
- Use a separate D1 database per project.
- All provisioning operations must be idempotent and audited.
- Store only hashes of secret and management API keys.
- Do not deploy or create paid resources without the owner's explicit approval.
- A Supabase migration must include export manifest, checksums, verification and rollback.
- Run lint, typecheck and tests before commit or deployment.
