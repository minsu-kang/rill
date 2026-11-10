import type { Db } from './db'

const MIGRATIONS: string[] = [
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
