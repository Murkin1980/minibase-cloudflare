# MiniBase identity and session boundary

Project schema v4 provides native users, one-time activation tokens, active
organization membership, opaque sessions, and append-only authentication audit.
It has no password or external identity-provider dependency.

## Trust model

- Activation and session material is 256-bit random and returned once; only SHA-256 is stored.
- Expiry, revocation, rotation linkage, `auth_version`, and last use are checked server-side.
- Organization and role come from current active membership on every operation.
- `mb_publishable_*` remains read-only; identity/session management is backend-only.
- Password hashes, provider sessions/JWTs, refresh tokens, OTPs, service keys,
  and database credentials have no storage path.

## Pilot activation

A trusted backend creates a pending user and a short-lived, single-use activation
token. The raw token is delivered manually by the owner for the pilot and is
exchanged once for a fresh MiniBase session. No email provider is required.

Schema v4 alone authenticates nobody. Runtime endpoints, atomic activation/session/audit
operations, rate limits, and cross-tenant tests remain mandatory before cutover.
