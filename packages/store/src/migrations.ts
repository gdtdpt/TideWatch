/**
 * schema 迁移序列（目标版本 v12，与 tide-cap-master 的行为资产对齐）。
 *
 * ⚠️ 迁移的**顺序**是正确性的一部分：
 * - v4 必须"先按 (session_id, path) 去重，再建唯一索引"，反了会让老库打不开；
 * - 所有 ALTER 都带 `NOT NULL DEFAULT`，老库等价于"这件事没发生过"，不需要回填。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './db.ts';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init-tasks',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE tasks (
          id                TEXT PRIMARY KEY,
          kind              TEXT NOT NULL DEFAULT 'live',
          url               TEXT NOT NULL,
          platform          TEXT NOT NULL DEFAULT '',
          title             TEXT,
          monitor_enabled   INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX idx_tasks_url ON tasks(url);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: 'init-sessions',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          started_at   TEXT NOT NULL,
          ended_at     TEXT,
          end_reason   TEXT,
          state        TEXT NOT NULL DEFAULT 'recording',
          output_dir   TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_sessions_task ON sessions(task_id, started_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'segments-artifacts',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE segments (
          id             TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          path           TEXT NOT NULL,
          part_no        INTEGER NOT NULL,
          started_at     TEXT NOT NULL,
          duration_s     REAL NOT NULL DEFAULT 0,
          size_bytes     INTEGER NOT NULL DEFAULT 0,
          video_codec    TEXT,
          video_profile  TEXT,
          width          INTEGER,
          height         INTEGER,
          pix_fmt        TEXT,
          audio_codec    TEXT,
          sample_rate    INTEGER,
          channels       INTEGER,
          layout_hash    TEXT,
          integrity      TEXT NOT NULL DEFAULT 'ok',
          error_class    TEXT
        ) STRICT;
        CREATE INDEX idx_segments_session ON segments(session_id, part_no);
        CREATE UNIQUE INDEX uq_segments_session_path ON segments(session_id, path);

        CREATE TABLE artifacts (
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          path        TEXT NOT NULL,
          kind        TEXT NOT NULL DEFAULT 'merged',
          duration_s  REAL NOT NULL DEFAULT 0,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 4,
    name: 'artifacts-unique',
    up(db: DatabaseSync) {
      // 顺序不可颠倒：先去重（同键保留最近一次写入），再建唯一索引
      db.exec(`
        DELETE FROM artifacts
         WHERE rowid NOT IN (SELECT MAX(rowid) FROM artifacts GROUP BY session_id, path);
        CREATE UNIQUE INDEX uq_artifacts_session_path ON artifacts(session_id, path);
      `);
    },
  },
  {
    version: 5,
    name: 'audit-log',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE audit_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          TEXT NOT NULL,
          actor       TEXT NOT NULL DEFAULT 'api',
          action      TEXT NOT NULL,
          target      TEXT,
          detail      TEXT,
          result      TEXT NOT NULL DEFAULT 'ok',
          duration_ms INTEGER
        ) STRICT;
        CREATE INDEX idx_audit_ts ON audit_log(ts);
      `);
    },
  },
  {
    version: 6,
    name: 'task-config',
    up(db: DatabaseSync) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN streamer_name TEXT;
        ALTER TABLE tasks ADD COLUMN quality TEXT;
        ALTER TABLE tasks ADD COLUMN quality_options TEXT;
        ALTER TABLE tasks ADD COLUMN segment_time_s INTEGER NOT NULL DEFAULT 1800;
        ALTER TABLE tasks ADD COLUMN postprocess TEXT NOT NULL DEFAULT 'merge';
        ALTER TABLE tasks ADD COLUMN save_format TEXT NOT NULL DEFAULT 'ts';
        ALTER TABLE tasks ADD COLUMN scheduled TEXT;
        ALTER TABLE tasks ADD COLUMN override TEXT;
      `);
    },
  },
  {
    version: 7,
    name: 'notifications',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE notifications (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT NOT NULL,
          kind       TEXT NOT NULL,
          level      TEXT NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT NOT NULL,
          task_id    TEXT,
          session_id TEXT,
          read_at    TEXT
        ) STRICT;
        CREATE INDEX idx_notifications_read ON notifications(read_at);
        CREATE INDEX idx_notifications_dedupe ON notifications(kind, task_id, ts);
      `);
    },
  },
  {
    version: 8,
    name: 'control-flags',
    up(db: DatabaseSync) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN record_requested INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN skip_current_live INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 9,
    name: 'check-now',
    up(db: DatabaseSync) {
      // 布尔而非计数：连续两次"立即检查"与一次等价
      db.exec(`ALTER TABLE tasks ADD COLUMN check_now INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    version: 10,
    name: 'events-runtime',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT NOT NULL,
          task_id    TEXT,
          session_id TEXT,
          kind       TEXT NOT NULL,
          payload    TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX idx_events_ts ON events(ts);

        CREATE TABLE task_runtime (
          task_id    TEXT PRIMARY KEY,
          state      TEXT NOT NULL DEFAULT 'idle',
          detail     TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 11,
    name: 'session-caps',
    up(db: DatabaseSync) {
      // 0 = 未设置 → 引擎按 6h / 20GiB 生效（docs/09 §5）
      db.exec(`
        ALTER TABLE tasks ADD COLUMN max_session_s INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN max_session_bytes INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 12,
    name: 'session-origin',
    up(db: DatabaseSync) {
      // 老行 = new（保守方向：谎称连续会让用户把两段无关录像拼起来）
      db.exec(`ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'new';`);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
