-- Schema 026 is installed by runPrivacyPurgeMigration.  The runner executes
-- this additive core and then installs the deterministic 65 x 3 fence matrix
-- derived from the frozen schema-25 target catalog in the same transaction.

CREATE TABLE privacy_purge_intents (
  intent_key TEXT PRIMARY KEY CHECK (
    length(intent_key) = 64 AND intent_key NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('schema26', 'legacy25')),
  idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  target_kind TEXT NOT NULL CHECK (
    target_kind IN ('run', 'logical_page', 'resource_history')
  ),
  subject_generation_id INTEGER,
  history_epoch_id INTEGER,
  logical_page_id_snapshot INTEGER,
  resource_id_snapshot INTEGER,
  root_generation_token TEXT CHECK (
    root_generation_token IS NULL OR (
      length(root_generation_token) = 64
        AND root_generation_token NOT GLOB '*[^0-9a-f]*'
    )
  ),
  history_epoch_no_snapshot INTEGER CHECK (
    history_epoch_no_snapshot IS NULL OR history_epoch_no_snapshot > 0
  ),
  run_target_count INTEGER NOT NULL CHECK (run_target_count BETWEEN 0 AND 250000),
  run_target_digest TEXT NOT NULL CHECK (
    length(run_target_digest) = 64 AND run_target_digest NOT GLOB '*[^0-9a-f]*'
  ),
  action_wait_count INTEGER NOT NULL CHECK (action_wait_count BETWEEN 0 AND 250000),
  action_wait_digest TEXT NOT NULL CHECK (
    length(action_wait_digest) = 64 AND action_wait_digest NOT GLOB '*[^0-9a-f]*'
  ),
  action_quiescence_digest TEXT NOT NULL CHECK (
    length(action_quiescence_digest) = 64
      AND action_quiescence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  job_wait_count INTEGER NOT NULL CHECK (job_wait_count BETWEEN 0 AND 250000),
  job_wait_digest TEXT NOT NULL CHECK (
    length(job_wait_digest) = 64 AND job_wait_digest NOT GLOB '*[^0-9a-f]*'
  ),
  wait_snapshot_digest TEXT NOT NULL CHECK (
    length(wait_snapshot_digest) = 64
      AND wait_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  execution_target_count INTEGER CHECK (
    execution_target_count IS NULL OR execution_target_count BETWEEN 0 AND 250000
  ),
  execution_plan_digest TEXT CHECK (
    execution_plan_digest IS NULL OR (
      length(execution_plan_digest) = 64
        AND execution_plan_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  purge_command_id INTEGER UNIQUE
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  tombstone_digest TEXT CHECK (
    tombstone_digest IS NULL OR (
      length(tombstone_digest) = 64 AND tombstone_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_digest TEXT CHECK (
    result_digest IS NULL OR (
      length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  carryover_manifest_count INTEGER CHECK (
    carryover_manifest_count IS NULL OR carryover_manifest_count >= 0
  ),
  carryover_manifest_digest TEXT CHECK (
    carryover_manifest_digest IS NULL OR (
      length(carryover_manifest_digest) = 64
        AND carryover_manifest_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  terminal_evidence_digest TEXT CHECK (
    terminal_evidence_digest IS NULL OR (
      length(terminal_evidence_digest) = 64
        AND terminal_evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN ('waiting', 'ready', 'committed', 'completed', 'failed_hold', 'failed')
  ),
  hold_code TEXT CHECK (
    hold_code IS NULL OR hold_code IN (
      'PROVIDER_USAGE_UNKNOWN', 'WAIT_SNAPSHOT_DRIFT',
      'PURGE_INVARIANT_VIOLATION'
    )
  ),
  repair_count INTEGER NOT NULL DEFAULT 0 CHECK (repair_count >= 0),
  last_repair_digest TEXT CHECK (
    last_repair_digest IS NULL OR (
      length(last_repair_digest) = 64
        AND last_repair_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_repair_at TEXT CHECK (
    last_repair_at IS NULL OR
      last_repair_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_repair_at)
  ),
  settlement_proof_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    settlement_proof_generation >= 0
  ),
  settlement_evidence_digest TEXT CHECK (
    settlement_evidence_digest IS NULL OR (
      length(settlement_evidence_digest) = 64
        AND settlement_evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  updated_at TEXT NOT NULL CHECK (
    COALESCE(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), 0)
      AND updated_at >= created_at
  ),
  CHECK (
    (origin = 'legacy25'
      AND logical_page_id_snapshot IS NULL AND resource_id_snapshot IS NULL
      AND root_generation_token IS NULL AND history_epoch_no_snapshot IS NULL)
    OR (origin = 'schema26' AND target_kind = 'logical_page'
      AND subject_generation_id IS NOT NULL
      AND history_epoch_id IS NULL AND logical_page_id_snapshot IS NOT NULL
      AND resource_id_snapshot IS NULL AND root_generation_token IS NOT NULL
      AND history_epoch_no_snapshot IS NULL)
    OR (origin = 'schema26' AND target_kind = 'run'
      AND subject_generation_id IS NOT NULL
      AND history_epoch_id IS NULL AND logical_page_id_snapshot IS NULL
      AND resource_id_snapshot IS NULL AND root_generation_token IS NOT NULL
      AND history_epoch_no_snapshot IS NULL)
    OR (origin = 'schema26' AND target_kind = 'resource_history'
      AND subject_generation_id IS NULL
      AND history_epoch_id IS NOT NULL AND logical_page_id_snapshot IS NULL
      AND resource_id_snapshot IS NOT NULL AND root_generation_token IS NULL
      AND history_epoch_no_snapshot IS NOT NULL)
  ),
  CHECK (
    (target_kind IN ('logical_page', 'run')
      AND subject_generation_id IS NOT NULL AND history_epoch_id IS NULL)
    OR (target_kind = 'resource_history'
      AND subject_generation_id IS NULL AND history_epoch_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('waiting', 'failed_hold')
      AND execution_target_count IS NULL AND execution_plan_digest IS NULL
      AND purge_command_id IS NULL AND tombstone_digest IS NULL
      AND result_digest IS NULL AND carryover_manifest_count IS NULL
      AND carryover_manifest_digest IS NULL AND terminal_evidence_digest IS NULL)
    OR (status = 'ready'
      AND execution_target_count IS NOT NULL AND execution_plan_digest IS NOT NULL
      AND purge_command_id IS NULL AND tombstone_digest IS NOT NULL
      AND result_digest IS NOT NULL AND carryover_manifest_count IS NOT NULL
      AND carryover_manifest_digest IS NOT NULL
      AND terminal_evidence_digest IS NOT NULL AND hold_code IS NULL)
    OR (status = 'committed'
      AND execution_target_count IS NOT NULL AND execution_plan_digest IS NOT NULL
      AND purge_command_id IS NOT NULL AND tombstone_digest IS NOT NULL
      AND result_digest IS NOT NULL AND carryover_manifest_count IS NOT NULL
      AND carryover_manifest_digest IS NOT NULL
      AND terminal_evidence_digest IS NOT NULL AND hold_code IS NULL)
    OR (status IN ('completed', 'failed') AND hold_code IS NULL)
  ),
  CHECK ((status = 'failed_hold') = (hold_code IS NOT NULL)),
  CHECK (
    (repair_count = 0 AND last_repair_digest IS NULL AND last_repair_at IS NULL)
    OR (repair_count > 0 AND last_repair_digest IS NOT NULL
      AND last_repair_at IS NOT NULL)
  ),
  CHECK (
    (settlement_proof_generation = 0 AND settlement_evidence_digest IS NULL)
    OR (settlement_proof_generation > 0 AND settlement_evidence_digest IS NOT NULL)
  ),
  CHECK (origin = 'schema26' OR status IN ('completed', 'failed')),
  CHECK (origin = 'legacy25' OR status <> 'failed')
) STRICT;

CREATE UNIQUE INDEX privacy_purge_intents_one_active
ON privacy_purge_intents((1))
WHERE status IN ('waiting', 'ready', 'committed', 'failed_hold');

-- Privacy purge removes the identifying ledger rows that normally enforce the
-- daily acquisition budgets.  This aggregate is the deliberately
-- non-identifying accounting handoff: rows are frozen while their source rows
-- still exist and become budget-visible only after atomic activation.
CREATE TABLE privacy_purge_budget_carryover_days (
  intent_key TEXT NOT NULL CHECK (
    length(intent_key) = 64 AND intent_key NOT GLOB '*[^0-9a-f]*'
  ),
  utc_date TEXT NOT NULL CHECK (
    length(utc_date) = 10
      AND utc_date = strftime('%Y-%m-%d', utc_date)
  ),
  budget_class TEXT NOT NULL CHECK (
    budget_class IN ('c90_coordinator', 'provider')
  ),
  job_kind TEXT NOT NULL CHECK (job_kind = 'resource_research'),
  workflow_id TEXT NOT NULL CHECK (
    length(CAST(workflow_id AS BLOB)) BETWEEN 1 AND 128
  ),
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  coordinator_starts INTEGER NOT NULL CHECK (coordinator_starts >= 0),
  provider_attempts INTEGER NOT NULL CHECK (provider_attempts >= 0),
  charged_cost_nanos INTEGER NOT NULL CHECK (charged_cost_nanos >= 0),
  active_exposure_nanos INTEGER NOT NULL CHECK (active_exposure_nanos >= 0),
  legacy25_day_block INTEGER NOT NULL CHECK (legacy25_day_block IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('frozen', 'active')),
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  frozen_at TEXT NOT NULL CHECK (
    COALESCE(frozen_at = strftime('%Y-%m-%dT%H:%M:%fZ', frozen_at), 0)
  ),
  activated_at TEXT CHECK (
    activated_at IS NULL OR (
      activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', activated_at)
        AND activated_at >= frozen_at
    )
  ),
  PRIMARY KEY (
    intent_key, utc_date, budget_class,
    job_kind, workflow_id, workflow_version
  ),
  CHECK (
    (state = 'frozen' AND activated_at IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL)
  ),
  CHECK (
    budget_class = 'c90_coordinator'
    OR coordinator_starts = 0
  ),
  CHECK (
    (budget_class = 'c90_coordinator'
      AND workflow_id = 'research_acquisition:c90:v1'
      AND workflow_version = 1)
    OR (budget_class = 'provider'
      AND NOT (
        workflow_id = 'research_acquisition:c90:v1'
        AND workflow_version = 1
      ))
  )
) STRICT;

CREATE TRIGGER privacy_purge_budget_carryover_insert_guard
BEFORE INSERT ON privacy_purge_budget_carryover_days
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NOT (
  (
    NEW.state = 'frozen' AND NEW.activated_at IS NULL
    AND NEW.legacy25_day_block = 0
    AND EXISTS (
      SELECT 1 FROM privacy_purge_intents AS intent
      WHERE intent.intent_key = NEW.intent_key
        AND intent.origin = 'schema26' AND intent.status = 'waiting'
    )
  ) OR (
    NEW.state = 'active' AND NEW.legacy25_day_block = 1
    AND NEW.frozen_at = NEW.activated_at
    AND EXISTS (
      SELECT 1
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_commands AS command
        ON command.id = intent.purge_command_id
      JOIN privacy_purge_results AS result ON result.command_id = command.id
      WHERE intent.intent_key = NEW.intent_key
        AND intent.origin = 'legacy25' AND intent.status = 'completed'
        AND command.status = 'completed' AND result.outcome = 'completed'
        AND NEW.utc_date = substr(result.completed_at, 1, 10)
        AND NEW.frozen_at = result.completed_at
        AND NEW.activated_at = result.completed_at
    )
  )
)
OR tabhub_purge26_carryover_insert_v1(
  NEW.intent_key, NEW.utc_date, NEW.budget_class, NEW.job_kind,
  NEW.workflow_id, NEW.workflow_version, NEW.coordinator_starts,
  NEW.provider_attempts, NEW.charged_cost_nanos,
  NEW.active_exposure_nanos, NEW.legacy25_day_block, NEW.state,
  NEW.payload_digest, NEW.frozen_at, NEW.activated_at
) <> 1
BEGIN
  SELECT RAISE(ABORT,
    'privacy purge budget carryover insert requires exact local capability');
END;

CREATE TRIGGER privacy_purge_budget_carryover_update_guard
BEFORE UPDATE ON privacy_purge_budget_carryover_days
WHEN NOT (
  OLD.state = 'frozen' AND OLD.activated_at IS NULL
  AND NEW.state = 'active' AND NEW.activated_at IS NOT NULL
  AND NEW.intent_key IS OLD.intent_key
  AND NEW.utc_date IS OLD.utc_date
  AND NEW.budget_class IS OLD.budget_class
  AND NEW.job_kind IS OLD.job_kind
  AND NEW.workflow_id IS OLD.workflow_id
  AND NEW.workflow_version IS OLD.workflow_version
  AND NEW.coordinator_starts IS OLD.coordinator_starts
  AND NEW.provider_attempts IS OLD.provider_attempts
  AND NEW.charged_cost_nanos IS OLD.charged_cost_nanos
  AND NEW.active_exposure_nanos IS OLD.active_exposure_nanos
  AND NEW.legacy25_day_block IS OLD.legacy25_day_block
  AND NEW.payload_digest IS OLD.payload_digest
  AND NEW.frozen_at IS OLD.frozen_at
  AND EXISTS (
    SELECT 1
    FROM privacy_purge_intents AS intent
    JOIN privacy_purge_commands AS command
      ON command.id = intent.purge_command_id
    JOIN privacy_purge_results AS result ON result.command_id = command.id
    WHERE intent.intent_key = OLD.intent_key
      AND intent.origin = 'schema26' AND intent.status = 'committed'
      AND command.status = 'completed'
      AND result.outcome = 'completed'
      AND NEW.activated_at = result.completed_at
      AND tabhub_purge_finalization_active_v1(command.id) = 1
  )
  AND tabhub_purge26_carryover_activate_v1(
    OLD.intent_key, OLD.utc_date, OLD.budget_class, OLD.job_kind,
    OLD.workflow_id, OLD.workflow_version, OLD.coordinator_starts,
    OLD.provider_attempts, OLD.charged_cost_nanos,
    OLD.active_exposure_nanos, OLD.legacy25_day_block, OLD.state,
    OLD.payload_digest, OLD.frozen_at, OLD.activated_at,
    NEW.intent_key, NEW.utc_date, NEW.budget_class, NEW.job_kind,
    NEW.workflow_id, NEW.workflow_version, NEW.coordinator_starts,
    NEW.provider_attempts, NEW.charged_cost_nanos,
    NEW.active_exposure_nanos, NEW.legacy25_day_block, NEW.state,
    NEW.payload_digest, NEW.frozen_at, NEW.activated_at
  ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge budget carryover rows are immutable');
END;

CREATE TRIGGER privacy_purge_budget_carryover_delete_guard
BEFORE DELETE ON privacy_purge_budget_carryover_days
BEGIN
  SELECT RAISE(ABORT, 'privacy purge budget carryover rows are permanent');
END;

-- Both runtime budget readers consume this single active-only projection.
-- Frozen rows remain excluded until the purge finalizer activates them.
CREATE VIEW privacy_purge_active_budget_carryover AS
SELECT utc_date, budget_class, job_kind, workflow_id, workflow_version,
  SUM(coordinator_starts) AS coordinator_starts,
  SUM(provider_attempts) AS provider_attempts,
  SUM(charged_cost_nanos) AS charged_cost_nanos,
  SUM(active_exposure_nanos) AS active_exposure_nanos,
  MAX(legacy25_day_block) AS legacy25_day_block
FROM privacy_purge_budget_carryover_days
WHERE state = 'active'
GROUP BY utc_date, budget_class, job_kind, workflow_id, workflow_version;

-- Schema 025 still owns reservation validity and the live-ledger cap.  This
-- independent guard only composes that unchanged ledger with active carryover
-- from purged history before the reservation itself becomes visible.
CREATE TRIGGER privacy_purge26_provider_reservation_rechecks_carryover_caps
BEFORE INSERT ON live_acquisition_provider_reservations
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_active_budget_carryover AS carryover
  WHERE carryover.utc_date = NEW.utc_date
    AND carryover.budget_class = 'provider'
    AND carryover.legacy25_day_block = 1
) OR (
  (
    SELECT COALESCE(SUM(counted_attempt.cost_usd), 0)
    FROM ai_job_attempts AS counted_attempt
    JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
      ON counted_adoption.attempt_id = counted_attempt.id
      AND counted_adoption.final_job_id = counted_attempt.job_id
    WHERE counted_job.kind = 'resource_research'
      AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
        AND counted_job.workflow_version IS 1)
      AND counted_attempt.provider IS NOT NULL
      AND COALESCE(
        counted_adoption.utc_date,
        substr(counted_attempt.provider_bound_at, 1, 10)
      ) = NEW.utc_date
  ) + (
    SELECT COALESCE(SUM(active_reservation.reserved_usd
      - active_reservation.consumed_usd), 0)
    FROM live_acquisition_provider_reservations AS active_reservation
    WHERE active_reservation.status = 'active'
      AND active_reservation.utc_date = NEW.utc_date
  ) + (
    SELECT COALESCE(SUM(running_job.max_cost_usd
      - running_job.spent_cost_usd), 0)
    FROM ai_jobs AS running_job
    JOIN ai_job_attempts AS running_attempt
      ON running_attempt.job_id = running_job.id
      AND running_attempt.outcome = 'running'
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS running_adoption
      ON running_adoption.attempt_id = running_attempt.id
      AND running_adoption.final_job_id = running_attempt.job_id
    WHERE running_job.kind = 'resource_research'
      AND running_job.status = 'running'
      AND NOT (running_job.workflow_id IS 'research_acquisition:c90:v1'
        AND running_job.workflow_version IS 1)
      AND NOT EXISTS (
        SELECT 1
        FROM live_acquisition_provider_reservations AS active_reservation
        WHERE active_reservation.final_job_id = running_job.id
          AND active_reservation.status = 'active'
      )
      AND (
        running_attempt.provider IS NULL
        OR COALESCE(
          running_adoption.utc_date,
          substr(running_attempt.provider_bound_at, 1, 10)
        ) = NEW.utc_date
      )
  ) + NEW.reserved_usd + (
    SELECT (TOTAL(carryover.charged_cost_nanos)
      + TOTAL(carryover.active_exposure_nanos)) / 1000000000.0
    FROM privacy_purge_active_budget_carryover AS carryover
    WHERE carryover.utc_date = NEW.utc_date
      AND carryover.budget_class = 'provider'
  )
) > 2
BEGIN
  SELECT RAISE(ABORT, 'schema26 provider reservation exceeds combined daily caps');
END;

-- Adoption does not create another attempt or another reservation.  Recheck
-- the unchanged schema-25 global ledger at the adopted UTC date and compose it
-- with active purged-history carryover before publishing the attribution row.
CREATE TRIGGER privacy_purge26_provider_reservation_adoption_rechecks_carryover_caps
BEFORE INSERT ON live_acquisition_provider_reservation_adoptions
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_active_budget_carryover AS carryover
  WHERE carryover.utc_date = NEW.utc_date
    AND carryover.budget_class = 'provider'
    AND carryover.legacy25_day_block = 1
) OR (
  (
    SELECT COUNT(*)
    FROM ai_job_attempts AS counted_attempt
    JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
      ON counted_adoption.attempt_id = counted_attempt.id
      AND counted_adoption.final_job_id = counted_attempt.job_id
    WHERE counted_job.kind = 'resource_research'
      AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
        AND counted_job.workflow_version IS 1)
      AND counted_attempt.provider IS NOT NULL
      AND COALESCE(
        counted_adoption.utc_date,
        substr(counted_attempt.provider_bound_at, 1, 10)
      ) = NEW.utc_date
  ) + (
    SELECT TOTAL(carryover.provider_attempts)
    FROM privacy_purge_active_budget_carryover AS carryover
    WHERE carryover.utc_date = NEW.utc_date
      AND carryover.budget_class = 'provider'
  )
) >= 10 OR (
  (
    SELECT COALESCE(SUM(counted_attempt.cost_usd), 0)
    FROM ai_job_attempts AS counted_attempt
    JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
      ON counted_adoption.attempt_id = counted_attempt.id
      AND counted_adoption.final_job_id = counted_attempt.job_id
    WHERE counted_job.kind = 'resource_research'
      AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
        AND counted_job.workflow_version IS 1)
      AND counted_attempt.provider IS NOT NULL
      AND COALESCE(
        counted_adoption.utc_date,
        substr(counted_attempt.provider_bound_at, 1, 10)
      ) = NEW.utc_date
  ) + (
    SELECT COALESCE(SUM(active_reservation.reserved_usd
      - active_reservation.consumed_usd), 0)
    FROM live_acquisition_provider_reservations AS active_reservation
    WHERE active_reservation.status = 'active'
      AND active_reservation.utc_date = NEW.utc_date
  ) + (
    SELECT COALESCE(SUM(running_job.max_cost_usd
      - running_job.spent_cost_usd), 0)
    FROM ai_jobs AS running_job
    JOIN ai_job_attempts AS running_attempt
      ON running_attempt.job_id = running_job.id
      AND running_attempt.outcome = 'running'
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS running_adoption
      ON running_adoption.attempt_id = running_attempt.id
      AND running_adoption.final_job_id = running_attempt.job_id
    WHERE running_job.kind = 'resource_research'
      AND running_job.status = 'running'
      AND NOT (running_job.workflow_id IS 'research_acquisition:c90:v1'
        AND running_job.workflow_version IS 1)
      AND NOT EXISTS (
        SELECT 1
        FROM live_acquisition_provider_reservations AS active_reservation
        WHERE active_reservation.final_job_id = running_job.id
          AND active_reservation.status = 'active'
      )
      AND (
        running_attempt.provider IS NULL
        OR COALESCE(
          running_adoption.utc_date,
          substr(running_attempt.provider_bound_at, 1, 10)
        ) = NEW.utc_date
      )
  ) + (
    SELECT (TOTAL(carryover.charged_cost_nanos)
      + TOTAL(carryover.active_exposure_nanos)) / 1000000000.0
    FROM privacy_purge_active_budget_carryover AS carryover
    WHERE carryover.utc_date = NEW.utc_date
      AND carryover.budget_class = 'provider'
  )
) > 2
BEGIN
  SELECT RAISE(ABORT,
    'schema26 provider reservation adoption exceeds combined daily caps');
END;

-- A schema-25 rollover moves the existing remaining reservation to a later UTC
-- day.  Compose that target-day ledger with active purged-history carryover;
-- consumption and terminal updates that keep their UTC day are unaffected.
CREATE TRIGGER privacy_purge26_provider_reservation_rollover_rechecks_carryover_caps
BEFORE UPDATE OF utc_date ON live_acquisition_provider_reservations
WHEN OLD.status = 'active' AND NEW.status = 'active'
  AND NEW.utc_date > OLD.utc_date
  AND (
    EXISTS (
      SELECT 1 FROM privacy_purge_active_budget_carryover AS carryover
      WHERE carryover.utc_date = NEW.utc_date
        AND carryover.budget_class = 'provider'
        AND carryover.legacy25_day_block = 1
    ) OR (
      (
        SELECT COALESCE(SUM(counted_attempt.cost_usd), 0)
        FROM ai_job_attempts AS counted_attempt
        JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
        LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
          ON counted_adoption.attempt_id = counted_attempt.id
          AND counted_adoption.final_job_id = counted_attempt.job_id
        WHERE counted_job.kind = 'resource_research'
          AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
            AND counted_job.workflow_version IS 1)
          AND counted_attempt.provider IS NOT NULL
          AND COALESCE(
            counted_adoption.utc_date,
            substr(counted_attempt.provider_bound_at, 1, 10)
          ) = NEW.utc_date
      ) + (
        SELECT COALESCE(SUM(active_reservation.reserved_usd
          - active_reservation.consumed_usd), 0)
        FROM live_acquisition_provider_reservations AS active_reservation
        WHERE active_reservation.status = 'active'
          AND active_reservation.utc_date = NEW.utc_date
          AND active_reservation.id <> OLD.id
      ) + (
        OLD.reserved_usd - OLD.consumed_usd
      ) + (
        SELECT COALESCE(SUM(running_job.max_cost_usd
          - running_job.spent_cost_usd), 0)
        FROM ai_jobs AS running_job
        JOIN ai_job_attempts AS running_attempt
          ON running_attempt.job_id = running_job.id
          AND running_attempt.outcome = 'running'
        LEFT JOIN live_acquisition_provider_reservation_adoptions AS running_adoption
          ON running_adoption.attempt_id = running_attempt.id
          AND running_adoption.final_job_id = running_attempt.job_id
        WHERE running_job.kind = 'resource_research'
          AND running_job.status = 'running'
          AND running_job.id <> OLD.final_job_id
          AND NOT (running_job.workflow_id IS 'research_acquisition:c90:v1'
            AND running_job.workflow_version IS 1)
          AND NOT EXISTS (
            SELECT 1
            FROM live_acquisition_provider_reservations AS active_reservation
            WHERE active_reservation.final_job_id = running_job.id
              AND active_reservation.status = 'active'
          )
          AND (
            running_attempt.provider IS NULL
            OR COALESCE(
              running_adoption.utc_date,
              substr(running_attempt.provider_bound_at, 1, 10)
            ) = NEW.utc_date
          )
      ) + (
        SELECT (TOTAL(carryover.charged_cost_nanos)
          + TOTAL(carryover.active_exposure_nanos)) / 1000000000.0
        FROM privacy_purge_active_budget_carryover AS carryover
        WHERE carryover.utc_date = NEW.utc_date
          AND carryover.budget_class = 'provider'
      )
    ) > 2
  )
BEGIN
  SELECT RAISE(ABORT,
    'schema26 provider reservation rollover exceeds combined daily caps');
END;

CREATE TRIGGER privacy_purge26_provider_bind_rechecks_carryover_caps
BEFORE UPDATE OF provider, model, prompt_version, provider_bound_at
ON ai_job_attempts
WHEN OLD.provider IS NULL AND NEW.provider IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ai_jobs AS binding_job
    WHERE binding_job.id = OLD.job_id
      AND binding_job.kind = 'resource_research'
      AND NOT (binding_job.workflow_id IS 'research_acquisition:c90:v1'
        AND binding_job.workflow_version IS 1)
  )
  AND (
    EXISTS (
      SELECT 1 FROM privacy_purge_active_budget_carryover AS carryover
      WHERE carryover.utc_date = COALESCE((
        SELECT adoption.utc_date
        FROM live_acquisition_provider_reservation_adoptions AS adoption
        WHERE adoption.attempt_id = OLD.id
          AND adoption.final_job_id = OLD.job_id
      ), substr(NEW.provider_bound_at, 1, 10))
        AND carryover.legacy25_day_block = 1
    )
    OR (
      SELECT COUNT(*) FROM ai_job_attempts AS counted_attempt
      JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
      LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
        ON counted_adoption.attempt_id = counted_attempt.id
        AND counted_adoption.final_job_id = counted_attempt.job_id
      WHERE counted_job.kind = 'resource_research'
        AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
          AND counted_job.workflow_version IS 1)
        AND counted_attempt.provider IS NOT NULL
        AND COALESCE(counted_adoption.utc_date,
          substr(counted_attempt.provider_bound_at, 1, 10)) = COALESCE((
            SELECT adoption.utc_date
            FROM live_acquisition_provider_reservation_adoptions AS adoption
            WHERE adoption.attempt_id = OLD.id
              AND adoption.final_job_id = OLD.job_id
          ), substr(NEW.provider_bound_at, 1, 10))
    ) + (
      SELECT TOTAL(carryover.provider_attempts)
      FROM privacy_purge_active_budget_carryover AS carryover
      WHERE carryover.utc_date = COALESCE((
        SELECT adoption.utc_date
        FROM live_acquisition_provider_reservation_adoptions AS adoption
        WHERE adoption.attempt_id = OLD.id
          AND adoption.final_job_id = OLD.job_id
      ), substr(NEW.provider_bound_at, 1, 10))
        AND carryover.budget_class = 'provider'
    ) >= 10
    OR (
      SELECT COALESCE(SUM(counted_attempt.cost_usd), 0)
      FROM ai_job_attempts AS counted_attempt
      JOIN ai_jobs AS counted_job ON counted_job.id = counted_attempt.job_id
      LEFT JOIN live_acquisition_provider_reservation_adoptions AS counted_adoption
        ON counted_adoption.attempt_id = counted_attempt.id
        AND counted_adoption.final_job_id = counted_attempt.job_id
      WHERE counted_job.kind = 'resource_research'
        AND NOT (counted_job.workflow_id IS 'research_acquisition:c90:v1'
          AND counted_job.workflow_version IS 1)
        AND counted_attempt.provider IS NOT NULL
        AND COALESCE(counted_adoption.utc_date,
          substr(counted_attempt.provider_bound_at, 1, 10)) = COALESCE((
            SELECT adoption.utc_date
            FROM live_acquisition_provider_reservation_adoptions AS adoption
            WHERE adoption.attempt_id = OLD.id
              AND adoption.final_job_id = OLD.job_id
          ), substr(NEW.provider_bound_at, 1, 10))
    ) + (
      SELECT COALESCE(SUM(reservation.reserved_usd - reservation.consumed_usd), 0)
      FROM live_acquisition_provider_reservations AS reservation
      WHERE reservation.status = 'active'
        AND reservation.utc_date = COALESCE((
          SELECT adoption.utc_date
          FROM live_acquisition_provider_reservation_adoptions AS adoption
          WHERE adoption.attempt_id = OLD.id
            AND adoption.final_job_id = OLD.job_id
        ), substr(NEW.provider_bound_at, 1, 10))
    ) + (
      SELECT COALESCE(SUM(running_job.max_cost_usd
        - running_job.spent_cost_usd), 0)
      FROM ai_jobs AS running_job
      JOIN ai_job_attempts AS running_attempt
        ON running_attempt.job_id = running_job.id
        AND running_attempt.outcome = 'running'
      LEFT JOIN live_acquisition_provider_reservation_adoptions AS running_adoption
        ON running_adoption.attempt_id = running_attempt.id
        AND running_adoption.final_job_id = running_attempt.job_id
      WHERE running_job.kind = 'resource_research'
        AND running_job.status = 'running'
        AND NOT (running_job.workflow_id IS 'research_acquisition:c90:v1'
          AND running_job.workflow_version IS 1)
        AND NOT EXISTS (
          SELECT 1 FROM live_acquisition_provider_reservations AS reservation
          WHERE reservation.final_job_id = running_job.id
            AND reservation.status = 'active'
        )
        AND (running_attempt.provider IS NULL OR COALESCE(
          running_adoption.utc_date,
          substr(running_attempt.provider_bound_at, 1, 10)
        ) = COALESCE((
          SELECT adoption.utc_date
          FROM live_acquisition_provider_reservation_adoptions AS adoption
          WHERE adoption.attempt_id = OLD.id
            AND adoption.final_job_id = OLD.job_id
        ), substr(NEW.provider_bound_at, 1, 10)))
    ) + (
      SELECT (TOTAL(carryover.charged_cost_nanos)
        + TOTAL(carryover.active_exposure_nanos)) / 1000000000.0
      FROM privacy_purge_active_budget_carryover AS carryover
      WHERE carryover.utc_date = COALESCE((
        SELECT adoption.utc_date
        FROM live_acquisition_provider_reservation_adoptions AS adoption
        WHERE adoption.attempt_id = OLD.id
          AND adoption.final_job_id = OLD.job_id
      ), substr(NEW.provider_bound_at, 1, 10))
        AND carryover.budget_class = 'provider'
    ) > 2
  )
BEGIN
  SELECT RAISE(ABORT, 'schema26 provider bind exceeds combined daily caps');
END;

CREATE TABLE privacy_purge_intent_run_targets (
  intent_key TEXT NOT NULL REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  subject_generation_id INTEGER NOT NULL,
  generation_token TEXT NOT NULL CHECK (
    length(generation_token) = 64 AND generation_token NOT GLOB '*[^0-9a-f]*'
  ),
  research_run_id INTEGER NOT NULL,
  ai_job_id INTEGER NOT NULL,
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  handoff_id INTEGER,
  handoff_status TEXT CHECK (
    handoff_status IS NULL OR handoff_status IN ('assembling', 'completed')
  ),
  handoff_receipt_digest TEXT CHECK (
    handoff_receipt_digest IS NULL OR (
      length(handoff_receipt_digest) = 64
        AND handoff_receipt_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  handoff_receipt_completed_at TEXT,
  membership_kind TEXT GENERATED ALWAYS AS (
    CASE
      WHEN is_root = 1 THEN 'root'
      WHEN handoff_id IS NULL THEN 'direct_history'
      ELSE 'directed_handoff'
    END
  ) STORED CHECK (
    membership_kind IN ('root', 'direct_history', 'directed_handoff')
  ),
  row_digest TEXT NOT NULL CHECK (
    length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (intent_key, ordinal),
  UNIQUE (intent_key, subject_generation_id),
  UNIQUE (intent_key, research_run_id),
  UNIQUE (intent_key, ai_job_id),
  CHECK (
    (is_root = 1 AND handoff_id IS NULL AND handoff_status IS NULL
      AND handoff_receipt_digest IS NULL
      AND handoff_receipt_completed_at IS NULL)
    OR (is_root = 0 AND handoff_id IS NULL AND handoff_status IS NULL
      AND handoff_receipt_digest IS NULL
      AND handoff_receipt_completed_at IS NULL)
    OR (is_root = 0 AND handoff_id IS NOT NULL AND handoff_status IS NOT NULL
      AND handoff_receipt_digest IS NOT NULL
      AND handoff_receipt_completed_at IS NOT NULL)
  )
) STRICT;

-- The frozen schema-25 executor creates lifecycle successors with an
-- executor-owned row id (and, for logical pages, an executor-owned random
-- token).  These additive guards prove every predictable semantic field and
-- the exact retired predecessor while a separate one-shot capability guards
-- the unpredictable INSERT primary key at the root fence.
CREATE TRIGGER privacy_purge26_logical_page_successor_provenance_guard
BEFORE INSERT ON privacy_subject_generations
WHEN NEW.subject_kind = 'logical_page'
  AND EXISTS (
    SELECT 1 FROM privacy_purge_intents AS owner
    WHERE owner.status IN ('waiting', 'ready', 'committed', 'failed_hold')
      AND owner.target_kind = 'logical_page'
      AND owner.logical_page_id_snapshot = NEW.logical_page_id
  )
  AND COALESCE((
    SELECT tabhub_purge26_lifecycle_successor_v1(
      intent.intent_key, intent.purge_command_id, 'logical_page',
      intent.subject_generation_id, intent.logical_page_id_snapshot,
      NEW.created_at
    )
    FROM privacy_purge_intents AS intent
    JOIN privacy_subject_generations AS predecessor
      ON predecessor.id = intent.subject_generation_id
    WHERE intent.status = 'committed' AND intent.target_kind = 'logical_page'
      AND intent.purge_command_id IS NOT NULL
      AND intent.logical_page_id_snapshot = NEW.logical_page_id
      AND tabhub_purge_finalization_active_v1(intent.purge_command_id) = 1
      AND predecessor.subject_kind = 'logical_page'
      AND predecessor.logical_page_id = intent.logical_page_id_snapshot
      AND predecessor.is_active = 0
      AND predecessor.retired_at = NEW.created_at
      AND NEW.id <> predecessor.id
      AND NEW.resource_id IS NULL AND NEW.research_run_id IS NULL
      AND NEW.is_active = 1 AND NEW.retired_at IS NULL
    LIMIT 1
  ), 0) <> 1
BEGIN
  SELECT RAISE(ABORT,
    'schema26 logical-page successor requires exact lifecycle provenance');
END;

CREATE TRIGGER privacy_purge26_history_successor_provenance_guard
BEFORE INSERT ON research_history_epochs
WHEN EXISTS (
    SELECT 1 FROM privacy_purge_intents AS owner
    WHERE owner.status IN ('waiting', 'ready', 'committed', 'failed_hold')
      AND owner.target_kind = 'resource_history'
      AND owner.resource_id_snapshot = NEW.resource_id
  )
  AND COALESCE((
    SELECT tabhub_purge26_lifecycle_successor_v1(
      intent.intent_key, intent.purge_command_id, 'resource_history',
      intent.history_epoch_id, intent.resource_id_snapshot,
      predecessor.resource_generation_id, intent.history_epoch_no_snapshot,
      NEW.epoch_no, NEW.created_at
    )
    FROM privacy_purge_intents AS intent
    JOIN research_history_epochs AS predecessor
      ON predecessor.id = intent.history_epoch_id
    WHERE intent.status = 'committed'
      AND intent.target_kind = 'resource_history'
      AND intent.purge_command_id IS NOT NULL
      AND intent.resource_id_snapshot = NEW.resource_id
      AND tabhub_purge_finalization_active_v1(intent.purge_command_id) = 1
      AND predecessor.resource_id = intent.resource_id_snapshot
      AND predecessor.epoch_no = intent.history_epoch_no_snapshot
      AND predecessor.is_active = 0
      AND predecessor.retired_at = NEW.created_at
      AND NEW.id <> predecessor.id
      AND NEW.resource_generation_id = predecessor.resource_generation_id
      AND NEW.epoch_no = predecessor.epoch_no + 1
      AND NEW.is_active = 1 AND NEW.retired_at IS NULL
    LIMIT 1
  ), 0) <> 1
BEGIN
  SELECT RAISE(ABORT,
    'schema26 history successor requires exact lifecycle provenance');
END;

CREATE TABLE privacy_purge_intent_action_waits (
  intent_key TEXT NOT NULL REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  action_id INTEGER NOT NULL,
  consent_id INTEGER NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('page', 'robots')),
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'resolution_started', 'resolved', 'authorized', 'started')
  ),
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  action_key_digest TEXT NOT NULL CHECK (
    length(action_key_digest) = 64 AND action_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  resolution_start_sequence_no INTEGER CHECK (
    resolution_start_sequence_no IS NULL OR resolution_start_sequence_no > 0
  ),
  resolution_start_event_digest TEXT CHECK (
    resolution_start_event_digest IS NULL OR (
      length(resolution_start_event_digest) = 64
        AND resolution_start_event_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  resolution_started_at TEXT CHECK (
    resolution_started_at IS NULL OR resolution_started_at =
      strftime('%Y-%m-%dT%H:%M:%fZ', resolution_started_at)
  ),
  resolution_deadline_at TEXT CHECK (
    resolution_deadline_at IS NULL OR resolution_deadline_at =
      strftime('%Y-%m-%dT%H:%M:%fZ', resolution_deadline_at)
  ),
  deadline_at TEXT,
  quiescence_snapshot_digest TEXT NOT NULL CHECK (
    length(quiescence_snapshot_digest) = 64
      AND quiescence_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  row_digest TEXT NOT NULL CHECK (
    length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_state TEXT CHECK (
    terminal_state IS NULL OR terminal_state IN ('completed', 'blocked', 'ambiguous')
  ),
  terminal_sequence_no INTEGER CHECK (
    terminal_sequence_no IS NULL OR terminal_sequence_no > sequence_no
  ),
  terminal_event_digest TEXT CHECK (
    terminal_event_digest IS NULL OR length(terminal_event_digest) = 64
  ),
  terminal_proof_digest TEXT CHECK (
    terminal_proof_digest IS NULL OR length(terminal_proof_digest) = 64
  ),
  terminal_at TEXT,
  PRIMARY KEY (intent_key, ordinal),
  UNIQUE (intent_key, action_id),
  CHECK (
    (terminal_state IS NULL AND terminal_sequence_no IS NULL
      AND terminal_event_digest IS NULL AND terminal_proof_digest IS NULL
      AND terminal_at IS NULL)
    OR (terminal_state IS NOT NULL AND terminal_sequence_no IS NOT NULL
      AND terminal_event_digest IS NOT NULL AND terminal_proof_digest IS NOT NULL
      AND terminal_at IS NOT NULL)
  )
  ,CHECK (
    (state = 'resolution_started'
      AND resolution_start_sequence_no = sequence_no
      AND resolution_start_event_digest IS NOT NULL
      AND resolution_started_at IS NOT NULL
      AND resolution_deadline_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ', resolution_started_at, '+3 seconds'
      ))
    OR (state <> 'resolution_started'
      AND resolution_start_sequence_no IS NULL
      AND resolution_start_event_digest IS NULL
      AND resolution_started_at IS NULL
      AND resolution_deadline_at IS NULL)
  )
) STRICT;

CREATE TABLE privacy_purge_intent_job_waits (
  intent_key TEXT NOT NULL REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  job_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running')),
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
  cancellation_requested_by TEXT NOT NULL CHECK (
    cancellation_requested_by IN ('user', 'agent')
  ),
  cancellation_requested_at TEXT NOT NULL CHECK (
    cancellation_requested_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', cancellation_requested_at
    )
  ),
  cancellation_snapshot_digest TEXT NOT NULL CHECK (
    length(cancellation_snapshot_digest) = 64
      AND cancellation_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  attempt_id INTEGER,
  attempt_no INTEGER,
  worker_id TEXT,
  lease_token_digest TEXT,
  lease_expires_at TEXT,
  request_bound INTEGER NOT NULL CHECK (request_bound IN (0, 1)),
  request_id_digest TEXT,
  request_bound_at TEXT,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  pricing_version TEXT,
  provider_adoption_utc_date TEXT,
  provider_adopted_at TEXT,
  provider_reservation_id INTEGER,
  provider_reservation_utc_date TEXT,
  provider_reserved_usd REAL,
  provider_consumed_usd REAL,
  provider_reservation_status TEXT,
  settlement_deadline_at TEXT,
  provider_usage_state TEXT NOT NULL CHECK (
    provider_usage_state IN ('none', 'known', 'pending')
  ),
  row_digest TEXT NOT NULL CHECK (
    length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_status TEXT CHECK (
    terminal_status IS NULL OR terminal_status IN (
      'succeeded', 'partial', 'failed', 'cancelled', 'superseded'
    )
  ),
  terminal_event_sequence INTEGER CHECK (
    terminal_event_sequence IS NULL OR terminal_event_sequence > event_sequence
  ),
  terminal_attempt_outcome TEXT CHECK (
    terminal_attempt_outcome IS NULL OR terminal_attempt_outcome IN (
      'succeeded', 'partial', 'failed', 'cancelled', 'interrupted', 'superseded'
    )
  ),
  terminal_usage_digest TEXT CHECK (
    terminal_usage_digest IS NULL OR length(terminal_usage_digest) = 64
  ),
  terminal_proof_digest TEXT CHECK (
    terminal_proof_digest IS NULL OR length(terminal_proof_digest) = 64
  ),
  terminal_reservation_state TEXT CHECK (
    terminal_reservation_state IS NULL OR
      terminal_reservation_state IN ('none', 'released', 'consumed')
  ),
  terminal_at TEXT,
  PRIMARY KEY (intent_key, ordinal),
  UNIQUE (intent_key, job_id),
  CHECK (status = 'running'),
  CHECK ((attempt_id IS NULL) = (attempt_no IS NULL)),
  CHECK ((attempt_id IS NULL) = (worker_id IS NULL)),
  CHECK (lease_token_digest IS NULL OR length(lease_token_digest) = 64),
  CHECK ((request_bound = 0) = (request_id_digest IS NULL)),
  CHECK ((request_bound = 0) = (request_bound_at IS NULL)),
  CHECK (
    (provider_adoption_utc_date IS NULL) = (provider_adopted_at IS NULL)
  ),
  CHECK (
    (provider_reservation_id IS NULL
      AND provider_reservation_utc_date IS NULL
      AND provider_reserved_usd IS NULL AND provider_consumed_usd IS NULL
      AND provider_reservation_status IS NULL)
    OR (provider_reservation_id IS NOT NULL
      AND provider_reservation_utc_date IS NOT NULL
      AND provider_reserved_usd IS NOT NULL AND provider_consumed_usd IS NOT NULL
      AND provider_reservation_status IS NOT NULL)
  ),
  CHECK (
    (request_bound = 0 AND settlement_deadline_at IS NULL
      AND provider_usage_state IN ('none', 'known'))
    OR (request_bound = 1 AND settlement_deadline_at IS NOT NULL
      AND provider_usage_state = 'pending')
  ),
  CHECK (
    (terminal_status IS NULL AND terminal_event_sequence IS NULL
      AND terminal_attempt_outcome IS NULL AND terminal_usage_digest IS NULL
      AND terminal_proof_digest IS NULL AND terminal_reservation_state IS NULL
      AND terminal_at IS NULL)
    OR (terminal_status IS NOT NULL AND terminal_event_sequence IS NOT NULL
      AND terminal_usage_digest IS NOT NULL
      AND terminal_proof_digest IS NOT NULL
      AND terminal_reservation_state IS NOT NULL AND terminal_at IS NOT NULL)
  )
) STRICT;

-- A permanent, non-identifying proof that the provider request represented by
-- an immutable wait snapshot is irreversibly final with authoritative usage.
-- The private request/job/provider identity remains only in the deletable wait
-- row; the permanent evidence is bound to that row solely by its digest.
CREATE TABLE privacy_purge_intent_final_settlements (
  intent_key TEXT NOT NULL REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  job_wait_ordinal INTEGER NOT NULL CHECK (job_wait_ordinal >= 0),
  proof_generation INTEGER NOT NULL CHECK (proof_generation > 0),
  wait_row_digest TEXT NOT NULL CHECK (
    length(wait_row_digest) = 64
      AND wait_row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_kind TEXT NOT NULL CHECK (
    evidence_kind IN (
      'provider_request_final_additional_usage_zero:v1',
      'provider_request_final_usage_positive:v1'
    )
  ),
  verifier_version TEXT NOT NULL CHECK (
    verifier_version IN ('provider_final_zero:v1', 'provider_final_usage:v1')
  ),
  final_cost_nanos INTEGER NOT NULL CHECK (final_cost_nanos >= 0),
  provider_final_at TEXT NOT NULL CHECK (
    provider_final_at = strftime('%Y-%m-%dT%H:%M:%fZ', provider_final_at)
  ),
  recorded_at TEXT NOT NULL CHECK (
    recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at)
      AND recorded_at >= provider_final_at
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (evidence_kind = 'provider_request_final_additional_usage_zero:v1'
      AND verifier_version = 'provider_final_zero:v1'
      AND final_cost_nanos = 0)
    OR (evidence_kind = 'provider_request_final_usage_positive:v1'
      AND verifier_version = 'provider_final_usage:v1'
      AND final_cost_nanos > 0)
  ),
  PRIMARY KEY (intent_key, job_wait_ordinal, proof_generation)
) STRICT;

CREATE TRIGGER privacy_purge_final_settlements_insert_guard
BEFORE INSERT ON privacy_purge_intent_final_settlements
WHEN NOT EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  JOIN privacy_purge_intent_job_waits AS wait
    ON wait.intent_key = intent.intent_key
   AND wait.ordinal = NEW.job_wait_ordinal
  WHERE intent.intent_key = NEW.intent_key
    AND intent.status = 'failed_hold'
    AND intent.hold_code = 'PROVIDER_USAGE_UNKNOWN'
    AND NEW.proof_generation = intent.settlement_proof_generation + 1
    AND wait.request_bound = 1
    AND wait.provider_usage_state = 'pending'
    AND wait.terminal_status IS NULL
    AND wait.row_digest = NEW.wait_row_digest
    AND NEW.evidence_digest = tabhub_sha256_v1(json_object(
      'version', 'tabhub:privacy-purge:settlement-final:v1',
      'intentKey', NEW.intent_key,
      'jobWaitOrdinal', NEW.job_wait_ordinal,
      'proofGeneration', NEW.proof_generation,
      'waitRowDigest', NEW.wait_row_digest,
      'evidenceKind', NEW.evidence_kind,
      'verifierVersion', NEW.verifier_version,
      'finalCostNanos', NEW.final_cost_nanos,
      'providerFinalAt', NEW.provider_final_at,
      'recordedAt', NEW.recorded_at
    ))
    AND tabhub_purge26_settlement_final_v1(
      NEW.intent_key, NEW.job_wait_ordinal, NEW.proof_generation,
      NEW.wait_row_digest, NEW.evidence_kind, NEW.verifier_version,
      NEW.final_cost_nanos, NEW.provider_final_at, NEW.recorded_at,
      NEW.evidence_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge final settlement evidence');
END;

CREATE TRIGGER privacy_purge_final_settlements_no_update
BEFORE UPDATE ON privacy_purge_intent_final_settlements
BEGIN
  SELECT RAISE(ABORT, 'privacy purge settlement evidence is immutable');
END;

CREATE TRIGGER privacy_purge_final_settlements_no_delete
BEFORE DELETE ON privacy_purge_intent_final_settlements
BEGIN
  SELECT RAISE(ABORT, 'privacy purge settlement evidence is permanent');
END;

-- Once FINAL ZERO has been accepted, the covered private source projection is
-- inert.  These reject-only guards close the old waiting paths (including a
-- forged backdated progress event) without changing the frozen fence generator.
CREATE TRIGGER privacy_purge_final_settlement_blocks_job_events
BEFORE INSERT ON ai_job_events
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_intent_job_waits AS wait
  JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
  JOIN privacy_purge_intent_final_settlements AS evidence
    ON evidence.intent_key = wait.intent_key
   AND evidence.job_wait_ordinal = wait.ordinal
   AND evidence.proof_generation = intent.settlement_proof_generation
   AND evidence.wait_row_digest = wait.row_digest
  WHERE wait.job_id = NEW.job_id AND intent.status IN ('waiting', 'ready', 'committed')
)
BEGIN
  SELECT RAISE(ABORT, 'final zero settlement source is immutable');
END;

CREATE TRIGGER privacy_purge_final_settlement_blocks_jobs
BEFORE UPDATE ON ai_jobs
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_intent_job_waits AS wait
  JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
  JOIN privacy_purge_intent_final_settlements AS evidence
    ON evidence.intent_key = wait.intent_key
   AND evidence.job_wait_ordinal = wait.ordinal
   AND evidence.proof_generation = intent.settlement_proof_generation
   AND evidence.wait_row_digest = wait.row_digest
  WHERE wait.job_id = OLD.id AND intent.status IN ('waiting', 'ready', 'committed')
)
BEGIN
  SELECT RAISE(ABORT, 'final zero settlement source is immutable');
END;

CREATE TRIGGER privacy_purge_final_settlement_blocks_attempts
BEFORE UPDATE ON ai_job_attempts
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_intent_job_waits AS wait
  JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
  JOIN privacy_purge_intent_final_settlements AS evidence
    ON evidence.intent_key = wait.intent_key
   AND evidence.job_wait_ordinal = wait.ordinal
   AND evidence.proof_generation = intent.settlement_proof_generation
   AND evidence.wait_row_digest = wait.row_digest
  WHERE wait.attempt_id = OLD.id AND intent.status IN ('waiting', 'ready', 'committed')
)
BEGIN
  SELECT RAISE(ABORT, 'final zero settlement source is immutable');
END;

CREATE TRIGGER privacy_purge_final_settlement_blocks_reservations
BEFORE UPDATE ON live_acquisition_provider_reservations
WHEN EXISTS (
  SELECT 1 FROM privacy_purge_intent_job_waits AS wait
  JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
  JOIN privacy_purge_intent_final_settlements AS evidence
    ON evidence.intent_key = wait.intent_key
   AND evidence.job_wait_ordinal = wait.ordinal
   AND evidence.proof_generation = intent.settlement_proof_generation
   AND evidence.wait_row_digest = wait.row_digest
  WHERE wait.provider_reservation_id = OLD.id
    AND intent.status IN ('waiting', 'ready', 'committed')
)
BEGIN
  SELECT RAISE(ABORT, 'final zero settlement source is immutable');
END;

CREATE TRIGGER privacy_purge_final_settlement_blocks_run_events
BEFORE INSERT ON research_run_events
WHEN EXISTS (
  SELECT 1 FROM research_runs AS run
  JOIN privacy_purge_intent_job_waits AS wait ON wait.job_id = run.job_id
  JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
  JOIN privacy_purge_intent_final_settlements AS evidence
    ON evidence.intent_key = wait.intent_key
   AND evidence.job_wait_ordinal = wait.ordinal
   AND evidence.proof_generation = intent.settlement_proof_generation
   AND evidence.wait_row_digest = wait.row_digest
  WHERE run.id = NEW.run_id AND intent.status IN ('waiting', 'ready', 'committed')
)
BEGIN
  SELECT RAISE(ABORT, 'final zero settlement source is immutable');
END;

CREATE TABLE privacy_purge_intent_execution_targets (
  intent_key TEXT NOT NULL REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  table_name TEXT NOT NULL CHECK (
    length(CAST(table_name AS BLOB)) BETWEEN 1 AND 128
  ),
  pk_v1 TEXT NOT NULL CHECK (
    length(CAST(pk_v1 AS BLOB)) BETWEEN 10 AND 2048
      AND substr(pk_v1, 1, 6) = 'pk:v1|'
  ),
  delete_rank INTEGER NOT NULL CHECK (delete_rank >= 0),
  live_action_depth INTEGER CHECK (
    live_action_depth IS NULL OR live_action_depth BETWEEN 0 AND 3
  ),
  row_digest TEXT NOT NULL CHECK (
    length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (intent_key, ordinal),
  UNIQUE (intent_key, table_name, pk_v1)
) STRICT;

CREATE TABLE privacy_purge_intent_receipts (
  intent_key TEXT PRIMARY KEY REFERENCES privacy_purge_intents(intent_key)
    ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  origin TEXT NOT NULL CHECK (origin IN ('schema26', 'legacy25')),
  purge_command_id INTEGER NOT NULL UNIQUE
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  safe_counts_json TEXT NOT NULL CHECK (
    json_valid(safe_counts_json) AND json_type(safe_counts_json) = 'object'
      AND length(CAST(safe_counts_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  execution_target_count INTEGER NOT NULL CHECK (
    execution_target_count BETWEEN 0 AND 250000
  ),
  execution_plan_digest TEXT NOT NULL CHECK (
    length(execution_plan_digest) = 64
      AND execution_plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  wait_terminal_digest TEXT NOT NULL CHECK (
    length(wait_terminal_digest) = 64
      AND wait_terminal_digest NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at TEXT NOT NULL CHECK (
    COALESCE(completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at), 0)
  ),
  CHECK (origin = 'legacy25' OR outcome = 'completed')
) STRICT;

CREATE TABLE privacy_purge_mutation_fence_catalog (
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  owner_group TEXT NOT NULL,
  old_owner_predicate_digest TEXT NOT NULL CHECK (
    length(old_owner_predicate_digest) = 64
  ),
  new_owner_predicate_digest TEXT NOT NULL CHECK (
    length(new_owner_predicate_digest) = 64
  ),
  exception_class TEXT NOT NULL CHECK (
    exception_class IN ('none', 'drain', 'executor_delete')
  ),
  trigger_name TEXT NOT NULL UNIQUE,
  trigger_sql_digest TEXT NOT NULL UNIQUE CHECK (length(trigger_sql_digest) = 64),
  PRIMARY KEY (table_name, operation)
) STRICT;

CREATE TRIGGER privacy_purge_intents_insert_guard
AFTER INSERT ON privacy_purge_intents
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NOT (
  tabhub_purge26_transition_v1(
    NEW.intent_key, '', NEW.status, NEW.wait_snapshot_digest
  ) = 1
  AND (
    (NEW.origin = 'legacy25' AND NEW.status IN ('completed', 'failed')
      AND NEW.purge_command_id IS NOT NULL
      AND NEW.run_target_count = 0 AND NEW.action_wait_count = 0
      AND NEW.job_wait_count = 0
      AND NEW.run_target_digest = tabhub_sha256_v1('[]')
      AND NEW.action_wait_digest = tabhub_sha256_v1('[]')
      AND NEW.action_quiescence_digest = tabhub_sha256_v1('[]')
      AND NEW.job_wait_digest = tabhub_sha256_v1('[]')
      AND NEW.wait_snapshot_digest = tabhub_sha256_v1(json_object(
        'origin', 'legacy25', 'purgeCommandId', NEW.purge_command_id,
        'idempotencyKeyHash', NEW.idempotency_key_hash,
        'requestFingerprint', NEW.request_fingerprint,
        'targetKind', NEW.target_kind,
        'subjectGenerationId', NEW.subject_generation_id,
        'historyEpochId', NEW.history_epoch_id,
        'executionTargetCount', NEW.execution_target_count,
        'executionPlanDigest', NEW.execution_plan_digest,
        'outcome', NEW.status, 'resultDigest', NEW.result_digest,
        'createdAt', NEW.created_at, 'completedAt', NEW.updated_at
      ))
      AND EXISTS (
        SELECT 1
        FROM privacy_purge_commands AS command
        JOIN privacy_purge_results AS result ON result.command_id = command.id
        WHERE command.id = NEW.purge_command_id
          AND command.idempotency_key_hash = NEW.idempotency_key_hash
          AND command.request_fingerprint = NEW.request_fingerprint
          AND command.target_kind = NEW.target_kind
          AND command.subject_generation_id IS NEW.subject_generation_id
          AND command.history_epoch_id IS NEW.history_epoch_id
          AND command.deletion_target_count = NEW.execution_target_count
          AND command.deletion_plan_digest = NEW.execution_plan_digest
          AND command.status = NEW.status AND result.outcome = NEW.status
          AND result.result_digest = NEW.result_digest
          AND command.created_at = NEW.created_at
          AND result.completed_at = NEW.updated_at
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_authorities AS authority
            WHERE authority.command_id = command.id
          )
          AND ((NEW.status = 'failed' AND NEW.tombstone_digest IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM privacy_subject_tombstones AS tombstone
                WHERE tombstone.purge_command_id = command.id
              ))
            OR (NEW.status = 'completed' AND NEW.tombstone_digest IS NOT NULL
              AND NEW.tombstone_digest = (
                SELECT tombstone.tombstone_digest
                FROM privacy_subject_tombstones AS tombstone
                WHERE tombstone.purge_command_id = command.id
                ORDER BY tombstone.id LIMIT 1
              )))
      ))
    OR (
      NEW.origin = 'schema26' AND NEW.status = 'waiting'
      AND (SELECT COUNT(*) FROM privacy_purge_intent_run_targets
        WHERE intent_key = NEW.intent_key) = NEW.run_target_count
      AND (SELECT COUNT(*) FROM privacy_purge_intent_action_waits
        WHERE intent_key = NEW.intent_key) = NEW.action_wait_count
      AND (SELECT COUNT(*) FROM privacy_purge_intent_job_waits
        WHERE intent_key = NEW.intent_key) = NEW.job_wait_count
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_run_targets
        WHERE intent_key = NEW.intent_key
          AND ordinal NOT BETWEEN 0 AND NEW.run_target_count - 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_action_waits
        WHERE intent_key = NEW.intent_key
          AND ordinal NOT BETWEEN 0 AND NEW.action_wait_count - 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_job_waits
        WHERE intent_key = NEW.intent_key
          AND ordinal NOT BETWEEN 0 AND NEW.job_wait_count - 1
      )
      AND tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(row_digest) FROM (
          SELECT row_digest FROM privacy_purge_intent_run_targets
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]')) = NEW.run_target_digest
      AND tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(row_digest) FROM (
          SELECT row_digest FROM privacy_purge_intent_action_waits
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]')) = NEW.action_wait_digest
      AND tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(quiescence_snapshot_digest) FROM (
          SELECT quiescence_snapshot_digest
          FROM privacy_purge_intent_action_waits
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]')) = NEW.action_quiescence_digest
      AND tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(row_digest) FROM (
          SELECT row_digest FROM privacy_purge_intent_job_waits
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]')) = NEW.job_wait_digest
      AND NEW.wait_snapshot_digest = tabhub_sha256_v1(json_object(
        'intentKey', NEW.intent_key,
        'idempotencyKeyHash', NEW.idempotency_key_hash,
        'requestFingerprint', NEW.request_fingerprint,
        'targetKind', NEW.target_kind,
        'subjectGenerationId', NEW.subject_generation_id,
        'historyEpochId', NEW.history_epoch_id,
        'logicalPageIdSnapshot', NEW.logical_page_id_snapshot,
        'resourceIdSnapshot', NEW.resource_id_snapshot,
        'rootGenerationToken', NEW.root_generation_token,
        'historyEpochNoSnapshot', NEW.history_epoch_no_snapshot,
        'runTargetCount', NEW.run_target_count,
        'runTargetDigest', NEW.run_target_digest,
        'actionWaitCount', NEW.action_wait_count,
        'actionWaitDigest', NEW.action_wait_digest,
        'actionQuiescenceDigest', NEW.action_quiescence_digest,
        'jobWaitCount', NEW.job_wait_count,
        'jobWaitDigest', NEW.job_wait_digest
      ))
      AND (
        (NEW.target_kind = 'logical_page' AND EXISTS (
          SELECT 1 FROM privacy_subject_generations AS generation
          WHERE generation.id = NEW.subject_generation_id
            AND generation.subject_kind = 'logical_page'
            AND generation.logical_page_id = NEW.logical_page_id_snapshot
            AND generation.generation_token = NEW.root_generation_token
            AND generation.is_active = 1
        ) AND NEW.run_target_count = 0)
        OR (NEW.target_kind = 'run' AND EXISTS (
          SELECT 1 FROM privacy_purge_intent_run_targets AS target
          JOIN privacy_subject_generations AS generation
            ON generation.id = target.subject_generation_id
          JOIN research_runs AS run ON run.id = target.research_run_id
          WHERE target.intent_key = NEW.intent_key AND target.is_root = 1
            AND target.subject_generation_id = NEW.subject_generation_id
            AND target.generation_token = NEW.root_generation_token
            AND generation.subject_kind = 'research_run'
            AND generation.generation_token = target.generation_token
            AND generation.research_run_id = target.research_run_id
            AND generation.is_active = 1 AND run.job_id = target.ai_job_id
        ) AND (SELECT COUNT(*) FROM privacy_purge_intent_run_targets
          WHERE intent_key = NEW.intent_key AND is_root = 1) = 1
          AND NEW.run_target_count BETWEEN 1 AND 2
          AND (SELECT COUNT(*) FROM live_acquisition_handoffs AS handoff
            WHERE handoff.coordinator_run_generation_id = NEW.subject_generation_id
              AND handoff.status IN ('assembling', 'completed')) BETWEEN 0 AND 1
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_run_targets AS extra
            WHERE extra.intent_key = NEW.intent_key AND extra.is_root = 0
              AND NOT EXISTS (
                SELECT 1 FROM live_acquisition_handoffs AS handoff
                JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
                WHERE handoff.coordinator_run_generation_id
                    = NEW.subject_generation_id
                  AND handoff.status IN ('assembling', 'completed')
                  AND final_run.id = extra.research_run_id
                  AND final_run.job_id = extra.ai_job_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM live_acquisition_handoffs AS handoff
            JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
            JOIN privacy_subject_generations AS final_generation
              ON final_generation.subject_kind = 'research_run'
              AND final_generation.research_run_id = final_run.id
              AND final_generation.is_active = 1
            WHERE handoff.coordinator_run_generation_id
                = NEW.subject_generation_id
              AND handoff.status IN ('assembling', 'completed')
              AND NOT EXISTS (
                SELECT 1 FROM privacy_purge_intent_run_targets AS expected
                WHERE expected.intent_key = NEW.intent_key AND expected.is_root = 0
                  AND expected.subject_generation_id = final_generation.id
                  AND expected.generation_token = final_generation.generation_token
                  AND expected.research_run_id = final_run.id
                  AND expected.ai_job_id = final_run.job_id
              )
          ))
        OR (NEW.target_kind = 'resource_history' AND EXISTS (
          SELECT 1 FROM research_history_epochs AS history
          WHERE history.id = NEW.history_epoch_id AND history.is_active = 1
            AND history.resource_id = NEW.resource_id_snapshot
            AND history.epoch_no = NEW.history_epoch_no_snapshot
        )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_run_targets AS extra
            JOIN research_runs AS run ON run.id = extra.research_run_id
            WHERE extra.intent_key = NEW.intent_key
              AND (extra.is_root <> 0 OR run.history_epoch_id <> NEW.history_epoch_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM research_runs AS run
            JOIN privacy_subject_generations AS generation
              ON generation.subject_kind = 'research_run'
              AND generation.research_run_id = run.id
              AND generation.is_active = 1
            WHERE run.history_epoch_id = NEW.history_epoch_id
              AND NOT EXISTS (
                SELECT 1 FROM privacy_purge_intent_run_targets AS expected
                WHERE expected.intent_key = NEW.intent_key
                  AND expected.subject_generation_id = generation.id
                  AND expected.generation_token = generation.generation_token
                  AND expected.research_run_id = run.id
                  AND expected.ai_job_id = run.job_id AND expected.is_root = 0
              )
          ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_run_targets AS target
        LEFT JOIN privacy_subject_generations AS generation
          ON generation.id = target.subject_generation_id
        LEFT JOIN research_runs AS run ON run.id = target.research_run_id
        WHERE target.intent_key = NEW.intent_key AND (
          generation.id IS NULL OR generation.subject_kind <> 'research_run'
          OR generation.generation_token <> target.generation_token
          OR generation.research_run_id <> target.research_run_id
          OR generation.is_active <> 1 OR run.job_id <> target.ai_job_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM privacy_purge_intent_action_waits AS wait
        LEFT JOIN live_acquisition_actions AS action ON action.id = wait.action_id
        LEFT JOIN live_acquisition_consents AS consent ON consent.id = wait.consent_id
        WHERE wait.intent_key = NEW.intent_key AND (
          action.id IS NULL OR consent.id IS NULL
          OR action.consent_id <> wait.consent_id
          OR action.action_kind <> wait.action_kind
          OR action.state <> wait.state OR action.sequence_no <> wait.sequence_no
          OR action.runtime_epoch <> wait.runtime_epoch
          OR action.action_key_digest <> wait.action_key_digest
          OR consent.expires_at IS NOT wait.deadline_at
          OR action.state IN ('completed', 'blocked', 'ambiguous')
          OR consent.coordinator_run_generation_id
            <> action.coordinator_run_generation_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM privacy_purge_intent_job_waits AS wait
        LEFT JOIN ai_jobs AS job ON job.id = wait.job_id
        LEFT JOIN ai_job_attempts AS attempt ON attempt.id = wait.attempt_id
        LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
          ON adoption.attempt_id = wait.attempt_id
          AND adoption.final_job_id = wait.job_id
        LEFT JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.id = wait.provider_reservation_id
        WHERE wait.intent_key = NEW.intent_key AND (
          job.id IS NULL OR job.status <> wait.status
          OR job.status NOT IN ('queued', 'running')
          OR job.event_sequence <> wait.event_sequence
          OR job.cancellation_requested_by IS NOT wait.cancellation_requested_by
          OR job.cancellation_requested_at IS NOT wait.cancellation_requested_at
          OR wait.cancellation_snapshot_digest <> tabhub_sha256_v1(json_object(
            'intentKey', wait.intent_key, 'jobId', wait.job_id,
            'eventSequence', wait.event_sequence,
            'cancellationRequestedBy', wait.cancellation_requested_by,
            'cancellationRequestedAt', wait.cancellation_requested_at
          ))
          OR job.lease_expires_at IS NOT wait.lease_expires_at
          OR (wait.lease_token_digest IS NOT NULL AND
            wait.lease_token_digest <> tabhub_sha256_v1(job.lease_token))
          OR (wait.lease_token_digest IS NULL) <> (job.lease_token IS NULL)
          OR (wait.attempt_id IS NULL) <> (attempt.id IS NULL)
          OR (attempt.id IS NOT NULL AND (
            attempt.job_id <> wait.job_id OR attempt.attempt_no <> wait.attempt_no
            OR attempt.worker_id <> wait.worker_id
            OR tabhub_sha256_v1(attempt.lease_token) <> wait.lease_token_digest
            OR (attempt.request_bound_at IS NOT NULL) <> wait.request_bound
            OR (attempt.request_id IS NULL) <> (wait.request_id_digest IS NULL)
            OR (attempt.request_id IS NOT NULL
              AND tabhub_sha256_v1(attempt.request_id) <> wait.request_id_digest)
            OR attempt.request_bound_at IS NOT wait.request_bound_at
            OR attempt.provider IS NOT wait.provider
            OR attempt.model IS NOT wait.model
            OR attempt.prompt_version IS NOT wait.prompt_version
            OR attempt.pricing_version IS NOT wait.pricing_version
          ))
          OR (wait.provider_reservation_id IS NULL) <> (reservation.id IS NULL)
          OR adoption.utc_date IS NOT wait.provider_adoption_utc_date
          OR adoption.adopted_at IS NOT wait.provider_adopted_at
          OR (adoption.reservation_id IS NOT NULL
            AND adoption.reservation_id IS NOT wait.provider_reservation_id)
          OR (reservation.id IS NOT NULL AND (
            reservation.final_job_id <> wait.job_id
            OR reservation.utc_date <> wait.provider_reservation_utc_date
            OR reservation.reserved_usd <> wait.provider_reserved_usd
            OR reservation.consumed_usd <> wait.provider_consumed_usd
            OR reservation.status <> wait.provider_reservation_status
          ))
          OR wait.provider_usage_state <> CASE
            WHEN attempt.request_bound_at IS NOT NULL THEN 'pending'
            WHEN reservation.id IS NULL THEN 'none' ELSE 'known' END
          OR wait.settlement_deadline_at IS NOT CASE
            WHEN attempt.request_bound_at IS NULL THEN NULL
            WHEN job.lease_expires_at > strftime(
              '%Y-%m-%dT%H:%M:%fZ', attempt.request_bound_at, '+31 minutes'
            ) THEN job.lease_expires_at
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
              attempt.request_bound_at, '+31 minutes') END
        )
      )
      AND tabhub_purge26_publication_attest_v1(
        NEW.intent_key, NEW.wait_snapshot_digest
      ) = 1
      AND NOT EXISTS (
        SELECT ordinal, subject_generation_id, generation_token,
          research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
          handoff_receipt_digest, handoff_receipt_completed_at, row_digest
        FROM privacy_purge_intent_run_targets WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, subject_generation_id, generation_token,
          research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
          handoff_receipt_digest, handoff_receipt_completed_at, row_digest
        FROM privacy_purge26_expected_run_targets WHERE intent_key = NEW.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, subject_generation_id, generation_token,
          research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
          handoff_receipt_digest, handoff_receipt_completed_at, row_digest
        FROM privacy_purge26_expected_run_targets WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, subject_generation_id, generation_token,
          research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
          handoff_receipt_digest, handoff_receipt_completed_at, row_digest
        FROM privacy_purge_intent_run_targets WHERE intent_key = NEW.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, action_id, consent_id, action_kind, state, sequence_no,
          runtime_epoch, action_key_digest, deadline_at, row_digest
        FROM privacy_purge_intent_action_waits WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, action_id, consent_id, action_kind, state, sequence_no,
          runtime_epoch, action_key_digest, deadline_at, row_digest
        FROM privacy_purge26_expected_action_waits WHERE intent_key = NEW.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, action_id, consent_id, action_kind, state, sequence_no,
          runtime_epoch, action_key_digest, deadline_at, row_digest
        FROM privacy_purge26_expected_action_waits WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, action_id, consent_id, action_kind, state, sequence_no,
          runtime_epoch, action_key_digest, deadline_at, row_digest
        FROM privacy_purge_intent_action_waits WHERE intent_key = NEW.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, job_id, status, event_sequence, attempt_id, attempt_no,
          worker_id, lease_token_digest, lease_expires_at, request_bound,
          request_id_digest, request_bound_at, provider, model, prompt_version,
          pricing_version, provider_adoption_utc_date, provider_adopted_at,
          provider_reservation_id, provider_reservation_utc_date,
          provider_reserved_usd, provider_consumed_usd,
          provider_reservation_status, settlement_deadline_at,
          provider_usage_state
        FROM privacy_purge_intent_job_waits WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, job_id, status, event_sequence, attempt_id, attempt_no,
          worker_id, lease_token_digest, lease_expires_at, request_bound,
          request_id_digest, request_bound_at, provider, model, prompt_version,
          pricing_version, provider_adoption_utc_date, provider_adopted_at,
          provider_reservation_id, provider_reservation_utc_date,
          provider_reserved_usd, provider_consumed_usd,
          provider_reservation_status, settlement_deadline_at,
          provider_usage_state
        FROM privacy_purge26_expected_job_waits WHERE intent_key = NEW.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, job_id, status, event_sequence, attempt_id, attempt_no,
          worker_id, lease_token_digest, lease_expires_at, request_bound,
          request_id_digest, request_bound_at, provider, model, prompt_version,
          pricing_version, provider_adoption_utc_date, provider_adopted_at,
          provider_reservation_id, provider_reservation_utc_date,
          provider_reserved_usd, provider_consumed_usd,
          provider_reservation_status, settlement_deadline_at,
          provider_usage_state
        FROM privacy_purge26_expected_job_waits WHERE intent_key = NEW.intent_key
        EXCEPT
        SELECT ordinal, job_id, status, event_sequence, attempt_id, attempt_no,
          worker_id, lease_token_digest, lease_expires_at, request_bound,
          request_id_digest, request_bound_at, provider, model, prompt_version,
          pricing_version, provider_adoption_utc_date, provider_adopted_at,
          provider_reservation_id, provider_reservation_utc_date,
          provider_reserved_usd, provider_consumed_usd,
          provider_reservation_status, settlement_deadline_at,
          provider_usage_state
        FROM privacy_purge_intent_job_waits WHERE intent_key = NEW.intent_key
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge intent publication requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intents_update_guard
BEFORE UPDATE ON privacy_purge_intents
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1 OR NOT (
  NEW.intent_key IS OLD.intent_key
  AND NEW.origin IS OLD.origin
  AND NEW.idempotency_key_hash IS OLD.idempotency_key_hash
  AND NEW.request_fingerprint IS OLD.request_fingerprint
  AND NEW.target_kind IS OLD.target_kind
  AND NEW.subject_generation_id IS OLD.subject_generation_id
  AND NEW.history_epoch_id IS OLD.history_epoch_id
  AND NEW.logical_page_id_snapshot IS OLD.logical_page_id_snapshot
  AND NEW.resource_id_snapshot IS OLD.resource_id_snapshot
  AND NEW.root_generation_token IS OLD.root_generation_token
  AND NEW.history_epoch_no_snapshot IS OLD.history_epoch_no_snapshot
  AND NEW.run_target_count IS OLD.run_target_count
  AND NEW.run_target_digest IS OLD.run_target_digest
  AND NEW.action_wait_count IS OLD.action_wait_count
  AND NEW.action_wait_digest IS OLD.action_wait_digest
  AND NEW.action_quiescence_digest IS OLD.action_quiescence_digest
  AND NEW.job_wait_count IS OLD.job_wait_count
  AND NEW.job_wait_digest IS OLD.job_wait_digest
  AND NEW.wait_snapshot_digest IS OLD.wait_snapshot_digest
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (OLD.status = 'waiting' AND NEW.status = 'ready'
      AND OLD.carryover_manifest_count IS NULL
      AND OLD.carryover_manifest_digest IS NULL
      AND OLD.terminal_evidence_digest IS NULL
      AND NEW.carryover_manifest_count IS NOT NULL
      AND NEW.carryover_manifest_digest IS NOT NULL
      AND NEW.terminal_evidence_digest IS NOT NULL)
    OR (NOT (OLD.status = 'waiting' AND NEW.status = 'ready')
      AND NEW.carryover_manifest_count IS OLD.carryover_manifest_count
      AND NEW.carryover_manifest_digest IS OLD.carryover_manifest_digest
      AND NEW.terminal_evidence_digest IS OLD.terminal_evidence_digest)
  )
  AND (
    (OLD.status = 'failed_hold' AND NEW.status = 'waiting'
      AND NEW.repair_count = OLD.repair_count + 1
      AND NEW.last_repair_digest IS NOT NULL
      AND NEW.last_repair_at = NEW.updated_at
      AND NEW.settlement_proof_generation
        = OLD.settlement_proof_generation + 1
      AND NEW.settlement_evidence_digest IS NOT NULL
      AND NEW.settlement_evidence_digest IS NOT OLD.settlement_evidence_digest
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_job_waits AS wait
        WHERE wait.intent_key = OLD.intent_key
          AND wait.request_bound = 1
          AND wait.provider_usage_state = 'pending'
          AND wait.terminal_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_final_settlements AS evidence
            WHERE evidence.intent_key = wait.intent_key
              AND evidence.job_wait_ordinal = wait.ordinal
              AND evidence.proof_generation = NEW.settlement_proof_generation
              AND evidence.wait_row_digest = wait.row_digest
          )
      )
      AND NEW.settlement_evidence_digest = tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(json(evidence_json)) FROM (
          SELECT json_object(
            'jobWaitOrdinal', job_wait_ordinal,
            'evidenceDigest', evidence_digest
          ) AS evidence_json
          FROM privacy_purge_intent_final_settlements
          WHERE intent_key = OLD.intent_key
            AND proof_generation = NEW.settlement_proof_generation
          ORDER BY job_wait_ordinal
        )
      ), '[]'))
      AND NEW.last_repair_digest = tabhub_sha256_v1(json_object(
        'intentKey', OLD.intent_key, 'holdCode', OLD.hold_code,
        'repairCount', NEW.repair_count,
        'settlementProofGeneration', NEW.settlement_proof_generation,
        'settlementEvidenceDigest', NEW.settlement_evidence_digest,
        'actionQuiescenceDigest', OLD.action_quiescence_digest,
        'repairAt', NEW.last_repair_at
      )))
    OR (NOT (OLD.status = 'failed_hold' AND NEW.status = 'waiting')
      AND NEW.repair_count IS OLD.repair_count
      AND NEW.last_repair_digest IS OLD.last_repair_digest
      AND NEW.last_repair_at IS OLD.last_repair_at
      AND NEW.settlement_proof_generation IS OLD.settlement_proof_generation
      AND NEW.settlement_evidence_digest IS OLD.settlement_evidence_digest)
  )
  AND (
    (OLD.status = 'waiting' AND NEW.status IN ('ready', 'failed_hold'))
    OR (OLD.status = 'failed_hold' AND NEW.status = 'waiting')
    OR (OLD.status = 'ready' AND NEW.status = 'committed')
    OR (OLD.status = 'committed' AND NEW.status = 'completed')
  )
  AND (
    (OLD.status = 'waiting' AND NEW.status = 'ready'
      AND OLD.execution_target_count IS NULL
      AND OLD.execution_plan_digest IS NULL AND OLD.purge_command_id IS NULL
      AND OLD.tombstone_digest IS NULL AND OLD.result_digest IS NULL
      AND NEW.purge_command_id IS NULL
      AND NEW.tombstone_digest IS NOT NULL AND NEW.result_digest IS NOT NULL
      AND NEW.execution_target_count = (
        SELECT COUNT(*) FROM privacy_purge_intent_execution_targets
        WHERE intent_key = OLD.intent_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_execution_targets
        WHERE intent_key = OLD.intent_key
          AND ordinal NOT BETWEEN 0 AND NEW.execution_target_count - 1
      )
      AND NEW.execution_plan_digest = tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(json(target_json)) FROM (
          SELECT json_object('tableName', table_name, 'pkV1', pk_v1) AS target_json
          FROM privacy_purge_intent_execution_targets
          WHERE intent_key = OLD.intent_key ORDER BY ordinal
        )
      ), '[]'))
      AND NOT EXISTS (
        SELECT ordinal, table_name, pk_v1, delete_rank, live_action_depth,
          row_digest
        FROM privacy_purge_intent_execution_targets
        WHERE intent_key = OLD.intent_key
        EXCEPT
        SELECT ordinal, table_name, pk_v1, delete_rank, live_action_depth,
          row_digest
        FROM privacy_purge26_expected_execution_targets
        WHERE intent_key = OLD.intent_key
      )
      AND NOT EXISTS (
        SELECT ordinal, table_name, pk_v1, delete_rank, live_action_depth,
          row_digest
        FROM privacy_purge26_expected_execution_targets
        WHERE intent_key = OLD.intent_key
        EXCEPT
        SELECT ordinal, table_name, pk_v1, delete_rank, live_action_depth,
          row_digest
        FROM privacy_purge_intent_execution_targets
        WHERE intent_key = OLD.intent_key
      )
      AND tabhub_purge26_ready_attest_v1(
        OLD.intent_key, NEW.execution_plan_digest
      ) = 1
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_action_waits
        WHERE intent_key = OLD.intent_key AND terminal_state IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_job_waits
        WHERE intent_key = OLD.intent_key AND terminal_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_final_settlements AS evidence
            WHERE evidence.intent_key = OLD.intent_key
              AND evidence.job_wait_ordinal = privacy_purge_intent_job_waits.ordinal
              AND evidence.proof_generation = OLD.settlement_proof_generation
              AND evidence.wait_row_digest = privacy_purge_intent_job_waits.row_digest
          )
      )
      AND EXISTS (
        SELECT 1 FROM privacy_purge26_command_preflight AS preflight
        WHERE preflight.intent_key = OLD.intent_key
      ))
    OR (OLD.status = 'waiting' AND NEW.status = 'failed_hold'
      AND NEW.execution_target_count IS NULL AND NEW.execution_plan_digest IS NULL
      AND NEW.purge_command_id IS NULL AND NEW.tombstone_digest IS NULL
      AND NEW.result_digest IS NULL AND NEW.hold_code IS NOT NULL
      AND (NEW.hold_code <> 'PROVIDER_USAGE_UNKNOWN' OR EXISTS (
        SELECT 1 FROM privacy_purge_intent_job_waits AS wait
        WHERE wait.intent_key = OLD.intent_key
          AND wait.provider_usage_state = 'pending'
          AND wait.terminal_status IS NULL
          AND NEW.updated_at >= wait.settlement_deadline_at
          AND NOT EXISTS (
            SELECT 1 FROM ai_job_events AS known_usage
            WHERE known_usage.job_id = wait.job_id
              AND known_usage.attempt_id = wait.attempt_id
              AND known_usage.event_type = 'progress'
              AND known_usage.sequence_no > wait.event_sequence
              AND known_usage.delta_steps > 0
              AND known_usage.occurred_at <= wait.settlement_deadline_at
              AND tabhub_sha256_v1(known_usage.lease_token)
                = wait.lease_token_digest
          )
      )))
    OR (OLD.status = 'failed_hold' AND NEW.status = 'waiting'
      AND NEW.execution_target_count IS NULL AND NEW.execution_plan_digest IS NULL
      AND NEW.purge_command_id IS NULL AND NEW.tombstone_digest IS NULL
      AND NEW.result_digest IS NULL AND NEW.hold_code IS NULL)
    OR (OLD.status = 'ready' AND NEW.status = 'committed'
      AND NEW.execution_target_count IS OLD.execution_target_count
      AND NEW.execution_plan_digest IS OLD.execution_plan_digest
      AND NEW.tombstone_digest IS OLD.tombstone_digest
      AND NEW.result_digest IS OLD.result_digest
      AND NEW.purge_command_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM privacy_purge_commands AS command
        WHERE command.id = NEW.purge_command_id
          AND command.idempotency_key_hash = OLD.idempotency_key_hash
          AND command.request_fingerprint = OLD.request_fingerprint
          AND command.target_kind = OLD.target_kind
          AND command.subject_generation_id IS OLD.subject_generation_id
          AND command.history_epoch_id IS OLD.history_epoch_id
          AND command.deletion_target_count = OLD.execution_target_count
          AND command.deletion_plan_digest = OLD.execution_plan_digest
          AND command.status = 'pending'
      ))
    OR (OLD.status = 'committed' AND NEW.status = 'completed'
      AND NEW.execution_target_count IS OLD.execution_target_count
      AND NEW.execution_plan_digest IS OLD.execution_plan_digest
      AND NEW.purge_command_id IS OLD.purge_command_id
      AND NEW.tombstone_digest IS OLD.tombstone_digest
      AND NEW.result_digest IS OLD.result_digest
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_execution_targets
        WHERE intent_key = OLD.intent_key
      )
      AND EXISTS (
        SELECT 1 FROM privacy_purge_intent_receipts AS receipt
        JOIN privacy_purge_commands AS command
          ON command.id = receipt.purge_command_id
        JOIN privacy_purge_results AS result
          ON result.command_id = command.id
        WHERE receipt.intent_key = OLD.intent_key
          AND receipt.outcome = 'completed'
          AND command.status = 'completed' AND result.outcome = 'completed'
          AND receipt.result_digest = result.result_digest
      ))
  )
  AND tabhub_purge26_transition_v1(
    OLD.intent_key, OLD.status, NEW.status,
    CASE
      WHEN OLD.status = 'waiting' AND NEW.status = 'failed_hold'
        THEN tabhub_sha256_v1(json_object(
          'intentKey', OLD.intent_key, 'fromStatus', OLD.status,
          'toStatus', NEW.status, 'holdCode', NEW.hold_code,
          'repairCount', NEW.repair_count,
          'settlementProofGeneration', NEW.settlement_proof_generation,
          'settlementEvidenceDigest', NEW.settlement_evidence_digest,
          'actionQuiescenceDigest', OLD.action_quiescence_digest,
          'updatedAt', NEW.updated_at
        ))
      WHEN OLD.status = 'failed_hold' AND NEW.status = 'waiting'
        THEN NEW.last_repair_digest
      ELSE tabhub_sha256_v1(json_object(
        'actionQuiescenceDigest', OLD.action_quiescence_digest,
        'evidenceDigest', COALESCE(NEW.execution_plan_digest, NEW.wait_snapshot_digest)
      ))
    END
  ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge intent transition');
END;

CREATE TRIGGER privacy_purge_intents_ready_evidence_guard
AFTER UPDATE OF status ON privacy_purge_intents
WHEN OLD.status = 'waiting' AND NEW.status = 'ready'
BEGIN
  SELECT CASE WHEN NEW.carryover_manifest_count <> (
    SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
    WHERE intent_key = NEW.intent_key AND state = 'frozen'
  ) THEN RAISE(ABORT, 'privacy purge ready carryover count is invalid') END;
  SELECT CASE WHEN NEW.carryover_manifest_digest <> tabhub_sha256_v1(COALESCE((
    SELECT json_group_array(json(row_json)) FROM (
      SELECT json_object(
        'intentKey', intent_key, 'utcDate', utc_date,
        'budgetClass', budget_class, 'jobKind', job_kind,
        'workflowId', workflow_id, 'workflowVersion', workflow_version,
        'coordinatorStarts', coordinator_starts,
        'providerAttempts', provider_attempts,
        'chargedCostNanos', charged_cost_nanos,
        'activeExposureNanos', active_exposure_nanos,
        'legacy25DayBlock', legacy25_day_block,
        'payloadDigest', payload_digest, 'frozenAt', frozen_at
      ) AS row_json
      FROM privacy_purge_budget_carryover_days
      WHERE intent_key = NEW.intent_key AND state = 'frozen'
      ORDER BY utc_date, budget_class, job_kind, workflow_id, workflow_version
    )
  ), '[]')) THEN RAISE(ABORT, 'privacy purge ready carryover digest is invalid') END;
  SELECT CASE WHEN NEW.result_digest <> tabhub_sha256_v1(json_object(
    'version', 'tabhub:privacy-purge:result:v3',
    'intentKey', NEW.intent_key, 'planDigest', NEW.execution_plan_digest,
    'actionQuiescenceDigest', NEW.action_quiescence_digest,
    'carryoverManifestCount', NEW.carryover_manifest_count,
    'carryoverManifestDigest', NEW.carryover_manifest_digest,
    'terminalEvidenceDigest', NEW.terminal_evidence_digest
  )) THEN RAISE(ABORT, 'privacy purge ready result digest is invalid') END;
END;

CREATE TRIGGER privacy_purge_intents_no_delete
BEFORE DELETE ON privacy_purge_intents
BEGIN
  SELECT RAISE(ABORT, 'privacy purge intents are permanent');
END;

CREATE TRIGGER privacy_purge_intent_run_targets_insert_guard
BEFORE INSERT ON privacy_purge_intent_run_targets
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NEW.row_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'subjectGenerationId', NEW.subject_generation_id,
  'generationToken', NEW.generation_token,
  'researchRunId', NEW.research_run_id, 'aiJobId', NEW.ai_job_id,
  'isRoot', NEW.is_root, 'handoffId', NEW.handoff_id,
  'handoffStatus', NEW.handoff_status,
  'handoffReceiptDigest', NEW.handoff_receipt_digest,
  'handoffReceiptCompletedAt', NEW.handoff_receipt_completed_at
))
OR tabhub_purge26_run_row_v1(
  NEW.intent_key, NEW.ordinal, NEW.subject_generation_id,
  NEW.generation_token, NEW.research_run_id, NEW.ai_job_id,
  NEW.is_root, NEW.handoff_id, NEW.handoff_status,
  NEW.handoff_receipt_digest, NEW.handoff_receipt_completed_at, NEW.row_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge run snapshot requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_action_waits_insert_guard
BEFORE INSERT ON privacy_purge_intent_action_waits
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NEW.row_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'actionId', NEW.action_id, 'consentId', NEW.consent_id,
  'actionKind', NEW.action_kind, 'state', NEW.state,
  'sequenceNo', NEW.sequence_no, 'runtimeEpoch', NEW.runtime_epoch,
  'actionKeyDigest', NEW.action_key_digest, 'deadlineAt', NEW.deadline_at
))
OR NEW.quiescence_snapshot_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'rowDigest', NEW.row_digest,
  'resolutionStartSequenceNo', NEW.resolution_start_sequence_no,
  'resolutionStartEventDigest', NEW.resolution_start_event_digest,
  'resolutionStartedAt', NEW.resolution_started_at,
  'resolutionDeadlineAt', NEW.resolution_deadline_at
))
OR (NEW.state = 'resolution_started' AND NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_action_events AS event
    ON event.action_id = action.id AND event.sequence_no = action.sequence_no
  WHERE action.id = NEW.action_id AND action.state = 'resolution_started'
    AND action.sequence_no = NEW.sequence_no
    AND event.sequence_no = NEW.resolution_start_sequence_no
    AND event.from_state = 'planned' AND event.to_state = 'resolution_started'
    AND event.occurred_at = NEW.resolution_started_at
    AND NEW.resolution_start_event_digest = tabhub_sha256_v1(json_object(
      'id', event.id, 'actionId', event.action_id,
      'sequenceNo', event.sequence_no, 'fromState', event.from_state,
      'toState', event.to_state, 'outcomeCode', event.outcome_code,
      'safeDetailsJson', event.safe_details_json, 'occurredAt', event.occurred_at
    ))
))
OR tabhub_purge26_action_row_v1(
  NEW.intent_key, NEW.ordinal, NEW.action_id, NEW.consent_id,
  NEW.action_kind, NEW.state, NEW.sequence_no, NEW.runtime_epoch,
  NEW.action_key_digest, NEW.resolution_start_sequence_no,
  NEW.resolution_start_event_digest, NEW.resolution_started_at,
  NEW.resolution_deadline_at, NEW.deadline_at,
  NEW.quiescence_snapshot_digest, NEW.row_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action snapshot requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_run_targets_immutable_update
BEFORE UPDATE ON privacy_purge_intent_run_targets
BEGIN
  SELECT RAISE(ABORT, 'privacy purge run snapshots are immutable');
END;

CREATE TRIGGER privacy_purge_intent_run_targets_delete_guard
BEFORE DELETE ON privacy_purge_intent_run_targets
BEGIN
  SELECT RAISE(ABORT, 'privacy purge run snapshots are permanent');
END;

CREATE TRIGGER privacy_purge_intent_action_waits_terminal_update
BEFORE UPDATE ON privacy_purge_intent_action_waits
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1 OR NOT (
  NEW.intent_key IS OLD.intent_key AND NEW.ordinal IS OLD.ordinal
  AND NEW.action_id IS OLD.action_id AND NEW.consent_id IS OLD.consent_id
  AND NEW.action_kind IS OLD.action_kind AND NEW.state IS OLD.state
  AND NEW.sequence_no IS OLD.sequence_no AND NEW.runtime_epoch IS OLD.runtime_epoch
  AND NEW.action_key_digest IS OLD.action_key_digest
  AND NEW.resolution_start_sequence_no IS OLD.resolution_start_sequence_no
  AND NEW.resolution_start_event_digest IS OLD.resolution_start_event_digest
  AND NEW.resolution_started_at IS OLD.resolution_started_at
  AND NEW.resolution_deadline_at IS OLD.resolution_deadline_at
  AND NEW.deadline_at IS OLD.deadline_at
  AND NEW.quiescence_snapshot_digest IS OLD.quiescence_snapshot_digest
  AND NEW.row_digest IS OLD.row_digest
  AND OLD.terminal_state IS NULL AND OLD.terminal_sequence_no IS NULL
  AND OLD.terminal_event_digest IS NULL AND OLD.terminal_proof_digest IS NULL
  AND OLD.terminal_at IS NULL
  AND NEW.terminal_state IS NOT NULL AND NEW.terminal_sequence_no IS NOT NULL
  AND NEW.terminal_event_digest IS NOT NULL
  AND NEW.terminal_proof_digest = tabhub_sha256_v1(json_object(
    'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
    'rowDigest', NEW.row_digest, 'terminalState', NEW.terminal_state,
    'terminalSequenceNo', NEW.terminal_sequence_no,
    'terminalEventDigest', NEW.terminal_event_digest,
    'terminalAt', NEW.terminal_at
  ))
  AND NEW.terminal_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM privacy_purge_intents AS intent
    WHERE intent.intent_key = OLD.intent_key AND intent.status = 'waiting'
  )
  AND EXISTS (
    SELECT 1 FROM live_acquisition_actions AS action
    JOIN live_acquisition_action_events AS event
      ON event.action_id = action.id
    WHERE action.id = OLD.action_id
      AND action.state = NEW.terminal_state
      AND action.sequence_no = NEW.terminal_sequence_no
      AND action.terminal_at = NEW.terminal_at
      AND event.sequence_no = NEW.terminal_sequence_no
      AND event.to_state = NEW.terminal_state
      AND event.occurred_at = NEW.terminal_at
      AND NEW.terminal_event_digest = tabhub_sha256_v1(json_object(
        'id', event.id, 'actionId', event.action_id,
        'sequenceNo', event.sequence_no, 'fromState', event.from_state,
        'toState', event.to_state, 'outcomeCode', event.outcome_code,
        'safeDetailsJson', event.safe_details_json,
        'occurredAt', event.occurred_at
      ))
      AND NOT EXISTS (
        SELECT 1 FROM live_acquisition_action_events AS newer
        WHERE newer.action_id = event.action_id
          AND newer.sequence_no > event.sequence_no
      )
  )
  AND tabhub_purge26_action_terminal_v1(
    OLD.intent_key, OLD.ordinal, OLD.action_id, OLD.row_digest,
    NEW.terminal_state, NEW.terminal_sequence_no,
    NEW.terminal_event_digest, NEW.terminal_at,
    NEW.terminal_proof_digest
  ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge action terminal proof');
END;

CREATE TRIGGER privacy_purge_intent_action_waits_delete_guard
BEFORE DELETE ON privacy_purge_intent_action_waits
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action snapshots are permanent');
END;

CREATE TABLE privacy_purge_action_abort_requests (
  intent_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  action_id INTEGER NOT NULL,
  consent_id INTEGER NOT NULL,
  coordinator_job_id INTEGER NOT NULL,
  attempt_id INTEGER,
  attempt_no INTEGER,
  lease_token_digest TEXT,
  execution_key_digest TEXT,
  checkpoint_digest TEXT,
  checkpoint_updated_at TEXT,
  action_sequence_no INTEGER NOT NULL,
  action_runtime_epoch INTEGER NOT NULL,
  observed_runtime_epoch INTEGER NOT NULL,
  request_kind TEXT NOT NULL CHECK (
    request_kind IN ('current_exact', 'prior_epoch')
  ),
  requested_at TEXT NOT NULL CHECK (
    requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at)
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (intent_key, ordinal),
  UNIQUE (request_digest),
  FOREIGN KEY (intent_key, ordinal)
    REFERENCES privacy_purge_intent_action_waits(intent_key, ordinal)
    ON DELETE RESTRICT,
  CHECK (
    (request_kind = 'current_exact' AND attempt_id IS NOT NULL
      AND attempt_no IS NOT NULL AND lease_token_digest IS NOT NULL
      AND execution_key_digest IS NOT NULL AND checkpoint_digest IS NOT NULL
      AND checkpoint_updated_at IS NOT NULL)
    OR (request_kind = 'prior_epoch' AND attempt_id IS NULL
      AND attempt_no IS NULL AND lease_token_digest IS NULL
      AND execution_key_digest IS NULL AND checkpoint_digest IS NULL
      AND checkpoint_updated_at IS NULL
      AND action_runtime_epoch < observed_runtime_epoch)
  )
) STRICT;

CREATE TRIGGER privacy_purge_action_abort_requests_insert_guard
BEFORE INSERT ON privacy_purge_action_abort_requests
WHEN NEW.request_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'actionId', NEW.action_id, 'consentId', NEW.consent_id,
  'coordinatorJobId', NEW.coordinator_job_id,
  'attemptId', NEW.attempt_id, 'attemptNo', NEW.attempt_no,
  'leaseTokenDigest', NEW.lease_token_digest,
  'executionKeyDigest', NEW.execution_key_digest,
  'checkpointDigest', NEW.checkpoint_digest,
  'checkpointUpdatedAt', NEW.checkpoint_updated_at,
  'actionSequenceNo', NEW.action_sequence_no,
  'actionRuntimeEpoch', NEW.action_runtime_epoch,
  'observedRuntimeEpoch', NEW.observed_runtime_epoch,
  'requestKind', NEW.request_kind, 'requestedAt', NEW.requested_at
))
OR NOT EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  JOIN privacy_purge_intent_action_waits AS wait
    ON wait.intent_key = intent.intent_key AND wait.ordinal = NEW.ordinal
  JOIN live_acquisition_actions AS action ON action.id = wait.action_id
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
  WHERE intent.intent_key = NEW.intent_key AND intent.status = 'waiting'
    AND wait.terminal_state IS NULL AND wait.state = 'started'
    AND action.id = NEW.action_id AND action.state = 'started'
    AND action.sequence_no = NEW.action_sequence_no
    AND action.runtime_epoch = NEW.action_runtime_epoch
    AND consent.id = NEW.consent_id
    AND consent.coordinator_job_id = NEW.coordinator_job_id
    AND runtime.runtime_epoch = NEW.observed_runtime_epoch
    AND ((NEW.request_kind = 'prior_epoch'
      AND action.runtime_epoch < runtime.runtime_epoch)
      OR (NEW.request_kind = 'current_exact'
        AND action.runtime_epoch = runtime.runtime_epoch
        AND EXISTS (
          SELECT 1 FROM ai_jobs AS job
          JOIN ai_job_attempts AS attempt ON attempt.job_id = job.id
          JOIN live_acquisition_checkpoints AS checkpoint
            ON checkpoint.attempt_id = attempt.id
          WHERE job.id = consent.coordinator_job_id AND job.status = 'running'
            AND attempt.id = NEW.attempt_id
            AND attempt.attempt_no = NEW.attempt_no
            AND attempt.outcome = 'running'
            AND tabhub_sha256_v1(attempt.lease_token) = NEW.lease_token_digest
            AND NEW.execution_key_digest = tabhub_sha256_v1(
              'tabhub:c90-tracked-execution:v1' || char(0) || json_object(
                'jobId', job.id, 'attemptId', attempt.id,
                'attemptNo', attempt.attempt_no,
                'leaseTokenDigest', NEW.lease_token_digest
              )
            )
            AND checkpoint.coordinator_job_id = job.id
            AND checkpoint.consent_id = consent.id
            AND checkpoint.runtime_epoch = runtime.runtime_epoch
            AND checkpoint.checkpoint_digest = NEW.checkpoint_digest
            AND tabhub_sha256_v1(checkpoint.checkpoint_json) = checkpoint.checkpoint_digest
            AND checkpoint.updated_at = NEW.checkpoint_updated_at
            AND EXISTS (
              SELECT 1 FROM json_each(
                checkpoint.checkpoint_json, '$.queue.activeActionIds'
              ) AS active_action
              WHERE active_action.type = 'integer'
                AND active_action.value = action.id
            )
        )))
)
OR tabhub_purge26_action_abort_request_v1(
  NEW.intent_key, NEW.ordinal, NEW.action_id, NEW.consent_id,
  NEW.coordinator_job_id, NEW.attempt_id, NEW.attempt_no,
  NEW.lease_token_digest, NEW.execution_key_digest, NEW.checkpoint_digest,
  NEW.checkpoint_updated_at, NEW.action_sequence_no,
  NEW.action_runtime_epoch, NEW.observed_runtime_epoch, NEW.request_kind,
  NEW.requested_at, NEW.request_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge action abort request');
END;

CREATE TRIGGER privacy_purge_action_abort_requests_immutable_update
BEFORE UPDATE ON privacy_purge_action_abort_requests
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action abort request is immutable');
END;

CREATE TRIGGER privacy_purge_action_abort_requests_immutable_delete
BEFORE DELETE ON privacy_purge_action_abort_requests
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action abort request is permanent');
END;

CREATE TABLE live_acquisition_action_abort_provenance (
  request_digest TEXT PRIMARY KEY CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  action_id INTEGER NOT NULL,
  execution_key_digest TEXT NOT NULL CHECK (
    length(execution_key_digest) = 64
      AND execution_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  event_id INTEGER NOT NULL UNIQUE,
  event_sequence_no INTEGER NOT NULL,
  recorded_at TEXT NOT NULL CHECK (
    recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at)
  ),
  row_digest TEXT NOT NULL CHECK (
    length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'
  ),
  FOREIGN KEY (action_id) REFERENCES live_acquisition_actions(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES live_acquisition_action_events(id) ON DELETE CASCADE,
  FOREIGN KEY (request_digest) REFERENCES privacy_purge_action_abort_requests(request_digest)
    ON DELETE RESTRICT
) STRICT;

DROP TRIGGER live_acquisition_action_events_safe_details_guard;
CREATE TRIGGER live_acquisition_action_events_safe_details_guard
BEFORE INSERT ON live_acquisition_action_events
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.safe_details_json) AS detail
  WHERE detail.key NOT IN (
    'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
    'response_class', 'outcome_class', 'redirect_count', 'response_bytes',
    'duration_ms', 'dns_answer_count', 'attempt_count', 'abort_request_digest'
  ) OR (
    detail.key IN (
      'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
      'abort_request_digest'
    ) AND (detail.type <> 'text' OR length(detail.value) <> 64
      OR detail.value GLOB '*[^0-9a-f]*')
  ) OR (
    detail.key = 'abort_request_digest' AND NOT (
      NEW.from_state = 'started' AND NEW.to_state = 'ambiguous'
      AND NEW.outcome_code = 'CANCELLED'
      AND json_extract(NEW.safe_details_json, '$.outcome_class') = 'ambiguous'
    )
  ) OR (
    detail.key = 'response_class' AND (
      detail.type <> 'text' OR detail.value NOT IN (
        'informational', 'success', 'redirect', 'client_error',
        'server_error', 'network_error', 'timeout', 'blocked'
      )
    )
  ) OR (
    detail.key = 'outcome_class' AND (
      detail.type <> 'text' OR detail.value NOT IN (
        'completed', 'blocked', 'ambiguous', 'failed', 'cancelled'
      )
    )
  ) OR (
    detail.key IN (
      'redirect_count', 'response_bytes', 'duration_ms',
      'dns_answer_count', 'attempt_count'
    ) AND (detail.type <> 'integer' OR detail.value < 0
      OR detail.value > 9007199254740991)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action event details are not safe');
END;

CREATE TRIGGER live_acquisition_action_abort_provenance_insert_guard
BEFORE INSERT ON live_acquisition_action_abort_provenance
WHEN NEW.row_digest <> tabhub_sha256_v1(json_object(
  'requestDigest', NEW.request_digest, 'actionId', NEW.action_id,
  'executionKeyDigest', NEW.execution_key_digest, 'eventId', NEW.event_id,
  'eventSequenceNo', NEW.event_sequence_no, 'recordedAt', NEW.recorded_at
))
OR NOT EXISTS (
  SELECT 1
  FROM privacy_purge_action_abort_requests AS request
  JOIN live_acquisition_action_events AS event ON event.id = NEW.event_id
  WHERE request.request_digest = NEW.request_digest
    AND request.request_kind = 'current_exact'
    AND request.action_id = NEW.action_id
    AND request.execution_key_digest = NEW.execution_key_digest
    AND event.action_id = NEW.action_id
    AND event.sequence_no = NEW.event_sequence_no
    AND event.from_state = 'started' AND event.to_state = 'ambiguous'
    AND event.outcome_code = 'CANCELLED'
    AND event.safe_details_json = json_object(
      'outcome_class', 'ambiguous',
      'abort_request_digest', request.request_digest
    )
    AND event.occurred_at = NEW.recorded_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition action abort provenance');
END;

CREATE TRIGGER live_acquisition_action_abort_provenance_immutable_update
BEFORE UPDATE ON live_acquisition_action_abort_provenance
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action abort provenance is immutable');
END;

CREATE TRIGGER live_acquisition_action_abort_provenance_no_direct_delete
BEFORE DELETE ON live_acquisition_action_abort_provenance
WHEN EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id)
  AND EXISTS (SELECT 1 FROM live_acquisition_action_events WHERE id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action abort provenance is immutable');
END;

CREATE TABLE privacy_purge_action_abort_receipts (
  intent_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'acknowledged', 'response_wins', 'prior_epoch_ambiguous',
      'prior_epoch_recovery'
    )
  ),
  bridge_status TEXT NOT NULL CHECK (
    bridge_status IN ('acknowledged', 'already_settled', 'durable_provenance', 'prior_epoch')
  ),
  bridge_action_id INTEGER,
  bridge_job_id INTEGER,
  bridge_attempt_id INTEGER,
  bridge_attempt_no INTEGER,
  bridge_lease_token_digest TEXT,
  bridge_execution_key_digest TEXT,
  bridge_abort_request_digest TEXT,
  bridge_signalled INTEGER NOT NULL CHECK (bridge_signalled IN (0, 1)),
  bridge_settled INTEGER NOT NULL CHECK (bridge_settled IN (0, 1)),
  bridge_settlement TEXT CHECK (bridge_settlement IN ('fulfilled', 'rejected')),
  bridge_terminal_outcome TEXT CHECK (
    bridge_terminal_outcome IN ('settled_without_abort', 'settled_after_external_abort')
  ),
  recovery_runtime_epoch INTEGER,
  bridge_result_digest TEXT NOT NULL CHECK (
    length(bridge_result_digest) = 64
      AND bridge_result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_state TEXT NOT NULL CHECK (
    terminal_state IN ('completed', 'blocked', 'ambiguous')
  ),
  terminal_sequence_no INTEGER NOT NULL,
  terminal_event_digest TEXT NOT NULL CHECK (length(terminal_event_digest) = 64),
  terminal_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL CHECK (
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  received_at TEXT NOT NULL CHECK (
    received_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at)
  ),
  PRIMARY KEY (intent_key, ordinal),
  FOREIGN KEY (intent_key, ordinal)
    REFERENCES privacy_purge_action_abort_requests(intent_key, ordinal)
    ON DELETE RESTRICT,
  CHECK (
    (bridge_status = 'prior_epoch' AND bridge_action_id IS NULL
      AND bridge_job_id IS NULL
      AND bridge_attempt_id IS NULL AND bridge_attempt_no IS NULL
      AND bridge_lease_token_digest IS NULL AND bridge_execution_key_digest IS NULL
      AND bridge_abort_request_digest IS NULL AND bridge_signalled = 0
      AND bridge_settled = 0 AND bridge_settlement IS NULL
      AND bridge_terminal_outcome IS NULL
      AND recovery_runtime_epoch IS NOT NULL)
    OR (bridge_status = 'acknowledged' AND bridge_action_id IS NOT NULL
      AND bridge_job_id IS NOT NULL
      AND bridge_attempt_id IS NOT NULL AND bridge_attempt_no IS NOT NULL
      AND bridge_lease_token_digest IS NOT NULL AND bridge_execution_key_digest IS NOT NULL
      AND bridge_abort_request_digest IS NOT NULL AND bridge_signalled = 1
      AND bridge_settled = 1 AND bridge_settlement IS NOT NULL
      AND bridge_terminal_outcome IS NULL AND recovery_runtime_epoch IS NULL)
    OR (bridge_status = 'already_settled' AND bridge_action_id IS NOT NULL
      AND bridge_job_id IS NOT NULL
      AND bridge_attempt_id IS NOT NULL AND bridge_attempt_no IS NOT NULL
      AND bridge_lease_token_digest IS NOT NULL AND bridge_execution_key_digest IS NOT NULL
      AND bridge_signalled = 0 AND bridge_settled = 1
      AND bridge_settlement IS NOT NULL AND bridge_terminal_outcome IS NOT NULL
      AND recovery_runtime_epoch IS NULL)
    OR (bridge_status = 'durable_provenance' AND bridge_action_id IS NOT NULL
      AND bridge_job_id IS NOT NULL AND bridge_attempt_id IS NOT NULL
      AND bridge_attempt_no IS NOT NULL AND bridge_lease_token_digest IS NOT NULL
      AND bridge_execution_key_digest IS NOT NULL
      AND bridge_abort_request_digest IS NOT NULL AND bridge_signalled = 1
      AND bridge_settled = 1 AND bridge_settlement IS NULL
      AND bridge_terminal_outcome = 'settled_after_external_abort'
      AND recovery_runtime_epoch IS NULL)
  )
) STRICT;

CREATE TRIGGER privacy_purge_action_abort_receipts_insert_guard
BEFORE INSERT ON privacy_purge_action_abort_receipts
WHEN NEW.receipt_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'requestDigest', NEW.request_digest, 'outcome', NEW.outcome,
  'bridgeStatus', NEW.bridge_status, 'bridgeActionId', NEW.bridge_action_id,
  'bridgeJobId', NEW.bridge_job_id,
  'bridgeAttemptId', NEW.bridge_attempt_id,
  'bridgeAttemptNo', NEW.bridge_attempt_no,
  'bridgeLeaseTokenDigest', NEW.bridge_lease_token_digest,
  'bridgeExecutionKeyDigest', NEW.bridge_execution_key_digest,
  'bridgeAbortRequestDigest', NEW.bridge_abort_request_digest,
  'bridgeSignalled', NEW.bridge_signalled,
  'bridgeSettled', NEW.bridge_settled,
  'bridgeSettlement', NEW.bridge_settlement,
  'bridgeTerminalOutcome', NEW.bridge_terminal_outcome,
  'recoveryRuntimeEpoch', NEW.recovery_runtime_epoch,
  'bridgeResultDigest', NEW.bridge_result_digest,
  'terminalState', NEW.terminal_state,
  'terminalSequenceNo', NEW.terminal_sequence_no,
  'terminalEventDigest', NEW.terminal_event_digest,
  'terminalAt', NEW.terminal_at, 'receivedAt', NEW.received_at
))
OR NOT EXISTS (
  SELECT 1
  FROM privacy_purge_action_abort_requests AS request
  JOIN privacy_purge_intent_action_waits AS wait
    ON wait.intent_key = request.intent_key AND wait.ordinal = request.ordinal
  JOIN live_acquisition_action_events AS event
    ON event.action_id = request.action_id
    AND event.sequence_no = NEW.terminal_sequence_no
  WHERE request.intent_key = NEW.intent_key AND request.ordinal = NEW.ordinal
    AND request.request_digest = NEW.request_digest
    AND NEW.received_at >= request.requested_at
    AND request.request_kind = CASE
      WHEN NEW.outcome = 'prior_epoch_ambiguous' THEN 'prior_epoch'
      ELSE 'current_exact' END
    AND (NEW.bridge_status = 'prior_epoch' OR (
      NEW.bridge_action_id = request.action_id
      AND NEW.bridge_job_id = request.coordinator_job_id
      AND NEW.bridge_attempt_id = request.attempt_id
      AND NEW.bridge_attempt_no = request.attempt_no
      AND NEW.bridge_lease_token_digest = request.lease_token_digest
      AND NEW.bridge_execution_key_digest = request.execution_key_digest
    ))
    AND ((NEW.outcome = 'acknowledged' AND (
      (NEW.bridge_status = 'acknowledged'
        AND NEW.bridge_abort_request_digest = request.request_digest)
      OR (NEW.bridge_status = 'already_settled'
        AND NEW.bridge_terminal_outcome = 'settled_after_external_abort'
        AND NEW.bridge_abort_request_digest = request.request_digest)
      OR (NEW.bridge_status = 'durable_provenance'
        AND NEW.bridge_terminal_outcome = 'settled_after_external_abort'
        AND NEW.bridge_abort_request_digest = request.request_digest)
    )) OR (NEW.outcome = 'response_wins'
      AND NEW.bridge_status = 'already_settled'
      AND NEW.bridge_terminal_outcome = 'settled_without_abort'
      AND NEW.bridge_abort_request_digest IS NULL)
      OR (NEW.outcome IN ('prior_epoch_ambiguous', 'prior_epoch_recovery')
        AND NEW.bridge_status = 'prior_epoch'
        AND NEW.recovery_runtime_epoch > request.action_runtime_epoch))
    AND NEW.bridge_result_digest = CASE NEW.bridge_status
      WHEN 'acknowledged' THEN tabhub_sha256_v1(
        'tabhub:c90-tracked-abort-ack:v1' || char(0) || json_object(
          'status', 'acknowledged', 'actionId', NEW.bridge_action_id,
          'jobId', NEW.bridge_job_id,
          'attemptId', NEW.bridge_attempt_id, 'attemptNo', NEW.bridge_attempt_no,
          'leaseTokenDigest', NEW.bridge_lease_token_digest,
          'executionKeyDigest', NEW.bridge_execution_key_digest,
          'abortRequestDigest', NEW.bridge_abort_request_digest,
          'signalled', json('true'), 'settled', json('true'),
          'settlement', NEW.bridge_settlement))
      WHEN 'already_settled' THEN tabhub_sha256_v1(
        'tabhub:c90-tracked-settled:v1' || char(0) || json_object(
          'status', 'already_settled', 'actionId', NEW.bridge_action_id,
          'jobId', NEW.bridge_job_id,
          'attemptId', NEW.bridge_attempt_id, 'attemptNo', NEW.bridge_attempt_no,
          'leaseTokenDigest', NEW.bridge_lease_token_digest,
          'executionKeyDigest', NEW.bridge_execution_key_digest,
          'abortRequestDigest', NEW.bridge_abort_request_digest,
          'signalled', json('false'), 'settled', json('true'),
          'settlement', NEW.bridge_settlement,
          'terminalOutcome', NEW.bridge_terminal_outcome))
      WHEN 'durable_provenance' THEN tabhub_sha256_v1(
        'tabhub:c90-durable-abort-provenance:v1' || char(0) || json_object(
          'requestDigest', NEW.bridge_abort_request_digest,
          'actionId', NEW.bridge_action_id,
          'executionKeyDigest', NEW.bridge_execution_key_digest,
          'terminalEventDigest', NEW.terminal_event_digest))
      ELSE tabhub_sha256_v1('tabhub:c90-prior-epoch:v1' || char(0) || json_object(
        'observedRuntimeEpoch', NEW.recovery_runtime_epoch)) END
    AND wait.terminal_state IS NULL
    AND event.to_state = NEW.terminal_state
    AND ((NEW.outcome = 'response_wins')
      OR (event.to_state = 'ambiguous' AND event.outcome_code = 'CANCELLED'))
    AND (NEW.outcome <> 'acknowledged' OR EXISTS (
      SELECT 1 FROM live_acquisition_action_abort_provenance AS provenance
      WHERE provenance.request_digest = request.request_digest
        AND provenance.action_id = request.action_id
        AND provenance.execution_key_digest = request.execution_key_digest
        AND provenance.event_id = event.id
        AND provenance.event_sequence_no = event.sequence_no
    ))
    AND event.occurred_at = NEW.terminal_at
    AND NEW.terminal_event_digest = tabhub_sha256_v1(json_object(
      'id', event.id, 'actionId', event.action_id,
      'sequenceNo', event.sequence_no, 'fromState', event.from_state,
      'toState', event.to_state, 'outcomeCode', event.outcome_code,
      'safeDetailsJson', event.safe_details_json,
      'occurredAt', event.occurred_at
    ))
)
OR tabhub_purge26_action_abort_receipt_v1(
  NEW.intent_key, NEW.ordinal, NEW.request_digest, NEW.outcome,
  NEW.bridge_status, NEW.bridge_action_id, NEW.bridge_job_id, NEW.bridge_attempt_id,
  NEW.bridge_attempt_no, NEW.bridge_lease_token_digest,
  NEW.bridge_execution_key_digest, NEW.bridge_abort_request_digest,
  NEW.bridge_signalled, NEW.bridge_settled, NEW.bridge_settlement,
  NEW.bridge_terminal_outcome, NEW.recovery_runtime_epoch,
  NEW.bridge_result_digest,
  NEW.terminal_state, NEW.terminal_sequence_no,
  NEW.terminal_event_digest, NEW.terminal_at, NEW.receipt_digest,
  NEW.received_at
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge action abort receipt');
END;

CREATE TRIGGER privacy_purge_action_abort_receipts_immutable_update
BEFORE UPDATE ON privacy_purge_action_abort_receipts
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action abort receipt is immutable');
END;

CREATE TRIGGER privacy_purge_action_abort_receipts_immutable_delete
BEFORE DELETE ON privacy_purge_action_abort_receipts
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action abort receipt is permanent');
END;

CREATE TRIGGER privacy_purge_action_abort_request_blocks_sync_adoption
BEFORE UPDATE OF terminal_state ON privacy_purge_intent_action_waits
WHEN OLD.terminal_state IS NULL AND NEW.terminal_state IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM privacy_purge_action_abort_requests AS request
    WHERE request.intent_key = OLD.intent_key AND request.ordinal = OLD.ordinal
  )
  AND NOT EXISTS (
    SELECT 1 FROM privacy_purge_action_abort_receipts AS receipt
    WHERE receipt.intent_key = OLD.intent_key AND receipt.ordinal = OLD.ordinal
      AND receipt.terminal_state = NEW.terminal_state
      AND receipt.terminal_sequence_no = NEW.terminal_sequence_no
      AND receipt.terminal_event_digest = NEW.terminal_event_digest
      AND receipt.terminal_at = NEW.terminal_at
  )
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action abort receipt is required');
END;

-- This runs after every legacy-025 authority guard and any BEFORE trigger, but
-- still before the executor can issue its first target mutation.  It closes
-- the gap between the JavaScript attestation and executePrivacyPurgePlan's
-- independently-owned BEGIN IMMEDIATE transaction.
CREATE TABLE privacy_purge_action_quiescence_attestations (
  command_id INTEGER PRIMARY KEY
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  intent_key TEXT NOT NULL UNIQUE
    REFERENCES privacy_purge_intents(intent_key) ON DELETE RESTRICT,
  action_quiescence_digest TEXT NOT NULL CHECK (
    length(action_quiescence_digest) = 64
      AND action_quiescence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  attested_at TEXT NOT NULL CHECK (
    attested_at = strftime('%Y-%m-%dT%H:%M:%fZ', attested_at)
  )
) STRICT;

CREATE TRIGGER privacy_purge_action_quiescence_attestations_insert_guard
BEFORE INSERT ON privacy_purge_action_quiescence_attestations
WHEN tabhub_purge_finalization_active_v1(NEW.command_id) <> 1
OR NOT EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  JOIN privacy_purge_commands AS command ON command.id = intent.purge_command_id
  WHERE intent.intent_key = NEW.intent_key
    AND intent.origin = 'schema26' AND intent.status = 'committed'
    AND command.id = NEW.command_id
    AND intent.action_quiescence_digest = NEW.action_quiescence_digest
    AND NEW.attested_at >= command.created_at
    AND intent.action_wait_count = (
      SELECT COUNT(*) FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key
    )
    AND intent.action_wait_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_row_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        )) AS recomputed_row_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND intent.action_quiescence_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_quiescence_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', tabhub_sha256_v1(json_object(
            'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
            'actionId', wait.action_id, 'consentId', wait.consent_id,
            'actionKind', wait.action_kind, 'state', wait.state,
            'sequenceNo', wait.sequence_no,
            'runtimeEpoch', wait.runtime_epoch,
            'actionKeyDigest', wait.action_key_digest,
            'deadlineAt', wait.deadline_at
          )),
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        )) AS recomputed_quiescence_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND NOT EXISTS (
      SELECT 1 FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key AND (
        wait.ordinal < 0 OR wait.ordinal >= intent.action_wait_count
        OR wait.row_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        ))
        OR wait.quiescence_snapshot_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', wait.row_digest,
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        ))
        OR (wait.state = 'resolution_started' AND (
          wait.resolution_start_sequence_no <> wait.sequence_no
          OR wait.resolution_started_at IS NULL
          OR wait.resolution_deadline_at <> strftime(
            '%Y-%m-%dT%H:%M:%fZ', wait.resolution_started_at, '+3 seconds'
          )
          OR NOT EXISTS (
            SELECT 1 FROM live_acquisition_action_events AS event
            WHERE event.action_id = wait.action_id
              AND event.sequence_no = wait.resolution_start_sequence_no
              AND event.from_state = 'planned'
              AND event.to_state = 'resolution_started'
              AND event.occurred_at = wait.resolution_started_at
              AND wait.resolution_start_event_digest =
                tabhub_sha256_v1(json_object(
                  'id', event.id, 'actionId', event.action_id,
                  'sequenceNo', event.sequence_no,
                  'fromState', event.from_state,
                  'toState', event.to_state,
                  'outcomeCode', event.outcome_code,
                  'safeDetailsJson', event.safe_details_json,
                  'occurredAt', event.occurred_at
                ))
          )
        ))
        OR (wait.state <> 'resolution_started' AND (
          wait.resolution_start_sequence_no IS NOT NULL
          OR wait.resolution_start_event_digest IS NOT NULL
          OR wait.resolution_started_at IS NOT NULL
          OR wait.resolution_deadline_at IS NOT NULL
        ))
      )
    )
)
BEGIN
  SELECT RAISE(ABORT,
    'privacy purge action quiescence attestation requires active executor');
END;

CREATE TRIGGER privacy_purge_action_quiescence_attestations_immutable_update
BEFORE UPDATE ON privacy_purge_action_quiescence_attestations
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action quiescence attestation is immutable');
END;

CREATE TRIGGER privacy_purge_action_quiescence_attestations_immutable_delete
BEFORE DELETE ON privacy_purge_action_quiescence_attestations
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action quiescence attestation is permanent');
END;

CREATE TRIGGER privacy_purge26_authority_action_quiescence_guard
AFTER INSERT ON privacy_purge_authorities
WHEN EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.command_id
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.command_id
    AND intent.action_wait_count = (
      SELECT COUNT(*) FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key
    )
    AND intent.action_wait_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_row_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        )) AS recomputed_row_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND intent.action_quiescence_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_quiescence_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', tabhub_sha256_v1(json_object(
            'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
            'actionId', wait.action_id, 'consentId', wait.consent_id,
            'actionKind', wait.action_kind, 'state', wait.state,
            'sequenceNo', wait.sequence_no,
            'runtimeEpoch', wait.runtime_epoch,
            'actionKeyDigest', wait.action_key_digest,
            'deadlineAt', wait.deadline_at
          )),
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        )) AS recomputed_quiescence_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND NOT EXISTS (
      SELECT 1
      FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key AND (
        wait.ordinal < 0 OR wait.ordinal >= intent.action_wait_count
        OR wait.row_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        ))
        OR wait.quiescence_snapshot_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', wait.row_digest,
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        ))
        OR (wait.state = 'resolution_started' AND (
          wait.resolution_start_sequence_no <> wait.sequence_no
          OR wait.resolution_started_at IS NULL
          OR wait.resolution_deadline_at <> strftime(
            '%Y-%m-%dT%H:%M:%fZ', wait.resolution_started_at, '+3 seconds'
          )
          OR (NOT EXISTS (
            SELECT 1 FROM live_acquisition_action_events AS event
            WHERE event.action_id = wait.action_id
              AND event.sequence_no = wait.resolution_start_sequence_no
              AND event.from_state = 'planned'
              AND event.to_state = 'resolution_started'
              AND event.occurred_at = wait.resolution_started_at
              AND wait.resolution_start_event_digest =
                tabhub_sha256_v1(json_object(
                  'id', event.id, 'actionId', event.action_id,
                  'sequenceNo', event.sequence_no,
                  'fromState', event.from_state,
                  'toState', event.to_state,
                  'outcomeCode', event.outcome_code,
                  'safeDetailsJson', event.safe_details_json,
                  'occurredAt', event.occurred_at
                ))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM privacy_purge_action_quiescence_attestations AS attestation
            WHERE attestation.command_id = NEW.command_id
              AND attestation.intent_key = intent.intent_key
              AND attestation.action_quiescence_digest =
                intent.action_quiescence_digest
          ))
        ))
        OR (wait.state <> 'resolution_started' AND (
          wait.resolution_start_sequence_no IS NOT NULL
          OR wait.resolution_start_event_digest IS NOT NULL
          OR wait.resolution_started_at IS NOT NULL
          OR wait.resolution_deadline_at IS NOT NULL
        ))
      )
    )
  ) THEN RAISE(ABORT, 'privacy purge action quiescence invariant failed') END;
  INSERT INTO privacy_purge_action_quiescence_attestations (
    command_id, intent_key, action_quiescence_digest, attested_at
  )
  SELECT NEW.command_id, intent.intent_key,
    intent.action_quiescence_digest, NEW.created_at
  FROM privacy_purge_intents AS intent
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.command_id
    AND NOT EXISTS (
      SELECT 1 FROM privacy_purge_action_quiescence_attestations AS attestation
      WHERE attestation.command_id = NEW.command_id
    );
END;

-- executePrivacyPurgePlan inserts the result only after all authorities have
-- been consumed and all target mutations have run.  Rechecking the permanent
-- wait ledger here catches a TEMP AFTER-authority mutation even when it ran
-- after the main AFTER trigger on the final authority.
CREATE TRIGGER privacy_purge26_result_action_quiescence_guard
BEFORE INSERT ON privacy_purge_results
WHEN EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.command_id
) AND NOT EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  LEFT JOIN privacy_purge_action_quiescence_attestations AS attestation
    ON attestation.command_id = intent.purge_command_id
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.command_id
    AND (
      (intent.action_wait_count = 0 AND attestation.command_id IS NULL)
      OR (attestation.intent_key = intent.intent_key
        AND attestation.action_quiescence_digest =
          intent.action_quiescence_digest)
    )
    AND intent.action_wait_count = (
      SELECT COUNT(*) FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key
    )
    AND intent.action_wait_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_row_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        )) AS recomputed_row_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND intent.action_quiescence_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(recomputed_quiescence_digest) FROM (
        SELECT tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', tabhub_sha256_v1(json_object(
            'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
            'actionId', wait.action_id, 'consentId', wait.consent_id,
            'actionKind', wait.action_kind, 'state', wait.state,
            'sequenceNo', wait.sequence_no,
            'runtimeEpoch', wait.runtime_epoch,
            'actionKeyDigest', wait.action_key_digest,
            'deadlineAt', wait.deadline_at
          )),
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        )) AS recomputed_quiescence_digest
        FROM privacy_purge_intent_action_waits AS wait
        WHERE wait.intent_key = intent.intent_key ORDER BY wait.ordinal
      )
    ), '[]'))
    AND NOT EXISTS (
      SELECT 1 FROM privacy_purge_intent_action_waits AS wait
      WHERE wait.intent_key = intent.intent_key AND (
        wait.ordinal < 0 OR wait.ordinal >= intent.action_wait_count
        OR wait.row_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'actionId', wait.action_id, 'consentId', wait.consent_id,
          'actionKind', wait.action_kind, 'state', wait.state,
          'sequenceNo', wait.sequence_no, 'runtimeEpoch', wait.runtime_epoch,
          'actionKeyDigest', wait.action_key_digest,
          'deadlineAt', wait.deadline_at
        ))
        OR wait.quiescence_snapshot_digest <> tabhub_sha256_v1(json_object(
          'intentKey', wait.intent_key, 'ordinal', wait.ordinal,
          'rowDigest', wait.row_digest,
          'resolutionStartSequenceNo', wait.resolution_start_sequence_no,
          'resolutionStartEventDigest', wait.resolution_start_event_digest,
          'resolutionStartedAt', wait.resolution_started_at,
          'resolutionDeadlineAt', wait.resolution_deadline_at
        ))
        OR (wait.state = 'resolution_started' AND (
          wait.resolution_start_sequence_no <> wait.sequence_no
          OR wait.resolution_started_at IS NULL
          OR wait.resolution_deadline_at <> strftime(
            '%Y-%m-%dT%H:%M:%fZ', wait.resolution_started_at, '+3 seconds'
          )
        ))
        OR (wait.state <> 'resolution_started' AND (
          wait.resolution_start_sequence_no IS NOT NULL
          OR wait.resolution_start_event_digest IS NOT NULL
          OR wait.resolution_started_at IS NOT NULL
          OR wait.resolution_deadline_at IS NOT NULL
        ))
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge action quiescence invariant failed');
END;

CREATE TRIGGER privacy_purge_intent_job_waits_insert_guard
BEFORE INSERT ON privacy_purge_intent_job_waits
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NEW.row_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'jobId', NEW.job_id, 'status', NEW.status,
  'eventSequence', NEW.event_sequence,
  'cancellationRequestedBy', NEW.cancellation_requested_by,
  'cancellationRequestedAt', NEW.cancellation_requested_at,
  'attemptId', NEW.attempt_id,
  'attemptNo', NEW.attempt_no, 'workerId', NEW.worker_id,
  'leaseTokenDigest', NEW.lease_token_digest,
  'leaseExpiresAt', NEW.lease_expires_at, 'requestBound', NEW.request_bound,
  'requestIdDigest', NEW.request_id_digest,
  'requestBoundAt', NEW.request_bound_at, 'provider', NEW.provider,
  'model', NEW.model, 'promptVersion', NEW.prompt_version,
  'pricingVersion', NEW.pricing_version,
  'providerAdoptionUtcDate', NEW.provider_adoption_utc_date,
  'providerAdoptedAt', NEW.provider_adopted_at,
  'providerReservationId', NEW.provider_reservation_id,
  'providerReservationUtcDate', NEW.provider_reservation_utc_date,
  'providerReservedUsd', NEW.provider_reserved_usd,
  'providerConsumedUsd', NEW.provider_consumed_usd,
  'providerReservationStatus', NEW.provider_reservation_status,
  'settlementDeadlineAt', NEW.settlement_deadline_at,
  'providerUsageState', NEW.provider_usage_state
))
OR NEW.cancellation_snapshot_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'jobId', NEW.job_id,
  'eventSequence', NEW.event_sequence,
  'cancellationRequestedBy', NEW.cancellation_requested_by,
  'cancellationRequestedAt', NEW.cancellation_requested_at
))
OR tabhub_purge26_job_row_v1(
  NEW.intent_key, NEW.ordinal, NEW.job_id, NEW.status,
  NEW.event_sequence, NEW.cancellation_requested_by,
  NEW.cancellation_requested_at, NEW.cancellation_snapshot_digest,
  NEW.attempt_id, NEW.attempt_no, NEW.worker_id,
  NEW.lease_token_digest, NEW.lease_expires_at, NEW.request_bound,
  NEW.request_id_digest, NEW.request_bound_at, NEW.provider, NEW.model,
  NEW.prompt_version, NEW.pricing_version,
  NEW.provider_adoption_utc_date, NEW.provider_adopted_at,
  NEW.provider_reservation_id, NEW.provider_reservation_utc_date,
  NEW.provider_reserved_usd, NEW.provider_consumed_usd,
  NEW.provider_reservation_status, NEW.settlement_deadline_at,
  NEW.provider_usage_state, NEW.row_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge job snapshot requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_job_waits_terminal_update
BEFORE UPDATE ON privacy_purge_intent_job_waits
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1 OR NOT (
  NEW.intent_key IS OLD.intent_key AND NEW.ordinal IS OLD.ordinal
  AND NEW.job_id IS OLD.job_id AND NEW.status IS OLD.status
  AND NEW.event_sequence IS OLD.event_sequence AND NEW.attempt_id IS OLD.attempt_id
  AND NEW.cancellation_requested_by IS OLD.cancellation_requested_by
  AND NEW.cancellation_requested_at IS OLD.cancellation_requested_at
  AND NEW.cancellation_snapshot_digest IS OLD.cancellation_snapshot_digest
  AND NEW.attempt_no IS OLD.attempt_no AND NEW.worker_id IS OLD.worker_id
  AND NEW.lease_token_digest IS OLD.lease_token_digest
  AND NEW.lease_expires_at IS OLD.lease_expires_at
  AND NEW.request_bound IS OLD.request_bound
  AND NEW.request_id_digest IS OLD.request_id_digest
  AND NEW.request_bound_at IS OLD.request_bound_at
  AND NEW.provider IS OLD.provider AND NEW.model IS OLD.model
  AND NEW.prompt_version IS OLD.prompt_version
  AND NEW.pricing_version IS OLD.pricing_version
  AND NEW.provider_adoption_utc_date IS OLD.provider_adoption_utc_date
  AND NEW.provider_adopted_at IS OLD.provider_adopted_at
  AND NEW.provider_reservation_id IS OLD.provider_reservation_id
  AND NEW.provider_reservation_utc_date IS OLD.provider_reservation_utc_date
  AND NEW.provider_reserved_usd IS OLD.provider_reserved_usd
  AND NEW.provider_consumed_usd IS OLD.provider_consumed_usd
  AND NEW.provider_reservation_status IS OLD.provider_reservation_status
  AND NEW.settlement_deadline_at IS OLD.settlement_deadline_at
  AND NEW.provider_usage_state IS OLD.provider_usage_state
  AND NEW.row_digest IS OLD.row_digest
  AND OLD.terminal_status IS NULL AND OLD.terminal_event_sequence IS NULL
  AND OLD.terminal_attempt_outcome IS NULL AND OLD.terminal_usage_digest IS NULL
  AND OLD.terminal_proof_digest IS NULL
  AND OLD.terminal_reservation_state IS NULL AND OLD.terminal_at IS NULL
  AND NEW.terminal_status IS NOT NULL AND NEW.terminal_event_sequence IS NOT NULL
  AND NEW.terminal_usage_digest IS NOT NULL
  AND NEW.terminal_reservation_state IS NOT NULL AND NEW.terminal_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM privacy_purge_intents AS intent
    WHERE intent.intent_key = OLD.intent_key AND intent.status = 'waiting'
  )
  AND EXISTS (
    SELECT 1
    FROM ai_jobs AS job
    JOIN ai_job_events AS event ON event.job_id = job.id
    LEFT JOIN ai_job_attempts AS attempt ON attempt.id = OLD.attempt_id
    LEFT JOIN live_acquisition_provider_reservations AS reservation
      ON reservation.id = OLD.provider_reservation_id
    WHERE job.id = OLD.job_id AND job.status = NEW.terminal_status
      AND event.event_type IN ('failed', 'cancelled')
      AND job.event_sequence = NEW.terminal_event_sequence
      AND job.updated_at = NEW.terminal_at
      AND event.sequence_no = NEW.terminal_event_sequence
      AND event.to_status = NEW.terminal_status
      AND event.occurred_at = NEW.terminal_at
      AND NOT EXISTS (
        SELECT 1 FROM ai_job_events AS newer
        WHERE newer.job_id = event.job_id AND newer.sequence_no > event.sequence_no
      )
      AND (OLD.request_bound = 0 OR EXISTS (
        SELECT 1 FROM ai_job_events AS known_usage
        WHERE known_usage.job_id = OLD.job_id
          AND known_usage.attempt_id = OLD.attempt_id
          AND known_usage.event_type = 'progress'
          AND known_usage.sequence_no > OLD.event_sequence
          AND known_usage.sequence_no < event.sequence_no
          AND known_usage.delta_steps > 0
          AND known_usage.occurred_at <= OLD.settlement_deadline_at
          AND tabhub_sha256_v1(known_usage.lease_token)
            = OLD.lease_token_digest
      ))
      AND ((OLD.attempt_id IS NULL AND attempt.id IS NULL
          AND NEW.terminal_attempt_outcome IS NULL)
        OR (OLD.attempt_id IS NOT NULL AND attempt.id = OLD.attempt_id
          AND attempt.job_id = OLD.job_id
          AND attempt.outcome = NEW.terminal_attempt_outcome
          AND attempt.outcome <> 'running'))
      AND ((OLD.provider_reservation_id IS NULL AND reservation.id IS NULL
          AND NEW.terminal_reservation_state = 'none')
        OR (OLD.provider_reservation_id IS NOT NULL
          AND reservation.id = OLD.provider_reservation_id
          AND reservation.final_job_id = OLD.job_id
          AND reservation.status = NEW.terminal_reservation_state
          AND reservation.status IN ('released', 'consumed')))
      AND NEW.terminal_usage_digest = tabhub_sha256_v1(json_object(
        'attemptId', attempt.id, 'attemptJobId', attempt.job_id,
        'attemptNo', attempt.attempt_no, 'attemptLeaseToken', attempt.lease_token,
        'workerId', attempt.worker_id, 'provider', attempt.provider,
        'model', attempt.model, 'promptVersion', attempt.prompt_version,
        'providerBoundAt', attempt.provider_bound_at,
        'requestId', attempt.request_id,
        'requestBoundAt', attempt.request_bound_at,
        'attemptStartedAt', attempt.started_at,
        'attemptCompletedAt', attempt.completed_at,
        'attemptOutcome', attempt.outcome,
        'inputTokens', attempt.input_tokens,
        'outputTokens', attempt.output_tokens, 'costUsd', attempt.cost_usd,
        'attemptErrorCode', attempt.error_code,
        'attemptErrorMessage', attempt.error_message,
        'pricingVersion', attempt.pricing_version,
        'reservationId', reservation.id,
        'handoffId', reservation.handoff_id,
        'reservationFinalJobId', reservation.final_job_id,
        'utcDate', reservation.utc_date,
        'reservedUsd', reservation.reserved_usd,
        'consumedUsd', reservation.consumed_usd,
        'reservationStatus', reservation.status,
        'reservationCreatedAt', reservation.created_at,
        'reservationTerminalAt', reservation.terminal_at,
        'knownUsageEventDigest', (
          SELECT tabhub_sha256_v1(json_object(
            'id', known.id, 'jobId', known.job_id,
            'sequenceNo', known.sequence_no, 'eventType', known.event_type,
            'fromStatus', known.from_status, 'toStatus', known.to_status,
            'attemptId', known.attempt_id, 'leaseOwner', known.lease_owner,
            'leaseToken', known.lease_token,
            'leaseExpiresAt', known.lease_expires_at,
            'progressCompleted', known.progress_completed,
            'progressTotal', known.progress_total,
            'progressStage', known.progress_stage,
            'checkpointJson', known.checkpoint_json,
            'cancellationRequestedBy', known.cancellation_requested_by,
            'resultType', known.result_type,
            'resultOutputFingerprint', known.result_output_fingerprint,
            'resultReportId', known.result_report_id,
            'errorCode', known.error_code, 'availableAt', known.available_at,
            'spentSteps', known.spent_steps, 'spentTokens', known.spent_tokens,
            'spentInputTokens', known.spent_input_tokens,
            'spentOutputTokens', known.spent_output_tokens,
            'deltaInputTokens', known.delta_input_tokens,
            'deltaOutputTokens', known.delta_output_tokens,
            'deltaCostUsd', known.delta_cost_usd,
            'deltaSteps', known.delta_steps,
            'deltaWallTimeMs', known.delta_wall_time_ms,
            'spentCostUsd', known.spent_cost_usd,
            'spentWallTimeMs', known.spent_wall_time_ms,
            'occurredAt', known.occurred_at
          ))
          FROM ai_job_events AS known
          WHERE known.job_id = OLD.job_id
            AND known.attempt_id = OLD.attempt_id
            AND known.event_type = 'progress'
            AND known.sequence_no > OLD.event_sequence
            AND known.sequence_no < event.sequence_no
            AND known.delta_steps > 0
            AND known.occurred_at <= OLD.settlement_deadline_at
            AND tabhub_sha256_v1(known.lease_token) = OLD.lease_token_digest
          ORDER BY known.sequence_no DESC LIMIT 1
        )
      ))
      AND NEW.terminal_proof_digest = tabhub_sha256_v1(json_object(
        'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
        'rowDigest', NEW.row_digest, 'terminalStatus', NEW.terminal_status,
        'terminalEventSequence', NEW.terminal_event_sequence,
        'terminalEventDigest', tabhub_sha256_v1(json_object(
          'id', event.id, 'jobId', event.job_id,
          'sequenceNo', event.sequence_no, 'eventType', event.event_type,
          'fromStatus', event.from_status, 'toStatus', event.to_status,
          'attemptId', event.attempt_id, 'leaseOwner', event.lease_owner,
          'leaseToken', event.lease_token,
          'leaseExpiresAt', event.lease_expires_at,
          'progressCompleted', event.progress_completed,
          'progressTotal', event.progress_total,
          'progressStage', event.progress_stage,
          'checkpointJson', event.checkpoint_json,
          'cancellationRequestedBy', event.cancellation_requested_by,
          'resultType', event.result_type,
          'resultOutputFingerprint', event.result_output_fingerprint,
          'resultReportId', event.result_report_id,
          'errorCode', event.error_code, 'availableAt', event.available_at,
          'spentSteps', event.spent_steps, 'spentTokens', event.spent_tokens,
          'spentInputTokens', event.spent_input_tokens,
          'spentOutputTokens', event.spent_output_tokens,
          'deltaInputTokens', event.delta_input_tokens,
          'deltaOutputTokens', event.delta_output_tokens,
          'deltaCostUsd', event.delta_cost_usd,
          'deltaSteps', event.delta_steps,
          'deltaWallTimeMs', event.delta_wall_time_ms,
          'spentCostUsd', event.spent_cost_usd,
          'spentWallTimeMs', event.spent_wall_time_ms,
          'occurredAt', event.occurred_at
        )),
        'terminalAttemptOutcome', NEW.terminal_attempt_outcome,
        'terminalUsageDigest', NEW.terminal_usage_digest,
        'terminalReservationState', NEW.terminal_reservation_state,
        'settlementProofGeneration', (
          SELECT settlement_proof_generation FROM privacy_purge_intents
          WHERE intent_key = OLD.intent_key
        ),
        'terminalAt', NEW.terminal_at
      ))
  )
  AND tabhub_purge26_job_terminal_v1(
    OLD.intent_key, OLD.ordinal, OLD.job_id, OLD.row_digest,
    NEW.terminal_status, NEW.terminal_event_sequence,
    NEW.terminal_attempt_outcome, NEW.terminal_usage_digest,
    NEW.terminal_reservation_state, NEW.terminal_at,
    NEW.terminal_proof_digest
  ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge job terminal proof');
END;

CREATE TRIGGER privacy_purge_intent_job_waits_delete_guard
BEFORE DELETE ON privacy_purge_intent_job_waits
BEGIN
  SELECT RAISE(ABORT, 'privacy purge job snapshots are permanent');
END;

CREATE TRIGGER privacy_purge_intent_execution_targets_insert_guard
BEFORE INSERT ON privacy_purge_intent_execution_targets
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR tabhub_pk_v1_canonical(NEW.pk_v1) <> 1
OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_intents AS intent
  WHERE intent.intent_key = NEW.intent_key AND intent.status = 'waiting'
)
OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_target_catalog AS catalog
  WHERE catalog.table_name = NEW.table_name
    AND catalog.delete_rank = NEW.delete_rank
)
OR NOT EXISTS (
  SELECT 1 FROM privacy_purge26_expected_execution_targets AS expected
  WHERE expected.intent_key = NEW.intent_key
    AND expected.ordinal = NEW.ordinal
    AND expected.table_name = NEW.table_name
    AND expected.pk_v1 = NEW.pk_v1
    AND expected.delete_rank = NEW.delete_rank
    AND expected.live_action_depth IS NEW.live_action_depth
    AND expected.row_digest = NEW.row_digest
)
OR NEW.row_digest <> tabhub_sha256_v1(json_object(
  'intentKey', NEW.intent_key, 'ordinal', NEW.ordinal,
  'tableName', NEW.table_name, 'pkV1', NEW.pk_v1,
  'deleteRank', NEW.delete_rank, 'liveActionDepth', NEW.live_action_depth
))
OR tabhub_purge26_execution_row_v1(
  NEW.intent_key, NEW.ordinal, NEW.table_name, NEW.pk_v1,
  NEW.delete_rank, NEW.live_action_depth, NEW.row_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge execution plan requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_execution_targets_update_guard
BEFORE UPDATE ON privacy_purge_intent_execution_targets
BEGIN
  SELECT RAISE(ABORT, 'privacy purge execution targets are immutable');
END;

CREATE TRIGGER privacy_purge_intent_execution_targets_delete_guard
BEFORE DELETE ON privacy_purge_intent_execution_targets
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_intent_receipts AS receipt
  JOIN privacy_purge_intents AS intent ON intent.intent_key = receipt.intent_key
  WHERE receipt.intent_key = OLD.intent_key AND intent.status = 'committed'
    AND receipt.outcome = 'completed'
)
OR tabhub_purge26_execution_cleanup_v1(
  OLD.intent_key, OLD.ordinal, OLD.table_name, OLD.pk_v1,
  OLD.delete_rank, OLD.live_action_depth, OLD.row_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge execution plan cleanup requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_receipts_insert_guard
BEFORE INSERT ON privacy_purge_intent_receipts
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR NOT (
  (
  NEW.origin = 'schema26' AND EXISTS (
  SELECT 1
  FROM privacy_purge_intents AS intent
  JOIN privacy_purge_commands AS command
    ON command.id = intent.purge_command_id
  JOIN privacy_purge_results AS result
    ON result.command_id = command.id
  WHERE intent.intent_key = NEW.intent_key
    AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.purge_command_id
    AND command.status = NEW.outcome
    AND result.outcome = NEW.outcome
    AND result.result_digest = NEW.result_digest
    AND intent.result_digest = NEW.result_digest
    AND result.completed_at = NEW.completed_at
    AND result.safe_counts_json = NEW.safe_counts_json
    AND intent.execution_target_count = NEW.execution_target_count
    AND intent.execution_plan_digest = NEW.execution_plan_digest
    AND NEW.wait_terminal_digest = tabhub_sha256_v1(json_object(
      'actions', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'actionId', action_id, 'state', terminal_state,
            'sequenceNo', terminal_sequence_no,
            'eventDigest', terminal_event_digest,
            'proofDigest', terminal_proof_digest, 'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_action_waits
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]'),
      'jobs', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'jobId', job_id, 'status', terminal_status,
            'eventSequence', terminal_event_sequence,
            'attemptOutcome', terminal_attempt_outcome,
            'usageDigest', terminal_usage_digest,
            'proofDigest', terminal_proof_digest,
            'reservationState', terminal_reservation_state,
            'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_job_waits
          WHERE intent_key = NEW.intent_key ORDER BY ordinal
        )
      ), '[]')
    ))
    AND intent.terminal_evidence_digest = tabhub_sha256_v1(json_object(
      'waitTerminalDigest', NEW.wait_terminal_digest,
      'settlementProofGeneration', intent.settlement_proof_generation,
      'settlementEvidenceDigest', intent.settlement_evidence_digest
    ))
    AND intent.carryover_manifest_count = (
      SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
      WHERE intent_key = NEW.intent_key AND state = 'frozen'
    )
    AND intent.carryover_manifest_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'intentKey', intent_key, 'utcDate', utc_date,
          'budgetClass', budget_class, 'jobKind', job_kind,
          'workflowId', workflow_id, 'workflowVersion', workflow_version,
          'coordinatorStarts', coordinator_starts,
          'providerAttempts', provider_attempts,
          'chargedCostNanos', charged_cost_nanos,
          'activeExposureNanos', active_exposure_nanos,
          'legacy25DayBlock', legacy25_day_block,
          'payloadDigest', payload_digest, 'frozenAt', frozen_at
        ) AS row_json
        FROM privacy_purge_budget_carryover_days
        WHERE intent_key = NEW.intent_key AND state = 'frozen'
        ORDER BY utc_date, budget_class, job_kind, workflow_id, workflow_version
      )
    ), '[]'))
  ))
  OR (
    NEW.origin = 'legacy25' AND EXISTS (
      SELECT 1
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_commands AS command
        ON command.id = intent.purge_command_id
      JOIN privacy_purge_results AS result
        ON result.command_id = command.id
      WHERE intent.intent_key = NEW.intent_key
        AND intent.origin = 'legacy25' AND intent.status = NEW.outcome
        AND command.id = NEW.purge_command_id AND command.status = NEW.outcome
        AND result.outcome = NEW.outcome
        AND result.safe_counts_json = NEW.safe_counts_json
        AND result.result_digest = NEW.result_digest
        AND result.completed_at = NEW.completed_at
        AND NEW.execution_target_count = command.deletion_target_count
        AND NEW.execution_plan_digest = command.deletion_plan_digest
        AND NEW.wait_terminal_digest = intent.wait_snapshot_digest
    )
  )
)
OR tabhub_purge26_receipt_row_v1(
  NEW.intent_key, NEW.outcome, NEW.origin, NEW.purge_command_id,
  NEW.safe_counts_json, NEW.execution_target_count,
  NEW.execution_plan_digest, NEW.result_digest,
  NEW.wait_terminal_digest, NEW.completed_at
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge receipt requires exact local capability');
END;

CREATE TRIGGER privacy_purge_intent_receipts_immutable_update
BEFORE UPDATE ON privacy_purge_intent_receipts
BEGIN
  SELECT RAISE(ABORT, 'privacy purge intent receipts are immutable');
END;

CREATE TRIGGER privacy_purge_intent_receipts_immutable_delete
BEFORE DELETE ON privacy_purge_intent_receipts
BEGIN
  SELECT RAISE(ABORT, 'privacy purge intent receipts are permanent');
END;

CREATE TRIGGER privacy_purge_mutation_fence_catalog_insert_guard
BEFORE INSERT ON privacy_purge_mutation_fence_catalog
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR tabhub_purge26_catalog_row_v1(
  NEW.table_name, NEW.operation, NEW.owner_group,
  NEW.old_owner_predicate_digest, NEW.new_owner_predicate_digest,
  NEW.exception_class, NEW.trigger_name, NEW.trigger_sql_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge mutation fence catalog is runner-owned');
END;

CREATE TRIGGER privacy_purge_mutation_fence_catalog_immutable_update
BEFORE UPDATE ON privacy_purge_mutation_fence_catalog
BEGIN
  SELECT RAISE(ABORT, 'privacy purge mutation fence catalog is frozen');
END;

CREATE TRIGGER privacy_purge_mutation_fence_catalog_immutable_delete
BEFORE DELETE ON privacy_purge_mutation_fence_catalog
BEGIN
  SELECT RAISE(ABORT, 'privacy purge mutation fence catalog is frozen');
END;

-- Once schema 026 exists, no caller may create a schema-25 command directly.
-- A ready intent and the matching one-shot connection-local link capability are
-- both required. The 025 AFTER INSERT lifecycle freeze remains unchanged.
CREATE TRIGGER privacy_purge26_commands_insert_gate
BEFORE INSERT ON privacy_purge_commands
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
OR tabhub_purge26_command_link_v1(
  (SELECT intent_key FROM privacy_purge_intents AS ready_intent
    WHERE ready_intent.status = 'ready'
      AND ready_intent.idempotency_key_hash = NEW.idempotency_key_hash
      AND ready_intent.request_fingerprint = NEW.request_fingerprint),
  NEW.idempotency_key_hash, NEW.request_fingerprint, NEW.target_kind,
  NEW.subject_generation_id, NEW.history_epoch_id,
  NEW.deletion_target_count, NEW.deletion_plan_digest
) <> 1
OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_intents AS intent
  WHERE intent.status = 'ready' AND intent.origin = 'schema26'
    AND intent.idempotency_key_hash = NEW.idempotency_key_hash
    AND intent.request_fingerprint = NEW.request_fingerprint
    AND intent.target_kind = NEW.target_kind
    AND intent.subject_generation_id IS NEW.subject_generation_id
    AND intent.history_epoch_id IS NEW.history_epoch_id
    AND intent.execution_target_count = NEW.deletion_target_count
    AND intent.execution_plan_digest = NEW.deletion_plan_digest
)
BEGIN
  SELECT RAISE(ABORT, 'schema26 privacy purge command requires a ready linked intent');
END;

-- Linking is part of the command INSERT statement.  This removes the otherwise
-- observable ready-command gap and leaves the unchanged schema-25 lifecycle
-- freeze triggers free to finish their same-statement command projection.
CREATE TRIGGER privacy_purge26_commands_atomic_link
AFTER INSERT ON privacy_purge_commands
BEGIN
  UPDATE privacy_purge_intents
  SET purge_command_id = NEW.id, status = 'committed', updated_at = NEW.created_at
  WHERE origin = 'schema26' AND status = 'ready'
    AND idempotency_key_hash = NEW.idempotency_key_hash
    AND request_fingerprint = NEW.request_fingerprint
    AND target_kind = NEW.target_kind
    AND subject_generation_id IS NEW.subject_generation_id
    AND history_epoch_id IS NEW.history_epoch_id
    AND execution_target_count = NEW.deletion_target_count
    AND execution_plan_digest = NEW.deletion_plan_digest;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'schema26 privacy purge command link failed')
  END;
END;

-- The unchanged schema-25 executor inserts privacy_purge_results and then
-- terminalizes privacy_purge_commands in the same transaction.  Completing the
-- linked schema-26 intent here therefore shares that exact commit boundary.  A
-- failed command is deliberately rejected: schema-26 committed work remains
-- retryable and can never acquire a misleading terminal receipt.
CREATE TRIGGER privacy_purge26_commands_atomic_finalize
AFTER UPDATE OF status ON privacy_purge_commands
WHEN OLD.status IN ('pending', 'waiting')
  AND NEW.status IN ('completed', 'failed')
  AND EXISTS (
    SELECT 1 FROM privacy_purge_intents AS intent
    WHERE intent.origin = 'schema26' AND intent.status = 'committed'
      AND intent.purge_command_id = NEW.id
  )
BEGIN
  SELECT CASE WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
    OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
    THEN RAISE(ABORT, 'schema26 privacy purge finalization requires safe pragmas')
  END;
  SELECT CASE WHEN NEW.status <> 'completed'
    THEN RAISE(ABORT, 'schema26 privacy purge failed command remains retryable')
  END;

  INSERT INTO privacy_purge_intent_receipts (
    intent_key, outcome, origin, purge_command_id, safe_counts_json,
    execution_target_count, execution_plan_digest, result_digest,
    wait_terminal_digest, completed_at
  )
  SELECT intent.intent_key, 'completed', intent.origin, NEW.id,
    result.safe_counts_json, intent.execution_target_count,
    intent.execution_plan_digest, result.result_digest,
    tabhub_sha256_v1(json_object(
      'actions', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'actionId', action_id, 'state', terminal_state,
            'sequenceNo', terminal_sequence_no,
            'eventDigest', terminal_event_digest,
            'proofDigest', terminal_proof_digest, 'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_action_waits
          WHERE intent_key = intent.intent_key ORDER BY ordinal
        )
      ), '[]'),
      'jobs', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'jobId', job_id, 'status', terminal_status,
            'eventSequence', terminal_event_sequence,
            'attemptOutcome', terminal_attempt_outcome,
            'usageDigest', terminal_usage_digest,
            'proofDigest', terminal_proof_digest,
            'reservationState', terminal_reservation_state,
            'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_job_waits
          WHERE intent_key = intent.intent_key ORDER BY ordinal
        )
      ), '[]')
    )), result.completed_at
  FROM privacy_purge_intents AS intent
  JOIN privacy_purge_results AS result ON result.command_id = NEW.id
  WHERE intent.origin = 'schema26' AND intent.status = 'committed'
    AND intent.purge_command_id = NEW.id AND result.outcome = 'completed';

  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'schema26 privacy purge receipt finalization failed')
  END;

  UPDATE privacy_purge_budget_carryover_days
  SET state = 'active', activated_at = (
    SELECT completed_at FROM privacy_purge_results WHERE command_id = NEW.id
  )
  WHERE intent_key = (
    SELECT intent_key FROM privacy_purge_intents
    WHERE origin = 'schema26' AND status = 'committed'
      AND purge_command_id = NEW.id
  ) AND state = 'frozen';

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM privacy_purge_budget_carryover_days AS carryover
    JOIN privacy_purge_intents AS intent
      ON intent.intent_key = carryover.intent_key
    WHERE intent.origin = 'schema26' AND intent.status = 'committed'
      AND intent.purge_command_id = NEW.id AND carryover.state <> 'active'
  ) THEN RAISE(ABORT, 'schema26 privacy purge carryover activation failed') END;

  DELETE FROM privacy_purge_intent_execution_targets
  WHERE intent_key = (
    SELECT intent_key FROM privacy_purge_intents
    WHERE origin = 'schema26' AND status = 'committed'
      AND purge_command_id = NEW.id
  );

  UPDATE privacy_purge_intents
  SET status = 'completed', updated_at = (
    SELECT completed_at FROM privacy_purge_results WHERE command_id = NEW.id
  )
  WHERE origin = 'schema26' AND status = 'committed'
    AND purge_command_id = NEW.id;

  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'schema26 privacy purge intent finalization failed')
  END;
  SELECT CASE WHEN tabhub_purge26_terminal_attest_v1(
    (SELECT intent_key FROM privacy_purge_intents
      WHERE origin = 'schema26' AND status = 'completed'
        AND purge_command_id = NEW.id),
    NEW.id,
    (SELECT result_digest FROM privacy_purge_results WHERE command_id = NEW.id)
  ) <> 1 THEN RAISE(
    ABORT, 'schema26 privacy purge terminal capability was not fully consumed'
  ) END;
END;
