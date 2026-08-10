import type Database from "better-sqlite3";

import type {
  CreateKnowledgeRelation,
  KnowledgeNodeRef,
  KnowledgeRelation,
  KnowledgeRelationListResponse,
  PatchKnowledgeRelation,
} from "@tabhub/shared";

export interface RelationCatalog {
  listRelations(node?: KnowledgeNodeRef): KnowledgeRelationListResponse;
  createRelation(input: CreateKnowledgeRelation): KnowledgeRelation;
  updateRelation(
    id: number,
    input: PatchKnowledgeRelation,
  ): KnowledgeRelation | undefined;
  deleteRelation(id: number): boolean;
}

export class RelationEndpointsNotFoundError extends Error {
  readonly code = "KNOWLEDGE_NODE_NOT_FOUND";

  constructor(readonly missing: KnowledgeNodeRef[]) {
    super(
      `No knowledge nodes exist for: ${missing
        .map((node) => `${node.type}:${node.id}`)
        .join(", ")}`,
    );
    this.name = "RelationEndpointsNotFoundError";
  }
}

export class SelfRelationError extends Error {
  readonly code = "SELF_RELATION_NOT_ALLOWED";

  constructor(readonly node: KnowledgeNodeRef) {
    super(`${node.type}:${node.id} cannot relate to itself`);
    this.name = "SelfRelationError";
  }
}

interface EntityRow {
  id: number;
}

interface RelationRow {
  id: number;
  from_type: KnowledgeNodeRef["type"];
  from_source_id: number;
  to_type: KnowledgeNodeRef["type"];
  to_source_id: number;
  kind: string;
  note: string | null;
  created_by: KnowledgeRelation["createdBy"];
}

function mapRelation(row: RelationRow): KnowledgeRelation {
  return {
    id: row.id,
    from: { type: row.from_type, id: row.from_source_id },
    to: { type: row.to_type, id: row.to_source_id },
    kind: row.kind,
    note: row.note,
    createdBy: row.created_by,
  };
}

const selectRelationSql = `
  SELECT
    relations.id,
    from_entity.kind AS from_type,
    COALESCE(from_entity.tab_id, from_entity.topic_id) AS from_source_id,
    to_entity.kind AS to_type,
    COALESCE(to_entity.tab_id, to_entity.topic_id) AS to_source_id,
    relations.kind,
    relations.note,
    relations.created_by
  FROM relations
  JOIN knowledge_entities AS from_entity
    ON from_entity.id = relations.from_entity_id
  JOIN knowledge_entities AS to_entity
    ON to_entity.id = relations.to_entity_id
`;

export function createRelationCatalog(
  connection: Database.Database,
): RelationCatalog {
  const selectEntity = connection.prepare(`
    SELECT id
    FROM knowledge_entities
    WHERE (kind = 'tab' AND @type = 'tab' AND tab_id = @sourceId)
       OR (kind = 'topic' AND @type = 'topic' AND topic_id = @sourceId)
    LIMIT 1
  `);
  const selectAll = connection.prepare(`${selectRelationSql}
    ORDER BY relations.id
  `);
  const selectForEntity = connection.prepare(`${selectRelationSql}
    WHERE relations.from_entity_id = ? OR relations.to_entity_id = ?
    ORDER BY relations.id
  `);
  const selectById = connection.prepare(`${selectRelationSql}
    WHERE relations.id = ?
  `);
  const insertRelation = connection.prepare(`
    INSERT INTO relations (
      from_entity_id,
      to_entity_id,
      kind,
      note,
      created_by
    ) VALUES (@fromEntityId, @toEntityId, @kind, @note, @createdBy)
  `);
  const updateRelation = connection.prepare(`
    UPDATE relations
    SET kind = CASE WHEN @hasKind = 1 THEN @kind ELSE kind END,
        note = CASE WHEN @hasNote = 1 THEN @note ELSE note END
    WHERE id = @id
  `);
  const deleteRelation = connection.prepare("DELETE FROM relations WHERE id = ?");

  const resolveEntity = (node: KnowledgeNodeRef): number | undefined =>
    (
      selectEntity.get({ type: node.type, sourceId: node.id }) as
        | EntityRow
        | undefined
    )?.id;

  const createTransaction = connection.transaction(
    (input: CreateKnowledgeRelation): KnowledgeRelation => {
      if (
        input.from.type === input.to.type &&
        input.from.id === input.to.id
      ) {
        throw new SelfRelationError(input.from);
      }

      const fromEntityId = resolveEntity(input.from);
      const toEntityId = resolveEntity(input.to);
      const missing = [
        ...(fromEntityId === undefined ? [input.from] : []),
        ...(toEntityId === undefined ? [input.to] : []),
      ];
      if (missing.length > 0) {
        throw new RelationEndpointsNotFoundError(missing);
      }

      const result = insertRelation.run({
        fromEntityId,
        toEntityId,
        kind: input.kind,
        note: input.note ?? null,
        createdBy: input.createdBy,
      });
      const row = selectById.get(Number(result.lastInsertRowid)) as
        | RelationRow
        | undefined;
      if (row === undefined) {
        throw new Error("Created relation could not be read back");
      }

      return mapRelation(row);
    },
  );

  const updateTransaction = connection.transaction(
    (
      id: number,
      input: PatchKnowledgeRelation,
    ): KnowledgeRelation | undefined => {
      const result = updateRelation.run({
        id,
        hasKind: input.kind === undefined ? 0 : 1,
        kind: input.kind ?? null,
        hasNote: input.note === undefined ? 0 : 1,
        note: input.note ?? null,
      });
      if (result.changes === 0) {
        return undefined;
      }

      const row = selectById.get(id) as RelationRow | undefined;
      return row === undefined ? undefined : mapRelation(row);
    },
  );

  return {
    listRelations(node) {
      if (node === undefined) {
        return { items: (selectAll.all() as RelationRow[]).map(mapRelation) };
      }

      const entityId = resolveEntity(node);
      if (entityId === undefined) {
        return { items: [] };
      }

      return {
        items: (
          selectForEntity.all(entityId, entityId) as RelationRow[]
        ).map(mapRelation),
      };
    },

    createRelation(input) {
      return createTransaction(input);
    },

    updateRelation(id, input) {
      return updateTransaction(id, input);
    },

    deleteRelation(id) {
      return deleteRelation.run(id).changes > 0;
    },
  };
}
