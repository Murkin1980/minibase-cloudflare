# MiniBase launch runbook

## Before approval

1. Run `npm ci` and `npm run check` from a clean commit.
2. Run `npm run release:readiness`; a blocked result is expected until approval.
3. Review security, migration, SDK, cost, rate-limit, and rollback decisions.
4. Complete `PRODUCTION_DECISION.example.md` without adding credentials to Git.

## Approved maintenance window

Only after explicit owner approval:

1. create the control D1 and R2 bucket;
2. create an untracked `wrangler.jsonc` from the example with exact resource IDs;
3. store the scoped Cloudflare D1 token using Wrangler secrets;
4. apply control migrations in order and create the bootstrap management key;
5. deploy a preview/version, run health and unauthorized smoke tests;
6. provision one approved pilot project idempotently;
7. issue least-privilege, expiring pilot keys and configure exact browser origins;
8. verify audit events, data isolation, file isolation, rate limits, and rollback;
9. promote only the verified version.

## Abort and rollback

Stop on any failed checksum, migration, isolation, audit, or smoke check. Revoke
new keys, freeze writes, restore the recorded D1 bookmark and R2 backup where
applicable, verify the previous manifest, and roll the Worker back to the last
known version. Never print or return Cloudflare tokens during diagnosis.
