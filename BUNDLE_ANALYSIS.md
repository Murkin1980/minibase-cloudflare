# Bundle Delta Honesty — CP-06 v7 (second review + fix 2)

Baseline (pre-CP-06): 95.70 KiB / gzip 20.81 KiB

Current (post-CP-06 second-review fix 2): 126.95 KiB / gzip 26.46 KiB

Delta: +31.25 KiB (+5.65 KiB gzip)

Metafile analysis (wrangler deploy --dry-run --outdir /tmp/bundle --metafile):
- src/project-schema.ts 32419 bytes (v7 verification, split verifiers, duplicate-column handling, authoritative publication)
- src/index.ts 17845 bytes
- src/record-query.ts 15639 bytes
- src/commands.ts 11671 bytes
- src/project-quotas.ts 10866 bytes
- src/files-api.ts ~9867 bytes
- src/artifact-api.ts ~8200 bytes (explicit ReadableStream cancel, overflow via stream error, no unconditional delete)
- src/file-hash.ts ~5600 bytes (explicit ReadableStream pull/cancel, not TransformStream.cancel)
- src/provision.ts 7029 bytes
- src/file-reconciliation.ts 6373 bytes

Total bundle: 130k bytes (126.95 KiB) / gzip 26.46 KiB (wrangler 4.114.0)

Optimizations:
- file-hash.ts uses only workerd crypto.DigestStream, no Node fallback, no buffering; explicit ReadableStream pull/cancel handles downstream cancel (R2 412) and source errors, proves O(chunk)
- No test-only code bundled (test-harness polyfill, *test.ts not in metafile inputs)
- Shared hashing, centralized artifactObjectKey, split verifiers

Honesty note: Delta larger than initial 118.21 KiB estimate due to second-review authoritative publication gate (+~15 KiB) and explicit ReadableStream lifecycle (+~1.7 KiB) to fix TransformStream.cancel non-standard and concurrent oversized race. Without verification+cancel handling bundle would be ~110 KiB but would violate CP-06 correctness (inconsistent_schema_state, unhandledRejection, concurrent orphan). Metafile reproducible via `npx wrangler deploy --dry-run --outdir /tmp/bundle --metafile --config wrangler.example.jsonc`.
