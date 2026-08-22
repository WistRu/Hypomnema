ALTER TABLE tab_instances
ADD COLUMN navigation_revision INTEGER NOT NULL DEFAULT 1 CHECK (
  navigation_revision > 0
);

CREATE TABLE context_entries (
  id INTEGER PRIMARY KEY,
  logical_page_id INTEGER NOT NULL
    REFERENCES logical_pages(id) ON DELETE CASCADE,
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
  stale_at TEXT CHECK (stale_at IS NULL OR length(trim(stale_at)) > 0),
  supersedes_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
  operation TEXT NOT NULL CHECK (operation IN ('append', 'withdraw', 'restore')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) > 0
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  withdrawn_at TEXT CHECK (
    withdrawn_at IS NULL OR length(trim(withdrawn_at)) > 0
  ),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (
    (actor = 'user' AND method = 'manual' AND confidence IS NULL
      AND source_fingerprint IS NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'on_behalf_of_user' AND confidence IS NULL
      AND source_fingerprint IS NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'rule' AND source_fingerprint IS NOT NULL
      AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'model' AND source_fingerprint IS NOT NULL
      AND model_provenance_json IS NOT NULL)
    OR (actor = 'system' AND method = 'derived' AND source_fingerprint IS NOT NULL
      AND model_provenance_json IS NULL)
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
  UNIQUE (logical_page_id, revision),
  UNIQUE (id, logical_page_id),
  FOREIGN KEY (supersedes_id, logical_page_id)
    REFERENCES context_entries(id, logical_page_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX context_entries_superseded_once_idx
ON context_entries (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE INDEX context_entries_page_revision_idx
ON context_entries (logical_page_id, revision DESC, id DESC);

CREATE INDEX context_entries_current_lookup_idx
ON context_entries (logical_page_id, state, kind, actor, revision DESC);

CREATE TRIGGER context_entries_append_only
BEFORE UPDATE ON context_entries
BEGIN
  SELECT RAISE(ABORT, 'context entry history is append-only');
END;

CREATE TABLE context_entry_reviews (
  id INTEGER PRIMARY KEY,
  context_entry_id INTEGER NOT NULL
    REFERENCES context_entries(id) ON DELETE CASCADE,
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
    REFERENCES context_entry_reviews(id, context_entry_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX context_entry_reviews_superseded_once_idx
ON context_entry_reviews (supersedes_id)
WHERE supersedes_id IS NOT NULL;

CREATE INDEX context_entry_reviews_current_lookup_idx
ON context_entry_reviews (context_entry_id, created_at DESC, id DESC);

CREATE TRIGGER context_entry_reviews_agent_only
BEFORE INSERT ON context_entry_reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM context_entries
  WHERE context_entries.id = NEW.context_entry_id
    AND context_entries.actor = 'agent'
)
BEGIN
  SELECT RAISE(ABORT, 'only agent context can be reviewed');
END;

CREATE TRIGGER context_entry_reviews_append_only
BEFORE UPDATE ON context_entry_reviews
BEGIN
  SELECT RAISE(ABORT, 'context review history is append-only');
END;

CREATE TABLE tab_session_intents (
  id INTEGER PRIMARY KEY,
  installation_id TEXT NOT NULL CHECK (length(trim(installation_id)) > 0),
  browser_session_id TEXT NOT NULL CHECK (length(trim(browser_session_id)) > 0),
  browser_tab_id INTEGER NOT NULL CHECK (browser_tab_id >= 0),
  logical_page_id INTEGER NOT NULL
    REFERENCES logical_pages(id) ON DELETE CASCADE,
  expected_url TEXT NOT NULL CHECK (length(trim(expected_url)) > 0),
  expected_url_normalized TEXT NOT NULL CHECK (
    length(trim(expected_url_normalized)) > 0
  ),
  expected_instance_revision INTEGER NOT NULL CHECK (
    expected_instance_revision > 0
  ),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  method TEXT NOT NULL CHECK (
    method IN ('manual', 'on_behalf_of_user', 'model')
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
  stale_at TEXT CHECK (stale_at IS NULL OR length(trim(stale_at)) > 0),
  state TEXT NOT NULL CHECK (
    state IN ('active', 'archived', 'promoted', 'expired')
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) > 0
  ),
  archive_idempotency_key TEXT UNIQUE CHECK (
    archive_idempotency_key IS NULL
    OR length(trim(archive_idempotency_key)) > 0
  ),
  archive_cause TEXT CHECK (
    archive_cause IS NULL OR archive_cause IN ('explicit', 'navigation', 'replacement')
  ),
  replacement_idempotency_key TEXT CHECK (
    replacement_idempotency_key IS NULL
    OR length(trim(replacement_idempotency_key)) > 0
  ),
  promote_idempotency_key TEXT UNIQUE CHECK (
    promote_idempotency_key IS NULL
    OR length(trim(promote_idempotency_key)) > 0
  ),
  archived_at TEXT CHECK (
    archived_at IS NULL OR length(trim(archived_at)) > 0
  ),
  expires_at TEXT CHECK (expires_at IS NULL OR length(trim(expires_at)) > 0),
  promoted_context_entry_id INTEGER,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  CHECK (
    replacement_idempotency_key IS NULL
    OR replacement_idempotency_key <> idempotency_key
  ),
  CHECK (
    (actor = 'user' AND method = 'manual' AND confidence IS NULL
      AND source_fingerprint IS NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'on_behalf_of_user' AND confidence IS NULL
      AND source_fingerprint IS NULL AND model_provenance_json IS NULL)
    OR (actor = 'agent' AND method = 'model' AND source_fingerprint IS NOT NULL
      AND model_provenance_json IS NOT NULL)
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
    (state = 'active' AND archived_at IS NULL AND expires_at IS NULL
      AND promoted_context_entry_id IS NULL
      AND archive_idempotency_key IS NULL AND archive_cause IS NULL
      AND replacement_idempotency_key IS NULL
      AND promote_idempotency_key IS NULL)
    OR (state = 'archived' AND archived_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > archived_at AND promoted_context_entry_id IS NULL
      AND archive_idempotency_key IS NOT NULL AND archive_cause IS NOT NULL
      AND ((archive_cause = 'replacement' AND replacement_idempotency_key IS NOT NULL)
        OR (archive_cause IN ('explicit', 'navigation')
          AND replacement_idempotency_key IS NULL))
      AND promote_idempotency_key IS NULL)
    OR (state = 'expired' AND archived_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > archived_at AND promoted_context_entry_id IS NULL
      AND archive_idempotency_key IS NOT NULL AND archive_cause IS NOT NULL
      AND ((archive_cause = 'replacement' AND replacement_idempotency_key IS NOT NULL)
        OR (archive_cause IN ('explicit', 'navigation')
          AND replacement_idempotency_key IS NULL))
      AND promote_idempotency_key IS NULL)
    OR (state = 'promoted' AND promoted_context_entry_id IS NOT NULL
      AND promote_idempotency_key IS NOT NULL
      AND replacement_idempotency_key IS NULL
      AND ((archived_at IS NULL AND expires_at IS NULL)
        OR (archived_at IS NOT NULL AND expires_at IS NOT NULL
          AND expires_at > archived_at)))
  ),
  FOREIGN KEY (promoted_context_entry_id, logical_page_id)
    REFERENCES context_entries(id, logical_page_id) ON DELETE RESTRICT,
  UNIQUE (
    idempotency_key, installation_id, browser_session_id, browser_tab_id
  ),
  FOREIGN KEY (
    replacement_idempotency_key, installation_id,
    browser_session_id, browser_tab_id
  ) REFERENCES tab_session_intents(
    idempotency_key, installation_id, browser_session_id, browser_tab_id
  )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX tab_session_active_intent_idx
ON tab_session_intents (installation_id, browser_session_id, browser_tab_id)
WHERE state = 'active';

CREATE INDEX tab_session_intent_scope_history_idx
ON tab_session_intents (
  installation_id, browser_session_id, browser_tab_id, created_at DESC, id DESC
);

CREATE INDEX tab_session_intent_page_state_idx
ON tab_session_intents (logical_page_id, state, updated_at DESC, id DESC);

CREATE TRIGGER tab_session_intent_subject_insert
BEFORE INSERT ON tab_session_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM logical_pages
  WHERE logical_pages.id = NEW.logical_page_id
    AND logical_pages.identity_key = NEW.expected_url_normalized
)
BEGIN
  SELECT RAISE(ABORT, 'session intent expected page does not match subject');
END;

CREATE TRIGGER tab_session_intent_archive_expiry_immutable
BEFORE UPDATE OF archived_at, expires_at, archive_idempotency_key,
  archive_cause, replacement_idempotency_key ON tab_session_intents
WHEN OLD.archived_at IS NOT NULL
  AND (
    NEW.archived_at IS NOT OLD.archived_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.archive_idempotency_key IS NOT OLD.archive_idempotency_key
    OR NEW.archive_cause IS NOT OLD.archive_cause
    OR NEW.replacement_idempotency_key IS NOT OLD.replacement_idempotency_key
  )
  AND NOT (
    OLD.state = 'archived' AND NEW.state = 'promoted'
    AND NEW.archived_at IS OLD.archived_at
    AND NEW.expires_at IS OLD.expires_at
    AND NEW.archive_idempotency_key IS OLD.archive_idempotency_key
    AND NEW.archive_cause IS OLD.archive_cause
    AND OLD.replacement_idempotency_key IS NOT NULL
    AND NEW.replacement_idempotency_key IS NULL
  )
  AND NOT (
    OLD.state IN ('archived', 'expired')
    AND OLD.archive_cause = 'replacement'
    AND OLD.visibility = 'share_with_ai'
    AND OLD.replacement_idempotency_key IS NOT NULL
    AND NEW.state = 'active'
    AND NEW.archived_at IS NULL AND NEW.expires_at IS NULL
    AND NEW.archive_idempotency_key IS NULL AND NEW.archive_cause IS NULL
    AND NEW.replacement_idempotency_key IS NULL
    AND NEW.promoted_context_entry_id IS NULL
    AND NEW.promote_idempotency_key IS NULL
    AND NEW.updated_at = OLD.created_at
    AND EXISTS (
      SELECT 1
      FROM tab_session_intents AS replacement
      WHERE replacement.idempotency_key = OLD.replacement_idempotency_key
        AND replacement.visibility = 'local_only'
        AND replacement.state = 'expired'
        AND replacement.archive_cause = 'explicit'
        AND replacement.installation_id = OLD.installation_id
        AND replacement.browser_session_id = OLD.browser_session_id
        AND replacement.browser_tab_id = OLD.browser_tab_id
    )
  )
  AND NOT (
    OLD.state IN ('archived', 'expired')
    AND OLD.archive_cause = 'replacement'
    AND OLD.replacement_idempotency_key IS NOT NULL
    AND NEW.state IS OLD.state
    AND NEW.archived_at IS OLD.archived_at
    AND NEW.expires_at IS OLD.expires_at
    AND NEW.archive_idempotency_key IS OLD.archive_idempotency_key
    AND NEW.archive_cause IS OLD.archive_cause
    AND NEW.updated_at IS OLD.updated_at
    AND NEW.replacement_idempotency_key IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM tab_session_intents AS replacement
      WHERE replacement.idempotency_key = OLD.replacement_idempotency_key
        AND replacement.installation_id = OLD.installation_id
        AND replacement.browser_session_id = OLD.browser_session_id
        AND replacement.browser_tab_id = OLD.browser_tab_id
        AND replacement.state = 'expired'
        AND replacement.archive_cause = 'replacement'
        AND replacement.replacement_idempotency_key =
          NEW.replacement_idempotency_key
        AND EXISTS (
          SELECT 1
          FROM tab_session_intents AS target
          WHERE target.idempotency_key = NEW.replacement_idempotency_key
            AND target.installation_id = OLD.installation_id
            AND target.browser_session_id = OLD.browser_session_id
            AND target.browser_tab_id = OLD.browser_tab_id
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'archived intent expiry is immutable');
END;

CREATE TRIGGER tab_session_intent_replacement_cycle_insert
BEFORE INSERT ON tab_session_intents
WHEN NEW.replacement_idempotency_key IS NOT NULL
  AND EXISTS (
    WITH RECURSIVE replacement_chain(key) AS (
      SELECT NEW.replacement_idempotency_key
      UNION
      SELECT intents.replacement_idempotency_key
      FROM tab_session_intents AS intents
      JOIN replacement_chain ON intents.idempotency_key = replacement_chain.key
      WHERE intents.replacement_idempotency_key IS NOT NULL
    )
    SELECT 1
    FROM replacement_chain
    WHERE key = NEW.idempotency_key
  )
BEGIN
  SELECT RAISE(ABORT, 'session intent replacement cycle');
END;

CREATE TRIGGER tab_session_intent_replacement_cycle_update
BEFORE UPDATE OF replacement_idempotency_key ON tab_session_intents
WHEN NEW.replacement_idempotency_key IS NOT NULL
  AND EXISTS (
    WITH RECURSIVE replacement_chain(key) AS (
      SELECT NEW.replacement_idempotency_key
      UNION
      SELECT intents.replacement_idempotency_key
      FROM tab_session_intents AS intents
      JOIN replacement_chain ON intents.idempotency_key = replacement_chain.key
      WHERE intents.replacement_idempotency_key IS NOT NULL
    )
    SELECT 1
    FROM replacement_chain
    WHERE key = OLD.idempotency_key
  )
BEGIN
  SELECT RAISE(ABORT, 'session intent replacement cycle');
END;

CREATE VIRTUAL TABLE context_entries_fts USING fts5(
  body,
  content = 'context_entries',
  content_rowid = 'id'
);

CREATE TRIGGER context_entries_fts_insert
AFTER INSERT ON context_entries
BEGIN
  INSERT INTO context_entries_fts(rowid, body) VALUES (NEW.id, NEW.body);
END;

CREATE TRIGGER context_entries_fts_delete
AFTER DELETE ON context_entries
BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, body)
  VALUES ('delete', OLD.id, OLD.body);
END;

CREATE TRIGGER context_entries_fts_update
AFTER UPDATE OF body ON context_entries
BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, body)
  VALUES ('delete', OLD.id, OLD.body);
  INSERT INTO context_entries_fts(rowid, body) VALUES (NEW.id, NEW.body);
END;

CREATE VIRTUAL TABLE shareable_context_entries_fts USING fts5(
  body,
  content = 'context_entries',
  content_rowid = 'id'
);

CREATE TRIGGER shareable_context_entries_fts_insert
AFTER INSERT ON context_entries
WHEN NEW.visibility = 'share_with_ai'
BEGIN
  INSERT INTO shareable_context_entries_fts(rowid, body)
  VALUES (NEW.id, NEW.body);
END;

CREATE TRIGGER shareable_context_entries_fts_delete
AFTER DELETE ON context_entries
WHEN OLD.visibility = 'share_with_ai'
BEGIN
  INSERT INTO shareable_context_entries_fts(
    shareable_context_entries_fts, rowid, body
  ) VALUES ('delete', OLD.id, OLD.body);
END;

CREATE TABLE local_installation_capabilities (
  installation_id TEXT PRIMARY KEY CHECK (length(trim(installation_id)) > 0),
  extension_origin TEXT NOT NULL CHECK (
    substr(extension_origin, 1, 19) = 'chrome-extension://'
    AND length(extension_origin) > 19
    AND substr(extension_origin, 20) NOT GLOB '*[^a-z0-9_-]*'
    AND extension_origin = lower(extension_origin)
  ),
  credential_hash BLOB CHECK (
    credential_hash IS NULL
    OR (typeof(credential_hash) = 'blob' AND length(credential_hash) = 32)
  ),
  credential_version INTEGER NOT NULL DEFAULT 0 CHECK (
    credential_version >= 0
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  rotated_at TEXT CHECK (rotated_at IS NULL OR length(trim(rotated_at)) > 0),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(trim(revoked_at)) > 0),
  last_used_at TEXT CHECK (
    last_used_at IS NULL OR length(trim(last_used_at)) > 0
  ),
  UNIQUE (installation_id, extension_origin),
  CHECK (
    (credential_version = 0 AND credential_hash IS NULL
      AND rotated_at IS NULL AND revoked_at IS NULL AND last_used_at IS NULL)
    OR (credential_version > 0 AND credential_hash IS NOT NULL)
  )
);

CREATE TABLE local_pairing_challenges (
  challenge_id TEXT PRIMARY KEY CHECK (length(trim(challenge_id)) > 0),
  installation_id TEXT NOT NULL,
  extension_origin TEXT NOT NULL,
  code_salt BLOB NOT NULL CHECK (
    typeof(code_salt) = 'blob' AND length(code_salt) = 32
  ),
  code_hash BLOB NOT NULL CHECK (
    typeof(code_hash) = 'blob' AND length(code_hash) = 32
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  expires_at TEXT NOT NULL CHECK (
    length(trim(expires_at)) > 0 AND expires_at > created_at
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR (
      length(trim(consumed_at)) > 0
      AND consumed_at >= created_at AND consumed_at <= expires_at
    )
  ),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    failed_attempts BETWEEN 0 AND 5
  ),
  CHECK (
    substr(extension_origin, 1, 19) = 'chrome-extension://'
    AND length(extension_origin) > 19
    AND substr(extension_origin, 20) NOT GLOB '*[^a-z0-9_-]*'
    AND extension_origin = lower(extension_origin)
  ),
  FOREIGN KEY (installation_id, extension_origin)
  REFERENCES local_installation_capabilities(
    installation_id, extension_origin
  ) ON DELETE CASCADE
);

CREATE UNIQUE INDEX local_capability_credential_hash_idx
ON local_installation_capabilities (credential_hash)
WHERE credential_hash IS NOT NULL;

CREATE INDEX local_pairing_challenges_expiry_idx
ON local_pairing_challenges (expires_at, consumed_at);

CREATE UNIQUE INDEX local_pairing_challenges_one_live_idx
ON local_pairing_challenges (installation_id)
WHERE consumed_at IS NULL AND failed_attempts < 5;

CREATE TRIGGER local_capability_identity_immutable
BEFORE UPDATE OF installation_id, extension_origin, created_at
ON local_installation_capabilities
BEGIN
  SELECT RAISE(ABORT, 'local capability identity is immutable');
END;

CREATE TRIGGER local_pairing_secret_immutable
BEFORE UPDATE OF challenge_id, installation_id, extension_origin,
  code_salt, code_hash, created_at, expires_at
ON local_pairing_challenges
BEGIN
  SELECT RAISE(ABORT, 'local pairing challenge is immutable');
END;
