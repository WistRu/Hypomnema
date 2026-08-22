# G9 C90a-R2a evidence — direct history epochs and exact-row purge authority

Status: **PASS — independently accepted**

Date: 2026-08-15

Goal: `019ff487-6f70-7d13-a96a-08a131566281`

Schema head: `25`

Live user runtime: intentionally unchanged at schema `24`

## Accepted scope

C90a-R2a corrects the schema/executor boundary exposed by the first real C90b
privacy integration. It changes only:

- `packages/server/migrations/025_live_acquisition.sql`;
- `packages/server/src/live-acquisition-migration.ts`;
- `packages/server/test/live-acquisition-migration.test.ts`.

The accepted packet provides:

1. direct immutable `research_runs.history_epoch_id` membership for Resource
   research, with migration backfill and an in-migration assertion;
2. `NULL` epoch identity for page/selection runs and a strict active matching
   Resource-generation guard for future Resource-run inserts;
3. same-epoch consent and coordinator-to-final handoff enforcement;
4. exact `resource_history` lifecycle closure for zero through N runs, including
   per-generation retirement/detachment and permanent generation plus epoch
   tombstones;
5. post-freeze protection preventing a new run from joining an epoch owned by a
   pending/waiting Resource-history purge;
6. exact equality between the committed `research_runs` deletion rows and the
   frozen lifecycle set, including omission/extra rejection and rollback;
7. runtime aggregate and trigger-digest validation for the frozen deletion
   manifest, with insert/update mutation denied after database opening;
8. predicate re-evaluation immediately before every exact delete and a strict
   maximum of one live one-shot authority at any instant;
9. exact unknown-workflow terminal outcome
   `{superseded, RESEARCH_WORKFLOW_UNSUPPORTED}`, unavailable to known C81/C90
   workflows or mismatched jobs/runs.

R2a intentionally does not add page queue/reservation/capture/adoption schema.
That is the disjoint R2b/R3 frontier.

## Independent rejection and correction loop

The first candidate passed 40 migration tests but was rejected by an independent
read-only audit with `P0/P1/P2/P3=0/3/1/0`. The audit proved:

- an incomplete Resource-history deletion plan could complete while leaving a
  `research_runs` row behind;
- a new same-epoch run could be inserted after a zero-run history command froze
  its lifecycle;
- the deletion-manifest predicate could drift after database opening;
- authorities were batch-created, reaching 21 simultaneously live rows instead
  of one exact authority around one exact delete.

Each finding received a failing regression test before implementation. The
corrected suite has 44 tests and the same auditor returned:

```text
P0/P1/P2/P3/UNVERIFIED = 0/0/0/0/0
verdict = ACCEPT
```

## Frozen implementation

```text
069444a3c3fcab476726766325285c58286c09c6464eba7d921d5334a613e02b  packages/server/migrations/025_live_acquisition.sql
42e28c7b23b6cdec20eae8f4114dbbe19fd9098d633edd79b3919381fa3fbb39  packages/server/src/live-acquisition-migration.ts
e99f66f3f084de927880a6fb1da31af2b7e8de3b266e464ae26eb8e64615d5f5  packages/server/test/live-acquisition-migration.test.ts
```

Line counts at freeze:

```text
4,981  packages/server/migrations/025_live_acquisition.sql
2,903  packages/server/src/live-acquisition-migration.ts
6,093  packages/server/test/live-acquisition-migration.test.ts
```

## Verification

Both the implementer and Root independently ran:

```text
live-acquisition-migration.test.ts: 44/44 PASS
database-migration-ceiling.test.ts:  3/3 PASS
server typecheck:                    PASS
three-file git diff --check:         PASS (line-ending warnings only)
```

The independent auditor re-ran the same focused checks and inspected the exact
correction sites before acceptance.

## Downstream integration state

The frozen C90b code predates mandatory direct epoch identity. Its privacy suite
currently reaches `1/7`: six cases stop in `test/live-research-fixture.ts` before
the purge path because fixture inserts do not yet provide `history_epoch_id`.
This is expected downstream C90b adoption work after the remaining R2b/R3 schema
is accepted; it is not waived and was not counted as an R2a defect.

No live database migration, server restart, tab mutation, stage, commit or push
was performed.
