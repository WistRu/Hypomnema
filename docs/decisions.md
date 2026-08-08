# Architecture decisions

- 2026-08-08: Use ordered SQL migration files and `better-sqlite3`; schema ownership stays in the server package and callers receive a ready database through one creation interface.
- 2026-08-08: Keep shared runtime schemas in `@tabhub/shared`; adapters (extension, web, MCP) consume the same validated wire contracts.
- 2026-08-08: Tab events trigger a debounced full-browser snapshot because the specified ingest contract is snapshot-based and only a full set can close missing tabs correctly.
- 2026-08-08: URL normalization removes fragments and case-insensitive `utm_*` parameters while preserving every retained parameter and its order; no other tracking parameters or path forms are changed in v1.
