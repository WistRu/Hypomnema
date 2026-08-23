# Web suite stability: failure table and cause

- Issue: [#28](https://github.com/WistRu/Hypomnema/issues/28)
- Date: 2026-08-23
- Purpose: find why the web package failed a different test on each full run, before
  changing anything.

## Observations

| Condition | Runs | Failures | Which test failed |
|---|---|---|---|
| Full mandated command, sequential packages | 10 | 3 | three different tests, never the same twice |
| Web package alone, quiet machine, 4 workers | 12 | 0 | — |
| Web package alone, server suite running concurrently | 6 | 0 | — |

The three victims, in the order they appeared:

1. `tab-drawer-page-summary-feature.test.tsx` — hides a cached resolved-Resource writer
   when the research capability flips off.
2. `library-primary-view.test.tsx` — rates cross-browser physical copies of one logical
   page once without changing browser actions.
3. `research-purge-control.test.tsx` — resumes polling, renders progress and completion
   receipt, then clears persistence.

Every one of them passes when its own file runs alone, and passed every subsequent run
after the others failed.

## Cause

All three make **a synchronous assertion about a non-DOM consequence of an
asynchronous transition, after awaiting a different signal from that same
transition.**

- The drawer test awaited a refetch and then asserted the entries were gone. Refetching
  resolves when the query holds new data; the re-render is a task later.
- The library test awaited the mutation call and then asserted the rating group had
  disappeared. The mutation being called says nothing about the view having re-rendered.
- The purge test awaited the completion text and then asserted the completion callback
  had fired and storage had been cleared. Text and callback are siblings of one poll,
  not one after the other.

The shape is safe when the awaited signal is *caused by* the thing being asserted — the
text cannot appear unless the fetch resolved, so asserting the fetch was called is
sound. It is unsafe when the two are siblings, which is what all three were.

## Exposure

A scan of the 43 web test files finds the shape 118 times. Narrowing to the unsafe
combination — a non-DOM effect asserted synchronously right after awaiting a DOM signal
— leaves 64 sites, of which 46 are positive assertions (18 are negative and must stay
synchronous: waiting for something never to happen passes on the first tick and proves
nothing).

Most of the 46 are the safe variety. Separating them needs a judgement per site, and a
blanket sweep would weaken tests rather than strengthen them.

## Gate after the change

| Condition | Runs | Failures |
|---|---|---|
| Full mandated command, after the three fixes | 5 | 0 |

Five consecutive runs of `corepack pnpm test`, every package green in each. Before the
fixes the same command failed three times in ten.

## What was changed

The three unsafe sites, and only those. Nothing was skipped, pinned to a worker, or
given a longer timeout.

## What remains unproven

Neither controlled experiment reproduced a failure: 12 quiet runs and 6 runs under a
concurrently running server suite were all green. The failures were only ever seen
inside the full sequential command, where the web package starts immediately after the
server package's 1,300 tests. That points at machine state rather than at anything the
web suite does to itself, and it means the fixes above are supported by the shape of
the three failures, not by a reproduction.
