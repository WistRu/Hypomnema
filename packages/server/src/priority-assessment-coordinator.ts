import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import type {
  AiJobProvenance,
  DurableJobRef,
  DurableJobView,
  PriorityAssessmentTaskSpec,
} from "@tabhub/shared";

import {
  AI_JOB_LEASE_MS,
  AI_JOB_RENEW_EVERY_MS,
  aiJobGuardMaximumBytes,
  aiJobGuardMaximumRows,
  fingerprintAiJobGuardProjection,
  type AiJobClaim,
  type AiJobGuardDefinition,
  type AiJobLedger,
} from "./ai-job-ledger.js";
import type { AiJobClaimBoundary } from "./ai-job-runtime-state.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import {
  createPriorityFeatureCatalog,
  PriorityFeatureCatalogError,
  priorityProjectionAggregateName,
  type PriorityFeatureCatalog,
  type PriorityFeatureProjectionRead,
  type PriorityFeatureRead,
} from "./priority-feature-catalog.js";
import {
  createPriorityEngine,
  PriorityEngineError,
  readActivePriorityRuleset,
  type PriorityFeedbackInput,
  type PrioritySubject,
} from "./priority-engine.js";
import type { PriorityListSubjectProjection } from "./priority-list-ordering.js";

import { canonicalJsonV1 as canonicalJson } from "@tabhub/shared";

export const prioritySingleCoverageGuardId = "priority_subject_coverage_v1";
export const priorityCollectionCoverageGuardId = "priority_coverage_v1";

/**
 * Every feature source family contributes a deterministic source token. The
 * guard runs this statement inside C52a's BEGIN IMMEDIATE transaction. Any
 * source mutation changes at least one token, so a preflight digest can no
 * longer terminal-succeed after a behind-cursor mutation.
 *
 * The final six fields also prove the persisted XOR, fingerprint, active
 * ruleset, and desired rule/null-model identity for each denominator subject.
 */

const priorityCoverageGuardTemplate = `WITH RECURSIVE
job AS (
  SELECT id, subject_type, logical_page_id, resource_id, created_at,
    ruleset_id, ruleset_version, assessment_method
  FROM ai_jobs WHERE id = ? AND kind = 'priority_assessment'
), denominator(type,subject_id,anchor,job_ruleset_id,job_ruleset_version,
    job_assessment_method) AS (
  SELECT 'page',logical_pages.id,job.created_at,job.ruleset_id,job.ruleset_version,
    job.assessment_method
  FROM job JOIN logical_pages
    ON job.subject_type='collection'
      OR job.subject_type='page' AND job.logical_page_id=logical_pages.id
  UNION ALL
  SELECT 'resource',resources.id,job.created_at,job.ruleset_id,job.ruleset_version,
    job.assessment_method
  FROM job JOIN resources
    ON job.subject_type='collection'
      OR job.subject_type='resource' AND job.resource_id=resources.id
  JOIN resource_heads ON resource_heads.resource_id=resources.id
  JOIN resource_events ON resource_events.id=resource_heads.event_id
    AND resource_events.resource_id=resources.id
    AND resource_events.lifecycle_state='active'
), members(type,subject_id,logical_page_id,anchor) AS (
  SELECT 'page',subject_id,subject_id,anchor FROM denominator WHERE type='page'
  UNION ALL
  SELECT 'resource',denominator.subject_id,assignments.logical_page_id,denominator.anchor
  FROM denominator
  JOIN logical_page_resource_assignments AS assignments
    ON assignments.resource_id=denominator.subject_id AND assignments.action='assigned'
  JOIN logical_page_resource_heads AS heads
    ON heads.logical_page_id=assignments.logical_page_id
      AND heads.assignment_id=assignments.id
  WHERE denominator.type='resource'
), topic_paths(id,path) AS (
  SELECT id,trim(name) FROM tags WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id,parent.path || '/' || trim(child.name)
  FROM tags AS child JOIN topic_paths AS parent ON parent.id=child.parent_id
), coverage(available) AS (
  SELECT EXISTS (
    SELECT 1 FROM activity_daily_writer_state AS writer
    JOIN activity_tracking_epochs AS epochs
      ON epochs.metric='logical_page_activity_daily'
    CROSS JOIN job
    WHERE writer.singleton_id=1 AND writer.state='enabled'
      AND writer.coverage_started_at IS NOT NULL
      AND writer.coverage_started_at=writer.updated_at
      AND writer.coverage_started_at>=epochs.coverage_started_at
      AND julianday(writer.coverage_started_at)<=julianday(date(job.created_at,'-29 days'))
      AND julianday(writer.updated_at)<=julianday(job.created_at)
  )
), qualifying_page_context(type,subject_id,logical_page_id,kind) AS (
  SELECT DISTINCT members.type,members.subject_id,members.logical_page_id,entries.kind
  FROM members JOIN context_entries AS entries
    ON entries.logical_page_id=members.logical_page_id
  WHERE entries.kind IN ('next_action','project')
    AND entries.visibility='share_with_ai' AND entries.state='active'
    AND (entries.stale_at IS NULL OR julianday(entries.stale_at)>julianday(members.anchor))
    AND NOT EXISTS(SELECT 1 FROM context_entries AS newer
      WHERE newer.supersedes_id=entries.id AND newer.visibility='share_with_ai')
    AND (entries.actor='user' OR entries.actor='agent'
      AND (SELECT COUNT(*) FROM context_entry_reviews AS reviews
        WHERE reviews.context_entry_id=entries.id
          AND NOT EXISTS(SELECT 1 FROM context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id=reviews.id))=1
      AND EXISTS(SELECT 1 FROM context_entry_reviews AS reviews
        WHERE reviews.context_entry_id=entries.id AND reviews.verdict='accepted'
          AND NOT EXISTS(SELECT 1 FROM context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id=reviews.id)))
), qualifying_resource_context(subject_id,kind) AS (
  SELECT DISTINCT denominator.subject_id,entries.kind
  FROM denominator JOIN resource_context_entries AS entries
    ON entries.resource_id=denominator.subject_id
  WHERE denominator.type='resource' AND entries.kind IN ('next_action','project')
    AND entries.visibility='share_with_ai' AND entries.state='active'
    AND (entries.stale_at IS NULL OR julianday(entries.stale_at)>julianday(denominator.anchor))
    AND NOT EXISTS(SELECT 1 FROM resource_context_entries AS newer
      WHERE newer.supersedes_id=entries.id AND newer.visibility='share_with_ai')
    AND (entries.actor='user' OR entries.actor='agent'
      AND (SELECT COUNT(*) FROM resource_context_entry_reviews AS reviews
        WHERE reviews.context_entry_id=entries.id
          AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id=reviews.id))=1
      AND EXISTS(SELECT 1 FROM resource_context_entry_reviews AS reviews
        WHERE reviews.context_entry_id=entries.id AND reviews.verdict='accepted'
          AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id=reviews.id)))
), member_entities(type,subject_id,entity_id) AS (
  SELECT DISTINCT members.type,members.subject_id,entities.id
  FROM members JOIN tabs ON tabs.logical_page_id=members.logical_page_id
  JOIN knowledge_entities AS entities
    ON entities.kind='tab' AND entities.tab_id=tabs.id
), incident_relations(type,subject_id,relation_id) AS (
  SELECT DISTINCT member_entities.type,member_entities.subject_id,relations.id
  FROM member_entities JOIN relations
    ON relations.from_entity_id=member_entities.entity_id
      OR relations.to_entity_id=member_entities.entity_id
), relation_counts(type,subject_id,relation_count) AS (
  SELECT type,subject_id,COUNT(*) FROM incident_relations GROUP BY type,subject_id
), page_stats AS (
  SELECT members.type,members.subject_id,members.logical_page_id,members.anchor,
    MAX(0,CAST(julianday(date(members.anchor))-julianday(date(pages.created_at)) AS INTEGER))
      AS age_days,
    MAX(0,CAST(julianday(date(members.anchor))-julianday(date(COALESCE(
      (SELECT MAX(tabs.last_seen_at) FROM tabs
       WHERE tabs.logical_page_id=members.logical_page_id),pages.updated_at))) AS INTEGER))
      AS last_seen_days,
    EXISTS(SELECT 1 FROM tabs WHERE tabs.logical_page_id=members.logical_page_id
      AND tabs.is_open=1) AS is_open,
    EXISTS(SELECT 1 FROM tabs JOIN tab_instances AS instances ON instances.tab_id=tabs.id
      WHERE tabs.logical_page_id=members.logical_page_id AND instances.pinned=1) AS is_pinned,
    MAX(0,(SELECT COUNT(DISTINCT instances.id) FROM tabs
      JOIN tab_instances AS instances ON instances.tab_id=tabs.id
      WHERE tabs.logical_page_id=members.logical_page_id)-1) AS duplicate_physical_count,
    EXISTS(SELECT 1 FROM tabs JOIN contents ON contents.tab_id=tabs.id
      WHERE tabs.logical_page_id=members.logical_page_id
        AND (contents.text IS NOT NULL OR contents.summary IS NOT NULL)) AS has_captured_content,
    EXISTS(SELECT 1 FROM tabs JOIN contents ON contents.tab_id=tabs.id
      WHERE tabs.logical_page_id=members.logical_page_id
        AND contents.summary IS NOT NULL AND length(trim(contents.summary))>0)
      AS has_current_summary,
    EXISTS(SELECT 1 FROM tabs JOIN tab_tags ON tab_tags.tab_id=tabs.id
      JOIN topic_paths ON topic_paths.id=tab_tags.tag_id
      WHERE tabs.logical_page_id=members.logical_page_id
        AND (topic_paths.path='Current projects'
          OR substr(topic_paths.path,1,17)='Current projects/'))
      OR EXISTS(SELECT 1 FROM tabs
        JOIN saved_workspace_items AS items ON items.canonical_tab_id=tabs.id
        JOIN saved_workspaces AS workspaces ON workspaces.id=items.workspace_id
        WHERE tabs.logical_page_id=members.logical_page_id
          AND (trim(workspaces.name)='Current projects'
            OR substr(trim(workspaces.name),1,17)='Current projects/'))
      AS has_current_project_membership,
    EXISTS(SELECT 1 FROM qualifying_page_context AS context
      WHERE context.type=members.type AND context.subject_id=members.subject_id
        AND context.logical_page_id=members.logical_page_id
        AND context.kind='next_action') AS has_shareable_next_action,
    EXISTS(SELECT 1 FROM qualifying_page_context AS context
      WHERE context.type=members.type AND context.subject_id=members.subject_id
        AND context.logical_page_id=members.logical_page_id
        AND context.kind='project') AS has_shareable_project_context
  FROM members JOIN logical_pages AS pages ON pages.id=members.logical_page_id
), activity_sums AS (
  SELECT members.type,members.subject_id,
    COALESCE(SUM(activity.foreground_ms),0) AS foreground_ms,
    COALESCE(SUM(activity.engaged_ms),0) AS engaged_ms
  FROM members LEFT JOIN logical_page_activity_daily AS activity
    ON activity.logical_page_id=members.logical_page_id
      AND activity.activity_date>=date(members.anchor,'-29 days')
      AND activity.activity_date<date(members.anchor,'+1 day')
  GROUP BY members.type,members.subject_id
), resource_stats AS (
  SELECT denominator.type,denominator.subject_id,denominator.anchor,
    MAX(0,CAST(julianday(date(denominator.anchor))-julianday(date(resources.created_at))
      AS INTEGER)) AS age_days,
    COUNT(page_stats.logical_page_id) AS resource_page_count,
    CASE WHEN COUNT(page_stats.logical_page_id)=0 THEN NULL
      ELSE MIN(page_stats.last_seen_days) END AS last_seen_days,
    COALESCE(MAX(page_stats.is_open),0) AS is_open,
    COALESCE(MAX(page_stats.is_pinned),0) AS is_pinned,
    COALESCE(SUM(page_stats.duplicate_physical_count),0) AS duplicate_physical_count,
    COALESCE(MAX(page_stats.has_captured_content),0) AS has_captured_content,
    COALESCE(MAX(page_stats.has_current_summary),0) AS has_current_summary,
    COALESCE(SUM(page_stats.has_captured_content),0) AS resource_captured_page_count,
    COALESCE(MAX(page_stats.has_current_project_membership),0)
      AS page_project_membership,
    COALESCE(MAX(page_stats.has_shareable_next_action),0) AS page_next_action,
    COALESCE(MAX(page_stats.has_shareable_project_context),0) AS page_project_context,
    EXISTS(SELECT 1 FROM qualifying_resource_context AS context
      WHERE context.subject_id=denominator.subject_id AND context.kind='next_action')
      AS resource_next_action,
    EXISTS(SELECT 1 FROM qualifying_resource_context AS context
      WHERE context.subject_id=denominator.subject_id AND context.kind='project')
      AS resource_project_context
  FROM denominator JOIN resources ON resources.id=denominator.subject_id
  LEFT JOIN page_stats ON page_stats.type='resource'
    AND page_stats.subject_id=denominator.subject_id
  WHERE denominator.type='resource'
  GROUP BY denominator.subject_id
), set_values(type,subject_id,feature_key,value) AS (
  SELECT DISTINCT members.type,members.subject_id,'status',tabs.status
  FROM members JOIN tabs ON tabs.logical_page_id=members.logical_page_id
  UNION ALL
  SELECT DISTINCT members.type,members.subject_id,'topic_paths',topic_paths.path
  FROM members JOIN tabs ON tabs.logical_page_id=members.logical_page_id
  JOIN tab_tags ON tab_tags.tab_id=tabs.id
  JOIN topic_paths ON topic_paths.id=tab_tags.tag_id
  UNION ALL
  SELECT DISTINCT members.type,members.subject_id,'workspace_names',trim(workspaces.name)
  FROM members JOIN tabs ON tabs.logical_page_id=members.logical_page_id
  JOIN saved_workspace_items AS items ON items.canonical_tab_id=tabs.id
  JOIN saved_workspaces AS workspaces ON workspaces.id=items.workspace_id
), set_keys(feature_key) AS (
  VALUES('status'),('topic_paths'),('workspace_names')
), page_fact_values AS (
  SELECT p.*,COALESCE(r.relation_count,0) AS relation_count,
    a.foreground_ms,a.engaged_ms,c.available
  FROM page_stats AS p LEFT JOIN relation_counts AS r USING(type,subject_id)
  JOIN activity_sums AS a USING(type,subject_id) CROSS JOIN coverage AS c
  WHERE p.type='page'
), resource_fact_values AS (
  SELECT r.*,COALESCE(rc.relation_count,0) AS relation_count,
    COALESCE(a.foreground_ms,0) AS foreground_ms,
    COALESCE(a.engaged_ms,0) AS engaged_ms,c.available
  FROM resource_stats AS r LEFT JOIN relation_counts AS rc USING(type,subject_id)
  LEFT JOIN activity_sums AS a USING(type,subject_id) CROSS JOIN coverage AS c
), scalar_facts(type,subject_id,anchor,family,feature_key,text_value,number_value) AS (
  SELECT page_fact_values.type,page_fact_values.subject_id,page_fact_values.anchor,
    'boolean',j.key,NULL,j.value
  FROM page_fact_values,json_each(json_object(
    'has_shareable_next_action',has_shareable_next_action,
    'has_shareable_project_context',has_shareable_project_context,
    'has_current_project_membership',has_current_project_membership,
    'is_pinned',is_pinned,'is_open',is_open,
    'has_captured_content',has_captured_content,
    'has_current_summary',has_current_summary,'has_current_research_report',0)) AS j
  UNION ALL
  SELECT page_fact_values.type,page_fact_values.subject_id,page_fact_values.anchor,
    'number',j.key,NULL,j.value
  FROM page_fact_values,json_each(json_patch(json_object(
    'relation_count',relation_count,'age_days',age_days,
    'last_seen_days',last_seen_days,'duplicate_physical_count',duplicate_physical_count),
    CASE available WHEN 1 THEN json_object(
      'active_use_30d_ms',engaged_ms,'on_screen_30d_ms',foreground_ms)
    ELSE json('{}') END)) AS j
  UNION ALL
  SELECT resource_fact_values.type,resource_fact_values.subject_id,
    resource_fact_values.anchor,'boolean',j.key,NULL,j.value
  FROM resource_fact_values,json_each(json_object(
    'has_shareable_next_action',
      CASE WHEN page_next_action=1 OR resource_next_action=1 THEN 1 ELSE 0 END,
    'has_shareable_project_context',
      CASE WHEN page_project_context=1 OR resource_project_context=1 THEN 1 ELSE 0 END,
    'has_current_project_membership',page_project_membership,
    'is_pinned',is_pinned,'is_open',is_open,
    'has_captured_content',has_captured_content,
    'has_current_summary',has_current_summary,'has_current_research_report',0)) AS j
  UNION ALL
  SELECT resource_fact_values.type,resource_fact_values.subject_id,
    resource_fact_values.anchor,'number',j.key,NULL,j.value
  FROM resource_fact_values,json_each(json_patch(json_object(
    'relation_count',relation_count,'age_days',age_days,
    'duplicate_physical_count',duplicate_physical_count,
    'resource_page_count',resource_page_count,
    'resource_captured_page_count',resource_captured_page_count),
    json_patch(CASE WHEN last_seen_days IS NULL THEN json('{}')
      ELSE json_object('last_seen_days',last_seen_days) END,
      CASE available WHEN 1 THEN json_object(
        'active_use_30d_ms',engaged_ms,'on_screen_30d_ms',foreground_ms)
      ELSE json('{}') END))) AS j
), set_facts(type,subject_id,anchor,family,feature_key,text_value,number_value) AS (
  SELECT set_values.type,set_values.subject_id,denominator.anchor,'set',feature_key,value,NULL
  FROM set_values JOIN denominator USING(type,subject_id)
  UNION ALL
  SELECT denominator.type,denominator.subject_id,denominator.anchor,'empty_set',
    set_keys.feature_key,NULL,NULL
  FROM denominator CROSS JOIN set_keys
  WHERE NOT EXISTS(SELECT 1 FROM set_values
    WHERE set_values.type=denominator.type AND set_values.subject_id=denominator.subject_id
      AND set_values.feature_key=set_keys.feature_key)
), resolution(type,subject_id,state,reason) AS (
  SELECT denominator.type,denominator.subject_id,events.state,events.reason
  FROM denominator
  LEFT JOIN resource_resolution_heads AS heads
    ON heads.logical_page_id=denominator.subject_id
  LEFT JOIN resource_resolution_events AS events
    ON events.id=heads.resolution_event_id
      AND events.logical_page_id=heads.logical_page_id
  WHERE denominator.type='page'
), eligibility_facts(type,subject_id,anchor,family,feature_key,text_value,number_value) AS (
  SELECT resolution.type,resolution.subject_id,denominator.anchor,'eligibility',
    CASE
      WHEN resolution.state IS NULL THEN 'temporarily_unavailable'
      WHEN NOT ((resolution.state='overridden' AND resolution.reason IN ('user_manual','agent_on_behalf'))
        OR (resolution.state='matched' AND resolution.reason IN
          ('explicit_alias','system_seed','registrable_domain'))
        OR (resolution.state='ambiguous' AND resolution.reason='authoritative_tie')
        OR (resolution.state='unmatched' AND resolution.reason IN
          ('weak_sensitive_signal','registrable_domain_unavailable'))
        OR (resolution.state='excluded' AND resolution.reason IN
          ('invalid_url','browser_internal','extension','file','data','unsupported_scheme',
           'embedded_credentials','localhost','private_ip','private_hostname')))
        THEN 'temporarily_unavailable'
      WHEN resolution.reason IN ('invalid_url','unsupported_scheme',
        'registrable_domain_unavailable') THEN 'unsupported_url'
      WHEN resolution.reason IN ('browser_internal','extension','file','data',
        'embedded_credentials','localhost','private_ip','private_hostname')
        THEN 'private_or_internal'
      ELSE 'eligible' END,
    CASE
      WHEN resolution.state IS NULL THEN 'missing_resource_resolution_head'
      WHEN NOT ((resolution.state='overridden' AND resolution.reason IN ('user_manual','agent_on_behalf'))
        OR (resolution.state='matched' AND resolution.reason IN
          ('explicit_alias','system_seed','registrable_domain'))
        OR (resolution.state='ambiguous' AND resolution.reason='authoritative_tie')
        OR (resolution.state='unmatched' AND resolution.reason IN
          ('weak_sensitive_signal','registrable_domain_unavailable'))
        OR (resolution.state='excluded' AND resolution.reason IN
          ('invalid_url','browser_internal','extension','file','data','unsupported_scheme',
           'embedded_credentials','localhost','private_ip','private_hostname')))
        THEN 'corrupt_resource_resolution_head'
      WHEN resolution.reason IN ('invalid_url','unsupported_scheme','registrable_domain_unavailable',
        'browser_internal','extension','file','data','embedded_credentials','localhost',
        'private_ip','private_hostname') THEN resolution.reason
      ELSE NULL END,NULL
  FROM resolution JOIN denominator USING(type,subject_id)
  UNION ALL
  SELECT type,subject_id,anchor,'eligibility','eligible',NULL,NULL
  FROM denominator WHERE type='resource'
), all_facts AS (
  SELECT * FROM scalar_facts UNION ALL SELECT * FROM set_facts
  UNION ALL SELECT * FROM eligibility_facts
), source_projection(type,subject_id,source_feature_fingerprint) AS (
  SELECT type,subject_id,${priorityProjectionAggregateName}(
    type,subject_id,anchor,family,feature_key,text_value,number_value)
  FROM (SELECT * FROM all_facts
    ORDER BY type,subject_id,family,feature_key,text_value,number_value)
  GROUP BY type,subject_id
), outcomes AS (
  SELECT denominator.*,
    source_projection.source_feature_fingerprint,
    active.ruleset_id AS active_ruleset_id,active.version AS active_ruleset_version,
    COALESCE(priority_assessments.ruleset_id,priority_exclusions.ruleset_id,
      resource_priority_assessments.ruleset_id,
      resource_priority_exclusions.ruleset_id) AS outcome_ruleset_id,
    COALESCE(priority_assessments.ruleset_version,priority_exclusions.ruleset_version,
      resource_priority_assessments.ruleset_version,
      resource_priority_exclusions.ruleset_version) AS outcome_ruleset_version,
    COALESCE(priority_assessments.feature_fingerprint,priority_exclusions.feature_fingerprint,
      resource_priority_assessments.feature_fingerprint,
      resource_priority_exclusions.feature_fingerprint) AS outcome_fingerprint,
    CASE WHEN priority_assessments.id IS NOT NULL OR
      resource_priority_assessments.id IS NOT NULL THEN 'assessment'
      WHEN priority_exclusions.id IS NOT NULL OR resource_priority_exclusions.id IS NOT NULL
        THEN 'exclusion' ELSE 'missing' END AS outcome_kind,
    COALESCE(priority_assessments.assessment_method,
      resource_priority_assessments.assessment_method,'rule') AS desired_method,
    CASE WHEN COALESCE(priority_assessments.model_provenance_json,
      resource_priority_assessments.model_provenance_json) IS NULL THEN 0 ELSE 1 END
      AS model_provenance,
    (CASE WHEN priority_assessments.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN priority_exclusions.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN resource_priority_assessments.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN resource_priority_exclusions.id IS NOT NULL THEN 1 ELSE 0 END) AS xor_count
  FROM denominator JOIN source_projection USING(type,subject_id)
  CROSS JOIN priority_ruleset_activations AS active
  LEFT JOIN priority_assessments ON denominator.type='page'
    AND priority_assessments.logical_page_id=denominator.subject_id
    AND priority_assessments.superseded_at IS NULL
  LEFT JOIN priority_exclusions ON denominator.type='page'
    AND priority_exclusions.logical_page_id=denominator.subject_id
    AND priority_exclusions.superseded_at IS NULL
  LEFT JOIN resource_priority_assessments ON denominator.type='resource'
    AND resource_priority_assessments.resource_id=denominator.subject_id
    AND resource_priority_assessments.superseded_at IS NULL
  LEFT JOIN resource_priority_exclusions ON denominator.type='resource'
    AND resource_priority_exclusions.resource_id=denominator.subject_id
    AND resource_priority_exclusions.superseded_at IS NULL
  WHERE active.scope='global'
)
SELECT type,subject_id,source_feature_fingerprint,job_ruleset_id,job_ruleset_version,
  active_ruleset_id,active_ruleset_version,outcome_ruleset_id,outcome_ruleset_version,
  outcome_fingerprint,outcome_kind,
  desired_method,model_provenance,xor_count,
  CASE WHEN source_feature_fingerprint=outcome_fingerprint
    AND job_ruleset_id=active_ruleset_id AND job_ruleset_version=active_ruleset_version
    AND job_ruleset_id=outcome_ruleset_id AND job_ruleset_version=outcome_ruleset_version
    AND xor_count=1 AND (outcome_kind='exclusion'
      OR outcome_kind='assessment' AND job_assessment_method=desired_method
        AND desired_method='rule' AND model_provenance=0)
    THEN 1 ELSE 0 END AS semantic_ok
FROM outcomes
ORDER BY CASE type WHEN 'page' THEN 0 ELSE 1 END,subject_id`;

export const priorityCoverageGuardSql = priorityCoverageGuardTemplate
  .replace(/'has_shareable_next_action'/g, "'@1'")
  .replace(/'has_shareable_project_context'/g, "'@2'")
  .replace(/'has_current_project_membership'/g, "'@3'")
  .replace(/'has_captured_content'/g, "'@4'")
  .replace(/'has_current_summary'/g, "'@5'")
  .replace(/'has_current_research_report'/g, "'@6'")
  .replace(/'duplicate_physical_count'/g, "'@7'")
  .replace(/'resource_page_count'/g, "'@8'")
  .replace(/'resource_captured_page_count'/g, "'@9'")
  .replace(/'active_use_30d_ms'/g, "'@a'")
  .replace(/'on_screen_30d_ms'/g, "'@b'")
  .replace(/'relation_count'/g, "'@c'")
  .replace(/'last_seen_days'/g, "'@d'")
  .replace(/'age_days'/g, "'@e'")
  .replace(/\bdenominator\b/g, "d")
  .replace(/\bmembers\b/g, "m")
  .replace(/\bqualifying_page_context\b/g, "qpc")
  .replace(/\bqualifying_resource_context\b/g, "qrc")
  .replace(/\bpage_stats\b/g, "ps")
  .replace(/\bresource_stats\b/g, "rs")
  .replace(/\bactivity_sums\b/g, "aus")
  .replace(/\brelation_counts\b/g, "rc")
  .replace(/\bpage_fact_values\b/g, "pfv")
  .replace(/\bresource_fact_values\b/g, "rfv")
  .replace(/\bscalar_facts\b/g, "sf")
  .replace(/\bset_facts\b/g, "stf")
  .replace(/\beligibility_facts\b/g, "ef")
  .replace(/\ball_facts\b/g, "af")
  .replace(/\bsource_projection\b/g, "sp")
  .replace(/\bsource_feature_fingerprint\b/g, "sfp")
  .replace(/\boutcome_fingerprint\b/g, "ofp")
  .replace(/\bjob_ruleset_id\b/g, "jri")
  .replace(/\bjob_ruleset_version\b/g, "jrv")
  .replace(/\bjob_assessment_method\b/g, "jam")
  .replace(/\bactive_ruleset_id\b/g, "ari")
  .replace(/\bactive_ruleset_version\b/g, "arv")
  .replace(/\boutcome_ruleset_id\b/g, "ori")
  .replace(/\boutcome_ruleset_version\b/g, "orv")
  .replace(/\bmember_entities\b/g, "me")
  .replace(/\bincident_relations\b/g, "ir")
  .replace(/\bset_values\b/g, "sv")
  .replace(/\bset_keys\b/g, "sk")
  .replace(/\bpage_next_action\b/g, "pna")
  .replace(/\bpage_project_context\b/g, "ppc")
  .replace(/\bpage_project_membership\b/g, "ppm")
  .replace(/\bresource_next_action\b/g, "rna")
  .replace(/\bresource_project_context\b/g, "rpc")
  .replace(/\bdesired_method\b/g, "dm")
  .replace(/\bmodel_provenance\b/g, "mp")
  .replace(/\boutcome_kind\b/g, "ok")
  .replace(/\bxor_count\b/g, "xc")
  .replace(/\bhas_shareable_next_action\b/g, "hsna")
  .replace(/\bhas_shareable_project_context\b/g, "hspc")
  .replace(/\bhas_current_project_membership\b/g, "hcpm")
  .replace(/\bhas_captured_content\b/g, "hcc")
  .replace(/\bhas_current_summary\b/g, "hcs")
  .replace(/\bhas_current_research_report\b/g, "hcrr")
  .replace(/\bduplicate_physical_count\b/g, "dpc")
  .replace(/\bresource_page_count\b/g, "rpcnt")
  .replace(/\bresource_captured_page_count\b/g, "rccnt")
  .replace(/\bactive_use_30d_ms\b/g, "au")
  .replace(/\bon_screen_30d_ms\b/g, "os")
  .replace(/\brelation_count\b/g, "rcnt")
  .replace(/\blast_seen_days\b/g, "lsd")
  .replace(/\bage_days\b/g, "agd")
  .replace(/\bcoverage\b/g, "cv")
  .replace(/\bresolution\b/g, "res")
  .replace(/\boutcomes\b/g, "o")
  .replace(/\bsubject_id\b/g, "s")
  .replace(/\banchor\b/g, "a0")
  .replace(/\bfamily\b/g, "f")
  .replace(/\bfeature_key\b/g, "k")
  .replace(/\btext_value\b/g, "t")
  .replace(/\bnumber_value\b/g, "n")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/'@1'/g, "'has_shareable_next_action'")
  .replace(/'@2'/g, "'has_shareable_project_context'")
  .replace(/'@3'/g, "'has_current_project_membership'")
  .replace(/'@4'/g, "'has_captured_content'")
  .replace(/'@5'/g, "'has_current_summary'")
  .replace(/'@6'/g, "'has_current_research_report'")
  .replace(/'@7'/g, "'duplicate_physical_count'")
  .replace(/'@8'/g, "'resource_page_count'")
  .replace(/'@9'/g, "'resource_captured_page_count'")
  .replace(/'@a'/g, "'active_use_30d_ms'")
  .replace(/'@b'/g, "'on_screen_30d_ms'")
  .replace(/'@c'/g, "'relation_count'")
  .replace(/'@d'/g, "'last_seen_days'")
  .replace(/'@e'/g, "'age_days'");

const sourceProjectionStart = priorityCoverageGuardTemplate.indexOf(
  "members(type,subject_id,logical_page_id,anchor) AS (",
);
const sourceProjectionEnd = priorityCoverageGuardTemplate.indexOf(
  "), outcomes AS (",
  sourceProjectionStart,
);
if (sourceProjectionStart < 0 || sourceProjectionEnd < 0) {
  throw new Error("Priority source projection SQL seam is missing");
}
const prioritySourceProjectionCtes = priorityCoverageGuardTemplate.slice(
  sourceProjectionStart,
  sourceProjectionEnd,
);

const priorityListProjectionSql = `WITH RECURSIVE
job(created_at) AS (SELECT @anchor),
denominator(type,subject_id,anchor) AS (
  SELECT 'page',requested.subject_id,job.created_at
  FROM temp.priority_list_requested AS requested CROSS JOIN job
  JOIN priority_ruleset_activations AS active ON active.scope='global'
  JOIN priority_assessments AS candidate
    ON candidate.logical_page_id=requested.subject_id
      AND candidate.superseded_at IS NULL
      AND candidate.ruleset_id=active.ruleset_id
      AND candidate.ruleset_version=active.version
      AND candidate.assessment_method='rule'
      AND candidate.model_provenance_json IS NULL
  WHERE @type='page'
  UNION ALL
  SELECT 'resource',requested.subject_id,job.created_at
  FROM temp.priority_list_requested AS requested CROSS JOIN job
  JOIN priority_ruleset_activations AS active ON active.scope='global'
  JOIN resource_priority_assessments AS candidate
    ON candidate.resource_id=requested.subject_id
      AND candidate.superseded_at IS NULL
      AND candidate.ruleset_id=active.ruleset_id
      AND candidate.ruleset_version=active.version
      AND candidate.assessment_method='rule'
      AND candidate.model_provenance_json IS NULL
  WHERE @type='resource'
), ${prioritySourceProjectionCtes}
), outcomes AS (
  SELECT denominator.type,denominator.subject_id,
    source_projection.source_feature_fingerprint,
    active.ruleset_id AS active_ruleset_id,active.version AS active_ruleset_version,
    COALESCE(priority_assessments.ruleset_id,priority_exclusions.ruleset_id,
      resource_priority_assessments.ruleset_id,
      resource_priority_exclusions.ruleset_id) AS outcome_ruleset_id,
    COALESCE(priority_assessments.ruleset_version,priority_exclusions.ruleset_version,
      resource_priority_assessments.ruleset_version,
      resource_priority_exclusions.ruleset_version) AS outcome_ruleset_version,
    COALESCE(priority_assessments.feature_fingerprint,priority_exclusions.feature_fingerprint,
      resource_priority_assessments.feature_fingerprint,
      resource_priority_exclusions.feature_fingerprint) AS outcome_fingerprint,
    CASE WHEN priority_assessments.id IS NOT NULL OR
      resource_priority_assessments.id IS NOT NULL THEN 'assessment'
      WHEN priority_exclusions.id IS NOT NULL OR resource_priority_exclusions.id IS NOT NULL
        THEN 'exclusion' ELSE 'missing' END AS outcome_kind,
    COALESCE(priority_assessments.assessment_method,
      resource_priority_assessments.assessment_method,'rule') AS assessment_method,
    CASE WHEN COALESCE(priority_assessments.model_provenance_json,
      resource_priority_assessments.model_provenance_json) IS NULL THEN 0 ELSE 1 END
      AS model_provenance,
    COALESCE(priority_assessments.agent_band,
      resource_priority_assessments.agent_band) AS agent_band,
    COALESCE(priority_assessments.agent_score,
      resource_priority_assessments.agent_score) AS agent_score,
    COALESCE(priority_assessments.needs_review,
      resource_priority_assessments.needs_review,0) AS needs_review,
    (CASE WHEN priority_assessments.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN priority_exclusions.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN resource_priority_assessments.id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN resource_priority_exclusions.id IS NOT NULL THEN 1 ELSE 0 END) AS xor_count
  FROM denominator JOIN source_projection USING(type,subject_id)
  CROSS JOIN priority_ruleset_activations AS active
  LEFT JOIN priority_assessments ON denominator.type='page'
    AND priority_assessments.logical_page_id=denominator.subject_id
    AND priority_assessments.superseded_at IS NULL
  LEFT JOIN priority_exclusions ON denominator.type='page'
    AND priority_exclusions.logical_page_id=denominator.subject_id
    AND priority_exclusions.superseded_at IS NULL
  LEFT JOIN resource_priority_assessments ON denominator.type='resource'
    AND resource_priority_assessments.resource_id=denominator.subject_id
    AND resource_priority_assessments.superseded_at IS NULL
  LEFT JOIN resource_priority_exclusions ON denominator.type='resource'
    AND resource_priority_exclusions.resource_id=denominator.subject_id
    AND resource_priority_exclusions.superseded_at IS NULL
  WHERE active.scope='global'
), projected AS (
  SELECT *,source_feature_fingerprint=outcome_fingerprint
    AND active_ruleset_id=outcome_ruleset_id
    AND active_ruleset_version=outcome_ruleset_version
    AND xor_count=1 AND (outcome_kind='exclusion' OR
      outcome_kind='assessment' AND assessment_method='rule' AND model_provenance=0)
    AS is_current
  FROM outcomes
)
SELECT subject_id AS subjectId,
  xor_count AS xorCount,
  CASE WHEN is_current AND outcome_kind='assessment' THEN CASE agent_band
    WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3
    WHEN 'critical' THEN 4 ELSE 0 END ELSE 0 END AS bandRank,
  CASE WHEN is_current AND outcome_kind='assessment' THEN agent_score ELSE -1 END
    AS agentScore,
  CASE WHEN is_current AND outcome_kind='assessment' THEN needs_review ELSE 0 END
    AS needsReview
FROM projected ORDER BY subject_id`;

const priorityListCorruptXorSql = `SELECT subjectId,xorCount FROM (
  SELECT requested.subject_id AS subjectId,
    (CASE WHEN assessment.id IS NULL THEN 0 ELSE 1 END +
      CASE WHEN exclusion.id IS NULL THEN 0 ELSE 1 END) AS xorCount
  FROM temp.priority_list_requested AS requested
  LEFT JOIN priority_assessments AS assessment
    ON assessment.logical_page_id=requested.subject_id
      AND assessment.superseded_at IS NULL
  LEFT JOIN priority_exclusions AS exclusion
    ON exclusion.logical_page_id=requested.subject_id
      AND exclusion.superseded_at IS NULL
  WHERE @type='page'
  UNION ALL
  SELECT requested.subject_id AS subjectId,
    (CASE WHEN assessment.id IS NULL THEN 0 ELSE 1 END +
      CASE WHEN exclusion.id IS NULL THEN 0 ELSE 1 END) AS xorCount
  FROM temp.priority_list_requested AS requested
  LEFT JOIN resource_priority_assessments AS assessment
    ON assessment.resource_id=requested.subject_id
      AND assessment.superseded_at IS NULL
  LEFT JOIN resource_priority_exclusions AS exclusion
    ON exclusion.resource_id=requested.subject_id
      AND exclusion.superseded_at IS NULL
  WHERE @type='resource'
) WHERE xorCount>1 ORDER BY subjectId LIMIT 1`;

export const priorityAssessmentGuardRegistry: Readonly<Record<string, AiJobGuardDefinition>> =
  Object.freeze({
    [prioritySingleCoverageGuardId]: Object.freeze({
      sql: priorityCoverageGuardSql,
      parameters: ["positive_safe_integer"] as const,
      usage: { stepsPerRow: 1 as const },
    }),
    [priorityCollectionCoverageGuardId]: Object.freeze({
      sql: priorityCoverageGuardSql,
      parameters: ["positive_safe_integer"] as const,
      usage: { stepsPerRow: 1 as const },
    }),
  });

export interface PrioritySubmitInput {
  readonly subject: PrioritySubject | { readonly type: "collection"; readonly scope: "all" };
  readonly provenance: AiJobProvenance;
  readonly idempotencyKey: string;
  readonly stepBatchSize?: number;
  readonly successorOf?: { readonly jobId: number; readonly eventSequence: number };
}

export interface PriorityAssessmentCoordinator {
  submit(input: PrioritySubmitInput): DurableJobRef;
  read(subject: PrioritySubject, anchor?: string): PriorityFeatureRead;
  readBatch(subjects: readonly PrioritySubject[], anchor?: string): readonly PriorityFeatureRead[];
  readListProjection(
    type: "page" | "resource",
    ids: readonly number[],
    anchor?: string,
  ): readonly PriorityListSubjectProjection[];
  previewBatch(
    subjects: readonly PrioritySubject[],
    anchor?: string,
  ): readonly PriorityFeatureProjectionRead[];
  listSubjectPage(input: {
    readonly after?: PrioritySubject;
    readonly limit: number;
  }): ReturnType<PriorityFeatureCatalog["listSubjectPage"]>;
  reviewQueue(input: { readonly cursor?: string; readonly limit: number; readonly anchor?: string }): {
    readonly items: readonly PriorityFeatureRead[];
    readonly nextCursor: string | null;
  };
  recordFeedback(input: Omit<PriorityFeedbackInput, "subject"> & {
    readonly expectedSubject: PrioritySubject;
  }):
    ReturnType<ReturnType<typeof createPriorityEngine>["recordFeedback"]>;
  recoverInterrupted(): number;
  claim(
    workerId: string,
    claimBoundary?: AiJobClaimBoundary,
  ): AiJobClaim | undefined;
  executeClaim(claim: AiJobClaim): DurableJobView;
  process(
    workerId: string,
    claimBoundary?: AiJobClaimBoundary,
  ): DurableJobView | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function guardProjection(
  connection: Database.Database,
  jobId: number,
): { readonly fingerprint: string; readonly rows: readonly (readonly unknown[])[];
  readonly overflow?: { readonly kind: "rows" | "bytes"; readonly observed: number;
    readonly limit: number; readonly observedRows: number } } {
  const statement = connection.prepare(priorityCoverageGuardSql);
  const columns = statement.columns().map((column) => ({
    name: column.name, column: column.column, table: column.table,
    database: column.database, type: column.type,
  }));
  const rows: Array<Array<string | number | null>> = [];
  let bytes = Buffer.byteLength(`${canonicalJson({ columns, rows: [] }).slice(0, -2)}`, "utf8") + 2;
  for (const row of statement.raw(true).iterate(jobId) as Iterable<Array<string | number | null>>) {
    bytes += Buffer.byteLength(canonicalJson(row), "utf8") + (rows.length === 0 ? 0 : 1);
    if (rows.length >= aiJobGuardMaximumRows) {
      return { fingerprint: "", rows,
        overflow: { kind: "rows", observed: rows.length + 1,
          limit: aiJobGuardMaximumRows, observedRows: rows.length + 1 } };
    }
    if (bytes > aiJobGuardMaximumBytes) {
      return { fingerprint: "", rows,
        overflow: { kind: "bytes", observed: bytes, limit: aiJobGuardMaximumBytes,
          observedRows: rows.length + 1 } };
    }
    rows.push(row);
  }
  return { fingerprint: fingerprintAiJobGuardProjection(columns, rows), rows };
}

function checkpoint(
  _claim: AiJobClaim,
  usageDeltaSteps: number,
  progressCompleted: number,
  total: number | null,
  stage: string,
  nextOffset = 0,
  wallTimeMs = 0,
) {
  return {
    progress: { completed: progressCompleted, total, stage },
    checkpoint: { version: 1 as const, nextOffset },
    usage: {
      steps: usageDeltaSteps,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs,
    },
  };
}

function semanticRowsValid(rows: readonly (readonly unknown[])[], expected: number): boolean {
  return rows.length === expected && rows.every((row) =>
    row[2] === row[9] &&
    row[3] === row[5] && row[4] === row[6] &&
    row[3] === row[7] && row[4] === row[8] &&
    typeof row[9] === "string" && /^[0-9a-f]{64}$/.test(row[9]) &&
    (row[10] === "exclusion" || row[10] === "assessment" &&
      row[11] === "rule" && row[12] === 0) && row[13] === 1 && row[14] === 1);
}

function validatePriorityListSubjectIds(ids: readonly number[]): void {
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0 || unique.has(id)) {
      throw new Error("Priority list subject IDs must be unique positive integers");
    }
    unique.add(id);
  }
}

export function createPriorityAssessmentCoordinator(options: {
  readonly connection: Database.Database;
  readonly clock?: () => Date;
  readonly writerEnabled: boolean;
  readonly catalog?: PriorityFeatureCatalog;
  readonly afterAssess?: (claim: AiJobClaim) => void;
  readonly afterFeatureRead?: (claim: AiJobClaim) => void;
  readonly afterBatchCheckpoint?: (claim: AiJobClaim, view: DurableJobView) => void;
  readonly afterListSubjects?: () => void;
  readonly afterPreflight?: (claim: AiJobClaim) => void;
  readonly beforeGuard?: (claim: AiJobClaim) => void;
  readonly createLedger: (
    guards: Readonly<Record<string, AiJobGuardDefinition>>,
  ) => AiJobLedger;
}): PriorityAssessmentCoordinator {
  const clock = options.clock ?? (() => new Date());
  // A PriorityFeatureCatalog owns registration of its SQLite projection
  // aggregate. Injected catalogs must therefore arrive fully initialized;
  // guessing from the presence of `catalog` makes real catalogs register the
  // connection-scoped aggregate twice.
  const catalog = options.catalog ?? createPriorityFeatureCatalog(options.connection);
  const engine = createPriorityEngine(options.connection, { now: () => clock().toISOString() });
  const ledger = options.createLedger(priorityAssessmentGuardRegistry);
  const feedbackSubject = {
    page: options.connection.prepare(
      "SELECT logical_page_id AS id FROM priority_assessments WHERE id=?",
    ),
    resource: options.connection.prepare(
      "SELECT resource_id AS id FROM resource_priority_assessments WHERE id=?",
    ),
  } as const;
  const now = () => clock().toISOString();
  options.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS priority_list_requested (
    subject_id INTEGER PRIMARY KEY
  ) WITHOUT ROWID`);
  const replacePriorityListRequested = options.connection.transaction((ids: string) => {
    options.connection.prepare("DELETE FROM temp.priority_list_requested").run();
    options.connection.prepare(`INSERT INTO temp.priority_list_requested(subject_id)
      SELECT CAST(value AS INTEGER) FROM json_each(?)`).run(ids);
  });
  const selectPriorityListProjection = options.connection.prepare(
    priorityListProjectionSql,
  );
  const selectPriorityListCorruptXor = options.connection.prepare(
    priorityListCorruptXorSql,
  );

  function refreshClaim(claim: AiJobClaim): AiJobClaim {
    return ledger.refresh(claim);
  }

  function partialForBudget(
    claim: AiJobClaim,
    input: { readonly steps: number; readonly wallTimeMs: number;
      readonly completed: number; readonly total: number | null;
      readonly nextOffset: number; readonly initialDenominator: number;
      readonly observedDenominator: number },
  ): DurableJobView {
    return ledger.completePartial(claim, {
      checkpoint: checkpoint(claim, input.steps, input.completed, input.total,
        "budget-exhausted", input.nextOffset, input.wallTimeMs),
      manifest: { version: 1, initialDenominator: input.initialDenominator,
        observedDenominator: input.observedDenominator },
    });
  }

  function heartbeat(claim: AiJobClaim): {
    readonly claim: AiJobClaim;
    readonly cancellationPending: boolean;
  } {
    const renewAt = Date.parse(claim.leaseExpiresAt) -
      AI_JOB_LEASE_MS + AI_JOB_RENEW_EVERY_MS;
    if (clock().getTime() < renewAt) return { claim, cancellationPending: false };
    const renewed = ledger.renew(claim);
    return renewed === undefined
      ? { claim, cancellationPending: true }
      : { claim: refreshClaim(renewed), cancellationPending: false };
  }

  function cancelAtCheckpoint(
    claim: AiJobClaim,
    input: { readonly steps: number; readonly wallTimeMs: number;
      readonly completed: number; readonly total: number | null;
      readonly nextOffset: number },
  ): DurableJobView {
    return ledger.checkpoint(claim, checkpoint(
      claim, input.steps, input.completed, input.total,
      "cancelling", input.nextOffset, input.wallTimeMs,
    ));
  }

  function submit(input: PrioritySubmitInput): DurableJobRef {
    if (!options.writerEnabled) {
      throw new DurableAiJobError("JOB_KIND_UNAVAILABLE", "Priority assessment writer is disabled");
    }
    const ruleset = readActivePriorityRuleset(options.connection).ref;
    const denominator = input.subject.type === "collection" ? (() => {
      const subjects = catalog.listSubjects();
      options.afterListSubjects?.();
      return subjects.length;
    })() : 1;
    const maxSteps = input.subject.type === "collection" ? Math.max(8, 12 * denominator) : 6;
    if (!Number.isSafeInteger(maxSteps)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Priority collection budget overflow");
    }
    // The ledger stamps the immutable extraction anchor as createdAt. Keeping
    // the caller's semantic fingerprint independent of wall clock makes an
    // idempotency-key replay return the original job instead of conflicting.
    const inputFingerprint = sha256(canonicalJson({ subject: input.subject, ruleset }));
    const task: PriorityAssessmentTaskSpec = {
      version: 1,
      kind: "priority_assessment",
      subject: input.subject,
      ruleset,
      assessmentProvenance: { method: "rule" },
      inputFingerprint,
      idempotencyKey: input.successorOf === undefined ? input.idempotencyKey :
        `${input.idempotencyKey}:${input.successorOf.jobId}:${input.successorOf.eventSequence}`,
      stepBatchSize: input.stepBatchSize ?? 50,
      provenance: input.provenance,
      schedulingPriority: input.provenance.requestedBy === "system" ? 0 :
        input.subject.type === "collection" ? 10 : 50,
      budget: { maxSteps, maxTokens: 0, maxCostUsd: 0, maxWallTimeMs: 60_000 },
    };
    return ledger.submit(task);
  }

  function assess(reads: readonly PriorityFeatureRead[]): void {
    if (reads.length === 0) return;
    engine.assess(reads.map((read) => ({
      subject: read.subject, features: read.features, eligibility: read.eligibility,
      assessmentMethod: "rule" as const,
    })), reads[0]!.ruleset);
  }

  function completeGuarded(
    claim: AiJobClaim,
    usageDeltaSteps: number,
    progressCompleted: number,
    progressTotal: number | null,
    expectedDenominator: number,
    initialDenominator: number,
    workStartedAt?: number,
    carriedWallTimeMs = 0,
  ): { completed: boolean; view: DurableJobView } {
    const refreshedClaim = refreshClaim(claim);
    const remainingSteps = claim.task.budget.maxSteps - refreshedClaim.usage.steps;
    const remainingWallTimeMs = claim.task.budget.maxWallTimeMs -
      refreshedClaim.usage.wallTimeMs;
    if (!Number.isSafeInteger(carriedWallTimeMs) || carriedWallTimeMs < 0) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Priority wall time is invalid");
    }
    if (remainingSteps < usageDeltaSteps || remainingWallTimeMs === 0 ||
        carriedWallTimeMs >= remainingWallTimeMs) {
      return { completed: true, view: partialForBudget(refreshedClaim, {
        steps: 0, wallTimeMs: Math.min(carriedWallTimeMs, remainingWallTimeMs),
        completed: progressCompleted, total: progressTotal,
        nextOffset: 0, initialDenominator, observedDenominator: expectedDenominator,
      }) };
    }
    const preflightStartedAt = workStartedAt ?? clock().getTime();
    const projection = guardProjection(options.connection, refreshedClaim.id);
    options.afterPreflight?.(refreshedClaim);
    const preflightElapsed = Math.max(0, clock().getTime() - preflightStartedAt);
    const chargedWallTimeMs = Math.min(
      carriedWallTimeMs + preflightElapsed,
      remainingWallTimeMs,
    );
    const afterPreflight = heartbeat(refreshedClaim);
    if (afterPreflight.cancellationPending) {
      return { completed: true, view: cancelAtCheckpoint(refreshedClaim, {
        steps: usageDeltaSteps, wallTimeMs: chargedWallTimeMs,
        completed: progressCompleted, total: progressTotal, nextOffset: 0,
      }) };
    }
    const guardedClaim = afterPreflight.claim;
    if (projection.overflow !== undefined) {
      const inspectedRows = projection.overflow.observedRows;
      const preflightSteps = Math.max(0, usageDeltaSteps - expectedDenominator) + inspectedRows;
      if (remainingSteps - preflightSteps < inspectedRows ||
          carriedWallTimeMs + preflightElapsed >= remainingWallTimeMs) {
        return { completed: true, view: partialForBudget(refreshedClaim, {
          steps: preflightSteps, wallTimeMs: chargedWallTimeMs,
          completed: progressCompleted, total: progressTotal, nextOffset: 0,
          initialDenominator, observedDenominator: inspectedRows,
        }) };
      }
      return ledger.completePartialIfGuardLimit(guardedClaim, {
        checkpoint: checkpoint(
          refreshedClaim, preflightSteps,
          progressCompleted, progressTotal, "guard-limit-preflight",
          0, chargedWallTimeMs,
        ),
        guard: { guardId: claim.task.subject.type === "collection"
          ? priorityCollectionCoverageGuardId : prioritySingleCoverageGuardId,
        args: [refreshedClaim.id] }, initialDenominator, maxCycles: 4,
      });
    }
    if (remainingSteps - usageDeltaSteps < expectedDenominator ||
        carriedWallTimeMs + preflightElapsed >= remainingWallTimeMs) {
      return { completed: true, view: partialForBudget(refreshedClaim, {
        steps: usageDeltaSteps, wallTimeMs: chargedWallTimeMs,
        completed: progressCompleted, total: progressTotal, nextOffset: 0,
        initialDenominator, observedDenominator: expectedDenominator,
      }) };
    }
    const semanticOk = (refreshedClaim.task.subject.type === "collection" ||
      expectedDenominator === 1) &&
      semanticRowsValid(projection.rows, expectedDenominator);
    options.beforeGuard?.(guardedClaim);
    const beforeGuard = heartbeat(guardedClaim);
    if (beforeGuard.cancellationPending) {
      return { completed: true, view: cancelAtCheckpoint(guardedClaim, {
        steps: usageDeltaSteps, wallTimeMs: chargedWallTimeMs,
        completed: progressCompleted, total: progressTotal, nextOffset: 0,
      }) };
    }
    return ledger.completeIf(beforeGuard.claim, {
      checkpoint: checkpoint(
        refreshedClaim, usageDeltaSteps, progressCompleted, progressTotal, "scanning",
        0, chargedWallTimeMs,
      ),
      guard: {
        guardId: refreshedClaim.task.subject.type === "collection"
          ? priorityCollectionCoverageGuardId : prioritySingleCoverageGuardId,
        args: [refreshedClaim.id], expectedFingerprint: semanticOk
          ? projection.fingerprint : sha256(`semantic-mismatch:${projection.fingerprint}`),
      },
      completion: { status: "succeeded", result: {
        type: "priority_assessment", outputFingerprint: semanticOk
          ? projection.fingerprint : sha256(`semantic-mismatch:${projection.fingerprint}`),
      } },
      onMismatch: { terminalPartial: { version: 1 as const, initialDenominator,
        maxCycles: refreshedClaim.task.subject.type === "collection" ?
          4 as const : 3 as const } },
    });
  }

  function processSingle(claim: AiJobClaim, subject: PrioritySubject): DurableJobView {
    const priorCycles = /^ledger:guard-cycle:(\d+)$/.exec(claim.progress.stage);
    const startCycle = priorCycles === null ? 0 : Number(priorCycles[1]);
    let workingClaim = claim;
    for (let cycle = startCycle; cycle < 3; cycle += 1) {
      workingClaim = refreshClaim(workingClaim);
      const beforeAssessment = heartbeat(workingClaim);
      if (beforeAssessment.cancellationPending) return cancelAtCheckpoint(workingClaim, {
        steps: 0, wallTimeMs: 0, completed: workingClaim.progress.completed,
        total: workingClaim.progress.total, nextOffset: 0,
      });
      workingClaim = beforeAssessment.claim;
      const usageBeforeCycle = workingClaim.usage;
      if (claim.task.budget.maxSteps - usageBeforeCycle.steps < 1 ||
          claim.task.budget.maxWallTimeMs - usageBeforeCycle.wallTimeMs === 0) {
        return partialForBudget(workingClaim, { steps: 0, wallTimeMs: 0,
          completed: workingClaim.progress.completed, total: 1, nextOffset: 0,
          initialDenominator: 1, observedDenominator: 1 });
      }
      const cycleStartedAt = clock().getTime();
      try {
        const read = catalog.read(subject, claim.createdAt);
        options.afterFeatureRead?.(workingClaim);
        const afterRead = heartbeat(workingClaim);
        if (afterRead.cancellationPending) return cancelAtCheckpoint(workingClaim, {
          steps: 0,
          wallTimeMs: Math.max(0, clock().getTime() - cycleStartedAt),
          completed: workingClaim.progress.completed,
          total: 1,
          nextOffset: 0,
        });
        workingClaim = afterRead.claim;
        assess([read]);
      } catch (error) {
        if (error instanceof PriorityFeatureCatalogError && (
          error.code === "PRIORITY_FEATURE_SUBJECT_NOT_FOUND" ||
          error.code === "PRIORITY_FEATURE_RESOURCE_NOT_ACTIVE"
        )) {
          const result = completeGuarded(workingClaim, 1, 1, 1, 0, 1, cycleStartedAt);
          if (result.completed || result.view.status !== "running") return result.view;
          workingClaim = refreshClaim(workingClaim);
          continue;
        }
        throw error;
      }
      options.afterAssess?.(workingClaim);
      const afterAssessment = heartbeat(workingClaim);
      if (afterAssessment.cancellationPending) return cancelAtCheckpoint(workingClaim, {
        steps: 1, wallTimeMs: Math.max(0, clock().getTime() - cycleStartedAt),
        completed: 1, total: 1, nextOffset: 0,
      });
      workingClaim = afterAssessment.claim;
      const result = completeGuarded(workingClaim, 1, 1, 1, 1, 1, cycleStartedAt);
      if (result.completed || result.view.status !== "running") return result.view;
      workingClaim = refreshClaim(workingClaim);
    }
    return partialForBudget(workingClaim, { steps: 0, wallTimeMs: 0,
      completed: 1, total: 1, nextOffset: 0,
      initialDenominator: 1, observedDenominator: 1 });
  }

  function processCollection(claim: AiJobClaim): DurableJobView {
    if (claim.task.kind !== "priority_assessment") {
      throw new DurableAiJobError("INVALID_JOB_TRANSITION", "Invalid priority claim");
    }
    const initialDenominator = claim.task.budget.maxSteps === 8
      ? 0 : claim.task.budget.maxSteps / 12;
    if (!Number.isSafeInteger(initialDenominator)) {
      throw new DurableAiJobError("INVALID_JOB_TRANSITION", "Invalid collection budget");
    }
    const priorCycles = /^ledger:guard-cycle:(\d+)$/.exec(claim.progress.stage);
    const startCycle = priorCycles === null ? 0 : Number(priorCycles[1]);
    let workingClaim = claim;
    let progressCompleted = claim.progress.completed;
    let startOffset = claim.checkpoint !== null && "nextOffset" in claim.checkpoint
      ? claim.checkpoint.nextOffset : 0;
    let lastObservedDenominator = initialDenominator;
    for (let cycle = startCycle; cycle < 4; cycle += 1) {
      const enumerationStartedAt = clock().getTime();
      const subjects: PrioritySubject[] = [];
      let after: PrioritySubject | undefined;
      while (true) {
        const page = catalog.listSubjectPage({
          ...(after === undefined ? {} : { after }),
          limit: 100,
        });
        subjects.push(...page.items);
        workingClaim = refreshClaim(workingClaim);
        const pageHeartbeat = heartbeat(workingClaim);
        if (pageHeartbeat.cancellationPending) return cancelAtCheckpoint(workingClaim, {
          steps: 0,
          wallTimeMs: Math.max(0, clock().getTime() - enumerationStartedAt),
          completed: progressCompleted,
          total: null,
          nextOffset: startOffset,
        });
        workingClaim = pageHeartbeat.claim;
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      }
      options.afterListSubjects?.();
      const enumerationWallTimeMs = Math.max(0, clock().getTime() - enumerationStartedAt);
      lastObservedDenominator = subjects.length;
      workingClaim = refreshClaim(workingClaim);
      const afterEnumeration = heartbeat(workingClaim);
      if (afterEnumeration.cancellationPending) return cancelAtCheckpoint(workingClaim, {
        steps: 0, wallTimeMs: enumerationWallTimeMs,
        completed: progressCompleted, total: null, nextOffset: startOffset,
      });
      workingClaim = afterEnumeration.claim;
      let usage = workingClaim.usage;
      if (claim.task.budget.maxSteps - usage.steps < subjects.length ||
          claim.task.budget.maxWallTimeMs - usage.wallTimeMs === 0 ||
          enumerationWallTimeMs >= claim.task.budget.maxWallTimeMs - usage.wallTimeMs) {
        return partialForBudget(workingClaim, { steps: 0,
          wallTimeMs: Math.min(enumerationWallTimeMs,
            claim.task.budget.maxWallTimeMs - usage.wallTimeMs),
          completed: progressCompleted, total: null, nextOffset: startOffset,
          initialDenominator, observedDenominator: subjects.length });
      }
      let pendingWallTimeMs = enumerationWallTimeMs;
      for (let offset = startOffset; offset < subjects.length;
        offset += claim.task.stepBatchSize) {
        const batch = subjects.slice(offset, offset + claim.task.stepBatchSize);
        workingClaim = refreshClaim(workingClaim);
        const beforeBatch = heartbeat(workingClaim);
        if (beforeBatch.cancellationPending) return cancelAtCheckpoint(workingClaim, {
          steps: 0, wallTimeMs: pendingWallTimeMs,
          completed: progressCompleted, total: null, nextOffset: offset,
        });
        workingClaim = beforeBatch.claim;
        usage = workingClaim.usage;
        const remainingSteps = claim.task.budget.maxSteps - usage.steps;
        const remainingWallTimeMs = claim.task.budget.maxWallTimeMs - usage.wallTimeMs;
        if (remainingSteps < batch.length || remainingWallTimeMs === 0 ||
            pendingWallTimeMs >= remainingWallTimeMs) {
          return partialForBudget(workingClaim, { steps: 0,
            wallTimeMs: Math.min(pendingWallTimeMs, remainingWallTimeMs),
            completed: progressCompleted, total: null, nextOffset: offset,
            initialDenominator, observedDenominator: subjects.length });
        }
        const batchStartedAt = clock().getTime();
        const reads = catalog.readBatch(batch, claim.createdAt);
        options.afterFeatureRead?.(workingClaim);
        const afterRead = heartbeat(workingClaim);
        if (afterRead.cancellationPending) return cancelAtCheckpoint(workingClaim, {
          steps: 0,
          wallTimeMs: pendingWallTimeMs +
            Math.max(0, clock().getTime() - batchStartedAt),
          completed: progressCompleted,
          total: null,
          nextOffset: offset,
        });
        workingClaim = afterRead.claim;
        assess(reads);
        options.afterAssess?.(workingClaim);
        const batchWallTimeMs = Math.max(0, clock().getTime() - batchStartedAt);
        const completedAfterBatch = progressCompleted + batch.length;
        const afterBatch = heartbeat(workingClaim);
        if (afterBatch.cancellationPending) return cancelAtCheckpoint(workingClaim, {
          steps: batch.length, wallTimeMs: pendingWallTimeMs + batchWallTimeMs,
          completed: completedAfterBatch, total: null,
          nextOffset: offset + batch.length,
        });
        workingClaim = afterBatch.claim;
        const chargedBatchWallTimeMs = Math.min(
          pendingWallTimeMs + batchWallTimeMs,
          remainingWallTimeMs,
        );
        progressCompleted = completedAfterBatch;
        if (pendingWallTimeMs + batchWallTimeMs >= remainingWallTimeMs) {
          return partialForBudget(workingClaim, { steps: batch.length,
            wallTimeMs: chargedBatchWallTimeMs, completed: progressCompleted,
            total: null, nextOffset: offset + batch.length,
            initialDenominator, observedDenominator: subjects.length });
        }
        const view = ledger.checkpoint(workingClaim, checkpoint(
          workingClaim, batch.length, progressCompleted, null, "scanning",
          offset + batch.length, chargedBatchWallTimeMs,
        ));
        options.afterBatchCheckpoint?.(workingClaim, view);
        if (view.status !== "running") return view;
        workingClaim = { ...workingClaim,
          progress: view.progress,
          checkpoint: { version: 1, nextOffset: offset + batch.length },
          usage: { ...workingClaim.usage, steps: workingClaim.usage.steps + batch.length,
            wallTimeMs: workingClaim.usage.wallTimeMs + chargedBatchWallTimeMs } };
        pendingWallTimeMs = 0;
      }
      const result = completeGuarded(
        workingClaim, subjects.length, progressCompleted, null, subjects.length,
        initialDenominator, undefined, pendingWallTimeMs,
      );
      if (result.completed || result.view.status !== "running") return result.view;
      workingClaim = refreshClaim(workingClaim);
      startOffset = 0;
    }
    return partialForBudget(workingClaim, { steps: 0, wallTimeMs: 0,
      completed: progressCompleted, total: null, nextOffset: 0,
      initialDenominator, observedDenominator: lastObservedDenominator });
  }

  function claimNext(
    workerId: string,
    claimBoundary?: AiJobClaimBoundary,
  ): AiJobClaim | undefined {
    if (!options.writerEnabled) return undefined;
    return ledger.claimNext("priority_assessment", workerId, {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 100,
      maxCostUsdPerUtcDay: null,
    }, claimBoundary);
  }

  function executeClaim(claim: AiJobClaim): DurableJobView {
    if (claim.task.kind !== "priority_assessment") {
      throw new DurableAiJobError("INVALID_JOB_TRANSITION", "Invalid priority claim");
    }
    if (claim.task.assessmentProvenance.method !== "rule") {
      const nextOffset = claim.checkpoint !== null && "nextOffset" in claim.checkpoint
        ? claim.checkpoint.nextOffset : 0;
      return ledger.fail(claim, checkpoint(
        claim, 0, claim.progress.completed, claim.progress.total,
        "unsupported-assessment-method", nextOffset,
      ), { code: "JOB_INPUT_UNAVAILABLE" });
    }
    return claim.task.subject.type === "collection"
      ? processCollection(claim)
      : processSingle(claim, claim.task.subject);
  }

  return {
    submit,
    read: (subject, anchor = now()) => catalog.read(subject, anchor),
    readBatch: (subjects, anchor = now()) => catalog.readBatch(subjects, anchor),
    readListProjection(type, ids, anchor = now()) {
      if (ids.length === 0) return [];
      validatePriorityListSubjectIds(ids);
      replacePriorityListRequested(JSON.stringify(ids));
      const corrupt = selectPriorityListCorruptXor.get({ type }) as
        { subjectId: number; xorCount: number } | undefined;
      if (corrupt !== undefined) {
        throw new PriorityEngineError(
          "PRIORITY_STORAGE_CORRUPT",
          `Corrupt priority XOR for ${type}:${corrupt.subjectId}`,
        );
      }
      const rows = selectPriorityListProjection.all({
        type,
        anchor,
      }) as Array<{
        subjectId: number;
        xorCount: number;
        bandRank: 0 | 1 | 2 | 3 | 4;
        agentScore: number;
        needsReview: 0 | 1;
      }>;
      const projectedCorrupt = rows.find((row) => row.xorCount > 1);
      if (projectedCorrupt !== undefined) {
        throw new PriorityEngineError(
          "PRIORITY_STORAGE_CORRUPT",
          `Corrupt priority XOR for ${type}:${projectedCorrupt.subjectId}`,
        );
      }
      const ranked = new Map(rows.map((row) => [row.subjectId, {
        subjectId: row.subjectId,
        bandRank: row.bandRank,
        agentScore: row.agentScore,
        needsReview: row.needsReview === 1,
      }]));
      return ids.map((subjectId) =>
        ranked.get(subjectId) ?? {
          subjectId,
          bandRank: 0,
          agentScore: -1,
          needsReview: false,
        });
    },
    previewBatch: (subjects, anchor = now()) => catalog.previewBatch(subjects, anchor),
    listSubjectPage: (input) => catalog.listSubjectPage(input),
    reviewQueue(input) {
      return catalog.reviewQueue({ anchor: input.anchor ?? now(), limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
    },
    recordFeedback(input) {
      const row = feedbackSubject[input.expectedSubject.type].get(input.assessmentId) as
        { id: number } | undefined;
      const expectedId = input.expectedSubject.type === "page"
        ? input.expectedSubject.logicalPageId : input.expectedSubject.resourceId;
      if (row?.id !== expectedId) {
        throw new PriorityEngineError(
          row === undefined ? "PRIORITY_OUTCOME_NOT_FOUND" : "INVALID_PRIORITY_INPUT",
          "Priority feedback assessment does not match expected subject",
        );
      }
      const { expectedSubject, ...rest } = input;
      return engine.recordFeedback({ subject: expectedSubject, ...rest });
    },
    recoverInterrupted: () => options.writerEnabled ? ledger.recoverInterrupted() : 0,
    claim: claimNext,
    executeClaim,
    process(workerId, claimBoundary) {
      const claim = claimNext(workerId, claimBoundary);
      if (claim === undefined) return undefined;
      return executeClaim(claim);
    },
  };
}
