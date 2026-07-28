# MiniBase roadmap

```text
MB0/1 Foundation     [##########] 100%
MB2 Control plane   [##########] 100%
MB3 Data plane      [##########] 100%
MB4 R2 files        [#####-----]  50%
MB5 Supabase move   [----------]   0%
MB6 Client SDK      [----------]   0%
MB7 Hardening       [----------]   0%
MB8 Launch          [----------]   0%

Overall             [######----]  56%
```

## Gates

- MB2: complete locally; no production verification.
- MB3: complete for local acceptance; outbound calls to a real project D1 remain
  intentionally unverified until production resources are approved.
- MB4: streaming CRUD, project prefixes, metadata schema, size limits, and upload
  compensation implemented; integration acceptance and reconciliation remain.
- MB8: requires an explicit owner decision before any production resource is
  created.
