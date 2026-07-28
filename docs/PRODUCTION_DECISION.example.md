# MiniBase production decision

Copy this file outside the repository's tracked secrets and complete it before
launch.

- Decision date: `YYYY-MM-DD`
- Owner: `REQUIRED`
- Production deployment approved: `yes/no`
- Cloudflare account and expected billing reviewed: `yes/no`
- Control D1 creation approved: `yes/no`
- Shared R2 bucket creation approved: `yes/no`
- Worker deployment approved: `yes/no`
- Rate-limit binding and values approved: `yes/no`
- Initial consuming project approved: `yes/no`
- Maintenance window: `REQUIRED`
- Rollback owner: `REQUIRED`

Approval authorizes only the explicitly checked resources and window. It does
not authorize copying Cloudflare, management, or secret keys into clients.
