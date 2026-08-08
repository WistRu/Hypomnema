CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'summary'),
  tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('user', 'agent')),
  depth TEXT NOT NULL CHECK (depth IN ('short', 'deep')),
  requested_model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 1 CHECK (prompt_version > 0),
  source_content_revision INTEGER NOT NULL CHECK (source_content_revision > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  result_summary TEXT,
  result_model TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0)
);

CREATE TABLE summary_job_attempts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed')),
  model TEXT,
  request_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  error TEXT,
  UNIQUE (job_id, attempt_no)
);

ALTER TABLE contents
ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE contents
ADD COLUMN summary_job_id INTEGER REFERENCES jobs(id);

ALTER TABLE contents
ADD COLUMN summary_generated_at TEXT;

CREATE UNIQUE INDEX jobs_one_active_summary_per_tab_idx
ON jobs (tab_id)
WHERE kind = 'summary' AND status IN ('queued', 'running');

CREATE INDEX jobs_claim_idx
ON jobs (kind, status, available_at, id);

CREATE INDEX jobs_created_at_idx
ON jobs (kind, created_at);

CREATE INDEX summary_job_attempts_started_idx
ON summary_job_attempts (started_at, id);
