CREATE TABLE ai_job_runtime_state (
  singleton_id INTEGER PRIMARY KEY CHECK (
    typeof(singleton_id) = 'integer' AND singleton_id = 1
  ),
  cursor INTEGER NOT NULL CHECK (
    typeof(cursor) = 'integer' AND cursor BETWEEN 0 AND 6
  ),
  updated_at TEXT NOT NULL CHECK (COALESCE(
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), 0
  ))
);

INSERT INTO ai_job_runtime_state (singleton_id, cursor, updated_at)
VALUES (1, 0, tabhub_migration_now());

CREATE TRIGGER ai_job_runtime_state_no_insert
BEFORE INSERT ON ai_job_runtime_state
WHEN EXISTS (SELECT 1 FROM ai_job_runtime_state)
BEGIN
  SELECT RAISE(ABORT, 'ai_job_runtime_state is singleton authority');
END;

CREATE TRIGGER ai_job_runtime_state_no_delete
BEFORE DELETE ON ai_job_runtime_state
BEGIN
  SELECT RAISE(ABORT, 'ai_job_runtime_state is singleton authority');
END;

CREATE TRIGGER ai_job_runtime_state_validate_update
BEFORE UPDATE ON ai_job_runtime_state
WHEN NEW.singleton_id IS NOT OLD.singleton_id
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'invalid ai_job_runtime_state update');
END;

CREATE TABLE agent_user_importance_receipts (
  idempotency_key_hash TEXT PRIMARY KEY CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_ref_hash TEXT NOT NULL CHECK (
    length(authorization_ref_hash) = 64
    AND authorization_ref_hash NOT GLOB '*[^0-9a-f]*'
  ),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('page', 'resource')),
  logical_page_id INTEGER CHECK (
    logical_page_id IS NULL OR (
      typeof(logical_page_id) = 'integer'
      AND logical_page_id > 0 AND logical_page_id <= 9007199254740991
    )
  ) REFERENCES logical_pages(id) ON DELETE RESTRICT,
  resource_id INTEGER CHECK (
    resource_id IS NULL OR (
      typeof(resource_id) = 'integer'
      AND resource_id > 0 AND resource_id <= 9007199254740991
    )
  ) REFERENCES resources(id) ON DELETE RESTRICT,
  value INTEGER CHECK (
    value IS NULL OR (typeof(value) = 'integer' AND value BETWEEN 1 AND 3)
  ),
  result_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(result_json)
      THEN json_type(result_json) = 'object'
        AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 4096
      ELSE 0 END
  ),
  result_updated_at TEXT NOT NULL CHECK (COALESCE(
    result_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', result_updated_at), 0
  )),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  CHECK (created_at >= result_updated_at),
  CHECK (
    (subject_type = 'page' AND logical_page_id IS NOT NULL AND resource_id IS NULL)
    OR
    (subject_type = 'resource' AND logical_page_id IS NULL AND resource_id IS NOT NULL)
  )
);

CREATE TRIGGER agent_user_importance_receipts_immutable_update
BEFORE UPDATE ON agent_user_importance_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent user importance receipts are append-only');
END;

CREATE TRIGGER agent_user_importance_receipts_immutable_delete
BEFORE DELETE ON agent_user_importance_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent user importance receipts are append-only');
END;

CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY CHECK (
    typeof(id) = 'integer' AND id > 0 AND id <= 9007199254740991
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('priority_assessment', 'resource_research')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('page', 'resource', 'collection', 'selection')
  ),
  logical_page_id INTEGER CHECK (
    logical_page_id IS NULL OR (
      typeof(logical_page_id) = 'integer'
      AND logical_page_id > 0 AND logical_page_id <= 9007199254740991
    )
  ) REFERENCES logical_pages(id) ON DELETE RESTRICT,
  resource_id INTEGER CHECK (
    resource_id IS NULL OR (
      typeof(resource_id) = 'integer'
      AND resource_id > 0 AND resource_id <= 9007199254740991
    )
  ) REFERENCES resources(id) ON DELETE RESTRICT,
  collection_scope TEXT CHECK (
    collection_scope IS NULL OR collection_scope = 'all'
  ),
  selection_fingerprint TEXT CHECK (
    selection_fingerprint IS NULL OR (
      length(selection_fingerprint) = 64
      AND selection_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  subject_key TEXT NOT NULL CHECK (
    length(CAST(subject_key AS BLOB)) BETWEEN 1 AND 80
  ),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('user', 'agent', 'system')),
  request_method TEXT NOT NULL CHECK (
    request_method IN ('manual', 'on_behalf_of_user', 'scheduled')
  ),
  authorization_ref TEXT CHECK (
    authorization_ref IS NULL
    OR (length(CAST(authorization_ref AS BLOB)) BETWEEN 1 AND 256
      AND authorization_ref = trim(authorization_ref))
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
    AND idempotency_key = trim(idempotency_key)
  ),
  submission_fingerprint TEXT NOT NULL CHECK (
    length(submission_fingerprint) = 64
    AND submission_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  input_fingerprint TEXT NOT NULL CHECK (
    length(input_fingerprint) = 64
    AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  ruleset_id INTEGER CHECK (
    ruleset_id IS NULL OR (
      typeof(ruleset_id) = 'integer'
      AND ruleset_id > 0 AND ruleset_id <= 9007199254740991
    )
  ),
  ruleset_version INTEGER CHECK (
    ruleset_version IS NULL OR (
      typeof(ruleset_version) = 'integer'
      AND ruleset_version > 0 AND ruleset_version <= 9007199254740991
    )
  ),
  assessment_method TEXT CHECK (
    assessment_method IS NULL OR assessment_method IN ('rule', 'model')
  ),
  assessment_model_provider TEXT CHECK (
    assessment_model_provider IS NULL OR (
      length(CAST(assessment_model_provider AS BLOB)) BETWEEN 1 AND 128
      AND assessment_model_provider = trim(assessment_model_provider)
    )
  ),
  assessment_model_name TEXT CHECK (
    assessment_model_name IS NULL OR (
      length(CAST(assessment_model_name AS BLOB)) BETWEEN 1 AND 128
      AND assessment_model_name = trim(assessment_model_name)
    )
  ),
  assessment_prompt_version TEXT CHECK (
    assessment_prompt_version IS NULL OR (
      length(CAST(assessment_prompt_version AS BLOB)) BETWEEN 1 AND 128
      AND assessment_prompt_version = trim(assessment_prompt_version)
    )
  ),
  workflow_id TEXT CHECK (
    workflow_id IS NULL OR (
      length(CAST(workflow_id AS BLOB)) BETWEEN 1 AND 128
      AND workflow_id = trim(workflow_id)
    )
  ),
  workflow_version INTEGER CHECK (
    workflow_version IS NULL OR (
      typeof(workflow_version) = 'integer'
      AND workflow_version > 0 AND workflow_version <= 9007199254740991
    )
  ),
  step_batch_size INTEGER CHECK (
    step_batch_size IS NULL OR (
      typeof(step_batch_size) = 'integer' AND step_batch_size BETWEEN 1 AND 100
    )
  ),
  scheduling_priority INTEGER NOT NULL CHECK (
    typeof(scheduling_priority) = 'integer'
    AND scheduling_priority BETWEEN -100 AND 100
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued', 'running', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempts) = 'integer'
    AND attempts BETWEEN 0 AND 9007199254740991
  ),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (
    typeof(max_attempts) = 'integer'
    AND max_attempts BETWEEN 1 AND 100
    AND attempts <= max_attempts
  ),
  available_at TEXT NOT NULL CHECK (COALESCE(
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', available_at), 0
  )),
  progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(progress_completed) = 'integer'
    AND progress_completed BETWEEN 0 AND 9007199254740991
  ),
  progress_total INTEGER CHECK (
    progress_total IS NULL OR (
      typeof(progress_total) = 'integer'
      AND progress_total BETWEEN 0 AND 9007199254740991
      AND progress_completed <= progress_total
    )
  ),
  progress_stage TEXT NOT NULL DEFAULT 'queued' CHECK (
    length(CAST(progress_stage AS BLOB)) BETWEEN 1 AND 128
    AND progress_stage = trim(progress_stage)
  ),
  checkpoint_json TEXT CHECK (
    checkpoint_json IS NULL
    OR length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND 65536
  ),
  spent_steps INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(spent_steps) = 'integer'
    AND spent_steps BETWEEN 0 AND 9007199254740991
  ),
  max_steps INTEGER NOT NULL CHECK (
    typeof(max_steps) = 'integer'
    AND max_steps BETWEEN 1 AND 9007199254740991
    AND spent_steps <= max_steps
  ),
  spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(spent_tokens) = 'integer'
    AND spent_tokens BETWEEN 0 AND 9007199254740991
  ),
  max_tokens INTEGER NOT NULL CHECK (
    typeof(max_tokens) = 'integer'
    AND max_tokens BETWEEN 0 AND 9007199254740991
    AND spent_tokens <= max_tokens
  ),
  spent_cost_usd REAL NOT NULL DEFAULT 0 CHECK (
    typeof(spent_cost_usd) IN ('real', 'integer')
    AND spent_cost_usd >= 0 AND spent_cost_usd <= 1.0e308
  ),
  max_cost_usd REAL NOT NULL CHECK (
    typeof(max_cost_usd) IN ('real', 'integer')
    AND max_cost_usd >= 0 AND max_cost_usd <= 1.0e308
    AND spent_cost_usd <= max_cost_usd
  ),
  spent_wall_time_ms INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(spent_wall_time_ms) = 'integer'
    AND spent_wall_time_ms BETWEEN 0 AND 9007199254740991
  ),
  max_wall_time_ms INTEGER NOT NULL CHECK (
    typeof(max_wall_time_ms) = 'integer'
    AND max_wall_time_ms BETWEEN 1 AND 9007199254740991
    AND spent_wall_time_ms <= max_wall_time_ms
  ),
  cancellation_requested_by TEXT CHECK (
    cancellation_requested_by IS NULL
    OR cancellation_requested_by IN ('user', 'agent')
  ),
  cancellation_requested_at TEXT CHECK (COALESCE(
    cancellation_requested_at IS NULL
    OR cancellation_requested_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', cancellation_requested_at
    ), 0
  )),
  lease_owner TEXT CHECK (
    lease_owner IS NULL
    OR (length(CAST(lease_owner AS BLOB)) BETWEEN 1 AND 200
      AND lease_owner = trim(lease_owner))
  ),
  lease_token TEXT UNIQUE CHECK (
    lease_token IS NULL
    OR (length(CAST(lease_token AS BLOB)) BETWEEN 16 AND 200
      AND lease_token = trim(lease_token))
  ),
  lease_expires_at TEXT CHECK (COALESCE(
    lease_expires_at IS NULL
    OR lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at), 0
  )),
  result_type TEXT CHECK (
    result_type IS NULL OR result_type IN ('priority_output', 'research_report')
  ),
  result_output_fingerprint TEXT CHECK (
    result_output_fingerprint IS NULL OR (
      length(result_output_fingerprint) = 64
      AND result_output_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_report_id INTEGER CHECK (
    result_report_id IS NULL OR (
      typeof(result_report_id) = 'integer'
      AND result_report_id > 0 AND result_report_id <= 9007199254740991
    )
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'INVALID_JOB_INPUT', 'JOB_SUBJECT_NOT_FOUND', 'JOB_INPUT_UNAVAILABLE',
      'JOB_BUDGET_EXHAUSTED', 'JOB_LEASE_LOST', 'JOB_CLOCK_REGRESSION',
      'INVALID_JOB_TRANSITION', 'JOB_STORAGE_CORRUPT'
    )
  ),
  error_message TEXT CHECK (
    error_message IS NULL
    OR length(CAST(error_message AS BLOB)) BETWEEN 1 AND 1024
  ),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(event_sequence) = 'integer'
    AND event_sequence BETWEEN 0 AND 9007199254740991
  ),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  updated_at TEXT NOT NULL CHECK (COALESCE(
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
    AND updated_at >= created_at, 0
  )),
  started_at TEXT CHECK (COALESCE(
    started_at IS NULL OR (
      started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)
      AND started_at >= created_at
    ), 0
  )),
  completed_at TEXT CHECK (COALESCE(
    completed_at IS NULL OR (
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
      AND completed_at >= created_at
    ), 0
  )),
  CHECK (
    (requested_by = 'user' AND request_method = 'manual'
      AND authorization_ref IS NULL)
    OR (requested_by = 'agent' AND request_method = 'on_behalf_of_user'
      AND authorization_ref IS NOT NULL)
    OR (requested_by = 'system' AND request_method = 'scheduled'
      AND authorization_ref IS NULL)
  ),
  CHECK (
    (subject_type = 'page' AND logical_page_id IS NOT NULL
      AND resource_id IS NULL AND collection_scope IS NULL
      AND selection_fingerprint IS NULL
      AND subject_key = 'page:' || logical_page_id)
    OR (subject_type = 'resource' AND logical_page_id IS NULL
      AND resource_id IS NOT NULL AND collection_scope IS NULL
      AND selection_fingerprint IS NULL
      AND subject_key = 'resource:' || resource_id)
    OR (kind = 'priority_assessment' AND subject_type = 'collection'
      AND logical_page_id IS NULL AND resource_id IS NULL
      AND collection_scope = 'all' AND selection_fingerprint IS NULL
      AND subject_key = 'collection:all')
    OR (kind = 'resource_research' AND subject_type = 'selection'
      AND logical_page_id IS NULL AND resource_id IS NULL
      AND collection_scope IS NULL AND selection_fingerprint IS NOT NULL
      AND subject_key = 'selection:' || selection_fingerprint)
  ),
  CHECK (
    (kind = 'priority_assessment' AND subject_type IN ('page', 'resource', 'collection')
      AND ruleset_id IS NOT NULL AND ruleset_version IS NOT NULL
      AND assessment_method IS NOT NULL
      AND workflow_id IS NULL AND workflow_version IS NULL
      AND step_batch_size IS NOT NULL)
    OR (kind = 'resource_research' AND subject_type IN ('page', 'resource', 'selection')
      AND ruleset_id IS NULL AND ruleset_version IS NULL
      AND assessment_method IS NULL AND assessment_model_provider IS NULL
      AND assessment_model_name IS NULL AND assessment_prompt_version IS NULL
      AND workflow_id IS NOT NULL AND workflow_version IS NOT NULL
      AND step_batch_size IS NULL)
  ),
  CHECK (
    (assessment_method = 'rule'
      AND assessment_model_provider IS NULL
      AND assessment_model_name IS NULL
      AND assessment_prompt_version IS NULL)
    OR (assessment_method = 'model'
      AND assessment_model_provider IS NOT NULL
      AND assessment_model_name IS NOT NULL
      AND assessment_prompt_version IS NOT NULL)
    OR assessment_method IS NULL
  ),
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status <> 'running' AND lease_owner IS NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'partial', 'failed', 'cancelled', 'superseded')
      AND completed_at IS NOT NULL)
  ),
  CHECK (
    (cancellation_requested_by IS NULL AND cancellation_requested_at IS NULL)
    OR (cancellation_requested_by IS NOT NULL AND cancellation_requested_at IS NOT NULL)
  ),
  CHECK (
    (status NOT IN ('succeeded', 'partial')
      AND result_type IS NULL AND result_output_fingerprint IS NULL
      AND result_report_id IS NULL)
    OR (status IN ('succeeded', 'partial')
      AND kind = 'priority_assessment' AND result_type = 'priority_output'
      AND result_output_fingerprint IS NOT NULL AND result_report_id IS NULL)
    OR (status IN ('succeeded', 'partial')
      AND kind = 'resource_research' AND result_type = 'research_report'
      AND result_output_fingerprint IS NULL AND result_report_id IS NOT NULL)
  ),
  CHECK (
    (error_code IS NULL AND error_message IS NULL)
    OR (error_code IS NOT NULL AND error_message IS NOT NULL)
  ),
  CHECK (
    error_code IS NULL OR status IN ('queued', 'failed', 'partial')
  ),
  CHECK (
    cancellation_requested_at IS NULL OR status IN ('running', 'cancelled')
  ),
  UNIQUE (id, kind),
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ai_jobs_one_active_priority_subject_idx
ON ai_jobs(subject_key)
WHERE kind = 'priority_assessment' AND status IN ('queued', 'running');

CREATE UNIQUE INDEX ai_jobs_one_active_research_subject_idx
ON ai_jobs(subject_key)
WHERE kind = 'resource_research' AND status IN ('queued', 'running');

CREATE INDEX ai_jobs_claim_idx ON ai_jobs(
  kind, status, scheduling_priority DESC, available_at, created_at, id
);

CREATE INDEX ai_jobs_created_idx ON ai_jobs(kind, created_at, id);

CREATE TABLE ai_job_idempotency_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
    AND idempotency_key = trim(idempotency_key)
  ),
  submission_fingerprint TEXT NOT NULL CHECK (
    length(submission_fingerprint) = 64
    AND submission_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  job_id INTEGER NOT NULL CHECK (
    typeof(job_id) = 'integer' AND job_id > 0 AND job_id <= 9007199254740991
  ),
  kind TEXT NOT NULL CHECK (kind IN ('priority_assessment', 'resource_research')),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  FOREIGN KEY (job_id, kind) REFERENCES ai_jobs(id, kind) ON DELETE RESTRICT
);

CREATE TABLE ai_job_attempts (
  id INTEGER PRIMARY KEY CHECK (
    typeof(id) = 'integer' AND id > 0 AND id <= 9007199254740991
  ),
  job_id INTEGER NOT NULL CHECK (
    typeof(job_id) = 'integer' AND job_id > 0 AND job_id <= 9007199254740991
  ) REFERENCES ai_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (
    typeof(attempt_no) = 'integer'
    AND attempt_no > 0 AND attempt_no <= 9007199254740991
  ),
  lease_token TEXT NOT NULL UNIQUE CHECK (
    length(CAST(lease_token AS BLOB)) BETWEEN 16 AND 200
    AND lease_token = trim(lease_token)
  ),
  worker_id TEXT NOT NULL CHECK (
    length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 200
    AND worker_id = trim(worker_id)
  ),
  provider TEXT CHECK (
    provider IS NULL OR (length(CAST(provider AS BLOB)) BETWEEN 1 AND 128
      AND provider = trim(provider))
  ),
  model TEXT CHECK (
    model IS NULL OR (length(CAST(model AS BLOB)) BETWEEN 1 AND 200
      AND model = trim(model))
  ),
  prompt_version TEXT CHECK (
    prompt_version IS NULL OR (
      length(CAST(prompt_version AS BLOB)) BETWEEN 1 AND 128
      AND prompt_version = trim(prompt_version)
    )
  ),
  provider_bound_at TEXT CHECK (COALESCE(
    provider_bound_at IS NULL OR provider_bound_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', provider_bound_at
    ), 0
  )),
  request_id TEXT CHECK (
    request_id IS NULL OR (length(CAST(request_id AS BLOB)) BETWEEN 1 AND 256
      AND request_id = trim(request_id))
  ),
  request_bound_at TEXT CHECK (COALESCE(
    request_bound_at IS NULL OR request_bound_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', request_bound_at
    ), 0
  )),
  started_at TEXT NOT NULL CHECK (COALESCE(
    started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at), 0
  )),
  completed_at TEXT CHECK (COALESCE(
    completed_at IS NULL OR (
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
      AND completed_at >= started_at
    ), 0
  )),
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'running', 'succeeded', 'partial', 'failed', 'cancelled',
      'interrupted', 'superseded'
    )
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(input_tokens) = 'integer'
    AND input_tokens BETWEEN 0 AND 9007199254740991
  ),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(output_tokens) = 'integer'
    AND output_tokens BETWEEN 0 AND 9007199254740991
  ),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (
    typeof(cost_usd) IN ('real', 'integer')
    AND cost_usd >= 0 AND cost_usd <= 1.0e308
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'INVALID_JOB_INPUT', 'JOB_SUBJECT_NOT_FOUND', 'JOB_INPUT_UNAVAILABLE',
      'JOB_BUDGET_EXHAUSTED', 'JOB_LEASE_LOST', 'JOB_CLOCK_REGRESSION',
      'INVALID_JOB_TRANSITION', 'JOB_STORAGE_CORRUPT'
    )
  ),
  error_message TEXT CHECK (
    error_message IS NULL
    OR length(CAST(error_message AS BLOB)) BETWEEN 1 AND 1024
  ),
  CHECK (
    (outcome = 'running' AND completed_at IS NULL)
    OR (outcome <> 'running' AND completed_at IS NOT NULL)
  ),
  CHECK (
    (error_code IS NULL AND error_message IS NULL)
    OR (error_code IS NOT NULL AND error_message IS NOT NULL)
  ),
  CHECK (
    (provider IS NULL AND model IS NULL AND prompt_version IS NULL
      AND provider_bound_at IS NULL)
    OR (provider IS NOT NULL AND model IS NOT NULL AND prompt_version IS NOT NULL
      AND provider_bound_at IS NOT NULL AND provider_bound_at >= started_at)
  ),
  CHECK (
    (request_id IS NULL AND request_bound_at IS NULL)
    OR (request_id IS NOT NULL AND request_bound_at IS NOT NULL
      AND provider_bound_at IS NOT NULL AND request_bound_at >= provider_bound_at)
  ),
  CHECK (
    outcome = 'interrupted'
    OR (outcome = 'failed' AND error_code IS NOT NULL)
    OR (outcome = 'partial' AND error_code = 'JOB_BUDGET_EXHAUSTED')
    OR (outcome NOT IN ('failed', 'partial', 'interrupted') AND error_code IS NULL)
  ),
  UNIQUE (job_id, attempt_no),
  UNIQUE (id, job_id)
);

CREATE TABLE ai_job_events (
  id INTEGER PRIMARY KEY CHECK (
    typeof(id) = 'integer' AND id > 0 AND id <= 9007199254740991
  ),
  job_id INTEGER NOT NULL CHECK (
    typeof(job_id) = 'integer' AND job_id > 0 AND job_id <= 9007199254740991
  ) REFERENCES ai_jobs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (
    typeof(sequence_no) = 'integer'
    AND sequence_no > 0 AND sequence_no <= 9007199254740991
  ),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'submitted', 'claimed', 'progress', 'cancel_requested',
      'deferred', 'retry_scheduled', 'recovered', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded'
    )
  ),
  from_status TEXT CHECK (
    from_status IS NULL OR from_status IN (
      'queued', 'running', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded'
    )
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN (
      'queued', 'running', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded'
    )
  ),
  attempt_id INTEGER,
  lease_owner TEXT CHECK (
    lease_owner IS NULL
    OR (length(CAST(lease_owner AS BLOB)) BETWEEN 1 AND 200
      AND lease_owner = trim(lease_owner))
  ),
  lease_token TEXT CHECK (
    lease_token IS NULL
    OR (length(CAST(lease_token AS BLOB)) BETWEEN 16 AND 200
      AND lease_token = trim(lease_token))
  ),
  lease_expires_at TEXT CHECK (COALESCE(
    lease_expires_at IS NULL
    OR lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at), 0
  )),
  progress_completed INTEGER CHECK (
    progress_completed IS NULL OR (
      typeof(progress_completed) = 'integer'
      AND progress_completed BETWEEN 0 AND 9007199254740991
    )
  ),
  progress_total INTEGER CHECK (
    progress_total IS NULL OR (
      typeof(progress_total) = 'integer'
      AND progress_total BETWEEN 0 AND 9007199254740991
    )
  ),
  progress_stage TEXT CHECK (
    progress_stage IS NULL OR (
      length(CAST(progress_stage AS BLOB)) BETWEEN 1 AND 128
      AND progress_stage = trim(progress_stage)
    )
  ),
  checkpoint_json TEXT CHECK (
    checkpoint_json IS NULL
    OR length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND 65536
  ),
  cancellation_requested_by TEXT CHECK (
    cancellation_requested_by IS NULL
    OR cancellation_requested_by IN ('user', 'agent')
  ),
  result_type TEXT CHECK (
    result_type IS NULL OR result_type IN ('priority_output', 'research_report')
  ),
  result_output_fingerprint TEXT CHECK (
    result_output_fingerprint IS NULL OR (
      length(result_output_fingerprint) = 64
      AND result_output_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_report_id INTEGER CHECK (
    result_report_id IS NULL OR (
      typeof(result_report_id) = 'integer'
      AND result_report_id > 0 AND result_report_id <= 9007199254740991
    )
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'INVALID_JOB_INPUT', 'JOB_SUBJECT_NOT_FOUND', 'JOB_INPUT_UNAVAILABLE',
      'JOB_BUDGET_EXHAUSTED', 'JOB_LEASE_LOST', 'JOB_CLOCK_REGRESSION',
      'INVALID_JOB_TRANSITION', 'JOB_STORAGE_CORRUPT'
    )
  ),
  available_at TEXT CHECK (COALESCE(
    available_at IS NULL
    OR available_at = strftime('%Y-%m-%dT%H:%M:%fZ', available_at), 0
  )),
  spent_steps INTEGER CHECK (
    spent_steps IS NULL OR (
      typeof(spent_steps) = 'integer'
      AND spent_steps BETWEEN 0 AND 9007199254740991
    )
  ),
  spent_tokens INTEGER CHECK (
    spent_tokens IS NULL OR (
      typeof(spent_tokens) = 'integer'
      AND spent_tokens BETWEEN 0 AND 9007199254740991
    )
  ),
  spent_input_tokens INTEGER CHECK (
    spent_input_tokens IS NULL OR (
      typeof(spent_input_tokens) = 'integer'
      AND spent_input_tokens BETWEEN 0 AND 9007199254740991
    )
  ),
  spent_output_tokens INTEGER CHECK (
    spent_output_tokens IS NULL OR (
      typeof(spent_output_tokens) = 'integer'
      AND spent_output_tokens BETWEEN 0 AND 9007199254740991
    )
  ),
  delta_input_tokens INTEGER CHECK (
    delta_input_tokens IS NULL OR (
      typeof(delta_input_tokens) = 'integer'
      AND delta_input_tokens BETWEEN 0 AND 9007199254740991
    )
  ),
  delta_output_tokens INTEGER CHECK (
    delta_output_tokens IS NULL OR (
      typeof(delta_output_tokens) = 'integer'
      AND delta_output_tokens BETWEEN 0 AND 9007199254740991
    )
  ),
  delta_cost_usd REAL CHECK (
    delta_cost_usd IS NULL OR (
      typeof(delta_cost_usd) IN ('real', 'integer')
      AND delta_cost_usd >= 0 AND delta_cost_usd <= 1.0e308
    )
  ),
  delta_steps INTEGER CHECK (
    delta_steps IS NULL OR (
      typeof(delta_steps) = 'integer'
      AND delta_steps BETWEEN 0 AND 9007199254740991
    )
  ),
  delta_wall_time_ms INTEGER CHECK (
    delta_wall_time_ms IS NULL OR (
      typeof(delta_wall_time_ms) = 'integer'
      AND delta_wall_time_ms BETWEEN 0 AND 9007199254740991
    )
  ),
  spent_cost_usd REAL CHECK (
    spent_cost_usd IS NULL OR (
      typeof(spent_cost_usd) IN ('real', 'integer')
      AND spent_cost_usd >= 0 AND spent_cost_usd <= 1.0e308
    )
  ),
  spent_wall_time_ms INTEGER CHECK (
    spent_wall_time_ms IS NULL OR (
      typeof(spent_wall_time_ms) = 'integer'
      AND spent_wall_time_ms BETWEEN 0 AND 9007199254740991
    )
  ),
  occurred_at TEXT NOT NULL CHECK (COALESCE(
    occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at), 0
  )),
  UNIQUE (job_id, sequence_no),
  CHECK (
    progress_total IS NULL OR progress_completed IS NULL
      OR progress_completed <= progress_total
  ),
  CHECK (
    spent_tokens IS NULL OR (
      spent_input_tokens IS NOT NULL AND spent_output_tokens IS NOT NULL
      AND spent_tokens = spent_input_tokens + spent_output_tokens
    )
  ),
  FOREIGN KEY (attempt_id, job_id)
    REFERENCES ai_job_attempts(id, job_id) ON DELETE CASCADE
);

CREATE INDEX ai_job_events_time_idx ON ai_job_events(occurred_at, id);

CREATE TRIGGER ai_jobs_validate_checkpoint_insert
BEFORE INSERT ON ai_jobs
WHEN NEW.checkpoint_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    json_valid(NEW.checkpoint_json)
    AND json_type(NEW.checkpoint_json) = 'object'
    AND NEW.checkpoint_json = json(NEW.checkpoint_json)
    AND (SELECT COUNT(*) FROM json_each(NEW.checkpoint_json)) = 2
    AND (SELECT COUNT(DISTINCT key) FROM json_each(NEW.checkpoint_json)) = 2
    AND json_type(NEW.checkpoint_json, '$.version') = 'integer'
    AND json_extract(NEW.checkpoint_json, '$.version') = 1
    AND (
      (NEW.kind = 'priority_assessment'
        AND json_type(NEW.checkpoint_json, '$.nextOffset') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextOffset') BETWEEN 0 AND 9007199254740991
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.checkpoint_json)
          WHERE key NOT IN ('version', 'nextOffset')
        )
        AND NEW.checkpoint_json = json_object(
          'nextOffset', json_extract(NEW.checkpoint_json, '$.nextOffset'),
          'version', 1
        ))
      OR (NEW.kind = 'resource_research'
        AND json_type(NEW.checkpoint_json, '$.nextStep') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextStep') BETWEEN 0 AND 9007199254740991
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.checkpoint_json)
          WHERE key NOT IN ('version', 'nextStep')
        )
        AND NEW.checkpoint_json = json_object(
          'nextStep', json_extract(NEW.checkpoint_json, '$.nextStep'),
          'version', 1
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
    AND (SELECT COUNT(*) FROM json_each(NEW.checkpoint_json)) = 2
    AND (SELECT COUNT(DISTINCT key) FROM json_each(NEW.checkpoint_json)) = 2
    AND json_type(NEW.checkpoint_json, '$.version') = 'integer'
    AND json_extract(NEW.checkpoint_json, '$.version') = 1
    AND (
      (NEW.kind = 'priority_assessment'
        AND json_type(NEW.checkpoint_json, '$.nextOffset') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextOffset') BETWEEN 0 AND 9007199254740991
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.checkpoint_json)
          WHERE key NOT IN ('version', 'nextOffset')
        )
        AND NEW.checkpoint_json = json_object(
          'nextOffset', json_extract(NEW.checkpoint_json, '$.nextOffset'),
          'version', 1
        ))
      OR (NEW.kind = 'resource_research'
        AND json_type(NEW.checkpoint_json, '$.nextStep') = 'integer'
        AND json_extract(NEW.checkpoint_json, '$.nextStep') BETWEEN 0 AND 9007199254740991
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.checkpoint_json)
          WHERE key NOT IN ('version', 'nextStep')
        )
        AND NEW.checkpoint_json = json_object(
          'nextStep', json_extract(NEW.checkpoint_json, '$.nextStep'),
          'version', 1
        ))
    )
  ) THEN RAISE(ABORT, 'invalid ai job checkpoint') END;
END;

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
      AND (max_tokens = 0 OR spent_tokens < max_tokens)
      AND (max_cost_usd = 0 OR spent_cost_usd < max_cost_usd)
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
          OR (max_tokens > 0 AND spent_tokens >= max_tokens)
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

CREATE TRIGGER ai_job_events_project_insert
AFTER INSERT ON ai_job_events
BEGIN
  UPDATE ai_job_attempts SET
    input_tokens = NEW.spent_input_tokens - COALESCE((
      SELECT SUM(other.input_tokens)
      FROM ai_job_attempts AS other
      WHERE other.job_id = NEW.job_id AND other.id <> NEW.attempt_id
    ), 0),
    output_tokens = NEW.spent_output_tokens - COALESCE((
      SELECT SUM(other.output_tokens)
      FROM ai_job_attempts AS other
      WHERE other.job_id = NEW.job_id AND other.id <> NEW.attempt_id
    ), 0),
    cost_usd = NEW.spent_cost_usd - COALESCE((
      SELECT SUM(other.cost_usd)
      FROM ai_job_attempts AS other
      WHERE other.job_id = NEW.job_id AND other.id <> NEW.attempt_id
    ), 0)
  WHERE id = NEW.attempt_id AND NEW.event_type = 'progress';
  UPDATE ai_job_attempts SET
    completed_at = NEW.occurred_at,
    outcome = CASE NEW.event_type
      WHEN 'succeeded' THEN 'succeeded'
      WHEN 'partial' THEN 'partial'
      WHEN 'failed' THEN CASE WHEN NEW.occurred_at >= (
        SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
      ) THEN 'interrupted' ELSE 'failed' END
      WHEN 'cancelled' THEN CASE WHEN NEW.occurred_at >= (
        SELECT lease_expires_at FROM ai_jobs WHERE id = NEW.job_id
      ) THEN 'interrupted' ELSE 'cancelled' END
      WHEN 'superseded' THEN 'superseded'
      ELSE 'interrupted'
    END,
    error_code = NEW.error_code,
    cost_usd = (
      SELECT spent_cost_usd FROM ai_jobs WHERE id = NEW.job_id
    ) - COALESCE((
      SELECT SUM(other.cost_usd)
      FROM ai_job_attempts AS other
      WHERE other.job_id = NEW.job_id AND other.id <> NEW.attempt_id
    ), 0),
    error_message = CASE NEW.error_code
      WHEN 'INVALID_JOB_INPUT' THEN 'Invalid job input'
      WHEN 'JOB_SUBJECT_NOT_FOUND' THEN 'Job subject not found'
      WHEN 'JOB_INPUT_UNAVAILABLE' THEN 'Job input unavailable'
      WHEN 'JOB_BUDGET_EXHAUSTED' THEN 'Job budget exhausted'
      WHEN 'JOB_LEASE_LOST' THEN 'Job lease lost'
      WHEN 'JOB_CLOCK_REGRESSION' THEN 'Job clock regression'
      WHEN 'INVALID_JOB_TRANSITION' THEN 'Invalid job transition'
      WHEN 'JOB_STORAGE_CORRUPT' THEN 'Job storage corrupt'
      ELSE NULL
    END
  WHERE id = NEW.attempt_id
    AND NEW.from_status = 'running'
    AND NEW.event_type IN (
      'retry_scheduled', 'recovered', 'succeeded', 'partial', 'failed',
      'cancelled', 'superseded'
    );
  UPDATE ai_jobs SET
    status = NEW.to_status,
    event_sequence = NEW.sequence_no,
    updated_at = NEW.occurred_at,
    available_at = CASE
      WHEN NEW.event_type IN ('deferred', 'retry_scheduled', 'recovered')
        THEN NEW.available_at
      ELSE available_at
    END,
    attempts = CASE
      WHEN NEW.event_type = 'claimed' THEN attempts + 1 ELSE attempts
    END,
    started_at = CASE
      WHEN NEW.event_type = 'claimed' THEN COALESCE(started_at, NEW.occurred_at)
      ELSE started_at
    END,
    completed_at = CASE
      WHEN NEW.to_status IN (
        'succeeded', 'partial', 'failed', 'cancelled', 'superseded'
      ) THEN NEW.occurred_at
      WHEN NEW.to_status = 'queued' THEN NULL
      ELSE completed_at
    END,
    lease_owner = CASE
      WHEN NEW.event_type = 'claimed' THEN NEW.lease_owner
      WHEN NEW.event_type = 'progress' AND NEW.lease_expires_at IS NOT NULL
        THEN NEW.lease_owner
      WHEN NEW.to_status = 'running' THEN lease_owner
      ELSE NULL
    END,
    lease_token = CASE
      WHEN NEW.event_type = 'claimed' THEN NEW.lease_token
      WHEN NEW.event_type = 'progress' AND NEW.lease_expires_at IS NOT NULL
        THEN NEW.lease_token
      WHEN NEW.to_status = 'running' THEN lease_token
      ELSE NULL
    END,
    lease_expires_at = CASE
      WHEN NEW.event_type = 'claimed' THEN NEW.lease_expires_at
      WHEN NEW.event_type = 'progress' AND NEW.lease_expires_at IS NOT NULL
        THEN NEW.lease_expires_at
      WHEN NEW.to_status = 'running' THEN lease_expires_at
      ELSE NULL
    END,
    progress_completed = COALESCE(NEW.progress_completed, progress_completed),
    progress_total = CASE
      WHEN NEW.event_type = 'progress' THEN NEW.progress_total
      ELSE progress_total
    END,
    progress_stage = COALESCE(NEW.progress_stage, progress_stage),
    checkpoint_json = CASE
      WHEN NEW.event_type = 'progress' THEN NEW.checkpoint_json
      ELSE checkpoint_json
    END,
    spent_steps = COALESCE(NEW.spent_steps, spent_steps),
    spent_tokens = COALESCE(NEW.spent_tokens, spent_tokens),
    spent_cost_usd = COALESCE(NEW.spent_cost_usd, spent_cost_usd),
    spent_wall_time_ms = COALESCE(NEW.spent_wall_time_ms, spent_wall_time_ms),
    cancellation_requested_by = CASE
      WHEN NEW.event_type = 'superseded' THEN NULL
      WHEN NEW.event_type IN ('cancel_requested', 'cancelled')
        AND NEW.cancellation_requested_by IS NOT NULL
        THEN NEW.cancellation_requested_by
      ELSE cancellation_requested_by
    END,
    cancellation_requested_at = CASE
      WHEN NEW.event_type = 'superseded' THEN NULL
      WHEN NEW.event_type IN ('cancel_requested', 'cancelled')
        AND NEW.cancellation_requested_by IS NOT NULL
        THEN NEW.occurred_at
      ELSE cancellation_requested_at
    END,
    result_type = NEW.result_type,
    result_output_fingerprint = NEW.result_output_fingerprint,
    result_report_id = NEW.result_report_id,
    error_code = CASE
      WHEN NEW.event_type = 'claimed' THEN NULL
      WHEN NEW.event_type = 'deferred' THEN error_code
      ELSE NEW.error_code
    END,
    error_message = CASE
      WHEN NEW.event_type = 'claimed' THEN NULL
      WHEN NEW.event_type = 'deferred' THEN error_message
      ELSE CASE NEW.error_code
      WHEN 'INVALID_JOB_INPUT' THEN 'Invalid job input'
      WHEN 'JOB_SUBJECT_NOT_FOUND' THEN 'Job subject not found'
      WHEN 'JOB_INPUT_UNAVAILABLE' THEN 'Job input unavailable'
      WHEN 'JOB_BUDGET_EXHAUSTED' THEN 'Job budget exhausted'
      WHEN 'JOB_LEASE_LOST' THEN 'Job lease lost'
      WHEN 'JOB_CLOCK_REGRESSION' THEN 'Job clock regression'
      WHEN 'INVALID_JOB_TRANSITION' THEN 'Invalid job transition'
      WHEN 'JOB_STORAGE_CORRUPT' THEN 'Job storage corrupt'
      ELSE NULL
    END END
  WHERE id = NEW.job_id;
END;

CREATE TRIGGER ai_jobs_status_requires_event
BEFORE UPDATE OF status, event_sequence ON ai_jobs
WHEN NEW.status IS NOT OLD.status OR NEW.event_sequence <> OLD.event_sequence
BEGIN
  SELECT CASE WHEN NEW.event_sequence <> OLD.event_sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM ai_job_events
    WHERE job_id = OLD.id
      AND sequence_no = NEW.event_sequence
      AND (
        (OLD.event_sequence = 0 AND from_status IS NULL)
        OR (OLD.event_sequence > 0 AND from_status IS OLD.status)
      )
      AND to_status = NEW.status
  ) THEN RAISE(ABORT, 'ai job projection requires event') END;
END;

CREATE TRIGGER ai_jobs_projection_requires_event
BEFORE UPDATE ON ai_jobs
WHEN NEW.event_sequence = OLD.event_sequence AND (
  NEW.available_at IS NOT OLD.available_at
  OR NEW.updated_at IS NOT OLD.updated_at
  OR NEW.attempts IS NOT OLD.attempts
  OR NEW.progress_completed IS NOT OLD.progress_completed
  OR NEW.progress_total IS NOT OLD.progress_total
  OR NEW.progress_stage IS NOT OLD.progress_stage
  OR NEW.checkpoint_json IS NOT OLD.checkpoint_json
  OR NEW.spent_steps IS NOT OLD.spent_steps
  OR NEW.spent_tokens IS NOT OLD.spent_tokens
  OR NEW.spent_cost_usd IS NOT OLD.spent_cost_usd
  OR NEW.spent_wall_time_ms IS NOT OLD.spent_wall_time_ms
  OR NEW.cancellation_requested_by IS NOT OLD.cancellation_requested_by
  OR NEW.cancellation_requested_at IS NOT OLD.cancellation_requested_at
  OR NEW.lease_owner IS NOT OLD.lease_owner
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
  OR NEW.result_type IS NOT OLD.result_type
  OR NEW.result_output_fingerprint IS NOT OLD.result_output_fingerprint
  OR NEW.result_report_id IS NOT OLD.result_report_id
  OR NEW.error_code IS NOT OLD.error_code
  OR NEW.error_message IS NOT OLD.error_message
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.completed_at IS NOT OLD.completed_at
)
BEGIN
  SELECT RAISE(ABORT, 'ai job projection requires event');
END;

CREATE TRIGGER ai_jobs_identity_immutable
BEFORE UPDATE ON ai_jobs
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.kind IS OLD.kind
    AND NEW.subject_type IS OLD.subject_type
    AND NEW.logical_page_id IS OLD.logical_page_id
    AND NEW.resource_id IS OLD.resource_id
    AND NEW.collection_scope IS OLD.collection_scope
    AND NEW.selection_fingerprint IS OLD.selection_fingerprint
    AND NEW.subject_key IS OLD.subject_key
    AND NEW.requested_by IS OLD.requested_by
    AND NEW.request_method IS OLD.request_method
    AND NEW.authorization_ref IS OLD.authorization_ref
    AND NEW.idempotency_key IS OLD.idempotency_key
    AND NEW.submission_fingerprint IS OLD.submission_fingerprint
    AND NEW.input_fingerprint IS OLD.input_fingerprint
    AND NEW.ruleset_id IS OLD.ruleset_id
    AND NEW.ruleset_version IS OLD.ruleset_version
    AND NEW.assessment_method IS OLD.assessment_method
    AND NEW.assessment_model_provider IS OLD.assessment_model_provider
    AND NEW.assessment_model_name IS OLD.assessment_model_name
    AND NEW.assessment_prompt_version IS OLD.assessment_prompt_version
    AND NEW.workflow_id IS OLD.workflow_id
    AND NEW.workflow_version IS OLD.workflow_version
    AND NEW.step_batch_size IS OLD.step_batch_size
    AND NEW.scheduling_priority IS OLD.scheduling_priority
    AND NEW.max_attempts IS OLD.max_attempts
    AND NEW.max_steps IS OLD.max_steps
    AND NEW.max_tokens IS OLD.max_tokens
    AND NEW.max_cost_usd IS OLD.max_cost_usd
    AND NEW.max_wall_time_ms IS OLD.max_wall_time_ms
    AND NEW.created_at IS OLD.created_at
  ) THEN RAISE(ABORT, 'ai job identity is immutable') END;
END;

CREATE TRIGGER ai_jobs_insert_submitted_event
AFTER INSERT ON ai_jobs
BEGIN
  INSERT INTO ai_job_events (
    job_id, sequence_no, event_type, from_status, to_status, occurred_at
  ) VALUES (NEW.id, 1, 'submitted', NULL, 'queued', NEW.created_at);
END;

CREATE TRIGGER ai_jobs_validate_initial_insert
BEFORE INSERT ON ai_jobs
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'queued' AND NEW.attempts = 0 AND NEW.max_attempts = 3
    AND NEW.event_sequence = 0
    AND NEW.progress_completed = 0 AND NEW.progress_stage = 'queued'
    AND ((NEW.subject_type IN ('page', 'resource') AND NEW.progress_total = 1)
      OR (NEW.subject_type IN ('collection', 'selection')
        AND NEW.progress_total IS NULL))
    AND NEW.checkpoint_json IS NULL
    AND NEW.spent_steps = 0 AND NEW.spent_tokens = 0
    AND NEW.spent_cost_usd = 0 AND NEW.spent_wall_time_ms = 0
    AND NEW.cancellation_requested_by IS NULL
    AND NEW.cancellation_requested_at IS NULL
    AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.result_type IS NULL AND NEW.result_output_fingerprint IS NULL
    AND NEW.result_report_id IS NULL
    AND NEW.error_code IS NULL AND NEW.error_message IS NULL
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL
    AND NEW.created_at = NEW.updated_at AND NEW.available_at = NEW.created_at
  ) THEN RAISE(ABORT, 'invalid initial ai job projection') END;
END;

CREATE TRIGGER ai_job_events_immutable_update
BEFORE UPDATE ON ai_job_events
BEGIN
  SELECT RAISE(ABORT, 'ai job events are append-only');
END;

CREATE TRIGGER ai_job_events_immutable_delete
BEFORE DELETE ON ai_job_events
BEGIN
  SELECT RAISE(ABORT, 'ai job events are append-only');
END;

CREATE TRIGGER ai_job_attempts_terminal_once
BEFORE UPDATE ON ai_job_attempts
BEGIN
  SELECT CASE WHEN OLD.outcome <> 'running'
    THEN RAISE(ABORT, 'ai job attempt is terminal') END;
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.job_id IS OLD.job_id
    AND NEW.attempt_no IS OLD.attempt_no
    AND NEW.lease_token IS OLD.lease_token
    AND NEW.worker_id IS OLD.worker_id
    AND NEW.started_at IS OLD.started_at
    AND (
      (NEW.provider IS OLD.provider AND NEW.model IS OLD.model
        AND NEW.prompt_version IS OLD.prompt_version
        AND NEW.provider_bound_at IS OLD.provider_bound_at)
      OR (
        OLD.provider IS NULL AND OLD.model IS NULL AND OLD.prompt_version IS NULL
        AND NEW.provider IS NOT NULL AND NEW.model IS NOT NULL
        AND NEW.prompt_version IS NOT NULL
        AND OLD.provider_bound_at IS NULL AND NEW.provider_bound_at IS NOT NULL
        AND NEW.outcome = 'running' AND NEW.completed_at IS NULL
        AND NEW.input_tokens = OLD.input_tokens
        AND NEW.output_tokens = OLD.output_tokens
        AND NEW.cost_usd = OLD.cost_usd
        AND NEW.error_code IS OLD.error_code
        AND NEW.error_message IS OLD.error_message
      )
    )
    AND (
      (NEW.request_id IS OLD.request_id
        AND NEW.request_bound_at IS OLD.request_bound_at)
      OR (
        OLD.request_id IS NULL AND NEW.request_id IS NOT NULL
        AND OLD.request_bound_at IS NULL AND NEW.request_bound_at IS NOT NULL
        AND NEW.outcome = 'running' AND NEW.completed_at IS NULL
        AND NEW.input_tokens = OLD.input_tokens
        AND NEW.output_tokens = OLD.output_tokens
        AND NEW.cost_usd = OLD.cost_usd
        AND NEW.error_code IS OLD.error_code
        AND NEW.error_message IS OLD.error_message
      )
    )
  ) THEN RAISE(ABORT, 'invalid ai job attempt completion') END;
  SELECT CASE WHEN (
    NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model
    OR NEW.prompt_version IS NOT OLD.prompt_version
  ) AND NOT (
    OLD.provider IS NULL AND OLD.model IS NULL AND OLD.prompt_version IS NULL
    AND NEW.provider IS NOT NULL AND NEW.model IS NOT NULL
    AND NEW.prompt_version IS NOT NULL
    AND OLD.provider_bound_at IS NULL AND NEW.provider_bound_at IS NOT NULL
    AND NEW.provider_bound_at >= NEW.started_at
    AND NEW.outcome = 'running' AND NEW.completed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM ai_jobs
      WHERE id = OLD.job_id AND status = 'running'
        AND lease_token = OLD.lease_token
        AND cancellation_requested_at IS NULL
        AND NEW.provider_bound_at >= updated_at
        AND NEW.provider_bound_at < lease_expires_at
        AND (
          kind = 'resource_research'
          OR (assessment_method = 'model'
            AND assessment_model_provider = NEW.provider
            AND assessment_model_name = NEW.model
            AND assessment_prompt_version = NEW.prompt_version)
        )
    )
  ) THEN RAISE(ABORT, 'invalid ai job attempt provider binding') END;
  SELECT CASE WHEN NEW.request_id IS NOT OLD.request_id AND NOT (
    OLD.request_id IS NULL AND NEW.request_id IS NOT NULL
    AND OLD.request_bound_at IS NULL AND NEW.request_bound_at IS NOT NULL
    AND NEW.request_bound_at >= OLD.provider_bound_at
    AND OLD.provider IS NOT NULL AND OLD.model IS NOT NULL
    AND OLD.prompt_version IS NOT NULL
    AND NEW.provider IS OLD.provider AND NEW.model IS OLD.model
    AND NEW.prompt_version IS OLD.prompt_version
    AND NEW.outcome = 'running' AND NEW.completed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM ai_jobs
      WHERE id = OLD.job_id AND status = 'running'
        AND lease_token = OLD.lease_token
        AND NEW.request_bound_at >= updated_at
        AND NEW.request_bound_at < lease_expires_at
    )
  ) THEN RAISE(ABORT, 'invalid ai job attempt request binding') END;
  SELECT CASE WHEN NEW.request_id IS NOT OLD.request_id THEN NULL END;
  SELECT CASE WHEN NEW.outcome = 'running' AND NOT (
    NEW.completed_at IS NULL
    AND NEW.error_code IS OLD.error_code
    AND NEW.error_message IS OLD.error_message
    AND (NEW.request_id IS NOT OLD.request_id
      OR NEW.request_bound_at IS NOT OLD.request_bound_at
      OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model
      OR NEW.prompt_version IS NOT OLD.prompt_version
      OR NEW.provider_bound_at IS NOT OLD.provider_bound_at OR EXISTS (
      SELECT 1 FROM ai_job_events
      WHERE job_id = OLD.job_id AND attempt_id = OLD.id
        AND lease_token = OLD.lease_token AND event_type = 'progress'
        AND sequence_no = (
          SELECT event_sequence + 1 FROM ai_jobs WHERE id = OLD.job_id
        )
        AND NEW.input_tokens = spent_input_tokens - COALESCE((
          SELECT SUM(other.input_tokens)
          FROM ai_job_attempts AS other
          WHERE other.job_id = OLD.job_id AND other.id <> OLD.id
        ), 0)
        AND NEW.output_tokens = spent_output_tokens - COALESCE((
          SELECT SUM(other.output_tokens)
          FROM ai_job_attempts AS other
          WHERE other.job_id = OLD.job_id AND other.id <> OLD.id
        ), 0)
        AND NEW.cost_usd = spent_cost_usd - COALESCE((
          SELECT SUM(other.cost_usd)
          FROM ai_job_attempts AS other
          WHERE other.job_id = OLD.job_id AND other.id <> OLD.id
        ), 0)
    ))
  ) THEN RAISE(ABORT, 'ai job attempt accounting requires event') END;
  SELECT CASE WHEN NEW.outcome <> 'running' AND NOT EXISTS (
    SELECT 1 FROM ai_job_events
    WHERE job_id = OLD.job_id AND attempt_id = OLD.id
      AND lease_token = OLD.lease_token
      AND occurred_at = NEW.completed_at
      AND NEW.input_tokens = OLD.input_tokens
      AND NEW.output_tokens = OLD.output_tokens
      AND NEW.cost_usd = (
        SELECT spent_cost_usd FROM ai_jobs WHERE id = OLD.job_id
      ) - COALESCE((
        SELECT SUM(other.cost_usd)
        FROM ai_job_attempts AS other
        WHERE other.job_id = OLD.job_id AND other.id <> OLD.id
      ), 0)
      AND (
        (event_type = 'succeeded' AND NEW.outcome = 'succeeded')
        OR (event_type = 'partial' AND NEW.outcome = 'partial')
        OR (event_type = 'failed' AND (
          NEW.outcome = 'failed' AND occurred_at < (
            SELECT lease_expires_at FROM ai_jobs WHERE id = OLD.job_id
          ) OR NEW.outcome = 'interrupted' AND occurred_at >= (
            SELECT lease_expires_at FROM ai_jobs WHERE id = OLD.job_id
          )))
        OR (event_type = 'cancelled' AND (
          NEW.outcome = 'cancelled' AND occurred_at < (
            SELECT lease_expires_at FROM ai_jobs WHERE id = OLD.job_id
          ) OR NEW.outcome = 'interrupted' AND occurred_at >= (
            SELECT lease_expires_at FROM ai_jobs WHERE id = OLD.job_id
          )))
        OR (event_type = 'superseded' AND NEW.outcome = 'superseded')
        OR (event_type IN ('retry_scheduled', 'recovered')
          AND NEW.outcome = 'interrupted')
      )
  ) THEN RAISE(ABORT, 'ai job attempt completion requires event') END;
END;

CREATE TRIGGER ai_job_attempts_validate_claim
BEFORE INSERT ON ai_job_attempts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ai_jobs
    WHERE id = NEW.job_id
      AND status = 'queued'
      AND cancellation_requested_at IS NULL
      AND available_at <= NEW.started_at
      AND attempts < max_attempts
      AND NEW.attempt_no = attempts + 1
      AND NEW.started_at >= updated_at
      AND spent_steps < max_steps
      AND (max_tokens = 0 OR spent_tokens < max_tokens)
      AND (max_cost_usd = 0 OR spent_cost_usd < max_cost_usd)
      AND spent_wall_time_ms < max_wall_time_ms
  ) THEN RAISE(ABORT, 'invalid ai job attempt claim') END;
  SELECT CASE WHEN NOT (
    NEW.provider IS NULL AND NEW.model IS NULL AND NEW.prompt_version IS NULL
    AND NEW.provider_bound_at IS NULL AND NEW.request_id IS NULL
    AND NEW.request_bound_at IS NULL AND NEW.completed_at IS NULL
    AND NEW.outcome = 'running' AND NEW.input_tokens = 0
    AND NEW.output_tokens = 0 AND NEW.cost_usd = 0
    AND NEW.error_code IS NULL AND NEW.error_message IS NULL
  ) THEN RAISE(ABORT, 'invalid initial ai job attempt') END;
END;

CREATE TRIGGER ai_job_attempts_project_claim
AFTER INSERT ON ai_job_attempts
BEGIN
  INSERT INTO ai_job_events (
    job_id, sequence_no, event_type, from_status, to_status, attempt_id,
    lease_owner, lease_token, lease_expires_at, occurred_at
  ) SELECT
    NEW.job_id, event_sequence + 1, 'claimed', 'queued', 'running', NEW.id,
    NEW.worker_id, NEW.lease_token,
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at, '+60 seconds'), NEW.started_at
  FROM ai_jobs WHERE id = NEW.job_id;
END;

CREATE TRIGGER ai_job_attempts_immutable_delete
BEFORE DELETE ON ai_job_attempts
BEGIN
  SELECT RAISE(ABORT, 'ai job attempts are immutable');
END;

CREATE TRIGGER ai_job_idempotency_receipts_immutable_update
BEFORE UPDATE ON ai_job_idempotency_receipts
BEGIN
  SELECT RAISE(ABORT, 'ai job idempotency receipts are append-only');
END;

CREATE TRIGGER ai_job_idempotency_receipts_immutable_delete
BEFORE DELETE ON ai_job_idempotency_receipts
BEGIN
  SELECT RAISE(ABORT, 'ai job idempotency receipts are append-only');
END;

CREATE TRIGGER ai_job_idempotency_receipts_validate_insert
BEFORE INSERT ON ai_job_idempotency_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ai_jobs
    WHERE id = NEW.job_id AND kind = NEW.kind AND updated_at <= NEW.created_at
      AND NEW.created_at >= COALESCE((
        SELECT MAX(COALESCE(request_bound_at, provider_bound_at, started_at))
        FROM ai_job_attempts WHERE job_id = NEW.job_id
      ), NEW.created_at)
  ) THEN RAISE(ABORT, 'invalid ai job idempotency receipt') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ai_jobs
    WHERE idempotency_key = NEW.idempotency_key AND id <> NEW.job_id
  ) THEN RAISE(ABORT, 'ai job idempotency key already exists') END;
END;

CREATE TRIGGER ai_jobs_idempotency_key_global
BEFORE INSERT ON ai_jobs
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ai_job_idempotency_receipts
    WHERE idempotency_key = NEW.idempotency_key
  ) THEN RAISE(ABORT, 'ai job idempotency key already exists') END;
END;

CREATE TRIGGER ai_jobs_insert_idempotency_receipt
AFTER INSERT ON ai_jobs
BEGIN
  INSERT INTO ai_job_idempotency_receipts (
    idempotency_key, submission_fingerprint, job_id, kind, created_at
  ) VALUES (
    NEW.idempotency_key, NEW.submission_fingerprint, NEW.id, NEW.kind, NEW.created_at
  );
END;
