# MiniBase roadmap

```text
MB0/1 Foundation     [##########] 100%
MB2 Control plane   [##########] 100%
MB3 Data plane      [##########] 100%
MB4 R2 files        [##########] 100%
MB5 Supabase move   [####------]  40%
MB6 Client SDK      [----------]   0%
MB7 Hardening       [----------]   0%
MB8 Launch          [----------]   0%

Overall             [#######---]  68%
```

## Gates

- MB2: complete locally; no production verification.
- MB3: complete for local acceptance; outbound calls to a real project D1 remain
  intentionally unverified until production resources are approved.
- MB4: complete for local acceptance; real R2 and project-D1 outbound behavior
  remains intentionally unverified without approved production-like resources.
- MB5: manifest/checksums and deterministic PostgreSQL→SQLite transform defined;
  import execution, Auth handoff, verification, and rollback remain.
- MB8: requires an explicit owner decision before any production resource is
  created.
