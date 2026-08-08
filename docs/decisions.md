# Architecture decisions

- 2026-08-08: Use ordered SQL migration files and `better-sqlite3`; schema ownership stays in the server package and callers receive a ready database through one creation interface.
- 2026-08-08: Keep shared runtime schemas in `@tabhub/shared`; adapters (extension, web, MCP) consume the same validated wire contracts.
- 2026-08-08: Tab events trigger a debounced full-browser snapshot because the specified ingest contract is snapshot-based and only a full set can close missing tabs correctly.
- 2026-08-08: URL normalization removes fragments and case-insensitive `utm_*` parameters while preserving every retained parameter and its order; no other tracking parameters or path forms are changed in v1.
- 2026-08-08: Use a contentless-delete FTS5 table synchronized by SQLite triggers; canonical text stays in `contents`, while title/content/summary indexing remains atomic across REST, worker, and future MCP writes.
- 2026-08-08: Convert user search text into quoted Unicode tokens joined with `AND`, preventing raw FTS syntax errors while retaining predictable keyword semantics.
- 2026-08-08: Keep MCP as a stateless REST adapter using the split MCP TypeScript v2 stdio packages; all MCP tag mutations are recorded with `assigned_by = 'agent'`.
- 2026-08-08: Rename ambiguous duplicate root tags during the v3 migration, then enforce root-name uniqueness in SQLite so concurrent local server processes cannot fork a tag path.
- 2026-08-08: Persist summary jobs and every provider attempt in SQLite, process one request at a time, and bind each job to a content revision so retries and restarts cannot attach stale output.
- 2026-08-08: Call Anthropic's Messages API directly with pinned configurable model IDs; resolve configurable token prices at request time so stored cost estimates follow the dated Sonnet 5 pricing transition without hidden SDK retries.
