import type Database from "better-sqlite3";

import { classifyLiveAcquisitionUrl } from "./live-acquisition-policy.js";
import type {
  LiveAcquisitionActionLedger,
  PlannedLiveAcquisitionAction,
} from "./live-acquisition-action-ledger.js";
import type { ResourceUrlPreview } from "./resource-catalog.js";

export interface LiveAcquisitionMaterializer {
  admitSeedOriginsForClaim(jobId: number): readonly PlannedLiveAcquisitionAction[];
}

interface MaterializerOptions {
  readonly actionLedger: LiveAcquisitionActionLedger;
  readonly clock?: () => Date;
  readonly previewResourceUrl: (url: string, rulesetVersion: number) => ResourceUrlPreview;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createLiveAcquisitionMaterializer(
  connection: Database.Database,
  options: MaterializerOptions,
): LiveAcquisitionMaterializer {
  const clock = options.clock ?? (() => new Date());

  return {
    admitSeedOriginsForClaim(jobId) {
      const at = clock().toISOString();
      const owner = connection.prepare(`
        SELECT consent.id AS consent_id, run.id AS run_id,
          payload.approved_origins_json,
          resource_generation.resource_id,
          ruleset.version AS ruleset_version
        FROM research_runs AS run
        JOIN privacy_subject_generations AS run_generation
          ON run_generation.subject_kind = 'research_run'
          AND run_generation.research_run_id = run.id
          AND run_generation.is_active = 1
        JOIN live_acquisition_consents AS consent
          ON consent.coordinator_job_id = run.job_id
          AND consent.coordinator_run_generation_id = run_generation.id
        JOIN live_acquisition_consent_payloads AS payload
          ON payload.consent_id = consent.id
        JOIN live_acquisition_runtime_state AS runtime
          ON runtime.singleton_id = 1 AND runtime.runtime_epoch = consent.runtime_epoch
        JOIN privacy_subject_generations AS resource_generation
          ON resource_generation.id = consent.resource_generation_id
          AND resource_generation.is_active = 1
        JOIN research_history_epochs AS history
          ON history.id = consent.history_epoch_id AND history.is_active = 1
        JOIN resource_ruleset_heads AS ruleset_head ON ruleset_head.scope = 'global'
        JOIN resource_ruleset_events AS ruleset ON ruleset.id = ruleset_head.ruleset_event_id
        WHERE run.job_id = ? AND consent.status = 'active' AND consent.expires_at > ?
        ORDER BY consent.id DESC
        LIMIT 1
      `).get(jobId, at) as {
        consent_id: number;
        run_id: number;
        approved_origins_json: string;
        resource_id: number;
        ruleset_version: number;
      } | undefined;
      if (owner === undefined) return [];

      const origins = [...new Set(
        (JSON.parse(owner.approved_origins_json) as unknown[]).map((value) => {
          if (typeof value !== "string") throw new Error("invalid approved origin");
          const policy = classifyLiveAcquisitionUrl(`${value}/`);
          if (policy.kind === "blocked" || policy.canonicalOrigin !== value) {
            throw new Error("invalid approved origin");
          }
          return value;
        }),
      )].sort(compareUtf8);
      const sourceUrls = (connection.prepare(`
        SELECT payload.url_snapshot
        FROM research_sources AS source
        JOIN research_source_payloads AS payload ON payload.source_id = source.id
        WHERE source.run_id = ? AND source.source_kind = 'captured'
          AND source.eligibility = 'eligible' AND source.inclusion_state = 'included'
        ORDER BY source.ordinal
      `).all(owner.run_id) as Array<{ url_snapshot: string }>).map(({ url_snapshot }) => {
        const policy = classifyLiveAcquisitionUrl(url_snapshot);
        return policy.kind === "blocked" ? undefined : policy;
      }).filter((policy) => policy !== undefined);
      const admitted: PlannedLiveAcquisitionAction[] = [];
      for (const origin of origins) {
        admitted.push(options.actionLedger.planRobots({
          consentId: owner.consent_id,
          canonicalOrigin: origin,
        }));
        const exactSeeds = [...new Set(sourceUrls
          .filter((policy) => policy.canonicalOrigin === origin)
          .map((policy) => policy.canonicalFetchUrl)
          .filter((url) => {
            const preview = options.previewResourceUrl(url, owner.ruleset_version);
            return preview.kind === "accepted" && preview.resource.id === owner.resource_id;
          }))].sort(compareUtf8);
        const root = `${origin}/`;
        const candidates = exactSeeds.length > 0 ? exactSeeds : (() => {
          const preview = options.previewResourceUrl(root, owner.ruleset_version);
          return preview.kind === "accepted" && preview.resource.id === owner.resource_id
            ? [root]
            : [];
        })();
        for (const url of candidates) {
          admitted.push(options.actionLedger.planUnknownPage({
            consentId: owner.consent_id,
            url,
          }));
        }
      }
      return admitted;
    },
  };
}
