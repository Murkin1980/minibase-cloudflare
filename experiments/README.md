# MiniBase experiments

This directory contains bounded experiments that may strengthen MiniBase or its adjacent data/memory capabilities without changing MiniBase's production architecture by default.

## Active

### TencentDB Agent Memory

- Decision: `EXPERIMENT`
- Path: [`tencentdb-agent-memory/`](./tencentdb-agent-memory/)
- Upstream: https://github.com/TencentCloud/TencentDB-Agent-Memory
- Goal: test whether a clean agent session can resume a real MPE project with materially less manual context reconstruction.
- Boundary: no new repository, no production dependency, no replacement of MiniBase, and no new source of truth.
- Canonical identity rule: MiniBase/MPE identifiers remain canonical; TencentDB Agent Memory may only hold/reference representations keyed by those identifiers.
- Promotion gate: only consider integration after the experiment produces measurable benefit and no identity/source-of-truth conflict.
