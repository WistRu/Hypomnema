# G9 contract freeze — revision 6

Date: 2026-08-14

Status: ACCEPTED

## Canonical accepted bytes

- `docs/personal-attention-layer-goal-runbook.md`: `d662c843cbefe1e718ea0137fb75afe848ba99f717dc3ef30fd362f92c8951d6`
- `docs/personal-attention-layer-implementation-plan.md`: `59f9fd6b834115ea397752d495010d97ad0a9329571d37cf61cdf0e9b744c369`
- `docs/decisions.md`: `84ba47f60fe012cbdf01fc70862deaac535c23b11ff1a72c82fd99b7a002aaf4`

The accepted semantic candidate immediately before status publication used
runbook hash `5dfa8314f2c43722814e965f788e76a830e659a02319f8d60ce06e9fa2c8ac2f`,
the same implementation-plan hash, and decisions hash
`ddf2e20f275479549ddee7cf3df88e45189caf47802e191a2c9549ab9bd578bc`.

## Independent audit result

All three read-only exact-hash audits accepted revision 6:

- boundary/security: `P0/P1/P2/P3=0/0/0/0`, mandatory `UNVERIFIED=0`;
- schema/runtime: `P0/P1/P2/P3=0/0/0/0`, mandatory `UNVERIFIED=0`;
- product/completeness: `P0/P1/P2/P3=0/0/0/0`, mandatory `UNVERIFIED=0`.

The boundary audit explicitly stress-tested full-token segmentation for
`authtoken`, `sessiontoken`, `bearertoken`, `authorizationcode`, `clientsecret`
and `xamzsecuritytoken`, plus benign `tokenization` and `signaturedesign`.
It also rechecked SSRF/DNS/TLS/HTTP, text/plain-only robots, chrome-pruned primary
content, consent-expiry fencing, exact-tab fallback, and the absence of generic or
extension acquisition.

The final status-only publication was re-hashed. Boundary and schema/runtime
confirmed no semantic delta. Product review found three stale pre-acceptance status
labels; those labels were corrected before the canonical accepted hashes above.

## Gate effect

- C90a: dependency-open, exclusive write lease may be issued.
- C90b: closed until C90a acceptance.
- W90: closed until C90b acceptance.
- A90/extension packet: does not exist.
