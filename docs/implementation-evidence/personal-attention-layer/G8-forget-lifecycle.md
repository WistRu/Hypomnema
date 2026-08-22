# G8 integration evidence — research forget lifecycle

Status: **PASS**  
Date: 2026-08-14  
Baseline HEAD: `40f5297250cfd214d7fbac2639c013228044e56d`  
Schema head: `24`

## Purpose

This gate-level regression closes the required proof that promoted exact-tab
intent, captured research evidence and later retention cleanup use one
foreign-key-safe order. It is intentionally a test-only integration receipt;
it changes no production code or migration.

## One-app lifecycle proved

`packages/server/test/research-forget-lifecycle.test.ts` creates one real
schema-24 app and proves this sequence:

1. exact-tab session intent is promoted into shareable logical-page context;
2. the research provider consumes the promoted `page_context` snapshot and
   publishes a valid report with typed evidence;
3. deleting the physical tab first is rejected by the database foreign key and
   leaves all state unchanged;
4. an injected late redaction failure rolls back every earlier privacy write;
5. the sanctioned logical-page redaction deletes all six payload families,
   nulls live source-tab and context-snapshot references, and preserves only
   immutable audit IDs and digests;
6. redacted report detail contains no privacy canary and exposes typed
   unavailable/redacted evidence instead of material;
7. replaying the exact redaction request returns the same receipt and state and
   does not advance another connection's SQLite `data_version`;
8. only after redaction does retention purge remove physical tab/content data.

Per decision `#8.14`, G8 deliberately retains promoted intent/context and the
logical identity. Whole-subject deletion and extension tombstones belong to G9.

The final database checks report `integrity_check=ok` and no foreign-key
violations.

## Independent verification

The author and an independent gate auditor both reviewed the stable test. The
auditor independently reran its focused proof.

```text
test file SHA-256: b091b9dc5b16e3a0062fc008c199f3081289fb2216df0c37fd72fc910abcac07

focused lifecycle test:              1/1 PASS
related context/retention/privacy:   31/31 PASS
full server regression:             851/851 PASS
server typecheck:                    PASS
server build:                        PASS
git diff --check:                    PASS

P0/P1/P2/P3:                         0/0/0/0
mandatory UNVERIFIED for this proof: 0
```

Migration `024` retains SHA-256
`5f095793b66fa70d9bf11ed96db3efdf9cf93f4a2640b079cc4d2ce594a6d182`;
migration `025` does not exist.

