# Architecture decisions

- 2026-08-08: Use ordered SQL migration files and `better-sqlite3`; schema ownership stays in the server package and callers receive a ready database through one creation interface.
- 2026-08-08: Keep shared runtime schemas in `@tabhub/shared`; adapters (extension, web, MCP) consume the same validated wire contracts.
