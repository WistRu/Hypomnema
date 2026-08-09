import type Database from "better-sqlite3";

import type {
  ClusterInboxResponse,
  EmbeddingReindexResponse,
  TabImportance,
  TabStatus,
} from "@tabhub/shared";

import type { EmbeddingProvider } from "./embedding-provider.js";
import {
  clusterInboxRows,
  type ClusterableInboxTab,
} from "./inbox-clustering.js";

const EMBEDDING_DIMENSIONS = 512 as const;
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_SOURCE_CHARACTERS = 32_000;
const CLUSTER_KEYWORD_CHARACTERS = 4_000;

export interface EmbeddingSearchFilters {
  browser?: string;
  isOpen?: boolean;
  status?: TabStatus;
  importance?: TabImportance;
  tag?: string;
}

export interface RankedTabPage {
  ids: number[];
  total: number;
}

export interface EmbeddingCatalog {
  reindex(limit: number): Promise<EmbeddingReindexResponse>;
  semanticSearch(
    query: string,
    page: number,
    pageSize: number,
    filters?: EmbeddingSearchFilters,
  ): Promise<RankedTabPage>;
  similarTabs(
    tabId: number,
    page: number,
    pageSize: number,
    filters?: EmbeddingSearchFilters,
  ): RankedTabPage;
  clusterInbox(maxClusters: number): Promise<ClusterInboxResponse>;
}

export class EmbeddingProviderUnavailableError extends Error {
  readonly code = "EMBEDDING_PROVIDER_UNAVAILABLE";

  constructor() {
    super("No embedding provider is configured");
    this.name = "EmbeddingProviderUnavailableError";
  }
}

export class InvalidEmbeddingResultError extends Error {
  readonly code = "INVALID_EMBEDDING_RESULT";

  constructor(message: string) {
    super(message);
    this.name = "InvalidEmbeddingResultError";
  }
}

export class SimilarTabNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly tabId: number) {
    super(`No tab exists with id ${tabId}`);
    this.name = "SimilarTabNotFoundError";
  }
}

export class EmbeddingNotIndexedError extends Error {
  readonly code = "EMBEDDING_NOT_INDEXED";

  constructor(readonly tabId: number) {
    super(`Tab ${tabId} does not have a current embedding`);
    this.name = "EmbeddingNotIndexedError";
  }
}

interface CandidateRow {
  tab_id: number;
  text: string;
  content_revision: number;
}

interface CountRow {
  total: number;
}

interface CurrentContentRow {
  content_revision: number;
}

interface SimilarSourceRow {
  embedding: Buffer;
  provider: string;
  model: string;
}

interface RankedRow {
  tab_id: number;
  distance: number;
}

interface InboxEmbeddingRow {
  id: number;
  title: string | null;
  text: string;
  embedding: Buffer;
}

function checkedVector(vector: number[], index: number): Float32Array {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingResultError(
      `Embedding ${index} has ${vector.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`,
    );
  }

  const result = Float32Array.from(vector);
  let squaredNorm = 0;
  for (const value of result) {
    if (!Number.isFinite(value)) {
      throw new InvalidEmbeddingResultError(
        `Embedding ${index} contains a non-finite value`,
      );
    }
    squaredNorm += value * value;
  }
  if (squaredNorm === 0) {
    throw new InvalidEmbeddingResultError(
      `Embedding ${index} must not be a zero vector`,
    );
  }

  return result;
}

function checkedVectors(
  vectors: number[][],
  expectedCount: number,
): Float32Array[] {
  if (vectors.length !== expectedCount) {
    throw new InvalidEmbeddingResultError(
      `Embedding provider returned ${vectors.length} vectors for ${expectedCount} inputs`,
    );
  }

  return vectors.map(checkedVector);
}

function vectorFromBuffer(buffer: Buffer): Float32Array {
  if (buffer.byteLength !== EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) {
    throw new InvalidEmbeddingResultError(
      `Stored embedding has ${buffer.byteLength} bytes; expected ${EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT}`,
    );
  }
  return Float32Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, index) => buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT),
  );
}

export function createEmbeddingCatalog(
  connection: Database.Database,
  provider: EmbeddingProvider | undefined,
  clock: () => Date = () => new Date(),
): EmbeddingCatalog {
  const selectCandidates = connection.prepare(`
    SELECT
      contents.tab_id,
      SUBSTR(contents.text, 1, ${EMBEDDING_SOURCE_CHARACTERS}) AS text,
      contents.content_revision
    FROM contents
    LEFT JOIN embedding_metadata AS metadata
      ON metadata.tab_id = contents.tab_id
    WHERE TRIM(COALESCE(contents.text, '')) <> ''
      AND (
        metadata.tab_id IS NULL
        OR metadata.provider != @provider
        OR metadata.model != @model
        OR metadata.dimensions != @dimensions
        OR metadata.source_content_revision != contents.content_revision
      )
    ORDER BY contents.tab_id
    LIMIT @limit
  `);
  const countCandidates = connection.prepare(`
    SELECT COUNT(*) AS total
    FROM contents
    LEFT JOIN embedding_metadata AS metadata
      ON metadata.tab_id = contents.tab_id
    WHERE TRIM(COALESCE(contents.text, '')) <> ''
      AND (
        metadata.tab_id IS NULL
        OR metadata.provider != @provider
        OR metadata.model != @model
        OR metadata.dimensions != @dimensions
        OR metadata.source_content_revision != contents.content_revision
      )
  `);
  const selectInboxCandidates = connection.prepare(`
    SELECT
      contents.tab_id,
      SUBSTR(contents.text, 1, ${EMBEDDING_SOURCE_CHARACTERS}) AS text,
      contents.content_revision
    FROM contents
    JOIN tabs ON tabs.id = contents.tab_id
    LEFT JOIN embedding_metadata AS metadata
      ON metadata.tab_id = contents.tab_id
    WHERE tabs.status = 'inbox'
      AND contents.tab_id > @afterTabId
      AND TRIM(COALESCE(contents.text, '')) <> ''
      AND (
        metadata.tab_id IS NULL
        OR metadata.provider != @provider
        OR metadata.model != @model
        OR metadata.dimensions != @dimensions
        OR metadata.source_content_revision != contents.content_revision
      )
    ORDER BY contents.tab_id
    LIMIT @limit
  `);
  const selectCurrentContent = connection.prepare(`
    SELECT content_revision
    FROM contents
    WHERE tab_id = ?
  `);
  const deleteVector = connection.prepare(
    "DELETE FROM vec_contents WHERE tab_id = ?",
  );
  const insertVector = connection.prepare(`
    INSERT INTO vec_contents (tab_id, embedding)
    VALUES (?, ?)
  `);
  const upsertMetadata = connection.prepare(`
    INSERT INTO embedding_metadata (
      tab_id, provider, model, dimensions, source_content_revision, embedded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tab_id) DO UPDATE SET
      provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      source_content_revision = excluded.source_content_revision,
      embedded_at = excluded.embedded_at
  `);
  const selectTab = connection.prepare("SELECT id FROM tabs WHERE id = ?");
  const selectSimilarSource = connection.prepare(`
    SELECT vec_contents.embedding, metadata.provider, metadata.model
    FROM vec_contents
    JOIN embedding_metadata AS metadata
      ON metadata.tab_id = vec_contents.tab_id
    JOIN contents ON contents.tab_id = vec_contents.tab_id
    WHERE vec_contents.tab_id = ?
      AND metadata.dimensions = 512
      AND metadata.source_content_revision = contents.content_revision
  `);
  const countInbox = connection.prepare(`
    SELECT COUNT(*) AS total
    FROM tabs
    WHERE status = 'inbox'
  `);
  const selectInboxEmbeddings = connection.prepare(`
    SELECT
      tabs.id,
      tabs.title,
      SUBSTR(contents.text, 1, ${CLUSTER_KEYWORD_CHARACTERS}) AS text,
      vec_contents.embedding
    FROM tabs
    JOIN contents ON contents.tab_id = tabs.id
    JOIN embedding_metadata AS metadata ON metadata.tab_id = tabs.id
    JOIN vec_contents ON vec_contents.tab_id = tabs.id
    WHERE tabs.status = 'inbox'
      AND TRIM(COALESCE(contents.text, '')) <> ''
      AND metadata.provider = @provider
      AND metadata.model = @model
      AND metadata.dimensions = @dimensions
      AND metadata.source_content_revision = contents.content_revision
    ORDER BY tabs.id
  `);

  const writeVectors = connection.transaction(
    (
      candidates: CandidateRow[],
      vectors: Float32Array[],
      embeddedAt: string,
      currentProvider: EmbeddingProvider,
    ): { indexed: number; skipped: number } => {
      let indexed = 0;
      let skipped = 0;

      for (const [index, candidate] of candidates.entries()) {
        const current = selectCurrentContent.get(candidate.tab_id) as
          | CurrentContentRow
          | undefined;
        if (current?.content_revision !== candidate.content_revision) {
          skipped += 1;
          continue;
        }

        // sqlite-vec 0.1.9 on Windows requires a BigInt primary-key binding.
        const vectorTabId = BigInt(candidate.tab_id);
        deleteVector.run(vectorTabId);
        insertVector.run(vectorTabId, vectors[index]!);
        upsertMetadata.run(
          candidate.tab_id,
          currentProvider.provider,
          currentProvider.model,
          EMBEDDING_DIMENSIONS,
          candidate.content_revision,
          embeddedAt,
        );
        indexed += 1;
      }

      return { indexed, skipped };
    },
  );

  const currentProvider = (): EmbeddingProvider => {
    if (provider === undefined) {
      throw new EmbeddingProviderUnavailableError();
    }
    if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new InvalidEmbeddingResultError(
        `Embedding provider declares ${String(provider.dimensions)} dimensions; expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return provider;
  };

  const indexCandidates = async (
    candidates: CandidateRow[],
    activeProvider: EmbeddingProvider,
  ): Promise<{ indexed: number; skipped: number }> => {
    let indexed = 0;
    let skipped = 0;
    const embeddedAt = clock().toISOString();

    for (
      let offset = 0;
      offset < candidates.length;
      offset += EMBEDDING_BATCH_SIZE
    ) {
      const batch = candidates.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = checkedVectors(
        await activeProvider.embed(
          batch.map(({ text }) => text),
          "document",
        ),
        batch.length,
      );
      const result = writeVectors(batch, vectors, embeddedAt, activeProvider);
      indexed += result.indexed;
      skipped += result.skipped;
    }

    return { indexed, skipped };
  };

  const rankedPage = (
    embedding: Float32Array | Buffer,
    providerName: string,
    model: string,
    page: number,
    pageSize: number,
    filters: EmbeddingSearchFilters = {},
    excludeTabId?: number,
  ): RankedTabPage => {
    const predicates = [
      "metadata.provider = ?",
      "metadata.model = ?",
      "metadata.dimensions = ?",
      "metadata.source_content_revision = contents.content_revision",
    ];
    const parameters: Array<string | number> = [
      providerName,
      model,
      EMBEDDING_DIMENSIONS,
    ];
    if (filters.browser !== undefined) {
      predicates.push("tabs.browser = ?");
      parameters.push(filters.browser);
    }
    if (filters.isOpen !== undefined) {
      predicates.push("tabs.is_open = ?");
      parameters.push(filters.isOpen ? 1 : 0);
    }
    if (filters.status !== undefined) {
      predicates.push("tabs.status = ?");
      parameters.push(filters.status);
    }
    if (filters.importance !== undefined) {
      predicates.push("tabs.importance = ?");
      parameters.push(filters.importance);
    }
    if (filters.tag !== undefined) {
      predicates.push(`tabs.id IN (
        WITH RECURSIVE
          tag_paths(id, path) AS (
            SELECT id, name FROM tags WHERE parent_id IS NULL
            UNION ALL
            SELECT child.id, tag_paths.path || '/' || child.name
            FROM tags AS child
            JOIN tag_paths ON child.parent_id = tag_paths.id
          ),
          descendants(id) AS (
            SELECT id FROM tag_paths WHERE path = ?
            UNION ALL
            SELECT child.id
            FROM tags AS child
            JOIN descendants ON child.parent_id = descendants.id
          )
        SELECT tab_tags.tab_id
        FROM tab_tags
        JOIN descendants ON descendants.id = tab_tags.tag_id
      )`);
      parameters.push(filters.tag);
    }
    if (excludeTabId !== undefined) {
      predicates.push("vec_contents.tab_id != ?");
      parameters.push(excludeTabId);
    }

    const fromAndWhere = `
      FROM vec_contents
      JOIN embedding_metadata AS metadata
        ON metadata.tab_id = vec_contents.tab_id
      JOIN contents ON contents.tab_id = vec_contents.tab_id
      JOIN tabs ON tabs.id = vec_contents.tab_id
      WHERE ${predicates.join(" AND ")}`;
    const total = (
      connection
        .prepare(`SELECT COUNT(*) AS total ${fromAndWhere}`)
        .get(...parameters) as CountRow
    ).total;
    if (total === 0) return { ids: [], total: 0 };

    const offset = (page - 1) * pageSize;
    const rows =
      connection
        .prepare(
          `SELECT
             vec_contents.tab_id,
             vec_distance_cosine(vec_contents.embedding, ?) AS distance
           ${fromAndWhere}
           ORDER BY distance, vec_contents.tab_id
           LIMIT ? OFFSET ?`,
        )
        .all(embedding, ...parameters, pageSize, offset) as RankedRow[];
    return { ids: rows.map(({ tab_id }) => tab_id), total };
  };

  return {
    async reindex(limit) {
      const activeProvider = currentProvider();

      const parameters = {
        provider: activeProvider.provider,
        model: activeProvider.model,
        dimensions: EMBEDDING_DIMENSIONS,
      };
      const candidates = selectCandidates.all({
        ...parameters,
        limit,
      }) as CandidateRow[];
      if (candidates.length === 0) {
        return {
          indexed: 0,
          skipped: 0,
          remaining: 0,
          ...parameters,
        };
      }

      const result = await indexCandidates(candidates, activeProvider);
      const remaining = (countCandidates.get(parameters) as CountRow).total;

      return { ...result, remaining, ...parameters };
    },

    async semanticSearch(query, page, pageSize, filters) {
      const activeProvider = currentProvider();

      const [embedding] = checkedVectors(
        await activeProvider.embed([query], "query"),
        1,
      );
      return rankedPage(
        embedding!,
        activeProvider.provider,
        activeProvider.model,
        page,
        pageSize,
        filters,
      );
    },

    similarTabs(tabId, page, pageSize, filters) {
      if (selectTab.get(tabId) === undefined) {
        throw new SimilarTabNotFoundError(tabId);
      }
      const source = selectSimilarSource.get(tabId) as
        | SimilarSourceRow
        | undefined;
      if (source === undefined) {
        throw new EmbeddingNotIndexedError(tabId);
      }

      return rankedPage(
        source.embedding,
        source.provider,
        source.model,
        page,
        pageSize,
        filters,
        tabId,
      );
    },

    async clusterInbox(maxClusters) {
      const activeProvider = currentProvider();
      const parameters = {
        provider: activeProvider.provider,
        model: activeProvider.model,
        dimensions: EMBEDDING_DIMENSIONS,
      };
      let indexed = 0;
      let afterTabId = 0;
      while (true) {
        const candidates = selectInboxCandidates.all({
          ...parameters,
          afterTabId,
          limit: EMBEDDING_BATCH_SIZE,
        }) as CandidateRow[];
        if (candidates.length === 0) break;
        const result = await indexCandidates(candidates, activeProvider);
        indexed += result.indexed;
        afterTabId = candidates.at(-1)!.tab_id;
      }
      const rows = (selectInboxEmbeddings.all(parameters) as InboxEmbeddingRow[]).map(
        (row): ClusterableInboxTab => ({
          id: row.id,
          title: row.title,
          text: row.text,
          embedding: vectorFromBuffer(row.embedding),
        }),
      );
      const totalInbox = (countInbox.get() as CountRow).total;

      return {
        clusters: clusterInboxRows(rows, maxClusters),
        indexed,
        unclustered: totalInbox - rows.length,
      };
    },
  };
}
