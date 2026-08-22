# G9 C90b final evidence — closed live-acquisition server boundary

Status: **PASS — independently accepted**

Date: 2026-08-21

Goal: `019ff487-6f70-7d13-a96a-08a131566281`

Candidate schema head: `26`

## Final accepted boundary

C90b composes the previously accepted admission/runtime, safe HTTP, action
ledger, materialization, traversal, handoff, accounting and schema-26 purge
correction into one closed server-only Resource research path.

Security and privacy invariants accepted by the final audit:

- no generic fetch route, extension fetch, browser navigation, tab mutation,
  script/subrequest execution, cookie, credential, authorization header or
  redirect-follow path exists;
- every request is GET-only, robots-gated, cadence-limited, exact-200 and bounded
  by DNS/connect/header/body-idle/request timeouts plus source/header/total byte
  caps;
- normalized URL components are rescanned for sensitive atoms before DNS and
  before use; authenticated/sensitive/login material becomes typed exact-tab
  fallback rather than server egress;
- DNS accepts a bounded answer set, rejects private/mixed/unknown/NAT64 forms,
  requires IPv4 in v1 and pins one deterministic public address; TLS verifies
  CA, SNI/hostname and the connected peer before application bytes;
- action phases are durable and non-replayable after network start. Expiry,
  cancel, crash and purge races terminalize conservatively;
- page reservations, network actions, traversal depth/pages, daily starts and
  provider cost are independently capped and durably accounted;
- usable source material, omission state and captured/live provenance are
  immutable and exactly linked into the descendant dossier;
- schema-26 waits for physical action/job quiescence and fences the complete
  mutation surface before the unchanged schema-25 deletion executor runs;
- purge/redaction projections cannot reveal origin, URL, capture, final-source
  or body material while privacy processing is active or complete.

The final handoff implementation uses pure precomputation outside SQLite, exact
before/after plan and provider-quote tokens, and one `BEGIN IMMEDIATE` mutation
per terminal path. No external callback executes inside that transaction.

## Independent verdict

Historical accepted audit:

```text
focused C90b claims: 80/80 PASS
P0/P1/P2/UNVERIFIED = 0/0/0/0
verdict = ACCEPT
```

The current worktree additionally passed the narrower V3–V5 command (`62/62`)
and the schema-26 purge packet command (`170/170`) recorded in their dedicated
manifests. These later commands validate current integration without replacing
the historical independent verdict.

## Current principal implementation inventory

```text
bbb2b789dea589b1b73e1af9e0d8bf3461b792abb12014d8ba70bd0ef51313e5  packages/server/src/live-acquisition-foundation.ts
9a1b43f74d1fc50118119bdb36523fb885538be672cc83d7879ed463af0fc241  packages/server/src/live-acquisition-policy.ts
46d941b7ac57f4faa679b13131b5f4f99f09bee1946150c48b74b03cb3e8a4c9  packages/server/src/safe-public-http-client.ts
f96cb5af6e38b0e16997be24f9c4b5e714337471bc60ea2f9c6ffcf30d803a5d  packages/server/src/live-acquisition-action-ledger.ts
db845ed497c79af6d07264b2472db05e4f252e523938b6edcf11cb0b703750bf  packages/server/src/live-acquisition-materializer.ts
66ec388c34883b700b17306624d93f456488595195f139249e75e625b70235a5  packages/server/src/live-acquisition-handoff.ts
3aa3690dd135997352063bde048dae0f4f62a1208cd84856e1004efe5837d0b8  packages/server/src/live-acquisition-workflow.ts
a8e8154d816c134b038e2e03a91a415361c422598e189881bf8b2445e1f18fcd  packages/server/src/research-acquisition-coordinator.ts
41ffc137d73db8e978747ddb4134a82c0e872b8bbc4f05978b6cc9c28b369944  packages/server/src/live-acquisition-routes.ts
e95255b2d15ef777c72c27a268f482839ab4c49f4556e5cadcc58a507ba1a725  packages/server/src/app.ts
eededef254a4eed2ddc0c460f685f648598749340472ff483bb73497149d8f78  packages/server/test/live-acquisition-foundation.test.ts
ba7a136f64c34f8fb1452cd0809b6998beca4b9c670cd1ac7ca5883a65e3a184  packages/server/test/live-acquisition-policy.test.ts
f5fb8187cf6e692743376b0cb9879981e46a08daa844df9b1202a081b7eb15e0  packages/server/test/safe-public-http-client.test.ts
5dc726630cd66b159f05414ae938e52b15ce96e223e325c68bd753a764143ac1  packages/server/test/live-acquisition-action-ledger.test.ts
c5ce3f5a7da537f90651fc3ef85034b7270ed195a2ce59f6bf099a0112522138  packages/server/test/live-acquisition-materializer.test.ts
df95a0992e206af9513c53a71890a88cc1872cf9640700834205985612bb626e  packages/server/test/live-acquisition-handoff.test.ts
bc4cf10ee620281d24fdcccf996cad9d8bfb7d64ffbadd70b17b3d1c7db8d667  packages/server/test/live-acquisition-workflow.test.ts
12a5a73344f195854657a326a868da09b2d6a0f586705d7dd5ad2d17e9bd1518  packages/server/test/research-acquisition-coordinator.test.ts
de0bcadb337bc209ff85996305f20d0217bd08a38542689427011c909ebec1a2  packages/server/test/live-acquisition-routes.test.ts
```

These are recomputed current hashes. Schema/purge files are inventoried in
`G9-C90a-R5.md`; the public read projection is inventoried separately.

## Known non-live regression boundary

The legacy schema-25 migration suite was subsequently repaired without changing
production: it is explicitly capped at schema 25 and now passes `54/54`. Five
additional fixture files were made schema-26-aware and pass `37/37`. These are
test compatibility results, not evidence of a live rollout.

## Pending live boundary

This PASS permits W90 and Final Gate preparation; it is not a deployment
receipt. Required later evidence includes disposable/fresh migration, rollback
artifact, full workspace regression/build, explicit rollout-or-waiver, fresh
PID/health/log proof if rolled out, extension reload and J3 real-public-HTTPS
acquisition with acquired dossier evidence and exact pre/post tab/window state.

