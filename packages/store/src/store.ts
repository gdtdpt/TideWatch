/**
 * SQLite 访问层：薄 repo 函数 + 一个 `Store` 聚合类。
 *
 * 刻意不引 ORM：迁移顺序、唯一索引、事务边界都要看得见（docs/02 §4）。
 * 所有 SQL 都在这里；引擎与 API 只调方法。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase } from './db.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Artifact,
  type AuditRow,
  type EndReason,
  type EventRow,
  type Integrity,
  type NotificationRow,
  type Postprocess,
  type RuntimeRow,
  type RuntimeState,
  type Segment,
  type Session,
  type SessionOrigin,
  type Task,
  type TaskKind,
} from './models.ts';

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => num(v) !== 0;
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v.length === 0) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

function toTask(r: Row): Task {
  return {
    id: str(r['id']),
    kind: str(r['kind']) === 'vod' ? 'vod' : 'live',
    url: str(r['url']),
    platform: str(r['platform']),
    streamerName: strOrNull(r['streamer_name']),
    title: strOrNull(r['title']),
    monitorEnabled: bool(r['monitor_enabled']),
    recordRequested: bool(r['record_requested']),
    skipCurrentLive: bool(r['skip_current_live']),
    checkNow: bool(r['check_now']),
    quality: strOrNull(r['quality']),
    qualityOptions: json<string[]>(r['quality_options'], []),
    segmentTimeS: num(r['segment_time_s']) || 1800,
    postprocess: (['merge', 'per_segment', 'manual'] as const).find((p) => p === r['postprocess']) ?? 'merge',
    saveFormat: str(r['save_format']) || 'ts',
    maxSessionS: num(r['max_session_s']),
    maxSessionBytes: num(r['max_session_bytes']),
    scheduled: json<unknown>(r['scheduled'], null),
    override: json<Record<string, unknown>>(r['override'], {}),
    createdAt: str(r['created_at']),
    updatedAt: str(r['updated_at']),
  };
}

function toSession(r: Row): Session {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    startedAt: str(r['started_at']),
    endedAt: strOrNull(r['ended_at']),
    endReason: strOrNull(r['end_reason']) as EndReason | null,
    state: str(r['state']),
    outputDir: str(r['output_dir']),
    origin: str(r['origin']) === 'cap' ? 'cap' : 'new',
  };
}

function toSegment(r: Row): Segment {
  return {
    id: str(r['id']),
    sessionId: str(r['session_id']),
    path: str(r['path']),
    partNo: num(r['part_no']),
    startedAt: str(r['started_at']),
    durationS: num(r['duration_s']),
    sizeBytes: num(r['size_bytes']),
    videoCodec: strOrNull(r['video_codec']),
    videoProfile: strOrNull(r['video_profile']),
    width: numOrNull(r['width']),
    height: numOrNull(r['height']),
    pixFmt: strOrNull(r['pix_fmt']),
    audioCodec: strOrNull(r['audio_codec']),
    sampleRate: numOrNull(r['sample_rate']),
    channels: numOrNull(r['channels']),
    layoutHash: strOrNull(r['layout_hash']),
    integrity: (str(r['integrity']) || 'ok') as Integrity,
    errorClass: strOrNull(r['error_class']),
  };
}

function toNotification(r: Row): NotificationRow {
  return {
    id: num(r['id']),
    ts: str(r['ts']),
    kind: str(r['kind']),
    level: str(r['level']),
    title: str(r['title']),
    body: str(r['body']),
    taskId: strOrNull(r['task_id']),
    sessionId: strOrNull(r['session_id']),
    readAt: strOrNull(r['read_at']),
  };
}

function toEvent(r: Row): EventRow {
  return {
    id: num(r['id']),
    ts: str(r['ts']),
    taskId: strOrNull(r['task_id']),
    sessionId: strOrNull(r['session_id']),
    kind: str(r['kind']),
    payload: json<Record<string, unknown>>(r['payload'], {}),
  };
}

export interface AddTaskInput {
  url: string;
  kind?: TaskKind;
  platform?: string;
  streamerName?: string | null;
  title?: string | null;
  quality?: string | null;
  segmentTimeS?: number;
  postprocess?: Postprocess;
  monitorEnabled?: boolean;
  maxSessionS?: number;
  maxSessionBytes?: number;
}

export interface TaskPatch {
  monitorEnabled?: boolean;
  recordRequested?: boolean;
  skipCurrentLive?: boolean;
  checkNow?: boolean;
  quality?: string | null;
  qualityOptions?: string[];
  segmentTimeS?: number;
  postprocess?: Postprocess;
  maxSessionS?: number;
  maxSessionBytes?: number;
  platform?: string;
  streamerName?: string | null;
  title?: string | null;
}

export interface CreateSessionInput {
  id?: string;
  taskId: string;
  startedAt: string;
  outputDir: string;
  origin: SessionOrigin;
}

export interface SegmentInput {
  sessionId: string;
  path: string;
  partNo: number;
  startedAt: string;
  durationS: number;
  sizeBytes: number;
  integrity: Integrity;
  errorClass?: string | null;
  video?: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    pixFmt: string | null;
    layoutHash: string | null;
  } | null;
  audio?: { codec: string | null; sampleRate: number | null; channels: number | null } | null;
}

export interface EventInput {
  kind: string;
  payload?: Record<string, unknown>;
  taskId?: string | null;
  sessionId?: string | null;
}

export interface NotificationInput {
  kind: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  taskId?: string | null;
  sessionId?: string | null;
}

const SETTINGS_JSON_KEYS: Record<keyof AppSettings, string> = {
  pollIntervalS: 'poll_interval_s',
  segmentTimeS: 'segment_time_s',
  defaultQuality: 'default_quality',
  defaultPostprocess: 'default_postprocess',
  faststart: 'faststart',
  faststartThresholdMb: 'faststart_threshold_mb',
  cleanupIntermediate: 'cleanup_intermediate',
  notify: 'notify',
  outputDir: 'output_dir',
};

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.db = openDatabase(file, opts);
    if (!opts.readOnly) migrate(this.db, MIGRATIONS);
  }

  static open(file: string): Store {
    return new Store(file);
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  listTasks(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as Row[]).map(toTask);
  }

  listRunnableTasks(): Task[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE monitor_enabled = 1 OR record_requested = 1 ORDER BY created_at ASC')
        .all() as Row[]
    ).map(toTask);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  getTaskByUrl(url: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE url = ?').get(url) as Row | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  addTask(input: AddTaskInput): Task {
    const now = new Date().toISOString();
    const settings = this.getSettings();
    const id = randomUUID().replace(/-/g, '');
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, kind, url, platform, title, streamer_name, monitor_enabled,
            quality, segment_time_s, postprocess, max_session_s, max_session_bytes,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind ?? 'live',
        input.url,
        input.platform ?? '',
        input.title ?? null,
        input.streamerName ?? null,
        input.monitorEnabled === true ? 1 : 0,
        input.quality ?? (settings.defaultQuality || null),
        input.segmentTimeS ?? settings.segmentTimeS,
        input.postprocess ?? settings.defaultPostprocess,
        input.maxSessionS ?? 0,
        input.maxSessionBytes ?? 0,
        now,
        now,
      );
    const created = this.getTask(id);
    if (created === undefined) throw new Error('插入任务后读不到该行');
    return created;
  }

  patchTask(id: string, patch: TaskPatch): Task {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (col: string, value: string | number | null): void => {
      sets.push(`${col} = ?`);
      values.push(value);
    };
    if (patch.monitorEnabled !== undefined) push('monitor_enabled', patch.monitorEnabled ? 1 : 0);
    if (patch.recordRequested !== undefined) push('record_requested', patch.recordRequested ? 1 : 0);
    if (patch.skipCurrentLive !== undefined) push('skip_current_live', patch.skipCurrentLive ? 1 : 0);
    if (patch.checkNow !== undefined) push('check_now', patch.checkNow ? 1 : 0);
    if (patch.quality !== undefined) push('quality', patch.quality);
    if (patch.qualityOptions !== undefined) push('quality_options', JSON.stringify(patch.qualityOptions));
    if (patch.segmentTimeS !== undefined) push('segment_time_s', patch.segmentTimeS);
    if (patch.postprocess !== undefined) push('postprocess', patch.postprocess);
    if (patch.maxSessionS !== undefined) push('max_session_s', patch.maxSessionS);
    if (patch.maxSessionBytes !== undefined) push('max_session_bytes', patch.maxSessionBytes);
    if (patch.platform !== undefined) push('platform', patch.platform);
    if (patch.streamerName !== undefined) push('streamer_name', patch.streamerName);
    if (patch.title !== undefined) push('title', patch.title);
    push('updated_at', new Date().toISOString());
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const updated = this.getTask(id);
    if (updated === undefined) throw new Error(`任务不存在：${id}`);
    return updated;
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  setMonitor(id: string, enabled: boolean): Task {
    return this.patchTask(id, { monitorEnabled: enabled, checkNow: enabled });
  }

  /** 消费即清零；返回"这次确实有待办" */
  takeCheckNow(id: string): boolean {
    const row = this.db.prepare('SELECT check_now FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (row === undefined || !bool(row['check_now'])) return false;
    this.db.prepare('UPDATE tasks SET check_now = 0 WHERE id = ?').run(id);
    return true;
  }

  clearCheckNow(id: string): void {
    this.db.prepare('UPDATE tasks SET check_now = 0 WHERE id = ?').run(id);
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput): string {
    const id = input.id ?? randomUUID().replace(/-/g, '');
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, started_at, ended_at, end_reason, state, output_dir, origin)
         VALUES (?, ?, ?, NULL, NULL, 'recording', ?, ?)`,
      )
      .run(id, input.taskId, input.startedAt, input.outputDir, input.origin);
    return id;
  }

  endSession(id: string, reason: EndReason, endedAt = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, state = ? WHERE id = ?')
      .run(endedAt, reason, 'ended', id);
  }

  setSessionState(id: string, state: string): void {
    this.db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, id);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  listSessions(opts: { taskId?: string; limit?: number; offset?: number } = {}): Session[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows =
      opts.taskId === undefined
        ? (this.db
            .prepare('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?')
            .all(limit, offset) as Row[])
        : (this.db
            .prepare(
              'SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?',
            )
            .all(opts.taskId, limit, offset) as Row[]);
    return rows.map(toSession);
  }

  listOpenSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all() as Row[]).map(toSession);
  }

  listRecentSessionsForTask(taskId: string, limit = 20): Session[] {
    return this.listSessions({ taskId, limit });
  }

  // ── segments ─────────────────────────────────────────────────────────────

  insertSegment(input: SegmentInput): Segment {
    const id = randomUUID().replace(/-/g, '');
    const v = input.video ?? null;
    const a = input.audio ?? null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO segments
           (id, session_id, path, part_no, started_at, duration_s, size_bytes,
            video_codec, video_profile, width, height, pix_fmt,
            audio_codec, sample_rate, channels, layout_hash, integrity, error_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.path,
        input.partNo,
        input.startedAt,
        input.durationS,
        input.sizeBytes,
        v?.codec ?? null,
        v?.profile ?? null,
        v?.width ?? null,
        v?.height ?? null,
        v?.pixFmt ?? null,
        a?.codec ?? null,
        a?.sampleRate ?? null,
        a?.channels ?? null,
        v?.layoutHash ?? null,
        input.integrity,
        input.errorClass ?? null,
      );
    const row = this.db.prepare('SELECT * FROM segments WHERE path = ?').get(input.path) as Row | undefined;
    if (row === undefined) throw new Error('插入分段后读不到该行');
    return toSegment(row);
  }

  listSegments(sessionId: string): Segment[] {
    return (
      this.db
        .prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY part_no ASC')
        .all(sessionId) as Row[]
    ).map(toSegment);
  }

  getSegmentByPath(path: string): Segment | undefined {
    const row = this.db.prepare('SELECT * FROM segments WHERE path = ?').get(path) as Row | undefined;
    return row === undefined ? undefined : toSegment(row);
  }

  setSegmentIntegrity(id: string, integrity: Integrity, errorClass?: string | null): void {
    this.db
      .prepare('UPDATE segments SET integrity = ?, error_class = COALESCE(?, error_class) WHERE id = ?')
      .run(integrity, errorClass ?? null, id);
  }

  sumSegmentBytes(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM segments WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return num(row?.['total']);
  }

  sumSegmentDuration(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(duration_s), 0) AS total FROM segments WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return num(row?.['total']);
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  upsertArtifact(a: Artifact): void {
    // 产物身份 = (session_id, path)：先删同键再插，避免重复 merge 攒出重复行
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM artifacts WHERE session_id = ? AND path = ?').run(a.sessionId, a.path);
      this.db
        .prepare(
          `INSERT INTO artifacts (session_id, path, kind, duration_s, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(a.sessionId, a.path, a.kind, a.durationS, a.sizeBytes, a.createdAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listArtifacts(sessionId: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as Row[]
    ).map((r) => ({
      sessionId: str(r['session_id']),
      path: str(r['path']),
      kind: str(r['kind']) === 'per_segment' ? 'per_segment' : 'merged',
      durationS: num(r['duration_s']),
      sizeBytes: num(r['size_bytes']),
      createdAt: str(r['created_at']),
    }));
  }

  // ── events ───────────────────────────────────────────────────────────────

  insertEvent(input: EventInput): number {
    const info = this.db
      .prepare('INSERT INTO events (ts, task_id, session_id, kind, payload) VALUES (?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        input.taskId ?? null,
        input.sessionId ?? null,
        input.kind,
        JSON.stringify(input.payload ?? {}),
      );
    return Number(info.lastInsertRowid);
  }

  listEvents(opts: { since?: number; limit?: number } = {}): EventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows =
      opts.since === undefined
        ? (this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
            .all(opts.since, limit) as Row[]);
    return rows.map(toEvent);
  }

  // ── runtime projection ───────────────────────────────────────────────────

  setRuntime(taskId: string, state: RuntimeState, detail: string | null): void {
    this.db
      .prepare(
        `INSERT INTO task_runtime (task_id, state, detail, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET state = excluded.state,
           detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .run(taskId, state, detail, new Date().toISOString());
  }

  getRuntime(taskId: string): RuntimeRow | undefined {
    const row = this.db.prepare('SELECT * FROM task_runtime WHERE task_id = ?').get(taskId) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      taskId: str(row['task_id']),
      state: str(row['state']) as RuntimeState,
      detail: strOrNull(row['detail']),
      updatedAt: str(row['updated_at']),
    };
  }

  listRuntime(): RuntimeRow[] {
    return (this.db.prepare('SELECT * FROM task_runtime').all() as Row[]).map((r) => ({
      taskId: str(r['task_id']),
      state: str(r['state']) as RuntimeState,
      detail: strOrNull(r['detail']),
      updatedAt: str(r['updated_at']),
    }));
  }

  // ── notifications ────────────────────────────────────────────────────────

  insertNotification(input: NotificationInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO notifications (ts, kind, level, title, body, task_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.kind,
        input.level,
        input.title,
        input.body,
        input.taskId ?? null,
        input.sessionId ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  listNotifications(opts: { limit?: number; offset?: number } = {}): NotificationRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    return (
      this.db
        .prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as Row[]
    ).map(toNotification);
  }

  unreadNotificationCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')
      .get() as Row | undefined;
    return num(row?.['n']);
  }

  markNotificationsRead(ids: number[]): void {
    const now = new Date().toISOString();
    if (ids.length === 0) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now);
      return;
    }
    const stmt = this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  pruneNotifications(max = 500): void {
    this.db
      .prepare(
        `DELETE FROM notifications WHERE id NOT IN
           (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)`,
      )
      .run(max);
  }

  // ── settings ─────────────────────────────────────────────────────────────

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[];
    const raw = new Map<string, unknown>();
    for (const r of rows) raw.set(str(r['key']), json<unknown>(r['value'], null));
    const pick = <K extends keyof AppSettings>(key: K): AppSettings[K] => {
      const value = raw.get(SETTINGS_JSON_KEYS[key]);
      return (value === null || value === undefined ? DEFAULT_SETTINGS[key] : value) as AppSettings[K];
    };
    return {
      pollIntervalS: Math.min(Math.max(Number(pick('pollIntervalS')) || 30, 5), 3600),
      segmentTimeS: Math.min(Math.max(Number(pick('segmentTimeS')) || 1800, 30), 43_200),
      defaultQuality: String(pick('defaultQuality') ?? ''),
      defaultPostprocess: (['merge', 'per_segment', 'manual'] as const).find(
        (p) => p === pick('defaultPostprocess'),
      ) ?? 'merge',
      faststart: (['auto', 'on', 'off'] as const).find((f) => f === pick('faststart')) ?? 'auto',
      faststartThresholdMb: Math.max(Number(pick('faststartThresholdMb')) || 512, 1),
      cleanupIntermediate: Boolean(pick('cleanupIntermediate')),
      notify: (pick('notify') ?? {}) as Record<string, unknown>,
      outputDir: String(pick('outputDir') ?? ''),
    };
  }

  putSettings(patch: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const mapped = SETTINGS_JSON_KEYS[key as keyof AppSettings];
      if (mapped === undefined) continue;
      stmt.run(mapped, JSON.stringify(value));
    }
    return this.getSettings();
  }

  /** 非强类型的元信息（cookie 清单、通知配置等），键名以 `meta.` 开头 */
  getMeta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row === undefined ? fallback : json<T>(row['value'], fallback);
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  // ── audit ────────────────────────────────────────────────────────────────

  insertAudit(input: {
    actor?: string;
    action: string;
    target?: string | null;
    detail?: unknown;
    result?: string;
    durationMs?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, actor, action, target, detail, result, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.actor ?? 'api',
        input.action,
        input.target ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        input.result ?? 'ok',
        input.durationMs ?? null,
      );
  }

  listAudit(limit = 100): AuditRow[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(
      (r) => ({
        id: num(r['id']),
        ts: str(r['ts']),
        actor: str(r['actor']),
        action: str(r['action']),
        target: strOrNull(r['target']),
        detail: json<unknown>(r['detail'], null),
        result: str(r['result']),
        durationMs: numOrNull(r['duration_ms']),
      }),
    );
  }

  // ── diagnostics ──────────────────────────────────────────────────────────

  stats(): {
    tasks: number;
    sessions: number;
    segments: number;
    artifacts: number;
    events: number;
    notifications: number;
    byIntegrity: Record<string, number>;
    byEndReason: Record<string, number>;
  } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as Row | undefined;
      return num(row?.['n']);
    };
    const group = (sql: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of this.db.prepare(sql).all() as Row[]) out[str(r['k'])] = num(r['n']);
      return out;
    };
    return {
      tasks: count('SELECT COUNT(*) AS n FROM tasks'),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      segments: count('SELECT COUNT(*) AS n FROM segments'),
      artifacts: count('SELECT COUNT(*) AS n FROM artifacts'),
      events: count('SELECT COUNT(*) AS n FROM events'),
      notifications: count('SELECT COUNT(*) AS n FROM notifications'),
      byIntegrity: group('SELECT integrity AS k, COUNT(*) AS n FROM segments GROUP BY integrity'),
      // SQLite 里双引号是标识符，字符串字面量必须用单引号（这里曾因此 500）
      byEndReason: group("SELECT COALESCE(end_reason, 'open') AS k, COUNT(*) AS n FROM sessions GROUP BY end_reason"),
    };
  }
}
