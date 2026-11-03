-- Claude Relay Hub schema (relay/1.0, schema_version 1)
-- Engine: SQLite via Node.js built-in node:sqlite (no native module rebuild)
-- Times: TEXT, RFC3339 UTC with milliseconds. JSON columns: TEXT holding JSON.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- One row per machine. Three kinds of columns:
--   meta_*  : admin-managed metadata (editable any time, versioned in node_meta_history)
--   facts / os / arch / profiles / versions : reported by the worker heartbeat (read-only for humans)
--   last_seen / presence* : presence tracking
CREATE TABLE IF NOT EXISTS nodes (
  node_id              TEXT PRIMARY KEY,
  state                TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','draining','disabled','retired')),
  -- admin-managed metadata
  display_name         TEXT NOT NULL,
  description          TEXT,
  roles                TEXT NOT NULL DEFAULT '[]',
  labels               TEXT NOT NULL DEFAULT '{}',
  power                TEXT NOT NULL DEFAULT 'desktop' CHECK (power IN ('server','desktop','laptop')),
  presence_override    TEXT,                       -- JSON presenceSettings or NULL
  owner                TEXT,
  notes                TEXT,
  meta_version         INTEGER NOT NULL DEFAULT 1,
  meta_updated_at      TEXT NOT NULL,
  meta_updated_by      TEXT NOT NULL,
  -- worker-reported facts
  os                   TEXT CHECK (os IN ('windows','macos','linux')),
  arch                 TEXT CHECK (arch IN ('x64','arm64')),
  facts                TEXT NOT NULL DEFAULT '{}',
  profiles             TEXT NOT NULL DEFAULT '[]',
  profiles_error       TEXT,
  max_concurrent       INTEGER NOT NULL DEFAULT 1,
  running              INTEGER NOT NULL DEFAULT 0,
  -- presence
  last_seen            TEXT,
  last_wake_at         TEXT,
  presence             TEXT NOT NULL DEFAULT 'never' CHECK (presence IN ('online','asleep','offline','never')),
  presence_changed_at  TEXT,
  enrolled_via         TEXT,                       -- enrollments.enrollment_id
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_nodes_state ON nodes(state, presence);

-- Full snapshot of meta for every version, so any change can be audited and rolled back.
CREATE TABLE IF NOT EXISTS node_meta_history (
  node_id       TEXT NOT NULL REFERENCES nodes(node_id),
  meta_version  INTEGER NOT NULL,
  meta          TEXT NOT NULL,
  change_note   TEXT,
  changed_by    TEXT NOT NULL,
  changed_at    TEXT NOT NULL,
  PRIMARY KEY (node_id, meta_version)
);

-- One-time join codes. Only the hash is stored.
CREATE TABLE IF NOT EXISTS enrollments (
  enrollment_id  TEXT PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE,
  bound_node_id  TEXT,
  preset         TEXT NOT NULL DEFAULT '{}',
  auto_approve   INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  used_by_node   TEXT,
  revoked_at     TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_id    TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('admin', 'node', 'task')),
  node_id     TEXT,
  task_id     TEXT,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id      TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  title          TEXT,
  task_count     INTEGER NOT NULL DEFAULT 0,
  message_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id             TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL REFERENCES threads(thread_id),
  parent_id           TEXT,
  from_node           TEXT NOT NULL,
  from_agent          TEXT NOT NULL,
  to_node             TEXT,
  to_role             TEXT,
  assigned_node       TEXT,
  profile             TEXT NOT NULL,
  require_os          TEXT,   -- JSON array, e.g. ["linux"]; NULL = any
  require_arch        TEXT,   -- JSON array, e.g. ["arm64"]; NULL = any
  require_labels      TEXT,   -- JSON object, e.g. {"xcode":"16"}; "*" = key must exist; NULL = none
  on_unavailable      TEXT NOT NULL DEFAULT 'queue' CHECK (on_unavailable IN ('confirm','queue','reject')),
  title               TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  state               TEXT NOT NULL CHECK (state IN ('queued','claimed','running','waiting_approval','succeeded','failed','cancelled','expired')),
  envelope            TEXT NOT NULL,
  result              TEXT,
  error_code          TEXT,
  attempt             INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 1,
  lease_id            TEXT,
  lease_expires_at    TEXT,
  cancel_requested    INTEGER NOT NULL DEFAULT 0,
  node_asleep_since   TEXT,   -- set while the assigned node is asleep during a running task
  asleep_ms_total     INTEGER NOT NULL DEFAULT 0,
  hop                 INTEGER NOT NULL DEFAULT 0,
  trace_id            TEXT NOT NULL,
  idempotency_key     TEXT,
  claude_session_id   TEXT,
  last_seq            INTEGER NOT NULL DEFAULT 0,
  timeout_sec         INTEGER NOT NULL DEFAULT 1800,
  expires_at          TEXT,
  created_at          TEXT NOT NULL,
  claimed_at          TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  updated_at          TEXT NOT NULL,
  CHECK (to_node IS NOT NULL OR to_role IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_idem   ON tasks(from_node, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX        IF NOT EXISTS ix_tasks_queue  ON tasks(state, priority, created_at);
CREATE INDEX        IF NOT EXISTS ix_tasks_thread ON tasks(thread_id);
CREATE INDEX        IF NOT EXISTS ix_tasks_lease  ON tasks(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS task_events (
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  seq         INTEGER NOT NULL,
  phase       TEXT NOT NULL,
  message     TEXT,
  data        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id       TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES threads(thread_id),
  kind             TEXT NOT NULL,
  from_node        TEXT NOT NULL,
  from_agent       TEXT NOT NULL,
  to_node          TEXT NOT NULL,
  to_agent         TEXT NOT NULL,
  envelope         TEXT NOT NULL,
  idempotency_key  TEXT,
  read_at          TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_idem ON messages(from_node, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX        IF NOT EXISTS ix_messages_inbox ON messages(to_node, to_agent, read_at, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id    TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  tool_name      TEXT NOT NULL,
  tool_input     TEXT NOT NULL,
  reason         TEXT,
  risk           TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  state          TEXT NOT NULL CHECK (state IN ('pending','allow','deny','expired')),
  decided_by     TEXT,
  note           TEXT,
  updated_input  TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_approvals_state ON approvals(state, created_at);

CREATE TABLE IF NOT EXISTS claude_sessions (
  thread_id          TEXT NOT NULL,
  node_id            TEXT NOT NULL,
  profile            TEXT NOT NULL,
  claude_session_id  TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (thread_id, node_id, profile)
);

CREATE TABLE IF NOT EXISTS blobs (
  sha256          TEXT PRIMARY KEY,
  size            INTEGER NOT NULL,
  mime            TEXT,
  ref_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_access_at  TEXT
);

-- Append-only audit / SSE source. event_seq is the SSE id (Last-Event-ID resume).
-- Presence transitions are stored here as kind 'node.presence' with data {from, to, silent_sec, slept_sec}.
CREATE TABLE IF NOT EXISTS events (
  event_seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  trace_id    TEXT,
  thread_id   TEXT,
  task_id     TEXT,
  node_id     TEXT,
  actor       TEXT,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_trace ON events(trace_id);
CREATE INDEX IF NOT EXISTS ix_events_task  ON events(task_id);
CREATE INDEX IF NOT EXISTS ix_events_node  ON events(node_id, kind, created_at);

INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
