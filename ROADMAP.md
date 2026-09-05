# MiniBase roadmap

```text
MB0/1 Foundation     [##########] 100%
MB2 Control plane   [##########] 100%
MB3 Data plane      [##########] 100%
MB4 R2 files        [##########] 100%
MB5 Supabase move   [##########] 100%
MB6 Client SDK      [##########] 100%
MB7 Hardening       [##########] 100%
MB8 Launch          [##########] 100%
MB9 vNext upgrade   [###-------]  30%   CP-03 of 10

Overall             [##########] 100%
```

## Gates

- MB2: complete locally; no production verification.
- MB3: complete for local acceptance; outbound calls to a real project D1 remain
  intentionally unverified until production resources are approved.
- MB4: complete for local acceptance; real R2 and project-D1 outbound behavior
  remains intentionally unverified without approved production-like resources.
- MB5: complete for local acceptance: export manifest, deterministic transforms,
  safe Auth handoff, idempotent imports, verification, and rollback evidence.
  No real Supabase or Cloudflare migration has been executed.
- MB6: locally accepted typed records/files client with strict key separation.
- MB7: locally accepted response security and optional hashed-identity abuse
  control. Production binding values still require owner approval.
- MB8: production infrastructure, secrets, migrations, public smoke, and
  authenticated management smoke are complete. Pilot projects are independent
  onboarding decisions.
- MB9: reusing MiniBase as a data platform for the whole MPE ecosystem. Scoped
  in `docs/SCALABILITY.md` as ten checkpoints (CP-01…CP-10). CP-01 (foundation
  hardening), CP-02 (schema version authority & verification), and CP-03 (project
  isolation: per-project quotas, per-route rate periods, fail-closed project
  context) are complete locally; they are backward compatible and add no paid
  resource. Deployment remains a separate owner-approved step.
