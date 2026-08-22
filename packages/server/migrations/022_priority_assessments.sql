CREATE TABLE priority_rulesets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (
    length(trim(name)) BETWEEN 1 AND 200
  ),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  updated_at TEXT NOT NULL CHECK (COALESCE(
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
    AND updated_at >= created_at
  , 0))
);

CREATE TABLE priority_rule_versions (
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  )
    REFERENCES priority_rulesets(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version > 0),
  rule_ast_json TEXT NOT NULL CHECK (
    length(CAST(rule_ast_json AS BLOB)) BETWEEN 1 AND 65536
    AND CASE
      WHEN json_valid(rule_ast_json)
      THEN (
        COALESCE(json_type(rule_ast_json) = 'object', 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.schemaVersion') IN ('integer', 'real'), 0
        )
        AND COALESCE(json_extract(rule_ast_json, '$.schemaVersion') = 1, 0)
        AND COALESCE(json_type(rule_ast_json, '$.policy') = 'object', 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.baseScore') IN ('integer', 'real'), 0
        )
        AND COALESCE(json_extract(rule_ast_json, '$.policy.baseScore') = 40, 0)
        AND COALESCE(json_type(rule_ast_json, '$.policy.baseConfidence') = 'real', 0)
        AND COALESCE(json_extract(rule_ast_json, '$.policy.baseConfidence') = 0.65, 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.lowConfidenceThreshold') = 'real', 0
        )
        AND COALESCE(
          json_extract(rule_ast_json, '$.policy.lowConfidenceThreshold') = 0.60, 0
        )
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.missingCapturedContentPenalty') = 'real', 0
        )
        AND COALESCE(
          json_extract(rule_ast_json, '$.policy.missingCapturedContentPenalty') = 0.20, 0
        )
        AND COALESCE(json_type(rule_ast_json, '$.policy.bands') = 'object', 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.bands.mediumMin') IN ('integer', 'real'), 0
        )
        AND COALESCE(json_extract(rule_ast_json, '$.policy.bands.mediumMin') = 25, 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.bands.highMin') IN ('integer', 'real'), 0
        )
        AND COALESCE(json_extract(rule_ast_json, '$.policy.bands.highMin') = 60, 0)
        AND COALESCE(
          json_type(rule_ast_json, '$.policy.bands.criticalMin') IN ('integer', 'real'), 0
        )
        AND COALESCE(json_extract(rule_ast_json, '$.policy.bands.criticalMin') = 85, 0)
        AND COALESCE(json_type(rule_ast_json, '$.rules') = 'array', 0)
        AND COALESCE(json_array_length(rule_ast_json, '$.rules') <= 100, 0)
      )
      ELSE 0
    END
  ),
  natural_language_source TEXT CHECK (
    natural_language_source IS NULL
    OR length(CAST(natural_language_source AS BLOB)) BETWEEN 1 AND 8192
  ),
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  PRIMARY KEY (ruleset_id, version)
);

CREATE TABLE priority_ruleset_activations (
  scope TEXT PRIMARY KEY NOT NULL CHECK (COALESCE(scope = 'global', 0)),
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  ),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version > 0),
  activated_at TEXT NOT NULL CHECK (COALESCE(
    activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', activated_at), 0
  )),
  FOREIGN KEY (ruleset_id, version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT
);

CREATE TABLE priority_assessments (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL CHECK (
    typeof(logical_page_id) = 'integer' AND logical_page_id > 0
  )
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  agent_score INTEGER NOT NULL CHECK (
    typeof(agent_score) = 'integer' AND agent_score BETWEEN 0 AND 100
  ),
  agent_band TEXT NOT NULL CHECK (
    agent_band IN ('low', 'medium', 'high', 'critical')
    AND (
      (agent_score BETWEEN 0 AND 24 AND agent_band = 'low')
      OR (agent_score BETWEEN 25 AND 59 AND agent_band = 'medium')
      OR (agent_score BETWEEN 60 AND 84 AND agent_band = 'high')
      OR (agent_score BETWEEN 85 AND 100 AND agent_band = 'critical')
    )
  ),
  confidence REAL NOT NULL CHECK (
    typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0 AND 1
  ),
  needs_review INTEGER NOT NULL CHECK (
    typeof(needs_review) = 'integer'
    AND needs_review IN (0, 1)
    AND (confidence >= 0.60 OR needs_review = 1)
  ),
  reasons_json TEXT NOT NULL CHECK (
    length(CAST(reasons_json AS BLOB)) <= 65536
    AND CASE
      WHEN json_valid(reasons_json)
      THEN json_type(reasons_json) = 'array' AND json_array_length(reasons_json) <= 102
      ELSE 0
    END
  ),
  missing_signals_json TEXT NOT NULL CHECK (
    length(CAST(missing_signals_json AS BLOB)) <= 16384
    AND CASE
      WHEN json_valid(missing_signals_json)
      THEN json_type(missing_signals_json) = 'array'
        AND json_array_length(missing_signals_json) <= 20
      ELSE 0
    END
  ),
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  ),
  ruleset_version INTEGER NOT NULL CHECK (
    typeof(ruleset_version) = 'integer' AND ruleset_version > 0
  ),
  feature_fingerprint TEXT NOT NULL CHECK (
    length(feature_fingerprint) = 64
    AND feature_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  assessment_method TEXT NOT NULL CHECK (
    assessment_method IN ('rule', 'model')
  ),
  model_provenance_json TEXT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  evaluated_at TEXT NOT NULL CHECK (COALESCE(
    evaluated_at = strftime('%Y-%m-%dT%H:%M:%fZ', evaluated_at), 0
  )),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= evaluated_at
    )
  , 0)),
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT,
  CHECK (
    (assessment_method = 'rule' AND model_provenance_json IS NULL)
    OR (
      assessment_method = 'model'
      AND length(CAST(model_provenance_json AS BLOB)) <= 2048
      AND CASE WHEN (
        json_valid(model_provenance_json)
        AND json_type(model_provenance_json) = 'object'
        AND json_type(model_provenance_json, '$.provider') = 'text'
        AND json_extract(model_provenance_json, '$.provider') =
          trim(json_extract(model_provenance_json, '$.provider'))
        AND length(CAST(json_extract(model_provenance_json, '$.provider') AS BLOB))
          BETWEEN 1 AND 128
        AND json_type(model_provenance_json, '$.name') = 'text'
        AND json_extract(model_provenance_json, '$.name') =
          trim(json_extract(model_provenance_json, '$.name'))
        AND length(CAST(json_extract(model_provenance_json, '$.name') AS BLOB))
          BETWEEN 1 AND 128
        AND json_type(model_provenance_json, '$.promptVersion') = 'text'
        AND json_extract(model_provenance_json, '$.promptVersion') =
          trim(json_extract(model_provenance_json, '$.promptVersion'))
        AND length(CAST(json_extract(model_provenance_json, '$.promptVersion') AS BLOB))
          BETWEEN 1 AND 128
        AND json_remove(
          model_provenance_json, '$.provider', '$.name', '$.promptVersion'
        ) = '{}'
      ) THEN 1 ELSE 0 END
    )
  ),
  UNIQUE (id, logical_page_id),
  UNIQUE (logical_page_id, revision)
);

CREATE UNIQUE INDEX priority_current_assessment_idx
ON priority_assessments(logical_page_id)
WHERE superseded_at IS NULL;

CREATE INDEX priority_assessment_history_idx
ON priority_assessments(logical_page_id, revision DESC);

CREATE TABLE resource_priority_assessments (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL CHECK (
    typeof(resource_id) = 'integer' AND resource_id > 0
  ) REFERENCES resources(id) ON DELETE CASCADE,
  agent_score INTEGER NOT NULL CHECK (
    typeof(agent_score) = 'integer' AND agent_score BETWEEN 0 AND 100
  ),
  agent_band TEXT NOT NULL CHECK (
    agent_band IN ('low', 'medium', 'high', 'critical')
    AND (
      (agent_score BETWEEN 0 AND 24 AND agent_band = 'low')
      OR (agent_score BETWEEN 25 AND 59 AND agent_band = 'medium')
      OR (agent_score BETWEEN 60 AND 84 AND agent_band = 'high')
      OR (agent_score BETWEEN 85 AND 100 AND agent_band = 'critical')
    )
  ),
  confidence REAL NOT NULL CHECK (
    typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0 AND 1
  ),
  needs_review INTEGER NOT NULL CHECK (
    typeof(needs_review) = 'integer'
    AND needs_review IN (0, 1)
    AND (confidence >= 0.60 OR needs_review = 1)
  ),
  reasons_json TEXT NOT NULL CHECK (
    length(CAST(reasons_json AS BLOB)) <= 65536
    AND CASE
      WHEN json_valid(reasons_json)
      THEN json_type(reasons_json) = 'array' AND json_array_length(reasons_json) <= 102
      ELSE 0
    END
  ),
  missing_signals_json TEXT NOT NULL CHECK (
    length(CAST(missing_signals_json AS BLOB)) <= 16384
    AND CASE
      WHEN json_valid(missing_signals_json)
      THEN json_type(missing_signals_json) = 'array'
        AND json_array_length(missing_signals_json) <= 20
      ELSE 0
    END
  ),
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  ),
  ruleset_version INTEGER NOT NULL CHECK (
    typeof(ruleset_version) = 'integer' AND ruleset_version > 0
  ),
  feature_fingerprint TEXT NOT NULL CHECK (
    length(feature_fingerprint) = 64
    AND feature_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  assessment_method TEXT NOT NULL CHECK (
    assessment_method IN ('rule', 'model')
  ),
  model_provenance_json TEXT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  evaluated_at TEXT NOT NULL CHECK (COALESCE(
    evaluated_at = strftime('%Y-%m-%dT%H:%M:%fZ', evaluated_at), 0
  )),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= evaluated_at
    )
  , 0)),
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT,
  CHECK (
    (assessment_method = 'rule' AND model_provenance_json IS NULL)
    OR (
      assessment_method = 'model'
      AND length(CAST(model_provenance_json AS BLOB)) <= 2048
      AND CASE WHEN (
        json_valid(model_provenance_json)
        AND json_type(model_provenance_json) = 'object'
        AND json_type(model_provenance_json, '$.provider') = 'text'
        AND json_extract(model_provenance_json, '$.provider') =
          trim(json_extract(model_provenance_json, '$.provider'))
        AND length(CAST(json_extract(model_provenance_json, '$.provider') AS BLOB))
          BETWEEN 1 AND 128
        AND json_type(model_provenance_json, '$.name') = 'text'
        AND json_extract(model_provenance_json, '$.name') =
          trim(json_extract(model_provenance_json, '$.name'))
        AND length(CAST(json_extract(model_provenance_json, '$.name') AS BLOB))
          BETWEEN 1 AND 128
        AND json_type(model_provenance_json, '$.promptVersion') = 'text'
        AND json_extract(model_provenance_json, '$.promptVersion') =
          trim(json_extract(model_provenance_json, '$.promptVersion'))
        AND length(CAST(json_extract(model_provenance_json, '$.promptVersion') AS BLOB))
          BETWEEN 1 AND 128
        AND json_remove(
          model_provenance_json, '$.provider', '$.name', '$.promptVersion'
        ) = '{}'
      ) THEN 1 ELSE 0 END
    )
  ),
  UNIQUE (id, resource_id),
  UNIQUE (resource_id, revision)
);

CREATE UNIQUE INDEX resource_priority_current_assessment_idx
ON resource_priority_assessments(resource_id)
WHERE superseded_at IS NULL;

CREATE INDEX resource_priority_assessment_history_idx
ON resource_priority_assessments(resource_id, revision DESC);

CREATE TABLE priority_exclusions (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL CHECK (
    typeof(logical_page_id) = 'integer' AND logical_page_id > 0
  )
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'unsupported_url', 'private_or_internal', 'user_excluded',
      'policy_excluded', 'insufficient_signals', 'temporarily_unavailable'
    )
  ),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(CAST(detail_json AS BLOB)) <= 4096
    AND CASE
      WHEN json_valid(detail_json)
      THEN json_type(detail_json) = 'object'
      ELSE 0
    END
  ),
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  ),
  ruleset_version INTEGER NOT NULL CHECK (
    typeof(ruleset_version) = 'integer' AND ruleset_version > 0
  ),
  feature_fingerprint TEXT NOT NULL CHECK (
    length(feature_fingerprint) = 64
    AND feature_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  evaluated_at TEXT NOT NULL CHECK (COALESCE(
    evaluated_at = strftime('%Y-%m-%dT%H:%M:%fZ', evaluated_at), 0
  )),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= evaluated_at
    )
  , 0)),
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT,
  UNIQUE (id, logical_page_id),
  UNIQUE (logical_page_id, revision)
);

CREATE UNIQUE INDEX priority_current_exclusion_idx
ON priority_exclusions(logical_page_id)
WHERE superseded_at IS NULL;

CREATE INDEX priority_exclusion_history_idx
ON priority_exclusions(logical_page_id, revision DESC);

CREATE TABLE resource_priority_exclusions (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL CHECK (
    typeof(resource_id) = 'integer' AND resource_id > 0
  ) REFERENCES resources(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'unsupported_url', 'private_or_internal', 'user_excluded',
      'policy_excluded', 'insufficient_signals', 'temporarily_unavailable'
    )
  ),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(CAST(detail_json AS BLOB)) <= 4096
    AND CASE
      WHEN json_valid(detail_json)
      THEN json_type(detail_json) = 'object'
      ELSE 0
    END
  ),
  ruleset_id INTEGER NOT NULL CHECK (
    typeof(ruleset_id) = 'integer' AND ruleset_id > 0
  ),
  ruleset_version INTEGER NOT NULL CHECK (
    typeof(ruleset_version) = 'integer' AND ruleset_version > 0
  ),
  feature_fingerprint TEXT NOT NULL CHECK (
    length(feature_fingerprint) = 64
    AND feature_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  evaluated_at TEXT NOT NULL CHECK (COALESCE(
    evaluated_at = strftime('%Y-%m-%dT%H:%M:%fZ', evaluated_at), 0
  )),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= evaluated_at
    )
  , 0)),
  FOREIGN KEY (ruleset_id, ruleset_version)
    REFERENCES priority_rule_versions(ruleset_id, version) ON DELETE RESTRICT,
  UNIQUE (id, resource_id),
  UNIQUE (resource_id, revision)
);

CREATE UNIQUE INDEX resource_priority_current_exclusion_idx
ON resource_priority_exclusions(resource_id)
WHERE superseded_at IS NULL;

CREATE INDEX resource_priority_exclusion_history_idx
ON resource_priority_exclusions(resource_id, revision DESC);

CREATE TABLE priority_feedback (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL CHECK (
    typeof(logical_page_id) = 'integer' AND logical_page_id > 0
  )
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL CHECK (
    typeof(assessment_id) = 'integer' AND assessment_id > 0
  ),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('accept', 'reject', 'too_high', 'too_low')
  ),
  note TEXT CHECK (
    note IS NULL OR length(CAST(note AS BLOB)) BETWEEN 1 AND 4096
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  method TEXT NOT NULL CHECK (method IN ('manual', 'on_behalf_of_user')),
  authorization_ref TEXT CHECK (
    authorization_ref IS NULL
    OR length(CAST(authorization_ref AS BLOB)) BETWEEN 1 AND 256
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  supersedes_id INTEGER CHECK (
    supersedes_id IS NULL OR (typeof(supersedes_id) = 'integer' AND supersedes_id > 0)
  ),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= created_at
    )
  , 0)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  FOREIGN KEY (assessment_id, logical_page_id)
    REFERENCES priority_assessments(id, logical_page_id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_id, logical_page_id)
    REFERENCES priority_feedback(id, logical_page_id) ON DELETE CASCADE,
  CHECK (
    (actor = 'user' AND method = 'manual' AND authorization_ref IS NULL)
    OR (
      actor = 'agent' AND method = 'on_behalf_of_user'
      AND authorization_ref IS NOT NULL
    )
  ),
  CHECK (COALESCE(supersedes_id IS NULL OR supersedes_id < id, 0)),
  UNIQUE (id, logical_page_id),
  UNIQUE (logical_page_id, revision)
);

CREATE UNIQUE INDEX priority_current_feedback_idx
ON priority_feedback(logical_page_id)
WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX priority_feedback_superseded_once_idx
ON priority_feedback(supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE TABLE resource_priority_feedback (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL CHECK (
    typeof(resource_id) = 'integer' AND resource_id > 0
  ) REFERENCES resources(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL CHECK (
    typeof(assessment_id) = 'integer' AND assessment_id > 0
  ),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('accept', 'reject', 'too_high', 'too_low')
  ),
  note TEXT CHECK (
    note IS NULL OR length(CAST(note AS BLOB)) BETWEEN 1 AND 4096
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  method TEXT NOT NULL CHECK (method IN ('manual', 'on_behalf_of_user')),
  authorization_ref TEXT CHECK (
    authorization_ref IS NULL
    OR length(CAST(authorization_ref AS BLOB)) BETWEEN 1 AND 256
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  supersedes_id INTEGER CHECK (
    supersedes_id IS NULL OR (typeof(supersedes_id) = 'integer' AND supersedes_id > 0)
  ),
  superseded_at TEXT CHECK (COALESCE(
    superseded_at IS NULL
    OR (
      superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at)
      AND superseded_at >= created_at
    )
  , 0)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  created_at TEXT NOT NULL CHECK (COALESCE(
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0
  )),
  FOREIGN KEY (assessment_id, resource_id)
    REFERENCES resource_priority_assessments(id, resource_id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_id, resource_id)
    REFERENCES resource_priority_feedback(id, resource_id) ON DELETE CASCADE,
  CHECK (
    (actor = 'user' AND method = 'manual' AND authorization_ref IS NULL)
    OR (
      actor = 'agent' AND method = 'on_behalf_of_user'
      AND authorization_ref IS NOT NULL
    )
  ),
  CHECK (COALESCE(supersedes_id IS NULL OR supersedes_id < id, 0)),
  UNIQUE (id, resource_id),
  UNIQUE (resource_id, revision)
);

CREATE UNIQUE INDEX resource_priority_current_feedback_idx
ON resource_priority_feedback(resource_id)
WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX resource_priority_feedback_superseded_once_idx
ON resource_priority_feedback(supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE TRIGGER priority_baseline_ruleset_immutable_update
BEFORE UPDATE ON priority_rulesets
WHEN OLD.id = 1
BEGIN
  SELECT RAISE(ABORT, 'TabHub baseline priority ruleset is immutable');
END;

CREATE TRIGGER priority_baseline_ruleset_immutable_delete
BEFORE DELETE ON priority_rulesets
WHEN OLD.id = 1
BEGIN
  SELECT RAISE(ABORT, 'TabHub baseline priority ruleset is immutable');
END;

CREATE TRIGGER priority_rule_versions_validate_insert
BEFORE INSERT ON priority_rule_versions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT key FROM json_each(NEW.rule_ast_json)
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate top-level field') END;
  SELECT CASE WHEN EXISTS (
    SELECT key FROM json_each(NEW.rule_ast_json, '$.policy')
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate policy field') END;
  SELECT CASE WHEN EXISTS (
    SELECT key FROM json_each(NEW.rule_ast_json, '$.policy.bands')
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate band field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE EXISTS (
      SELECT field.key FROM json_each(rule.value) AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate rule field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE EXISTS (
      SELECT field.key FROM json_each(rule.value, '$.when') AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate when field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE EXISTS (
      SELECT field.key FROM json_each(rule.value, '$.effect') AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate effect field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    JOIN json_each(rule.value, '$.when.all') AS condition
    WHERE EXISTS (
      SELECT field.key FROM json_each(condition.value) AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate condition field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json)
    WHERE key NOT IN ('schemaVersion', 'policy', 'rules')
  ) THEN RAISE(ABORT, 'priority rule AST has unknown top-level field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.policy')
    WHERE key NOT IN (
      'baseScore', 'baseConfidence', 'lowConfidenceThreshold',
      'missingCapturedContentPenalty', 'bands'
    )
  ) THEN RAISE(ABORT, 'priority rule AST has unknown policy field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.policy.bands')
    WHERE key NOT IN ('mediumMin', 'highMin', 'criticalMin')
  ) THEN RAISE(ABORT, 'priority rule AST has unknown band field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE NOT COALESCE((
      json_type(rule.value) = 'object'
      AND json_type(rule.value, '$.ruleKey') = 'text'
      AND json_extract(rule.value, '$.ruleKey') = trim(json_extract(rule.value, '$.ruleKey'))
      AND length(CAST(json_extract(rule.value, '$.ruleKey') AS BLOB)) BETWEEN 1 AND 128
      AND json_extract(rule.value, '$.ruleKey') NOT GLOB '*[^a-z0-9._-]*'
      AND substr(json_extract(rule.value, '$.ruleKey'), 1, 1) NOT GLOB '[^a-z0-9]'
      AND json_type(rule.value, '$.priority') IN ('integer', 'real')
      AND json_extract(rule.value, '$.priority') BETWEEN 0 AND 1000
      AND json_extract(rule.value, '$.priority') =
        CAST(json_extract(rule.value, '$.priority') AS INTEGER)
      AND json_type(rule.value, '$.label') = 'text'
      AND json_extract(rule.value, '$.label') = trim(json_extract(rule.value, '$.label'))
      AND length(CAST(json_extract(rule.value, '$.label') AS BLOB)) BETWEEN 1 AND 200
      AND json_type(rule.value, '$.appliesTo') = 'text'
      AND json_extract(rule.value, '$.appliesTo') IN ('page', 'resource', 'both')
      AND json_type(rule.value, '$.when') = 'object'
      AND json_type(rule.value, '$.when.all') = 'array'
      AND json_array_length(rule.value, '$.when.all') BETWEEN 1 AND 8
      AND json_type(rule.value, '$.effect') = 'object'
      AND EXISTS (SELECT 1 FROM json_each(rule.value, '$.effect'))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(rule.value) AS field
        WHERE field.key NOT IN (
          'ruleKey', 'priority', 'label', 'appliesTo', 'when', 'effect'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(rule.value, '$.when') AS field
        WHERE field.key <> 'all'
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(rule.value, '$.effect') AS field
        WHERE field.key NOT IN (
          'scoreDelta', 'confidenceDelta', 'scoreFloor', 'scoreCap',
          'needsReview', 'exclusionReason'
        )
      )
    ), 0)
  ) THEN RAISE(ABORT, 'priority rule AST has invalid rule structure') END;
  SELECT CASE WHEN EXISTS (
    SELECT json_extract(rule.value, '$.ruleKey')
    FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    GROUP BY json_extract(rule.value, '$.ruleKey')
    HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority rule AST has duplicate ruleKey') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    JOIN json_each(rule.value, '$.when.all') AS condition
    WHERE NOT COALESCE((
      json_type(condition.value) = 'object'
      AND json_type(condition.value, '$.signal') = 'text'
      AND json_type(condition.value, '$.operator') = 'text'
      AND json_type(condition.value, '$.value') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM json_each(condition.value) AS field
        WHERE field.key NOT IN ('signal', 'operator', 'value')
      )
      AND json_extract(condition.value, '$.signal') IN (
        'has_shareable_next_action', 'has_shareable_project_context',
        'has_current_project_membership', 'topic_paths', 'workspace_names',
        'is_pinned', 'is_open', 'status', 'relation_count',
        'active_use_30d_ms', 'on_screen_30d_ms', 'age_days', 'last_seen_days',
        'has_captured_content', 'has_current_summary',
        'has_current_research_report', 'duplicate_physical_count',
        'resource_page_count', 'resource_captured_page_count'
      )
      AND (
        (
          json_extract(condition.value, '$.signal') IN (
            'has_shareable_next_action', 'has_shareable_project_context',
            'has_current_project_membership', 'is_pinned', 'is_open',
            'has_captured_content', 'has_current_summary',
            'has_current_research_report'
          )
          AND json_extract(condition.value, '$.operator') = 'eq'
          AND json_type(condition.value, '$.value') IN ('true', 'false')
        )
        OR (
          json_extract(condition.value, '$.signal') IN (
            'relation_count', 'active_use_30d_ms', 'on_screen_30d_ms',
            'age_days', 'last_seen_days', 'duplicate_physical_count',
            'resource_page_count', 'resource_captured_page_count'
          )
          AND json_extract(condition.value, '$.operator') IN ('eq', 'gte', 'lte')
          AND json_type(condition.value, '$.value') IN ('integer', 'real')
          AND abs(json_extract(condition.value, '$.value')) <= 9007199254740991
        )
        OR (
          json_extract(condition.value, '$.signal') IN (
            'topic_paths', 'workspace_names', 'status'
          )
          AND json_extract(condition.value, '$.operator') = 'in'
          AND json_type(condition.value, '$.value') = 'array'
          AND json_array_length(condition.value, '$.value') BETWEEN 1 AND 100
          AND NOT EXISTS (
            SELECT 1 FROM json_each(condition.value, '$.value') AS item
            WHERE item.type <> 'text'
              OR item.value <> trim(item.value)
              OR length(CAST(item.value AS BLOB)) NOT BETWEEN 1 AND 256
          )
          AND NOT EXISTS (
            SELECT trim(item.value)
            FROM json_each(condition.value, '$.value') AS item
            GROUP BY trim(item.value) HAVING COUNT(*) > 1
          )
        )
      )
      AND NOT (
        json_extract(condition.value, '$.signal') IN (
          'resource_page_count', 'resource_captured_page_count'
        )
        AND json_extract(rule.value, '$.appliesTo') <> 'resource'
      )
    ), 0)
  ) THEN RAISE(ABORT, 'priority rule AST has invalid condition') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE
      (
        json_type(rule.value, '$.effect.scoreDelta') IS NOT NULL
        AND NOT COALESCE((
          json_type(rule.value, '$.effect.scoreDelta') IN ('integer', 'real')
          AND json_extract(rule.value, '$.effect.scoreDelta') BETWEEN -100 AND 100
          AND json_extract(rule.value, '$.effect.scoreDelta') =
            CAST(json_extract(rule.value, '$.effect.scoreDelta') AS INTEGER)
        ), 0)
      )
      OR (
        json_type(rule.value, '$.effect.confidenceDelta') IS NOT NULL
        AND NOT COALESCE((
          json_type(rule.value, '$.effect.confidenceDelta') IN ('integer', 'real')
          AND json_extract(rule.value, '$.effect.confidenceDelta') BETWEEN -1 AND 1
        ), 0)
      )
      OR (
        json_type(rule.value, '$.effect.scoreFloor') IS NOT NULL
        AND NOT COALESCE((
          json_type(rule.value, '$.effect.scoreFloor') IN ('integer', 'real')
          AND json_extract(rule.value, '$.effect.scoreFloor') BETWEEN 0 AND 100
          AND json_extract(rule.value, '$.effect.scoreFloor') =
            CAST(json_extract(rule.value, '$.effect.scoreFloor') AS INTEGER)
        ), 0)
      )
      OR (
        json_type(rule.value, '$.effect.scoreCap') IS NOT NULL
        AND NOT COALESCE((
          json_type(rule.value, '$.effect.scoreCap') IN ('integer', 'real')
          AND json_extract(rule.value, '$.effect.scoreCap') BETWEEN 0 AND 100
          AND json_extract(rule.value, '$.effect.scoreCap') =
            CAST(json_extract(rule.value, '$.effect.scoreCap') AS INTEGER)
        ), 0)
      )
      OR (
        json_type(rule.value, '$.effect.needsReview') IS NOT NULL
        AND json_type(rule.value, '$.effect.needsReview') NOT IN ('true', 'false')
      )
      OR (
        json_type(rule.value, '$.effect.exclusionReason') IS NOT NULL
        AND NOT COALESCE((
          json_type(rule.value, '$.effect.exclusionReason') = 'text'
          AND json_extract(rule.value, '$.effect.exclusionReason') IN (
            'user_excluded', 'policy_excluded'
          )
        ), 0)
      )
      OR (
        json_type(rule.value, '$.effect.scoreFloor') IS NOT NULL
        AND json_type(rule.value, '$.effect.scoreCap') IS NOT NULL
        AND json_extract(rule.value, '$.effect.scoreFloor') >
          json_extract(rule.value, '$.effect.scoreCap')
      )
  ) THEN RAISE(ABORT, 'priority rule AST has invalid effect') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.rule_ast_json, '$.rules') AS rule
    WHERE EXISTS (
      SELECT 1 FROM json_each(rule.value, '$.when.all') AS condition
      WHERE json_extract(condition.value, '$.signal') = 'has_captured_content'
        AND json_extract(condition.value, '$.operator') = 'eq'
        AND json_type(condition.value, '$.value') = 'false'
    ) AND (
      json_type(rule.value, '$.effect.scoreDelta') IS NOT NULL
      OR json_type(rule.value, '$.effect.scoreFloor') IS NOT NULL
      OR json_type(rule.value, '$.effect.scoreCap') IS NOT NULL
      OR json_type(rule.value, '$.effect.exclusionReason') IS NOT NULL
      OR (
        json_type(rule.value, '$.effect.confidenceDelta') IS NOT NULL
        AND json_extract(rule.value, '$.effect.confidenceDelta') >= 0
      )
      OR (
        json_type(rule.value, '$.effect.needsReview') IS NOT NULL
        AND json_type(rule.value, '$.effect.needsReview') <> 'true'
      )
    )
  ) THEN RAISE(ABORT, 'missing content rule cannot lower score or hide review') END;
END;

CREATE TRIGGER priority_assessments_json_guard
BEFORE INSERT ON priority_assessments
BEGIN
  SELECT CASE WHEN NEW.model_provenance_json IS NOT NULL AND EXISTS (
    SELECT key FROM json_each(NEW.model_provenance_json)
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority model provenance has duplicate field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.reasons_json) AS reason
    WHERE EXISTS (
      SELECT field.key FROM json_each(reason.value) AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'priority reason has duplicate field') END;
  SELECT CASE WHEN json_array_length(NEW.reasons_json) > 102 OR EXISTS (
    SELECT 1 FROM json_each(NEW.reasons_json) AS reason
    WHERE NOT COALESCE((
      json_type(reason.value) = 'object'
      AND json_type(reason.value, '$.code') = 'text'
      AND json_extract(reason.value, '$.code') = trim(json_extract(reason.value, '$.code'))
      AND length(CAST(json_extract(reason.value, '$.code') AS BLOB)) BETWEEN 1 AND 512
      AND json_type(reason.value, '$.kind') = 'text'
      AND json_extract(reason.value, '$.kind') IN ('contribution', 'conflict', 'review')
      AND json_type(reason.value, '$.label') = 'text'
      AND json_extract(reason.value, '$.label') = trim(json_extract(reason.value, '$.label'))
      AND length(CAST(json_extract(reason.value, '$.label') AS BLOB)) BETWEEN 1 AND 1024
      AND (
        json_type(reason.value, '$.scoreDelta') IS NULL OR (
          json_type(reason.value, '$.scoreDelta') IN ('integer', 'real')
          AND json_extract(reason.value, '$.scoreDelta') BETWEEN -100 AND 100
          AND json_extract(reason.value, '$.scoreDelta') =
            CAST(json_extract(reason.value, '$.scoreDelta') AS INTEGER)
        )
      )
      AND (
        json_type(reason.value, '$.confidenceDelta') IS NULL OR (
          json_type(reason.value, '$.confidenceDelta') IN ('integer', 'real')
          AND json_extract(reason.value, '$.confidenceDelta') BETWEEN -1 AND 1
        )
      )
      AND (
        json_type(reason.value, '$.appliedRuleKey') IS NULL OR (
          json_type(reason.value, '$.appliedRuleKey') = 'text'
          AND json_extract(reason.value, '$.appliedRuleKey') =
            trim(json_extract(reason.value, '$.appliedRuleKey'))
          AND length(CAST(json_extract(reason.value, '$.appliedRuleKey') AS BLOB)) BETWEEN 1 AND 128
          AND json_extract(reason.value, '$.appliedRuleKey') NOT GLOB '*[^a-z0-9._-]*'
          AND substr(json_extract(reason.value, '$.appliedRuleKey'), 1, 1) NOT GLOB '[^a-z0-9]'
        )
      )
      AND (
        json_type(reason.value, '$.ignoredRuleKey') IS NULL OR (
          json_type(reason.value, '$.ignoredRuleKey') = 'text'
          AND json_extract(reason.value, '$.ignoredRuleKey') =
            trim(json_extract(reason.value, '$.ignoredRuleKey'))
          AND length(CAST(json_extract(reason.value, '$.ignoredRuleKey') AS BLOB)) BETWEEN 1 AND 128
          AND json_extract(reason.value, '$.ignoredRuleKey') NOT GLOB '*[^a-z0-9._-]*'
          AND substr(json_extract(reason.value, '$.ignoredRuleKey'), 1, 1) NOT GLOB '[^a-z0-9]'
        )
      )
      AND json_remove(
        reason.value, '$.code', '$.kind', '$.label', '$.scoreDelta',
        '$.confidenceDelta', '$.appliedRuleKey', '$.ignoredRuleKey'
      ) = '{}'
      AND CASE json_extract(reason.value, '$.kind')
        WHEN 'contribution' THEN
          json_type(reason.value, '$.appliedRuleKey') IS NULL
          AND json_type(reason.value, '$.ignoredRuleKey') IS NULL
        WHEN 'conflict' THEN
          json_type(reason.value, '$.scoreDelta') IS NULL
          AND json_type(reason.value, '$.confidenceDelta') IS NULL
          AND json_type(reason.value, '$.appliedRuleKey') = 'text'
          AND json_type(reason.value, '$.ignoredRuleKey') = 'text'
        WHEN 'review' THEN
          json_type(reason.value, '$.scoreDelta') IS NULL
          AND json_type(reason.value, '$.confidenceDelta') IS NULL
          AND json_type(reason.value, '$.ignoredRuleKey') IS NULL
        ELSE 0
      END
    ), 0)
  ) OR EXISTS (
    SELECT json_extract(reason.value, '$.code')
    FROM json_each(NEW.reasons_json) AS reason
    GROUP BY json_extract(reason.value, '$.code') HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority reasons JSON is invalid') END;
  SELECT CASE WHEN json_array_length(NEW.missing_signals_json) > 20 OR EXISTS (
    SELECT 1 FROM json_each(NEW.missing_signals_json) AS signal
    WHERE signal.type <> 'text' OR signal.value NOT IN (
      'captured_content', 'has_shareable_next_action', 'has_shareable_project_context',
      'has_current_project_membership', 'topic_paths', 'workspace_names', 'is_pinned',
      'is_open', 'status', 'relation_count', 'active_use_30d_ms', 'on_screen_30d_ms',
      'age_days', 'last_seen_days', 'has_captured_content', 'has_current_summary',
      'has_current_research_report', 'duplicate_physical_count', 'resource_page_count',
      'resource_captured_page_count'
    )
  ) OR EXISTS (
    SELECT signal.value FROM json_each(NEW.missing_signals_json) AS signal
    GROUP BY signal.value HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority missing signals JSON is invalid') END;
END;

CREATE TRIGGER resource_priority_assessments_json_guard
BEFORE INSERT ON resource_priority_assessments
BEGIN
  SELECT CASE WHEN NEW.model_provenance_json IS NOT NULL AND EXISTS (
    SELECT key FROM json_each(NEW.model_provenance_json)
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'resource priority model provenance has duplicate field') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.reasons_json) AS reason
    WHERE EXISTS (
      SELECT field.key FROM json_each(reason.value) AS field
      GROUP BY field.key HAVING COUNT(*) > 1
    )
  ) THEN RAISE(ABORT, 'resource priority reason has duplicate field') END;
  SELECT CASE WHEN json_array_length(NEW.reasons_json) > 102 OR EXISTS (
    SELECT 1 FROM json_each(NEW.reasons_json) AS reason
    WHERE NOT COALESCE((
      json_type(reason.value) = 'object'
      AND json_type(reason.value, '$.code') = 'text'
      AND json_extract(reason.value, '$.code') = trim(json_extract(reason.value, '$.code'))
      AND length(CAST(json_extract(reason.value, '$.code') AS BLOB)) BETWEEN 1 AND 512
      AND json_type(reason.value, '$.kind') = 'text'
      AND json_extract(reason.value, '$.kind') IN ('contribution', 'conflict', 'review')
      AND json_type(reason.value, '$.label') = 'text'
      AND json_extract(reason.value, '$.label') = trim(json_extract(reason.value, '$.label'))
      AND length(CAST(json_extract(reason.value, '$.label') AS BLOB)) BETWEEN 1 AND 1024
      AND (json_type(reason.value, '$.scoreDelta') IS NULL OR (
        json_type(reason.value, '$.scoreDelta') IN ('integer', 'real')
        AND json_extract(reason.value, '$.scoreDelta') BETWEEN -100 AND 100
        AND json_extract(reason.value, '$.scoreDelta') =
          CAST(json_extract(reason.value, '$.scoreDelta') AS INTEGER)
      ))
      AND (json_type(reason.value, '$.confidenceDelta') IS NULL OR (
        json_type(reason.value, '$.confidenceDelta') IN ('integer', 'real')
        AND json_extract(reason.value, '$.confidenceDelta') BETWEEN -1 AND 1
      ))
      AND (json_type(reason.value, '$.appliedRuleKey') IS NULL OR (
        json_type(reason.value, '$.appliedRuleKey') = 'text'
        AND json_extract(reason.value, '$.appliedRuleKey') = trim(json_extract(reason.value, '$.appliedRuleKey'))
        AND length(CAST(json_extract(reason.value, '$.appliedRuleKey') AS BLOB)) BETWEEN 1 AND 128
        AND json_extract(reason.value, '$.appliedRuleKey') NOT GLOB '*[^a-z0-9._-]*'
        AND substr(json_extract(reason.value, '$.appliedRuleKey'), 1, 1) NOT GLOB '[^a-z0-9]'
      ))
      AND (json_type(reason.value, '$.ignoredRuleKey') IS NULL OR (
        json_type(reason.value, '$.ignoredRuleKey') = 'text'
        AND json_extract(reason.value, '$.ignoredRuleKey') = trim(json_extract(reason.value, '$.ignoredRuleKey'))
        AND length(CAST(json_extract(reason.value, '$.ignoredRuleKey') AS BLOB)) BETWEEN 1 AND 128
        AND json_extract(reason.value, '$.ignoredRuleKey') NOT GLOB '*[^a-z0-9._-]*'
        AND substr(json_extract(reason.value, '$.ignoredRuleKey'), 1, 1) NOT GLOB '[^a-z0-9]'
      ))
      AND json_remove(
        reason.value, '$.code', '$.kind', '$.label', '$.scoreDelta',
        '$.confidenceDelta', '$.appliedRuleKey', '$.ignoredRuleKey'
      ) = '{}'
      AND CASE json_extract(reason.value, '$.kind')
        WHEN 'contribution' THEN
          json_type(reason.value, '$.appliedRuleKey') IS NULL
          AND json_type(reason.value, '$.ignoredRuleKey') IS NULL
        WHEN 'conflict' THEN
          json_type(reason.value, '$.scoreDelta') IS NULL
          AND json_type(reason.value, '$.confidenceDelta') IS NULL
          AND json_type(reason.value, '$.appliedRuleKey') = 'text'
          AND json_type(reason.value, '$.ignoredRuleKey') = 'text'
        WHEN 'review' THEN
          json_type(reason.value, '$.scoreDelta') IS NULL
          AND json_type(reason.value, '$.confidenceDelta') IS NULL
          AND json_type(reason.value, '$.ignoredRuleKey') IS NULL
        ELSE 0
      END
    ), 0)
  ) OR EXISTS (
    SELECT json_extract(reason.value, '$.code') FROM json_each(NEW.reasons_json) AS reason
    GROUP BY json_extract(reason.value, '$.code') HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'resource priority reasons JSON is invalid') END;
  SELECT CASE WHEN json_array_length(NEW.missing_signals_json) > 20 OR EXISTS (
    SELECT 1 FROM json_each(NEW.missing_signals_json) AS signal
    WHERE signal.type <> 'text' OR signal.value NOT IN (
      'captured_content', 'has_shareable_next_action', 'has_shareable_project_context',
      'has_current_project_membership', 'topic_paths', 'workspace_names', 'is_pinned',
      'is_open', 'status', 'relation_count', 'active_use_30d_ms', 'on_screen_30d_ms',
      'age_days', 'last_seen_days', 'has_captured_content', 'has_current_summary',
      'has_current_research_report', 'duplicate_physical_count', 'resource_page_count',
      'resource_captured_page_count'
    )
  ) OR EXISTS (
    SELECT signal.value FROM json_each(NEW.missing_signals_json) AS signal
    GROUP BY signal.value HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'resource priority missing signals JSON is invalid') END;
END;

CREATE TRIGGER priority_rule_versions_immutable_update
BEFORE UPDATE ON priority_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'priority rule versions are immutable');
END;

CREATE TRIGGER priority_rule_versions_immutable_delete
BEFORE DELETE ON priority_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'priority rule versions are immutable');
END;

CREATE TRIGGER priority_assessments_insert_guard
BEFORE INSERT ON priority_assessments
BEGIN
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new priority assessment must be current'
  ) END;
  SELECT CASE WHEN NEW.revision <> 1 + MAX(
    COALESCE((SELECT MAX(revision) FROM priority_assessments
      WHERE logical_page_id = NEW.logical_page_id), 0),
    COALESCE((SELECT MAX(revision) FROM priority_exclusions
      WHERE logical_page_id = NEW.logical_page_id), 0)
  ) THEN RAISE(ABORT, 'priority outcome revision must be sequential') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM priority_exclusions
    WHERE logical_page_id = NEW.logical_page_id AND superseded_at IS NULL
  ) THEN RAISE(ABORT, 'current priority outcome must be assessment XOR exclusion') END;
END;

CREATE TRIGGER priority_exclusions_insert_guard
BEFORE INSERT ON priority_exclusions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT key FROM json_each(NEW.detail_json)
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'priority exclusion detail has duplicate field') END;
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new priority exclusion must be current'
  ) END;
  SELECT CASE WHEN NEW.revision <> 1 + MAX(
    COALESCE((SELECT MAX(revision) FROM priority_assessments
      WHERE logical_page_id = NEW.logical_page_id), 0),
    COALESCE((SELECT MAX(revision) FROM priority_exclusions
      WHERE logical_page_id = NEW.logical_page_id), 0)
  ) THEN RAISE(ABORT, 'priority outcome revision must be sequential') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM priority_assessments
    WHERE logical_page_id = NEW.logical_page_id AND superseded_at IS NULL
  ) THEN RAISE(ABORT, 'current priority outcome must be assessment XOR exclusion') END;
END;

CREATE TRIGGER resource_priority_assessments_insert_guard
BEFORE INSERT ON resource_priority_assessments
BEGIN
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new resource priority assessment must be current'
  ) END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM resource_heads AS heads
    JOIN resource_events AS events
      ON events.id = heads.event_id AND events.resource_id = heads.resource_id
    WHERE heads.resource_id = NEW.resource_id
      AND events.lifecycle_state = 'active'
  ) THEN RAISE(ABORT, 'resource priority outcome requires current active resource') END;
  SELECT CASE WHEN NEW.revision <> 1 + MAX(
    COALESCE((SELECT MAX(revision) FROM resource_priority_assessments
      WHERE resource_id = NEW.resource_id), 0),
    COALESCE((SELECT MAX(revision) FROM resource_priority_exclusions
      WHERE resource_id = NEW.resource_id), 0)
  ) THEN RAISE(ABORT, 'resource priority outcome revision must be sequential') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM resource_priority_exclusions
    WHERE resource_id = NEW.resource_id AND superseded_at IS NULL
  ) THEN RAISE(ABORT, 'current resource priority outcome must be assessment XOR exclusion') END;
END;

CREATE TRIGGER resource_priority_exclusions_insert_guard
BEFORE INSERT ON resource_priority_exclusions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT key FROM json_each(NEW.detail_json)
    GROUP BY key HAVING COUNT(*) > 1
  ) THEN RAISE(ABORT, 'resource priority exclusion detail has duplicate field') END;
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new resource priority exclusion must be current'
  ) END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM resource_heads AS heads
    JOIN resource_events AS events
      ON events.id = heads.event_id AND events.resource_id = heads.resource_id
    WHERE heads.resource_id = NEW.resource_id
      AND events.lifecycle_state = 'active'
  ) THEN RAISE(ABORT, 'resource priority outcome requires current active resource') END;
  SELECT CASE WHEN NEW.revision <> 1 + MAX(
    COALESCE((SELECT MAX(revision) FROM resource_priority_assessments
      WHERE resource_id = NEW.resource_id), 0),
    COALESCE((SELECT MAX(revision) FROM resource_priority_exclusions
      WHERE resource_id = NEW.resource_id), 0)
  ) THEN RAISE(ABORT, 'resource priority outcome revision must be sequential') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM resource_priority_assessments
    WHERE resource_id = NEW.resource_id AND superseded_at IS NULL
  ) THEN RAISE(ABORT, 'current resource priority outcome must be assessment XOR exclusion') END;
END;

CREATE TRIGGER priority_assessments_append_only
BEFORE UPDATE ON priority_assessments
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.logical_page_id IS OLD.logical_page_id
  AND NEW.agent_score IS OLD.agent_score
  AND NEW.agent_band IS OLD.agent_band
  AND NEW.confidence IS OLD.confidence
  AND NEW.needs_review IS OLD.needs_review
  AND NEW.reasons_json IS OLD.reasons_json
  AND NEW.missing_signals_json IS OLD.missing_signals_json
  AND NEW.ruleset_id IS OLD.ruleset_id
  AND NEW.ruleset_version IS OLD.ruleset_version
  AND NEW.feature_fingerprint IS OLD.feature_fingerprint
  AND NEW.assessment_method IS OLD.assessment_method
  AND NEW.model_provenance_json IS OLD.model_provenance_json
  AND NEW.revision IS OLD.revision
  AND NEW.evaluated_at IS OLD.evaluated_at
)
BEGIN
  SELECT RAISE(ABORT, 'priority assessment history is append-only');
END;

CREATE TRIGGER resource_priority_assessments_append_only
BEFORE UPDATE ON resource_priority_assessments
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.resource_id IS OLD.resource_id
  AND NEW.agent_score IS OLD.agent_score
  AND NEW.agent_band IS OLD.agent_band
  AND NEW.confidence IS OLD.confidence
  AND NEW.needs_review IS OLD.needs_review
  AND NEW.reasons_json IS OLD.reasons_json
  AND NEW.missing_signals_json IS OLD.missing_signals_json
  AND NEW.ruleset_id IS OLD.ruleset_id
  AND NEW.ruleset_version IS OLD.ruleset_version
  AND NEW.feature_fingerprint IS OLD.feature_fingerprint
  AND NEW.assessment_method IS OLD.assessment_method
  AND NEW.model_provenance_json IS OLD.model_provenance_json
  AND NEW.revision IS OLD.revision
  AND NEW.evaluated_at IS OLD.evaluated_at
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority assessment history is append-only');
END;

CREATE TRIGGER priority_exclusions_append_only
BEFORE UPDATE ON priority_exclusions
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.logical_page_id IS OLD.logical_page_id
  AND NEW.reason IS OLD.reason
  AND NEW.detail_json IS OLD.detail_json
  AND NEW.ruleset_id IS OLD.ruleset_id
  AND NEW.ruleset_version IS OLD.ruleset_version
  AND NEW.feature_fingerprint IS OLD.feature_fingerprint
  AND NEW.revision IS OLD.revision
  AND NEW.evaluated_at IS OLD.evaluated_at
)
BEGIN
  SELECT RAISE(ABORT, 'priority exclusion history is append-only');
END;

CREATE TRIGGER resource_priority_exclusions_append_only
BEFORE UPDATE ON resource_priority_exclusions
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.resource_id IS OLD.resource_id
  AND NEW.reason IS OLD.reason
  AND NEW.detail_json IS OLD.detail_json
  AND NEW.ruleset_id IS OLD.ruleset_id
  AND NEW.ruleset_version IS OLD.ruleset_version
  AND NEW.feature_fingerprint IS OLD.feature_fingerprint
  AND NEW.revision IS OLD.revision
  AND NEW.evaluated_at IS OLD.evaluated_at
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority exclusion history is append-only');
END;

CREATE TRIGGER priority_assessments_privacy_delete_only
BEFORE DELETE ON priority_assessments
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'priority assessment delete requires subject privacy deletion');
END;

CREATE TRIGGER priority_exclusions_privacy_delete_only
BEFORE DELETE ON priority_exclusions
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'priority exclusion delete requires subject privacy deletion');
END;

CREATE TRIGGER resource_priority_assessments_privacy_delete_only
BEFORE DELETE ON resource_priority_assessments
WHEN EXISTS (
  SELECT 1 FROM resources WHERE id = OLD.resource_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority assessment delete requires subject privacy deletion');
END;

CREATE TRIGGER resource_priority_exclusions_privacy_delete_only
BEFORE DELETE ON resource_priority_exclusions
WHEN EXISTS (
  SELECT 1 FROM resources WHERE id = OLD.resource_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority exclusion delete requires subject privacy deletion');
END;

CREATE TRIGGER priority_feedback_insert_guard
BEFORE INSERT ON priority_feedback
BEGIN
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new priority feedback must be current'
  ) END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM resource_priority_feedback
    WHERE idempotency_key = NEW.idempotency_key
  ) THEN RAISE(ABORT, 'priority feedback idempotency key already used') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM priority_assessments
    WHERE id = NEW.assessment_id
      AND logical_page_id = NEW.logical_page_id
      AND superseded_at IS NULL
      AND evaluated_at <= NEW.created_at
  ) THEN RAISE(ABORT, 'priority feedback requires current assessment') END;
  SELECT CASE WHEN NEW.revision <> 1 + COALESCE((
    SELECT MAX(revision) FROM priority_feedback
    WHERE logical_page_id = NEW.logical_page_id
  ), 0) THEN RAISE(ABORT, 'priority feedback revision must be sequential') END;
  SELECT CASE WHEN (
    (NEW.supersedes_id IS NULL AND NEW.revision <> 1)
    OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM priority_feedback AS prior
      WHERE prior.id = NEW.supersedes_id
        AND prior.logical_page_id = NEW.logical_page_id
        AND prior.revision = NEW.revision - 1
        AND prior.superseded_at = NEW.created_at
        AND prior.created_at <= NEW.created_at
    ))
  ) THEN RAISE(ABORT, 'priority feedback supersession must follow current revision') END;
END;

CREATE TRIGGER resource_priority_feedback_insert_guard
BEFORE INSERT ON resource_priority_feedback
BEGIN
  SELECT CASE WHEN NEW.superseded_at IS NOT NULL THEN RAISE(
    ABORT, 'new resource priority feedback must be current'
  ) END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM priority_feedback
    WHERE idempotency_key = NEW.idempotency_key
  ) THEN RAISE(ABORT, 'priority feedback idempotency key already used') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM resource_priority_assessments
    WHERE id = NEW.assessment_id
      AND resource_id = NEW.resource_id
      AND superseded_at IS NULL
      AND evaluated_at <= NEW.created_at
  ) THEN RAISE(ABORT, 'resource priority feedback requires current assessment') END;
  SELECT CASE WHEN NEW.revision <> 1 + COALESCE((
    SELECT MAX(revision) FROM resource_priority_feedback
    WHERE resource_id = NEW.resource_id
  ), 0) THEN RAISE(ABORT, 'resource priority feedback revision must be sequential') END;
  SELECT CASE WHEN (
    (NEW.supersedes_id IS NULL AND NEW.revision <> 1)
    OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM resource_priority_feedback AS prior
      WHERE prior.id = NEW.supersedes_id
        AND prior.resource_id = NEW.resource_id
        AND prior.revision = NEW.revision - 1
        AND prior.superseded_at = NEW.created_at
        AND prior.created_at <= NEW.created_at
    ))
  ) THEN RAISE(ABORT, 'resource priority feedback supersession must follow current revision') END;
END;

CREATE TRIGGER priority_feedback_append_only
BEFORE UPDATE ON priority_feedback
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.logical_page_id IS OLD.logical_page_id
  AND NEW.assessment_id IS OLD.assessment_id
  AND NEW.verdict IS OLD.verdict
  AND NEW.note IS OLD.note
  AND NEW.actor IS OLD.actor
  AND NEW.method IS OLD.method
  AND NEW.authorization_ref IS OLD.authorization_ref
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_fingerprint IS OLD.request_fingerprint
  AND NEW.supersedes_id IS OLD.supersedes_id
  AND NEW.revision IS OLD.revision
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'priority feedback history is append-only');
END;

CREATE TRIGGER resource_priority_feedback_append_only
BEFORE UPDATE ON resource_priority_feedback
WHEN NOT (
  OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.resource_id IS OLD.resource_id
  AND NEW.assessment_id IS OLD.assessment_id
  AND NEW.verdict IS OLD.verdict
  AND NEW.note IS OLD.note
  AND NEW.actor IS OLD.actor
  AND NEW.method IS OLD.method
  AND NEW.authorization_ref IS OLD.authorization_ref
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_fingerprint IS OLD.request_fingerprint
  AND NEW.supersedes_id IS OLD.supersedes_id
  AND NEW.revision IS OLD.revision
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority feedback history is append-only');
END;

CREATE TRIGGER priority_feedback_privacy_delete_only
BEFORE DELETE ON priority_feedback
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'priority feedback delete requires subject privacy deletion');
END;

CREATE TRIGGER resource_priority_feedback_privacy_delete_only
BEFORE DELETE ON resource_priority_feedback
WHEN EXISTS (
  SELECT 1 FROM resources WHERE id = OLD.resource_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource priority feedback delete requires subject privacy deletion');
END;

CREATE TRIGGER resource_priority_close_current_on_merge
AFTER UPDATE OF event_id ON resource_heads
WHEN EXISTS (
  SELECT 1 FROM resource_events
  WHERE id = NEW.event_id
    AND resource_id = NEW.resource_id
    AND lifecycle_state = 'merged'
)
BEGIN
  UPDATE resource_priority_feedback
  SET superseded_at = (
    SELECT created_at FROM resource_events WHERE id = NEW.event_id
  )
  WHERE resource_id = NEW.resource_id AND superseded_at IS NULL;

  UPDATE resource_priority_assessments
  SET superseded_at = (
    SELECT created_at FROM resource_events WHERE id = NEW.event_id
  )
  WHERE resource_id = NEW.resource_id AND superseded_at IS NULL;

  UPDATE resource_priority_exclusions
  SET superseded_at = (
    SELECT created_at FROM resource_events WHERE id = NEW.event_id
  )
  WHERE resource_id = NEW.resource_id AND superseded_at IS NULL;
END;

INSERT INTO priority_rulesets (id, name, created_at, updated_at)
VALUES (1, 'TabHub baseline', tabhub_migration_now(), tabhub_migration_now());

INSERT INTO priority_rule_versions (
  ruleset_id,
  version,
  rule_ast_json,
  natural_language_source,
  created_by,
  created_at
) VALUES (
  1,
  1,
  '{"policy":{"bands":{"criticalMin":85,"highMin":60,"mediumMin":25},"baseConfidence":0.65,"baseScore":40,"lowConfidenceThreshold":0.6,"missingCapturedContentPenalty":0.2},"rules":[{"appliesTo":"both","effect":{"confidenceDelta":0.1,"scoreDelta":10},"label":"At least 15 minutes of active use in 30 days","priority":100,"ruleKey":"baseline.active-use-30d","when":{"all":[{"operator":"gte","signal":"active_use_30d_ms","value":900000}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.1,"scoreDelta":15},"label":"Member of a current project","priority":100,"ruleKey":"baseline.current-project","when":{"all":[{"operator":"eq","signal":"has_current_project_membership","value":true}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.1,"scoreDelta":10},"label":"Has a current research report","priority":100,"ruleKey":"baseline.current-research-report","when":{"all":[{"operator":"eq","signal":"has_current_research_report","value":true}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.05,"scoreDelta":0},"label":"Has a current summary","priority":100,"ruleKey":"baseline.current-summary","when":{"all":[{"operator":"eq","signal":"has_current_summary","value":true}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.05,"scoreDelta":10},"label":"Pinned in the browser","priority":100,"ruleKey":"baseline.pinned","when":{"all":[{"operator":"eq","signal":"is_pinned","value":true}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.05,"scoreDelta":5},"label":"Has knowledge relations","priority":100,"ruleKey":"baseline.relations","when":{"all":[{"operator":"gte","signal":"relation_count","value":1}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.15,"scoreDelta":25},"label":"Has a shareable next action","priority":100,"ruleKey":"baseline.shareable-next-action","when":{"all":[{"operator":"eq","signal":"has_shareable_next_action","value":true}]}},{"appliesTo":"both","effect":{"confidenceDelta":0.1,"scoreDelta":15},"label":"Has shareable project context","priority":100,"ruleKey":"baseline.shareable-project-context","when":{"all":[{"operator":"eq","signal":"has_shareable_project_context","value":true}]}}],"schemaVersion":1}',
  'Transparent TabHub baseline from goal runbook decision #3.',
  'agent',
  tabhub_migration_now()
);

INSERT INTO priority_ruleset_activations (
  scope, ruleset_id, version, activated_at
) VALUES ('global', 1, 1, tabhub_migration_now());
