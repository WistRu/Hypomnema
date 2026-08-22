ALTER TABLE ai_job_attempts ADD COLUMN pricing_version TEXT CHECK (
  pricing_version IS NULL OR (
    length(CAST(pricing_version AS BLOB)) BETWEEN 1 AND 128
    AND pricing_version = trim(pricing_version)
  )
);

CREATE TRIGGER ai_job_attempts_pricing_initial_guard
BEFORE INSERT ON ai_job_attempts
WHEN NEW.pricing_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid initial ai job attempt pricing');
END;

CREATE TRIGGER ai_job_attempts_pricing_binding_guard
BEFORE UPDATE OF provider, model, prompt_version, pricing_version ON ai_job_attempts
BEGIN
  SELECT CASE WHEN NOT (
    NEW.pricing_version IS OLD.pricing_version
    OR (
      OLD.pricing_version IS NULL AND NEW.pricing_version IS NOT NULL
      AND OLD.provider IS NULL AND OLD.model IS NULL AND OLD.prompt_version IS NULL
      AND NEW.provider IS NOT NULL AND NEW.model IS NOT NULL
      AND NEW.prompt_version IS NOT NULL
      AND NEW.outcome = 'running' AND NEW.completed_at IS NULL
    )
  ) THEN RAISE(ABORT, 'invalid ai job attempt pricing binding') END;
  SELECT CASE WHEN NEW.provider IS NULL AND NEW.pricing_version IS NOT NULL
    THEN RAISE(ABORT, 'unbound ai job attempt cannot have pricing') END;
  SELECT CASE WHEN NEW.provider IS NOT NULL AND NEW.pricing_version IS NULL
    AND EXISTS (
      SELECT 1 FROM ai_jobs
      WHERE id = NEW.job_id AND kind = 'resource_research'
    )
    THEN RAISE(ABORT, 'research attempt pricing is required') END;
END;

DROP TRIGGER ai_jobs_validate_checkpoint_insert;
DROP TRIGGER ai_jobs_validate_checkpoint_update;

CREATE TRIGGER ai_jobs_validate_checkpoint_insert
BEFORE INSERT ON ai_jobs
WHEN NEW.checkpoint_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    json_valid(NEW.checkpoint_json)
    AND json_type(NEW.checkpoint_json) = 'object'
    AND NEW.checkpoint_json = json(NEW.checkpoint_json)
    AND json_type(NEW.checkpoint_json, '$.version') = 'integer'
    AND json_extract(NEW.checkpoint_json, '$.version') = 1
    AND (
      (NEW.kind = 'priority_assessment'
        AND (SELECT COUNT(*) FROM json_each(NEW.checkpoint_json)) = 2
        AND json_type(NEW.checkpoint_json, '$.nextOffset') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextOffset') BETWEEN 0 AND 9007199254740991
        AND NEW.checkpoint_json = json_object(
          'nextOffset', json_extract(NEW.checkpoint_json, '$.nextOffset'),
          'version', 1
        ))
      OR (NEW.kind = 'resource_research'
        AND length(CAST(NEW.checkpoint_json AS BLOB)) <= 2048
        AND (
          (json_extract(NEW.checkpoint_json, '$.nextStep') = 0
            AND NEW.checkpoint_json = json_object(
              'nextStep', 0, 'stage', 'claimed', 'version', 1
            ))
          OR (json_extract(NEW.checkpoint_json, '$.nextStep') = 1
            AND json_type(NEW.checkpoint_json, '$.corpusDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.corpusDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.corpusDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.parentDigest') IN ('null', 'text')
            AND (json_type(NEW.checkpoint_json, '$.parentDigest') = 'null' OR (
              length(json_extract(NEW.checkpoint_json, '$.parentDigest')) = 64
              AND json_extract(NEW.checkpoint_json, '$.parentDigest') NOT GLOB '*[^0-9a-f]*'
            ))
            AND json_type(NEW.checkpoint_json, '$.providerInputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerInputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerInputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.quoteDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.quoteDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.quoteDigest') NOT GLOB '*[^0-9a-f]*'
            AND NEW.checkpoint_json = json_object(
              'corpusDigest', json_extract(NEW.checkpoint_json, '$.corpusDigest'),
              'nextStep', 1,
              'parentDigest', json_extract(NEW.checkpoint_json, '$.parentDigest'),
              'providerInputDigest', json_extract(NEW.checkpoint_json, '$.providerInputDigest'),
              'quoteDigest', json_extract(NEW.checkpoint_json, '$.quoteDigest'),
              'stage', 'provider_ready', 'version', 1
            ))
          OR (json_extract(NEW.checkpoint_json, '$.nextStep') = 2
            AND json_type(NEW.checkpoint_json, '$.corpusDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.corpusDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.corpusDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.parentDigest') IN ('null', 'text')
            AND (json_type(NEW.checkpoint_json, '$.parentDigest') = 'null' OR (
              length(json_extract(NEW.checkpoint_json, '$.parentDigest')) = 64
              AND json_extract(NEW.checkpoint_json, '$.parentDigest') NOT GLOB '*[^0-9a-f]*'
            ))
            AND json_type(NEW.checkpoint_json, '$.providerInputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerInputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerInputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.providerOutputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerOutputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerOutputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.quoteDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.quoteDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.quoteDigest') NOT GLOB '*[^0-9a-f]*'
            AND NEW.checkpoint_json = json_object(
              'corpusDigest', json_extract(NEW.checkpoint_json, '$.corpusDigest'),
              'nextStep', 2,
              'parentDigest', json_extract(NEW.checkpoint_json, '$.parentDigest'),
              'providerInputDigest', json_extract(NEW.checkpoint_json, '$.providerInputDigest'),
              'providerOutputDigest', json_extract(NEW.checkpoint_json, '$.providerOutputDigest'),
              'quoteDigest', json_extract(NEW.checkpoint_json, '$.quoteDigest'),
              'stage', 'terminal_publication', 'version', 1
            ))
        ))
    )
  ) THEN RAISE(ABORT, 'invalid ai job checkpoint') END;
END;

CREATE TRIGGER ai_jobs_validate_checkpoint_update
BEFORE UPDATE OF checkpoint_json ON ai_jobs
WHEN NEW.checkpoint_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    json_valid(NEW.checkpoint_json)
    AND json_type(NEW.checkpoint_json) = 'object'
    AND NEW.checkpoint_json = json(NEW.checkpoint_json)
    AND json_type(NEW.checkpoint_json, '$.version') = 'integer'
    AND json_extract(NEW.checkpoint_json, '$.version') = 1
    AND (
      (NEW.kind = 'priority_assessment'
        AND (SELECT COUNT(*) FROM json_each(NEW.checkpoint_json)) = 2
        AND json_type(NEW.checkpoint_json, '$.nextOffset') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextOffset') BETWEEN 0 AND 9007199254740991
        AND NEW.checkpoint_json = json_object(
          'nextOffset', json_extract(NEW.checkpoint_json, '$.nextOffset'),
          'version', 1
        ))
      OR (NEW.kind = 'resource_research'
        AND length(CAST(NEW.checkpoint_json AS BLOB)) <= 2048
        AND (
          (json_extract(NEW.checkpoint_json, '$.nextStep') = 0
            AND NEW.checkpoint_json = json_object(
              'nextStep', 0, 'stage', 'claimed', 'version', 1
            ))
          OR (json_extract(NEW.checkpoint_json, '$.nextStep') = 1
            AND json_type(NEW.checkpoint_json, '$.corpusDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.corpusDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.corpusDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.parentDigest') IN ('null', 'text')
            AND (json_type(NEW.checkpoint_json, '$.parentDigest') = 'null' OR (
              length(json_extract(NEW.checkpoint_json, '$.parentDigest')) = 64
              AND json_extract(NEW.checkpoint_json, '$.parentDigest') NOT GLOB '*[^0-9a-f]*'
            ))
            AND json_type(NEW.checkpoint_json, '$.providerInputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerInputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerInputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.quoteDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.quoteDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.quoteDigest') NOT GLOB '*[^0-9a-f]*'
            AND NEW.checkpoint_json = json_object(
              'corpusDigest', json_extract(NEW.checkpoint_json, '$.corpusDigest'),
              'nextStep', 1,
              'parentDigest', json_extract(NEW.checkpoint_json, '$.parentDigest'),
              'providerInputDigest', json_extract(NEW.checkpoint_json, '$.providerInputDigest'),
              'quoteDigest', json_extract(NEW.checkpoint_json, '$.quoteDigest'),
              'stage', 'provider_ready', 'version', 1
            ))
          OR (json_extract(NEW.checkpoint_json, '$.nextStep') = 2
            AND json_type(NEW.checkpoint_json, '$.corpusDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.corpusDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.corpusDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.parentDigest') IN ('null', 'text')
            AND (json_type(NEW.checkpoint_json, '$.parentDigest') = 'null' OR (
              length(json_extract(NEW.checkpoint_json, '$.parentDigest')) = 64
              AND json_extract(NEW.checkpoint_json, '$.parentDigest') NOT GLOB '*[^0-9a-f]*'
            ))
            AND json_type(NEW.checkpoint_json, '$.providerInputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerInputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerInputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.providerOutputDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.providerOutputDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.providerOutputDigest') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.checkpoint_json, '$.quoteDigest') = 'text'
            AND length(json_extract(NEW.checkpoint_json, '$.quoteDigest')) = 64
            AND json_extract(NEW.checkpoint_json, '$.quoteDigest') NOT GLOB '*[^0-9a-f]*'
            AND NEW.checkpoint_json = json_object(
              'corpusDigest', json_extract(NEW.checkpoint_json, '$.corpusDigest'),
              'nextStep', 2,
              'parentDigest', json_extract(NEW.checkpoint_json, '$.parentDigest'),
              'providerInputDigest', json_extract(NEW.checkpoint_json, '$.providerInputDigest'),
              'providerOutputDigest', json_extract(NEW.checkpoint_json, '$.providerOutputDigest'),
              'quoteDigest', json_extract(NEW.checkpoint_json, '$.quoteDigest'),
              'stage', 'terminal_publication', 'version', 1
            ))
        )
        AND (
          (OLD.checkpoint_json IS NULL
            AND json_extract(NEW.checkpoint_json, '$.nextStep') = 0)
          OR (OLD.checkpoint_json IS NOT NULL
            AND json_extract(NEW.checkpoint_json, '$.nextStep')
              BETWEEN json_extract(OLD.checkpoint_json, '$.nextStep')
                AND json_extract(OLD.checkpoint_json, '$.nextStep') + 1
            AND (json_extract(NEW.checkpoint_json, '$.nextStep') <>
              json_extract(OLD.checkpoint_json, '$.nextStep')
              OR NEW.checkpoint_json = OLD.checkpoint_json))
        ))
    )
  ) THEN RAISE(ABORT, 'invalid ai job checkpoint') END;
END;

DROP TRIGGER ai_job_events_validate_insert;

CREATE TRIGGER ai_job_events_validate_insert
BEFORE INSERT ON ai_job_events
BEGIN
  SELECT CASE WHEN NEW.sequence_no <> (
    SELECT event_sequence + 1 FROM ai_jobs WHERE id = NEW.job_id
  ) THEN RAISE(ABORT, 'non-contiguous ai job event') END;
  SELECT CASE WHEN NEW.occurred_at < (
    SELECT updated_at FROM ai_jobs WHERE id = NEW.job_id
  ) THEN RAISE(ABORT, 'ai job event clock regression') END;
  SELECT CASE WHEN NEW.occurred_at < COALESCE((
    SELECT MAX(COALESCE(request_bound_at, provider_bound_at, started_at))
    FROM ai_job_attempts WHERE job_id = NEW.job_id
  ), NEW.occurred_at) THEN RAISE(ABORT, 'ai job attempt event clock regression') END;
  SELECT CASE WHEN NOT (
    (NEW.event_type = 'submitted' AND NEW.from_status IS NULL
      AND NEW.to_status = 'queued'
      AND (SELECT event_sequence FROM ai_jobs WHERE id = NEW.job_id) = 0)
    OR (NEW.event_type = 'claimed' AND NEW.from_status = 'queued'
      AND NEW.to_status = 'running')
    OR (NEW.event_type IN ('progress', 'cancel_requested')
      AND NEW.from_status = 'running' AND NEW.to_status = 'running')
    OR (NEW.event_type = 'deferred'
      AND NEW.from_status = 'queued' AND NEW.to_status = 'queued')
    OR (NEW.event_type IN ('retry_scheduled', 'recovered')
      AND NEW.from_status = 'running' AND NEW.to_status = 'queued')
    OR (NEW.event_type IN ('succeeded', 'partial', 'failed')
      AND NEW.from_status = 'running' AND NEW.to_status = NEW.event_type)
    OR (NEW.event_type = 'cancelled' AND NEW.from_status IN ('queued', 'running')
      AND NEW.to_status = 'cancelled')
    OR (NEW.event_type = 'superseded' AND NEW.from_status IN ('queued', 'running')
      AND NEW.to_status = 'superseded')
  ) THEN RAISE(ABORT, 'illegal ai job event transition') END;
  SELECT CASE WHEN NEW.event_type <> 'submitted'
    AND NEW.from_status <> (SELECT status FROM ai_jobs WHERE id = NEW.job_id)
    THEN RAISE(ABORT, 'stale ai job event transition') END;
  SELECT CASE WHEN NEW.event_type = 'claimed' AND NOT (
    NEW.attempt_id IS NOT NULL
    AND NEW.lease_owner IS NOT NULL
    AND NEW.lease_token IS NOT NULL
    AND NEW.lease_expires_at > NEW.occurred_at
    AND EXISTS (
      SELECT 1 FROM ai_job_attempts
      WHERE id = NEW.attempt_id AND job_id = NEW.job_id
        AND lease_token = NEW.lease_token AND worker_id = NEW.lease_owner
        AND outcome = 'running'
    )
  ) THEN RAISE(ABORT, 'invalid ai job claim event') END;
  SELECT CASE WHEN NEW.from_status = 'running'
    AND NEW.event_type <> 'cancel_requested'
    AND NOT (
      NEW.lease_token IS NOT NULL
      AND NEW.lease_token = (
        SELECT lease_token FROM ai_jobs WHERE id = NEW.job_id
      )
    ) THEN RAISE(ABORT, 'stale ai job lease event') END;
  SELECT CASE WHEN NEW.from_status = 'running'
    AND NEW.event_type <> 'cancel_requested'
    AND NOT (
      NEW.attempt_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ai_job_attempts
        WHERE id = NEW.attempt_id AND job_id = NEW.job_id
          AND lease_token = NEW.lease_token AND outcome = 'running'
      )
    ) THEN RAISE(ABORT, 'invalid ai job attempt event') END;
  SELECT CASE WHEN NEW.event_type IN (
      'progress', 'succeeded', 'partial', 'retry_scheduled'
    ) AND NOT (
      NEW.occurred_at < (
        SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
      )
    ) THEN RAISE(ABORT, 'expired ai job lease event') END;
  SELECT CASE WHEN NEW.event_type = 'recovered' AND NOT (
    NEW.occurred_at >= (
      SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
    )
  ) THEN RAISE(ABORT, 'unexpired ai job recovery event') END;
  SELECT CASE WHEN NEW.event_type IN ('retry_scheduled', 'recovered') AND NOT EXISTS (
    SELECT 1 FROM ai_jobs WHERE id = NEW.job_id
      AND attempts < max_attempts
      AND spent_steps < max_steps
      AND (
        (kind = 'priority_assessment' AND (max_tokens = 0 OR spent_tokens < max_tokens))
        OR (kind = 'resource_research' AND spent_tokens < max_tokens)
      )
      AND (
        (kind = 'priority_assessment' AND (max_cost_usd = 0 OR spent_cost_usd < max_cost_usd))
        OR (kind = 'resource_research' AND spent_cost_usd < max_cost_usd)
      )
      AND spent_wall_time_ms < max_wall_time_ms
  ) THEN RAISE(ABORT, 'exhausted ai job cannot be requeued') END;
  SELECT CASE WHEN NEW.event_type = 'failed' AND NOT (
    NEW.occurred_at < (
      SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
    ) OR (
      NEW.error_code = 'JOB_BUDGET_EXHAUSTED'
      AND NEW.occurred_at >= (
        SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
      )
      AND EXISTS (
        SELECT 1 FROM ai_jobs WHERE id = NEW.job_id AND (
          attempts >= max_attempts OR spent_steps >= max_steps
          OR (kind = 'resource_research' AND max_tokens = 0)
          OR (max_tokens > 0 AND spent_tokens >= max_tokens)
          OR (kind = 'resource_research' AND max_cost_usd = 0)
          OR (max_cost_usd > 0 AND spent_cost_usd >= max_cost_usd)
          OR spent_wall_time_ms >= max_wall_time_ms
        )
      )
    )
  ) THEN RAISE(ABORT, 'invalid expired ai job failure') END;
  SELECT CASE WHEN NEW.event_type = 'cancel_requested' AND NOT (
    NEW.cancellation_requested_by IS NOT NULL
    AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
    AND (SELECT cancellation_requested_by FROM ai_jobs WHERE id = NEW.job_id) IS NULL
    AND (SELECT cancellation_requested_at FROM ai_jobs WHERE id = NEW.job_id) IS NULL
  ) THEN RAISE(ABORT, 'invalid ai job cancellation event') END;
  SELECT CASE WHEN (
    NEW.event_type IN ('submitted', 'deferred', 'cancel_requested')
    OR (NEW.event_type IN ('cancelled', 'superseded') AND NEW.from_status = 'queued')
  ) AND (NEW.attempt_id IS NOT NULL OR NEW.lease_token IS NOT NULL)
    THEN RAISE(ABORT, 'unexpected queued ai job attempt payload') END;
  SELECT CASE WHEN NEW.event_type = 'cancelled'
    AND NEW.from_status = 'queued'
    AND NEW.cancellation_requested_by IS NULL
    THEN RAISE(ABORT, 'missing queued cancellation requester') END;
  SELECT CASE WHEN NEW.event_type = 'cancelled'
    AND NEW.from_status = 'running' AND NOT (
      NEW.cancellation_requested_by IS NULL
      AND (SELECT cancellation_requested_by FROM ai_jobs WHERE id = NEW.job_id)
        IS NOT NULL
      AND (SELECT cancellation_requested_at FROM ai_jobs WHERE id = NEW.job_id)
        IS NOT NULL
    ) THEN RAISE(ABORT, 'missing running cancellation request') END;
  SELECT CASE WHEN NEW.event_type = 'cancelled'
    AND NEW.from_status = 'running'
    AND NEW.occurred_at < (
      SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
    ) AND NOT EXISTS (
      SELECT 1 FROM ai_job_events
      WHERE job_id = NEW.job_id AND event_type = 'progress'
        AND attempt_id = NEW.attempt_id AND lease_token = NEW.lease_token
        AND checkpoint_json IS NOT NULL
        AND occurred_at = NEW.occurred_at
        AND sequence_no = NEW.sequence_no - 1
    ) THEN RAISE(ABORT, 'running cancellation requires checkpoint') END;
  SELECT CASE WHEN (
    NEW.event_type IN ('succeeded', 'partial', 'retry_scheduled')
    OR (NEW.event_type = 'failed' AND NEW.occurred_at < (
      SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
    ))
    OR (NEW.event_type = 'cancelled' AND NEW.from_status = 'running'
      AND NEW.occurred_at < (
        SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
      ))
  ) AND NOT EXISTS (
    SELECT 1 FROM ai_job_events
    WHERE job_id = NEW.job_id AND event_type = 'progress'
      AND attempt_id = NEW.attempt_id AND lease_token = NEW.lease_token
      AND checkpoint_json IS NOT NULL
      AND occurred_at = NEW.occurred_at
      AND sequence_no = NEW.sequence_no - 1
  ) THEN RAISE(ABORT, 'worker terminal event requires final checkpoint') END;
  SELECT CASE WHEN NEW.event_type = 'progress' AND NOT (
    NEW.progress_completed IS NOT NULL
    AND NEW.progress_completed >= (
      SELECT progress_completed FROM ai_jobs WHERE id = NEW.job_id
    )
    AND ((SELECT progress_total FROM ai_jobs WHERE id = NEW.job_id) IS NULL
      OR NEW.progress_total = (
        SELECT progress_total FROM ai_jobs WHERE id = NEW.job_id
      ))
    AND (NEW.progress_total IS NULL OR NEW.progress_completed <= NEW.progress_total)
    AND NEW.progress_stage IS NOT NULL
    AND NEW.spent_steps IS NOT NULL
    AND NEW.delta_steps IS NOT NULL
    AND NEW.spent_steps >= (SELECT spent_steps FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.spent_steps <= (SELECT max_steps FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.delta_steps = NEW.spent_steps - (
      SELECT spent_steps FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.spent_tokens IS NOT NULL
    AND NEW.spent_tokens >= (SELECT spent_tokens FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.spent_tokens <= (SELECT max_tokens FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.spent_input_tokens IS NOT NULL
    AND NEW.spent_output_tokens IS NOT NULL
    AND NEW.delta_input_tokens IS NOT NULL
    AND NEW.delta_output_tokens IS NOT NULL
    AND NEW.spent_tokens = NEW.spent_input_tokens + NEW.spent_output_tokens
    AND NEW.delta_input_tokens = NEW.spent_input_tokens - COALESCE((
      SELECT SUM(input_tokens) FROM ai_job_attempts
      WHERE job_id = NEW.job_id
    ), 0)
    AND NEW.delta_output_tokens = NEW.spent_output_tokens - COALESCE((
      SELECT SUM(output_tokens) FROM ai_job_attempts
      WHERE job_id = NEW.job_id
    ), 0)
    AND NEW.spent_cost_usd IS NOT NULL
    AND NEW.delta_cost_usd IS NOT NULL
    AND NEW.delta_cost_usd = NEW.spent_cost_usd - (
      SELECT spent_cost_usd FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.spent_cost_usd >= (SELECT spent_cost_usd FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.spent_cost_usd <= (SELECT max_cost_usd FROM ai_jobs WHERE id = NEW.job_id)
    AND NEW.spent_wall_time_ms IS NOT NULL
    AND NEW.delta_wall_time_ms IS NOT NULL
    AND NEW.spent_wall_time_ms >= (
      SELECT spent_wall_time_ms FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.spent_wall_time_ms <= (
      SELECT max_wall_time_ms FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.delta_wall_time_ms = NEW.spent_wall_time_ms - (
      SELECT spent_wall_time_ms FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.spent_tokens >= COALESCE((
      SELECT SUM(input_tokens + output_tokens) FROM ai_job_attempts
      WHERE job_id = NEW.job_id AND id <> NEW.attempt_id
    ), 0)
    AND NEW.spent_cost_usd >= COALESCE((
      SELECT SUM(cost_usd) FROM ai_job_attempts
      WHERE job_id = NEW.job_id AND id <> NEW.attempt_id
    ), 0)
    AND (
      (NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
      OR (
        NEW.lease_owner = (SELECT lease_owner FROM ai_jobs WHERE id = NEW.job_id)
        AND NEW.lease_expires_at = strftime(
          '%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at, '+60 seconds'
        )
      )
    )
  ) THEN RAISE(ABORT, 'invalid ai job progress event') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('claimed', 'progress')
    AND (NEW.progress_completed IS NOT NULL OR NEW.progress_total IS NOT NULL
      OR NEW.progress_stage IS NOT NULL OR NEW.checkpoint_json IS NOT NULL)
    THEN RAISE(ABORT, 'unexpected ai job progress payload') END;
  SELECT CASE WHEN NEW.event_type <> 'progress'
    AND (NEW.spent_steps IS NOT NULL OR NEW.spent_tokens IS NOT NULL
      OR NEW.spent_input_tokens IS NOT NULL OR NEW.spent_output_tokens IS NOT NULL
      OR NEW.delta_input_tokens IS NOT NULL OR NEW.delta_output_tokens IS NOT NULL
      OR NEW.delta_cost_usd IS NOT NULL
      OR NEW.delta_steps IS NOT NULL OR NEW.delta_wall_time_ms IS NOT NULL
      OR NEW.spent_cost_usd IS NOT NULL OR NEW.spent_wall_time_ms IS NOT NULL)
    THEN RAISE(ABORT, 'unexpected ai job usage payload') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('claimed', 'progress')
    AND (NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
    THEN RAISE(ABORT, 'unexpected ai job lease payload') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('succeeded', 'partial')
    AND (NEW.result_type IS NOT NULL OR NEW.result_output_fingerprint IS NOT NULL
      OR NEW.result_report_id IS NOT NULL)
    THEN RAISE(ABORT, 'unexpected ai job result payload') END;
  SELECT CASE WHEN NEW.event_type IN ('succeeded', 'partial') AND NOT (
    ((SELECT kind FROM ai_jobs WHERE id = NEW.job_id) = 'priority_assessment'
      AND NEW.result_type = 'priority_output'
      AND NEW.result_output_fingerprint IS NOT NULL AND NEW.result_report_id IS NULL)
    OR ((SELECT kind FROM ai_jobs WHERE id = NEW.job_id) = 'resource_research'
      AND NEW.result_type = 'research_report'
      AND NEW.result_output_fingerprint IS NULL AND NEW.result_report_id IS NOT NULL)
  ) THEN RAISE(ABORT, 'invalid ai job result payload') END;
  SELECT CASE WHEN NEW.event_type IN ('succeeded', 'partial')
    AND (SELECT kind FROM ai_jobs WHERE id = NEW.job_id) = 'priority_assessment'
    AND NOT (
      ((SELECT assessment_method FROM ai_jobs WHERE id = NEW.job_id) = 'rule'
        AND (SELECT provider FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NULL
        AND (SELECT model FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NULL
        AND (SELECT prompt_version FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NULL)
      OR ((SELECT assessment_method FROM ai_jobs WHERE id = NEW.job_id) = 'model'
        AND (
          (NEW.event_type = 'partial'
            AND (SELECT provider FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NULL
            AND (SELECT model FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NULL
            AND (SELECT prompt_version FROM ai_job_attempts WHERE id = NEW.attempt_id)
              IS NULL)
          OR (
            (SELECT provider FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NOT NULL
            AND (SELECT model FROM ai_job_attempts WHERE id = NEW.attempt_id) IS NOT NULL
            AND (SELECT prompt_version FROM ai_job_attempts WHERE id = NEW.attempt_id)
              IS NOT NULL
            AND (SELECT provider FROM ai_job_attempts WHERE id = NEW.attempt_id) =
              (SELECT assessment_model_provider FROM ai_jobs WHERE id = NEW.job_id)
            AND (SELECT model FROM ai_job_attempts WHERE id = NEW.attempt_id) =
              (SELECT assessment_model_name FROM ai_jobs WHERE id = NEW.job_id)
            AND (SELECT prompt_version FROM ai_job_attempts WHERE id = NEW.attempt_id) =
              (SELECT assessment_prompt_version FROM ai_jobs WHERE id = NEW.job_id)
          )
        ))
    ) THEN RAISE(ABORT, 'invalid assessment attempt provenance') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('failed', 'partial', 'retry_scheduled')
    AND NEW.error_code IS NOT NULL
    THEN RAISE(ABORT, 'unexpected ai job error payload') END;
  SELECT CASE WHEN NEW.event_type = 'failed' AND NEW.error_code IS NULL
    THEN RAISE(ABORT, 'missing ai job error payload') END;
  SELECT CASE WHEN NEW.event_type = 'retry_scheduled' AND NEW.error_code IS NULL
    THEN RAISE(ABORT, 'missing retry ai job error payload') END;
  SELECT CASE WHEN NEW.event_type = 'partial'
    AND NEW.error_code IS NOT 'JOB_BUDGET_EXHAUSTED'
    THEN RAISE(ABORT, 'invalid partial ai job diagnostic') END;
  SELECT CASE WHEN NEW.event_type = 'succeeded' AND NEW.error_code IS NOT NULL
    THEN RAISE(ABORT, 'unexpected succeeded ai job diagnostic') END;
  SELECT CASE WHEN NEW.event_type IN ('deferred', 'retry_scheduled', 'recovered') AND NOT (
    NEW.available_at IS NOT NULL AND NEW.available_at >= NEW.occurred_at
  ) THEN RAISE(ABORT, 'missing ai job retry availability') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('deferred', 'retry_scheduled', 'recovered')
    AND NEW.available_at IS NOT NULL
    THEN RAISE(ABORT, 'unexpected ai job retry availability') END;
  SELECT CASE WHEN NEW.event_type NOT IN ('cancel_requested', 'cancelled')
    AND NEW.cancellation_requested_by IS NOT NULL
    THEN RAISE(ABORT, 'unexpected ai job cancellation payload') END;
END;

CREATE TABLE research_runs (
  id INTEGER PRIMARY KEY CHECK (
    typeof(id) = 'integer' AND id > 0 AND id <= 9007199254740991
  ),
  job_id INTEGER NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  target_logical_page_id INTEGER REFERENCES logical_pages(id) ON DELETE RESTRICT,
  target_resource_id INTEGER REFERENCES resources(id) ON DELETE RESTRICT,
  target_selection INTEGER NOT NULL DEFAULT 0 CHECK (target_selection IN (0, 1)),
  selection_fingerprint TEXT CHECK (
    selection_fingerprint IS NULL OR (
      length(selection_fingerprint) = 64
      AND selection_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  target_key TEXT NOT NULL CHECK (length(CAST(target_key AS BLOB)) BETWEEN 3 AND 80),
  question_digest TEXT NOT NULL CHECK (
    length(question_digest) = 64 AND question_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_json TEXT NOT NULL CHECK (
    json_valid(scope_json) AND json_type(scope_json) = 'object'
    AND length(CAST(scope_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  approval_fingerprint TEXT NOT NULL CHECK (
    length(approval_fingerprint) = 64
    AND approval_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  corpus_fingerprint TEXT NOT NULL CHECK (
    length(corpus_fingerprint) = 64
    AND corpus_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  submission_fingerprint TEXT NOT NULL CHECK (
    length(submission_fingerprint) = 64
    AND submission_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  workflow_id TEXT NOT NULL CHECK (
    length(CAST(workflow_id AS BLOB)) BETWEEN 1 AND 128 AND workflow_id = trim(workflow_id)
  ),
  workflow_version INTEGER NOT NULL CHECK (
    typeof(workflow_version) = 'integer' AND workflow_version > 0
      AND workflow_version <= 9007199254740991
  ),
  parent_report_id INTEGER REFERENCES research_reports(id) ON DELETE RESTRICT,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 100),
  max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 0 AND 200000),
  max_cost_usd REAL NOT NULL CHECK (max_cost_usd >= 0 AND max_cost_usd <= 2.0),
  max_wall_time_ms INTEGER NOT NULL CHECK (max_wall_time_ms BETWEEN 1 AND 1800000),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  CHECK (
    (target_logical_page_id IS NOT NULL AND target_resource_id IS NULL
      AND target_selection = 0 AND selection_fingerprint IS NULL
      AND target_key = 'page:' || target_logical_page_id)
    OR (target_logical_page_id IS NULL AND target_resource_id IS NOT NULL
      AND target_selection = 0 AND selection_fingerprint IS NULL
      AND target_key = 'resource:' || target_resource_id)
    OR (target_logical_page_id IS NULL AND target_resource_id IS NULL
      AND target_selection = 1 AND selection_fingerprint IS NOT NULL
      AND target_key = 'selection:' || selection_fingerprint)
  )
);

CREATE TRIGGER research_runs_immutable_update
BEFORE UPDATE ON research_runs
BEGIN
  SELECT RAISE(ABORT, 'research runs are immutable');
END;

CREATE TRIGGER research_runs_job_ownership_insert
BEFORE INSERT ON research_runs
WHEN NOT EXISTS (
  SELECT 1 FROM ai_jobs AS job
  WHERE job.id = NEW.job_id
    AND job.kind = 'resource_research'
    AND job.subject_key = NEW.target_key
    AND job.input_fingerprint = NEW.approval_fingerprint
    AND job.workflow_id = NEW.workflow_id
    AND job.workflow_version = NEW.workflow_version
    AND job.max_steps = NEW.max_steps
    AND job.max_tokens = NEW.max_tokens
    AND job.max_cost_usd = NEW.max_cost_usd
    AND job.max_wall_time_ms = NEW.max_wall_time_ms
    AND job.status = 'queued'
)
BEGIN
  SELECT RAISE(ABORT, 'research run is not owned by its queued job');
END;

CREATE TRIGGER research_runs_immutable_delete
BEFORE DELETE ON research_runs
BEGIN
  SELECT RAISE(ABORT, 'research runs are immutable audit');
END;

CREATE TRIGGER research_runs_parent_same_target
BEFORE INSERT ON research_runs
WHEN NEW.parent_report_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_reports AS parent
  JOIN research_report_heads AS head ON head.report_id = parent.id
  WHERE parent.id = NEW.parent_report_id AND parent.target_key = NEW.target_key
    AND head.state IN ('fresh', 'stale')
)
BEGIN
  SELECT RAISE(ABORT, 'parent research report must have the same target');
END;

CREATE TABLE research_run_payloads (
  run_id INTEGER PRIMARY KEY REFERENCES research_runs(id) ON DELETE RESTRICT,
  question TEXT NOT NULL CHECK (length(CAST(question AS BLOB)) BETWEEN 1 AND 4000),
  scope_json TEXT NOT NULL CHECK (
    json_valid(scope_json) AND json_type(scope_json) = 'object'
      AND length(CAST(scope_json AS BLOB)) BETWEEN 2 AND 65536
  )
);

CREATE TRIGGER research_run_payloads_immutable_update
BEFORE UPDATE ON research_run_payloads BEGIN
  SELECT RAISE(ABORT, 'research run payload is immutable');
END;

CREATE TRIGGER research_run_payloads_no_resurrection
BEFORE INSERT ON research_run_payloads
WHEN EXISTS (
  SELECT 1 FROM research_runs AS run
  JOIN research_reports AS report ON report.run_id = run.id
  JOIN research_report_state_events AS event ON event.report_id = report.id
  WHERE run.id = NEW.run_id AND event.state = 'redacted'
)
OR EXISTS (
  SELECT 1 FROM research_privacy_run_bindings WHERE run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research run payload cannot be restored');
END;

CREATE TRIGGER research_run_payloads_redaction_guard
BEFORE DELETE ON research_run_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_runs AS run
  JOIN research_reports AS report ON report.run_id = run.id
  JOIN research_report_heads AS head ON head.report_id = report.id
  WHERE run.id = OLD.run_id AND head.state = 'redacted'
)
AND NOT EXISTS (
  SELECT 1 FROM research_privacy_run_bindings WHERE run_id = OLD.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'research run payload requires report redaction');
END;

CREATE TABLE research_run_selection_pages (
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  logical_page_id INTEGER NOT NULL REFERENCES logical_pages(id) ON DELETE RESTRICT,
  selection_order INTEGER NOT NULL CHECK (selection_order BETWEEN 1 AND 100),
  PRIMARY KEY (run_id, logical_page_id),
  UNIQUE (run_id, selection_order)
);

CREATE TRIGGER research_selection_pages_target_guard
BEFORE INSERT ON research_run_selection_pages
WHEN NOT EXISTS (
  SELECT 1 FROM research_runs WHERE id = NEW.run_id AND target_selection = 1
)
BEGIN
  SELECT RAISE(ABORT, 'selection pages require a selection research target');
END;

CREATE TRIGGER research_selection_pages_immutable_update
BEFORE UPDATE ON research_run_selection_pages
BEGIN
  SELECT RAISE(ABORT, 'research selection is immutable');
END;

CREATE TRIGGER research_selection_pages_immutable_delete
BEFORE DELETE ON research_run_selection_pages
BEGIN
  SELECT RAISE(ABORT, 'research selection is immutable');
END;

CREATE TABLE research_run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('queued', 'running', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded') AND status = event_type
  ),
  report_id INTEGER REFERENCES research_reports(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  occurred_at TEXT NOT NULL CHECK (
    COALESCE(occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at), 0)
  ),
  UNIQUE (run_id, sequence_no),
  CHECK ((status IN ('succeeded', 'partial')) = (report_id IS NOT NULL))
);

CREATE TRIGGER research_run_events_transition_guard
BEFORE INSERT ON research_run_events
WHEN NEW.sequence_no <> COALESCE((
    SELECT MAX(sequence_no) + 1 FROM research_run_events WHERE run_id = NEW.run_id
  ), 1)
  OR (NEW.sequence_no = 1 AND NEW.status <> 'queued')
  OR (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM research_run_heads AS head
    WHERE head.run_id = NEW.run_id AND (
      (head.status = 'queued' AND NEW.status IN ('running', 'cancelled', 'superseded'))
      OR (head.status = 'running' AND NEW.status IN (
        'queued', 'succeeded', 'partial', 'failed', 'cancelled', 'superseded'
      ))
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid research run event transition');
END;

CREATE TRIGGER research_run_events_immutable_update
BEFORE UPDATE ON research_run_events
BEGIN
  SELECT RAISE(ABORT, 'research run events are append-only');
END;

CREATE TRIGGER research_run_events_immutable_delete
BEFORE DELETE ON research_run_events
BEGIN
  SELECT RAISE(ABORT, 'research run events are append-only');
END;

CREATE VIEW research_run_heads AS
SELECT event.run_id, event.id AS event_id, event.status, event.report_id
FROM research_run_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM research_run_events AS newer
  WHERE newer.run_id = event.run_id AND newer.sequence_no > event.sequence_no
);

CREATE TABLE research_sources (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
  logical_page_id INTEGER NOT NULL REFERENCES logical_pages(id) ON DELETE RESTRICT,
  tab_id INTEGER,
  captured_tab_id_snapshot INTEGER CHECK (
    captured_tab_id_snapshot IS NULL OR (
      typeof(captured_tab_id_snapshot) = 'integer'
      AND captured_tab_id_snapshot > 0
      AND captured_tab_id_snapshot <= 9007199254740991
    )
  ),
  content_revision INTEGER CHECK (content_revision IS NULL OR content_revision > 0),
  content_digest TEXT CHECK (
    content_digest IS NULL OR (
      length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  extracted_at TEXT,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('inventory', 'captured', 'exact_capture')
  ),
  access_class_snapshot TEXT NOT NULL CHECK (
    access_class_snapshot IN ('public', 'authenticated', 'sensitive')
  ),
  eligibility TEXT NOT NULL CHECK (
    eligibility IN ('eligible', 'privacy_excluded', 'format_excluded',
      'size_excluded', 'not_captured')
  ),
  inclusion_state TEXT NOT NULL CHECK (
    inclusion_state IN ('included', 'excluded', 'missing', 'failed')
  ),
  exclusion_reason TEXT CHECK (
    exclusion_reason IS NULL OR exclusion_reason IN ('source_limit', 'privacy', 'format', 'size')
  ),
  included_order INTEGER CHECK (included_order IS NULL OR included_order BETWEEN 1 AND 100),
  failure_code TEXT CHECK (
    failure_code IS NULL OR length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, logical_page_id),
  UNIQUE (run_id, included_order),
  UNIQUE (id, run_id),
  FOREIGN KEY (tab_id, logical_page_id)
    REFERENCES tabs(id, logical_page_id) ON DELETE RESTRICT,
  CHECK (
    (inclusion_state = 'included' AND eligibility = 'eligible'
      AND captured_tab_id_snapshot IS NOT NULL
      AND (tab_id IS NULL OR captured_tab_id_snapshot = tab_id)
      AND content_revision IS NOT NULL
      AND content_digest IS NOT NULL AND extracted_at IS NOT NULL
      AND included_order IS NOT NULL AND failure_code IS NULL AND exclusion_reason IS NULL)
    OR (inclusion_state = 'excluded' AND eligibility IN (
        'eligible', 'privacy_excluded', 'format_excluded', 'size_excluded')
      AND captured_tab_id_snapshot IS NOT NULL
      AND (tab_id IS NULL OR captured_tab_id_snapshot = tab_id)
      AND content_revision IS NOT NULL
      AND content_digest IS NOT NULL AND extracted_at IS NOT NULL
      AND included_order IS NULL AND failure_code IS NULL
      AND exclusion_reason = CASE eligibility
        WHEN 'eligible' THEN 'source_limit'
        WHEN 'privacy_excluded' THEN 'privacy'
        WHEN 'format_excluded' THEN 'format'
        WHEN 'size_excluded' THEN 'size' END)
    OR (inclusion_state = 'missing' AND eligibility = 'not_captured'
      AND content_revision IS NULL AND content_digest IS NULL
      AND extracted_at IS NULL AND included_order IS NULL AND failure_code IS NULL
      AND exclusion_reason IS NULL)
    OR (inclusion_state = 'failed' AND eligibility = 'not_captured'
      AND content_revision IS NULL AND content_digest IS NULL
      AND extracted_at IS NULL AND included_order IS NULL AND failure_code IS NOT NULL
      AND exclusion_reason IS NULL)
  )
);

CREATE TRIGGER research_sources_live_capture_insert_guard
BEFORE INSERT ON research_sources
WHEN NEW.inclusion_state IN ('included', 'excluded') AND NEW.tab_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'captured research source requires live tab at submission');
END;

CREATE UNIQUE INDEX research_sources_exact_identity_idx
ON research_sources(
  run_id, captured_tab_id_snapshot, content_revision, content_digest
)
WHERE captured_tab_id_snapshot IS NOT NULL
  AND content_revision IS NOT NULL AND content_digest IS NOT NULL;

CREATE TRIGGER research_sources_immutable_update
BEFORE UPDATE ON research_sources
WHEN NOT (
  OLD.tab_id IS NOT NULL AND NEW.tab_id IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.ordinal IS OLD.ordinal
  AND NEW.logical_page_id IS OLD.logical_page_id
  AND NEW.captured_tab_id_snapshot IS OLD.captured_tab_id_snapshot
  AND NEW.content_revision IS OLD.content_revision
  AND NEW.content_digest IS OLD.content_digest
  AND NEW.extracted_at IS OLD.extracted_at
  AND NEW.acquisition_method IS OLD.acquisition_method
  AND NEW.access_class_snapshot IS OLD.access_class_snapshot
  AND NEW.eligibility IS OLD.eligibility
  AND NEW.inclusion_state IS OLD.inclusion_state
  AND NEW.exclusion_reason IS OLD.exclusion_reason
  AND NEW.included_order IS OLD.included_order
  AND NEW.failure_code IS OLD.failure_code
  AND NEW.created_at IS OLD.created_at
  AND EXISTS (
    SELECT 1 FROM research_source_heads
    WHERE source_id = OLD.id AND state = 'redacted'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research source manifest is immutable');
END;

CREATE TRIGGER research_sources_immutable_delete
BEFORE DELETE ON research_sources
BEGIN
  SELECT RAISE(ABORT, 'research source manifest is immutable');
END;

CREATE TABLE research_source_state_events (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'invalidated', 'redacted')),
  state TEXT NOT NULL CHECK (state IN ('valid', 'invalid', 'redacted')),
  reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (source_id, sequence_no),
  CHECK (
    (event_type = 'accepted' AND state = 'valid' AND reason IS NULL)
    OR (event_type = 'invalidated' AND state = 'invalid' AND reason IS NOT NULL)
    OR (event_type = 'redacted' AND state = 'redacted' AND reason IS NOT NULL)
  )
);

CREATE TRIGGER research_source_state_events_transition_guard
BEFORE INSERT ON research_source_state_events
WHEN NEW.sequence_no <> COALESCE((
    SELECT MAX(sequence_no) + 1
    FROM research_source_state_events WHERE source_id = NEW.source_id
  ), 1)
  OR (NEW.sequence_no = 1 AND NEW.event_type <> 'accepted')
  OR (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM research_source_heads
    WHERE source_id = NEW.source_id
      AND ((state = 'valid' AND NEW.state IN ('invalid', 'redacted'))
        OR (state = 'invalid' AND NEW.state = 'redacted'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid research source event transition');
END;

CREATE TRIGGER research_source_redaction_requires_unavailable_evidence
BEFORE INSERT ON research_source_state_events
WHEN NEW.state = 'redacted' AND EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE evidence.source_id = NEW.source_id AND head.state = 'valid'
)
BEGIN
  SELECT RAISE(ABORT, 'research source redaction requires unavailable evidence');
END;

CREATE TRIGGER research_source_state_events_immutable_update
BEFORE UPDATE ON research_source_state_events
BEGIN
  SELECT RAISE(ABORT, 'research source events are append-only');
END;

CREATE TRIGGER research_source_state_events_immutable_delete
BEFORE DELETE ON research_source_state_events
BEGIN
  SELECT RAISE(ABORT, 'research source events are append-only');
END;

CREATE VIEW research_source_heads AS
SELECT event.source_id, event.id AS event_id, event.state
FROM research_source_state_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM research_source_state_events AS newer
  WHERE newer.source_id = event.source_id AND newer.sequence_no > event.sequence_no
);

CREATE TABLE research_source_payloads (
  source_id INTEGER PRIMARY KEY REFERENCES research_sources(id) ON DELETE RESTRICT,
  url_snapshot TEXT NOT NULL CHECK (length(CAST(url_snapshot AS BLOB)) BETWEEN 1 AND 8192),
  title_snapshot TEXT NOT NULL CHECK (length(CAST(title_snapshot AS BLOB)) <= 8192),
  evidence_material TEXT NOT NULL CHECK (
    length(CAST(evidence_material AS BLOB)) BETWEEN 1 AND 65536
  ),
  chunk_manifest_json TEXT NOT NULL CHECK (
    json_valid(chunk_manifest_json) AND json_type(chunk_manifest_json) = 'object'
  ),
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER research_source_payloads_insert_guard
BEFORE INSERT ON research_source_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_sources AS source
  JOIN research_source_heads AS head ON head.source_id = source.id
  WHERE source.id = NEW.source_id AND source.inclusion_state = 'included'
    AND source.tab_id IS NOT NULL AND head.state = 'valid'
) OR (
  SELECT COALESCE(SUM(length(CAST(payload.evidence_material AS BLOB))), 0)
  FROM research_source_payloads AS payload
  JOIN research_sources AS existing ON existing.id = payload.source_id
  WHERE existing.run_id = (
    SELECT run_id FROM research_sources WHERE id = NEW.source_id
  )
) + length(CAST(NEW.evidence_material AS BLOB)) > 4194304
BEGIN
  SELECT RAISE(ABORT, 'invalid research source payload');
END;

CREATE TRIGGER research_source_payloads_immutable_update
BEFORE UPDATE ON research_source_payloads
BEGIN
  SELECT RAISE(ABORT, 'research source payload is immutable');
END;

CREATE TRIGGER research_source_payloads_redaction_guard
BEFORE DELETE ON research_source_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_source_heads
  WHERE source_id = OLD.source_id AND state = 'redacted'
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE evidence.source_id = OLD.source_id AND head.state = 'valid'
)
BEGIN
  SELECT RAISE(ABORT, 'research source payload requires redaction event');
END;

CREATE TRIGGER research_source_payloads_no_resurrection
BEFORE INSERT ON research_source_payloads
WHEN EXISTS (
  SELECT 1 FROM research_source_state_events
  WHERE source_id = NEW.source_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research source payload cannot be restored');
END;

CREATE TABLE research_page_context_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  context_entry_audit_id INTEGER NOT NULL CHECK (context_entry_audit_id > 0),
  logical_page_audit_id INTEGER NOT NULL CHECK (logical_page_audit_id > 0),
  context_entry_id INTEGER REFERENCES context_entries(id) ON DELETE SET NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (id, run_id),
  UNIQUE (run_id, context_entry_audit_id)
);

CREATE TABLE research_resource_context_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  context_entry_audit_id INTEGER NOT NULL CHECK (context_entry_audit_id > 0),
  resource_audit_id INTEGER NOT NULL CHECK (resource_audit_id > 0),
  context_entry_id INTEGER REFERENCES resource_context_entries(id) ON DELETE SET NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (id, run_id),
  UNIQUE (run_id, context_entry_audit_id)
);

CREATE TABLE research_activity_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  logical_page_audit_id INTEGER NOT NULL CHECK (logical_page_audit_id > 0),
  activity_date_audit TEXT NOT NULL,
  logical_page_id INTEGER,
  activity_date TEXT,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (id, run_id),
  UNIQUE (run_id, logical_page_audit_id, activity_date_audit),
  FOREIGN KEY (logical_page_id, activity_date)
    REFERENCES logical_page_activity_daily(logical_page_id, activity_date) ON DELETE SET NULL,
  CHECK ((logical_page_id IS NULL) = (activity_date IS NULL))
);

CREATE TABLE research_relation_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  relation_audit_id INTEGER NOT NULL CHECK (relation_audit_id > 0),
  relation_id INTEGER REFERENCES relations(id) ON DELETE SET NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (id, run_id),
  UNIQUE (run_id, relation_audit_id)
);

CREATE TRIGGER research_page_context_snapshots_live_insert_guard
BEFORE INSERT ON research_page_context_snapshots
WHEN NEW.context_entry_id IS NULL OR NEW.context_entry_id <> NEW.context_entry_audit_id
  OR NOT EXISTS (
    SELECT 1 FROM context_entries
    WHERE id = NEW.context_entry_id AND logical_page_id = NEW.logical_page_audit_id
  )
BEGIN
  SELECT RAISE(ABORT, 'page context snapshot requires matching live identity');
END;

CREATE TRIGGER research_resource_context_snapshots_live_insert_guard
BEFORE INSERT ON research_resource_context_snapshots
WHEN NEW.context_entry_id IS NULL OR NEW.context_entry_id <> NEW.context_entry_audit_id
  OR NOT EXISTS (
    SELECT 1 FROM resource_context_entries
    WHERE id = NEW.context_entry_id AND resource_id = NEW.resource_audit_id
  )
BEGIN
  SELECT RAISE(ABORT, 'resource context snapshot requires matching live identity');
END;

CREATE TRIGGER research_activity_snapshots_live_insert_guard
BEFORE INSERT ON research_activity_snapshots
WHEN NEW.logical_page_id IS NULL OR NEW.activity_date IS NULL
  OR NEW.logical_page_id <> NEW.logical_page_audit_id
  OR NEW.activity_date <> NEW.activity_date_audit
  OR NOT EXISTS (
    SELECT 1 FROM logical_page_activity_daily
    WHERE logical_page_id = NEW.logical_page_id AND activity_date = NEW.activity_date
  )
BEGIN
  SELECT RAISE(ABORT, 'activity snapshot requires matching live identity');
END;

CREATE TRIGGER research_relation_snapshots_live_insert_guard
BEFORE INSERT ON research_relation_snapshots
WHEN NEW.relation_id IS NULL OR NEW.relation_id <> NEW.relation_audit_id
  OR NOT EXISTS (SELECT 1 FROM relations WHERE id = NEW.relation_id)
BEGIN
  SELECT RAISE(ABORT, 'relation snapshot requires matching live identity');
END;

CREATE TRIGGER research_page_context_snapshots_immutable_update
BEFORE UPDATE ON research_page_context_snapshots
WHEN NOT (
  OLD.context_entry_id IS NOT NULL AND NEW.context_entry_id IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.context_entry_audit_id IS OLD.context_entry_audit_id
  AND NEW.logical_page_audit_id IS OLD.logical_page_audit_id
  AND NEW.snapshot_digest IS OLD.snapshot_digest AND NEW.created_at IS OLD.created_at
  AND EXISTS (SELECT 1 FROM research_snapshot_heads WHERE kind = 'page_context'
    AND snapshot_id = OLD.id AND state = 'redacted')
)
BEGIN
  SELECT RAISE(ABORT, 'research page context snapshot is immutable');
END;

CREATE TRIGGER research_page_context_snapshots_immutable_delete
BEFORE DELETE ON research_page_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'research page context snapshot is immutable');
END;

CREATE TRIGGER research_resource_context_snapshots_immutable_update
BEFORE UPDATE ON research_resource_context_snapshots
WHEN NOT (
  OLD.context_entry_id IS NOT NULL AND NEW.context_entry_id IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.context_entry_audit_id IS OLD.context_entry_audit_id
  AND NEW.resource_audit_id IS OLD.resource_audit_id
  AND NEW.snapshot_digest IS OLD.snapshot_digest AND NEW.created_at IS OLD.created_at
  AND EXISTS (SELECT 1 FROM research_snapshot_heads WHERE kind = 'resource_context'
    AND snapshot_id = OLD.id AND state = 'redacted')
)
BEGIN
  SELECT RAISE(ABORT, 'research resource context snapshot is immutable');
END;

CREATE TRIGGER research_resource_context_snapshots_immutable_delete
BEFORE DELETE ON research_resource_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'research resource context snapshot is immutable');
END;

CREATE TRIGGER research_activity_snapshots_immutable_update
BEFORE UPDATE ON research_activity_snapshots
WHEN NOT (
  OLD.logical_page_id IS NOT NULL AND NEW.logical_page_id IS NULL
  AND OLD.activity_date IS NOT NULL AND NEW.activity_date IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.logical_page_audit_id IS OLD.logical_page_audit_id
  AND NEW.activity_date_audit IS OLD.activity_date_audit
  AND NEW.snapshot_digest IS OLD.snapshot_digest AND NEW.created_at IS OLD.created_at
  AND EXISTS (SELECT 1 FROM research_snapshot_heads WHERE kind = 'activity'
    AND snapshot_id = OLD.id AND state = 'redacted')
)
BEGIN
  SELECT RAISE(ABORT, 'research activity snapshot is immutable');
END;

CREATE TRIGGER research_activity_snapshots_immutable_delete
BEFORE DELETE ON research_activity_snapshots
BEGIN
  SELECT RAISE(ABORT, 'research activity snapshot is immutable');
END;

CREATE TRIGGER research_relation_snapshots_immutable_update
BEFORE UPDATE ON research_relation_snapshots
WHEN NOT (
  OLD.relation_id IS NOT NULL AND NEW.relation_id IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.relation_audit_id IS OLD.relation_audit_id
  AND NEW.snapshot_digest IS OLD.snapshot_digest AND NEW.created_at IS OLD.created_at
  AND EXISTS (SELECT 1 FROM research_snapshot_heads WHERE kind = 'relation'
    AND snapshot_id = OLD.id AND state = 'redacted')
)
BEGIN
  SELECT RAISE(ABORT, 'research relation snapshot is immutable');
END;

CREATE TRIGGER research_relation_snapshots_immutable_delete
BEFORE DELETE ON research_relation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'research relation snapshot is immutable');
END;

CREATE TABLE research_snapshot_payloads (
  kind TEXT NOT NULL CHECK (
    kind IN ('page_context', 'resource_context', 'activity', 'relation')
  ),
  snapshot_id INTEGER NOT NULL,
  material_json TEXT NOT NULL CHECK (
    json_valid(material_json) AND json_type(material_json) = 'object'
    AND length(CAST(material_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  PRIMARY KEY (kind, snapshot_id)
);

CREATE TRIGGER research_snapshot_payloads_typed_insert
BEFORE INSERT ON research_snapshot_payloads
WHEN (NEW.kind = 'page_context' AND NOT EXISTS (
    SELECT 1 FROM research_page_context_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'resource_context' AND NOT EXISTS (
    SELECT 1 FROM research_resource_context_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'activity' AND NOT EXISTS (
    SELECT 1 FROM research_activity_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'relation' AND NOT EXISTS (
    SELECT 1 FROM research_relation_snapshots WHERE id = NEW.snapshot_id))
BEGIN
  SELECT RAISE(ABORT, 'research snapshot payload has no typed snapshot');
END;

CREATE TRIGGER research_snapshot_payloads_immutable_update
BEFORE UPDATE ON research_snapshot_payloads
BEGIN
  SELECT RAISE(ABORT, 'research snapshot payload is immutable');
END;

CREATE TABLE research_snapshot_state_events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('page_context', 'resource_context', 'activity', 'relation')
  ),
  snapshot_id INTEGER NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'invalidated', 'redacted')),
  state TEXT NOT NULL CHECK (state IN ('valid', 'invalid', 'redacted')),
  reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (kind, snapshot_id, sequence_no),
  CHECK (
    (event_type = 'accepted' AND state = 'valid' AND reason IS NULL)
    OR (event_type = 'invalidated' AND state = 'invalid' AND reason IS NOT NULL)
    OR (event_type = 'redacted' AND state = 'redacted' AND reason IS NOT NULL)
  )
);

CREATE TRIGGER research_snapshot_state_events_typed_insert
BEFORE INSERT ON research_snapshot_state_events
WHEN (NEW.kind = 'page_context' AND NOT EXISTS (
    SELECT 1 FROM research_page_context_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'resource_context' AND NOT EXISTS (
    SELECT 1 FROM research_resource_context_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'activity' AND NOT EXISTS (
    SELECT 1 FROM research_activity_snapshots WHERE id = NEW.snapshot_id))
  OR (NEW.kind = 'relation' AND NOT EXISTS (
    SELECT 1 FROM research_relation_snapshots WHERE id = NEW.snapshot_id))
BEGIN
  SELECT RAISE(ABORT, 'research snapshot event has no typed snapshot');
END;

CREATE VIEW research_snapshot_heads AS
SELECT event.kind, event.snapshot_id, event.id AS event_id, event.state
FROM research_snapshot_state_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM research_snapshot_state_events AS newer
  WHERE newer.kind = event.kind AND newer.snapshot_id = event.snapshot_id
    AND newer.sequence_no > event.sequence_no
);

CREATE TRIGGER research_snapshot_state_events_transition_guard
BEFORE INSERT ON research_snapshot_state_events
WHEN NEW.sequence_no <> COALESCE((
    SELECT MAX(sequence_no) + 1 FROM research_snapshot_state_events
    WHERE kind = NEW.kind AND snapshot_id = NEW.snapshot_id
  ), 1)
  OR (NEW.sequence_no = 1 AND NEW.event_type <> 'accepted')
  OR (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM research_snapshot_heads
    WHERE kind = NEW.kind AND snapshot_id = NEW.snapshot_id
      AND ((state = 'valid' AND NEW.state IN ('invalid', 'redacted'))
        OR (state = 'invalid' AND NEW.state = 'redacted'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid research snapshot event transition');
END;

CREATE TRIGGER research_snapshot_redaction_requires_unavailable_evidence
BEFORE INSERT ON research_snapshot_state_events
WHEN NEW.state = 'redacted' AND (
  EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE head.state <> 'redacted' AND (
    (NEW.kind = 'page_context' AND evidence.page_context_snapshot_id = NEW.snapshot_id)
    OR (NEW.kind = 'resource_context'
      AND evidence.resource_context_snapshot_id = NEW.snapshot_id)
    OR (NEW.kind = 'activity' AND evidence.activity_snapshot_id = NEW.snapshot_id)
    OR (NEW.kind = 'relation' AND evidence.relation_snapshot_id = NEW.snapshot_id)
  )
  )
  OR EXISTS (
    SELECT 1 FROM research_claim_evidence AS evidence
    JOIN research_report_heads AS report_head ON report_head.report_id = evidence.report_id
    WHERE report_head.state <> 'redacted' AND (
      (NEW.kind = 'page_context'
        AND evidence.page_context_snapshot_id = NEW.snapshot_id)
      OR (NEW.kind = 'resource_context'
        AND evidence.resource_context_snapshot_id = NEW.snapshot_id)
      OR (NEW.kind = 'activity' AND evidence.activity_snapshot_id = NEW.snapshot_id)
      OR (NEW.kind = 'relation' AND evidence.relation_snapshot_id = NEW.snapshot_id)
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research snapshot redaction requires unavailable evidence');
END;

CREATE TRIGGER research_snapshot_payloads_insert_state_guard
BEFORE INSERT ON research_snapshot_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_snapshot_heads
  WHERE kind = NEW.kind AND snapshot_id = NEW.snapshot_id AND state = 'valid'
)
BEGIN
  SELECT RAISE(ABORT, 'research snapshot payload requires valid state');
END;

CREATE TRIGGER research_snapshot_payloads_redaction_guard
BEFORE DELETE ON research_snapshot_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_snapshot_heads
  WHERE kind = OLD.kind AND snapshot_id = OLD.snapshot_id AND state = 'redacted'
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE head.state = 'valid' AND (
    (OLD.kind = 'page_context'
      AND evidence.page_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'resource_context'
      AND evidence.resource_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'activity' AND evidence.activity_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'relation' AND evidence.relation_snapshot_id = OLD.snapshot_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research snapshot payload requires redaction event');
END;

CREATE TRIGGER research_snapshot_payloads_no_resurrection
BEFORE INSERT ON research_snapshot_payloads
WHEN EXISTS (
  SELECT 1 FROM research_snapshot_state_events
  WHERE kind = NEW.kind AND snapshot_id = NEW.snapshot_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research snapshot payload cannot be restored');
END;

CREATE TRIGGER research_snapshot_state_events_immutable_update
BEFORE UPDATE ON research_snapshot_state_events
BEGIN
  SELECT RAISE(ABORT, 'research snapshot events are append-only');
END;

CREATE TRIGGER research_snapshot_state_events_immutable_delete
BEFORE DELETE ON research_snapshot_state_events
BEGIN
  SELECT RAISE(ABORT, 'research snapshot events are append-only');
END;

CREATE TABLE research_reports (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE REFERENCES research_runs(id) ON DELETE RESTRICT,
  target_logical_page_id INTEGER REFERENCES logical_pages(id) ON DELETE RESTRICT,
  target_resource_id INTEGER REFERENCES resources(id) ON DELETE RESTRICT,
  selection_fingerprint TEXT,
  target_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_report_id INTEGER REFERENCES research_reports(id) ON DELETE RESTRICT,
  publish_status TEXT NOT NULL CHECK (publish_status IN ('succeeded', 'partial')),
  coverage_json TEXT NOT NULL CHECK (
    json_valid(coverage_json) AND json_type(coverage_json) = 'object'
  ),
  coverage_fingerprint TEXT NOT NULL CHECK (length(coverage_fingerprint) = 64),
  provenance_json TEXT NOT NULL CHECK (
    json_valid(provenance_json) AND json_type(provenance_json) = 'object'
  ),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (target_key, version),
  UNIQUE (id, run_id),
  CHECK (
    (target_logical_page_id IS NOT NULL AND target_resource_id IS NULL
      AND selection_fingerprint IS NULL AND target_key = 'page:' || target_logical_page_id)
    OR (target_logical_page_id IS NULL AND target_resource_id IS NOT NULL
      AND selection_fingerprint IS NULL AND target_key = 'resource:' || target_resource_id)
    OR (target_logical_page_id IS NULL AND target_resource_id IS NULL
      AND selection_fingerprint IS NOT NULL
      AND target_key = 'selection:' || selection_fingerprint)
  )
);

CREATE TRIGGER research_reports_immutable_update
BEFORE UPDATE ON research_reports
BEGIN
  SELECT RAISE(ABORT, 'research reports are immutable');
END;

CREATE TRIGGER research_reports_run_consistency_insert
BEFORE INSERT ON research_reports
WHEN NOT EXISTS (
  SELECT 1 FROM research_runs AS run
  WHERE run.id = NEW.run_id AND run.target_key = NEW.target_key
    AND run.target_logical_page_id IS NEW.target_logical_page_id
    AND run.target_resource_id IS NEW.target_resource_id
    AND run.selection_fingerprint IS NEW.selection_fingerprint
    AND run.parent_report_id IS NEW.parent_report_id
    AND run.approval_fingerprint = NEW.input_fingerprint
)
BEGIN
  SELECT RAISE(ABORT, 'research report does not match its run');
END;

CREATE TRIGGER research_reports_immutable_delete
BEFORE DELETE ON research_reports
BEGIN
  SELECT RAISE(ABORT, 'research reports are immutable audit');
END;

CREATE TRIGGER research_run_terminal_publication_guard
BEFORE INSERT ON research_run_events
WHEN NEW.status IN ('succeeded', 'partial') AND NOT EXISTS (
  SELECT 1
  FROM research_runs AS run
  JOIN ai_jobs AS job ON job.id = run.job_id
  JOIN research_reports AS report
    ON report.id = NEW.report_id AND report.run_id = run.id
  WHERE run.id = NEW.run_id
    AND job.kind = 'resource_research'
    AND job.status = 'running'
    AND report.publish_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'research terminal publication is not ledger-owned');
END;

CREATE TABLE research_report_payloads (
  report_id INTEGER PRIMARY KEY REFERENCES research_reports(id) ON DELETE RESTRICT,
  report_text TEXT NOT NULL CHECK (length(CAST(report_text AS BLOB)) BETWEEN 1 AND 1000000),
  structured_json TEXT NOT NULL CHECK (
    json_valid(structured_json) AND json_type(structured_json) = 'object'
  ),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64)
);

CREATE VIRTUAL TABLE research_reports_fts USING fts5(
  report_text,
  content='research_report_payloads',
  content_rowid='report_id'
);

CREATE TRIGGER research_report_payloads_fts_after_insert
AFTER INSERT ON research_report_payloads
BEGIN
  INSERT INTO research_reports_fts(rowid, report_text)
  VALUES (NEW.report_id, NEW.report_text);
END;

CREATE TRIGGER research_report_payloads_fts_after_delete
AFTER DELETE ON research_report_payloads
BEGIN
  INSERT INTO research_reports_fts(research_reports_fts, rowid, report_text)
  VALUES ('delete', OLD.report_id, OLD.report_text);
END;

CREATE TABLE research_report_sources (
  report_id INTEGER NOT NULL REFERENCES research_reports(id) ON DELETE RESTRICT,
  source_id INTEGER NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  used_order INTEGER NOT NULL CHECK (used_order BETWEEN 1 AND 100),
  PRIMARY KEY (report_id, source_id),
  UNIQUE (report_id, used_order)
);

CREATE TRIGGER research_report_sources_no_late_insert
BEFORE INSERT ON research_report_sources
WHEN EXISTS (
  SELECT 1 FROM research_report_state_events WHERE report_id = NEW.report_id
)
BEGIN
  SELECT RAISE(ABORT, 'published research report is immutable');
END;

CREATE TRIGGER research_report_sources_same_run
BEFORE INSERT ON research_report_sources
WHEN NOT EXISTS (
  SELECT 1 FROM research_reports AS report
  JOIN research_sources AS source ON source.run_id = report.run_id
  JOIN research_source_heads AS head ON head.source_id = source.id
  JOIN research_source_payloads AS payload ON payload.source_id = source.id
  WHERE report.id = NEW.report_id AND source.id = NEW.source_id
    AND source.inclusion_state = 'included' AND head.state = 'valid'
)
BEGIN
  SELECT RAISE(ABORT, 'research report source is outside its corpus');
END;

CREATE TRIGGER research_report_sources_immutable_update
BEFORE UPDATE ON research_report_sources
BEGIN
  SELECT RAISE(ABORT, 'research report sources are immutable');
END;

CREATE TRIGGER research_report_sources_immutable_delete
BEFORE DELETE ON research_report_sources
BEGIN
  SELECT RAISE(ABORT, 'research report sources are immutable');
END;

CREATE TABLE research_claims (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES research_reports(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
  claim_digest TEXT NOT NULL CHECK (
    length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'
  ),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_inference INTEGER NOT NULL CHECK (is_inference IN (0, 1)),
  rationale_digest TEXT CHECK (
    rationale_digest IS NULL OR (
      length(rationale_digest) = 64 AND rationale_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE (report_id, ordinal),
  UNIQUE (id, report_id),
  CHECK ((is_inference = 1) = (rationale_digest IS NOT NULL))
);

CREATE TRIGGER research_claims_no_late_insert
BEFORE INSERT ON research_claims
WHEN EXISTS (
  SELECT 1 FROM research_report_state_events WHERE report_id = NEW.report_id
)
BEGIN
  SELECT RAISE(ABORT, 'published research report is immutable');
END;

CREATE TABLE research_claim_payloads (
  claim_id INTEGER PRIMARY KEY REFERENCES research_claims(id) ON DELETE RESTRICT,
  claim_text TEXT NOT NULL CHECK (length(CAST(claim_text AS BLOB)) BETWEEN 1 AND 16384),
  inference_rationale TEXT CHECK (
    inference_rationale IS NULL OR length(CAST(inference_rationale AS BLOB)) BETWEEN 1 AND 4096
  )
);

CREATE TRIGGER research_claim_payloads_immutable_update
BEFORE UPDATE ON research_claim_payloads BEGIN
  SELECT RAISE(ABORT, 'research claim payload is immutable');
END;

CREATE TRIGGER research_claim_payloads_no_resurrection
BEFORE INSERT ON research_claim_payloads
WHEN EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_report_state_events AS event ON event.report_id = claim.report_id
  WHERE claim.id = NEW.claim_id AND event.state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research claim payload cannot be restored');
END;

CREATE TRIGGER research_claim_payloads_redaction_guard
BEFORE DELETE ON research_claim_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_report_heads AS head ON head.report_id = claim.report_id
  WHERE claim.id = OLD.claim_id AND head.state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'research claim payload requires report redaction');
END;

CREATE TABLE research_claim_evidence (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (
    kind IN ('tab_content', 'page_context', 'resource_context', 'activity', 'relation')
  ),
  source_id INTEGER,
  page_context_snapshot_id INTEGER,
  resource_context_snapshot_id INTEGER,
  activity_snapshot_id INTEGER,
  relation_snapshot_id INTEGER,
  locator_digest TEXT NOT NULL CHECK (
    length(locator_digest) = 64 AND locator_digest NOT GLOB '*[^0-9a-f]*'
  ),
  excerpt_hash TEXT NOT NULL CHECK (
    length(excerpt_hash) = 64 AND excerpt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (claim_id, ordinal),
  FOREIGN KEY (claim_id, report_id)
    REFERENCES research_claims(id, report_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, run_id)
    REFERENCES research_sources(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (page_context_snapshot_id, run_id)
    REFERENCES research_page_context_snapshots(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (resource_context_snapshot_id, run_id)
    REFERENCES research_resource_context_snapshots(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (activity_snapshot_id, run_id)
    REFERENCES research_activity_snapshots(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (relation_snapshot_id, run_id)
    REFERENCES research_relation_snapshots(id, run_id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'tab_content' AND source_id IS NOT NULL
      AND page_context_snapshot_id IS NULL AND resource_context_snapshot_id IS NULL
      AND activity_snapshot_id IS NULL AND relation_snapshot_id IS NULL)
    OR (kind = 'page_context' AND source_id IS NULL
      AND page_context_snapshot_id IS NOT NULL AND resource_context_snapshot_id IS NULL
      AND activity_snapshot_id IS NULL AND relation_snapshot_id IS NULL)
    OR (kind = 'resource_context' AND source_id IS NULL
      AND page_context_snapshot_id IS NULL AND resource_context_snapshot_id IS NOT NULL
      AND activity_snapshot_id IS NULL AND relation_snapshot_id IS NULL)
    OR (kind = 'activity' AND source_id IS NULL
      AND page_context_snapshot_id IS NULL AND resource_context_snapshot_id IS NULL
      AND activity_snapshot_id IS NOT NULL AND relation_snapshot_id IS NULL)
    OR (kind = 'relation' AND source_id IS NULL
      AND page_context_snapshot_id IS NULL AND resource_context_snapshot_id IS NULL
      AND activity_snapshot_id IS NULL AND relation_snapshot_id IS NOT NULL)
  )
);

CREATE TRIGGER research_claim_evidence_no_late_insert
BEFORE INSERT ON research_claim_evidence
WHEN EXISTS (
  SELECT 1 FROM research_report_state_events WHERE report_id = NEW.report_id
)
BEGIN
  SELECT RAISE(ABORT, 'published research report is immutable');
END;

CREATE TABLE research_evidence_payloads (
  evidence_id INTEGER PRIMARY KEY REFERENCES research_claim_evidence(id) ON DELETE RESTRICT,
  locator_json TEXT NOT NULL CHECK (
    json_valid(locator_json) AND json_type(locator_json) = 'object'
      AND length(CAST(locator_json AS BLOB)) BETWEEN 2 AND 65536
  )
);

CREATE TRIGGER research_evidence_payloads_immutable_update
BEFORE UPDATE ON research_evidence_payloads BEGIN
  SELECT RAISE(ABORT, 'research evidence payload is immutable');
END;

CREATE TRIGGER research_evidence_payloads_no_resurrection
BEFORE INSERT ON research_evidence_payloads
WHEN EXISTS (
  SELECT 1 FROM research_evidence_state_events
  WHERE evidence_id = NEW.evidence_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research evidence payload cannot be restored');
END;

CREATE TRIGGER research_evidence_payloads_redaction_guard
BEFORE DELETE ON research_evidence_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_evidence_heads
  WHERE evidence_id = OLD.evidence_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence payload requires redaction event');
END;

CREATE TRIGGER research_claim_evidence_same_run
BEFORE INSERT ON research_claim_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_reports AS report ON report.id = claim.report_id
  WHERE claim.id = NEW.claim_id AND NEW.report_id = report.id
    AND NEW.run_id = report.run_id AND (
    (NEW.kind = 'tab_content' AND EXISTS (
      SELECT 1 FROM research_sources s WHERE s.id = NEW.source_id AND s.run_id = report.run_id))
    OR (NEW.kind = 'page_context' AND EXISTS (
      SELECT 1 FROM research_page_context_snapshots s
      WHERE s.id = NEW.page_context_snapshot_id AND s.run_id = report.run_id))
    OR (NEW.kind = 'resource_context' AND EXISTS (
      SELECT 1 FROM research_resource_context_snapshots s
      WHERE s.id = NEW.resource_context_snapshot_id AND s.run_id = report.run_id))
    OR (NEW.kind = 'activity' AND EXISTS (
      SELECT 1 FROM research_activity_snapshots s
      WHERE s.id = NEW.activity_snapshot_id AND s.run_id = report.run_id))
    OR (NEW.kind = 'relation' AND EXISTS (
      SELECT 1 FROM research_relation_snapshots s
      WHERE s.id = NEW.relation_snapshot_id AND s.run_id = report.run_id))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence is outside its report corpus');
END;

CREATE TABLE research_evidence_state_events (
  id INTEGER PRIMARY KEY,
  evidence_id INTEGER NOT NULL REFERENCES research_claim_evidence(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'invalidated', 'redacted')),
  state TEXT NOT NULL CHECK (state IN ('valid', 'invalid', 'redacted')),
  reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (evidence_id, sequence_no),
  CHECK (
    (event_type = 'accepted' AND state = 'valid' AND reason IS NULL)
    OR (event_type = 'invalidated' AND state = 'invalid' AND reason IS NOT NULL)
    OR (event_type = 'redacted' AND state = 'redacted' AND reason IS NOT NULL)
  )
);

CREATE TRIGGER research_evidence_state_events_transition_guard
BEFORE INSERT ON research_evidence_state_events
WHEN NEW.sequence_no <> COALESCE((
    SELECT MAX(sequence_no) + 1
    FROM research_evidence_state_events WHERE evidence_id = NEW.evidence_id
  ), 1)
  OR (NEW.sequence_no = 1 AND NEW.event_type <> 'accepted')
  OR (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM research_evidence_heads
    WHERE evidence_id = NEW.evidence_id
      AND ((state = 'valid' AND NEW.state IN ('invalid', 'redacted'))
        OR (state = 'invalid' AND NEW.state = 'redacted'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid research evidence event transition');
END;

CREATE VIEW research_evidence_heads AS
SELECT event.evidence_id, event.id AS event_id, event.state
FROM research_evidence_state_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM research_evidence_state_events AS newer
  WHERE newer.evidence_id = event.evidence_id AND newer.sequence_no > event.sequence_no
);

CREATE TABLE research_report_state_events (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES research_reports(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('published', 'stale', 'redacted', 'superseded')
  ),
  state TEXT NOT NULL CHECK (state IN ('fresh', 'stale', 'redacted', 'superseded')),
  reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (report_id, sequence_no),
  CHECK (
    (event_type = 'published' AND state IN ('fresh', 'stale'))
    OR (event_type = 'stale' AND state = 'stale' AND reason IS NOT NULL)
    OR (event_type = 'redacted' AND state = 'redacted' AND reason IS NOT NULL)
    OR (event_type = 'superseded' AND state = 'superseded')
  )
);

CREATE TRIGGER research_evidence_acceptance_requires_material
BEFORE INSERT ON research_evidence_state_events
WHEN NEW.event_type = 'accepted' AND NOT EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_payloads AS evidence_payload
    ON evidence_payload.evidence_id = evidence.id
  WHERE evidence.id = NEW.evidence_id AND (
    (evidence.kind = 'tab_content' AND EXISTS (
      SELECT 1 FROM research_source_payloads AS payload
      JOIN research_source_heads AS head ON head.source_id = payload.source_id
      WHERE payload.source_id = evidence.source_id AND head.state = 'valid'
    ))
    OR (evidence.kind = 'page_context' AND EXISTS (
      SELECT 1 FROM research_snapshot_payloads AS payload
      JOIN research_snapshot_heads AS head
        ON head.kind = payload.kind AND head.snapshot_id = payload.snapshot_id
      WHERE payload.kind = 'page_context'
        AND payload.snapshot_id = evidence.page_context_snapshot_id AND head.state = 'valid'
    ))
    OR (evidence.kind = 'resource_context' AND EXISTS (
      SELECT 1 FROM research_snapshot_payloads AS payload
      JOIN research_snapshot_heads AS head
        ON head.kind = payload.kind AND head.snapshot_id = payload.snapshot_id
      WHERE payload.kind = 'resource_context'
        AND payload.snapshot_id = evidence.resource_context_snapshot_id AND head.state = 'valid'
    ))
    OR (evidence.kind = 'activity' AND EXISTS (
      SELECT 1 FROM research_snapshot_payloads AS payload
      JOIN research_snapshot_heads AS head
        ON head.kind = payload.kind AND head.snapshot_id = payload.snapshot_id
      WHERE payload.kind = 'activity' AND payload.snapshot_id = evidence.activity_snapshot_id
        AND head.state = 'valid'
    ))
    OR (evidence.kind = 'relation' AND EXISTS (
      SELECT 1 FROM research_snapshot_payloads AS payload
      JOIN research_snapshot_heads AS head
        ON head.kind = payload.kind AND head.snapshot_id = payload.snapshot_id
      WHERE payload.kind = 'relation' AND payload.snapshot_id = evidence.relation_snapshot_id
        AND head.state = 'valid'
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence requires retained material');
END;

CREATE TRIGGER research_report_state_events_transition_guard
BEFORE INSERT ON research_report_state_events
WHEN NEW.sequence_no <> COALESCE((
    SELECT MAX(sequence_no) + 1
    FROM research_report_state_events WHERE report_id = NEW.report_id
  ), 1)
  OR (NEW.sequence_no = 1 AND NEW.event_type <> 'published')
  OR (NEW.sequence_no > 1 AND NOT EXISTS (
    SELECT 1 FROM research_report_heads
    WHERE report_id = NEW.report_id AND (
      (state IN ('fresh', 'stale') AND NEW.state IN ('stale', 'redacted', 'superseded'))
      OR (state = 'superseded' AND NEW.state = 'redacted')
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid research report event transition');
END;

CREATE TRIGGER research_report_redaction_requires_unavailable_evidence
BEFORE INSERT ON research_report_state_events
WHEN NEW.state = 'redacted' AND NOT EXISTS (
  SELECT 1 FROM research_report_sources AS used
  JOIN research_source_heads AS source_head ON source_head.source_id = used.source_id
  WHERE used.report_id = NEW.report_id AND source_head.state IN ('invalid', 'redacted')
  UNION ALL
  SELECT 1 FROM research_claims AS claim
  JOIN research_claim_evidence AS evidence ON evidence.claim_id = claim.id
  JOIN research_evidence_heads AS evidence_head
    ON evidence_head.evidence_id = evidence.id
  WHERE claim.report_id = NEW.report_id
    AND evidence_head.state IN ('invalid', 'redacted')
  UNION ALL
  SELECT 1 FROM research_privacy_event_bindings AS binding
  WHERE binding.event_key = NEW.idempotency_key
    AND binding.child_type = 'report'
    AND binding.child_key = CAST(NEW.report_id AS TEXT)
)
BEGIN
  SELECT RAISE(ABORT, 'research report redaction requires unavailable evidence');
END;

CREATE VIEW research_report_heads AS
SELECT event.report_id, event.id AS event_id, event.state
FROM research_report_state_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM research_report_state_events AS newer
  WHERE newer.report_id = event.report_id AND newer.sequence_no > event.sequence_no
);

CREATE TRIGGER research_report_publication_claim_evidence_guard
BEFORE INSERT ON research_report_state_events
WHEN NEW.event_type = 'published' AND (
  EXISTS (
  SELECT 1 FROM research_claims AS claim
  WHERE claim.report_id = NEW.report_id AND claim.is_inference = 0
    AND NOT EXISTS (
      SELECT 1 FROM research_claim_evidence AS evidence
      JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
      WHERE evidence.claim_id = claim.id AND head.state = 'valid'
    )
) OR EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_claim_evidence AS evidence ON evidence.claim_id = claim.id
  WHERE claim.report_id = NEW.report_id AND NOT EXISTS (
    SELECT 1 FROM research_evidence_heads AS evidence_head
    WHERE evidence_head.evidence_id = evidence.id AND evidence_head.state = 'valid'
  )
))
BEGIN
  SELECT RAISE(ABORT, 'non-inference research claim requires valid evidence');
END;

CREATE TABLE research_target_heads (
  target_key TEXT PRIMARY KEY,
  latest_published_report_id INTEGER NOT NULL REFERENCES research_reports(id) ON DELETE RESTRICT,
  current_fresh_report_id INTEGER REFERENCES research_reports(id) ON DELETE RESTRICT,
  last_successful_report_id INTEGER REFERENCES research_reports(id) ON DELETE RESTRICT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES research_report_state_events(id) ON DELETE RESTRICT
);

CREATE TRIGGER research_target_heads_validate_insert
BEFORE INSERT ON research_target_heads
WHEN NOT EXISTS (
  SELECT 1 FROM research_report_state_events AS event
  JOIN research_reports AS report ON report.id = event.report_id
  WHERE event.id = NEW.event_id AND report.target_key = NEW.target_key
    AND NEW.latest_published_report_id = report.id
    AND NEW.current_fresh_report_id IS CASE
      WHEN event.state = 'fresh' AND report.publish_status = 'succeeded'
        THEN report.id ELSE NULL END
    AND NEW.last_successful_report_id IS CASE
      WHEN event.state = 'fresh' AND report.publish_status = 'succeeded'
        THEN report.id ELSE NULL END
)
BEGIN
  SELECT RAISE(ABORT, 'research target head is trigger-owned');
END;

CREATE TRIGGER research_target_heads_validate_update
BEFORE UPDATE ON research_target_heads
WHEN NEW.target_key IS NOT OLD.target_key
  OR NEW.event_id <= OLD.event_id
  OR NOT EXISTS (
    SELECT 1 FROM research_report_state_events AS event
    JOIN research_reports AS report ON report.id = event.report_id
    WHERE event.id = NEW.event_id AND report.target_key = OLD.target_key
      AND NEW.latest_published_report_id IS CASE
        WHEN event.event_type = 'published' THEN report.id
        ELSE OLD.latest_published_report_id END
      AND NEW.current_fresh_report_id IS CASE
        WHEN event.state = 'fresh' AND report.publish_status = 'succeeded'
          THEN report.id
        WHEN OLD.current_fresh_report_id = report.id AND event.state <> 'fresh'
          THEN NULL
        ELSE OLD.current_fresh_report_id END
      AND NEW.last_successful_report_id IS CASE
        WHEN event.state = 'fresh' AND report.publish_status = 'succeeded'
          THEN report.id
        ELSE OLD.last_successful_report_id END
  )
BEGIN
  SELECT RAISE(ABORT, 'research target head is trigger-owned');
END;

CREATE TRIGGER research_target_heads_no_delete
BEFORE DELETE ON research_target_heads
BEGIN
  SELECT RAISE(ABORT, 'research target head is trigger-owned');
END;

CREATE TABLE research_privacy_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  target_type TEXT NOT NULL CHECK (
    target_type IN ('source', 'snapshot', 'report', 'logical_page', 'target')
  ),
  target_key TEXT NOT NULL CHECK (length(CAST(target_key AS BLOB)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL
);

CREATE TRIGGER research_privacy_requests_immutable_update
BEFORE UPDATE ON research_privacy_requests BEGIN
  SELECT RAISE(ABORT, 'research privacy requests are immutable');
END;
CREATE TRIGGER research_privacy_requests_immutable_delete
BEFORE DELETE ON research_privacy_requests BEGIN
  SELECT RAISE(ABORT, 'research privacy requests are immutable');
END;

CREATE TABLE research_privacy_run_bindings (
  idempotency_key TEXT NOT NULL REFERENCES research_privacy_requests(idempotency_key)
    ON DELETE RESTRICT,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  PRIMARY KEY (idempotency_key, run_id)
);

CREATE TRIGGER research_privacy_run_bindings_immutable_update
BEFORE UPDATE ON research_privacy_run_bindings BEGIN
  SELECT RAISE(ABORT, 'research privacy run bindings are immutable');
END;
CREATE TRIGGER research_privacy_run_bindings_immutable_delete
BEFORE DELETE ON research_privacy_run_bindings BEGIN
  SELECT RAISE(ABORT, 'research privacy run bindings are immutable');
END;

CREATE TABLE research_privacy_event_bindings (
  event_key TEXT PRIMARY KEY CHECK (
    length(CAST(event_key AS BLOB)) BETWEEN 1 AND 200
  ),
  idempotency_key TEXT NOT NULL REFERENCES research_privacy_requests(idempotency_key)
    ON DELETE RESTRICT,
  child_type TEXT NOT NULL CHECK (
    child_type IN ('source', 'snapshot', 'evidence', 'report')
  ),
  child_key TEXT NOT NULL CHECK (length(CAST(child_key AS BLOB)) BETWEEN 1 AND 200),
  UNIQUE (idempotency_key, child_type, child_key)
);

CREATE TRIGGER research_privacy_event_bindings_immutable_update
BEFORE UPDATE ON research_privacy_event_bindings BEGIN
  SELECT RAISE(ABORT, 'research privacy event bindings are immutable');
END;
CREATE TRIGGER research_privacy_event_bindings_immutable_delete
BEFORE DELETE ON research_privacy_event_bindings BEGIN
  SELECT RAISE(ABORT, 'research privacy event bindings are immutable');
END;

CREATE TABLE research_redaction_receipts (
  idempotency_key TEXT PRIMARY KEY REFERENCES research_privacy_requests(idempotency_key)
    ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  target_type TEXT NOT NULL CHECK (
    target_type IN ('source', 'snapshot', 'report', 'logical_page', 'target')
  ),
  target_key TEXT NOT NULL CHECK (length(CAST(target_key AS BLOB)) BETWEEN 1 AND 200),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND json_type(result_json) = 'object'
  ),
  created_at TEXT NOT NULL
);

CREATE TRIGGER research_redaction_receipts_immutable_update
BEFORE UPDATE ON research_redaction_receipts
BEGIN
  SELECT RAISE(ABORT, 'research redaction receipts are immutable');
END;

CREATE TRIGGER research_redaction_receipts_immutable_delete
BEFORE DELETE ON research_redaction_receipts
BEGIN
  SELECT RAISE(ABORT, 'research redaction receipts are immutable');
END;

CREATE TRIGGER research_report_state_events_project_target
AFTER INSERT ON research_report_state_events
BEGIN
  INSERT INTO research_target_heads (
    target_key, latest_published_report_id, current_fresh_report_id,
    last_successful_report_id, event_id
  )
  SELECT
    report.target_key,
    report.id,
    CASE WHEN NEW.state = 'fresh' AND report.publish_status = 'succeeded'
      THEN report.id ELSE NULL END,
    CASE WHEN NEW.state = 'fresh' AND report.publish_status = 'succeeded'
      THEN report.id ELSE NULL END,
    NEW.id
  FROM research_reports AS report
  WHERE report.id = NEW.report_id
  ON CONFLICT(target_key) DO UPDATE SET
    latest_published_report_id = CASE
      WHEN NEW.event_type = 'published' THEN NEW.report_id
      ELSE research_target_heads.latest_published_report_id END,
    current_fresh_report_id = CASE
      WHEN NEW.state = 'fresh' AND (
        SELECT publish_status FROM research_reports WHERE id = NEW.report_id
      ) = 'succeeded' THEN NEW.report_id
      WHEN research_target_heads.current_fresh_report_id = NEW.report_id
        AND NEW.state <> 'fresh' THEN NULL
      ELSE research_target_heads.current_fresh_report_id END,
    last_successful_report_id = CASE
      WHEN NEW.state = 'fresh' AND (
        SELECT publish_status FROM research_reports WHERE id = NEW.report_id
      ) = 'succeeded' THEN NEW.report_id
      ELSE research_target_heads.last_successful_report_id END,
    event_id = NEW.id;
END;

CREATE TRIGGER research_report_payloads_immutable_update
BEFORE UPDATE ON research_report_payloads
BEGIN
  SELECT RAISE(ABORT, 'research report payload is immutable');
END;

CREATE TRIGGER research_report_payloads_no_resurrection
BEFORE INSERT ON research_report_payloads
WHEN EXISTS (
  SELECT 1 FROM research_report_state_events
  WHERE report_id = NEW.report_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'redacted research report payload cannot be restored');
END;

CREATE TRIGGER research_report_payloads_redaction_guard
BEFORE DELETE ON research_report_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_report_heads
  WHERE report_id = OLD.report_id AND state = 'redacted'
)
BEGIN
  SELECT RAISE(ABORT, 'research report payload requires redaction event');
END;

CREATE TRIGGER research_claims_immutable_update
BEFORE UPDATE ON research_claims
BEGIN
  SELECT RAISE(ABORT, 'research claims are immutable');
END;

CREATE TRIGGER research_claims_immutable_delete
BEFORE DELETE ON research_claims
BEGIN
  SELECT RAISE(ABORT, 'research claims are immutable audit');
END;

CREATE TRIGGER research_claim_evidence_immutable_update
BEFORE UPDATE ON research_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'research evidence is immutable');
END;

CREATE TRIGGER research_claim_evidence_immutable_delete
BEFORE DELETE ON research_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'research evidence is immutable audit');
END;

CREATE TRIGGER research_evidence_state_events_immutable_update
BEFORE UPDATE ON research_evidence_state_events
BEGIN
  SELECT RAISE(ABORT, 'research evidence events are append-only');
END;

CREATE TRIGGER research_evidence_state_events_immutable_delete
BEFORE DELETE ON research_evidence_state_events
BEGIN
  SELECT RAISE(ABORT, 'research evidence events are append-only');
END;

CREATE TRIGGER research_report_state_events_immutable_update
BEFORE UPDATE ON research_report_state_events
BEGIN
  SELECT RAISE(ABORT, 'research report events are append-only');
END;

CREATE TRIGGER research_report_state_events_immutable_delete
BEFORE DELETE ON research_report_state_events
BEGIN
  SELECT RAISE(ABORT, 'research report events are append-only');
END;

CREATE INDEX research_sources_run_state_idx
ON research_sources(run_id, inclusion_state, ordinal);

CREATE INDEX research_reports_target_idx
ON research_reports(target_key, version DESC);

CREATE INDEX research_claims_report_idx
ON research_claims(report_id, ordinal);

CREATE TRIGGER contents_invalidate_research_sources_after_update
AFTER UPDATE OF text, content_revision, extracted_at ON contents
WHEN OLD.text IS NOT NEW.text OR OLD.content_revision IS NOT NEW.content_revision
  OR OLD.extracted_at IS NOT NEW.extracted_at
BEGIN
  INSERT INTO research_source_state_events (
    source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
  )
  SELECT source.id, (SELECT MAX(sequence_no) + 1 FROM research_source_state_events
      WHERE source_id = source.id), 'invalidated', 'invalid',
    'captured content changed', 'contents-invalidated:source:' || source.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_sources AS source
  JOIN research_source_heads AS head ON head.source_id = source.id AND head.state = 'valid'
  WHERE source.tab_id = NEW.tab_id;

  INSERT INTO research_report_state_events (
    report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
  )
  SELECT report.id,
    (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM research_report_state_events
      WHERE report_id = report.id),
    'stale', 'stale', 'captured content changed',
    'contents-stale:report:' || report.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_reports AS report
  JOIN research_report_heads AS report_head
    ON report_head.report_id = report.id AND report_head.state = 'fresh'
  WHERE EXISTS (
    SELECT 1 FROM research_report_sources AS used
    JOIN research_sources AS source ON source.id = used.source_id
    WHERE used.report_id = report.id AND source.tab_id = NEW.tab_id
  );
END;

CREATE TRIGGER contents_invalidate_research_sources_after_delete
AFTER DELETE ON contents
BEGIN
  INSERT INTO research_source_state_events (
    source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
  )
  SELECT source.id, (SELECT MAX(sequence_no) + 1 FROM research_source_state_events
      WHERE source_id = source.id), 'invalidated', 'invalid',
    'captured content deleted', 'contents-invalidated:source:' || source.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_sources AS source
  JOIN research_source_heads AS head ON head.source_id = source.id AND head.state = 'valid'
  WHERE source.tab_id = OLD.tab_id;

  INSERT INTO research_report_state_events (
    report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
  )
  SELECT report.id,
    (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM research_report_state_events
      WHERE report_id = report.id),
    'stale', 'stale', 'captured content deleted',
    'contents-stale:report:' || report.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM research_reports AS report
  JOIN research_report_heads AS report_head
    ON report_head.report_id = report.id AND report_head.state = 'fresh'
  WHERE EXISTS (
    SELECT 1 FROM research_report_sources AS used
    JOIN research_sources AS source ON source.id = used.source_id
    WHERE used.report_id = report.id AND source.tab_id = OLD.tab_id
  );
END;

CREATE TRIGGER ai_job_events_research_publication_guard
BEFORE INSERT ON ai_job_events
WHEN NEW.event_type IN ('succeeded', 'partial')
  AND (SELECT kind FROM ai_jobs WHERE id = NEW.job_id) = 'resource_research'
  AND NOT EXISTS (
    SELECT 1 FROM research_runs AS run
    JOIN research_reports AS report
      ON report.run_id = run.id AND report.id = NEW.result_report_id
    JOIN research_run_heads AS head
      ON head.run_id = run.id AND head.report_id = report.id
    WHERE run.job_id = NEW.job_id
      AND report.publish_status = NEW.event_type
      AND head.status = NEW.event_type
  )
BEGIN
  SELECT RAISE(ABORT, 'research job terminal event requires owned publication');
END;

CREATE TRIGGER ai_job_events_project_research_run_lifecycle
AFTER INSERT ON ai_job_events
WHEN NEW.event_type IN (
    'claimed', 'retry_scheduled', 'recovered', 'failed', 'cancelled', 'superseded'
  )
  AND (SELECT kind FROM ai_jobs WHERE id = NEW.job_id) = 'resource_research'
  AND EXISTS (SELECT 1 FROM research_runs WHERE job_id = NEW.job_id)
BEGIN
  INSERT INTO research_run_events (
    run_id, sequence_no, event_type, status, report_id, idempotency_key, occurred_at
  )
  SELECT
    run.id,
    COALESCE((
      SELECT MAX(sequence_no) + 1 FROM research_run_events WHERE run_id = run.id
    ), 1),
    CASE NEW.event_type
      WHEN 'claimed' THEN 'running'
      WHEN 'retry_scheduled' THEN 'queued'
      WHEN 'recovered' THEN 'queued'
      ELSE NEW.event_type
    END,
    CASE NEW.event_type
      WHEN 'claimed' THEN 'running'
      WHEN 'retry_scheduled' THEN 'queued'
      WHEN 'recovered' THEN 'queued'
      ELSE NEW.event_type
    END,
    NULL,
    'ai-job-event:' || NEW.id,
    NEW.occurred_at
  FROM research_runs AS run
  WHERE run.job_id = NEW.job_id;
END;

-- Schema-23 could leave research queued/running without a run/corpus FK.
-- Fence those orphaned active jobs during upgrade; terminal audit remains intact.
INSERT INTO ai_job_events (
  job_id, sequence_no, event_type, from_status, to_status, attempt_id,
  lease_token, cancellation_requested_by, error_code, available_at, occurred_at
)
SELECT
  job.id,
  job.event_sequence + 1,
  'superseded',
  job.status,
  'superseded',
  CASE WHEN job.status = 'running' THEN attempt.id ELSE NULL END,
  CASE WHEN job.status = 'running' THEN job.lease_token ELSE NULL END,
  NULL,
  NULL,
  NULL,
  CASE
    WHEN job.status = 'running' AND job.updated_at >= attempt.started_at
      THEN job.updated_at
    ELSE job.updated_at
  END
FROM ai_jobs AS job
LEFT JOIN ai_job_attempts AS attempt
  ON attempt.job_id = job.id AND attempt.outcome = 'running'
WHERE job.kind = 'resource_research'
  AND job.status IN ('queued', 'running')
  AND NOT EXISTS (SELECT 1 FROM research_runs WHERE job_id = job.id)
ORDER BY job.id;

CREATE TRIGGER research_job_checkpoint_progress_guard
BEFORE INSERT ON ai_job_events
WHEN NEW.event_type = 'progress'
  AND EXISTS (SELECT 1 FROM research_runs WHERE job_id = NEW.job_id)
BEGIN
  SELECT CASE WHEN NOT COALESCE(
    NEW.checkpoint_json IS NOT NULL
    AND NEW.progress_stage = json_extract(NEW.checkpoint_json, '$.stage')
    AND NEW.progress_total IS (
      SELECT progress_total FROM ai_jobs WHERE id = NEW.job_id
    )
    AND NEW.progress_completed = CASE
      WHEN json_extract(NEW.checkpoint_json, '$.nextStep') = 2 THEN 1 ELSE 0
    END,
    0
  ) THEN RAISE(ABORT, 'invalid research checkpoint progress') END;
END;

-- Trusted agent research commands have a separate, material-free replay ledger.
-- The key and authorization references are domain-separated SHA-256 hashes; raw
-- values, prompts, corpus material and report material never enter this table.
CREATE TABLE agent_research_command_receipts (
  idempotency_key_hash TEXT PRIMARY KEY CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN ('start', 'cancel')),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_ref_hash TEXT NOT NULL CHECK (
    length(authorization_ref_hash) = 64
    AND authorization_ref_hash NOT GLOB '*[^0-9a-f]*'
  ),
  job_id INTEGER NOT NULL CHECK (
    typeof(job_id) = 'integer' AND job_id > 0 AND job_id <= 9007199254740991
  ) REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  )
);

CREATE INDEX agent_research_command_receipts_job_idx
ON agent_research_command_receipts(job_id, operation, created_at);

CREATE TRIGGER agent_research_command_receipts_owned_job_insert
BEFORE INSERT ON agent_research_command_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM ai_jobs
  WHERE id = NEW.job_id
    AND kind = 'resource_research'
    AND requested_by = 'agent'
    AND request_method = 'on_behalf_of_user'
    AND authorization_ref IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'agent research receipt requires an agent-owned research job');
END;

CREATE TRIGGER agent_research_command_receipts_immutable_update
BEFORE UPDATE ON agent_research_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent research command receipts are immutable');
END;

CREATE TRIGGER agent_research_command_receipts_immutable_delete
BEFORE DELETE ON agent_research_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent research command receipts are immutable');
END;
