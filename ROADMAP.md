# MiniBase roadmap

```text
MB0/1 Foundation     [##########] 100%
MB2 Control plane   [##########] 100%
MB3 Data plane      [##########] 100%
MB4 R2 files        [##########] 100%
MB5 Supabase move   [##########] 100%
MB6 Client SDK      [##########] 100%
MB7 Hardening       [##########] 100%
MB8 Launch          [########--]  80%

Overall             [##########]  99%
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
- MB8: Worker, control D1, R2 Standard, rate limiter, migrations, and public
  smoke tests are complete. D1 provisioning token, authenticated management
  smoke, and an approved pilot project remain.
