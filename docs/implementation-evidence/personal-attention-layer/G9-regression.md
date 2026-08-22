# G9 automated regression evidence

Status: **PASS — automated regression packet; G9 gate remains pending**  
Date: 2026-08-21  
Baseline HEAD: `40f5297250cfd214d7fbac2639c013228044e56d`  
Resulting supported schema head: `26`

This receipt records the final automated workspace regression after the
schema-026, C90b and W90 implementation was present in the shared worktree. It
does not claim a live rollout, touch the user's loaded test runtime, or replace
the pending G9 product and migration receipts listed below.

## Exact root verification

```text
corepack pnpm test
2,435/2,435 tests PASS
exit code 0

corepack pnpm typecheck
exit code 0

corepack pnpm build
exit code 0

git diff --check
exit code 0
```

The server package now uses the stable bounded command
`vitest run --maxWorkers=2` through `packages/server/package.json`. Therefore
the root `corepack pnpm test` command exercises server tests with at most two
workers while preserving the ordinary one-command workspace gate. This bounds
Windows process/SQLite contention; it does not skip or quarantine a test.

## Schema-26 test modernization

The full green run includes test-only modernization required after installing
schema 26:

- default feature projections explicitly include `privacyPurge:false`;
- health and migration fixtures expect schema `26`, and schema-object
  inventories include the generated schema-26 purge fences;
- intentional raw/secondary SQLite writers enable `foreign_keys` and
  `recursive_triggers` and install the same connection-local purge
  authorization/intent functions before preparing guarded statements;
- deliberate corruption fixtures remove both the legacy immutability guard and
  the exact schema-26 fence where corruption is the purpose of the test;
- migration-heavy tests use bounded explicit timeouts appropriate to the extra
  schema migration instead of relying on the old five-second default.

These corrections are confined to tests/test helpers and the server test-runner
worker bound. They do not weaken production mutation fences or add a bypass to
production code. Focused serial verification of the two residual modernization
packets also passed:

```text
schema-26 migration/legacy partition: 14 files, 104/104 PASS
route/catalog/raw-writer partition:     4 files,  31/31 PASS
server typecheck:                                      PASS
scoped git diff --check:                               PASS
```

The final workspace result supersedes intermediate failures caused by stale
schema-25 expectations, missing connection-local UDFs and the earlier
unbounded Windows two-writer scheduling behavior.

## What this receipt proves

- all workspace test surfaces pass together on the resulting
  schema-26-aware worktree;
- shared, extension, MCP, server and web type contracts compile;
- every package production build completes;
- no whitespace-error diff remains;
- W90's independently accepted focused, integrated, server and MCP sets are
  included in the full result;
- schema-26 production fences remain enabled while legacy tests use accurate
  connection semantics.

## Isolated migration and rollback proof

The follow-up isolated receipt
[`G9-isolated-migration-rollback-receipt.json`](G9-isolated-migration-rollback-receipt.json)
is **PASS**:

- an immutable schema-24 G8 candidate copy migrated to schema 26 with
  `integrity_check=ok`, zero foreign-key violations and no row-count changes in
  any of its 122 existing tables;
- a fresh database opened directly at schema 26 with `integrity_check=ok` and
  zero foreign-key violations;
- an isolated feature-off schema-26 server started on port 7796, returned
  healthy schema-26 status and a successful Library read, advertised research,
  Resources, live acquisition and privacy purge as disabled, then stopped with
  its exact PID and port closed;
- the rollback-smoke database hash was identical before and after the process,
  and tracked AI-job, live-action, purge-intent, purge-command and research-run
  counts remained zero.

This used only disposable files under `.tmp/personal-attention-layer/` and did
not read or modify the user's current live database or loaded runtime.

## Required evidence still pending

Automated regression is necessary but insufficient for `PASS(G9)`. The
following are explicitly **PENDING**:

1. **Live J3:** a real public-HTTPS, public-A, same-Resource missing page must be
   acquired through actual server egress, materialized, handed off immutably and
   cited by a successful final G8 dossier. Localhost, mocks and captured-only
   substitution do not satisfy this requirement.
2. **Network/live receipt:** the real candidate must record safe counters and
   provenance, while the synthetic negative matrix remains supporting evidence
   rather than proof of the public leg.
3. **Extension session:** reload the frozen extension, perform exact physical-tab
   captured-only fallback, and record exact pre/post window/tab identities and
   counts proving no tab or window mutation.
4. **UAT:** the user must select a personally relevant Resource and accept either
   a live success or a typed limitation followed by successful exact-tab
   captured-only fallback.

No deployment or UAT waiver is recorded here. A deployment waiver belongs to
Final/R99 before any rollout attempt and cannot waive G9 live J3, safety,
migration or extension evidence. Until the pending receipts are complete,
`G9.md` must remain absent or carry a non-PASS verdict and Final cannot start.
