const version = 1;
const description = 'initial durable supervisor queue schema';

const sql = `
CREATE TABLE IF NOT EXISTS supervisor_tasks (
  task_id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'blocked', 'canceled')),
  owner_pane TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  worker_pid INTEGER,
  context_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result_payload_json TEXT,
  error_payload_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_heartbeat_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_status_priority
  ON supervisor_tasks(status, priority DESC, created_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_lease
  ON supervisor_tasks(status, lease_expires_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_supervisor_tasks_owner
  ON supervisor_tasks(owner_pane, status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS supervisor_task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES supervisor_tasks(task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_supervisor_task_events_task
  ON supervisor_task_events(task_id, created_at_ms ASC);
`;

function up(db) {
  db.exec(sql);
}

module.exports = {
  version,
  description,
  sql,
  up,
};
