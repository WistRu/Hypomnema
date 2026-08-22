# G9 C90a-R2b evidence — durable traversal and reservation identity

Status: **PASS — independently accepted**

Date: 2026-08-15

Goal: `019ff487-6f70-7d13-a96a-08a131566281`

Schema head: `25`

Live user runtime: intentionally unchanged at schema `24`

## Accepted scope

R2b keeps migration 025 and changes only the migration, its closed runner and
the migration test. It adds the durable identities required before C90b can own
network execution:

- planned page actions form the durable queue, with at most 1,000 current
  `page/planned` rows per consent;
- planned pages carry depth and discovered-parent lineage but no preterminal
  logical-page generation;
- an immutable page reservation with dense `reservation_sequence` is the only
  atomic page `planned -> resolution_started` seam and enforces `maxPages`;
- reservation requires the exact URL payload first; a missing URL cannot consume
  budget and strand an action;
- remaining planned work may become `blocked/BUDGET_EXHAUSTED` only after the
  reservation cap is actually exhausted, with no reservation/network/body/
  capture/start material;
- a page may complete only after reservation, start, body, active logical-page
  generation, eligible matching ResourceResolution and an exact immutable capture
  manifest with depth and dense `capture_sequence`;
- acquired source receipts bind the exact capture manifest, page generation,
  depth, capture sequence, content digest and canonical manifest;
- immutable provider-reservation adoption rows bind attempt, final job, reserved
  UTC date and adoption time, while allowing legal retry attempts to adopt the
  same final-job reservation;
- page reservations and provider adoptions are exact guarded purge targets;
- `discovered_from_action_id` remains an `ON DELETE RESTRICT` self-FK and the
  executor rejects retained children or parent-before-child exact plans before
  any mutation.

R2b intentionally adds no daily provider accounting, usage coupling, rollover or
terminal remainder release. Those behaviors belong to the serial R3 packet.

## Independent correction loop

The first green candidate was deliberately rejected during read-only audit. The
correction loop found and closed:

1. mutable page reservation identities;
2. an accidental one-adoption-per-reservation restriction that rejected legal
   final-job retries;
3. reservation before URL payload, which could strand a budget-consuming action;
4. caller-asserted `BUDGET_EXHAUSTED` before `maxPages` was actually exhausted;
5. missing direct coverage for a purge plan that targets a parent but retains its
   discovered child;
6. caller-dependent child ordering, replaced by executor validation of the exact
   self-referential plan.

Every finding received an exact negative/rollback test. The final independent
verdict is:

```text
P0/P1/P2/P3/UNVERIFIED = 0/0/0/0/0
verdict = ACCEPT
```

## Frozen implementation

```text
f18f0c8951ef1b090e44347ce80a49b9291fc33beca2f37dea083dffd63a8d2d  packages/server/migrations/025_live_acquisition.sql
a27df96f5a06ce041db7645e709fafba63978d8531195cf714e729b5395c9563  packages/server/src/live-acquisition-migration.ts
4fcb67786f69dc68e0e2a05ad0e21ab9c6c3999bc415c82a11a27ec1fb64c36b  packages/server/test/live-acquisition-migration.test.ts
```

Line counts at freeze:

```text
5,337  packages/server/migrations/025_live_acquisition.sql
2,945  packages/server/src/live-acquisition-migration.ts
7,058  packages/server/test/live-acquisition-migration.test.ts
```

## Verification

Implementer, Root and independent auditor ran the focused migration suite. Final
evidence:

```text
live-acquisition-migration.test.ts: 48/48 PASS
database-migration-ceiling.test.ts:  3/3 PASS
server typecheck:                    PASS
three-file git diff --check:         PASS (line-ending warnings only)
```

The test-only compatibility bridge around the pre-R2b legacy fixture restores
the exact production trigger SQL in `finally`; all R2b positive/negative tests
run against active production guards. The bridge changes no production schema.

## Downstream integration state

C90b remains frozen until R3 is accepted. Its later production purge enumerator
must emit descendant actions before parents; R2b's executor already rejects a
wrong or incomplete order before mutation. C90b also still needs direct
`history_epoch_id`, queue/reservation/capture and receipt-lineage adoption.

No live database migration, server restart, tab mutation, migration 026, stage,
commit or push was performed.
