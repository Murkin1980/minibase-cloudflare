# TencentDB Agent Memory experiment

Status: PLANNED  
Decision: **EXPERIMENT**  
Host repository: `minibase-cloudflare`  
Upstream: https://github.com/TencentCloud/TencentDB-Agent-Memory

## Why this belongs here

TencentDB Agent Memory is being evaluated as an optional memory/intelligence layer adjacent to MiniBase, not as a replacement database and not as a separate MPE platform.

The current hypothesis is that persistent agent memory can reduce repeated context reconstruction between ChatGPT, Arena/Codex, Harness, and other coding-agent sessions while MiniBase/MPE remains authoritative for canonical project identities and approved project state.

## Experiment question

Can a fresh coding-agent session continue work on an existing MPE project correctly, with materially less manually repeated context, after prior project/session information has been stored through TencentDB Agent Memory?

## Minimal scope

Use one existing real project as the test subject. Prefer `murat-ai-orchestrator` or `ai-microtask-factory`; do not create a synthetic product or a new repository for the trial.

The experiment should test only:

1. ingestion of bounded prior session/project context;
2. retrieval in a clean agent session;
3. recovery of the current checkpoint/status and key constraints;
4. recovery of at least one prior architectural or operational decision;
5. resistance to inventing a conflicting parallel architecture or duplicate identity.

Do not integrate TencentDB Agent Memory into MiniBase production paths during this experiment.

## Invariants

- MiniBase/MPE remains the source of truth for canonical project/object identifiers.
- One object keeps one canonical identity across systems.
- TencentDB Agent Memory must not mint a competing identity for an existing MPE object.
- No existing MiniBase storage contract, API contract, D1/R2 layout, or security boundary changes in the experiment.
- No paid or production infrastructure is created without explicit owner approval.
- No new repository is created.
- The experiment must remain reversible by deleting this experiment directory/configuration only.

## Measurement

Capture a baseline and a memory-assisted run using the same bounded continuation task.

Measure:

- manual context supplied to the new session;
- whether project/checkpoint/status are recovered correctly;
- whether key constraints are recovered correctly;
- whether prior decisions are recovered with sufficient provenance;
- number of contradictory or invented project facts;
- time/steps spent rediscovering context;
- setup and operational complexity introduced by the memory layer.

## PASS

PASS only if all of the following are true:

- the fresh session recovers the correct project and current checkpoint/status;
- it recovers the selected prior decision and important constraints without owner re-teaching;
- it does not create a duplicate canonical project/object identity;
- it does not propose a conflicting parallel architecture as if it were already approved;
- manual context reconstruction is materially lower than the baseline;
- the operational burden is small enough to justify another integration checkpoint.

## FAIL / HOLD

FAIL or HOLD if any of these occur:

- retrieved memory is stale enough to misdirect execution;
- provenance is insufficient to distinguish approved state from historical discussion;
- identity/source-of-truth duplication appears;
- setup or maintenance cost outweighs the observed reduction in repeated context;
- the experiment requires a deep MiniBase architecture change to demonstrate basic value.

## Promotion gate

A successful experiment does **not** authorize production integration.

Before any production integration, run the New Idea Filter again and define a separate owner-approved checkpoint covering:

- integration boundary;
- canonical ID mapping;
- write/read authority;
- retention/deletion behavior;
- security and tenant isolation;
- cost;
- rollback;
- whether MiniBase, the orchestrator, or another existing component should own the adapter.

Until then, TencentDB Agent Memory remains experimental only.
