import type { Db } from './db'

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dsl TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    trigger_payload TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX runs_status ON runs(status);
  CREATE TABLE step_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned')),
    input TEXT,
    output TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE (run_id, node_id, attempt)
  );
  CREATE TABLE idempotency_journal (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('intent','done')),
    data TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE step_attempts_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned','skipped','continued')),
    input TEXT,
    output TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE (run_id, node_id, attempt)
  );
  INSERT INTO step_attempts_next
    (id, run_id, node_id, attempt, status, input, output, error, idempotency_key, started_at, finished_at)
    SELECT id, run_id, node_id, attempt, status, input, output, error, idempotency_key, started_at, finished_at
    FROM step_attempts;
  DROP TABLE step_attempts;
  ALTER TABLE step_attempts_next RENAME TO step_attempts;
  `,
  `
  CREATE TABLE trigger_state (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id),
    next_fire_at INTEGER,
    last_fire_at INTEGER
  );
  CREATE TABLE seen_files (
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    fingerprint TEXT NOT NULL,
    path TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    run_id TEXT,
    PRIMARY KEY (workflow_id, fingerprint)
  );
  `,
  `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned','failed','cancelled')),
    effort TEXT NOT NULL,
    model TEXT,
    request_text TEXT NOT NULL,
    attachments TEXT NOT NULL,
    result TEXT,
    meta TEXT,
    error TEXT,
    workflow_hash TEXT,
    flag_keys TEXT NOT NULL DEFAULT '[]',
    workflow_id TEXT REFERENCES workflows(id),
    confirmed TEXT
  );
  CREATE INDEX plans_workflow_hash ON plans(workflow_hash);
  CREATE INDEX plans_created ON plans(created_at);
  `,
  `
  CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    text_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE plans ADD COLUMN memory_ids TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  );
  CREATE UNIQUE INDEX rules_one_effort_cap ON rules(kind) WHERE kind = 'maxPlanEffort';
  `,
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    persona TEXT NOT NULL,
    instructions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ALTER TABLE plans ADD COLUMN agent_id TEXT;
  `,
  `
  CREATE TABLE hooks (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL CHECK (event IN ('run.failed','run.succeeded','plan.deployed')),
    scope_workflow_id TEXT REFERENCES workflows(id),
    action_type TEXT NOT NULL CHECK (action_type IN ('notify','deactivateAfterFailures','record')),
    connection TEXT,
    channel TEXT,
    failure_count INTEGER,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (action_type != 'notify' OR connection IS NOT NULL),
    CHECK (action_type != 'deactivateAfterFailures' OR (event = 'run.failed' AND failure_count BETWEEN 2 AND 20))
  );
  CREATE INDEX hooks_workflow ON hooks(scope_workflow_id);
  CREATE TABLE hook_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('run.failed','run.succeeded','plan.deployed')),
    workflow_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed','skipped_cooldown','rate_limited','blocked_by_rule','skipped_inactive')),
    code TEXT CHECK (code IS NULL OR code IN ('connection','timeout','http_status','slack_error','unknown'))
  );
  `,
]

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
  const current = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1
    if (version <= current) return
    db.transaction(() => {
      db.exec(sql)
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', version)
    })
  })
}
