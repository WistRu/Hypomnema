import type Database from "better-sqlite3";

import type {
  RetentionCandidate,
  RetentionDecisionResponse,
  RetentionReason,
  RetentionReviewResponse,
  RetentionTrashResponse,
  RestoreRetention,
  SetRetentionDecision,
  RetentionWarning,
} from "@tabhub/shared";

import type { TabCatalog } from "./tab-catalog.js";

const REVIEW_SCORE_THRESHOLD = 0.55;
const LATER_DELAY_MS = 7 * 24 * 60 * 60 * 1_000;
const TRASH_DELAY_MS = 7 * 24 * 60 * 60 * 1_000;

interface RetentionSignalRow {
  id: number;
  is_open: 0 | 1;
  content_count: number;
  custom_field_count: number;
  engaged_ms: number;
  link_count: number;
  open_instance_count: number;
  pinned_count: number;
  workspace_count: number;
}

interface RetentionTrashRow {
  tab_id: number;
  decided_by: "user" | "agent";
  trashed_at: string;
  purge_at: string;
}

export interface RetentionCatalog {
  decide(
    tabId: number,
    input: SetRetentionDecision,
  ): RetentionDecisionResponse;
  listTrash(input: { page: number; pageSize: number }): RetentionTrashResponse;
  purgeDue(): number;
  restore(tabId: number, input: RestoreRetention): RetentionDecisionResponse;
  review(input: { page: number; pageSize: number }): RetentionReviewResponse;
}

export class RetentionTabNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly tabId: number) {
    super(`No tab exists with id ${tabId}`);
    this.name = "RetentionTabNotFoundError";
  }
}

export class RetentionTabOpenError extends Error {
  readonly code = "TAB_STILL_OPEN";

  constructor(readonly tabId: number) {
    super(`Tab ${tabId} still has a live physical instance`);
    this.name = "RetentionTabOpenError";
  }
}

function isSearchResultsPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      hostname === "google.com" ||
      hostname.endsWith(".google.com") ||
      hostname === "google.ru" ||
      hostname.endsWith(".google.ru")
    ) {
      return url.pathname === "/search";
    }
    if (
      hostname === "yandex.ru" ||
      hostname.endsWith(".yandex.ru") ||
      hostname === "ya.ru"
    ) {
      return url.pathname.startsWith("/search");
    }
    return (
      hostname === "bing.com" && url.pathname.startsWith("/search")
    );
  } catch {
    return false;
  }
}

function candidateFromSignals(
  row: RetentionSignalRow,
  tabCatalog: TabCatalog,
): RetentionCandidate | undefined {
  const tab = tabCatalog.getTab(row.id);
  if (tab === undefined) return undefined;

  const reasons: RetentionReason[] = [];
  let score = 0.1;
  if (row.is_open === 0) {
    reasons.push("closed");
    score += 0.2;
  }
  if (isSearchResultsPage(tab.url)) {
    reasons.push("search_results");
    score += 0.3;
  }
  if (row.content_count === 0) {
    reasons.push("no_captured_content");
    score += 0.15;
  }
  if (row.engaged_ms === 0) {
    reasons.push("no_engaged_activity");
    score += 0.15;
  }
  if (row.custom_field_count === 0) {
    reasons.push("no_custom_fields");
    score += 0.05;
  }
  if (row.link_count === 0) {
    reasons.push("no_links");
    score += 0.05;
  }

  const warnings: RetentionWarning[] = [];
  if (row.open_instance_count > 0) {
    warnings.push({ kind: "open_instances", count: row.open_instance_count });
  }
  if (row.pinned_count > 0) {
    warnings.push({ kind: "pinned", count: row.pinned_count });
  }
  if (row.workspace_count > 0) {
    warnings.push({ kind: "workspace", count: row.workspace_count });
  }
  if (row.link_count > 0) {
    warnings.push({ kind: "links", count: row.link_count });
  }
  if (row.content_count > 0) {
    warnings.push({ kind: "captured_content", count: row.content_count });
  }

  const normalizedScore = Math.min(1, Number(score.toFixed(2)));
  if (normalizedScore < REVIEW_SCORE_THRESHOLD || reasons.length === 0) {
    return undefined;
  }

  return { tab, score: normalizedScore, reasons, warnings };
}

export function createRetentionCatalog(
  connection: Database.Database,
  tabCatalog: TabCatalog,
  contextEnabled = false,
  clock: () => Date = () => new Date(),
): RetentionCatalog {
  const selectSignals = connection.prepare(`
    SELECT
      tabs.id,
      tabs.is_open,
      CASE
        WHEN contents.tab_id IS NOT NULL
         AND (contents.text IS NOT NULL OR contents.summary IS NOT NULL)
        THEN 1 ELSE 0
      END AS content_count,
      (SELECT COUNT(*) FROM custom_fields WHERE tab_id = tabs.id)
        AS custom_field_count,
      COALESCE(tab_page_activity_totals.engaged_ms, 0) AS engaged_ms,
      (
        SELECT COUNT(*)
        FROM knowledge_entities
        JOIN relations
          ON relations.from_entity_id = knowledge_entities.id
          OR relations.to_entity_id = knowledge_entities.id
        WHERE knowledge_entities.kind = 'tab'
          AND knowledge_entities.tab_id = tabs.id
      ) AS link_count,
      (SELECT COUNT(*) FROM tab_instances WHERE tab_id = tabs.id)
        AS open_instance_count,
      (
        SELECT COUNT(*)
        FROM tab_instances
        WHERE tab_id = tabs.id AND pinned = 1
      ) AS pinned_count,
      (
        SELECT COUNT(*)
        FROM saved_workspace_items
        WHERE canonical_tab_id = tabs.id
      ) AS workspace_count
    FROM tabs
    LEFT JOIN contents ON contents.tab_id = tabs.id
    LEFT JOIN page_retention ON page_retention.tab_id = tabs.id
    LEFT JOIN tab_page_activity_totals
      ON tab_page_activity_totals.browser = tabs.browser
     AND tab_page_activity_totals.url_normalized = tabs.url_normalized
    WHERE tabs.status = 'inbox'
      AND tabs.importance = 0
      ${contextEnabled ? `AND NOT EXISTS (
        SELECT 1
        FROM context_entries AS protection
        WHERE protection.logical_page_id = tabs.logical_page_id
          AND protection.kind IN ('purpose', 'next_action')
          AND protection.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM context_entries AS superseding
            WHERE superseding.supersedes_id = protection.id
          )
          AND (
            protection.actor = 'user'
            OR (
              protection.actor = 'agent'
              AND EXISTS (
                SELECT 1
                FROM context_entry_reviews AS review
                WHERE review.context_entry_id = protection.id
                  AND review.verdict = 'accepted'
                  AND NOT EXISTS (
                    SELECT 1 FROM context_entry_reviews AS later_review
                    WHERE later_review.supersedes_id = review.id
                  )
              )
            )
          )
      )` : ""}
      AND (
        page_retention.tab_id IS NULL
        OR (
          page_retention.state = 'deferred'
          AND page_retention.review_after <= ?
        )
      )
    ORDER BY tabs.id
  `);
  const selectTab = connection.prepare(`
    SELECT
      tabs.id,
      tabs.is_open,
      (SELECT COUNT(*) FROM tab_instances WHERE tab_id = tabs.id)
        AS open_instance_count
    FROM tabs
    WHERE tabs.id = ?
  `);
  const upsertDecision = connection.prepare(`
    INSERT INTO page_retention (
      tab_id,
      state,
      decided_by,
      decided_at,
      review_after,
      trashed_at,
      purge_at
    ) VALUES (
      @tabId,
      @state,
      @decidedBy,
      @decidedAt,
      @reviewAfter,
      @trashedAt,
      @purgeAt
    )
    ON CONFLICT (tab_id) DO UPDATE SET
      state = excluded.state,
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at,
      review_after = excluded.review_after,
      trashed_at = excluded.trashed_at,
      purge_at = excluded.purge_at
  `);
  const selectTrash = connection.prepare(`
    SELECT tab_id, decided_by, trashed_at, purge_at
    FROM page_retention
    WHERE state = 'trashed'
    ORDER BY purge_at, tab_id
    LIMIT ? OFFSET ?
  `);
  const countTrash = connection.prepare(`
    SELECT COUNT(*) AS total
    FROM page_retention
    WHERE state = 'trashed'
  `);
  const selectDueTrash = connection.prepare(`
    SELECT tabs.id, tabs.browser, tabs.url_normalized
    FROM page_retention
    JOIN tabs ON tabs.id = page_retention.tab_id
    WHERE page_retention.state = 'trashed'
      AND page_retention.purge_at <= ?
      AND tabs.is_open = 0
      AND NOT EXISTS (
        SELECT 1 FROM tab_instances WHERE tab_id = tabs.id
      )
    ORDER BY page_retention.purge_at, tabs.id
  `);
  const deleteWorkspaceItems = connection.prepare(`
    DELETE FROM saved_workspace_items
    WHERE canonical_tab_id = ?
  `);
  const deletePageActivity = connection.prepare(`
    DELETE FROM tab_page_activity_totals
    WHERE browser = ? AND url_normalized = ?
  `);
  const deleteTab = connection.prepare("DELETE FROM tabs WHERE id = ?");

  const purgeDue = connection.transaction((): number => {
    const due = selectDueTrash.all(clock().toISOString()) as Array<{
      id: number;
      browser: string;
      url_normalized: string;
    }>;
    for (const tab of due) {
      deleteWorkspaceItems.run(tab.id);
      deletePageActivity.run(tab.browser, tab.url_normalized);
      deleteTab.run(tab.id);
    }
    return due.length;
  });

  const decide = connection.transaction(
    (
      tabId: number,
      input: SetRetentionDecision,
    ): RetentionDecisionResponse => {
      const tab = selectTab.get(tabId) as
        | { id: number; is_open: 0 | 1; open_instance_count: number }
        | undefined;
      if (tab === undefined) {
        throw new RetentionTabNotFoundError(tabId);
      }
      if (input.decision === "trash" && tab.open_instance_count > 0) {
        throw new RetentionTabOpenError(tabId);
      }
      const decisionTime = clock();
      const decidedAt = decisionTime.toISOString();
      const state =
        input.decision === "keep"
          ? "kept"
          : input.decision === "later"
            ? "deferred"
            : "trashed";
      const reviewAfter =
        input.decision === "later"
          ? new Date(decisionTime.getTime() + LATER_DELAY_MS).toISOString()
          : null;
      const trashedAt = input.decision === "trash" ? decidedAt : null;
      const purgeAt =
        input.decision === "trash"
          ? new Date(decisionTime.getTime() + TRASH_DELAY_MS).toISOString()
          : null;
      upsertDecision.run({
        tabId,
        state,
        decidedBy: input.decidedBy,
        decidedAt,
        reviewAfter,
        trashedAt,
        purgeAt,
      });
      return {
        tabId,
        decision: input.decision,
        state,
        decidedBy: input.decidedBy,
        decidedAt,
        reviewAfter,
        trashedAt,
        purgeAt,
      };
    },
  );

  return {
    decide,
    listTrash(input) {
      const total = (countTrash.get() as { total: number }).total;
      const offset = (input.page - 1) * input.pageSize;
      const items = (
        selectTrash.all(input.pageSize, offset) as RetentionTrashRow[]
      ).flatMap((row) => {
        const tab = tabCatalog.getTab(row.tab_id);
        return tab === undefined
          ? []
          : [
              {
                tab,
                decidedBy: row.decided_by,
                trashedAt: row.trashed_at,
                purgeAt: row.purge_at,
              },
            ];
      });
      return { items, total, page: input.page, pageSize: input.pageSize };
    },
    purgeDue,
    restore(tabId, input) {
      return decide(tabId, { decision: "keep", decidedBy: input.decidedBy });
    },
    review(input) {
      const candidates = (
        selectSignals.all(clock().toISOString()) as RetentionSignalRow[]
      )
        .map((row) => candidateFromSignals(row, tabCatalog))
        .filter(
          (candidate): candidate is RetentionCandidate =>
            candidate !== undefined,
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.tab.id - right.tab.id,
        );
      const offset = (input.page - 1) * input.pageSize;
      return {
        items: candidates.slice(offset, offset + input.pageSize),
        total: candidates.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    },
  };
}
