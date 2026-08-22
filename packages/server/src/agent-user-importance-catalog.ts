import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  agentUserImportanceRequestSchema,
  agentUserImportanceResponseSchema,
  type AgentUserImportanceRequest,
  type AgentUserImportanceResponse,
} from "@tabhub/shared";

import type { LogicalPageCatalog } from "./logical-page-catalog.js";
import {
  type ResourceCommandCatalog,
  ResourceCommandCatalogError,
} from "./resource-command-catalog.js";

const receiptVersion = 1;
const idempotencyNamespace = "tabhub:agent-user-importance:idempotency:v1\0";
const authorizationNamespace = "tabhub:agent-user-importance:authorization:v1\0";

type AgentUserImportanceCatalogErrorCode =
  | "FEATURE_DISABLED"
  | "SCHEMA_UNAVAILABLE"
  | "SUBJECT_NOT_FOUND"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "USER_IMPORTANCE_RECEIPT_CORRUPT";

export class AgentUserImportanceCatalogError extends Error {
  constructor(
    readonly code: AgentUserImportanceCatalogErrorCode,
    readonly feature?: "logicalImportance" | "resources",
    readonly actualSchemaVersion?: number,
  ) {
    super(code);
    this.name = "AgentUserImportanceCatalogError";
  }
}

export interface AgentUserImportanceCatalog {
  change(input: AgentUserImportanceRequest): AgentUserImportanceResponse;
}

export interface AgentUserImportanceCatalogTestHooks {
  afterDomainMutation?: (input: AgentUserImportanceRequest) => void;
  afterReceiptInsert?: (input: AgentUserImportanceRequest) => void;
}

interface ReceiptRow {
  idempotency_key_hash: string;
  request_fingerprint: string;
  authorization_ref_hash: string;
  subject_type: "page" | "resource";
  logical_page_id: number | null;
  resource_id: number | null;
  value: 1 | 2 | 3 | null;
  result_json: string;
  result_updated_at: string;
  created_at: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function idempotencyKeyHash(key: string): string {
  return sha256(`${idempotencyNamespace}${key}`);
}

function requestFingerprint(input: AgentUserImportanceRequest): string {
  const subject = input.subject.type === "page"
    ? `page:${input.subject.logicalPageId}`
    : `resource:${input.subject.resourceId}`;
  return sha256(JSON.stringify({
    version: receiptVersion,
    subject,
    value: input.value,
    authorizationRefHash: authorizationRefHash(input.authorizationRef),
  }));
}

function authorizationRefHash(value: string): string {
  return sha256(`${authorizationNamespace}${value}`);
}

function receiptResult(row: ReceiptRow): AgentUserImportanceResponse {
  try {
    const result = agentUserImportanceResponseSchema.parse(
      JSON.parse(row.result_json),
    );
    const expectedId = row.subject_type === "page"
      ? row.logical_page_id
      : row.resource_id;
    const actualId = result.subject.type === "page"
      ? result.subject.logicalPageId
      : result.subject.resourceId;
    if (
      result.subject.type !== row.subject_type ||
      actualId !== expectedId ||
      result.value !== row.value ||
      result.updatedAt !== row.result_updated_at
    ) {
      throw new Error("Receipt projection mismatch");
    }
    return result;
  } catch {
    throw new AgentUserImportanceCatalogError(
      "USER_IMPORTANCE_RECEIPT_CORRUPT",
    );
  }
}

export function createAgentUserImportanceCatalog(
  connection: Database.Database,
  options: {
    schemaVersion: number;
    clock?: () => Date;
    logicalImportanceEnabled: boolean;
    resourcesEnabled: boolean;
    logicalPages: LogicalPageCatalog;
    resourceCommands?: ResourceCommandCatalog;
  },
  testHooks: AgentUserImportanceCatalogTestHooks = {},
): AgentUserImportanceCatalog {
  const assertEnabled = (subject: AgentUserImportanceRequest["subject"]): void => {
    if (subject.type === "page" && !options.logicalImportanceEnabled) {
      throw new AgentUserImportanceCatalogError(
        "FEATURE_DISABLED",
        "logicalImportance",
      );
    }
    if (subject.type === "resource" && !options.resourcesEnabled) {
      throw new AgentUserImportanceCatalogError("FEATURE_DISABLED", "resources");
    }
  };
  if (options.schemaVersion < 23) {
    return {
      change(input) {
        const parsed = agentUserImportanceRequestSchema.parse(input);
        assertEnabled(parsed.subject);
        throw new AgentUserImportanceCatalogError(
          "SCHEMA_UNAVAILABLE",
          undefined,
          options.schemaVersion,
        );
      },
    };
  }

  const selectReceipt = connection.prepare(`
    SELECT * FROM agent_user_importance_receipts
    WHERE idempotency_key_hash = ?
  `);
  const insertReceipt = connection.prepare(`
    INSERT INTO agent_user_importance_receipts (
      idempotency_key_hash, request_fingerprint, subject_type,
      authorization_ref_hash, logical_page_id, resource_id, value,
      result_json, result_updated_at, created_at
    ) VALUES (
      @idempotencyKeyHash, @requestFingerprint, @subjectType,
      @authorizationRefHash, @logicalPageId, @resourceId, @value,
      @resultJson, @resultUpdatedAt, @createdAt
    )
  `);
  const clock = options.clock ?? (() => new Date());

  const execute = connection.transaction(
    (input: AgentUserImportanceRequest): AgentUserImportanceResponse => {
      assertEnabled(input.subject);
      const keyHash = idempotencyKeyHash(input.idempotencyKey);
      const fingerprint = requestFingerprint(input);
      const existing = selectReceipt.get(keyHash) as ReceiptRow | undefined;
      if (existing !== undefined) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new AgentUserImportanceCatalogError("IDEMPOTENCY_KEY_CONFLICT");
        }
        return receiptResult(existing);
      }

      let updatedAt: string;
      if (input.subject.type === "page") {
        const preference = options.logicalPages.setUserImportance(
          {
            logicalPageId: input.subject.logicalPageId,
            value: input.value,
          },
          { recordedBy: "agent", recordMethod: "on_behalf_of_user" },
        );
        if (preference === undefined) {
          throw new AgentUserImportanceCatalogError("SUBJECT_NOT_FOUND");
        }
        updatedAt = preference.updatedAt;
      } else {
        if (options.resourceCommands === undefined) {
          throw new AgentUserImportanceCatalogError("FEATURE_DISABLED", "resources");
        }
        try {
          const receipt = options.resourceCommands.change({
            kind: "set_user_evaluation",
            resourceId: input.subject.resourceId,
            evaluation: input.value,
            provenance: { actor: "agent", method: "on_behalf_of_user" },
            idempotencyKey: `agent-user-importance:${keyHash}`,
          });
          if (receipt.result.kind !== "set_user_evaluation") {
            throw new Error("Unexpected resource command result");
          }
          updatedAt = receipt.result.updatedAt;
        } catch (error) {
          if (
            error instanceof ResourceCommandCatalogError &&
            error.code === "RESOURCE_NOT_FOUND"
          ) {
            throw new AgentUserImportanceCatalogError("SUBJECT_NOT_FOUND");
          }
          throw error;
        }
      }

      const result = agentUserImportanceResponseSchema.parse({
        subject: input.subject,
        value: input.value,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
        updatedAt,
      });
      testHooks.afterDomainMutation?.(input);
      insertReceipt.run({
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        subjectType: input.subject.type,
        authorizationRefHash: authorizationRefHash(input.authorizationRef),
        logicalPageId: input.subject.type === "page"
          ? input.subject.logicalPageId : null,
        resourceId: input.subject.type === "resource"
          ? input.subject.resourceId : null,
        value: input.value,
        resultJson: JSON.stringify(result),
        resultUpdatedAt: result.updatedAt,
        createdAt: clock().toISOString(),
      });
      testHooks.afterReceiptInsert?.(input);
      return result;
    },
  );

  return {
    change(input) {
      return execute.immediate(agentUserImportanceRequestSchema.parse(input));
    },
  };
}
