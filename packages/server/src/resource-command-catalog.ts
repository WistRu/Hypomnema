import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import ipaddr from "ipaddr.js";
import { parse as parseDomain } from "tldts";

import {
  canonicalJsonV1 as canonicalJson,
  resourceCommandSchema,
  resourceCommandReceiptSchema,
  type ResourceAlias,
  type ResourceCommand,
  type ResourceCommandProvenance,
  type ResourceCommandReceipt,
  type ResourceCommandResult,
  type ResourceRef,
} from "@tabhub/shared";

import { createResourceCatalog } from "./resource-catalog.js";

export const resourceCommandFingerprintVersion = "resource-command-v1";

export type ResourceCommandCatalogErrorCode =
  | "RESOURCE_KEY_INVALID"
  | "RESOURCE_NAME_INVALID"
  | "RESOURCE_ALIAS_INVALID"
  | "RESOURCE_KEY_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_NOT_ACTIVE"
  | "RESOURCE_VERSION_CONFLICT"
  | "RESOURCE_RULESET_VERSION_CONFLICT"
  | "RESOURCE_ASSIGNMENT_CONFLICT"
  | "RESOURCE_MEMBERSHIP_CONFLICT"
  | "LOGICAL_PAGE_NOT_FOUND"
  | "RESOURCE_RECEIPT_CORRUPT"
  | "IDEMPOTENCY_KEY_CONFLICT";

const errorMessages: Record<ResourceCommandCatalogErrorCode, string> = {
  RESOURCE_KEY_INVALID: "Resource key must use a normalized namespace:value form",
  RESOURCE_NAME_INVALID: "Resource name is invalid after normalization",
  RESOURCE_ALIAS_INVALID: "Resource alias is invalid after normalization",
  RESOURCE_KEY_CONFLICT: "Resource key already exists",
  RESOURCE_NOT_FOUND: "Resource not found",
  RESOURCE_NOT_ACTIVE: "Resource is not active",
  RESOURCE_VERSION_CONFLICT: "Resource version does not match expected version",
  RESOURCE_RULESET_VERSION_CONFLICT:
    "Resource ruleset version does not match expected version",
  RESOURCE_ASSIGNMENT_CONFLICT:
    "Logical page resource assignment does not match expected head",
  RESOURCE_MEMBERSHIP_CONFLICT:
    "Logical page is not a current member of the expected resource",
  LOGICAL_PAGE_NOT_FOUND: "Logical page not found",
  RESOURCE_RECEIPT_CORRUPT:
    "Stored resource command receipt violates schema invariants",
  IDEMPOTENCY_KEY_CONFLICT:
    "Idempotency key was already used for another command payload",
};

export class ResourceCommandCatalogError extends Error {
  constructor(readonly code: ResourceCommandCatalogErrorCode) {
    super(errorMessages[code]);
    this.name = "ResourceCommandCatalogError";
  }
}

export interface ResourceCommandCatalog {
  change(command: ResourceCommand): ResourceCommandReceipt;
}

export interface ResourceCommandCatalogTestHooks {
  afterResourceEventInsert?: (
    operation: "create" | "rename" | "merge" | "split",
  ) => void;
  afterResourceHeadAdvance?: (
    operation: "create" | "rename" | "merge" | "split",
  ) => void;
  afterResourcePreferenceInsert?: () => void;
  afterResourcePreferenceUpdate?: () => void;
  afterRuleEventInsert?: () => void;
  afterRulesetEventInsert?: () => void;
  afterAssignmentInsert?: (
    operation: "apply_override" | "merge" | "split",
    logicalPageId: number,
  ) => void;
  afterAssignmentHeadAdvance?: (
    operation: "apply_override" | "merge" | "split",
    logicalPageId: number,
  ) => void;
  beforeReceiptInsert?: () => void;
  afterReceiptInsert?: () => void;
}

interface ResourceHeadRow {
  id: number;
  resource_key: string;
  resource_created_at: string;
  event_id: number;
  version: number;
  name: string;
  kind: ResourceRef["kind"];
  access_class: ResourceRef["accessClass"];
  lifecycle_state: ResourceRef["lifecycleState"];
  merged_into_resource_id: number | null;
  event_created_at: string;
}

interface ReceiptRow {
  idempotency_key: string;
  command_kind: ResourceCommandReceipt["commandKind"];
  request_fingerprint: string;
  result_json: string;
  created_at: string;
}

interface ResourcePreferenceRow {
  user_evaluation: 1 | 2 | 3 | null;
  recorded_by: "user" | "agent" | null;
  record_method: "manual" | "on_behalf_of_user" | null;
  updated_at: string;
}

interface RulesetHeadRow {
  id: number;
  version: number;
}

interface RuleHeadRow {
  id: number;
  rule_key: string;
  version: number;
  resource_id: number;
  host_pattern: string;
  match_kind: ResourceAlias["matchKind"];
  path_prefix: string;
  priority: number;
  provenance_class: "user_alias" | "agent_alias" | "system_seed";
  created_by: "system" | "user" | "agent";
  creation_method: "manual" | "on_behalf_of_user" | "derived";
  enabled: 0 | 1;
}

interface AssignmentHeadRow {
  id: number;
  logical_page_id: number;
  action: "assigned" | "removed";
  resource_id: number | null;
  provenance_class:
    | "user_manual"
    | "agent_on_behalf"
    | "explicit_alias"
    | "system_seed"
    | "registrable_domain";
}

type SupportedResourceCommand = Extract<
  ResourceCommand,
  {
    kind:
      | "create"
      | "rename"
      | "set_aliases"
      | "apply_override"
      | "merge"
      | "split"
      | "set_user_evaluation";
  }
>;

const domainParseOptions = Object.freeze({
  allowIcannDomains: true,
  allowPrivateDomains: true,
  detectIp: true,
  detectSpecialUse: true,
  extractHostname: false,
  mixedInputs: false,
  validateHostname: true,
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestFingerprint(command: SupportedResourceCommand): string {
  const { idempotencyKey: _idempotencyKey, ...payload } = command;
  return `${resourceCommandFingerprintVersion};sha256=${sha256(
    canonicalJson(payload),
  )}`;
}

function normalizeName(name: string): string {
  const normalized = name.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new ResourceCommandCatalogError("RESOURCE_NAME_INVALID");
  }
  return normalized;
}

function normalizeResourceKey(resourceKey: string): string {
  const normalized = resourceKey.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length > 256 ||
    !/^[a-z][a-z0-9_-]{0,31}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(
      normalized,
    )
  ) {
    throw new ResourceCommandCatalogError("RESOURCE_KEY_INVALID");
  }
  return normalized;
}

function normalizeHostPattern(hostPattern: string): string {
  const normalizedInput = hostPattern.normalize("NFKC");
  if (/[\u0000-\u001F\u007F]/.test(normalizedInput)) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  const candidate = normalizedInput.trim().replace(/\.+$/, "");
  if (
    candidate.length === 0 ||
    /[*:/@?#\\]/.test(candidate) ||
    candidate.includes("%")
  ) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }

  let host: string;
  try {
    const parsedUrl = new URL(`https://${candidate}/`);
    if (
      parsedUrl.username.length > 0 ||
      parsedUrl.password.length > 0 ||
      parsedUrl.port.length > 0 ||
      parsedUrl.pathname !== "/" ||
      parsedUrl.search.length > 0 ||
      parsedUrl.hash.length > 0
    ) {
      throw new Error("host includes URL components");
    }
    host = parsedUrl.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  } catch {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }

  if (host.length === 0 || host.length > 253) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  if (ipaddr.isValid(host)) {
    let address = ipaddr.parse(host);
    if (address.kind() === "ipv6") {
      const ipv6 = address as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) address = ipv6.toIPv4Address();
    }
    if (address.range() !== "unicast") {
      throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
    }
    return host;
  }

  const parsedDomain = parseDomain(host, domainParseOptions);
  const reservedExample = ["example.com", "example.net", "example.org"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  const syntheticExample = host === "example" || host.endsWith(".example");
  if (
    (parsedDomain.isSpecialUse && !reservedExample && !syntheticExample) ||
    (!parsedDomain.isIcann &&
      !parsedDomain.isPrivate &&
      !reservedExample &&
      !syntheticExample)
  ) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  if (
    !reservedExample &&
    !syntheticExample &&
    parsedDomain.domain === null
  ) {
    // A suffix rule for a public suffix such as `com` would otherwise become
    // an authority over an unbounded portion of the web. Exact-host aliases
    // have no useful meaning for a bare public suffix either.
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  return host;
}

function normalizePathPrefix(pathPrefix: string): string {
  const normalizedInput = pathPrefix.normalize("NFKC");
  if (/[\u0000-\u001F\u007F]/.test(normalizedInput)) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  const candidate = normalizedInput.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 2_048 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[?#\\]/.test(candidate) ||
    /%(?:2f|5c)/i.test(candidate)
  ) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }

  let path: string;
  try {
    path = new URL(candidate, "https://alias.invalid").pathname;
  } catch {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  path = path
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => {
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return /[A-Za-z0-9._~-]/.test(character)
        ? character
        : `%${hex.toUpperCase()}`;
    })
    .replace(/\/$/, "");
  if (path.length === 0) path = "/";
  if (path.length > 2_048) {
    throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
  }
  return path;
}

function aliasSelector(alias: ResourceAlias): string {
  return canonicalJson({
    hostPattern: alias.hostPattern,
    matchKind: alias.matchKind,
    pathPrefix: alias.pathPrefix,
  });
}

function aliasValue(alias: ResourceAlias): string {
  return canonicalJson(alias);
}

function compareAliases(left: ResourceAlias, right: ResourceAlias): number {
  const compareCodeUnits = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  return (
    compareCodeUnits(left.hostPattern, right.hostPattern) ||
    compareCodeUnits(left.matchKind, right.matchKind) ||
    compareCodeUnits(left.pathPrefix, right.pathPrefix) ||
    left.priority - right.priority
  );
}

function normalizeAliases(aliases: ResourceAlias[]): ResourceAlias[] {
  const byValue = new Map<string, ResourceAlias>();
  const priorityBySelector = new Map<string, number>();
  for (const alias of aliases) {
    const normalized: ResourceAlias = {
      hostPattern: normalizeHostPattern(alias.hostPattern),
      matchKind: alias.matchKind,
      pathPrefix: normalizePathPrefix(alias.pathPrefix),
      priority: alias.priority,
    };
    if (ipaddr.isValid(normalized.hostPattern) && normalized.matchKind !== "exact_host") {
      throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
    }
    const selector = aliasSelector(normalized);
    const priorPriority = priorityBySelector.get(selector);
    if (priorPriority !== undefined && priorPriority !== normalized.priority) {
      throw new ResourceCommandCatalogError("RESOURCE_ALIAS_INVALID");
    }
    priorityBySelector.set(selector, normalized.priority);
    byValue.set(aliasValue(normalized), normalized);
  }
  return [...byValue.values()].sort(compareAliases);
}

function derivedRuleKey(resourceId: number, alias: ResourceAlias): string {
  return `alias:${resourceId}:sha256:${sha256(aliasSelector(alias))}`;
}

function normalizeSupportedCommand(
  command: SupportedResourceCommand,
): SupportedResourceCommand {
  switch (command.kind) {
    case "create":
      return {
        ...command,
        resourceKey: normalizeResourceKey(command.resourceKey),
        name: normalizeName(command.name),
      };
    case "rename":
      return { ...command, name: normalizeName(command.name) };
    case "set_aliases":
      return { ...command, aliases: normalizeAliases(command.aliases) };
    case "split":
      return {
        ...command,
        logicalPageIds: [...new Set(command.logicalPageIds)].sort(
          (left, right) => left - right,
        ),
        target:
          command.target.kind === "new"
            ? {
                ...command.target,
                resourceKey: normalizeResourceKey(command.target.resourceKey),
                name: normalizeName(command.target.name),
              }
            : command.target,
      };
    case "apply_override":
    case "merge":
    case "set_user_evaluation":
      return command;
  }
}

function provenanceColumns(provenance: ResourceCommandProvenance): {
  createdBy: "user" | "agent";
  creationMethod: "manual" | "on_behalf_of_user";
  ruleProvenance: "user_alias" | "agent_alias";
} {
  return provenance.actor === "user"
    ? {
        createdBy: "user",
        creationMethod: "manual",
        ruleProvenance: "user_alias",
      }
    : {
        createdBy: "agent",
        creationMethod: "on_behalf_of_user",
        ruleProvenance: "agent_alias",
      };
}

function mapResource(row: ResourceHeadRow): ResourceRef {
  return {
    id: row.id,
    resourceKey: row.resource_key,
    name: row.name,
    kind: row.kind,
    accessClass: row.access_class,
    lifecycleState: row.lifecycle_state,
    mergedIntoResourceId: row.merged_into_resource_id,
    createdAt: row.resource_created_at,
    updatedAt: row.event_created_at,
  };
}

function aliasFromRow(row: RuleHeadRow): ResourceAlias {
  return {
    hostPattern: row.host_pattern,
    matchKind: row.match_kind,
    pathPrefix: row.path_prefix,
    priority: row.priority,
  };
}

function parseReceipt(row: ReceiptRow): ResourceCommandReceipt {
  try {
    return resourceCommandReceiptSchema.parse({
      idempotencyKey: row.idempotency_key,
      commandKind: row.command_kind,
      requestFingerprint: row.request_fingerprint,
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    });
  } catch {
    throw new ResourceCommandCatalogError("RESOURCE_RECEIPT_CORRUPT");
  }
}

export function createResourceCommandCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
  testHooks: ResourceCommandCatalogTestHooks = {},
): ResourceCommandCatalog {
  // Construct the resolver over this exact connection. Alias reprojection is
  // then guaranteed to participate in the command's outer transaction.
  const resourceCatalog = createResourceCatalog(connection, clock);
  const selectReceipt = connection.prepare(`
    SELECT * FROM resource_command_receipts WHERE idempotency_key = ?
  `);
  const insertReceipt = connection.prepare(`
    INSERT INTO resource_command_receipts (
      idempotency_key, command_kind, request_fingerprint, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectResource = connection.prepare(`
    SELECT
      resources.id,
      resources.resource_key,
      resources.created_at AS resource_created_at,
      events.id AS event_id,
      events.version,
      events.name,
      events.kind,
      events.access_class,
      events.lifecycle_state,
      events.merged_into_resource_id,
      events.created_at AS event_created_at
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events ON events.id = heads.event_id
    WHERE resources.id = ?
  `);
  const selectResourceByKey = connection.prepare(`
    SELECT resources.id
    FROM resources
    WHERE resources.resource_key = ?
  `);
  const insertResource = connection.prepare(`
    INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
  `);
  const insertResourceEvent = connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      merged_into_resource_id, created_by, creation_method, supersedes_id,
      created_at
    ) VALUES (
      @resourceId, @version, @name, @kind, @accessClass, @lifecycleState,
      @mergedIntoResourceId, @createdBy, @creationMethod, @supersedesId,
      @createdAt
    )
  `);
  const insertResourceHead = connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `);
  const updateResourceHead = connection.prepare(`
    UPDATE resource_heads SET event_id = ? WHERE resource_id = ?
  `);
  const insertResourcePreference = connection.prepare(`
    INSERT INTO resource_preferences (resource_id, updated_at) VALUES (?, ?)
  `);
  const selectResourcePreference = connection.prepare(`
    SELECT user_evaluation, recorded_by, record_method, updated_at
    FROM resource_preferences WHERE resource_id = ?
  `);
  const updateResourcePreference = connection.prepare(`
    UPDATE resource_preferences
    SET user_evaluation = @evaluation,
      recorded_by = @recordedBy,
      record_method = @recordMethod,
      updated_at = @updatedAt
    WHERE resource_id = @resourceId
  `);
  const selectRulesetHead = connection.prepare(`
    SELECT events.id, events.version
    FROM resource_ruleset_heads AS heads
    JOIN resource_ruleset_events AS events
      ON events.id = heads.ruleset_event_id
    WHERE heads.scope = 'global'
  `);
  const selectMutableRuleHeads = connection.prepare(`
    SELECT rules.*
    FROM resource_match_rule_heads AS heads
    JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
    WHERE rules.resource_id = ?
      AND rules.provenance_class IN ('user_alias', 'agent_alias')
    ORDER BY rules.rule_key
  `);
  const selectEnabledRuleHeads = connection.prepare(`
    SELECT rules.*
    FROM resource_match_rule_heads AS heads
    JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
    WHERE rules.resource_id = ? AND rules.enabled = 1
    ORDER BY rules.rule_key
  `);
  const insertRule = connection.prepare(`
    INSERT INTO resource_match_rules (
      rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, supersedes_id,
      enabled, created_at
    ) VALUES (
      @ruleKey, @version, @resourceId, @hostPattern, @matchKind, @pathPrefix,
      @priority, @provenanceClass, @createdBy, @creationMethod, @supersedesId,
      @enabled, @createdAt
    )
  `);
  const insertRuleHead = connection.prepare(`
    INSERT INTO resource_match_rule_heads (rule_key, rule_id) VALUES (?, ?)
  `);
  const updateRuleHead = connection.prepare(`
    UPDATE resource_match_rule_heads SET rule_id = ? WHERE rule_key = ?
  `);
  const insertRulesetEvent = connection.prepare(`
    INSERT INTO resource_ruleset_events (
      version, supersedes_id, created_by, creation_method, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const updateRulesetHead = connection.prepare(`
    UPDATE resource_ruleset_heads
    SET ruleset_event_id = ?
    WHERE scope = 'global'
  `);
  const selectLogicalPage = connection.prepare(`
    SELECT id FROM logical_pages WHERE id = ?
  `);
  const selectCurrentAssignment = connection.prepare(`
    SELECT assignments.*
    FROM logical_page_resource_heads AS heads
    JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = heads.assignment_id
    WHERE heads.logical_page_id = ?
  `);
  const selectCurrentMemberships = connection.prepare(`
    SELECT assignments.*
    FROM logical_page_resource_heads AS heads
    JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = heads.assignment_id
    WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    ORDER BY assignments.logical_page_id
  `);
  const insertAssignment = connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, rule_id, source_fingerprint, supersedes_id, created_at
    ) VALUES (
      @logicalPageId, @action, @resourceId, @provenanceClass, @assignedBy,
      @assignmentMethod, NULL, @sourceFingerprint, @supersedesId, @createdAt
    )
  `);
  const upsertAssignmentHead = connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (?, ?)
    ON CONFLICT (logical_page_id) DO UPDATE SET
      assignment_id = excluded.assignment_id
  `);

  const requireResource = (resourceId: number): ResourceHeadRow => {
    const row = selectResource.get(resourceId) as ResourceHeadRow | undefined;
    if (row === undefined) {
      throw new ResourceCommandCatalogError("RESOURCE_NOT_FOUND");
    }
    return row;
  };

  const requireActiveExpectedResource = (
    resourceId: number,
    expectedVersion: number,
  ): ResourceHeadRow => {
    const row = requireResource(resourceId);
    if (row.lifecycle_state !== "active") {
      throw new ResourceCommandCatalogError("RESOURCE_NOT_ACTIVE");
    }
    if (row.version !== expectedVersion) {
      throw new ResourceCommandCatalogError("RESOURCE_VERSION_CONFLICT");
    }
    return row;
  };

  const requireRuleset = (expectedVersion?: number): RulesetHeadRow => {
    const row = selectRulesetHead.get() as RulesetHeadRow | undefined;
    if (row === undefined) {
      throw new Error("Resource ruleset head is missing");
    }
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new ResourceCommandCatalogError(
        "RESOURCE_RULESET_VERSION_CONFLICT",
      );
    }
    return row;
  };

  const commandResource = (row: ResourceHeadRow) => ({
    resource: mapResource(row),
    version: row.version,
  });

  const appendAssignment = (
    operation: "apply_override" | "merge" | "split",
    logicalPageId: number,
    resourceId: number | null,
    current: AssignmentHeadRow | undefined,
    provenance: ResourceCommandProvenance,
    fingerprint: string,
    createdAt: string,
  ): number => {
    const columns = provenanceColumns(provenance);
    const assignmentId = Number(
      insertAssignment.run({
        logicalPageId,
        action: resourceId === null ? "removed" : "assigned",
        resourceId,
        provenanceClass:
          provenance.actor === "user" ? "user_manual" : "agent_on_behalf",
        assignedBy: columns.createdBy,
        assignmentMethod: columns.creationMethod,
        sourceFingerprint: `${fingerprint};logicalPageId=${logicalPageId}`,
        supersedesId: current?.id ?? null,
        createdAt,
      }).lastInsertRowid,
    );
    testHooks.afterAssignmentInsert?.(operation, logicalPageId);
    upsertAssignmentHead.run(logicalPageId, assignmentId);
    testHooks.afterAssignmentHeadAdvance?.(operation, logicalPageId);
    return assignmentId;
  };

  const createInlineResource = (
    input: {
      resourceKey: string;
      name: string;
      resourceKind: ResourceRef["kind"];
      accessClass: ResourceRef["accessClass"];
    },
    provenanceInput: ResourceCommandProvenance,
    createdAt: string,
  ): ResourceHeadRow => {
    if (selectResourceByKey.get(input.resourceKey) !== undefined) {
      throw new ResourceCommandCatalogError("RESOURCE_KEY_CONFLICT");
    }
    const resourceId = Number(
      insertResource.run(input.resourceKey, createdAt).lastInsertRowid,
    );
    const provenance = provenanceColumns(provenanceInput);
    const eventId = Number(
      insertResourceEvent.run({
        resourceId,
        version: 1,
        name: input.name,
        kind: input.resourceKind,
        accessClass: input.accessClass,
        lifecycleState: "active",
        mergedIntoResourceId: null,
        createdBy: provenance.createdBy,
        creationMethod: provenance.creationMethod,
        supersedesId: null,
        createdAt,
      }).lastInsertRowid,
    );
    testHooks.afterResourceEventInsert?.("split");
    insertResourceHead.run(resourceId, eventId);
    testHooks.afterResourceHeadAdvance?.("split");
    insertResourcePreference.run(resourceId, createdAt);
    testHooks.afterResourcePreferenceInsert?.();
    return requireResource(resourceId);
  };

  const persistReceipt = (
    command: SupportedResourceCommand,
    fingerprint: string,
    result: ResourceCommandResult,
    createdAt: string,
  ): ResourceCommandReceipt => {
    const receipt = resourceCommandReceiptSchema.parse({
      idempotencyKey: command.idempotencyKey,
      commandKind: command.kind,
      requestFingerprint: fingerprint,
      result,
      createdAt,
    });
    testHooks.beforeReceiptInsert?.();
    insertReceipt.run(
      receipt.idempotencyKey,
      receipt.commandKind,
      receipt.requestFingerprint,
      canonicalJson(receipt.result),
      receipt.createdAt,
    );
    testHooks.afterReceiptInsert?.();
    return receipt;
  };

  const createResource = (
    command: Extract<SupportedResourceCommand, { kind: "create" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    if (selectResourceByKey.get(command.resourceKey) !== undefined) {
      throw new ResourceCommandCatalogError("RESOURCE_KEY_CONFLICT");
    }
    const createdAt = clock().toISOString();
    const resourceId = Number(
      insertResource.run(command.resourceKey, createdAt).lastInsertRowid,
    );
    const provenance = provenanceColumns(command.provenance);
    const eventId = Number(
      insertResourceEvent.run({
        resourceId,
        version: 1,
        name: command.name,
        kind: command.resourceKind,
        accessClass: command.accessClass,
        lifecycleState: "active",
        mergedIntoResourceId: null,
        createdBy: provenance.createdBy,
        creationMethod: provenance.creationMethod,
        supersedesId: null,
        createdAt,
      }).lastInsertRowid,
    );
    testHooks.afterResourceEventInsert?.("create");
    insertResourceHead.run(resourceId, eventId);
    testHooks.afterResourceHeadAdvance?.("create");
    insertResourcePreference.run(resourceId, createdAt);
    testHooks.afterResourcePreferenceInsert?.();
    const row = requireResource(resourceId);
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "create",
        changed: true,
        resource: { resource: mapResource(row), version: row.version },
      },
      createdAt,
    );
  };

  const renameResource = (
    command: Extract<SupportedResourceCommand, { kind: "rename" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    const current = requireActiveExpectedResource(
      command.resourceId,
      command.expectedVersion,
    );
    const createdAt = clock().toISOString();
    if (current.name === command.name) {
      return persistReceipt(
        command,
        fingerprint,
        {
          kind: "rename",
          changed: false,
          resource: {
            resource: mapResource(current),
            version: current.version,
          },
        },
        createdAt,
      );
    }

    const provenance = provenanceColumns(command.provenance);
    const eventId = Number(
      insertResourceEvent.run({
        resourceId: current.id,
        version: current.version + 1,
        name: command.name,
        kind: current.kind,
        accessClass: current.access_class,
        lifecycleState: current.lifecycle_state,
        mergedIntoResourceId: current.merged_into_resource_id,
        createdBy: provenance.createdBy,
        creationMethod: provenance.creationMethod,
        supersedesId: current.event_id,
        createdAt,
      }).lastInsertRowid,
    );
    testHooks.afterResourceEventInsert?.("rename");
    updateResourceHead.run(eventId, current.id);
    testHooks.afterResourceHeadAdvance?.("rename");
    const renamed = requireResource(current.id);
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "rename",
        changed: true,
        resource: {
          resource: mapResource(renamed),
          version: renamed.version,
        },
      },
      createdAt,
    );
  };

  const setAliases = (
    command: Extract<SupportedResourceCommand, { kind: "set_aliases" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    requireActiveExpectedResource(
      command.resourceId,
      command.expectedResourceVersion,
    );
    const ruleset = requireRuleset(command.expectedRulesetVersion);
    const existing = selectMutableRuleHeads.all(
      command.resourceId,
    ) as RuleHeadRow[];
    const existingBySelector = new Map<string, RuleHeadRow[]>();
    for (const row of existing) {
      const selector = aliasSelector(aliasFromRow(row));
      const rows = existingBySelector.get(selector) ?? [];
      rows.push(row);
      existingBySelector.set(selector, rows);
    }
    const desiredBySelector = new Map(
      command.aliases.map((alias) => [aliasSelector(alias), alias]),
    );
    const changes: Array<
      | { kind: "insert"; alias: ResourceAlias }
      | {
          kind: "succeed";
          current: RuleHeadRow;
          alias: ResourceAlias;
          enabled: 0 | 1;
        }
    > = [];

    for (const [selector, rows] of existingBySelector) {
      const desired = desiredBySelector.get(selector);
      if (desired === undefined) {
        for (const row of rows) {
          if (row.enabled === 1) {
            changes.push({
              kind: "succeed",
              current: row,
              alias: aliasFromRow(row),
              enabled: 0,
            });
          }
        }
        continue;
      }
      const keeper =
        rows.find(
          (row) => row.enabled === 1 && row.priority === desired.priority,
        ) ?? rows[0]!;
      for (const row of rows) {
        if (row.id === keeper.id) {
          if (row.enabled === 0 || row.priority !== desired.priority) {
            changes.push({
              kind: "succeed",
              current: row,
              alias: desired,
              enabled: 1,
            });
          }
        } else if (row.enabled === 1) {
          changes.push({
            kind: "succeed",
            current: row,
            alias: aliasFromRow(row),
            enabled: 0,
          });
        }
      }
    }
    for (const alias of command.aliases) {
      if (!existingBySelector.has(aliasSelector(alias))) {
        changes.push({ kind: "insert", alias });
      }
    }

    const createdAt = clock().toISOString();
    if (changes.length === 0) {
      return persistReceipt(
        command,
        fingerprint,
        {
          kind: "set_aliases",
          changed: false,
          resourceId: command.resourceId,
          aliases: command.aliases,
          rulesetVersion: ruleset.version,
        },
        createdAt,
      );
    }

    const provenance = provenanceColumns(command.provenance);
    for (const change of changes) {
      if (change.kind === "insert") {
        const ruleKey = derivedRuleKey(command.resourceId, change.alias);
        const ruleId = Number(
          insertRule.run({
            ruleKey,
            version: 1,
            resourceId: command.resourceId,
            hostPattern: change.alias.hostPattern,
            matchKind: change.alias.matchKind,
            pathPrefix: change.alias.pathPrefix,
            priority: change.alias.priority,
            provenanceClass: provenance.ruleProvenance,
            createdBy: provenance.createdBy,
            creationMethod: provenance.creationMethod,
            supersedesId: null,
            enabled: 1,
            createdAt,
          }).lastInsertRowid,
        );
        testHooks.afterRuleEventInsert?.();
        insertRuleHead.run(ruleKey, ruleId);
        continue;
      }

      const ruleId = Number(
        insertRule.run({
          ruleKey: change.current.rule_key,
          version: change.current.version + 1,
          resourceId: command.resourceId,
          hostPattern: change.alias.hostPattern,
          matchKind: change.alias.matchKind,
          pathPrefix: change.alias.pathPrefix,
          priority: change.alias.priority,
          provenanceClass: provenance.ruleProvenance,
          createdBy: provenance.createdBy,
          creationMethod: provenance.creationMethod,
          supersedesId: change.current.id,
          enabled: change.enabled,
          createdAt,
        }).lastInsertRowid,
      );
      testHooks.afterRuleEventInsert?.();
      updateRuleHead.run(ruleId, change.current.rule_key);
    }

    const nextRulesetVersion = ruleset.version + 1;
    const rulesetEventId = Number(
      insertRulesetEvent.run(
        nextRulesetVersion,
        ruleset.id,
        provenance.createdBy,
        provenance.creationMethod,
        createdAt,
      ).lastInsertRowid,
    );
    testHooks.afterRulesetEventInsert?.();
    updateRulesetHead.run(rulesetEventId);

    // Alias edits change resolver semantics. Rebuild current projections in
    // this same outer transaction so rules, ruleset version and resolutions
    // cannot become observably inconsistent.
    resourceCatalog.backfill();
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "set_aliases",
        changed: true,
        resourceId: command.resourceId,
        aliases: command.aliases,
        rulesetVersion: nextRulesetVersion,
      },
      createdAt,
    );
  };

  const applyOverride = (
    command: Extract<SupportedResourceCommand, { kind: "apply_override" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    if (selectLogicalPage.get(command.logicalPageId) === undefined) {
      throw new ResourceCommandCatalogError("LOGICAL_PAGE_NOT_FOUND");
    }
    const current = selectCurrentAssignment.get(command.logicalPageId) as
      | AssignmentHeadRow
      | undefined;
    if ((current?.id ?? null) !== command.expectedAssignmentId) {
      throw new ResourceCommandCatalogError("RESOURCE_ASSIGNMENT_CONFLICT");
    }
    const target =
      command.resourceId === null
        ? null
        : requireResource(command.resourceId);
    if (target !== null && target.lifecycle_state !== "active") {
      throw new ResourceCommandCatalogError("RESOURCE_NOT_ACTIVE");
    }

    const currentIsExplicit =
      current?.action === "assigned" &&
      (current.provenance_class === "user_manual" ||
        current.provenance_class === "agent_on_behalf");
    const changed =
      command.resourceId === null
        ? currentIsExplicit
        : !(
            currentIsExplicit && current?.resource_id === command.resourceId
          );
    const createdAt = clock().toISOString();
    if (changed) {
      appendAssignment(
        "apply_override",
        command.logicalPageId,
        command.resourceId,
        current,
        command.provenance,
        fingerprint,
        createdAt,
      );
    }
    const resolution = resourceCatalog.resolvePage(command.logicalPageId);
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "apply_override",
        changed,
        logicalPageId: command.logicalPageId,
        resource: target === null ? null : commandResource(target),
        resolution,
      },
      createdAt,
    );
  };

  const mergeResources = (
    command: Extract<SupportedResourceCommand, { kind: "merge" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    const source = requireActiveExpectedResource(
      command.sourceResourceId,
      command.expectedSourceVersion,
    );
    const target = requireActiveExpectedResource(
      command.targetResourceId,
      command.expectedTargetVersion,
    );
    const ruleset = requireRuleset(command.expectedRulesetVersion);
    const aliases = selectEnabledRuleHeads.all(source.id) as RuleHeadRow[];
    const memberships = selectCurrentMemberships.all(
      source.id,
    ) as AssignmentHeadRow[];
    const createdAt = clock().toISOString();
    const provenance = provenanceColumns(command.provenance);

    const mergedEventId = Number(
      insertResourceEvent.run({
        resourceId: source.id,
        version: source.version + 1,
        name: source.name,
        kind: source.kind,
        accessClass: source.access_class,
        lifecycleState: "merged",
        mergedIntoResourceId: target.id,
        createdBy: provenance.createdBy,
        creationMethod: provenance.creationMethod,
        supersedesId: source.event_id,
        createdAt,
      }).lastInsertRowid,
    );
    testHooks.afterResourceEventInsert?.("merge");
    updateResourceHead.run(mergedEventId, source.id);
    testHooks.afterResourceHeadAdvance?.("merge");

    for (const alias of aliases) {
      const ruleId = Number(
        insertRule.run({
          ruleKey: alias.rule_key,
          version: alias.version + 1,
          resourceId: target.id,
          hostPattern: alias.host_pattern,
          matchKind: alias.match_kind,
          pathPrefix: alias.path_prefix,
          priority: alias.priority,
          provenanceClass: alias.provenance_class,
          createdBy: alias.created_by,
          creationMethod: alias.creation_method,
          supersedesId: alias.id,
          enabled: 1,
          createdAt,
        }).lastInsertRowid,
      );
      testHooks.afterRuleEventInsert?.();
      updateRuleHead.run(ruleId, alias.rule_key);
    }

    let rulesetVersion = ruleset.version;
    if (aliases.length > 0) {
      rulesetVersion += 1;
      const rulesetEventId = Number(
        insertRulesetEvent.run(
          rulesetVersion,
          ruleset.id,
          provenance.createdBy,
          provenance.creationMethod,
          createdAt,
        ).lastInsertRowid,
      );
      testHooks.afterRulesetEventInsert?.();
      updateRulesetHead.run(rulesetEventId);
    }

    const movedLogicalPageIds: number[] = [];
    for (const membership of memberships) {
      appendAssignment(
        "merge",
        membership.logical_page_id,
        target.id,
        membership,
        command.provenance,
        fingerprint,
        createdAt,
      );
      resourceCatalog.resolvePage(membership.logical_page_id);
      movedLogicalPageIds.push(membership.logical_page_id);
    }

    // Retargeted aliases can affect pages that were ambiguous/unmatched and
    // therefore had no current membership in the merge source. Reproject the
    // complete corpus before the receipt makes this command observable.
    if (aliases.length > 0) resourceCatalog.backfill();

    const merged = requireResource(source.id);
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "merge",
        changed: true,
        source: commandResource(merged),
        target: commandResource(target),
        movedLogicalPageIds,
        rulesetVersion,
      },
      createdAt,
    );
  };

  const splitResource = (
    command: Extract<SupportedResourceCommand, { kind: "split" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    const source = requireActiveExpectedResource(
      command.sourceResourceId,
      command.expectedSourceVersion,
    );
    const memberships: AssignmentHeadRow[] = [];
    for (const logicalPageId of command.logicalPageIds) {
      if (selectLogicalPage.get(logicalPageId) === undefined) {
        throw new ResourceCommandCatalogError("LOGICAL_PAGE_NOT_FOUND");
      }
      const membership = selectCurrentAssignment.get(logicalPageId) as
        | AssignmentHeadRow
        | undefined;
      if (
        membership?.action !== "assigned" ||
        membership.resource_id !== source.id
      ) {
        throw new ResourceCommandCatalogError("RESOURCE_MEMBERSHIP_CONFLICT");
      }
      memberships.push(membership);
    }

    const createdAt = clock().toISOString();
    const target =
      command.target.kind === "existing"
        ? requireActiveExpectedResource(
            command.target.resourceId,
            command.target.expectedVersion,
          )
        : createInlineResource(
            command.target,
            command.provenance,
            createdAt,
          );

    for (const membership of memberships) {
      appendAssignment(
        "split",
        membership.logical_page_id,
        target.id,
        membership,
        command.provenance,
        fingerprint,
        createdAt,
      );
      resourceCatalog.resolvePage(membership.logical_page_id);
    }
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "split",
        changed: true,
        source: commandResource(source),
        target: commandResource(target),
        movedLogicalPageIds: memberships.map(({ logical_page_id }) =>
          logical_page_id
        ),
      },
      createdAt,
    );
  };

  const setUserEvaluation = (
    command: Extract<SupportedResourceCommand, { kind: "set_user_evaluation" }>,
    fingerprint: string,
  ): ResourceCommandReceipt => {
    const resource = requireResource(command.resourceId);
    if (resource.lifecycle_state !== "active") {
      throw new ResourceCommandCatalogError("RESOURCE_NOT_ACTIVE");
    }
    const current = selectResourcePreference.get(command.resourceId) as
      | ResourcePreferenceRow
      | undefined;
    if (current === undefined) {
      throw new ResourceCommandCatalogError("RESOURCE_RECEIPT_CORRUPT");
    }
    const provenance = command.evaluation === null ? null : command.provenance;
    const recordedBy = provenance?.actor ?? null;
    const recordMethod = provenance?.method ?? null;
    const changed = current.user_evaluation !== command.evaluation ||
      current.recorded_by !== recordedBy ||
      current.record_method !== recordMethod;
    const createdAt = clock().toISOString();
    const updatedAt = changed ? createdAt : current.updated_at;
    if (changed) {
      updateResourcePreference.run({
        resourceId: command.resourceId,
        evaluation: command.evaluation,
        recordedBy,
        recordMethod,
        updatedAt,
      });
      testHooks.afterResourcePreferenceUpdate?.();
    }
    return persistReceipt(
      command,
      fingerprint,
      {
        kind: "set_user_evaluation",
        changed,
        resourceId: command.resourceId,
        evaluation: command.evaluation,
        provenance,
        updatedAt,
      },
      createdAt,
    );
  };

  const execute = connection.transaction(
    (command: SupportedResourceCommand): ResourceCommandReceipt => {
      const fingerprint = requestFingerprint(command);
      const replay = selectReceipt.get(command.idempotencyKey) as
        | ReceiptRow
        | undefined;
      if (replay !== undefined) {
        if (replay.request_fingerprint !== fingerprint) {
          throw new ResourceCommandCatalogError("IDEMPOTENCY_KEY_CONFLICT");
        }
        if (replay.command_kind !== command.kind) {
          throw new ResourceCommandCatalogError("RESOURCE_RECEIPT_CORRUPT");
        }
        return parseReceipt(replay);
      }

      switch (command.kind) {
        case "create":
          return createResource(command, fingerprint);
        case "rename":
          return renameResource(command, fingerprint);
        case "set_aliases":
          return setAliases(command, fingerprint);
        case "apply_override":
          return applyOverride(command, fingerprint);
        case "merge":
          return mergeResources(command, fingerprint);
        case "split":
          return splitResource(command, fingerprint);
        case "set_user_evaluation":
          return setUserEvaluation(command, fingerprint);
      }
    },
  );

  return {
    change(input) {
      const parsed = resourceCommandSchema.parse(input);
      return execute(normalizeSupportedCommand(parsed));
    },
  };
}
