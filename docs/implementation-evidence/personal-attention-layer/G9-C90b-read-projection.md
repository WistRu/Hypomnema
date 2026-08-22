# G9 C90b read-projection evidence — live run audit contract

Status: **PASS — independently accepted**

Date: 2026-08-21

Goal: `019ff487-6f70-7d13-a96a-08a131566281`

## Accepted projection

The read projection closes the server-to-W90 contract without exposing internal
capabilities or requiring the live writer to be enabled:

- `GET /api/research/live/runs/:jobId` is local-authenticated, strict-schema and
  remains available for historical reads while new C90 starts are disabled;
- app feature discovery advertises effective writer availability rather than a
  raw environment flag;
- preflight projects the immutable effective policy: local TabHub server egress,
  possible browser-network difference, GET only, no cookies/credentials,
  redirects rejected, robots/cadence, byte/time/header caps and exact
  `maxPages + originCount` network-action cap;
- the complete captured-corpus safe manifest, snapshots, coverage and estimate
  are bound into the live approval fingerprint, preventing stale consent from
  creating any write;
- status projects exact coordinator/final identities, workflow outcome/code,
  counters, checkpoint-derived stage and deterministic ordered action IDs;
- every action exposes state, usability, omission and only allowlisted typed
  exact-tab fallback. Fallback is unavailable for robots, redacted material,
  absent exact URL/origin or forbidden reason codes;
- final dossier linkage exposes exact captured/live provenance and preserves the
  tri-state `runLiveSuccess` distinction;
- active purge hides the entire origin/URL/capture/final-inclusion projection;
  completed redaction remains material-free for run, logical-page and
  Resource-history targets.

Acceptance matrices cover all 19 workflow outcome codes, all 17 allowed and six
forbidden fallback codes, terminal final success/partial/redacted combinations,
the 1,016-action bound and overflow rejection, three purge scopes, checkpoint
corruption and deterministic ordering.

## Independent verdict

```text
P0/P1/P2/UNVERIFIED = 0/0/0/0
verdict = ACCEPT
```

## Verification evidence

Current commands executed during the W90 independent re-audit:

```text
pnpm --filter @tabhub/shared exec vitest run \
  src/live-acquisition-contracts.test.ts

Test Files  1 passed (1)
Tests       7 passed (7)
```

```text
pnpm --filter @tabhub/server exec vitest run \
  test/live-acquisition-status-reader.test.ts \
  test/live-acquisition-routes.test.ts

Test Files  2 passed (2)
Tests       38 passed (38)
```

The same audit ran `pnpm --filter @tabhub/web typecheck`,
`pnpm --filter @tabhub/shared typecheck` and
`pnpm --filter @tabhub/server typecheck`; all exited `0`. Research report routes,
which consume the projected source provenance downstream, passed `11/11`.

## Current file inventory and SHA-256

```text
03ca9cf80cd4cd9fd3f8afd9725d19824d23fa9a0d0ea4308fd0040725a6f83f  packages/shared/src/live-acquisition-contracts.ts
2c3390aed1ac55fa966e9aff84a2e358bc3c200382fdc0f767a946f35cee109e  packages/shared/src/live-acquisition-contracts.test.ts
88968ffad7cf1db6fafc2ece808f95379c9259016e6cdeb37e879fec49241b32  packages/server/src/live-acquisition-status-reader.ts
c912efd623f7531efaf6180ca958668b809a88f97e9bc0a46b9f19663ca35ed8  packages/server/test/live-acquisition-status-reader.test.ts
41ffc137d73db8e978747ddb4134a82c0e872b8bbc4f05978b6cc9c28b369944  packages/server/src/live-acquisition-routes.ts
de0bcadb337bc209ff85996305f20d0217bd08a38542689427011c909ebec1a2  packages/server/test/live-acquisition-routes.test.ts
7ddd9e4716c28003f75895518f14de63999a8476ad0cc6197800d3e3561f49a5  packages/server/src/attention-feature-flags.ts
e0338259144a01b412db8b3b776aa9fdfb64f0c01eccdf1e2fc6e5e6beacb9d2  packages/server/test/privacy-purge-feature-flag.test.ts
e95255b2d15ef777c72c27a268f482839ab4c49f4556e5cadcc58a507ba1a725  packages/server/src/app.ts
ac2084fa3cee42688477740bb72f75b2056c736a27ae05e06aa2787c82264290  packages/server/test/research-app-wiring.test.ts
```

Hashes were recomputed from the current worktree for this manifest.

## Pending live boundary

No endpoint in the user-loaded runtime was called while preparing this evidence.
Historical-read behavior is covered by isolated tests; live UI polling, loaded
runtime schema/feature discovery and redaction display remain Final Gate/runtime
verification and require explicit rollout authorization.

