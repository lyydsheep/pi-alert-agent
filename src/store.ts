import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null;

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        owner_ids TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_version INTEGER NOT NULL DEFAULT 0,
        wait_stage TEXT,
        wait_until INTEGER,
        run_id TEXT,
        run_fence INTEGER NOT NULL DEFAULT 0,
        run_deadline INTEGER,
        resume_status TEXT,
        no_progress INTEGER NOT NULL DEFAULT 0,
        branch TEXT,
        mr_url TEXT,
        mr_state TEXT,
        head_sha TEXT,
        conclusion TEXT,
        block_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(source, event_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        notified_at INTEGER,
        reminder_sent_at INTEGER,
        notification_message_id TEXT,
        reminder_message_id TEXT,
        PRIMARY KEY(task_id, version)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        plan_version INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        command TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(acknowledged_at, id);
      CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks(status, created_at);
    `);
  }

  run(sql: string, ...values: SqlValue[]) {
    return this.db.prepare(sql).run(...values);
  }

  get<T>(sql: string, ...values: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }

  all<T>(sql: string, ...values: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }

  transaction<T>(fn: () => T): T {
    const level=this.depth;
    const savepoint=`nested_${level}`;
    this.db.exec(level?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec(level?`RELEASE ${savepoint}`:'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(level?`ROLLBACK TO ${savepoint}`:'ROLLBACK');
      if(level)this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {this.depth--;}
  }

  close(): void {
    this.db.close();
  }
}
