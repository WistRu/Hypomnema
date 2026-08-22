CREATE TABLE privacy_subject_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL CHECK (
    subject_kind IN ('logical_page', 'resource', 'research_run')
  ),
  logical_page_id INTEGER REFERENCES logical_pages(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  resource_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  research_run_id INTEGER REFERENCES research_runs(id) ON DELETE SET NULL,
  generation_token TEXT NOT NULL UNIQUE CHECK (
    length(generation_token) = 64
      AND generation_token NOT GLOB '*[^0-9a-f]*'
  ),
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  retired_at TEXT CHECK (
    COALESCE(retired_at IS NULL OR (
      retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', retired_at)
      AND retired_at >= created_at
    ), 0)
  ),
  CHECK (
    (subject_kind = 'logical_page' AND resource_id IS NULL
      AND research_run_id IS NULL AND (logical_page_id IS NOT NULL OR is_active = 0))
    OR (subject_kind = 'resource' AND logical_page_id IS NULL
      AND research_run_id IS NULL AND (resource_id IS NOT NULL OR is_active = 0))
    OR (subject_kind = 'research_run' AND logical_page_id IS NULL
      AND resource_id IS NULL AND (research_run_id IS NOT NULL OR is_active = 0))
  ),
  CHECK (
    (is_active = 1 AND retired_at IS NULL)
    OR (is_active = 0 AND retired_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX privacy_subject_generations_active_page_idx
ON privacy_subject_generations(logical_page_id)
WHERE subject_kind = 'logical_page' AND is_active = 1;

CREATE UNIQUE INDEX privacy_subject_generations_active_resource_idx
ON privacy_subject_generations(resource_id)
WHERE subject_kind = 'resource' AND is_active = 1;

CREATE UNIQUE INDEX privacy_subject_generations_active_run_idx
ON privacy_subject_generations(research_run_id)
WHERE subject_kind = 'research_run' AND is_active = 1;

INSERT INTO privacy_subject_generations (
  subject_kind, logical_page_id, generation_token, is_active, created_at
)
SELECT 'logical_page', id, lower(hex(randomblob(32))), 1, tabhub_migration_now()
FROM logical_pages ORDER BY id;

INSERT INTO privacy_subject_generations (
  subject_kind, resource_id, generation_token, is_active, created_at
)
SELECT 'resource', id, lower(hex(randomblob(32))), 1, tabhub_migration_now()
FROM resources ORDER BY id;

INSERT INTO privacy_subject_generations (
  subject_kind, research_run_id, generation_token, is_active, created_at
)
SELECT 'research_run', id, lower(hex(randomblob(32))), 1, tabhub_migration_now()
FROM research_runs ORDER BY id;

CREATE TABLE research_history_epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  resource_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  epoch_no INTEGER NOT NULL CHECK (epoch_no > 0),
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  retired_at TEXT CHECK (
    COALESCE(retired_at IS NULL OR (
      retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', retired_at)
      AND retired_at >= created_at
    ), 0)
  ),
  UNIQUE (resource_id, epoch_no),
  UNIQUE (id, resource_id),
  CHECK (
    (is_active = 1 AND retired_at IS NULL)
    OR (is_active = 0 AND retired_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX research_history_epochs_active_resource_idx
ON research_history_epochs(resource_id) WHERE is_active = 1;

CREATE TRIGGER research_history_epochs_resource_generation_guard
BEFORE INSERT ON research_history_epochs
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_subject_generations AS generation
  WHERE generation.id = NEW.resource_generation_id
    AND generation.subject_kind = 'resource'
    AND generation.resource_id = NEW.resource_id
    AND generation.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research history epoch generation must own its resource');
END;

INSERT INTO research_history_epochs (
  resource_id, resource_generation_id, epoch_no, is_active, created_at
)
SELECT generation.resource_id, generation.id, 1, 1, tabhub_migration_now()
FROM privacy_subject_generations AS generation
WHERE generation.subject_kind = 'resource' AND generation.is_active = 1
ORDER BY generation.resource_id;

DROP TRIGGER research_runs_immutable_update;

ALTER TABLE research_runs ADD COLUMN history_epoch_id INTEGER
  REFERENCES research_history_epochs(id) ON DELETE RESTRICT;

UPDATE research_runs
SET history_epoch_id = (
  SELECT history.id
  FROM research_history_epochs AS history
  WHERE history.resource_id = research_runs.target_resource_id
    AND history.is_active = 1
)
WHERE target_resource_id IS NOT NULL;

CREATE TEMP TABLE research_run_history_epoch_backfill_assertion (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO research_run_history_epoch_backfill_assertion (invalid_count)
SELECT COUNT(*)
FROM research_runs AS run
LEFT JOIN research_history_epochs AS history
  ON history.id = run.history_epoch_id
LEFT JOIN privacy_subject_generations AS resource_generation
  ON resource_generation.id = history.resource_generation_id
WHERE (run.target_resource_id IS NULL) <> (run.history_epoch_id IS NULL)
  OR (run.target_resource_id IS NOT NULL AND (
    history.id IS NULL OR history.resource_id <> run.target_resource_id
    OR history.is_active <> 1
    OR resource_generation.subject_kind <> 'resource'
    OR resource_generation.resource_id <> run.target_resource_id
    OR resource_generation.is_active <> 1
  ));

DROP TABLE research_run_history_epoch_backfill_assertion;

CREATE INDEX research_runs_history_epoch_idx
ON research_runs(history_epoch_id) WHERE history_epoch_id IS NOT NULL;

CREATE TRIGGER research_runs_history_epoch_insert_guard
BEFORE INSERT ON research_runs
WHEN NOT (
  (NEW.target_resource_id IS NULL AND NEW.history_epoch_id IS NULL)
  OR EXISTS (
    SELECT 1 FROM research_history_epochs AS history
    JOIN privacy_subject_generations AS resource_generation
      ON resource_generation.id = history.resource_generation_id
    WHERE history.id = NEW.history_epoch_id
      AND history.resource_id = NEW.target_resource_id
      AND history.is_active = 1
      AND resource_generation.subject_kind = 'resource'
      AND resource_generation.resource_id = NEW.target_resource_id
      AND resource_generation.is_active = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research run must bind its target resource history epoch');
END;

CREATE TRIGGER research_runs_immutable_update
BEFORE UPDATE ON research_runs
BEGIN
  SELECT RAISE(ABORT, 'research runs are immutable');
END;

CREATE TABLE live_acquisition_runtime_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  off_recovery_marker TEXT NOT NULL CHECK (
    off_recovery_marker IN ('pending', 'completed')
  ),
  updated_at TEXT NOT NULL CHECK (
    COALESCE(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), 0)
  )
) STRICT;

INSERT INTO live_acquisition_runtime_state (
  singleton_id, runtime_epoch, off_recovery_marker, updated_at
) VALUES (1, 1, 'pending', tabhub_migration_now());

CREATE TRIGGER live_acquisition_runtime_state_no_insert
BEFORE INSERT ON live_acquisition_runtime_state
WHEN EXISTS (SELECT 1 FROM live_acquisition_runtime_state)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition runtime state is singleton authority');
END;

CREATE TRIGGER live_acquisition_runtime_state_no_delete
BEFORE DELETE ON live_acquisition_runtime_state
BEGIN
  SELECT RAISE(ABORT, 'live acquisition runtime state is singleton authority');
END;

CREATE TRIGGER live_acquisition_runtime_state_validate_update
BEFORE UPDATE ON live_acquisition_runtime_state
WHEN NEW.singleton_id IS NOT OLD.singleton_id
  OR NEW.runtime_epoch < OLD.runtime_epoch
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition runtime state update');
END;

CREATE TABLE live_acquisition_handoffs (
  id INTEGER PRIMARY KEY,
  coordinator_run_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  final_run_id INTEGER NOT NULL UNIQUE
    REFERENCES research_runs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('assembling', 'completed')),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  completed_at TEXT CHECK (
    COALESCE(completed_at IS NULL OR (
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
      AND completed_at >= created_at
    ), 0)
  ),
  UNIQUE (coordinator_run_generation_id),
  CHECK (
    (status = 'assembling' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER live_acquisition_handoffs_insert_guard
BEFORE INSERT ON live_acquisition_handoffs
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_subject_generations AS coordinator_generation
  JOIN research_runs AS coordinator_run
    ON coordinator_run.id = coordinator_generation.research_run_id
  JOIN research_run_heads AS coordinator_head
    ON coordinator_head.run_id = coordinator_run.id
  JOIN ai_jobs AS coordinator_job ON coordinator_job.id = coordinator_run.job_id
  JOIN research_runs AS final_run ON final_run.id = NEW.final_run_id
  JOIN ai_jobs AS final_job ON final_job.id = final_run.job_id
  WHERE coordinator_generation.id = NEW.coordinator_run_generation_id
    AND coordinator_generation.subject_kind = 'research_run'
    AND coordinator_generation.is_active = 1
    AND coordinator_job.kind = 'resource_research'
    AND coordinator_job.workflow_id = 'research_acquisition:c90:v1'
    AND coordinator_job.workflow_version = 1
    AND coordinator_job.status = 'superseded'
    AND coordinator_head.status = 'superseded'
    AND coordinator_run.workflow_id = 'research_acquisition:c90:v1'
    AND coordinator_run.workflow_version = 1
    AND coordinator_run.history_epoch_id IS NOT NULL
    AND final_job.kind = 'resource_research'
    AND final_job.workflow_id = 'research_workflow:c81:v1'
    AND final_job.workflow_version = 1
    AND final_job.status = 'queued' AND final_job.event_sequence = 1
    AND final_run.workflow_id = 'research_workflow:c81:v1'
    AND final_run.workflow_version = 1
    AND final_run.history_epoch_id = coordinator_run.history_epoch_id
    AND final_run.target_resource_id = coordinator_run.target_resource_id
    AND final_job.resource_id = coordinator_job.resource_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition directed handoff header');
END;

CREATE TABLE live_acquisition_capture_manifests (
  id INTEGER PRIMARY KEY,
  consent_id INTEGER NOT NULL
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  logical_page_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  action_id INTEGER NOT NULL UNIQUE
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  reservation_id INTEGER NOT NULL UNIQUE,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 3),
  capture_sequence INTEGER NOT NULL CHECK (
    capture_sequence BETWEEN 1 AND 50
  ),
  url_digest TEXT NOT NULL CHECK (
    length(url_digest) = 64 AND url_digest NOT GLOB '*[^0-9a-f]*'
  ),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json) AND json_type(manifest_json) = 'object'
      AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  UNIQUE (consent_id, capture_sequence),
  UNIQUE (id, action_id),
  FOREIGN KEY (reservation_id, action_id)
    REFERENCES live_acquisition_page_reservations(id, action_id)
      ON DELETE RESTRICT
) STRICT;

CREATE TABLE live_acquisition_handoff_receipts (
  handoff_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_handoffs(id) ON DELETE RESTRICT,
  receipt_digest TEXT NOT NULL UNIQUE CHECK (
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at TEXT NOT NULL CHECK (
    COALESCE(completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at), 0)
  )
) STRICT;

CREATE TABLE live_acquisition_source_receipts (
  id INTEGER PRIMARY KEY,
  handoff_id INTEGER NOT NULL
    REFERENCES live_acquisition_handoffs(id) ON DELETE RESTRICT,
  final_run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
  logical_page_id INTEGER NOT NULL REFERENCES logical_pages(id) ON DELETE RESTRICT,
  logical_page_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  capture_manifest_id INTEGER
    REFERENCES live_acquisition_capture_manifests(id) ON DELETE RESTRICT,
  depth INTEGER CHECK (depth IS NULL OR depth BETWEEN 0 AND 3),
  capture_sequence INTEGER CHECK (
    capture_sequence IS NULL OR capture_sequence BETWEEN 1 AND 50
  ),
  inclusion_state TEXT NOT NULL CHECK (inclusion_state = 'included'),
  included_order INTEGER NOT NULL CHECK (included_order BETWEEN 1 AND 100),
  content_revision INTEGER NOT NULL CHECK (content_revision = 1),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  extracted_at TEXT NOT NULL CHECK (
    COALESCE(extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ', extracted_at), 0)
  ),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json) AND json_type(manifest_json) = 'object'
      AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  receipt_digest TEXT NOT NULL UNIQUE CHECK (
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  UNIQUE (final_run_id, ordinal),
  UNIQUE (final_run_id, logical_page_id),
  UNIQUE (final_run_id, included_order),
  UNIQUE (capture_manifest_id),
  CHECK (
    (capture_manifest_id IS NULL AND depth IS NULL AND capture_sequence IS NULL)
    OR (capture_manifest_id IS NOT NULL
      AND depth IS NOT NULL AND capture_sequence IS NOT NULL)
  ),
  UNIQUE (id, final_run_id)
) STRICT;

CREATE TRIGGER live_acquisition_source_receipts_safe_manifest_guard
BEFORE INSERT ON live_acquisition_source_receipts
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.manifest_json) AS manifest
  WHERE manifest.key NOT IN (
    'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
    'body_digest', 'response_metadata_digest', 'chunk_manifest_digest',
    'response_class', 'byte_length', 'redirect_count', 'truncated'
  ) OR (
    manifest.key IN (
      'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
      'body_digest', 'response_metadata_digest', 'chunk_manifest_digest'
    ) AND (manifest.type <> 'text' OR length(manifest.value) <> 64
      OR manifest.value GLOB '*[^0-9a-f]*')
  ) OR (
    manifest.key = 'response_class' AND (
      manifest.type <> 'text' OR manifest.value NOT IN (
        'informational', 'success', 'redirect', 'client_error', 'server_error'
      )
    )
  ) OR (
    manifest.key IN ('byte_length', 'redirect_count')
    AND (manifest.type <> 'integer' OR manifest.value < 0
      OR manifest.value > 9007199254740991)
  ) OR (
    manifest.key = 'truncated' AND manifest.type NOT IN ('true', 'false')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition source receipt manifest is not digest-only');
END;

CREATE TRIGGER live_acquisition_source_receipts_insert_guard
BEFORE INSERT ON live_acquisition_source_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_handoffs AS handoff
  JOIN privacy_subject_generations AS run_generation
    ON run_generation.id = handoff.coordinator_run_generation_id
  JOIN privacy_subject_generations AS page_generation
    ON page_generation.id = NEW.logical_page_generation_id
  WHERE handoff.id = NEW.handoff_id
    AND handoff.final_run_id = NEW.final_run_id
    AND handoff.status = 'assembling'
    AND run_generation.subject_kind = 'research_run'
    AND page_generation.subject_kind = 'logical_page'
    AND page_generation.logical_page_id = NEW.logical_page_id
    AND page_generation.is_active = 1
    AND (
      NEW.capture_manifest_id IS NULL OR EXISTS (
        SELECT 1 FROM live_acquisition_capture_manifests AS capture
        WHERE capture.id = NEW.capture_manifest_id
          AND capture.logical_page_generation_id = NEW.logical_page_generation_id
          AND capture.depth = NEW.depth
          AND capture.capture_sequence = NEW.capture_sequence
          AND capture.content_digest = NEW.content_digest
      )
    )
) OR EXISTS (
  SELECT 1 FROM live_acquisition_handoff_receipts
  WHERE handoff_id = NEW.handoff_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid or closed live acquisition source receipt');
END;

CREATE TRIGGER live_acquisition_source_receipts_immutable_update
BEFORE UPDATE ON live_acquisition_source_receipts
BEGIN
  SELECT RAISE(ABORT, 'live acquisition source receipts are immutable');
END;

CREATE TRIGGER live_acquisition_source_receipts_immutable_delete
BEFORE DELETE ON live_acquisition_source_receipts
BEGIN
  SELECT RAISE(ABORT, 'live acquisition source receipts are immutable');
END;

CREATE TABLE research_sources_new (
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
  source_kind TEXT NOT NULL DEFAULT 'captured' CHECK (
    source_kind IN ('captured', 'live_acquisition')
  ),
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN (
      'inventory', 'captured', 'exact_capture', 'safe_public_http_v1'
    )
  ),
  handoff_source_receipt_id INTEGER UNIQUE
    REFERENCES live_acquisition_source_receipts(id) ON DELETE RESTRICT,
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
    (source_kind = 'captured' AND handoff_source_receipt_id IS NULL
      AND acquisition_method IN ('inventory', 'captured', 'exact_capture') AND (
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
      ))
    OR (source_kind = 'live_acquisition'
      AND handoff_source_receipt_id IS NOT NULL
      AND tab_id IS NULL AND captured_tab_id_snapshot IS NULL
      AND acquisition_method = 'safe_public_http_v1'
      AND access_class_snapshot = 'public'
      AND eligibility = 'eligible' AND inclusion_state = 'included'
      AND content_revision = 1 AND content_digest IS NOT NULL
      AND extracted_at IS NOT NULL AND included_order IS NOT NULL
      AND failure_code IS NULL AND exclusion_reason IS NULL)
  )
) STRICT;

INSERT INTO research_sources_new (
  id, run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
  content_revision, content_digest, extracted_at, source_kind,
  acquisition_method, handoff_source_receipt_id, access_class_snapshot,
  eligibility, inclusion_state, exclusion_reason, included_order, failure_code,
  created_at
)
SELECT id, run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
  content_revision, content_digest, extracted_at, 'captured',
  acquisition_method, NULL, access_class_snapshot, eligibility, inclusion_state,
  exclusion_reason, included_order, failure_code, created_at
FROM research_sources ORDER BY id;

DROP TRIGGER research_source_payloads_insert_guard;
DROP TRIGGER research_report_sources_same_run;
DROP TRIGGER research_claim_evidence_same_run;
DROP TRIGGER contents_invalidate_research_sources_after_update;
DROP TRIGGER contents_invalidate_research_sources_after_delete;

DROP TABLE research_sources;
ALTER TABLE research_sources_new RENAME TO research_sources;

CREATE TRIGGER research_sources_live_capture_insert_guard
BEFORE INSERT ON research_sources
WHEN NEW.source_kind = 'captured'
  AND NEW.inclusion_state IN ('included', 'excluded') AND NEW.tab_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'captured research source requires live tab at submission');
END;

CREATE TRIGGER research_sources_live_receipt_insert_guard
BEFORE INSERT ON research_sources
WHEN NEW.source_kind = 'live_acquisition' AND NOT EXISTS (
  SELECT 1 FROM live_acquisition_source_receipts AS receipt
  JOIN live_acquisition_handoffs AS handoff ON handoff.id = receipt.handoff_id
  WHERE receipt.id = NEW.handoff_source_receipt_id
    AND receipt.final_run_id = NEW.run_id
    AND receipt.ordinal = NEW.ordinal
    AND receipt.logical_page_id = NEW.logical_page_id
    AND receipt.inclusion_state = NEW.inclusion_state
    AND receipt.included_order = NEW.included_order
    AND receipt.content_revision = NEW.content_revision
    AND receipt.content_digest = NEW.content_digest
    AND receipt.extracted_at = NEW.extracted_at
    AND handoff.status = 'assembling'
    AND NOT EXISTS (
      SELECT 1 FROM live_acquisition_handoff_receipts
      WHERE handoff_id = handoff.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'live research source does not match its open handoff receipt');
END;

CREATE UNIQUE INDEX research_sources_exact_identity_idx
ON research_sources(
  run_id, captured_tab_id_snapshot, content_revision, content_digest
)
WHERE source_kind = 'captured' AND captured_tab_id_snapshot IS NOT NULL
  AND content_revision IS NOT NULL AND content_digest IS NOT NULL;

CREATE INDEX research_sources_run_state_idx
ON research_sources(run_id, inclusion_state, ordinal);

CREATE TRIGGER research_sources_immutable_update
BEFORE UPDATE ON research_sources
WHEN NOT (
  OLD.source_kind = 'captured'
  AND OLD.tab_id IS NOT NULL AND NEW.tab_id IS NULL
  AND NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id
  AND NEW.ordinal IS OLD.ordinal
  AND NEW.logical_page_id IS OLD.logical_page_id
  AND NEW.captured_tab_id_snapshot IS OLD.captured_tab_id_snapshot
  AND NEW.content_revision IS OLD.content_revision
  AND NEW.content_digest IS OLD.content_digest
  AND NEW.extracted_at IS OLD.extracted_at
  AND NEW.source_kind IS OLD.source_kind
  AND NEW.acquisition_method IS OLD.acquisition_method
  AND NEW.handoff_source_receipt_id IS OLD.handoff_source_receipt_id
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

CREATE TRIGGER research_source_payloads_insert_guard
BEFORE INSERT ON research_source_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM research_sources AS source
  JOIN research_source_heads AS head ON head.source_id = source.id
  WHERE source.id = NEW.source_id AND source.inclusion_state = 'included'
    AND head.state = 'valid' AND (
      (source.source_kind = 'captured' AND source.tab_id IS NOT NULL)
      OR (source.source_kind = 'live_acquisition'
        AND source.handoff_source_receipt_id IS NOT NULL)
    )
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
  WHERE source.source_kind = 'captured' AND source.tab_id = NEW.tab_id;

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
    WHERE used.report_id = report.id AND source.source_kind = 'captured'
      AND source.tab_id = NEW.tab_id
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
  WHERE source.source_kind = 'captured' AND source.tab_id = OLD.tab_id;

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
    WHERE used.report_id = report.id AND source.source_kind = 'captured'
      AND source.tab_id = OLD.tab_id
  );
END;

CREATE TRIGGER live_acquisition_handoff_receipts_insert_guard
BEFORE INSERT ON live_acquisition_handoff_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_handoffs AS handoff
  JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
  JOIN ai_jobs AS final_job ON final_job.id = final_run.job_id
  WHERE handoff.id = NEW.handoff_id AND handoff.status = 'assembling'
    AND final_job.status = 'queued' AND final_job.event_sequence = 1
    AND EXISTS (
      SELECT 1 FROM ai_job_events AS event
      WHERE event.job_id = final_job.id AND event.sequence_no = 1
        AND event.event_type = 'submitted' AND event.to_status = 'queued'
    )
    AND EXISTS (
      SELECT 1 FROM research_run_events AS event
      WHERE event.run_id = final_run.id AND event.sequence_no = 1
        AND event.event_type = 'queued' AND event.status = 'queued'
    )
    AND EXISTS (
      SELECT 1 FROM live_acquisition_provider_reservations AS reservation
      WHERE reservation.handoff_id = handoff.id
        AND reservation.final_job_id = final_job.id
        AND reservation.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM live_acquisition_source_receipts
      WHERE handoff_id = handoff.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM research_sources AS assembled_source
      WHERE assembled_source.run_id = final_run.id
        AND (
          assembled_source.inclusion_state <> 'included'
          OR NOT EXISTS (
            SELECT 1 FROM research_source_heads AS head
            WHERE head.source_id = assembled_source.id AND head.state = 'valid'
          )
          OR
          NOT EXISTS (
            SELECT 1 FROM research_source_state_events AS accepted
            WHERE accepted.source_id = assembled_source.id
              AND accepted.sequence_no = 1
              AND accepted.event_type = 'accepted'
              AND accepted.state = 'valid'
          )
          OR NOT EXISTS (
            SELECT 1 FROM research_source_payloads AS payload
            WHERE payload.source_id = assembled_source.id
          )
          OR EXISTS (
            SELECT 1 FROM research_source_state_events AS successor
            WHERE successor.source_id = assembled_source.id
              AND successor.sequence_no > 1
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM live_acquisition_source_receipts AS receipt
      WHERE receipt.handoff_id = handoff.id AND NOT EXISTS (
        SELECT 1 FROM research_sources AS source
        JOIN research_source_state_events AS event
          ON event.source_id = source.id AND event.sequence_no = 1
          AND event.event_type = 'accepted' AND event.state = 'valid'
        JOIN research_source_payloads AS payload ON payload.source_id = source.id
        WHERE source.handoff_source_receipt_id = receipt.id
          AND source.run_id = receipt.final_run_id
          AND source.ordinal = receipt.ordinal
          AND source.logical_page_id = receipt.logical_page_id
          AND source.inclusion_state = receipt.inclusion_state
          AND source.included_order = receipt.included_order
          AND source.content_revision = receipt.content_revision
          AND source.content_digest = receipt.content_digest
          AND source.extracted_at = receipt.extracted_at
          AND NOT EXISTS (
            SELECT 1 FROM research_source_state_events AS successor
            WHERE successor.source_id = source.id
              AND successor.sequence_no > 1
          )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition handoff assembly is incomplete');
END;

CREATE TRIGGER live_acquisition_handoff_receipts_complete
AFTER INSERT ON live_acquisition_handoff_receipts
BEGIN
  UPDATE live_acquisition_handoffs
  SET status = 'completed', completed_at = NEW.completed_at
  WHERE id = NEW.handoff_id;
END;

CREATE TRIGGER live_acquisition_handoffs_validate_update
BEFORE UPDATE ON live_acquisition_handoffs
WHEN NOT (
  OLD.status = 'assembling' AND OLD.completed_at IS NULL
  AND NEW.status = 'completed' AND NEW.completed_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.coordinator_run_generation_id IS OLD.coordinator_run_generation_id
  AND NEW.final_run_id IS OLD.final_run_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition handoff is immutable');
END;

CREATE TRIGGER live_acquisition_handoff_receipts_immutable_update
BEFORE UPDATE ON live_acquisition_handoff_receipts
BEGIN
  SELECT RAISE(ABORT, 'live acquisition handoff receipts are immutable');
END;

CREATE TRIGGER live_acquisition_handoff_receipts_immutable_delete
BEFORE DELETE ON live_acquisition_handoff_receipts
BEGIN
  SELECT RAISE(ABORT, 'live acquisition handoff receipts are immutable');
END;

CREATE TRIGGER live_acquisition_handoffs_immutable_delete
BEFORE DELETE ON live_acquisition_handoffs
BEGIN
  SELECT RAISE(ABORT, 'live acquisition handoffs are immutable');
END;

CREATE TRIGGER live_acquisition_source_receipts_no_late_insert
BEFORE INSERT ON live_acquisition_source_receipts
WHEN EXISTS (
  SELECT 1 FROM live_acquisition_handoff_receipts
  WHERE handoff_id = NEW.handoff_id
)
BEGIN
  SELECT RAISE(ABORT, 'completed live acquisition handoff is closed');
END;

CREATE TRIGGER research_sources_no_late_live_insert
BEFORE INSERT ON research_sources
WHEN EXISTS (
  SELECT 1 FROM live_acquisition_handoffs AS handoff
  JOIN live_acquisition_handoff_receipts AS terminal
    ON terminal.handoff_id = handoff.id
  WHERE handoff.final_run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'completed live acquisition handoff is closed');
END;

CREATE TRIGGER research_source_payloads_no_late_live_insert
BEFORE INSERT ON research_source_payloads
WHEN EXISTS (
  SELECT 1 FROM research_sources AS source
  JOIN live_acquisition_handoffs AS handoff
    ON handoff.final_run_id = source.run_id
  JOIN live_acquisition_handoff_receipts AS terminal
    ON terminal.handoff_id = handoff.id
  WHERE source.id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'completed live acquisition handoff is closed');
END;

CREATE TRIGGER research_source_state_events_no_late_live_accept
BEFORE INSERT ON research_source_state_events
WHEN NEW.sequence_no = 1 AND NEW.event_type = 'accepted' AND EXISTS (
  SELECT 1 FROM research_sources AS source
  JOIN live_acquisition_handoffs AS handoff
    ON handoff.final_run_id = source.run_id
  JOIN live_acquisition_handoff_receipts AS terminal
    ON terminal.handoff_id = handoff.id
  WHERE source.id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'completed live acquisition handoff is closed');
END;

CREATE TABLE live_acquisition_consents (
  id INTEGER PRIMARY KEY,
  resource_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  history_epoch_id INTEGER NOT NULL
    REFERENCES research_history_epochs(id) ON DELETE RESTRICT,
  coordinator_job_id INTEGER NOT NULL UNIQUE
    REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  coordinator_run_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  consent_fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(consent_fingerprint) = 64
      AND consent_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  origin_set_digest TEXT NOT NULL CHECK (
    length(origin_set_digest) = 64 AND origin_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  limits_json TEXT NOT NULL CHECK (
    json_valid(limits_json) AND json_type(limits_json) = 'object'
      AND length(CAST(limits_json AS BLOB)) BETWEEN 2 AND 8192
  ),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'expired', 'consumed', 'revoked')
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  expires_at TEXT NOT NULL CHECK (
    COALESCE(expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
      AND expires_at > created_at
      AND (
        CAST(strftime('%s', expires_at) AS INTEGER) * 1000
          + CAST(substr(expires_at, 21, 3) AS INTEGER)
      ) = (
        CAST(strftime('%s', created_at) AS INTEGER) * 1000
          + CAST(substr(created_at, 21, 3) AS INTEGER)
          + json_extract(limits_json, '$.duration_ms')
      ), 0)
  ),
  terminal_at TEXT CHECK (
    COALESCE(terminal_at IS NULL OR (
      terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at)
      AND terminal_at >= created_at
    ), 0)
  ),
  CHECK (
    (status = 'active' AND terminal_at IS NULL)
    OR (status <> 'active' AND terminal_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER live_acquisition_consents_safe_limits_guard
BEFORE INSERT ON live_acquisition_consents
WHEN (SELECT COUNT(*) FROM json_each(NEW.limits_json)) <> 19
  OR (SELECT COUNT(DISTINCT key) FROM json_each(NEW.limits_json)) <> 19
  OR EXISTS (
  SELECT 1 FROM json_each(NEW.limits_json) AS limit_entry
  WHERE limit_entry.key NOT IN (
    'max_pages', 'max_depth', 'duration_ms', 'max_cost_usd', 'max_origins',
    'max_output_tokens', 'provider_digest', 'model_digest', 'pricing_digest',
    'ruleset_generation_digest', 'resource_generation_digest',
    'max_source_bytes', 'max_total_bytes', 'dns_timeout_ms',
    'connect_timeout_ms', 'headers_timeout_ms', 'body_idle_timeout_ms',
    'request_timeout_ms', 'max_header_bytes'
  )
  )
  OR json_type(NEW.limits_json, '$.max_pages') <> 'integer'
  OR json_extract(NEW.limits_json, '$.max_pages') NOT BETWEEN 1 AND 50
  OR json_type(NEW.limits_json, '$.max_depth') <> 'integer'
  OR json_extract(NEW.limits_json, '$.max_depth') NOT BETWEEN 0 AND 3
  OR json_type(NEW.limits_json, '$.duration_ms') <> 'integer'
  OR json_extract(NEW.limits_json, '$.duration_ms') NOT BETWEEN 30000 AND 900000
  OR json_type(NEW.limits_json, '$.max_cost_usd') NOT IN ('integer', 'real')
  OR json_extract(NEW.limits_json, '$.max_cost_usd') <= 0
  OR json_extract(NEW.limits_json, '$.max_cost_usd') > 2
  OR json_type(NEW.limits_json, '$.max_origins') <> 'integer'
  OR json_extract(NEW.limits_json, '$.max_origins') NOT BETWEEN 1 AND 16
  OR json_type(NEW.limits_json, '$.max_output_tokens') <> 'integer'
  OR json_extract(NEW.limits_json, '$.max_output_tokens') NOT BETWEEN 1 AND 200000
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.limits_json) AS digest_limit
    WHERE digest_limit.key IN (
      'provider_digest', 'model_digest', 'pricing_digest',
      'ruleset_generation_digest', 'resource_generation_digest'
    ) AND (digest_limit.type <> 'text' OR length(digest_limit.value) <> 64
      OR digest_limit.value GLOB '*[^0-9a-f]*')
  )
  OR json_extract(NEW.limits_json, '$.max_source_bytes') <> 65536
  OR json_extract(NEW.limits_json, '$.max_total_bytes') <> 4194304
  OR json_extract(NEW.limits_json, '$.dns_timeout_ms') <> 3000
  OR json_extract(NEW.limits_json, '$.connect_timeout_ms') <> 5000
  OR json_extract(NEW.limits_json, '$.headers_timeout_ms') <> 8000
  OR json_extract(NEW.limits_json, '$.body_idle_timeout_ms') <> 3000
  OR json_extract(NEW.limits_json, '$.request_timeout_ms') <> 15000
  OR json_extract(NEW.limits_json, '$.max_header_bytes') <> 16384
BEGIN
  SELECT RAISE(ABORT, 'live acquisition consent limits are not safe');
END;

CREATE TRIGGER live_acquisition_consents_insert_guard
BEFORE INSERT ON live_acquisition_consents
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_subject_generations AS resource_generation
  JOIN research_history_epochs AS history
    ON history.id = NEW.history_epoch_id
  JOIN privacy_subject_generations AS run_generation
    ON run_generation.id = NEW.coordinator_run_generation_id
  JOIN research_runs AS run ON run.id = run_generation.research_run_id
  JOIN ai_jobs AS job ON job.id = NEW.coordinator_job_id
  JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
  WHERE resource_generation.id = NEW.resource_generation_id
    AND resource_generation.subject_kind = 'resource'
    AND resource_generation.is_active = 1
    AND history.resource_generation_id = resource_generation.id
    AND history.resource_id = resource_generation.resource_id
    AND history.is_active = 1
    AND run_generation.subject_kind = 'research_run'
    AND run_generation.is_active = 1
    AND run.job_id = job.id
    AND run.target_resource_id = resource_generation.resource_id
    AND run.history_epoch_id = history.id
    AND run.workflow_id = 'research_acquisition:c90:v1'
    AND run.workflow_version = 1
    AND job.kind = 'resource_research'
    AND job.resource_id = resource_generation.resource_id
    AND job.workflow_id = 'research_acquisition:c90:v1'
    AND job.workflow_version = 1
    AND job.status IN ('queued', 'running')
    AND runtime.runtime_epoch = NEW.runtime_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition consent ownership');
END;

CREATE TABLE live_acquisition_consent_payloads (
  consent_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  approved_origins_json TEXT NOT NULL CHECK (
    json_valid(approved_origins_json) AND json_type(approved_origins_json) = 'array'
      AND length(CAST(approved_origins_json AS BLOB)) BETWEEN 2 AND 65536
  )
) STRICT;

CREATE TRIGGER live_acquisition_consent_payloads_shape_guard
BEFORE INSERT ON live_acquisition_consent_payloads
WHEN (SELECT COUNT(*) FROM json_each(NEW.approved_origins_json)) NOT BETWEEN 1 AND 16
  OR (SELECT COUNT(*) FROM json_each(NEW.approved_origins_json)) > COALESCE((
    SELECT json_extract(consent.limits_json, '$.max_origins')
    FROM live_acquisition_consents AS consent
    WHERE consent.id = NEW.consent_id
  ), 0)
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.approved_origins_json))
    <> (SELECT COUNT(*) FROM json_each(NEW.approved_origins_json))
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.approved_origins_json) AS origin
    WHERE origin.type <> 'text'
      OR tabhub_https_origin_canonical_v1(origin.value) <> 1
  )
BEGIN
  SELECT RAISE(ABORT, 'approved origins must be unique canonical HTTPS origins');
END;

CREATE TABLE live_acquisition_digest_keys (
  consent_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  digest_key BLOB NOT NULL CHECK (length(digest_key) = 32)
) STRICT;

CREATE TABLE live_acquisition_actions (
  id INTEGER PRIMARY KEY,
  consent_id INTEGER NOT NULL
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  coordinator_run_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  resource_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  history_epoch_id INTEGER NOT NULL
    REFERENCES research_history_epochs(id) ON DELETE RESTRICT,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('page', 'robots')),
  depth INTEGER CHECK (depth IS NULL OR depth BETWEEN 0 AND 3),
  discovered_from_action_id INTEGER
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  canonical_fetch_url_fingerprint TEXT CHECK (
    canonical_fetch_url_fingerprint IS NULL OR (
      length(canonical_fetch_url_fingerprint) = 64
      AND canonical_fetch_url_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  canonical_origin_digest TEXT CHECK (
    canonical_origin_digest IS NULL OR (
      length(canonical_origin_digest) = 64
      AND canonical_origin_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  action_key_digest TEXT NOT NULL UNIQUE CHECK (
    length(action_key_digest) = 64
      AND action_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'resolution_started', 'resolved', 'authorized',
      'started', 'completed', 'blocked', 'ambiguous')
  ),
  sequence_no INTEGER NOT NULL DEFAULT 0 CHECK (sequence_no >= 0),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  terminal_at TEXT CHECK (
    COALESCE(terminal_at IS NULL OR (
      terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at)
      AND terminal_at >= created_at
    ), 0)
  ),
  CHECK (
    (state IN ('completed', 'blocked', 'ambiguous') AND terminal_at IS NOT NULL)
    OR (state NOT IN ('completed', 'blocked', 'ambiguous') AND terminal_at IS NULL)
  ),
  CHECK (
    (action_kind = 'page' AND depth IS NOT NULL
      AND canonical_fetch_url_fingerprint IS NOT NULL
      AND canonical_origin_digest IS NULL)
    OR (action_kind = 'robots' AND depth IS NULL
      AND discovered_from_action_id IS NULL
      AND canonical_fetch_url_fingerprint IS NULL
      AND canonical_origin_digest IS NOT NULL)
  ),
  CHECK (
    action_kind <> 'page'
    OR (depth = 0 AND discovered_from_action_id IS NULL)
    OR (depth > 0 AND discovered_from_action_id IS NOT NULL)
  ),
  UNIQUE (id, consent_id)
) STRICT;

CREATE UNIQUE INDEX live_acquisition_actions_page_identity_idx
ON live_acquisition_actions(
  coordinator_run_generation_id, action_kind, canonical_fetch_url_fingerprint
)
WHERE action_kind = 'page';

CREATE UNIQUE INDEX live_acquisition_actions_robots_identity_idx
ON live_acquisition_actions(
  coordinator_run_generation_id, action_kind, canonical_origin_digest
)
WHERE action_kind = 'robots';

CREATE INDEX live_acquisition_actions_planned_queue_idx
ON live_acquisition_actions(consent_id, depth, id)
WHERE action_kind = 'page' AND state = 'planned';

CREATE TABLE live_acquisition_page_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consent_id INTEGER NOT NULL
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  action_id INTEGER NOT NULL UNIQUE,
  reservation_sequence INTEGER NOT NULL CHECK (
    reservation_sequence BETWEEN 1 AND 50
  ),
  reserved_at TEXT NOT NULL CHECK (
    COALESCE(reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at), 0)
  ),
  UNIQUE (consent_id, reservation_sequence),
  UNIQUE (id, action_id),
  FOREIGN KEY (action_id, consent_id)
    REFERENCES live_acquisition_actions(id, consent_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER live_acquisition_page_reservations_insert_guard
BEFORE INSERT ON live_acquisition_page_reservations
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
  JOIN privacy_subject_generations AS resource_generation
    ON resource_generation.id = action.resource_generation_id
  JOIN privacy_subject_generations AS run_generation
    ON run_generation.id = action.coordinator_run_generation_id
  JOIN research_history_epochs AS history ON history.id = action.history_epoch_id
  WHERE action.id = NEW.action_id
    AND action.consent_id = NEW.consent_id
    AND action.action_kind = 'page'
    AND action.state = 'planned' AND action.sequence_no = 1
    AND consent.status = 'active' AND NEW.reserved_at < consent.expires_at
    AND consent.runtime_epoch = action.runtime_epoch
    AND runtime.runtime_epoch = action.runtime_epoch
    AND resource_generation.is_active = 1
    AND run_generation.is_active = 1
    AND history.is_active = 1
    AND EXISTS (
      SELECT 1 FROM live_acquisition_url_payloads AS url_payload
      WHERE url_payload.action_id = action.id
    )
    AND NEW.reservation_sequence = 1 + (
      SELECT COUNT(*) FROM live_acquisition_page_reservations AS existing
      WHERE existing.consent_id = NEW.consent_id
    )
    AND NEW.reservation_sequence
      <= json_extract(consent.limits_json, '$.max_pages')
)
BEGIN
  SELECT CASE WHEN NEW.reservation_sequence > COALESCE((
    SELECT json_extract(limits_json, '$.max_pages')
    FROM live_acquisition_consents WHERE id = NEW.consent_id
  ), 0)
    THEN RAISE(ABORT, 'live acquisition page reservation budget exhausted')
    ELSE RAISE(ABORT, 'invalid live acquisition page reservation') END;
END;

CREATE TRIGGER live_acquisition_page_reservations_begin_resolution
AFTER INSERT ON live_acquisition_page_reservations
BEGIN
  INSERT INTO live_acquisition_action_events (
    action_id, sequence_no, from_state, to_state, outcome_code,
    safe_details_json, occurred_at
  ) VALUES (
    NEW.action_id, 2, 'planned', 'resolution_started', NULL, '{}', NEW.reserved_at
  );
END;

CREATE TRIGGER live_acquisition_page_reservations_immutable_update
BEFORE UPDATE ON live_acquisition_page_reservations
BEGIN
  SELECT RAISE(ABORT, 'live acquisition page reservations are immutable');
END;

CREATE TABLE live_acquisition_action_authorizations (
  action_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  selected_ipv4_digest TEXT NOT NULL CHECK (
    length(selected_ipv4_digest) = 64
      AND selected_ipv4_digest NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_digest TEXT NOT NULL UNIQUE CHECK (
    length(authorization_digest) = 64
      AND authorization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  authorized_at TEXT NOT NULL CHECK (
    COALESCE(authorized_at = strftime('%Y-%m-%dT%H:%M:%fZ', authorized_at), 0)
  ),
  expires_at TEXT NOT NULL CHECK (
    COALESCE(expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
      AND expires_at > authorized_at, 0)
  )
) STRICT;

CREATE TRIGGER live_acquisition_action_authorizations_insert_guard
BEFORE INSERT ON live_acquisition_action_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  WHERE action.id = NEW.action_id
    AND action.state = 'resolved'
    AND action.runtime_epoch = NEW.runtime_epoch
    AND consent.status = 'active'
    AND NEW.authorized_at >= action.created_at
    AND NEW.expires_at <= consent.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition action authorization');
END;

CREATE TABLE live_acquisition_action_events (
  id INTEGER PRIMARY KEY,
  action_id INTEGER NOT NULL
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (
    to_state IN ('planned', 'resolution_started', 'resolved', 'authorized',
      'started', 'completed', 'blocked', 'ambiguous')
  ),
  outcome_code TEXT CHECK (
    outcome_code IS NULL OR outcome_code IN (
      'DNS_RESULT_UNKNOWN', 'RUNTIME_RESTARTED_BEFORE_REQUEST',
      'IPV4_REQUIRED_V1', 'PARTIAL_RESPONSE', 'META_REFRESH',
      'AUTH_REQUIRED', 'CHALLENGE_PAGE', 'SPA_SHELL',
      'INSUFFICIENT_PUBLIC_TEXT', 'INVALID_UTF8',
      'CONSENT_EXPIRED_IN_FLIGHT', 'ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH',
      'SENSITIVE_URL_CAPTURE_REQUIRED', 'LIVE_ACQUISITION_DISABLED',
      'LIVE_ACQUISITION_DISABLED_IN_FLIGHT', 'POLICY_BLOCKED',
      'TRANSPORT_DNS_FAILURE', 'TRANSPORT_CONNECT_FAILURE',
      'TRANSPORT_TLS_FAILURE', 'TRANSPORT_TIMEOUT', 'HTTP_INFORMATIONAL',
      'HTTP_SUCCESS', 'HTTP_REDIRECT', 'HTTP_CLIENT_ERROR',
      'HTTP_SERVER_ERROR', 'RESPONSE_SIZE_LIMIT', 'FETCH_COMPLETED',
      'CANCELLED', 'BUDGET_EXHAUSTED'
    )
  ),
  safe_details_json TEXT NOT NULL CHECK (
    json_valid(safe_details_json) AND json_type(safe_details_json) = 'object'
      AND length(CAST(safe_details_json AS BLOB)) BETWEEN 2 AND 8192
  ),
  occurred_at TEXT NOT NULL CHECK (
    COALESCE(occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at), 0)
  ),
  UNIQUE (action_id, sequence_no)
) STRICT;

CREATE TRIGGER live_acquisition_action_events_safe_details_guard
BEFORE INSERT ON live_acquisition_action_events
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.safe_details_json) AS detail
  WHERE detail.key NOT IN (
    'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
    'response_class', 'outcome_class', 'redirect_count', 'response_bytes',
    'duration_ms', 'dns_answer_count', 'attempt_count'
  ) OR (
    detail.key IN ('hostname_digest', 'url_digest', 'address_digest', 'content_digest')
    AND (detail.type <> 'text' OR length(detail.value) <> 64
      OR detail.value GLOB '*[^0-9a-f]*')
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

CREATE TRIGGER live_acquisition_actions_insert_guard
BEFORE INSERT ON live_acquisition_actions
WHEN NEW.state <> 'planned' OR NEW.sequence_no <> 0 OR NEW.terminal_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM live_acquisition_consents AS consent
    JOIN privacy_subject_generations AS resource_generation
      ON resource_generation.id = NEW.resource_generation_id
    JOIN privacy_subject_generations AS run_generation
      ON run_generation.id = NEW.coordinator_run_generation_id
    WHERE consent.id = NEW.consent_id AND consent.status = 'active'
      AND EXISTS (
        SELECT 1 FROM live_acquisition_consent_payloads AS payload
        WHERE payload.consent_id = consent.id
      )
      AND EXISTS (
        SELECT 1 FROM live_acquisition_digest_keys AS digest_key
        WHERE digest_key.consent_id = consent.id
      )
      AND (NEW.action_kind <> 'page' OR (
        NEW.depth <= json_extract(consent.limits_json, '$.max_depth')
        AND (SELECT COUNT(*) FROM live_acquisition_actions AS existing
             WHERE existing.consent_id = consent.id
               AND existing.action_kind = 'page'
               AND existing.state = 'planned') < 1000
        AND (
          (NEW.depth = 0 AND NEW.discovered_from_action_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM live_acquisition_actions AS parent
            JOIN live_acquisition_capture_manifests AS capture
              ON capture.action_id = parent.id
            WHERE parent.id = NEW.discovered_from_action_id
              AND parent.consent_id = NEW.consent_id
              AND parent.action_kind = 'page'
              AND parent.state = 'completed'
              AND parent.depth + 1 = NEW.depth
          )
        )
      ))
      AND (
        NEW.action_kind <> 'robots'
        OR (SELECT COUNT(*) FROM live_acquisition_actions AS existing
            WHERE existing.consent_id = consent.id
              AND existing.action_kind = 'robots')
          < (SELECT COUNT(*) FROM live_acquisition_consent_payloads AS payload,
               json_each(payload.approved_origins_json)
             WHERE payload.consent_id = consent.id)
      )
      AND consent.runtime_epoch = NEW.runtime_epoch
      AND consent.resource_generation_id = NEW.resource_generation_id
      AND consent.history_epoch_id = NEW.history_epoch_id
      AND consent.coordinator_run_generation_id
        = NEW.coordinator_run_generation_id
      AND resource_generation.subject_kind = 'resource'
      AND resource_generation.is_active = 1
      AND run_generation.subject_kind = 'research_run'
      AND run_generation.is_active = 1
  )
BEGIN
  SELECT CASE WHEN NEW.action_kind = 'page' AND (
    SELECT COUNT(*) FROM live_acquisition_actions AS existing
    WHERE existing.consent_id = NEW.consent_id
      AND existing.action_kind = 'page' AND existing.state = 'planned'
  ) >= 1000
    THEN RAISE(ABORT, 'live acquisition planned page queue limit exceeded')
    ELSE RAISE(ABORT, 'invalid live acquisition planned action') END;
END;

CREATE TRIGGER live_acquisition_action_events_transition_guard
BEFORE INSERT ON live_acquisition_action_events
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  WHERE action.id = NEW.action_id
    AND NEW.sequence_no = action.sequence_no + 1
    AND NEW.from_state IS action.state
    AND (
      action.action_kind = 'robots'
      OR NEW.to_state = 'planned'
      OR EXISTS (
        SELECT 1 FROM live_acquisition_page_reservations AS reservation
        WHERE reservation.action_id = action.id
          AND reservation.consent_id = action.consent_id
      )
      OR (
        action.state = 'planned' AND NEW.to_state = 'blocked'
        AND NEW.outcome_code IN (
          'BUDGET_EXHAUSTED', 'RUNTIME_RESTARTED_BEFORE_REQUEST',
          'LIVE_ACQUISITION_DISABLED', 'CANCELLED'
        )
        AND (
          NEW.outcome_code <> 'BUDGET_EXHAUSTED'
          OR (
            SELECT COUNT(*) FROM live_acquisition_page_reservations AS existing
            WHERE existing.consent_id = action.consent_id
          ) >= (
            SELECT json_extract(consent.limits_json, '$.max_pages')
            FROM live_acquisition_consents AS consent
            WHERE consent.id = action.consent_id
          )
        )
      )
    )
    AND (
      (action.sequence_no = 0 AND action.state = 'planned'
        AND NEW.to_state = 'planned')
      OR (action.sequence_no > 0 AND action.state = 'planned'
        AND NEW.to_state IN ('resolution_started', 'blocked'))
      OR (action.state = 'resolution_started'
        AND NEW.to_state IN ('resolved', 'blocked', 'ambiguous'))
      OR (action.state = 'resolved'
        AND NEW.to_state IN ('authorized', 'blocked')
        AND (
          NEW.to_state <> 'authorized' OR EXISTS (
            SELECT 1 FROM live_acquisition_action_authorizations AS authorization
            WHERE authorization.action_id = action.id
              AND authorization.runtime_epoch = action.runtime_epoch
              AND authorization.authorized_at <= NEW.occurred_at
              AND authorization.expires_at > NEW.occurred_at
          )
        ))
      OR (action.state = 'authorized'
        AND NEW.to_state IN ('started', 'blocked')
        AND (
          NEW.to_state <> 'started' OR EXISTS (
            SELECT 1 FROM live_acquisition_action_authorizations AS authorization
            WHERE authorization.action_id = action.id
              AND authorization.runtime_epoch = action.runtime_epoch
              AND authorization.expires_at > NEW.occurred_at
          )
        ))
      OR (action.state = 'started'
        AND NEW.to_state IN ('completed', 'blocked', 'ambiguous')
        AND (
          NEW.to_state <> 'completed' OR action.action_kind = 'robots' OR (
            NEW.outcome_code = 'FETCH_COMPLETED'
            AND EXISTS (
              SELECT 1 FROM live_acquisition_capture_manifests AS capture
              JOIN live_acquisition_page_reservations AS reservation
                ON reservation.id = capture.reservation_id
                AND reservation.action_id = capture.action_id
              JOIN live_acquisition_body_payloads AS body
                ON body.action_id = capture.action_id
              WHERE capture.action_id = action.id
                AND capture.consent_id = action.consent_id
                AND capture.depth = action.depth
                AND capture.content_digest = body.body_digest
            )
          )
        ))
    )
    AND (
      (NEW.to_state IN ('completed', 'blocked', 'ambiguous')
        AND NEW.outcome_code IS NOT NULL)
      OR (NEW.to_state NOT IN ('completed', 'blocked', 'ambiguous')
        AND NEW.outcome_code IS NULL)
    )
)
BEGIN
  SELECT CASE WHEN NEW.to_state = 'resolution_started' AND EXISTS (
    SELECT 1 FROM live_acquisition_actions AS action
    WHERE action.id = NEW.action_id AND action.action_kind = 'page'
      AND NOT EXISTS (
        SELECT 1 FROM live_acquisition_page_reservations AS reservation
        WHERE reservation.action_id = action.id
      )
  )
    THEN RAISE(ABORT, 'live acquisition page reservation is required')
    ELSE RAISE(ABORT, 'invalid live acquisition action transition') END;
END;

CREATE TRIGGER live_acquisition_action_events_apply
AFTER INSERT ON live_acquisition_action_events
BEGIN
  UPDATE live_acquisition_actions
  SET state = NEW.to_state, sequence_no = NEW.sequence_no,
    terminal_at = CASE
      WHEN NEW.to_state IN ('completed', 'blocked', 'ambiguous')
      THEN NEW.occurred_at ELSE NULL END
  WHERE id = NEW.action_id;
END;

CREATE TRIGGER live_acquisition_actions_validate_update
BEFORE UPDATE ON live_acquisition_actions
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_action_events AS event
  WHERE event.action_id = OLD.id
    AND event.sequence_no = OLD.sequence_no + 1
    AND event.from_state IS OLD.state
    AND event.to_state = NEW.state
    AND NEW.sequence_no = event.sequence_no
    AND NEW.id IS OLD.id AND NEW.consent_id IS OLD.consent_id
    AND NEW.coordinator_run_generation_id IS OLD.coordinator_run_generation_id
    AND NEW.resource_generation_id IS OLD.resource_generation_id
    AND NEW.history_epoch_id IS OLD.history_epoch_id
    AND NEW.runtime_epoch IS OLD.runtime_epoch
    AND NEW.action_kind IS OLD.action_kind
    AND NEW.depth IS OLD.depth
    AND NEW.discovered_from_action_id IS OLD.discovered_from_action_id
    AND NEW.canonical_fetch_url_fingerprint
      IS OLD.canonical_fetch_url_fingerprint
    AND NEW.canonical_origin_digest IS OLD.canonical_origin_digest
    AND NEW.action_key_digest IS OLD.action_key_digest
    AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action is event-owned');
END;

CREATE TRIGGER live_acquisition_action_events_immutable_update
BEFORE UPDATE ON live_acquisition_action_events
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action events are append-only');
END;

CREATE TABLE live_acquisition_url_payloads (
  action_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  exact_url TEXT NOT NULL CHECK (
    length(CAST(exact_url AS BLOB)) BETWEEN 1 AND 8192
  ),
  keyed_url_digest TEXT NOT NULL CHECK (
    length(keyed_url_digest) = 64 AND keyed_url_digest NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE TRIGGER live_acquisition_url_payloads_insert_guard
BEFORE INSERT ON live_acquisition_url_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  WHERE action.id = NEW.action_id
    AND action.state = 'planned'
    AND consent.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition URL payload owner or state');
END;

CREATE TABLE live_acquisition_dns_payloads (
  action_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  answers_json TEXT NOT NULL CHECK (
    json_valid(answers_json) AND json_type(answers_json) = 'array'
      AND length(CAST(answers_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  selected_ipv4 TEXT CHECK (
    selected_ipv4 IS NULL OR length(CAST(selected_ipv4 AS BLOB)) BETWEEN 7 AND 15
  ),
  resolved_at TEXT NOT NULL CHECK (
    COALESCE(resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at), 0)
  )
) STRICT;

CREATE TRIGGER live_acquisition_dns_payloads_insert_guard
BEFORE INSERT ON live_acquisition_dns_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  WHERE action.id = NEW.action_id
    AND action.state = 'resolution_started'
    AND consent.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition DNS payload owner or state');
END;

CREATE TABLE live_acquisition_body_payloads (
  action_id INTEGER PRIMARY KEY
    REFERENCES live_acquisition_actions(id) ON DELETE RESTRICT,
  raw_body BLOB NOT NULL CHECK (length(raw_body) BETWEEN 1 AND 65536),
  extracted_text TEXT NOT NULL CHECK (
    length(CAST(extracted_text AS BLOB)) BETWEEN 1 AND 65536
  ),
  body_digest TEXT NOT NULL CHECK (
    length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_metadata_json TEXT NOT NULL CHECK (
    json_valid(response_metadata_json) AND json_type(response_metadata_json) = 'object'
      AND length(CAST(response_metadata_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  acquired_at TEXT NOT NULL CHECK (
    COALESCE(acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at), 0)
  )
) STRICT;

CREATE TRIGGER live_acquisition_body_payloads_insert_guard
BEFORE INSERT ON live_acquisition_body_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  JOIN live_acquisition_action_authorizations AS authorization
    ON authorization.action_id = action.id
  WHERE action.id = NEW.action_id
    AND action.state = 'started'
    AND authorization.runtime_epoch = action.runtime_epoch
    AND authorization.expires_at > NEW.acquired_at
    AND consent.status = 'active'
    AND length(NEW.raw_body)
      <= json_extract(consent.limits_json, '$.max_source_bytes')
    AND length(CAST(NEW.extracted_text AS BLOB))
      <= json_extract(consent.limits_json, '$.max_source_bytes')
    AND COALESCE((
      SELECT SUM(length(existing.raw_body))
      FROM live_acquisition_body_payloads AS existing
      JOIN live_acquisition_actions AS existing_action
        ON existing_action.id = existing.action_id
      WHERE existing_action.consent_id = consent.id
    ), 0) + length(NEW.raw_body)
      <= json_extract(consent.limits_json, '$.max_total_bytes')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition body payload owner or state');
END;

CREATE TABLE live_acquisition_checkpoints (
  attempt_id INTEGER PRIMARY KEY REFERENCES ai_job_attempts(id) ON DELETE RESTRICT,
  coordinator_job_id INTEGER NOT NULL REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  consent_id INTEGER NOT NULL
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  checkpoint_json TEXT NOT NULL CHECK (
    json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'
      AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  checkpoint_digest TEXT NOT NULL CHECK (
    length(checkpoint_digest) = 64
      AND checkpoint_digest NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at TEXT NOT NULL CHECK (
    COALESCE(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), 0)
  )
) STRICT;

CREATE TRIGGER live_acquisition_checkpoints_insert_guard
BEFORE INSERT ON live_acquisition_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM ai_job_attempts AS attempt
  JOIN live_acquisition_consents AS consent
    ON consent.id = NEW.consent_id
  JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
  WHERE attempt.id = NEW.attempt_id
    AND attempt.job_id = NEW.coordinator_job_id
    AND attempt.outcome = 'running'
    AND consent.coordinator_job_id = NEW.coordinator_job_id
    AND consent.runtime_epoch = NEW.runtime_epoch
    AND consent.status = 'active'
    AND runtime.runtime_epoch = NEW.runtime_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition checkpoint ownership');
END;

CREATE TABLE live_acquisition_origin_courtesy_state (
  coordinator_run_id INTEGER NOT NULL
    REFERENCES research_runs(id) ON DELETE RESTRICT,
  coordinator_run_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  consent_id INTEGER NOT NULL
    REFERENCES live_acquisition_consents(id) ON DELETE RESTRICT,
  canonical_origin_digest TEXT NOT NULL CHECK (
    length(canonical_origin_digest) = 64
      AND canonical_origin_digest NOT GLOB '*[^0-9a-f]*'
  ),
  origin_digest TEXT NOT NULL CHECK (
    length(origin_digest) = 64 AND origin_digest NOT GLOB '*[^0-9a-f]*'
  ),
  robots_policy_digest TEXT CHECK (
    robots_policy_digest IS NULL OR (
      length(robots_policy_digest) = 64
      AND robots_policy_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_request_at TEXT CHECK (
    COALESCE(last_request_at IS NULL OR
      last_request_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_request_at), 0)
  ),
  next_allowed_at TEXT CHECK (
    COALESCE(next_allowed_at IS NULL OR (
      next_allowed_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_allowed_at)
      AND last_request_at IS NOT NULL AND next_allowed_at >= last_request_at
    ), 0)
  ),
  retry_after_until TEXT CHECK (
    COALESCE(retry_after_until IS NULL OR (
      retry_after_until = strftime('%Y-%m-%dT%H:%M:%fZ', retry_after_until)
      AND last_request_at IS NOT NULL AND retry_after_until >= last_request_at
    ), 0)
  ),
  updated_at TEXT NOT NULL CHECK (
    COALESCE(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
      AND (last_request_at IS NULL OR updated_at >= last_request_at), 0)
  ),
  PRIMARY KEY (coordinator_run_id, canonical_origin_digest),
  UNIQUE (consent_id, canonical_origin_digest)
) STRICT;

CREATE TRIGGER live_acquisition_origin_courtesy_state_insert_guard
BEFORE INSERT ON live_acquisition_origin_courtesy_state
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_consents AS consent
  JOIN privacy_subject_generations AS run_generation
    ON run_generation.id = NEW.coordinator_run_generation_id
  WHERE consent.id = NEW.consent_id
    AND consent.coordinator_run_generation_id = NEW.coordinator_run_generation_id
    AND consent.status = 'active'
    AND run_generation.subject_kind = 'research_run'
    AND run_generation.research_run_id = NEW.coordinator_run_id
    AND run_generation.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition origin courtesy owner');
END;

CREATE TRIGGER live_acquisition_capture_manifests_safe_manifest_guard
BEFORE INSERT ON live_acquisition_capture_manifests
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.manifest_json) AS manifest
  WHERE manifest.key NOT IN (
    'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
    'body_digest', 'response_metadata_digest', 'chunk_manifest_digest',
    'response_class', 'byte_length', 'redirect_count', 'truncated'
  ) OR (
    manifest.key IN (
      'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
      'body_digest', 'response_metadata_digest', 'chunk_manifest_digest'
    ) AND (manifest.type <> 'text' OR length(manifest.value) <> 64
      OR manifest.value GLOB '*[^0-9a-f]*')
  ) OR (
    manifest.key = 'response_class' AND (
      manifest.type <> 'text' OR manifest.value NOT IN (
        'informational', 'success', 'redirect', 'client_error', 'server_error'
      )
    )
  ) OR (
    manifest.key IN ('byte_length', 'redirect_count')
    AND (manifest.type <> 'integer' OR manifest.value < 0
      OR manifest.value > 9007199254740991)
  ) OR (
    manifest.key = 'truncated' AND manifest.type NOT IN ('true', 'false')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition capture manifest is not digest-only');
END;

CREATE TRIGGER live_acquisition_capture_manifests_insert_guard
BEFORE INSERT ON live_acquisition_capture_manifests
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  JOIN live_acquisition_page_reservations AS reservation
    ON reservation.id = NEW.reservation_id
    AND reservation.action_id = action.id
  JOIN live_acquisition_url_payloads AS url_payload
    ON url_payload.action_id = action.id
  JOIN live_acquisition_body_payloads AS body ON body.action_id = action.id
  JOIN privacy_subject_generations AS page_generation
    ON page_generation.id = NEW.logical_page_generation_id
  JOIN logical_pages AS page ON page.id = page_generation.logical_page_id
  JOIN resource_resolution_heads AS resolution_head
    ON resolution_head.logical_page_id = page.id
  JOIN resource_resolution_events AS resolution
    ON resolution.id = resolution_head.resolution_event_id
    AND resolution.logical_page_id = page.id
  JOIN privacy_subject_generations AS resource_generation
    ON resource_generation.id = action.resource_generation_id
  JOIN privacy_subject_generations AS run_generation
    ON run_generation.id = action.coordinator_run_generation_id
  JOIN research_history_epochs AS history ON history.id = action.history_epoch_id
  WHERE action.id = NEW.action_id
    AND action.action_kind = 'page'
    AND action.state = 'started'
    AND action.consent_id = NEW.consent_id
    AND action.depth = NEW.depth
    AND consent.status = 'active' AND NEW.created_at < consent.expires_at
    AND reservation.consent_id = consent.id
    AND NEW.capture_sequence = 1 + (
      SELECT COUNT(*) FROM live_acquisition_capture_manifests AS existing
      WHERE existing.consent_id = consent.id
    )
    AND NEW.capture_sequence
      <= json_extract(consent.limits_json, '$.max_pages')
    AND page_generation.subject_kind = 'logical_page'
    AND page_generation.is_active = 1
    AND tabhub_normalize_url_v2(url_payload.exact_url) = page.url_normalized
    AND NEW.url_digest = url_payload.keyed_url_digest
    AND NEW.content_digest = body.body_digest
    AND resolution.state IN ('matched', 'overridden')
    AND resolution.research_eligible = 1
    AND resolution.resource_id = resource_generation.resource_id
    AND resource_generation.subject_kind = 'resource'
    AND resource_generation.is_active = 1
    AND run_generation.subject_kind = 'research_run'
    AND run_generation.is_active = 1
    AND history.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition capture manifest ownership');
END;

CREATE TABLE live_acquisition_provider_reservations (
  id INTEGER PRIMARY KEY,
  handoff_id INTEGER NOT NULL UNIQUE
    REFERENCES live_acquisition_handoffs(id) ON DELETE RESTRICT,
  final_job_id INTEGER NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  utc_date TEXT NOT NULL CHECK (
    length(utc_date) = 10
      AND utc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND COALESCE(utc_date = date(utc_date), 0)
  ),
  reserved_usd REAL NOT NULL CHECK (reserved_usd > 0 AND reserved_usd <= 2),
  consumed_usd REAL NOT NULL DEFAULT 0 CHECK (
    consumed_usd >= 0 AND consumed_usd <= reserved_usd AND consumed_usd <= 2
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'consumed')),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  terminal_at TEXT CHECK (
    COALESCE(terminal_at IS NULL OR (
      terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at)
      AND terminal_at >= created_at
    ), 0)
  ),
  CHECK (
    (status = 'active' AND terminal_at IS NULL)
    OR (status <> 'active' AND terminal_at IS NOT NULL)
  ),
  UNIQUE (id, final_job_id)
) STRICT;

CREATE TRIGGER live_acquisition_provider_reservations_insert_guard
BEFORE INSERT ON live_acquisition_provider_reservations
WHEN NOT EXISTS (
  SELECT 1 FROM live_acquisition_handoffs AS handoff
  JOIN research_runs AS run ON run.id = handoff.final_run_id
  JOIN ai_jobs AS job ON job.id = run.job_id
  JOIN privacy_subject_generations AS coordinator_generation
    ON coordinator_generation.id = handoff.coordinator_run_generation_id
  JOIN research_runs AS coordinator_run
    ON coordinator_run.id = coordinator_generation.research_run_id
  JOIN live_acquisition_consents AS consent
    ON consent.coordinator_job_id = coordinator_run.job_id
    AND consent.coordinator_run_generation_id = coordinator_generation.id
  WHERE handoff.id = NEW.handoff_id
    AND handoff.status = 'assembling'
    AND run.job_id = NEW.final_job_id
    AND job.status = 'queued' AND job.event_sequence = 1
    AND consent.status IN ('active', 'consumed')
    AND NEW.reserved_usd <= json_extract(consent.limits_json, '$.max_cost_usd')
    AND NEW.reserved_usd <= job.max_cost_usd
    AND NEW.reserved_usd = job.max_cost_usd - job.spent_cost_usd
    AND NEW.consumed_usd = 0 AND NEW.status = 'active'
    AND NEW.terminal_at IS NULL
    AND NEW.utc_date = date(NEW.created_at)
    AND job.max_tokens > 0
    AND job.max_tokens <= json_extract(consent.limits_json, '$.max_output_tokens')
    AND (
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
            SELECT 1 FROM live_acquisition_provider_reservations AS active_reservation
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
      ) + NEW.reserved_usd
    ) <= 2
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition provider reservation ownership');
END;

CREATE TABLE live_acquisition_provider_reservation_adoptions (
  attempt_id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL,
  final_job_id INTEGER NOT NULL,
  utc_date TEXT NOT NULL CHECK (
    length(utc_date) = 10
      AND utc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND COALESCE(utc_date = date(utc_date), 0)
  ),
  adopted_at TEXT NOT NULL CHECK (
    COALESCE(adopted_at = strftime('%Y-%m-%dT%H:%M:%fZ', adopted_at), 0)
  ),
  FOREIGN KEY (attempt_id, final_job_id)
    REFERENCES ai_job_attempts(id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id, final_job_id)
    REFERENCES live_acquisition_provider_reservations(id, final_job_id)
      ON DELETE RESTRICT
) STRICT;

CREATE INDEX live_acquisition_provider_adoptions_utc_idx
ON live_acquisition_provider_reservation_adoptions(utc_date, final_job_id);

CREATE TRIGGER live_acquisition_provider_reservation_adoptions_insert_guard
BEFORE INSERT ON live_acquisition_provider_reservation_adoptions
WHEN NOT EXISTS (
  SELECT 1 FROM ai_job_attempts AS attempt
  JOIN ai_jobs AS job ON job.id = attempt.job_id
  JOIN live_acquisition_provider_reservations AS reservation
    ON reservation.id = NEW.reservation_id
    AND reservation.final_job_id = NEW.final_job_id
  JOIN live_acquisition_handoff_receipts AS receipt
    ON receipt.handoff_id = reservation.handoff_id
  WHERE attempt.id = NEW.attempt_id
    AND attempt.job_id = NEW.final_job_id
    AND attempt.outcome = 'running'
    AND attempt.provider IS NULL AND attempt.model IS NULL
    AND attempt.prompt_version IS NULL AND attempt.provider_bound_at IS NULL
    AND attempt.request_id IS NULL AND attempt.request_bound_at IS NULL
    AND job.status = 'running'
    AND job.lease_token = attempt.lease_token
    AND reservation.status = 'active'
    AND abs(reservation.reserved_usd - job.max_cost_usd) <= 1.0e-12
    AND abs(reservation.consumed_usd - job.spent_cost_usd) <= 1.0e-12
    AND reservation.utc_date = NEW.utc_date
    AND date(NEW.adopted_at) = NEW.utc_date
    AND NEW.adopted_at >= attempt.started_at
    AND NEW.adopted_at < job.lease_expires_at
    AND (
      SELECT COUNT(*) FROM ai_job_attempts AS counted_attempt
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
    ) < 10
    AND (
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
            SELECT 1 FROM live_acquisition_provider_reservations AS active_reservation
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
      )
    ) <= 2
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition provider reservation adoption');
END;

CREATE TRIGGER live_acquisition_provider_reservation_adoptions_immutable_update
BEFORE UPDATE ON live_acquisition_provider_reservation_adoptions
BEGIN
  SELECT RAISE(ABORT, 'live acquisition provider reservation adoptions are immutable');
END;

CREATE TRIGGER live_acquisition_final_provider_bind_requires_adoption
BEFORE UPDATE OF provider, model, prompt_version, provider_bound_at
ON ai_job_attempts
WHEN OLD.provider IS NULL AND NEW.provider IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM research_runs AS run
    JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
    WHERE run.job_id = OLD.job_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_acquisition_provider_reservation_adoptions AS adoption
    WHERE adoption.attempt_id = OLD.id
      AND adoption.final_job_id = OLD.job_id
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition provider reservation adoption is required');
END;

CREATE TRIGGER live_acquisition_final_provider_bind_requires_current_adoption
BEFORE UPDATE OF provider, model, prompt_version, provider_bound_at
ON ai_job_attempts
WHEN OLD.provider IS NULL AND NEW.provider IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM research_runs AS run
    JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
    WHERE run.job_id = OLD.job_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_acquisition_provider_reservation_adoptions AS adoption
    JOIN live_acquisition_provider_reservations AS reservation
      ON reservation.id = adoption.reservation_id
      AND reservation.final_job_id = adoption.final_job_id
    JOIN ai_jobs AS final_job ON final_job.id = adoption.final_job_id
    WHERE adoption.attempt_id = OLD.id
      AND adoption.final_job_id = OLD.job_id
      AND reservation.status = 'active'
      AND abs(reservation.reserved_usd - final_job.max_cost_usd) <= 1.0e-12
      AND abs(reservation.consumed_usd - final_job.spent_cost_usd) <= 1.0e-12
      AND adoption.utc_date = reservation.utc_date
      AND reservation.utc_date = substr(NEW.provider_bound_at, 1, 10)
      AND adoption.adopted_at = NEW.provider_bound_at
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition provider reservation adoption is not current');
END;

CREATE TRIGGER live_acquisition_provider_bind_rechecks_daily_caps
BEFORE UPDATE OF provider, model, prompt_version, provider_bound_at
ON ai_job_attempts
WHEN OLD.provider IS NULL AND NEW.provider IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ai_jobs AS binding_job
    WHERE binding_job.id = OLD.job_id
      AND binding_job.kind = 'resource_research'
      AND NOT (binding_job.workflow_id IS 'research_acquisition:c90:v1'
        AND binding_job.workflow_version IS 1)
      AND (
        (
          SELECT COUNT(*) FROM ai_job_attempts AS counted_attempt
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
            ) = COALESCE((
              SELECT binding_adoption.utc_date
              FROM live_acquisition_provider_reservation_adoptions
                AS binding_adoption
              WHERE binding_adoption.attempt_id = OLD.id
                AND binding_adoption.final_job_id = OLD.job_id
            ), substr(NEW.provider_bound_at, 1, 10))
        ) >= 10
        OR (
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
              ) = COALESCE((
                SELECT binding_adoption.utc_date
                FROM live_acquisition_provider_reservation_adoptions
                  AS binding_adoption
                WHERE binding_adoption.attempt_id = OLD.id
                  AND binding_adoption.final_job_id = OLD.job_id
              ), substr(NEW.provider_bound_at, 1, 10))
          ) + (
            SELECT COALESCE(SUM(active_reservation.reserved_usd
              - active_reservation.consumed_usd), 0)
            FROM live_acquisition_provider_reservations AS active_reservation
            WHERE active_reservation.status = 'active'
              AND active_reservation.utc_date = COALESCE((
                SELECT binding_adoption.utc_date
                FROM live_acquisition_provider_reservation_adoptions
                  AS binding_adoption
                WHERE binding_adoption.attempt_id = OLD.id
                  AND binding_adoption.final_job_id = OLD.job_id
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
                SELECT 1 FROM live_acquisition_provider_reservations AS active_reservation
                WHERE active_reservation.final_job_id = running_job.id
                  AND active_reservation.status = 'active'
              )
              AND (
                running_attempt.provider IS NULL
                OR COALESCE(
                  running_adoption.utc_date,
                  substr(running_attempt.provider_bound_at, 1, 10)
                ) = COALESCE((
                  SELECT binding_adoption.utc_date
                  FROM live_acquisition_provider_reservation_adoptions
                    AS binding_adoption
                  WHERE binding_adoption.attempt_id = OLD.id
                    AND binding_adoption.final_job_id = OLD.job_id
                ), substr(NEW.provider_bound_at, 1, 10))
              )
          )
        ) > 2
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition provider bind exceeds daily caps');
END;

CREATE TRIGGER live_acquisition_coordinator_provider_bind_forbidden
BEFORE UPDATE OF provider, model, prompt_version, provider_bound_at
ON ai_job_attempts
WHEN OLD.provider IS NULL AND NEW.provider IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ai_jobs AS job
    WHERE job.id = OLD.job_id
      AND job.workflow_id = 'research_acquisition:c90:v1'
      AND job.workflow_version = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition coordinator attempts cannot bind a provider');
END;

CREATE TRIGGER live_acquisition_coordinator_provider_usage_forbidden
BEFORE INSERT ON ai_job_events
WHEN NEW.event_type = 'progress'
  AND EXISTS (
    SELECT 1 FROM ai_jobs AS job
    WHERE job.id = NEW.job_id
      AND job.workflow_id = 'research_acquisition:c90:v1'
      AND job.workflow_version = 1
  )
  AND NOT (
    NEW.delta_input_tokens = 0
    AND NEW.delta_output_tokens = 0
    AND NEW.delta_cost_usd = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition coordinator provider usage must be zero');
END;

CREATE TRIGGER live_acquisition_handoff_receipts_capture_lineage_guard
BEFORE INSERT ON live_acquisition_handoff_receipts
WHEN EXISTS (
  SELECT 1 FROM live_acquisition_handoffs AS handoff
  JOIN live_acquisition_source_receipts AS receipt
    ON receipt.handoff_id = handoff.id
  WHERE handoff.id = NEW.handoff_id AND NOT EXISTS (
    SELECT 1 FROM live_acquisition_capture_manifests AS capture
    JOIN live_acquisition_consents AS consent ON consent.id = capture.consent_id
    WHERE capture.id = receipt.capture_manifest_id
      AND capture.logical_page_generation_id
        = receipt.logical_page_generation_id
      AND capture.depth = receipt.depth
      AND capture.capture_sequence = receipt.capture_sequence
      AND capture.content_digest = receipt.content_digest
      AND capture.manifest_json = receipt.manifest_json
      AND consent.coordinator_run_generation_id
        = handoff.coordinator_run_generation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition source receipt capture lineage is incomplete');
END;

CREATE TABLE live_acquisition_workflow_outcomes (
  id INTEGER PRIMARY KEY,
  coordinator_job_id INTEGER NOT NULL UNIQUE REFERENCES ai_jobs(id) ON DELETE RESTRICT,
  coordinator_run_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('handoff', 'captured_only', 'blocked', 'ambiguous', 'superseded')
  ),
  outcome_code TEXT NOT NULL CHECK (
    outcome_code IN (
      'LIVE_ACQUISITION_RESOURCE_REQUIRED',
      'LIVE_ACQUISITION_TARGET_UNSUPPORTED', 'RESEARCH_WORKFLOW_UNSUPPORTED',
      'LIVE_ACQUISITION_DISABLED', 'LIVE_ACQUISITION_DISABLED_IN_FLIGHT',
      'ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH',
      'SENSITIVE_URL_CAPTURE_REQUIRED', 'CONSENT_EXPIRED_IN_FLIGHT',
      'PURGE_WAITING_FOR_ACTION', 'SUBJECT_FORGOTTEN',
      'WORKFLOW_COMPLETED', 'WORKFLOW_BLOCKED', 'WORKFLOW_AMBIGUOUS',
      'WORKFLOW_FAILED', 'WORKFLOW_CANCELLED', 'NO_ELIGIBLE_SOURCE',
      'BUDGET_EXHAUSTED', 'POLICY_BLOCKED', 'PROVIDER_UNAVAILABLE'
    )
  ),
  safe_details_json TEXT NOT NULL CHECK (
    json_valid(safe_details_json) AND json_type(safe_details_json) = 'object'
      AND length(CAST(safe_details_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  )
) STRICT;

CREATE TRIGGER live_acquisition_workflow_outcomes_safe_details_guard
BEFORE INSERT ON live_acquisition_workflow_outcomes
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.safe_details_json) AS detail
  WHERE detail.key NOT IN (
    'hostname_digest', 'url_digest', 'address_digest', 'content_digest',
    'response_class', 'outcome_class', 'redirect_count', 'response_bytes',
    'duration_ms', 'dns_answer_count', 'attempt_count'
  ) OR (
    detail.key IN ('hostname_digest', 'url_digest', 'address_digest', 'content_digest')
    AND (detail.type <> 'text' OR length(detail.value) <> 64
      OR detail.value GLOB '*[^0-9a-f]*')
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
  SELECT RAISE(ABORT, 'live acquisition workflow outcome details are not safe');
END;

CREATE TRIGGER live_acquisition_workflow_outcomes_insert_guard
BEFORE INSERT ON live_acquisition_workflow_outcomes
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_subject_generations AS generation
  JOIN research_runs AS run ON run.id = generation.research_run_id
  JOIN ai_jobs AS job ON job.id = run.job_id
  WHERE generation.id = NEW.coordinator_run_generation_id
    AND generation.subject_kind = 'research_run'
    AND generation.is_active = 1
    AND run.job_id = NEW.coordinator_job_id
    AND job.kind = 'resource_research'
    AND job.resource_id = run.target_resource_id
    AND (
      (
        run.workflow_id = 'research_acquisition:c90:v1'
        AND run.workflow_version = 1
        AND job.workflow_id = 'research_acquisition:c90:v1'
        AND job.workflow_version = 1
        AND NEW.outcome_code <> 'RESEARCH_WORKFLOW_UNSUPPORTED'
      )
      OR (
        run.workflow_id = job.workflow_id
        AND run.workflow_version = job.workflow_version
        AND NOT (
          (run.workflow_id = 'research_workflow:c81:v1'
            AND run.workflow_version = 1)
          OR (run.workflow_id = 'research_acquisition:c90:v1'
            AND run.workflow_version = 1)
        )
        AND job.status = 'superseded'
        AND EXISTS (
          SELECT 1 FROM research_run_heads AS head
          WHERE head.run_id = run.id AND head.status = 'superseded'
        )
        AND NEW.outcome = 'superseded'
        AND NEW.outcome_code = 'RESEARCH_WORKFLOW_UNSUPPORTED'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition workflow outcome ownership');
END;

CREATE TRIGGER live_acquisition_consent_payloads_immutable_update
BEFORE UPDATE ON live_acquisition_consent_payloads
BEGIN
  SELECT RAISE(ABORT, 'live acquisition consent payload is immutable');
END;

CREATE TRIGGER live_acquisition_digest_keys_immutable_update
BEFORE UPDATE ON live_acquisition_digest_keys
BEGIN
  SELECT RAISE(ABORT, 'live acquisition digest key is immutable');
END;

CREATE TRIGGER live_acquisition_action_authorizations_immutable_update
BEFORE UPDATE ON live_acquisition_action_authorizations
BEGIN
  SELECT RAISE(ABORT, 'live acquisition action authorization is immutable');
END;

CREATE TRIGGER live_acquisition_url_payloads_immutable_update
BEFORE UPDATE ON live_acquisition_url_payloads
BEGIN
  SELECT RAISE(ABORT, 'live acquisition URL payload is immutable');
END;

CREATE TRIGGER live_acquisition_dns_payloads_immutable_update
BEFORE UPDATE ON live_acquisition_dns_payloads
BEGIN
  SELECT RAISE(ABORT, 'live acquisition DNS payload is immutable');
END;

CREATE TRIGGER live_acquisition_body_payloads_immutable_update
BEFORE UPDATE ON live_acquisition_body_payloads
BEGIN
  SELECT RAISE(ABORT, 'live acquisition body payload is immutable');
END;

CREATE TRIGGER live_acquisition_capture_manifests_immutable_update
BEFORE UPDATE ON live_acquisition_capture_manifests
BEGIN
  SELECT RAISE(ABORT, 'live acquisition capture manifest is immutable');
END;

CREATE TRIGGER live_acquisition_workflow_outcomes_immutable_update
BEFORE UPDATE ON live_acquisition_workflow_outcomes
BEGIN
  SELECT RAISE(ABORT, 'live acquisition workflow outcome is immutable');
END;

CREATE TRIGGER live_acquisition_consents_validate_update
BEFORE UPDATE ON live_acquisition_consents
WHEN NOT (
  OLD.status = 'active' AND NEW.status IN ('expired', 'consumed', 'revoked')
  AND NEW.terminal_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.resource_generation_id IS OLD.resource_generation_id
  AND NEW.history_epoch_id IS OLD.history_epoch_id
  AND NEW.coordinator_job_id IS OLD.coordinator_job_id
  AND NEW.coordinator_run_generation_id IS OLD.coordinator_run_generation_id
  AND NEW.runtime_epoch IS OLD.runtime_epoch
  AND NEW.consent_fingerprint IS OLD.consent_fingerprint
  AND NEW.origin_set_digest IS OLD.origin_set_digest
  AND NEW.limits_json IS OLD.limits_json
  AND NEW.created_at IS OLD.created_at AND NEW.expires_at IS OLD.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition consent transition');
END;

CREATE TRIGGER live_acquisition_checkpoints_validate_update
BEFORE UPDATE ON live_acquisition_checkpoints
WHEN NOT (
  NEW.attempt_id IS OLD.attempt_id
  AND NEW.coordinator_job_id IS OLD.coordinator_job_id
  AND NEW.consent_id IS OLD.consent_id
  AND NEW.runtime_epoch IS OLD.runtime_epoch
  AND NEW.updated_at > OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition checkpoint update');
END;

CREATE TRIGGER live_acquisition_origin_courtesy_state_validate_update
BEFORE UPDATE ON live_acquisition_origin_courtesy_state
WHEN NOT (
  NEW.coordinator_run_id IS OLD.coordinator_run_id
  AND NEW.coordinator_run_generation_id IS OLD.coordinator_run_generation_id
  AND NEW.consent_id IS OLD.consent_id
  AND NEW.canonical_origin_digest IS OLD.canonical_origin_digest
  AND NEW.origin_digest IS OLD.origin_digest
  AND NEW.updated_at > OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition origin courtesy update');
END;

CREATE TRIGGER live_acquisition_provider_reservations_validate_update
BEFORE UPDATE ON live_acquisition_provider_reservations
WHEN NOT (
  NEW.id IS OLD.id AND NEW.handoff_id IS OLD.handoff_id
  AND NEW.final_job_id IS OLD.final_job_id
  AND NEW.reserved_usd IS OLD.reserved_usd
  AND NEW.created_at IS OLD.created_at
  AND OLD.status = 'active'
  AND (
    (
      NEW.utc_date IS OLD.utc_date
      AND (
        (
          NEW.status = 'active' AND NEW.terminal_at IS NULL
          AND NEW.consumed_usd > OLD.consumed_usd
          AND NEW.consumed_usd = (
            SELECT COALESCE(SUM(event.delta_cost_usd), 0)
            FROM ai_job_events AS event
            JOIN live_acquisition_provider_reservation_adoptions AS adoption
              ON adoption.attempt_id = event.attempt_id
              AND adoption.final_job_id = event.job_id
            WHERE adoption.reservation_id = OLD.id
              AND event.event_type = 'progress'
          )
        )
        OR (
          NEW.consumed_usd IS OLD.consumed_usd
          AND NEW.terminal_at IS NOT NULL
          AND NEW.status = CASE
            WHEN OLD.consumed_usd = OLD.reserved_usd THEN 'consumed'
            ELSE 'released'
          END
          AND EXISTS (
            SELECT 1 FROM ai_job_events AS terminal_event
            WHERE terminal_event.job_id = OLD.final_job_id
              AND terminal_event.to_status IN (
                'succeeded', 'partial', 'failed', 'cancelled', 'superseded'
              )
              AND terminal_event.occurred_at = NEW.terminal_at
              AND terminal_event.sequence_no = (
                SELECT MAX(latest_event.sequence_no)
                FROM ai_job_events AS latest_event
                WHERE latest_event.job_id = OLD.final_job_id
              )
          )
        )
      )
    )
    OR (
      NEW.status = 'active' AND NEW.terminal_at IS NULL
      AND NEW.consumed_usd IS OLD.consumed_usd
      AND NEW.utc_date > OLD.utc_date
      AND (
        EXISTS (
          SELECT 1 FROM ai_jobs AS job
          WHERE job.id = OLD.final_job_id AND job.status = 'queued'
        )
        OR EXISTS (
          SELECT 1 FROM ai_jobs AS job
          JOIN ai_job_attempts AS attempt
            ON attempt.job_id = job.id AND attempt.outcome = 'running'
          WHERE job.id = OLD.final_job_id AND job.status = 'running'
            AND attempt.provider IS NULL AND attempt.model IS NULL
            AND attempt.prompt_version IS NULL
            AND attempt.provider_bound_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM live_acquisition_provider_reservation_adoptions AS adoption
              WHERE adoption.attempt_id = attempt.id
                AND adoption.final_job_id = job.id
            )
        )
      )
      AND (
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
              SELECT 1 FROM live_acquisition_provider_reservations AS active_reservation
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
        )
      ) <= 2
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid live acquisition provider reservation update');
END;

CREATE TRIGGER live_acquisition_provider_usage_requires_active_adoption
BEFORE INSERT ON ai_job_events
WHEN NEW.event_type = 'progress'
  AND (
    COALESCE(NEW.delta_input_tokens, 0) > 0
    OR COALESCE(NEW.delta_output_tokens, 0) > 0
    OR COALESCE(NEW.delta_cost_usd, 0) > 0
  )
  AND EXISTS (
    SELECT 1 FROM research_runs AS run
    JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
    JOIN live_acquisition_provider_reservations AS reservation
      ON reservation.handoff_id = handoff.id
      AND reservation.final_job_id = run.job_id
    WHERE run.job_id = NEW.job_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_acquisition_provider_reservation_adoptions AS adoption
    JOIN live_acquisition_provider_reservations AS reservation
      ON reservation.id = adoption.reservation_id
      AND reservation.final_job_id = adoption.final_job_id
    JOIN ai_job_attempts AS attempt
      ON attempt.id = adoption.attempt_id
      AND attempt.job_id = adoption.final_job_id
    WHERE adoption.attempt_id = NEW.attempt_id
      AND adoption.final_job_id = NEW.job_id
      AND attempt.provider IS NOT NULL AND attempt.model IS NOT NULL
      AND attempt.prompt_version IS NOT NULL AND attempt.pricing_version IS NOT NULL
      AND attempt.provider_bound_at = adoption.adopted_at
      AND adoption.utc_date = reservation.utc_date
      AND reservation.utc_date = substr(attempt.provider_bound_at, 1, 10)
      AND reservation.status = 'active'
      AND reservation.consumed_usd + NEW.delta_cost_usd
        <= reservation.reserved_usd
  )
BEGIN
  SELECT RAISE(ABORT, 'live acquisition provider usage requires active reservation adoption');
END;

CREATE TRIGGER live_acquisition_provider_usage_consume_reservation
AFTER INSERT ON ai_job_events
WHEN NEW.event_type = 'progress' AND COALESCE(NEW.delta_cost_usd, 0) > 0
BEGIN
  UPDATE live_acquisition_provider_reservations
  SET consumed_usd = consumed_usd + NEW.delta_cost_usd
  WHERE status = 'active'
    AND EXISTS (
      SELECT 1 FROM live_acquisition_provider_reservation_adoptions AS adoption
      WHERE adoption.attempt_id = NEW.attempt_id
        AND adoption.final_job_id = NEW.job_id
        AND adoption.reservation_id = live_acquisition_provider_reservations.id
    );
END;

CREATE TRIGGER live_acquisition_provider_terminal_closes_reservation
AFTER INSERT ON ai_job_events
WHEN NEW.to_status IN ('succeeded', 'partial', 'failed', 'cancelled', 'superseded')
BEGIN
  UPDATE live_acquisition_provider_reservations
  SET status = CASE
      WHEN consumed_usd = reserved_usd THEN 'consumed'
      ELSE 'released'
    END,
    terminal_at = NEW.occurred_at
  WHERE final_job_id = NEW.job_id AND status = 'active';
END;

CREATE TABLE privacy_purge_commands (
  id INTEGER PRIMARY KEY,
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
  subject_generation_id INTEGER
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  history_epoch_id INTEGER REFERENCES research_history_epochs(id) ON DELETE RESTRICT,
  deletion_target_count INTEGER NOT NULL CHECK (
    deletion_target_count BETWEEN 0 AND 250000
  ),
  deletion_plan_digest TEXT NOT NULL CHECK (
    length(deletion_plan_digest) = 64
      AND deletion_plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle_target_count INTEGER NOT NULL DEFAULT 0 CHECK (
    lifecycle_target_count BETWEEN 0 AND 250000
  ),
  lifecycle_plan_digest TEXT NOT NULL DEFAULT
    '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (
      length(lifecycle_plan_digest) = 64
        AND lifecycle_plan_digest NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'completed', 'failed')),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  CHECK (
    (target_kind IN ('run', 'logical_page') AND subject_generation_id IS NOT NULL
      AND history_epoch_id IS NULL)
    OR (target_kind = 'resource_history' AND subject_generation_id IS NULL
      AND history_epoch_id IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX privacy_purge_commands_active_subject_idx
ON privacy_purge_commands(subject_generation_id)
WHERE status IN ('pending', 'waiting') AND subject_generation_id IS NOT NULL;

CREATE UNIQUE INDEX privacy_purge_commands_active_history_epoch_idx
ON privacy_purge_commands(history_epoch_id)
WHERE status IN ('pending', 'waiting') AND history_epoch_id IS NOT NULL;

CREATE TRIGGER research_runs_open_history_purge_insert_guard
BEFORE INSERT ON research_runs
WHEN NEW.history_epoch_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM privacy_purge_commands AS command
  WHERE command.target_kind = 'resource_history'
    AND command.history_epoch_id = NEW.history_epoch_id
    AND command.status IN ('pending', 'waiting')
)
BEGIN
  SELECT RAISE(ABORT, 'research run history epoch has open privacy purge');
END;

CREATE TABLE privacy_purge_transaction_fence_roots (
  id INTEGER PRIMARY KEY
) STRICT;

CREATE TRIGGER privacy_purge_transaction_fence_roots_no_insert
BEFORE INSERT ON privacy_purge_transaction_fence_roots
BEGIN
  SELECT RAISE(ABORT, 'privacy purge transaction fence roots stay empty');
END;

CREATE TABLE privacy_purge_transaction_fences (
  nonce_digest TEXT PRIMARY KEY CHECK (
    length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  missing_root_id INTEGER NOT NULL DEFAULT 1
    REFERENCES privacy_purge_transaction_fence_roots(id)
      DEFERRABLE INITIALLY DEFERRED,
  CHECK (missing_root_id = 1)
) STRICT;

CREATE TRIGGER privacy_purge_transaction_fences_insert_guard
BEFORE INSERT ON privacy_purge_transaction_fences
WHEN tabhub_purge_fence_install_v1(NEW.nonce_digest) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge transaction fence requires local installer');
END;

CREATE TRIGGER privacy_purge_transaction_fences_immutable_update
BEFORE UPDATE ON privacy_purge_transaction_fences
BEGIN
  SELECT RAISE(ABORT, 'privacy purge transaction fence is immutable');
END;

CREATE TRIGGER privacy_purge_transaction_fences_delete_guard
BEFORE DELETE ON privacy_purge_transaction_fences
WHEN tabhub_purge_fence_remove_v1(OLD.nonce_digest) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge transaction fence requires local remover');
END;

CREATE TABLE privacy_purge_authorities (
  command_id INTEGER NOT NULL REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  table_name TEXT NOT NULL CHECK (
    length(CAST(table_name AS BLOB)) BETWEEN 1 AND 128
  ),
  pk_v1 TEXT NOT NULL CHECK (
    length(CAST(pk_v1 AS BLOB)) BETWEEN 10 AND 2048
      AND substr(pk_v1, 1, 6) = 'pk:v1|'
  ),
  nonce_digest TEXT NOT NULL CHECK (
    length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  consumed_at TEXT CHECK (
    COALESCE(consumed_at IS NULL OR (
      consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at)
      AND consumed_at >= created_at
    ), 0)
  ),
  PRIMARY KEY (command_id, table_name, pk_v1),
  UNIQUE (table_name, pk_v1, nonce_digest)
) STRICT;

CREATE TABLE privacy_purge_lifecycle_targets (
  purge_command_id INTEGER NOT NULL
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  subject_generation_id INTEGER NOT NULL
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  generation_token TEXT NOT NULL CHECK (
    length(generation_token) = 64
      AND generation_token NOT GLOB '*[^0-9a-f]*'
  ),
  research_run_id INTEGER NOT NULL,
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  PRIMARY KEY (purge_command_id, subject_generation_id),
  UNIQUE (purge_command_id, research_run_id)
) STRICT;

CREATE UNIQUE INDEX privacy_purge_lifecycle_targets_root_idx
ON privacy_purge_lifecycle_targets(purge_command_id)
WHERE is_root = 1;

CREATE TRIGGER privacy_purge_lifecycle_targets_insert_guard
BEFORE INSERT ON privacy_purge_lifecycle_targets
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_purge_commands AS command
  JOIN privacy_subject_generations AS generation
    ON generation.id = NEW.subject_generation_id
  WHERE command.id = NEW.purge_command_id
    AND command.target_kind IN ('run', 'resource_history')
    AND command.status = 'pending'
    AND command.lifecycle_target_count = 0
    AND command.lifecycle_plan_digest
      = '0000000000000000000000000000000000000000000000000000000000000000'
    AND generation.subject_kind = 'research_run'
    AND generation.generation_token = NEW.generation_token
    AND generation.research_run_id = NEW.research_run_id
    AND generation.is_active = 1
    AND (
      (command.target_kind = 'run'
        AND NEW.is_root = (generation.id = command.subject_generation_id))
      OR (command.target_kind = 'resource_history' AND NEW.is_root = 0
        AND EXISTS (
          SELECT 1 FROM research_runs AS run
          WHERE run.id = NEW.research_run_id
            AND run.history_epoch_id = command.history_epoch_id
        ))
    )
)
OR EXISTS (
  SELECT 1
  FROM privacy_purge_lifecycle_targets AS existing_target
  JOIN privacy_purge_commands AS existing_command
    ON existing_command.id = existing_target.purge_command_id
  WHERE existing_command.id <> NEW.purge_command_id
    AND existing_command.status IN ('pending', 'waiting')
    AND existing_target.subject_generation_id = NEW.subject_generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge lifecycle target is not in command freeze or overlaps an active command');
END;

CREATE TRIGGER privacy_purge_lifecycle_targets_immutable_update
BEFORE UPDATE ON privacy_purge_lifecycle_targets
BEGIN
  SELECT RAISE(ABORT, 'privacy purge lifecycle targets are immutable');
END;

CREATE TRIGGER privacy_purge_lifecycle_targets_immutable_delete
BEFORE DELETE ON privacy_purge_lifecycle_targets
BEGIN
  SELECT RAISE(ABORT, 'privacy purge lifecycle targets are permanent');
END;

CREATE TABLE privacy_purge_results (
  command_id INTEGER PRIMARY KEY
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  safe_counts_json TEXT NOT NULL CHECK (
    json_valid(safe_counts_json) AND json_type(safe_counts_json) = 'object'
      AND length(CAST(safe_counts_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  result_digest TEXT NOT NULL UNIQUE CHECK (
    length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at TEXT NOT NULL CHECK (
    COALESCE(completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at), 0)
  )
) STRICT;

CREATE TRIGGER privacy_purge_results_safe_counts_guard
BEFORE INSERT ON privacy_purge_results
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.safe_counts_json) AS count_entry
  WHERE count_entry.key NOT IN (
    'deleted_rows', 'redacted_rows', 'detached_rows', 'cancelled_jobs',
    'retired_generations', 'removed_payloads', 'removed_sources',
    'removed_reports', 'removed_context_entries', 'removed_priority_records',
    'removed_activity_records', 'removed_relations'
  ) OR count_entry.type <> 'integer' OR count_entry.value < 0
    OR count_entry.value > 9007199254740991
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge result counts are not safe');
END;

CREATE TRIGGER privacy_purge_results_insert_guard
BEFORE INSERT ON privacy_purge_results
WHEN tabhub_purge_finalization_active_v1(NEW.command_id) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM privacy_purge_transaction_fences AS fence
    WHERE fence.nonce_digest
      = tabhub_purge_finalization_nonce_v1(NEW.command_id)
  )
  OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_commands AS command
  WHERE command.id = NEW.command_id
    AND command.status IN ('pending', 'waiting')
    AND NOT EXISTS (
      SELECT 1 FROM privacy_purge_authorities AS authority
      WHERE authority.command_id = command.id AND authority.consumed_at IS NULL
    )
    AND (
      (NEW.outcome = 'completed' AND (
        (
          command.target_kind = 'run'
          AND command.lifecycle_target_count = (
            SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = command.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            LEFT JOIN privacy_subject_tombstones AS tombstone
              ON tombstone.purge_command_id = target.purge_command_id
              AND tombstone.subject_generation_id = target.subject_generation_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = command.id
              AND (
                tombstone.id IS NULL
                OR generation.generation_token <> target.generation_token
                OR generation.is_active <> 0
                OR generation.research_run_id IS NOT NULL
              )
          )
        )
        OR (
          command.target_kind = 'resource_history'
          AND (CASE WHEN command.lifecycle_target_count = 0 THEN 1
            ELSE command.lifecycle_target_count END) = (
            SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = command.id
              AND tombstone.history_epoch_id = command.history_epoch_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            LEFT JOIN privacy_subject_tombstones AS tombstone
              ON tombstone.purge_command_id = target.purge_command_id
              AND tombstone.subject_generation_id = target.subject_generation_id
              AND tombstone.history_epoch_id = command.history_epoch_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = command.id
              AND (tombstone.id IS NULL
                OR generation.generation_token <> target.generation_token
                OR generation.is_active <> 0
                OR generation.research_run_id IS NOT NULL)
          )
        )
        OR (
          command.target_kind = 'logical_page'
          AND EXISTS (
            SELECT 1 FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = command.id
              AND tombstone.subject_generation_id IS command.subject_generation_id
              AND tombstone.history_epoch_id IS command.history_epoch_id
          )
        )
      ))
      OR (NEW.outcome = 'failed' AND NOT EXISTS (
        SELECT 1 FROM privacy_subject_tombstones AS tombstone
        WHERE tombstone.purge_command_id = command.id
      ) AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_authorities AS authority
        WHERE authority.command_id = command.id
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge result does not close its command');
END;

CREATE TRIGGER privacy_purge_results_immutable_update
BEFORE UPDATE ON privacy_purge_results
BEGIN
  SELECT RAISE(ABORT, 'privacy purge results are immutable');
END;

CREATE TRIGGER privacy_purge_authorities_validate_update
BEFORE UPDATE ON privacy_purge_authorities
WHEN NOT (
  OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
  AND NEW.command_id IS OLD.command_id
  AND NEW.table_name IS OLD.table_name AND NEW.pk_v1 IS OLD.pk_v1
  AND NEW.nonce_digest IS OLD.nonce_digest AND NEW.created_at IS OLD.created_at
  AND EXISTS (
    SELECT 1 FROM privacy_purge_transaction_fences AS fence
    WHERE fence.nonce_digest = OLD.nonce_digest
  )
  AND tabhub_purge_authority_consume_v1(
    OLD.command_id, OLD.table_name, OLD.pk_v1, OLD.nonce_digest
  ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'privacy purge authority is one-shot');
END;

CREATE TABLE privacy_subject_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_generation_id INTEGER
    REFERENCES privacy_subject_generations(id) ON DELETE RESTRICT,
  history_epoch_id INTEGER REFERENCES research_history_epochs(id) ON DELETE RESTRICT,
  purge_command_id INTEGER NOT NULL
    REFERENCES privacy_purge_commands(id) ON DELETE RESTRICT,
  tombstone_digest TEXT NOT NULL UNIQUE CHECK (
    length(tombstone_digest) = 64
      AND tombstone_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    COALESCE(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)
  ),
  CHECK (subject_generation_id IS NOT NULL OR history_epoch_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX privacy_subject_tombstones_generation_idx
ON privacy_subject_tombstones(subject_generation_id)
WHERE subject_generation_id IS NOT NULL;

CREATE INDEX privacy_subject_tombstones_history_epoch_idx
ON privacy_subject_tombstones(history_epoch_id)
WHERE history_epoch_id IS NOT NULL;

CREATE INDEX privacy_subject_tombstones_command_history_idx
ON privacy_subject_tombstones(purge_command_id)
WHERE history_epoch_id IS NOT NULL;

CREATE TRIGGER privacy_subject_tombstones_immutable_update
BEFORE UPDATE ON privacy_subject_tombstones
BEGIN
  SELECT RAISE(ABORT, 'privacy subject tombstones are permanent');
END;

CREATE TRIGGER privacy_purge_commands_insert_guard
BEFORE INSERT ON privacy_purge_commands
WHEN NEW.lifecycle_target_count <> 0
OR NEW.lifecycle_plan_digest <>
  '0000000000000000000000000000000000000000000000000000000000000000'
OR EXISTS (
  SELECT 1 FROM privacy_subject_tombstones AS tombstone
  WHERE tombstone.subject_generation_id = NEW.subject_generation_id
    OR tombstone.history_epoch_id = NEW.history_epoch_id
)
OR NOT (
  (NEW.target_kind = 'logical_page' AND EXISTS (
    SELECT 1 FROM privacy_subject_generations AS generation
    JOIN logical_pages AS page ON page.id = generation.logical_page_id
    WHERE generation.id = NEW.subject_generation_id
      AND generation.subject_kind = 'logical_page' AND generation.is_active = 1
  ))
  OR (NEW.target_kind = 'run' AND EXISTS (
    SELECT 1 FROM privacy_subject_generations AS generation
    JOIN research_runs AS run ON run.id = generation.research_run_id
    WHERE generation.id = NEW.subject_generation_id
      AND generation.subject_kind = 'research_run' AND generation.is_active = 1
  ))
  OR (NEW.target_kind = 'resource_history' AND EXISTS (
    SELECT 1 FROM research_history_epochs AS history
    JOIN privacy_subject_generations AS generation
      ON generation.id = history.resource_generation_id
    JOIN resources AS resource ON resource.id = history.resource_id
    WHERE history.id = NEW.history_epoch_id AND history.is_active = 1
      AND generation.subject_kind = 'resource'
      AND generation.resource_id = history.resource_id
      AND generation.is_active = 1
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'SUBJECT_FORGOTTEN_OR_INVALID');
END;

CREATE TRIGGER privacy_purge_commands_freeze_run_lifecycle
AFTER INSERT ON privacy_purge_commands
WHEN NEW.target_kind = 'run'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM privacy_subject_generations AS root
    WHERE root.id = NEW.subject_generation_id
      AND root.subject_kind = 'research_run'
      AND root.research_run_id IS NOT NULL
      AND root.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM live_acquisition_handoffs AS incoming_root
        WHERE incoming_root.final_run_id = root.research_run_id
      )
      AND (
        SELECT COUNT(*) FROM live_acquisition_handoffs AS root_edge
        WHERE root_edge.coordinator_run_generation_id = root.id
      ) BETWEEN 0 AND 1
      AND (
        NOT EXISTS (
          SELECT 1 FROM live_acquisition_handoffs AS root_edge
          WHERE root_edge.coordinator_run_generation_id = root.id
        )
        OR EXISTS (
          SELECT 1
          FROM live_acquisition_handoffs AS semantic_edge
          JOIN research_runs AS coordinator_run
            ON coordinator_run.id = root.research_run_id
          JOIN research_run_heads AS coordinator_head
            ON coordinator_head.run_id = coordinator_run.id
          JOIN ai_jobs AS coordinator_job
            ON coordinator_job.id = coordinator_run.job_id
          JOIN privacy_subject_generations AS final_generation
            ON final_generation.subject_kind = 'research_run'
            AND final_generation.research_run_id = semantic_edge.final_run_id
            AND final_generation.is_active = 1
          JOIN research_runs AS final_run
            ON final_run.id = final_generation.research_run_id
          JOIN ai_jobs AS final_job ON final_job.id = final_run.job_id
          JOIN live_acquisition_handoff_receipts AS terminal_receipt
            ON terminal_receipt.handoff_id = semantic_edge.id
          WHERE semantic_edge.coordinator_run_generation_id = root.id
            AND semantic_edge.status = 'completed'
            AND semantic_edge.completed_at = terminal_receipt.completed_at
            AND coordinator_job.kind = 'resource_research'
            AND coordinator_job.workflow_id = 'research_acquisition:c90:v1'
            AND coordinator_job.workflow_version = 1
            AND coordinator_job.status = 'superseded'
            AND coordinator_head.status = 'superseded'
            AND coordinator_run.workflow_id = 'research_acquisition:c90:v1'
            AND coordinator_run.workflow_version = 1
            AND final_job.kind = 'resource_research'
            AND final_job.workflow_id = 'research_workflow:c81:v1'
            AND final_job.workflow_version = 1
            AND final_run.workflow_id = 'research_workflow:c81:v1'
            AND final_run.workflow_version = 1
            AND coordinator_job.resource_id IS NOT NULL
            AND coordinator_run.target_resource_id = coordinator_job.resource_id
            AND coordinator_run.target_key = coordinator_job.subject_key
            AND final_job.resource_id = coordinator_job.resource_id
            AND final_run.target_resource_id = coordinator_run.target_resource_id
            AND final_run.target_key = coordinator_run.target_key
            AND final_job.subject_key = coordinator_job.subject_key
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM live_acquisition_handoffs AS root_edge
        LEFT JOIN privacy_subject_generations AS descendant
          ON descendant.subject_kind = 'research_run'
          AND descendant.research_run_id = root_edge.final_run_id
          AND descendant.is_active = 1
        WHERE root_edge.coordinator_run_generation_id = root.id
          AND (
            descendant.id IS NULL
            OR descendant.id = root.id
            OR (
              SELECT COUNT(*) FROM live_acquisition_handoffs AS incoming_final
              WHERE incoming_final.final_run_id = root_edge.final_run_id
            ) <> 1
            OR EXISTS (
              SELECT 1
              FROM live_acquisition_handoffs AS extension
              JOIN privacy_subject_generations AS extension_generation
                ON extension_generation.id
                  = extension.coordinator_run_generation_id
              WHERE extension_generation.subject_kind = 'research_run'
                AND extension_generation.research_run_id
                  = root_edge.final_run_id
            )
          )
      )
  ) THEN RAISE(
    ABORT, 'invalid privacy purge run lifecycle graph'
  ) END;

  INSERT INTO privacy_purge_lifecycle_targets (
    purge_command_id, subject_generation_id, generation_token,
    research_run_id, is_root
  )
  WITH RECURSIVE run_graph (
    subject_generation_id, generation_token, research_run_id
  ) AS (
    SELECT generation.id, generation.generation_token,
      generation.research_run_id
    FROM privacy_subject_generations AS generation
    WHERE generation.id = NEW.subject_generation_id
      AND generation.subject_kind = 'research_run'
      AND generation.is_active = 1
    UNION
    SELECT descendant.id, descendant.generation_token,
      descendant.research_run_id
    FROM run_graph AS ancestor
    JOIN live_acquisition_handoffs AS handoff
      ON handoff.coordinator_run_generation_id
        = ancestor.subject_generation_id
    JOIN privacy_subject_generations AS descendant
      ON descendant.subject_kind = 'research_run'
      AND descendant.research_run_id = handoff.final_run_id
      AND descendant.is_active = 1
    LIMIT 3
  )
  SELECT NEW.id, subject_generation_id, generation_token, research_run_id,
    subject_generation_id = NEW.subject_generation_id
  FROM run_graph
  ORDER BY subject_generation_id;

  SELECT CASE WHEN (
    SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
    WHERE purge_command_id = NEW.id
  ) > 2 THEN RAISE(
    ABORT, 'privacy purge run lifecycle graph exceeds closed root-final bound'
  ) END;

  UPDATE privacy_purge_commands
  SET lifecycle_target_count = (
      SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
      WHERE purge_command_id = NEW.id
    ),
    lifecycle_plan_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(json(binding_json))
      FROM (
        SELECT json_object(
          'subjectGenerationId', subject_generation_id,
          'generationToken', generation_token,
          'researchRunId', research_run_id
        ) AS binding_json
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = NEW.id
        ORDER BY subject_generation_id
      )
    ), '[]'))
  WHERE id = NEW.id;

  SELECT CASE WHEN (
    SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
    WHERE purge_command_id = NEW.id AND is_root = 1
  ) <> 1 THEN RAISE(ABORT, 'privacy purge lifecycle root freeze failed') END;
END;

CREATE TRIGGER privacy_purge_commands_freeze_history_lifecycle
AFTER INSERT ON privacy_purge_commands
WHEN NEW.target_kind = 'resource_history'
BEGIN
  INSERT INTO privacy_purge_lifecycle_targets (
    purge_command_id, subject_generation_id, generation_token,
    research_run_id, is_root
  )
  SELECT NEW.id, generation.id, generation.generation_token, run.id, 0
  FROM research_runs AS run
  JOIN privacy_subject_generations AS generation
    ON generation.subject_kind = 'research_run'
    AND generation.research_run_id = run.id
    AND generation.is_active = 1
  WHERE run.history_epoch_id = NEW.history_epoch_id
  ORDER BY generation.id;

  UPDATE privacy_purge_commands
  SET lifecycle_target_count = (
      SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
      WHERE purge_command_id = NEW.id
    ),
    lifecycle_plan_digest = tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(json(binding_json))
      FROM (
        SELECT json_object(
          'subjectGenerationId', subject_generation_id,
          'generationToken', generation_token,
          'researchRunId', research_run_id
        ) AS binding_json
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = NEW.id
        ORDER BY subject_generation_id
      )
    ), '[]'))
  WHERE id = NEW.id;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM privacy_purge_lifecycle_targets
    WHERE purge_command_id = NEW.id AND is_root <> 0
  ) THEN RAISE(ABORT, 'privacy purge history lifecycle root freeze failed') END;
END;

CREATE TRIGGER privacy_purge_commands_validate_update
BEFORE UPDATE ON privacy_purge_commands
WHEN NOT (
  NEW.id IS OLD.id AND NEW.idempotency_key_hash IS OLD.idempotency_key_hash
  AND NEW.request_fingerprint IS OLD.request_fingerprint
  AND NEW.target_kind IS OLD.target_kind
  AND NEW.subject_generation_id IS OLD.subject_generation_id
  AND NEW.history_epoch_id IS OLD.history_epoch_id
  AND NEW.deletion_target_count IS OLD.deletion_target_count
  AND NEW.deletion_plan_digest IS OLD.deletion_plan_digest
  AND NEW.created_at IS OLD.created_at
  AND (
    (
      OLD.target_kind IN ('run', 'resource_history')
      AND OLD.status = 'pending' AND NEW.status = 'pending'
      AND OLD.lifecycle_target_count = 0
      AND OLD.lifecycle_plan_digest
        = '0000000000000000000000000000000000000000000000000000000000000000'
      AND NEW.lifecycle_target_count BETWEEN
        CASE WHEN OLD.target_kind = 'run' THEN 1 ELSE 0 END AND 250000
      AND NEW.lifecycle_target_count = (
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = OLD.id
      )
      AND NEW.lifecycle_plan_digest = tabhub_sha256_v1(COALESCE((
        SELECT json_group_array(json(binding_json))
        FROM (
          SELECT json_object(
            'subjectGenerationId', subject_generation_id,
            'generationToken', generation_token,
            'researchRunId', research_run_id
          ) AS binding_json
          FROM privacy_purge_lifecycle_targets
          WHERE purge_command_id = OLD.id
          ORDER BY subject_generation_id
        )
      ), '[]'))
      AND (
        (OLD.target_kind = 'run' AND (
          SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
          WHERE purge_command_id = OLD.id AND is_root = 1
            AND subject_generation_id = OLD.subject_generation_id
        ) = 1)
        OR (OLD.target_kind = 'resource_history' AND NOT EXISTS (
          SELECT 1 FROM privacy_purge_lifecycle_targets
          WHERE purge_command_id = OLD.id AND is_root <> 0
        ))
      )
    )
    OR (
      NEW.lifecycle_target_count IS OLD.lifecycle_target_count
      AND NEW.lifecycle_plan_digest IS OLD.lifecycle_plan_digest
      AND (
        (OLD.status = 'pending'
          AND NEW.status IN ('waiting', 'completed', 'failed'))
        OR (OLD.status = 'waiting' AND NEW.status IN ('completed', 'failed'))
      )
      AND (
        NEW.status = 'waiting'
        OR (
          NEW.status = 'completed'
      AND tabhub_purge_finalization_active_v1(OLD.id) = 1
      AND EXISTS (
        SELECT 1 FROM privacy_purge_transaction_fences AS fence
        WHERE fence.nonce_digest
          = tabhub_purge_finalization_nonce_v1(OLD.id)
      )
      AND EXISTS (
        SELECT 1 FROM privacy_purge_results AS result
        WHERE result.command_id = OLD.id AND result.outcome = 'completed'
      )
      AND (
        (
          OLD.target_kind = 'run'
          AND OLD.lifecycle_target_count = (
            SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            LEFT JOIN privacy_subject_tombstones AS tombstone
              ON tombstone.purge_command_id = target.purge_command_id
              AND tombstone.subject_generation_id = target.subject_generation_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = OLD.id
              AND (
                tombstone.id IS NULL
                OR generation.generation_token <> target.generation_token
                OR generation.is_active <> 0
                OR generation.research_run_id IS NOT NULL
              )
          )
        )
        OR (
          OLD.target_kind = 'resource_history'
          AND (CASE WHEN OLD.lifecycle_target_count = 0 THEN 1
            ELSE OLD.lifecycle_target_count END) = (
            SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = OLD.id
              AND tombstone.history_epoch_id = OLD.history_epoch_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            LEFT JOIN privacy_subject_tombstones AS tombstone
              ON tombstone.purge_command_id = target.purge_command_id
              AND tombstone.subject_generation_id = target.subject_generation_id
              AND tombstone.history_epoch_id = OLD.history_epoch_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = OLD.id
              AND (tombstone.id IS NULL
                OR generation.generation_token <> target.generation_token
                OR generation.is_active <> 0
                OR generation.research_run_id IS NOT NULL)
          )
        )
        OR (
          OLD.target_kind = 'logical_page'
          AND EXISTS (
            SELECT 1 FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = OLD.id
              AND tombstone.subject_generation_id IS OLD.subject_generation_id
              AND tombstone.history_epoch_id IS OLD.history_epoch_id
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_authorities AS authority
        WHERE authority.command_id = OLD.id AND authority.consumed_at IS NULL
      )
      AND (
        OLD.target_kind NOT IN ('logical_page', 'resource_history', 'run')
        OR (
          OLD.target_kind = 'logical_page'
          AND EXISTS (
            SELECT 1 FROM privacy_subject_generations AS retired
            WHERE retired.id = OLD.subject_generation_id
              AND retired.subject_kind = 'logical_page'
              AND retired.is_active = 0
              AND (
                retired.logical_page_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM logical_pages AS page
                  WHERE page.id = retired.logical_page_id
                )
                OR EXISTS (
                  SELECT 1 FROM privacy_subject_generations AS successor
                  WHERE successor.subject_kind = 'logical_page'
                    AND successor.logical_page_id = retired.logical_page_id
                    AND successor.is_active = 1 AND successor.id <> retired.id
                )
              )
          )
        )
        OR (
          OLD.target_kind = 'resource_history'
          AND EXISTS (
            SELECT 1 FROM research_history_epochs AS retired
            JOIN research_history_epochs AS successor
              ON successor.resource_id = retired.resource_id
              AND successor.resource_generation_id
                = retired.resource_generation_id
              AND successor.epoch_no = retired.epoch_no + 1
              AND successor.is_active = 1
            WHERE retired.id = OLD.history_epoch_id
              AND retired.is_active = 0
          )
        )
        OR (
          OLD.target_kind = 'run'
          AND OLD.lifecycle_target_count > 0
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            JOIN privacy_subject_generations AS retired
              ON retired.id = target.subject_generation_id
            WHERE target.purge_command_id = OLD.id
              AND (
                retired.subject_kind <> 'research_run'
                OR retired.generation_token <> target.generation_token
                OR retired.is_active <> 0
                OR retired.research_run_id IS NOT NULL
              )
          )
        )
      )
    )
        OR (
          NEW.status = 'failed'
      AND tabhub_purge_finalization_active_v1(OLD.id) = 1
      AND EXISTS (
        SELECT 1 FROM privacy_purge_transaction_fences AS fence
        WHERE fence.nonce_digest
          = tabhub_purge_finalization_nonce_v1(OLD.id)
      )
      AND EXISTS (
        SELECT 1 FROM privacy_purge_results AS result
        WHERE result.command_id = OLD.id AND result.outcome = 'failed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_subject_tombstones AS tombstone
        WHERE tombstone.purge_command_id = OLD.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_authorities AS authority
        WHERE authority.command_id = OLD.id
      )
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy purge command transition');
END;

CREATE TRIGGER privacy_purge_authorities_insert_guard
BEFORE INSERT ON privacy_purge_authorities
WHEN tabhub_pk_v1_canonical(NEW.pk_v1) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM privacy_purge_deletion_manifest AS manifest
    WHERE manifest.table_name = NEW.table_name
  )
  OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_commands AS command
  WHERE command.id = NEW.command_id AND command.status IN ('pending', 'waiting')
    AND NOT EXISTS (
      SELECT 1 FROM privacy_purge_results AS result
      WHERE result.command_id = command.id
    )
    AND tabhub_purge_finalization_active_v1(command.id) = 1
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest
        = tabhub_purge_finalization_nonce_v1(command.id)
    )
    AND (
      (
        command.target_kind = 'run'
        AND command.lifecycle_target_count = (
          SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
          WHERE tombstone.purge_command_id = command.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM privacy_purge_lifecycle_targets AS target
          LEFT JOIN privacy_subject_tombstones AS tombstone
            ON tombstone.purge_command_id = target.purge_command_id
            AND tombstone.subject_generation_id = target.subject_generation_id
          JOIN privacy_subject_generations AS generation
            ON generation.id = target.subject_generation_id
          WHERE target.purge_command_id = command.id
            AND (
              tombstone.id IS NULL
              OR generation.generation_token <> target.generation_token
              OR generation.is_active <> 0
              OR generation.research_run_id IS NOT NULL
            )
        )
      )
      OR (
        command.target_kind = 'resource_history'
        AND (CASE WHEN command.lifecycle_target_count = 0 THEN 1
          ELSE command.lifecycle_target_count END) = (
          SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
          WHERE tombstone.purge_command_id = command.id
            AND tombstone.history_epoch_id = command.history_epoch_id
        )
        AND (
          (command.lifecycle_target_count = 0 AND EXISTS (
            SELECT 1 FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = command.id
              AND tombstone.subject_generation_id IS NULL
              AND tombstone.history_epoch_id = command.history_epoch_id
          ))
          OR (command.lifecycle_target_count > 0 AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            LEFT JOIN privacy_subject_tombstones AS tombstone
              ON tombstone.purge_command_id = target.purge_command_id
              AND tombstone.subject_generation_id = target.subject_generation_id
              AND tombstone.history_epoch_id = command.history_epoch_id
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = command.id
              AND (tombstone.id IS NULL
                OR generation.generation_token <> target.generation_token
                OR generation.is_active <> 0
                OR generation.research_run_id IS NOT NULL)
          ))
        )
      )
      OR (
        command.target_kind = 'logical_page'
        AND EXISTS (
          SELECT 1 FROM privacy_subject_tombstones AS tombstone
          WHERE tombstone.purge_command_id = command.id
            AND tombstone.subject_generation_id IS command.subject_generation_id
            AND tombstone.history_epoch_id IS command.history_epoch_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid or completed privacy purge authority');
END;

CREATE TRIGGER privacy_subject_tombstones_insert_guard
BEFORE INSERT ON privacy_subject_tombstones
WHEN tabhub_purge_finalization_active_v1(NEW.purge_command_id) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM privacy_purge_transaction_fences AS fence
    WHERE fence.nonce_digest
      = tabhub_purge_finalization_nonce_v1(NEW.purge_command_id)
  )
  OR NOT EXISTS (
  SELECT 1 FROM privacy_purge_commands AS command
  WHERE command.id = NEW.purge_command_id
    AND command.status IN ('pending', 'waiting')
    AND (
      (
        command.target_kind = 'run'
        AND NEW.history_epoch_id IS NULL
        AND EXISTS (
          SELECT 1 FROM privacy_purge_lifecycle_targets AS target
          JOIN privacy_subject_generations AS generation
            ON generation.id = target.subject_generation_id
          WHERE target.purge_command_id = command.id
            AND target.subject_generation_id = NEW.subject_generation_id
            AND generation.subject_kind = 'research_run'
            AND generation.generation_token = target.generation_token
            AND generation.research_run_id = target.research_run_id
            AND generation.is_active = 1
        )
      )
      OR (
        command.target_kind = 'resource_history'
        AND command.history_epoch_id IS NEW.history_epoch_id
        AND (
          (command.lifecycle_target_count = 0
            AND NEW.subject_generation_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM privacy_purge_lifecycle_targets AS target
            JOIN privacy_subject_generations AS generation
              ON generation.id = target.subject_generation_id
            WHERE target.purge_command_id = command.id
              AND target.subject_generation_id = NEW.subject_generation_id
              AND generation.subject_kind = 'research_run'
              AND generation.generation_token = target.generation_token
              AND generation.research_run_id = target.research_run_id
              AND generation.is_active = 1
          )
        )
      )
      OR (
        command.target_kind = 'logical_page'
        AND command.subject_generation_id IS NEW.subject_generation_id
        AND command.history_epoch_id IS NEW.history_epoch_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'privacy tombstone does not match its purge command');
END;

CREATE TABLE privacy_purge_deletion_manifest (
  trigger_name TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  pk_columns_json TEXT NOT NULL CHECK (
    json_valid(pk_columns_json) AND json_type(pk_columns_json) = 'array'
  ),
  pk_expression_sql TEXT NOT NULL,
  predicate_sql TEXT NOT NULL,
  trigger_sql_digest TEXT NOT NULL CHECK (
    length(trigger_sql_digest) = 64
      AND trigger_sql_digest NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE TABLE privacy_purge_target_catalog (
  table_name TEXT PRIMARY KEY CHECK (
    length(CAST(table_name AS BLOB)) BETWEEN 1 AND 128
      AND table_name NOT GLOB '*[^A-Za-z0-9_]*'
      AND substr(table_name, 1, 1) NOT GLOB '[0-9]'
  ),
  pk_columns_json TEXT NOT NULL CHECK (
    json_valid(pk_columns_json) AND json_type(pk_columns_json) = 'array'
      AND json_array_length(pk_columns_json) BETWEEN 1 AND 16
  ),
  pk_expression_sql TEXT NOT NULL CHECK (
    length(CAST(pk_expression_sql AS BLOB)) BETWEEN 10 AND 4096
  ),
  delete_rank INTEGER NOT NULL CHECK (delete_rank BETWEEN 0 AND 255),
  requires_authority INTEGER NOT NULL CHECK (requires_authority IN (0, 1)),
  guard_trigger_name TEXT UNIQUE
    REFERENCES privacy_purge_deletion_manifest(trigger_name) ON DELETE RESTRICT,
  CHECK (
    (requires_authority = 1 AND guard_trigger_name IS NOT NULL)
    OR (requires_authority = 0 AND guard_trigger_name IS NULL)
  )
) STRICT;

CREATE TRIGGER privacy_subject_generations_after_logical_page_insert
AFTER INSERT ON logical_pages
BEGIN
  INSERT INTO privacy_subject_generations (
    subject_kind, logical_page_id, generation_token, is_active, created_at
  ) VALUES (
    'logical_page', NEW.id, lower(hex(randomblob(32))), 1, NEW.created_at
  );
END;

CREATE TRIGGER privacy_subject_generations_after_logical_page_delete
AFTER DELETE ON logical_pages
BEGIN
  UPDATE privacy_subject_generations
  SET logical_page_id = NULL,
    is_active = 0,
    retired_at = CASE WHEN is_active = 1
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE retired_at END
  WHERE subject_kind = 'logical_page' AND logical_page_id = OLD.id;
END;

CREATE TRIGGER privacy_subject_generations_after_resource_insert
AFTER INSERT ON resources
BEGIN
  INSERT INTO privacy_subject_generations (
    subject_kind, resource_id, generation_token, is_active, created_at
  ) VALUES (
    'resource', NEW.id, lower(hex(randomblob(32))), 1, NEW.created_at
  );
  INSERT INTO research_history_epochs (
    resource_id, resource_generation_id, epoch_no, is_active, created_at
  ) SELECT NEW.id, id, 1, 1, NEW.created_at
    FROM privacy_subject_generations
    WHERE subject_kind = 'resource' AND resource_id = NEW.id AND is_active = 1;
END;

CREATE TRIGGER privacy_subject_generations_after_research_run_insert
AFTER INSERT ON research_runs
BEGIN
  INSERT INTO privacy_subject_generations (
    subject_kind, research_run_id, generation_token, is_active, created_at
  ) VALUES (
    'research_run', NEW.id, lower(hex(randomblob(32))), 1, NEW.created_at
  );
END;

CREATE TRIGGER privacy_subject_generations_validate_update
BEFORE UPDATE ON privacy_subject_generations
WHEN NOT (
  (OLD.is_active = 1 AND NEW.is_active = 0
    AND NEW.retired_at IS NOT NULL
    AND NEW.id IS OLD.id AND NEW.subject_kind IS OLD.subject_kind
    AND NEW.logical_page_id IS OLD.logical_page_id
    AND NEW.resource_id IS OLD.resource_id
    AND (
      NEW.research_run_id IS OLD.research_run_id
      OR (
        OLD.subject_kind = 'research_run'
        AND OLD.research_run_id IS NOT NULL
        AND NEW.research_run_id IS NULL
      )
    )
    AND NEW.generation_token IS OLD.generation_token
    AND NEW.created_at IS OLD.created_at
    AND EXISTS (
      SELECT 1 FROM privacy_subject_tombstones AS tombstone
      JOIN privacy_purge_commands AS command
        ON command.id = tombstone.purge_command_id
      WHERE tombstone.subject_generation_id = OLD.id
        AND command.status IN ('pending', 'waiting')
        AND (
          command.subject_generation_id = OLD.id
          OR (
            command.target_kind IN ('run', 'resource_history')
            AND EXISTS (
              SELECT 1 FROM privacy_purge_lifecycle_targets AS target
              WHERE target.purge_command_id = command.id
                AND target.subject_generation_id = OLD.id
                AND target.generation_token = OLD.generation_token
                AND target.research_run_id = OLD.research_run_id
            )
          )
        )
    ))
  OR (OLD.subject_kind = 'logical_page'
    AND OLD.logical_page_id IS NOT NULL
    AND NEW.logical_page_id IS NULL
    AND OLD.is_active = 1 AND NEW.is_active = 0
    AND NEW.retired_at IS NOT NULL
    AND NEW.id IS OLD.id AND NEW.subject_kind IS OLD.subject_kind
    AND NEW.resource_id IS OLD.resource_id
    AND NEW.research_run_id IS OLD.research_run_id
    AND NEW.generation_token IS OLD.generation_token
    AND NEW.created_at IS OLD.created_at
    AND NOT EXISTS (
      SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
    ))
  OR (OLD.is_active = 0 AND NEW.is_active = 0
    AND NEW.retired_at IS OLD.retired_at
    AND NEW.id IS OLD.id AND NEW.subject_kind IS OLD.subject_kind
    AND NEW.generation_token IS OLD.generation_token
    AND NEW.created_at IS OLD.created_at
    AND (
      (OLD.subject_kind = 'logical_page' AND OLD.logical_page_id IS NOT NULL
        AND NEW.logical_page_id IS NULL
        AND NEW.resource_id IS OLD.resource_id
        AND NEW.research_run_id IS OLD.research_run_id)
      OR (OLD.subject_kind = 'resource' AND OLD.resource_id IS NOT NULL
        AND NEW.resource_id IS NULL
        AND NEW.logical_page_id IS OLD.logical_page_id
        AND NEW.research_run_id IS OLD.research_run_id)
      OR (OLD.subject_kind = 'research_run' AND OLD.research_run_id IS NOT NULL
        AND NEW.research_run_id IS NULL
        AND NEW.logical_page_id IS OLD.logical_page_id
        AND NEW.resource_id IS OLD.resource_id)
    )
    AND (
      (OLD.subject_kind = 'logical_page' AND NOT EXISTS (
        SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
      ))
      OR (OLD.subject_kind = 'resource' AND NOT EXISTS (
        SELECT 1 FROM resources WHERE id = OLD.resource_id
      ))
      OR (OLD.subject_kind = 'research_run' AND NOT EXISTS (
        SELECT 1 FROM research_runs WHERE id = OLD.research_run_id
      ))
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'privacy subject generation is immutable');
END;

CREATE TRIGGER privacy_subject_generations_immutable_delete
BEFORE DELETE ON privacy_subject_generations
BEGIN
  SELECT RAISE(ABORT, 'privacy subject generations are immutable');
END;

CREATE TRIGGER research_history_epochs_validate_update
BEFORE UPDATE ON research_history_epochs
WHEN NOT (
  OLD.is_active = 1 AND NEW.is_active = 0
  AND NEW.retired_at IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.resource_id IS OLD.resource_id
  AND NEW.resource_generation_id IS OLD.resource_generation_id
  AND NEW.epoch_no IS OLD.epoch_no AND NEW.created_at IS OLD.created_at
  AND EXISTS (
    SELECT 1 FROM privacy_subject_tombstones AS tombstone
    JOIN privacy_purge_commands AS command
      ON command.id = tombstone.purge_command_id
    WHERE tombstone.history_epoch_id = OLD.id
      AND command.history_epoch_id = OLD.id
      AND command.status IN ('pending', 'waiting')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research history epoch is immutable');
END;

CREATE TRIGGER research_history_epochs_immutable_delete
BEFORE DELETE ON research_history_epochs
BEGIN
  SELECT RAISE(ABORT, 'research history epochs are immutable');
END;


-- Frozen schema-24 plus G9 subject-purge deletion closure.
DROP TRIGGER priority_assessments_privacy_delete_only;
CREATE TRIGGER priority_assessments_privacy_delete_only
BEFORE DELETE ON priority_assessments
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'priority_assessments'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'priority_assessments', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'priority assessment delete requires subject privacy deletion');
END;

DROP TRIGGER priority_exclusions_privacy_delete_only;
CREATE TRIGGER priority_exclusions_privacy_delete_only
BEFORE DELETE ON priority_exclusions
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'priority_exclusions'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'priority_exclusions', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'priority exclusion delete requires subject privacy deletion');
END;

DROP TRIGGER priority_feedback_privacy_delete_only;
CREATE TRIGGER priority_feedback_privacy_delete_only
BEFORE DELETE ON priority_feedback
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'priority_feedback'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'priority_feedback', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'priority feedback delete requires subject privacy deletion');
END;

DROP TRIGGER resource_assignment_heads_delete_guard;
CREATE TRIGGER resource_assignment_heads_delete_guard
BEFORE DELETE ON logical_page_resource_heads
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'logical_page_resource_heads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'logical_page_resource_heads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment head cannot be deleted');
END;

DROP TRIGGER resource_assignments_delete_immutable;
CREATE TRIGGER resource_assignments_delete_immutable
BEFORE DELETE ON logical_page_resource_assignments
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'logical_page_resource_assignments'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'logical_page_resource_assignments', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment history is append-only');
END;

DROP TRIGGER resource_resolution_heads_delete_guard;
CREATE TRIGGER resource_resolution_heads_delete_guard
BEFORE DELETE ON resource_resolution_heads
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'resource_resolution_heads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'resource_resolution_heads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution head cannot be deleted');
END;

DROP TRIGGER resource_resolutions_delete_immutable;
CREATE TRIGGER resource_resolutions_delete_immutable
BEFORE DELETE ON resource_resolution_events
WHEN (EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'resource_resolution_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'resource_resolution_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution history is append-only');
END;

DROP TRIGGER agent_user_importance_receipts_immutable_delete;
CREATE TRIGGER agent_user_importance_receipts_immutable_delete
BEFORE DELETE ON agent_user_importance_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'agent_user_importance_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || ':' || CAST(OLD.idempotency_key_hash AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'agent_user_importance_receipts', 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || ':' || CAST(OLD.idempotency_key_hash AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'agent user importance receipts are append-only');
END;

DROP TRIGGER ai_job_events_immutable_delete;
CREATE TRIGGER ai_job_events_immutable_delete
BEFORE DELETE ON ai_job_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'ai_job_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'ai_job_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'ai job events are append-only');
END;

DROP TRIGGER ai_job_attempts_immutable_delete;
CREATE TRIGGER ai_job_attempts_immutable_delete
BEFORE DELETE ON ai_job_attempts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'ai_job_attempts'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'ai_job_attempts', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'ai job attempts are immutable');
END;

DROP TRIGGER ai_job_idempotency_receipts_immutable_delete;
CREATE TRIGGER ai_job_idempotency_receipts_immutable_delete
BEFORE DELETE ON ai_job_idempotency_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'ai_job_idempotency_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'ai_job_idempotency_receipts', 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'ai job idempotency receipts are append-only');
END;

DROP TRIGGER research_runs_immutable_delete;
CREATE TRIGGER research_runs_immutable_delete
BEFORE DELETE ON research_runs
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_runs'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_runs', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research runs are immutable audit');
END;

DROP TRIGGER research_run_payloads_redaction_guard;
CREATE TRIGGER research_run_payloads_redaction_guard
BEFORE DELETE ON research_run_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_runs AS run
  JOIN research_reports AS report ON report.run_id = run.id
  JOIN research_report_heads AS head ON head.report_id = report.id
  WHERE run.id = OLD.run_id AND head.state = 'redacted'
)
AND NOT EXISTS (
  SELECT 1 FROM research_privacy_run_bindings WHERE run_id = OLD.run_id
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_run_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_run_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research run payload requires report redaction');
END;

DROP TRIGGER research_selection_pages_immutable_delete;
CREATE TRIGGER research_selection_pages_immutable_delete
BEFORE DELETE ON research_run_selection_pages
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_run_selection_pages'
    AND authority.pk_v1 = 'pk:v1|2|' || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT) || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_run_selection_pages', 'pk:v1|2|' || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT) || 'i:' || length(CAST(OLD.logical_page_id AS TEXT)) || ':' || CAST(OLD.logical_page_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research selection is immutable');
END;

DROP TRIGGER research_run_events_immutable_delete;
CREATE TRIGGER research_run_events_immutable_delete
BEFORE DELETE ON research_run_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_run_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_run_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research run events are append-only');
END;

DROP TRIGGER research_sources_immutable_delete;
CREATE TRIGGER research_sources_immutable_delete
BEFORE DELETE ON research_sources
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_sources'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_sources', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research source manifest is immutable');
END;

DROP TRIGGER research_source_state_events_immutable_delete;
CREATE TRIGGER research_source_state_events_immutable_delete
BEFORE DELETE ON research_source_state_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_source_state_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_source_state_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research source events are append-only');
END;

DROP TRIGGER research_source_payloads_redaction_guard;
CREATE TRIGGER research_source_payloads_redaction_guard
BEFORE DELETE ON research_source_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_source_heads
  WHERE source_id = OLD.source_id AND state = 'redacted'
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE evidence.source_id = OLD.source_id AND head.state = 'valid'
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_source_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.source_id AS TEXT)) || ':' || CAST(OLD.source_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_source_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.source_id AS TEXT)) || ':' || CAST(OLD.source_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research source payload requires redaction event');
END;

DROP TRIGGER research_page_context_snapshots_immutable_delete;
CREATE TRIGGER research_page_context_snapshots_immutable_delete
BEFORE DELETE ON research_page_context_snapshots
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_page_context_snapshots'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_page_context_snapshots', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research page context snapshot is immutable');
END;

DROP TRIGGER research_resource_context_snapshots_immutable_delete;
CREATE TRIGGER research_resource_context_snapshots_immutable_delete
BEFORE DELETE ON research_resource_context_snapshots
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_resource_context_snapshots'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_resource_context_snapshots', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research resource context snapshot is immutable');
END;

DROP TRIGGER research_activity_snapshots_immutable_delete;
CREATE TRIGGER research_activity_snapshots_immutable_delete
BEFORE DELETE ON research_activity_snapshots
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_activity_snapshots'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_activity_snapshots', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research activity snapshot is immutable');
END;

DROP TRIGGER research_relation_snapshots_immutable_delete;
CREATE TRIGGER research_relation_snapshots_immutable_delete
BEFORE DELETE ON research_relation_snapshots
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_relation_snapshots'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_relation_snapshots', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research relation snapshot is immutable');
END;

DROP TRIGGER research_snapshot_payloads_redaction_guard;
CREATE TRIGGER research_snapshot_payloads_redaction_guard
BEFORE DELETE ON research_snapshot_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_snapshot_heads
  WHERE kind = OLD.kind AND snapshot_id = OLD.snapshot_id AND state = 'redacted'
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE head.state = 'valid' AND (
    (OLD.kind = 'page_context' AND evidence.page_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'resource_context' AND evidence.resource_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'activity' AND evidence.activity_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = 'relation' AND evidence.relation_snapshot_id = OLD.snapshot_id)
  )
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_snapshot_payloads'
    AND authority.pk_v1 = 'pk:v1|2|' || 's:' || length(CAST(OLD.kind AS BLOB)) || ':' || CAST(OLD.kind AS TEXT) || 'i:' || length(CAST(OLD.snapshot_id AS TEXT)) || ':' || CAST(OLD.snapshot_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_snapshot_payloads', 'pk:v1|2|' || 's:' || length(CAST(OLD.kind AS BLOB)) || ':' || CAST(OLD.kind AS TEXT) || 'i:' || length(CAST(OLD.snapshot_id AS TEXT)) || ':' || CAST(OLD.snapshot_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research snapshot payload requires redaction event');
END;

DROP TRIGGER research_snapshot_state_events_immutable_delete;
CREATE TRIGGER research_snapshot_state_events_immutable_delete
BEFORE DELETE ON research_snapshot_state_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_snapshot_state_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_snapshot_state_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research snapshot events are append-only');
END;

DROP TRIGGER research_reports_immutable_delete;
CREATE TRIGGER research_reports_immutable_delete
BEFORE DELETE ON research_reports
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_reports'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_reports', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research reports are immutable audit');
END;

DROP TRIGGER research_report_sources_immutable_delete;
CREATE TRIGGER research_report_sources_immutable_delete
BEFORE DELETE ON research_report_sources
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_report_sources'
    AND authority.pk_v1 = 'pk:v1|2|' || 'i:' || length(CAST(OLD.report_id AS TEXT)) || ':' || CAST(OLD.report_id AS TEXT) || 'i:' || length(CAST(OLD.source_id AS TEXT)) || ':' || CAST(OLD.source_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_report_sources', 'pk:v1|2|' || 'i:' || length(CAST(OLD.report_id AS TEXT)) || ':' || CAST(OLD.report_id AS TEXT) || 'i:' || length(CAST(OLD.source_id AS TEXT)) || ':' || CAST(OLD.source_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research report sources are immutable');
END;

DROP TRIGGER research_claim_payloads_redaction_guard;
CREATE TRIGGER research_claim_payloads_redaction_guard
BEFORE DELETE ON research_claim_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_report_heads AS head ON head.report_id = claim.report_id
  WHERE claim.id = OLD.claim_id AND head.state = 'redacted'
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_claim_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.claim_id AS TEXT)) || ':' || CAST(OLD.claim_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_claim_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.claim_id AS TEXT)) || ':' || CAST(OLD.claim_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research claim payload requires report redaction');
END;

DROP TRIGGER research_evidence_payloads_redaction_guard;
CREATE TRIGGER research_evidence_payloads_redaction_guard
BEFORE DELETE ON research_evidence_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_evidence_heads
  WHERE evidence_id = OLD.evidence_id AND state = 'redacted'
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_evidence_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.evidence_id AS TEXT)) || ':' || CAST(OLD.evidence_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_evidence_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.evidence_id AS TEXT)) || ':' || CAST(OLD.evidence_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence payload requires redaction event');
END;

DROP TRIGGER research_target_heads_no_delete;
CREATE TRIGGER research_target_heads_no_delete
BEFORE DELETE ON research_target_heads
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_target_heads'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.target_key AS BLOB)) || ':' || CAST(OLD.target_key AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_target_heads', 'pk:v1|1|' || 's:' || length(CAST(OLD.target_key AS BLOB)) || ':' || CAST(OLD.target_key AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research target head is trigger-owned');
END;

DROP TRIGGER research_privacy_requests_immutable_delete;
CREATE TRIGGER research_privacy_requests_immutable_delete
BEFORE DELETE ON research_privacy_requests
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_privacy_requests'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_privacy_requests', 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research privacy requests are immutable');
END;

DROP TRIGGER research_privacy_run_bindings_immutable_delete;
CREATE TRIGGER research_privacy_run_bindings_immutable_delete
BEFORE DELETE ON research_privacy_run_bindings
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_privacy_run_bindings'
    AND authority.pk_v1 = 'pk:v1|2|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT) || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_privacy_run_bindings', 'pk:v1|2|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT) || 'i:' || length(CAST(OLD.run_id AS TEXT)) || ':' || CAST(OLD.run_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research privacy run bindings are immutable');
END;

DROP TRIGGER research_privacy_event_bindings_immutable_delete;
CREATE TRIGGER research_privacy_event_bindings_immutable_delete
BEFORE DELETE ON research_privacy_event_bindings
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_privacy_event_bindings'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.event_key AS BLOB)) || ':' || CAST(OLD.event_key AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_privacy_event_bindings', 'pk:v1|1|' || 's:' || length(CAST(OLD.event_key AS BLOB)) || ':' || CAST(OLD.event_key AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research privacy event bindings are immutable');
END;

DROP TRIGGER research_redaction_receipts_immutable_delete;
CREATE TRIGGER research_redaction_receipts_immutable_delete
BEFORE DELETE ON research_redaction_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_redaction_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_redaction_receipts', 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key AS BLOB)) || ':' || CAST(OLD.idempotency_key AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research redaction receipts are immutable');
END;

DROP TRIGGER research_report_payloads_redaction_guard;
CREATE TRIGGER research_report_payloads_redaction_guard
BEFORE DELETE ON research_report_payloads
WHEN (NOT EXISTS (
  SELECT 1 FROM research_report_heads
  WHERE report_id = OLD.report_id AND state = 'redacted'
)) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_report_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.report_id AS TEXT)) || ':' || CAST(OLD.report_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_report_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.report_id AS TEXT)) || ':' || CAST(OLD.report_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research report payload requires redaction event');
END;

DROP TRIGGER research_claims_immutable_delete;
CREATE TRIGGER research_claims_immutable_delete
BEFORE DELETE ON research_claims
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_claims'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_claims', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research claims are immutable audit');
END;

DROP TRIGGER research_claim_evidence_immutable_delete;
CREATE TRIGGER research_claim_evidence_immutable_delete
BEFORE DELETE ON research_claim_evidence
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_claim_evidence'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_claim_evidence', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence is immutable audit');
END;

DROP TRIGGER research_evidence_state_events_immutable_delete;
CREATE TRIGGER research_evidence_state_events_immutable_delete
BEFORE DELETE ON research_evidence_state_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_evidence_state_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_evidence_state_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence events are append-only');
END;

DROP TRIGGER research_report_state_events_immutable_delete;
CREATE TRIGGER research_report_state_events_immutable_delete
BEFORE DELETE ON research_report_state_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'research_report_state_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'research_report_state_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'research report events are append-only');
END;

DROP TRIGGER agent_research_command_receipts_immutable_delete;
CREATE TRIGGER agent_research_command_receipts_immutable_delete
BEFORE DELETE ON agent_research_command_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'agent_research_command_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || ':' || CAST(OLD.idempotency_key_hash AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'agent_research_command_receipts', 'pk:v1|1|' || 's:' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || ':' || CAST(OLD.idempotency_key_hash AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'agent research command receipts are immutable');
END;

CREATE TRIGGER live_acquisition_consents_immutable_delete
BEFORE DELETE ON live_acquisition_consents
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_consents'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_consents', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_consents delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_consent_payloads_redaction_guard
BEFORE DELETE ON live_acquisition_consent_payloads
WHEN (EXISTS (SELECT 1 FROM live_acquisition_consents WHERE id = OLD.consent_id AND status = 'active')) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_consent_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.consent_id AS TEXT)) || ':' || CAST(OLD.consent_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_consent_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.consent_id AS TEXT)) || ':' || CAST(OLD.consent_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_consent_payloads delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_digest_keys_redaction_guard
BEFORE DELETE ON live_acquisition_digest_keys
WHEN (EXISTS (SELECT 1 FROM live_acquisition_consents WHERE id = OLD.consent_id AND status = 'active')) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_digest_keys'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.consent_id AS TEXT)) || ':' || CAST(OLD.consent_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_digest_keys', 'pk:v1|1|' || 'i:' || length(CAST(OLD.consent_id AS TEXT)) || ':' || CAST(OLD.consent_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_digest_keys delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_actions_immutable_delete
BEFORE DELETE ON live_acquisition_actions
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_actions'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_actions', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_actions delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_action_authorizations_immutable_delete
BEFORE DELETE ON live_acquisition_action_authorizations
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_action_authorizations'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_action_authorizations', 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_action_authorizations delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_page_reservations_immutable_delete
BEFORE DELETE ON live_acquisition_page_reservations
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_page_reservations'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_page_reservations', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_page_reservations delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_action_events_immutable_delete
BEFORE DELETE ON live_acquisition_action_events
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_action_events'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_action_events', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_action_events delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_url_payloads_redaction_guard
BEFORE DELETE ON live_acquisition_url_payloads
WHEN (EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN ('completed','blocked','ambiguous'))) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_url_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_url_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_url_payloads delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_dns_payloads_redaction_guard
BEFORE DELETE ON live_acquisition_dns_payloads
WHEN (EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN ('completed','blocked','ambiguous'))) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_dns_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_dns_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_dns_payloads delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_body_payloads_redaction_guard
BEFORE DELETE ON live_acquisition_body_payloads
WHEN (EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN ('completed','blocked','ambiguous'))) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_body_payloads'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_body_payloads', 'pk:v1|1|' || 'i:' || length(CAST(OLD.action_id AS TEXT)) || ':' || CAST(OLD.action_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_body_payloads delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_checkpoints_immutable_delete
BEFORE DELETE ON live_acquisition_checkpoints
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_checkpoints'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.attempt_id AS TEXT)) || ':' || CAST(OLD.attempt_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_checkpoints', 'pk:v1|1|' || 'i:' || length(CAST(OLD.attempt_id AS TEXT)) || ':' || CAST(OLD.attempt_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_checkpoints delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_capture_manifests_immutable_delete
BEFORE DELETE ON live_acquisition_capture_manifests
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_capture_manifests'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_capture_manifests', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_capture_manifests delete requires exact purge authority');
END;

DROP TRIGGER live_acquisition_handoffs_immutable_delete;
CREATE TRIGGER live_acquisition_handoffs_immutable_delete
BEFORE DELETE ON live_acquisition_handoffs
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_handoffs'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_handoffs', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_handoffs delete requires exact purge authority');
END;

DROP TRIGGER live_acquisition_source_receipts_immutable_delete;
CREATE TRIGGER live_acquisition_source_receipts_immutable_delete
BEFORE DELETE ON live_acquisition_source_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_source_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_source_receipts', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_source_receipts delete requires exact purge authority');
END;

DROP TRIGGER live_acquisition_handoff_receipts_immutable_delete;
CREATE TRIGGER live_acquisition_handoff_receipts_immutable_delete
BEFORE DELETE ON live_acquisition_handoff_receipts
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_handoff_receipts'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.handoff_id AS TEXT)) || ':' || CAST(OLD.handoff_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_handoff_receipts', 'pk:v1|1|' || 'i:' || length(CAST(OLD.handoff_id AS TEXT)) || ':' || CAST(OLD.handoff_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_handoff_receipts delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_provider_reservations_immutable_delete
BEFORE DELETE ON live_acquisition_provider_reservations
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_provider_reservations'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_provider_reservations', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_provider_reservations delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_provider_reservation_adoptions_immutable_delete
BEFORE DELETE ON live_acquisition_provider_reservation_adoptions
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_provider_reservation_adoptions'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.attempt_id AS TEXT)) || ':' || CAST(OLD.attempt_id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_provider_reservation_adoptions', 'pk:v1|1|' || 'i:' || length(CAST(OLD.attempt_id AS TEXT)) || ':' || CAST(OLD.attempt_id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_provider_reservation_adoptions delete requires exact purge authority');
END;

CREATE TRIGGER live_acquisition_workflow_outcomes_immutable_delete
BEFORE DELETE ON live_acquisition_workflow_outcomes
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_workflow_outcomes'
    AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_workflow_outcomes', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live_acquisition_workflow_outcomes delete requires exact purge authority');
END;

CREATE TRIGGER privacy_purge_commands_immutable_delete
BEFORE DELETE ON privacy_purge_commands
BEGIN
  SELECT RAISE(ABORT, 'privacy purge commands are permanent');
END;

CREATE TRIGGER privacy_purge_authorities_immutable_delete
BEFORE DELETE ON privacy_purge_authorities
WHEN OLD.consumed_at IS NULL OR tabhub_purge_authority_remove_v1(
  OLD.command_id, OLD.table_name, OLD.pk_v1, OLD.nonce_digest
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'privacy purge authority removal requires exact local capability');
END;

CREATE TRIGGER privacy_subject_tombstones_immutable_delete
BEFORE DELETE ON privacy_subject_tombstones
BEGIN
  SELECT RAISE(ABORT, 'privacy subject tombstones are permanent');
END;

CREATE TRIGGER privacy_purge_results_immutable_delete
BEFORE DELETE ON privacy_purge_results
BEGIN
  SELECT RAISE(ABORT, 'privacy purge results are immutable');
END;

CREATE TRIGGER live_acquisition_origin_courtesy_state_immutable_delete
BEFORE DELETE ON live_acquisition_origin_courtesy_state
WHEN (1) AND NOT EXISTS (
  SELECT 1 FROM privacy_purge_authorities AS authority
  JOIN privacy_purge_commands AS command ON command.id = authority.command_id
  WHERE authority.table_name = 'live_acquisition_origin_courtesy_state'
    AND authority.pk_v1 = 'pk:v1|2|'
      || 'i:' || length(CAST(OLD.coordinator_run_id AS TEXT)) || ':'
        || CAST(OLD.coordinator_run_id AS TEXT)
      || 's:' || length(CAST(OLD.canonical_origin_digest AS BLOB)) || ':'
        || CAST(OLD.canonical_origin_digest AS TEXT)
    AND authority.consumed_at IS NULL
    AND command.status IN ('pending', 'waiting')
    AND EXISTS (
      SELECT 1 FROM privacy_purge_transaction_fences AS fence
      WHERE fence.nonce_digest = authority.nonce_digest
    )
    AND tabhub_purge_authorized_v1(
      'live_acquisition_origin_courtesy_state',
      'pk:v1|2|'
        || 'i:' || length(CAST(OLD.coordinator_run_id AS TEXT)) || ':'
          || CAST(OLD.coordinator_run_id AS TEXT)
        || 's:' || length(CAST(OLD.canonical_origin_digest AS BLOB)) || ':'
          || CAST(OLD.canonical_origin_digest AS TEXT),
      authority.nonce_digest
    ) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'live acquisition origin courtesy state is immutable');
END;

CREATE TRIGGER privacy_purge_deletion_manifest_immutable_delete
BEFORE DELETE ON privacy_purge_deletion_manifest
BEGIN
  SELECT RAISE(ABORT, 'privacy purge deletion manifest is frozen');
END;

INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'agent_user_importance_receipts_immutable_delete', 'agent_user_importance_receipts', '["idempotency_key_hash"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || '':'' || CAST(OLD.idempotency_key_hash AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'ai_job_events_immutable_delete', 'ai_job_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'ai_job_attempts_immutable_delete', 'ai_job_attempts', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'ai_job_idempotency_receipts_immutable_delete', 'ai_job_idempotency_receipts', '["idempotency_key"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.idempotency_key AS BLOB)) || '':'' || CAST(OLD.idempotency_key AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_runs_immutable_delete', 'research_runs', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_run_payloads_redaction_guard', 'research_run_payloads', '["run_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.run_id AS TEXT)) || '':'' || CAST(OLD.run_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_runs AS run
  JOIN research_reports AS report ON report.run_id = run.id
  JOIN research_report_heads AS head ON head.report_id = report.id
  WHERE run.id = OLD.run_id AND head.state = ''redacted''
)
AND NOT EXISTS (
  SELECT 1 FROM research_privacy_run_bindings WHERE run_id = OLD.run_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_selection_pages_immutable_delete', 'research_run_selection_pages', '["run_id","logical_page_id"]',
  '''pk:v1|2|'' || ''i:'' || length(CAST(OLD.run_id AS TEXT)) || '':'' || CAST(OLD.run_id AS TEXT) || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_run_events_immutable_delete', 'research_run_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_sources_immutable_delete', 'research_sources', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_source_state_events_immutable_delete', 'research_source_state_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_source_payloads_redaction_guard', 'research_source_payloads', '["source_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.source_id AS TEXT)) || '':'' || CAST(OLD.source_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_source_heads
  WHERE source_id = OLD.source_id AND state = ''redacted''
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE evidence.source_id = OLD.source_id AND head.state = ''valid''
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_page_context_snapshots_immutable_delete', 'research_page_context_snapshots', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_resource_context_snapshots_immutable_delete', 'research_resource_context_snapshots', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_activity_snapshots_immutable_delete', 'research_activity_snapshots', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_relation_snapshots_immutable_delete', 'research_relation_snapshots', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_snapshot_payloads_redaction_guard', 'research_snapshot_payloads', '["kind","snapshot_id"]',
  '''pk:v1|2|'' || ''s:'' || length(CAST(OLD.kind AS BLOB)) || '':'' || CAST(OLD.kind AS TEXT) || ''i:'' || length(CAST(OLD.snapshot_id AS TEXT)) || '':'' || CAST(OLD.snapshot_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_snapshot_heads
  WHERE kind = OLD.kind AND snapshot_id = OLD.snapshot_id AND state = ''redacted''
) OR EXISTS (
  SELECT 1 FROM research_claim_evidence AS evidence
  JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
  WHERE head.state = ''valid'' AND (
    (OLD.kind = ''page_context'' AND evidence.page_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = ''resource_context'' AND evidence.resource_context_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = ''activity'' AND evidence.activity_snapshot_id = OLD.snapshot_id)
    OR (OLD.kind = ''relation'' AND evidence.relation_snapshot_id = OLD.snapshot_id)
  )
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_snapshot_state_events_immutable_delete', 'research_snapshot_state_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_reports_immutable_delete', 'research_reports', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_report_sources_immutable_delete', 'research_report_sources', '["report_id","source_id"]',
  '''pk:v1|2|'' || ''i:'' || length(CAST(OLD.report_id AS TEXT)) || '':'' || CAST(OLD.report_id AS TEXT) || ''i:'' || length(CAST(OLD.source_id AS TEXT)) || '':'' || CAST(OLD.source_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_claim_payloads_redaction_guard', 'research_claim_payloads', '["claim_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.claim_id AS TEXT)) || '':'' || CAST(OLD.claim_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_claims AS claim
  JOIN research_report_heads AS head ON head.report_id = claim.report_id
  WHERE claim.id = OLD.claim_id AND head.state = ''redacted''
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_evidence_payloads_redaction_guard', 'research_evidence_payloads', '["evidence_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.evidence_id AS TEXT)) || '':'' || CAST(OLD.evidence_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_evidence_heads
  WHERE evidence_id = OLD.evidence_id AND state = ''redacted''
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_target_heads_no_delete', 'research_target_heads', '["target_key"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.target_key AS BLOB)) || '':'' || CAST(OLD.target_key AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_privacy_requests_immutable_delete', 'research_privacy_requests', '["idempotency_key"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.idempotency_key AS BLOB)) || '':'' || CAST(OLD.idempotency_key AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_privacy_run_bindings_immutable_delete', 'research_privacy_run_bindings', '["idempotency_key","run_id"]',
  '''pk:v1|2|'' || ''s:'' || length(CAST(OLD.idempotency_key AS BLOB)) || '':'' || CAST(OLD.idempotency_key AS TEXT) || ''i:'' || length(CAST(OLD.run_id AS TEXT)) || '':'' || CAST(OLD.run_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_privacy_event_bindings_immutable_delete', 'research_privacy_event_bindings', '["event_key"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.event_key AS BLOB)) || '':'' || CAST(OLD.event_key AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_redaction_receipts_immutable_delete', 'research_redaction_receipts', '["idempotency_key"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.idempotency_key AS BLOB)) || '':'' || CAST(OLD.idempotency_key AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_report_payloads_redaction_guard', 'research_report_payloads', '["report_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.report_id AS TEXT)) || '':'' || CAST(OLD.report_id AS TEXT)', 'NOT EXISTS (
  SELECT 1 FROM research_report_heads
  WHERE report_id = OLD.report_id AND state = ''redacted''
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_claims_immutable_delete', 'research_claims', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_claim_evidence_immutable_delete', 'research_claim_evidence', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_evidence_state_events_immutable_delete', 'research_evidence_state_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'research_report_state_events_immutable_delete', 'research_report_state_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'agent_research_command_receipts_immutable_delete', 'agent_research_command_receipts', '["idempotency_key_hash"]',
  '''pk:v1|1|'' || ''s:'' || length(CAST(OLD.idempotency_key_hash AS BLOB)) || '':'' || CAST(OLD.idempotency_key_hash AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_consents_immutable_delete', 'live_acquisition_consents', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_consent_payloads_redaction_guard', 'live_acquisition_consent_payloads', '["consent_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.consent_id AS TEXT)) || '':'' || CAST(OLD.consent_id AS TEXT)', 'EXISTS (SELECT 1 FROM live_acquisition_consents WHERE id = OLD.consent_id AND status = ''active'')', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_digest_keys_redaction_guard', 'live_acquisition_digest_keys', '["consent_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.consent_id AS TEXT)) || '':'' || CAST(OLD.consent_id AS TEXT)', 'EXISTS (SELECT 1 FROM live_acquisition_consents WHERE id = OLD.consent_id AND status = ''active'')', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_actions_immutable_delete', 'live_acquisition_actions', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_page_reservations_immutable_delete', 'live_acquisition_page_reservations', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_action_authorizations_immutable_delete', 'live_acquisition_action_authorizations', '["action_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.action_id AS TEXT)) || '':'' || CAST(OLD.action_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_action_events_immutable_delete', 'live_acquisition_action_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_url_payloads_redaction_guard', 'live_acquisition_url_payloads', '["action_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.action_id AS TEXT)) || '':'' || CAST(OLD.action_id AS TEXT)', 'EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN (''completed'',''blocked'',''ambiguous''))', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_dns_payloads_redaction_guard', 'live_acquisition_dns_payloads', '["action_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.action_id AS TEXT)) || '':'' || CAST(OLD.action_id AS TEXT)', 'EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN (''completed'',''blocked'',''ambiguous''))', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_body_payloads_redaction_guard', 'live_acquisition_body_payloads', '["action_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.action_id AS TEXT)) || '':'' || CAST(OLD.action_id AS TEXT)', 'EXISTS (SELECT 1 FROM live_acquisition_actions WHERE id = OLD.action_id AND state NOT IN (''completed'',''blocked'',''ambiguous''))', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_checkpoints_immutable_delete', 'live_acquisition_checkpoints', '["attempt_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.attempt_id AS TEXT)) || '':'' || CAST(OLD.attempt_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_capture_manifests_immutable_delete', 'live_acquisition_capture_manifests', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_handoffs_immutable_delete', 'live_acquisition_handoffs', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_source_receipts_immutable_delete', 'live_acquisition_source_receipts', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_handoff_receipts_immutable_delete', 'live_acquisition_handoff_receipts', '["handoff_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.handoff_id AS TEXT)) || '':'' || CAST(OLD.handoff_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_provider_reservations_immutable_delete', 'live_acquisition_provider_reservations', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_provider_reservation_adoptions_immutable_delete', 'live_acquisition_provider_reservation_adoptions', '["attempt_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.attempt_id AS TEXT)) || '':'' || CAST(OLD.attempt_id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_workflow_outcomes_immutable_delete', 'live_acquisition_workflow_outcomes', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'live_acquisition_origin_courtesy_state_immutable_delete', 'live_acquisition_origin_courtesy_state', '["coordinator_run_id","canonical_origin_digest"]',
  '''pk:v1|2|'' || ''i:'' || length(CAST(OLD.coordinator_run_id AS TEXT)) || '':'' || CAST(OLD.coordinator_run_id AS TEXT) || ''s:'' || length(CAST(OLD.canonical_origin_digest AS BLOB)) || '':'' || CAST(OLD.canonical_origin_digest AS TEXT)', '1', '0000000000000000000000000000000000000000000000000000000000000000'
);

INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'priority_assessments_privacy_delete_only', 'priority_assessments', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'priority_exclusions_privacy_delete_only', 'priority_exclusions', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'priority_feedback_privacy_delete_only', 'priority_feedback', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'resource_assignment_heads_delete_guard', 'logical_page_resource_heads', '["logical_page_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'resource_assignments_delete_immutable', 'logical_page_resource_assignments', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'resource_resolution_heads_delete_guard', 'resource_resolution_heads', '["logical_page_id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);
INSERT INTO privacy_purge_deletion_manifest (
  trigger_name, table_name, pk_columns_json, pk_expression_sql,
  predicate_sql, trigger_sql_digest
) VALUES (
  'resource_resolutions_delete_immutable', 'resource_resolution_events', '["id"]',
  '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 'EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)', '0000000000000000000000000000000000000000000000000000000000000000'
);

INSERT INTO privacy_purge_target_catalog (
  table_name, pk_columns_json, pk_expression_sql, delete_rank,
  requires_authority, guard_trigger_name
)
SELECT
  table_name,
  pk_columns_json,
  pk_expression_sql,
  CASE table_name
    WHEN 'agent_research_command_receipts' THEN 1
    WHEN 'agent_user_importance_receipts' THEN 0
    WHEN 'ai_job_attempts' THEN 1
    WHEN 'ai_job_events' THEN 2
    WHEN 'ai_job_idempotency_receipts' THEN 1
    WHEN 'live_acquisition_action_authorizations' THEN 3
    WHEN 'live_acquisition_action_events' THEN 3
    WHEN 'live_acquisition_actions' THEN 2
    WHEN 'live_acquisition_body_payloads' THEN 3
    WHEN 'live_acquisition_capture_manifests' THEN 4
    WHEN 'live_acquisition_checkpoints' THEN 2
    WHEN 'live_acquisition_consent_payloads' THEN 2
    WHEN 'live_acquisition_consents' THEN 1
    WHEN 'live_acquisition_digest_keys' THEN 2
    WHEN 'live_acquisition_dns_payloads' THEN 3
    WHEN 'live_acquisition_handoff_receipts' THEN 3
    WHEN 'live_acquisition_handoffs' THEN 2
    WHEN 'live_acquisition_origin_courtesy_state' THEN 2
    WHEN 'live_acquisition_page_reservations' THEN 3
    WHEN 'live_acquisition_provider_reservation_adoptions' THEN 4
    WHEN 'live_acquisition_provider_reservations' THEN 3
    WHEN 'live_acquisition_source_receipts' THEN 5
    WHEN 'live_acquisition_url_payloads' THEN 3
    WHEN 'live_acquisition_workflow_outcomes' THEN 1
    WHEN 'logical_page_resource_assignments' THEN 0
    WHEN 'logical_page_resource_heads' THEN 1
    WHEN 'priority_assessments' THEN 0
    WHEN 'priority_exclusions' THEN 0
    WHEN 'priority_feedback' THEN 1
    WHEN 'research_activity_snapshots' THEN 2
    WHEN 'research_claim_evidence' THEN 7
    WHEN 'research_claim_payloads' THEN 3
    WHEN 'research_claims' THEN 2
    WHEN 'research_evidence_payloads' THEN 8
    WHEN 'research_evidence_state_events' THEN 8
    WHEN 'research_page_context_snapshots' THEN 2
    WHEN 'research_privacy_event_bindings' THEN 1
    WHEN 'research_privacy_requests' THEN 0
    WHEN 'research_privacy_run_bindings' THEN 2
    WHEN 'research_redaction_receipts' THEN 1
    WHEN 'research_relation_snapshots' THEN 2
    WHEN 'research_report_payloads' THEN 2
    WHEN 'research_report_sources' THEN 7
    WHEN 'research_report_state_events' THEN 2
    WHEN 'research_reports' THEN 1
    WHEN 'research_resource_context_snapshots' THEN 2
    WHEN 'research_run_events' THEN 2
    WHEN 'research_run_payloads' THEN 2
    WHEN 'research_run_selection_pages' THEN 2
    WHEN 'research_runs' THEN 1
    WHEN 'research_snapshot_payloads' THEN 0
    WHEN 'research_snapshot_state_events' THEN 0
    WHEN 'research_source_payloads' THEN 7
    WHEN 'research_source_state_events' THEN 7
    WHEN 'research_sources' THEN 6
    WHEN 'research_target_heads' THEN 3
    WHEN 'resource_resolution_events' THEN 1
    WHEN 'resource_resolution_heads' THEN 2
    ELSE -1
  END,
  1,
  trigger_name
FROM privacy_purge_deletion_manifest;

INSERT INTO privacy_purge_target_catalog (
  table_name, pk_columns_json, pk_expression_sql, delete_rank,
  requires_authority, guard_trigger_name
) VALUES
  ('ai_jobs', '["id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 0, 0, NULL),
  ('context_entries', '["id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 0, 0, NULL),
  ('context_entry_reviews', '["id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 1, 0, NULL),
  ('logical_page_activity_daily', '["logical_page_id","activity_date"]',
    '''pk:v1|2|'' || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT) || ''s:'' || length(CAST(OLD.activity_date AS BLOB)) || '':'' || CAST(OLD.activity_date AS TEXT)', 0, 0, NULL),
  ('logical_page_importance_migration_audit', '["logical_page_id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT)', 0, 0, NULL),
  ('logical_page_preferences', '["logical_page_id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.logical_page_id AS TEXT)) || '':'' || CAST(OLD.logical_page_id AS TEXT)', 0, 0, NULL),
  ('tab_session_intents', '["id"]',
    '''pk:v1|1|'' || ''i:'' || length(CAST(OLD.id AS TEXT)) || '':'' || CAST(OLD.id AS TEXT)', 1, 0, NULL);
