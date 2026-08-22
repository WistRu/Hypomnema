import type Database from "better-sqlite3";

import type {
  ContextBundle,
  ContextChangeResult,
  ContextCommand,
  ContextEntry,
  ContextSubject,
  ShareableContextBundle,
  ShareableContextEntry,
} from "@tabhub/shared";

import {
  createContextStore,
  type ContextStoreHooks,
} from "./context-ledger-store.js";

export { ContextLedgerError } from "./context-ledger-errors.js";

export interface ContextSearchInput {
  logicalPageId?: number;
  resourceId?: number;
  limit?: number;
  query: string;
}

export interface ContextLedger {
  readLocal(subject: ContextSubject): ContextBundle;
  readShareable(subject: ContextSubject): ShareableContextBundle;
  change(command: ContextCommand): ContextChangeResult;
  searchLocal(input: ContextSearchInput): ContextEntry[];
  searchShareable(input: ContextSearchInput): ShareableContextEntry[];
}

export type ContextLedgerTestHooks = ContextStoreHooks;

export interface ContextLedgerOptions {
  now?: () => string;
  testHooks?: ContextLedgerTestHooks;
}

export function createContextLedger(
  connection: Database.Database,
  options: ContextLedgerOptions = {},
): ContextLedger {
  const now = options.now ?? (() => new Date().toISOString());
  const activeResource = connection.prepare(`
    SELECT 1 FROM resource_heads AS heads
    JOIN resource_events AS events ON events.id = heads.event_id
    WHERE heads.resource_id = ? AND events.lifecycle_state = 'active'
  `);
  const page = createContextStore(connection, {
    type: "page",
    idColumn: "logical_page_id",
    identityTable: "logical_pages",
    entryTable: "context_entries",
    reviewTable: "context_entry_reviews",
    ftsTable: "context_entries_fts",
    shareableFtsTable: "shareable_context_entries_fts",
    notFoundCode: "LOGICAL_PAGE_NOT_FOUND",
  }, now, options.testHooks);
  const resource = createContextStore(connection, {
    type: "resource",
    idColumn: "resource_id",
    identityTable: "resources",
    entryTable: "resource_context_entries",
    reviewTable: "resource_context_entry_reviews",
    ftsTable: "resource_context_entries_fts",
    shareableFtsTable: "shareable_resource_context_entries_fts",
    notFoundCode: "RESOURCE_NOT_FOUND",
    isWritable: (resourceId) => activeResource.get(resourceId) !== undefined,
  }, now, options.testHooks);
  const storeFor = (subject: ContextSubject) =>
    subject.type === "page" ? page : resource;
  const searchInput = (
    input: ContextSearchInput,
    subjectId: number | undefined,
  ): { query: string; limit?: number; subjectId?: number } => ({
    query: input.query,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(subjectId === undefined ? {} : { subjectId }),
  });

  return {
    readLocal: (subject) => storeFor(subject).readLocal(subject),
    readShareable: (subject) => storeFor(subject).readShareable(subject),
    change: (command) => storeFor(command.subject).change(command),
    searchLocal: (input) => {
      if (input.logicalPageId !== undefined && input.resourceId !== undefined) return [];
      if (input.resourceId !== undefined) {
        return resource.search(searchInput(input, input.resourceId), false) as ContextEntry[];
      }
      return page.search(searchInput(input, input.logicalPageId), false) as ContextEntry[];
    },
    searchShareable: (input) => {
      if (input.logicalPageId !== undefined && input.resourceId !== undefined) return [];
      if (input.resourceId !== undefined) {
        return resource.search(searchInput(input, input.resourceId), true) as ShareableContextEntry[];
      }
      return page.search(searchInput(input, input.logicalPageId), true) as ShareableContextEntry[];
    },
  };
}
