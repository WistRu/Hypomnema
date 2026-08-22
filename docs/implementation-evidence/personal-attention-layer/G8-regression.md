# G8 integration evidence — final workspace regression

Status: **PASS**  
Date: 2026-08-14  
Baseline HEAD: `40f5297250cfd214d7fbac2639c013228044e56d`

This regression was run after every G8 packet and the gate-level research
forget-lifecycle test were present in the shared worktree. It did not restart
or migrate the user's live schema-17 runtime.

```text
corepack pnpm test
shared:      10 files /  63 tests PASS
extension:   29 files / 321 tests PASS
mcp:         12 files / 140 tests PASS
server:     100 files / 851 tests PASS
web:         86 files / 553 tests PASS
aggregate:  237 files / 1,928 tests PASS

corepack pnpm typecheck
PASS for all five packages

corepack pnpm build
PASS for all five packages

git diff --check
PASS; no whitespace errors

git diff --cached --name-only
PASS; index empty
```

Non-failing diagnostics were limited to 16 known JSDOM canvas warnings, the
Vite large-chunk advisory and 85 Git LF-to-CRLF notices. Performance diagnostics
reported `C52A_FACADE50_P95_MS=0.639` and
`C50_BATCH50_P95_MS=141.280`.

The built MCP transcript was also rerun against a fresh process:

```text
research-stdio.test.ts + research-real-adapter.test.ts
2 files / 2 tests PASS
```

It covers all five captured-research tools, exactly one REST call per tool,
no hidden preflight/polling/navigation/capture/cache behavior, safe auth/cookie
forwarding boundaries, privacy-canary exclusion and exact replay after corpus
drift with a fresh MCP instance.

The fresh extension reload and exact physical-tab live smoke required by the
runbook were completed after this packet. During that smoke, the web-session
cookie path defect was corrected under TDD and the complete workspace commands
were rerun cleanly. The integrated acceptance receipt is `G8.md`.
