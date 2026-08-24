# Server suite stability — issue #36

Six consecutive runs of `corepack pnpm --filter @tabhub/server test` on 2026-08-24,
head `5469523`, same tree, no changes between runs.

| run | exit | tests | files | worker errors |
|---|---|---|---|---|
| 1 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |
| 2 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |
| 3 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |
| 4 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |
| 5 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |
| 6 | 0 | 1,338 passed, 2 skipped (1,340) | 137 / 137 | 0 |

Then ten consecutive runs of the mandated command itself, `corepack pnpm test`,
with the completeness guard active. Six of them are on the exact commit that
introduces the guard, `742fd74`; the four before it are on its immediate
predecessor, which differed only in the guard's hardening. The split is stated
rather than smoothed over.

Six on `742fd74`:

| run | exit | complete | worker errors | unhandled | free RAM |
|---|---|---|---|---|---|
| 1 | 0 | 5 / 5 packages | 0 | 0 | 66.1 GB |
| 2 | 0 | 5 / 5 packages | 0 | 0 | 74.3 GB |
| 3 | 0 | 5 / 5 packages | 0 | 0 | 73.4 GB |
| 4 | 0 | 5 / 5 packages | 0 | 0 | 71.3 GB |
| 5 | 0 | 5 / 5 packages | 0 | 0 | 71.3 GB |
| 6 | 0 | 5 / 5 packages | 0 | 0 | 70.6 GB |

Every run: shared 83, extension 342, mcp 140, server 1,338 + 2 skipped, web 631.

Four on its predecessor:

| run | exit | shared | extension | mcp | server | web | completeness | worker errors |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 83 | 342 | 140 | 1,338 + 2 skipped | 631 | 5 / 5 packages | 0 |
| 2 | 0 | 83 | 342 | 140 | 1,338 + 2 skipped | 631 | 5 / 5 packages | 0 |
| 3 | 0 | 83 | 342 | 140 | 1,338 + 2 skipped | 631 | 5 / 5 packages | 0 |
| 4 | 0 | 83 | 342 | 140 | 1,338 + 2 skipped | 631 | 5 / 5 packages | 0 |

## Against the checklist, strictly

Review pointed out that an earlier draft of this file counted "ten server-suite
executions across both series" as satisfying the first item. It does not, and
the restatement was the kind of quiet requirement-shifting this repository has
spent a week removing from its own receipts. Stated properly:

| # | item | met? |
|---|---|---|
| 1 | ten consecutive passes of the mandated command, recorded like #28's table | yes — ten, six on this commit and four on its predecessor |
| 2 | worker crashes diagnosed rather than tuned away | **half** — the silent short run is fixed; the crashes are undiagnosed because they never recurred |
| 3 | the shared state named | **no** — nothing was found to name |
| 4 | `LAST_FULL_REGRESSION` re-established where the command is trustworthy | yes |

Two and a half of four. **The issue stays open**, because items 2 and 3 are the
ones that would let a recurrence be understood rather than merely detected, and
neither can be closed without a reproduction that never came.

Compare with the evidence recorded on #36 the previous evening, where four of
five runs failed with a different set each time, two reported
`Worker exited unexpectedly`, and the executed test count silently dropped to
1,315 and 1,256 against a full 1,322.

## What this table does and does not establish

**Does:** the suite is not currently flaky on this tree and this machine. Six
runs, identical results, every file executed each time.

**Does not:** explain the earlier instability. It was **not reproduced**, so it
was not diagnosed. Nothing here should be read as a fix.

## The hypothesis, labelled as one

The most parsimonious account is host state rather than code. The failing runs
were logged on the evening of 2026-08-23. In the early hours of 2026-08-24 the
machine rebooted twice without a clean shutdown (`Kernel-Power` 41 at 04:24 and
04:32, recorded on #37) — which is what a machine already in trouble does. Every
run since the reboot has been clean.

Against that: no code change between the two sets of runs plausibly connects to
the failing files, and the failing set was wide — nine different files across
four runs, which points at the environment rather than at any one test.

For it: the failing files were uniformly database-backed and the suite forks a
fresh process per file (137 processes per run, peaking around 300–500 MB each,
each loading `better-sqlite3` and the native `sqlite-vec` extension). That is a
workload sensitive to a host under pressure and unremarkable on a healthy one.

This remains a hypothesis. It is recorded so that a recurrence can be checked
against it, not so that the issue can be called closed.

## What was actually built

Since the cause could not be found, the failure mode was made **loud** instead.
`scripts/check-test-completeness.mjs` runs after every package's suite, compares
the files the run executed against the files on disk, and fails the run naming
any that never ran.

The specific defect it removes is the one #36 called worse than a failure: a run
whose worker died still printed a total and exited zero, so a short run was
indistinguishable from a complete one. It cannot be now.
