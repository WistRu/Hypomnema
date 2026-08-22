CREATE TABLE resources (
  id INTEGER PRIMARY KEY,
  resource_key TEXT NOT NULL UNIQUE CHECK (length(trim(resource_key)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE TABLE resource_events (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('website', 'platform', 'collection')),
  access_class TEXT NOT NULL CHECK (
    access_class IN ('public', 'authenticated', 'sensitive')
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('active', 'merged')
  ),
  merged_into_resource_id INTEGER REFERENCES resources(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK (created_by IN ('system', 'user', 'agent')),
  creation_method TEXT NOT NULL CHECK (
    creation_method IN ('manual', 'on_behalf_of_user', 'derived')
  ),
  supersedes_id INTEGER,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (created_by = 'user' AND creation_method = 'manual')
    OR (created_by = 'agent' AND creation_method = 'on_behalf_of_user')
    OR (created_by = 'system' AND creation_method = 'derived')
  ),
  CHECK (
    (lifecycle_state = 'active' AND merged_into_resource_id IS NULL)
    OR (
      lifecycle_state = 'merged'
      AND merged_into_resource_id IS NOT NULL
      AND merged_into_resource_id <> resource_id
    )
  ),
  UNIQUE (resource_id, version),
  UNIQUE (id, resource_id),
  FOREIGN KEY (supersedes_id, resource_id)
    REFERENCES resource_events(id, resource_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX resource_events_superseded_once_idx
ON resource_events (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE TABLE resource_heads (
  resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (event_id, resource_id)
    REFERENCES resource_events(id, resource_id) ON DELETE RESTRICT
);

CREATE TABLE resource_match_rules (
  id INTEGER PRIMARY KEY,
  rule_key TEXT NOT NULL CHECK (length(trim(rule_key)) > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  host_pattern TEXT NOT NULL CHECK (
    length(trim(host_pattern)) > 0 AND host_pattern = lower(host_pattern)
  ),
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact_host', 'suffix_host')),
  path_prefix TEXT NOT NULL DEFAULT '/' CHECK (
    length(path_prefix) > 0 AND substr(path_prefix, 1, 1) = '/'
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  provenance_class TEXT NOT NULL CHECK (
    provenance_class IN ('user_alias', 'agent_alias', 'system_seed')
  ),
  created_by TEXT NOT NULL CHECK (created_by IN ('system', 'user', 'agent')),
  creation_method TEXT NOT NULL CHECK (
    creation_method IN ('manual', 'on_behalf_of_user', 'derived')
  ),
  supersedes_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (provenance_class = 'user_alias'
      AND created_by = 'user' AND creation_method = 'manual')
    OR (provenance_class = 'agent_alias'
      AND created_by = 'agent' AND creation_method = 'on_behalf_of_user')
    OR (provenance_class = 'system_seed'
      AND created_by = 'system' AND creation_method = 'derived')
  ),
  UNIQUE (rule_key, version),
  UNIQUE (id, rule_key),
  UNIQUE (id, resource_id),
  FOREIGN KEY (supersedes_id, rule_key)
    REFERENCES resource_match_rules(id, rule_key) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX resource_match_rules_superseded_once_idx
ON resource_match_rules (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE INDEX resource_match_rules_candidate_idx
ON resource_match_rules (host_pattern, path_prefix, provenance_class, priority);

CREATE TABLE resource_match_rule_heads (
  rule_key TEXT PRIMARY KEY,
  rule_id INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (rule_id, rule_key)
    REFERENCES resource_match_rules(id, rule_key) ON DELETE RESTRICT
);

CREATE TABLE resource_ruleset_events (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK (version > 0),
  supersedes_id INTEGER UNIQUE REFERENCES resource_ruleset_events(id)
    ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK (created_by IN ('system', 'user', 'agent')),
  creation_method TEXT NOT NULL CHECK (
    creation_method IN ('manual', 'on_behalf_of_user', 'derived')
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (created_by = 'user' AND creation_method = 'manual')
    OR (created_by = 'agent' AND creation_method = 'on_behalf_of_user')
    OR (created_by = 'system' AND creation_method = 'derived')
  )
);

CREATE TABLE resource_ruleset_heads (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  ruleset_event_id INTEGER NOT NULL UNIQUE
    REFERENCES resource_ruleset_events(id) ON DELETE RESTRICT
);

CREATE TABLE logical_page_resource_assignments (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'removed')),
  resource_id INTEGER REFERENCES resources(id) ON DELETE RESTRICT,
  provenance_class TEXT NOT NULL CHECK (
    provenance_class IN (
      'user_manual', 'agent_on_behalf', 'explicit_alias',
      'system_seed', 'registrable_domain'
    )
  ),
  assigned_by TEXT NOT NULL CHECK (assigned_by IN ('system', 'user', 'agent')),
  assignment_method TEXT NOT NULL CHECK (
    assignment_method IN ('manual', 'on_behalf_of_user', 'rule', 'derived')
  ),
  rule_id INTEGER,
  confidence REAL CHECK (
    confidence IS NULL
    OR (typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0 AND 1)
  ),
  source_fingerprint TEXT NOT NULL CHECK (
    length(trim(source_fingerprint)) > 0
  ),
  supersedes_id INTEGER,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (action = 'assigned' AND resource_id IS NOT NULL)
    OR (action = 'removed' AND resource_id IS NULL AND rule_id IS NULL)
  ),
  CHECK (
    (provenance_class = 'user_manual'
      AND assigned_by = 'user' AND assignment_method = 'manual'
      AND rule_id IS NULL)
    OR (provenance_class = 'agent_on_behalf'
      AND assigned_by = 'agent' AND assignment_method = 'on_behalf_of_user'
      AND rule_id IS NULL)
    OR (provenance_class = 'explicit_alias'
      AND assigned_by = 'system' AND assignment_method = 'rule'
      AND rule_id IS NOT NULL)
    OR (provenance_class = 'system_seed'
      AND assigned_by = 'system' AND assignment_method = 'rule'
      AND rule_id IS NOT NULL)
    OR (provenance_class = 'registrable_domain'
      AND assigned_by = 'system' AND assignment_method = 'derived'
      AND rule_id IS NULL)
  ),
  UNIQUE (id, logical_page_id),
  UNIQUE (id, resource_id),
  FOREIGN KEY (supersedes_id, logical_page_id)
    REFERENCES logical_page_resource_assignments(id, logical_page_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (rule_id, resource_id)
    REFERENCES resource_match_rules(id, resource_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX logical_page_resource_assignments_superseded_once_idx
ON logical_page_resource_assignments (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE INDEX logical_page_resource_assignments_history_idx
ON logical_page_resource_assignments (logical_page_id, created_at DESC, id DESC);

CREATE TABLE logical_page_resource_heads (
  logical_page_id INTEGER PRIMARY KEY
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (assignment_id, logical_page_id)
    REFERENCES logical_page_resource_assignments(id, logical_page_id)
      ON DELETE RESTRICT
);

CREATE TABLE resource_resolution_events (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (
    state IN ('matched', 'overridden', 'unmatched', 'ambiguous', 'excluded')
  ),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'user_manual', 'agent_on_behalf', 'explicit_alias', 'system_seed',
      'registrable_domain', 'authoritative_tie', 'weak_sensitive_signal',
      'registrable_domain_unavailable', 'invalid_url', 'browser_internal',
      'extension', 'file', 'data', 'unsupported_scheme',
      'embedded_credentials', 'localhost', 'private_ip', 'private_hostname'
    )
  ),
  resource_id INTEGER REFERENCES resources(id) ON DELETE RESTRICT,
  assignment_id INTEGER,
  candidate_resource_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    CASE
      WHEN json_valid(candidate_resource_ids_json)
      THEN json_type(candidate_resource_ids_json) = 'array'
      ELSE 0
    END
  ),
  source_fingerprint TEXT NOT NULL CHECK (
    length(trim(source_fingerprint)) > 0
  ),
  research_eligible INTEGER NOT NULL CHECK (research_eligible IN (0, 1)),
  research_exclusion_reason TEXT CHECK (
    research_exclusion_reason IS NULL OR research_exclusion_reason IN (
      'browser_internal', 'extension', 'file', 'data', 'unsupported_scheme',
      'embedded_credentials', 'localhost', 'private_ip', 'private_hostname',
      'weak_sensitive_signal', 'registrable_domain_unavailable', 'invalid_url',
      'authenticated_access', 'sensitive_access', 'authoritative_tie'
    )
  ),
  supersedes_id INTEGER,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (state IN ('matched', 'overridden')
      AND resource_id IS NOT NULL AND assignment_id IS NOT NULL)
    OR (state NOT IN ('matched', 'overridden')
      AND resource_id IS NULL AND assignment_id IS NULL)
  ),
  CHECK (state IN ('matched', 'overridden') OR research_eligible = 0),
  CHECK (
    (research_eligible = 1 AND research_exclusion_reason IS NULL)
    OR (research_eligible = 0 AND research_exclusion_reason IS NOT NULL)
  ),
  UNIQUE (id, logical_page_id),
  FOREIGN KEY (assignment_id, logical_page_id)
    REFERENCES logical_page_resource_assignments(id, logical_page_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id, resource_id)
    REFERENCES logical_page_resource_assignments(id, resource_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_id, logical_page_id)
    REFERENCES resource_resolution_events(id, logical_page_id)
      ON DELETE RESTRICT
);

CREATE UNIQUE INDEX resource_resolution_events_superseded_once_idx
ON resource_resolution_events (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE INDEX resource_resolution_review_idx
ON resource_resolution_events (state, created_at, logical_page_id);

CREATE TABLE resource_resolution_heads (
  logical_page_id INTEGER PRIMARY KEY
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  resolution_event_id INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (resolution_event_id, logical_page_id)
    REFERENCES resource_resolution_events(id, logical_page_id)
      ON DELETE RESTRICT
);

CREATE TABLE resource_preferences (
  resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  user_evaluation INTEGER CHECK (user_evaluation BETWEEN 1 AND 3),
  recorded_by TEXT CHECK (recorded_by IN ('user', 'agent')),
  record_method TEXT CHECK (
    record_method IN ('manual', 'on_behalf_of_user')
  ),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  CHECK (
    (user_evaluation IS NULL AND recorded_by IS NULL AND record_method IS NULL)
    OR (user_evaluation IS NOT NULL
      AND recorded_by = 'user' AND record_method = 'manual')
    OR (user_evaluation IS NOT NULL
      AND recorded_by = 'agent' AND record_method = 'on_behalf_of_user')
  )
);

CREATE TABLE resource_context_entries (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'purpose', 'interest', 'question', 'project', 'next_action',
      'disposition', 'note'
    )
  ),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  method TEXT NOT NULL CHECK (
    method IN ('manual', 'on_behalf_of_user', 'rule', 'model', 'derived')
  ),
  visibility TEXT NOT NULL CHECK (
    visibility IN ('local_only', 'share_with_ai')
  ),
  confidence REAL CHECK (
    confidence IS NULL
    OR (typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0 AND 1)
  ),
  source_fingerprint TEXT CHECK (
    source_fingerprint IS NULL OR length(trim(source_fingerprint)) > 0
  ),
  model_provenance_json TEXT CHECK (
    model_provenance_json IS NULL
    OR CASE
      WHEN json_valid(model_provenance_json)
      THEN json_type(model_provenance_json) = 'object'
      ELSE 0
    END
  ),
  stale_at TEXT,
  supersedes_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
  operation TEXT NOT NULL CHECK (operation IN ('append', 'withdraw', 'restore')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) > 0
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  withdrawn_at TEXT,
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (actor = 'user' AND method = 'manual' AND confidence IS NULL
      AND source_fingerprint IS NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'on_behalf_of_user'
      AND confidence IS NULL AND source_fingerprint IS NULL
      AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'rule'
      AND source_fingerprint IS NOT NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'model'
      AND source_fingerprint IS NOT NULL AND model_provenance_json IS NOT NULL)
    OR (actor = 'system' AND method = 'derived'
      AND source_fingerprint IS NOT NULL AND model_provenance_json IS NULL)
  ),
  CHECK (
    method <> 'model'
    OR CASE WHEN (
      json_valid(model_provenance_json)
      AND json_type(model_provenance_json) = 'object'
      AND json_type(model_provenance_json, '$.provider') = 'text'
      AND length(trim(json_extract(model_provenance_json, '$.provider'))) > 0
      AND json_type(model_provenance_json, '$.name') = 'text'
      AND length(trim(json_extract(model_provenance_json, '$.name'))) > 0
      AND json_type(model_provenance_json, '$.promptVersion') = 'text'
      AND length(trim(json_extract(model_provenance_json, '$.promptVersion'))) > 0
      AND json_remove(
        model_provenance_json, '$.provider', '$.name', '$.promptVersion'
      ) = '{}'
    ) THEN 1 ELSE 0 END
  ),
  CHECK (
    (operation = 'append' AND state = 'active' AND withdrawn_at IS NULL)
    OR (operation = 'withdraw' AND state = 'withdrawn'
      AND supersedes_id IS NOT NULL AND withdrawn_at IS NOT NULL)
    OR (operation = 'restore' AND state = 'active'
      AND supersedes_id IS NOT NULL AND withdrawn_at IS NULL)
  ),
  UNIQUE (resource_id, revision),
  UNIQUE (id, resource_id),
  FOREIGN KEY (supersedes_id, resource_id)
    REFERENCES resource_context_entries(id, resource_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX resource_context_entries_superseded_once_idx
ON resource_context_entries (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE TABLE resource_context_entry_reviews (
  id INTEGER PRIMARY KEY,
  context_entry_id INTEGER NOT NULL
    REFERENCES resource_context_entries(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
  reviewed_by TEXT NOT NULL CHECK (reviewed_by IN ('user', 'agent')),
  review_method TEXT NOT NULL CHECK (
    review_method IN ('manual', 'on_behalf_of_user')
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) > 0
  ),
  supersedes_id INTEGER,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (
    (reviewed_by = 'user' AND review_method = 'manual')
    OR (reviewed_by = 'agent' AND review_method = 'on_behalf_of_user')
  ),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  UNIQUE (id, context_entry_id),
  FOREIGN KEY (supersedes_id, context_entry_id)
    REFERENCES resource_context_entry_reviews(id, context_entry_id)
      ON DELETE RESTRICT
);

CREATE UNIQUE INDEX resource_context_reviews_superseded_once_idx
ON resource_context_entry_reviews (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE TABLE resource_command_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  command_kind TEXT NOT NULL CHECK (
    command_kind IN (
      'create', 'set_aliases', 'apply_override', 'merge', 'split', 'rename',
      'set_user_evaluation'
    )
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(trim(request_fingerprint)) > 0
  ),
  result_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(result_json)
      THEN json_type(result_json) = 'object' ELSE 0 END
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE VIRTUAL TABLE resource_context_entries_fts USING fts5(
  body,
  content = 'resource_context_entries',
  content_rowid = 'id'
);

CREATE VIRTUAL TABLE shareable_resource_context_entries_fts USING fts5(
  body,
  content = 'resource_context_entries',
  content_rowid = 'id'
);

CREATE TRIGGER resource_context_entries_fts_insert
AFTER INSERT ON resource_context_entries
BEGIN
  INSERT INTO resource_context_entries_fts(rowid, body) VALUES (NEW.id, NEW.body);
  INSERT INTO shareable_resource_context_entries_fts(rowid, body)
  SELECT NEW.id, NEW.body WHERE NEW.visibility = 'share_with_ai';
END;

CREATE TRIGGER resource_context_entries_fts_delete
AFTER DELETE ON resource_context_entries
BEGIN
  INSERT INTO resource_context_entries_fts(resource_context_entries_fts, rowid, body)
  VALUES ('delete', OLD.id, OLD.body);
  INSERT INTO shareable_resource_context_entries_fts(
    shareable_resource_context_entries_fts, rowid, body
  )
  SELECT 'delete', OLD.id, OLD.body WHERE OLD.visibility = 'share_with_ai';
END;

CREATE TRIGGER resources_identity_immutable
BEFORE UPDATE ON resources
BEGIN
  SELECT RAISE(ABORT, 'resource identity is append-only');
END;

CREATE TRIGGER resources_delete_immutable
BEFORE DELETE ON resources
BEGIN
  SELECT RAISE(ABORT, 'resource identity is append-only');
END;

CREATE TRIGGER resource_events_update_immutable
BEFORE UPDATE ON resource_events
BEGIN
  SELECT RAISE(ABORT, 'resource event history is append-only');
END;

CREATE TRIGGER resource_events_delete_immutable
BEFORE DELETE ON resource_events
BEGIN
  SELECT RAISE(ABORT, 'resource event history is append-only');
END;

CREATE TRIGGER resource_rules_update_immutable
BEFORE UPDATE ON resource_match_rules
BEGIN
  SELECT RAISE(ABORT, 'resource rule history is append-only');
END;

CREATE TRIGGER resource_rules_delete_immutable
BEFORE DELETE ON resource_match_rules
BEGIN
  SELECT RAISE(ABORT, 'resource rule history is append-only');
END;

CREATE TRIGGER resource_ruleset_events_update_immutable
BEFORE UPDATE ON resource_ruleset_events
BEGIN
  SELECT RAISE(ABORT, 'resource ruleset history is append-only');
END;

CREATE TRIGGER resource_ruleset_events_delete_immutable
BEFORE DELETE ON resource_ruleset_events
BEGIN
  SELECT RAISE(ABORT, 'resource ruleset history is append-only');
END;

CREATE TRIGGER resource_events_successor_invariant
BEFORE INSERT ON resource_events
WHEN NOT (
  (NEW.version = 1 AND NEW.supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM resource_events WHERE resource_id = NEW.resource_id
  ))
  OR
  (NEW.version > 1 AND NEW.supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM resource_events AS previous
    JOIN resource_heads AS heads
      ON heads.resource_id = previous.resource_id
      AND heads.event_id = previous.id
    WHERE previous.id = NEW.supersedes_id
      AND previous.resource_id = NEW.resource_id
      AND previous.version = NEW.version - 1
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'resource event must succeed the current version');
END;

CREATE TRIGGER resource_heads_successor_invariant
BEFORE UPDATE OF event_id ON resource_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM resource_events
  WHERE resource_events.id = NEW.event_id
    AND resource_events.resource_id = NEW.resource_id
    AND resource_events.supersedes_id = OLD.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource head must advance to a direct successor');
END;

CREATE TRIGGER resource_rules_successor_invariant
BEFORE INSERT ON resource_match_rules
WHEN NOT (
  (NEW.version = 1 AND NEW.supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM resource_match_rules WHERE rule_key = NEW.rule_key
  ))
  OR
  (NEW.version > 1 AND NEW.supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM resource_match_rules AS previous
    JOIN resource_match_rule_heads AS heads
      ON heads.rule_key = previous.rule_key
      AND heads.rule_id = previous.id
    WHERE previous.id = NEW.supersedes_id
      AND previous.rule_key = NEW.rule_key
      AND previous.version = NEW.version - 1
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'resource rule must succeed the current version');
END;

CREATE TRIGGER resource_rule_heads_successor_invariant
BEFORE UPDATE OF rule_id ON resource_match_rule_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM resource_match_rules
  WHERE resource_match_rules.id = NEW.rule_id
    AND resource_match_rules.rule_key = NEW.rule_key
    AND resource_match_rules.supersedes_id = OLD.rule_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource rule head must advance to a direct successor');
END;

CREATE TRIGGER resource_ruleset_successor_invariant
BEFORE INSERT ON resource_ruleset_events
WHEN NOT (
  (NEW.version = 1 AND NEW.supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM resource_ruleset_events
  ))
  OR
  (NEW.version > 1 AND NEW.supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM resource_ruleset_events AS previous
    JOIN resource_ruleset_heads AS heads
      ON heads.scope = 'global'
      AND heads.ruleset_event_id = previous.id
    WHERE previous.id = NEW.supersedes_id
      AND previous.version = NEW.version - 1
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'resource ruleset must succeed the current version');
END;

CREATE TRIGGER resource_ruleset_heads_successor_invariant
BEFORE UPDATE OF ruleset_event_id ON resource_ruleset_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM resource_ruleset_events
  WHERE resource_ruleset_events.id = NEW.ruleset_event_id
    AND resource_ruleset_events.supersedes_id = OLD.ruleset_event_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource ruleset head must advance to a direct successor');
END;

CREATE TRIGGER resource_assignments_successor_invariant
BEFORE INSERT ON logical_page_resource_assignments
WHEN NOT (
  (NEW.supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM logical_page_resource_heads
    WHERE logical_page_id = NEW.logical_page_id
  ))
  OR
  (NEW.supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM logical_page_resource_heads
    WHERE logical_page_id = NEW.logical_page_id
      AND assignment_id = NEW.supersedes_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment must succeed the current head');
END;

CREATE TRIGGER resource_assignment_heads_successor_invariant
BEFORE UPDATE OF assignment_id ON logical_page_resource_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM logical_page_resource_assignments
  WHERE logical_page_resource_assignments.id = NEW.assignment_id
    AND logical_page_resource_assignments.logical_page_id = NEW.logical_page_id
    AND logical_page_resource_assignments.supersedes_id = OLD.assignment_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment head must advance to a direct successor');
END;

CREATE TRIGGER resource_resolutions_successor_invariant
BEFORE INSERT ON resource_resolution_events
WHEN NOT (
  (NEW.supersedes_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM resource_resolution_heads
    WHERE logical_page_id = NEW.logical_page_id
  ))
  OR
  (NEW.supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM resource_resolution_heads
    WHERE logical_page_id = NEW.logical_page_id
      AND resolution_event_id = NEW.supersedes_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution must succeed the current head');
END;

CREATE TRIGGER resource_resolution_heads_successor_invariant
BEFORE UPDATE OF resolution_event_id ON resource_resolution_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM resource_resolution_events
  WHERE resource_resolution_events.id = NEW.resolution_event_id
    AND resource_resolution_events.logical_page_id = NEW.logical_page_id
    AND resource_resolution_events.supersedes_id = OLD.resolution_event_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution head must advance to a direct successor');
END;

CREATE TRIGGER resource_assignments_update_immutable
BEFORE UPDATE ON logical_page_resource_assignments
BEGIN
  SELECT RAISE(ABORT, 'resource assignment history is append-only');
END;

CREATE TRIGGER resource_assignments_delete_immutable
BEFORE DELETE ON logical_page_resource_assignments
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment history is append-only');
END;

CREATE TRIGGER resource_resolutions_update_immutable
BEFORE UPDATE ON resource_resolution_events
BEGIN
  SELECT RAISE(ABORT, 'resource resolution history is append-only');
END;

CREATE TRIGGER resource_resolutions_delete_immutable
BEFORE DELETE ON resource_resolution_events
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution history is append-only');
END;

CREATE TRIGGER resource_heads_delete_guard
BEFORE DELETE ON resource_heads
BEGIN
  SELECT RAISE(ABORT, 'resource head cannot be deleted');
END;

CREATE TRIGGER resource_rule_heads_delete_guard
BEFORE DELETE ON resource_match_rule_heads
BEGIN
  SELECT RAISE(ABORT, 'resource rule head cannot be deleted');
END;

CREATE TRIGGER resource_ruleset_heads_delete_guard
BEFORE DELETE ON resource_ruleset_heads
BEGIN
  SELECT RAISE(ABORT, 'resource ruleset head cannot be deleted');
END;

CREATE TRIGGER resource_assignment_heads_delete_guard
BEFORE DELETE ON logical_page_resource_heads
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource assignment head cannot be deleted');
END;

CREATE TRIGGER resource_resolution_heads_delete_guard
BEFORE DELETE ON resource_resolution_heads
WHEN EXISTS (
  SELECT 1 FROM logical_pages WHERE id = OLD.logical_page_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource resolution head cannot be deleted');
END;

CREATE TRIGGER resource_command_receipts_update_immutable
BEFORE UPDATE ON resource_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'resource command receipts are append-only');
END;

CREATE TRIGGER resource_command_receipts_delete_immutable
BEFORE DELETE ON resource_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'resource command receipts are append-only');
END;

CREATE TRIGGER resource_context_entries_update_immutable
BEFORE UPDATE ON resource_context_entries
BEGIN
  SELECT RAISE(ABORT, 'resource context history is append-only');
END;

CREATE TRIGGER resource_context_reviews_update_immutable
BEFORE UPDATE ON resource_context_entry_reviews
BEGIN
  SELECT RAISE(ABORT, 'resource context review history is append-only');
END;

CREATE TRIGGER resource_context_reviews_agent_only
BEFORE INSERT ON resource_context_entry_reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM resource_context_entries
  WHERE resource_context_entries.id = NEW.context_entry_id
    AND resource_context_entries.actor = 'agent'
)
BEGIN
  SELECT RAISE(ABORT, 'only agent resource context can be reviewed');
END;

INSERT INTO resources (resource_key, created_at)
VALUES ('platform:youtube', '1970-01-01T00:00:00.000Z');

INSERT INTO resource_events (
  resource_id, version, name, kind, access_class, lifecycle_state,
  created_by, creation_method, created_at
)
SELECT
  id, 1, 'YouTube', 'platform', 'public', 'active',
  'system', 'derived', '1970-01-01T00:00:00.000Z'
FROM resources
WHERE resource_key = 'platform:youtube';

INSERT INTO resource_heads (resource_id, event_id)
SELECT resources.id, resource_events.id
FROM resources
JOIN resource_events ON resource_events.resource_id = resources.id
WHERE resources.resource_key = 'platform:youtube' AND resource_events.version = 1;

INSERT INTO resource_preferences (resource_id, updated_at)
SELECT id, '1970-01-01T00:00:00.000Z'
FROM resources
WHERE resource_key = 'platform:youtube';

INSERT INTO resource_match_rules (
  rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
  priority, provenance_class, created_by, creation_method, created_at
)
SELECT
  'seed:youtube:youtube.com', 1, id, 'youtube.com', 'suffix_host', '/',
  100, 'system_seed', 'system', 'derived', '1970-01-01T00:00:00.000Z'
FROM resources
WHERE resource_key = 'platform:youtube';

INSERT INTO resource_match_rules (
  rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
  priority, provenance_class, created_by, creation_method, created_at
)
SELECT
  'seed:youtube:youtu.be', 1, id, 'youtu.be', 'suffix_host', '/',
  100, 'system_seed', 'system', 'derived', '1970-01-01T00:00:00.000Z'
FROM resources
WHERE resource_key = 'platform:youtube';

INSERT INTO resource_match_rule_heads (rule_key, rule_id)
SELECT rule_key, id
FROM resource_match_rules
WHERE rule_key IN ('seed:youtube:youtube.com', 'seed:youtube:youtu.be');

INSERT INTO resource_ruleset_events (
  version, created_by, creation_method, created_at
) VALUES (1, 'system', 'derived', '1970-01-01T00:00:00.000Z');

INSERT INTO resource_ruleset_heads (scope, ruleset_event_id)
SELECT 'global', id FROM resource_ruleset_events WHERE version = 1;
