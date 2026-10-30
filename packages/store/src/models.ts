/**
 * 领域模型（store 是叶子：只有 SQLite，不认识 HTTP / 引擎 / 平台）。
 *
 * 类型放在这里的理由：`core` 依赖 `store`（docs/00 §2 的依赖方向），
 * 反过来 store 不认识 core。于是"一份类型"只能落在 store 侧，
 * 引擎与 API 都按结构消费它，不会出现两套字段名。
 */

export type TaskKind = 'live' | 'vod';
export type Postprocess = 'merge' | 'per_segment' | 'manual';
export type Faststart = 'auto' | 'on' | 'off';

/** 会话结束原因：`capped` 是"录满单场上限"，不是下播（docs/09 §2） */
export type EndReason =
  | 'offline'
  | 'manual'
  | 'error'
  | 'disk'
  | 'degraded'
  | 'capped'
  | 'interrupted'
  | 'shutdown';

/** `capped` 之后立刻重开的那一场带 `cap`，其余都算 `new`（docs/09 §6.2） */
export type SessionOrigin = 'new' | 'cap';

/** 分段完整性（docs/03 §7）：`recovered` = 崩溃后就地抢救登记 */
export type Integrity = 'ok' | 'partial' | 'truncated' | 'recovered' | 'cleaned' | 'orphan';

/** 运行态投影（task_runtime 表）：UI 只读这个，不碰事件流 */
export type RuntimeState =
  | 'idle'
  | 'resolving'
  | 'waiting'
  | 'recording'
  | 'snoozed'
  | 'reconnecting'
  | 'finalizing'
  | 'error'
  | 'needs_auth'
  | 'needs_dep'
  | 'unsupported';

export interface Task {
  id: string;
  kind: TaskKind;
  url: string;
  /** 上次解析回填的平台 key（首次为空） */
  platform: string;
  streamerName: string | null;
  title: string | null;
  /** 自动档：开播自动录 */
  monitorEnabled: boolean;
  /** 手动的"这一场"，一次性；会话收尾后清除 */
  recordRequested: boolean;
  /** 本场跳过（监控仍开，只挡开新会话） */
  skipCurrentLive: boolean;
  /** 「下一轮立刻解析」的一次性请求（不参与 runner 判定） */
  checkNow: boolean;
  quality: string | null;
  qualityOptions: string[];
  segmentTimeS: number;
  postprocess: Postprocess;
  saveFormat: string;
  maxSessionS: number;
  maxSessionBytes: number;
  scheduled: unknown;
  override: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: EndReason | null;
  state: string;
  outputDir: string;
  origin: SessionOrigin;
}

export interface Segment {
  id: string;
  sessionId: string;
  path: string;
  partNo: number;
  startedAt: string;
  durationS: number;
  sizeBytes: number;
  videoCodec: string | null;
  videoProfile: string | null;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  layoutHash: string | null;
  integrity: Integrity;
  errorClass: string | null;
}

export interface Artifact {
  sessionId: string;
  path: string;
  kind: 'merged' | 'per_segment';
  durationS: number;
  sizeBytes: number;
  createdAt: string;
}

export interface EventRow {
  id: number;
  ts: string;
  taskId: string | null;
  sessionId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface NotificationRow {
  id: number;
  ts: string;
  kind: string;
  level: string;
  title: string;
  body: string;
  taskId: string | null;
  sessionId: string | null;
  readAt: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  result: string;
  durationMs: number | null;
}

export interface RuntimeRow {
  taskId: string;
  state: RuntimeState;
  detail: string | null;
  updatedAt: string;
}

/** 全局设置（`settings` 表逐键存 JSON，这里给出强类型视图） */
export interface AppSettings {
  pollIntervalS: number;
  segmentTimeS: number;
  defaultQuality: string;
  defaultPostprocess: Postprocess;
  faststart: Faststart;
  faststartThresholdMb: number;
  /** 合并成功后删除 `.fixed.ts` 中间产物（源 TS 永不动） */
  cleanupIntermediate: boolean;
  /** 通知渠道配置（结构由 notify 包解释，store 只存） */
  notify: Record<string, unknown>;
  /** 录制产物根目录（空 = 数据根下 downloads） */
  outputDir: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pollIntervalS: 30,
  segmentTimeS: 1800,
  defaultQuality: '',
  defaultPostprocess: 'merge',
  faststart: 'auto',
  faststartThresholdMb: 512,
  cleanupIntermediate: true,
  notify: {},
  outputDir: '',
};

/** 单场上限的兜底（0 = 未设置，按默认生效；docs/09 §5） */
export const DEFAULT_MAX_SESSION_S = 21_600;
export const DEFAULT_MAX_SESSION_BYTES = 20 * 1024 * 1024 * 1024;
export const MIN_MAX_SESSION_S = 600;
export const MAX_MAX_SESSION_S = 21_600;
export const MIN_MAX_SESSION_BYTES = 1024 * 1024;
export const MAX_MAX_SESSION_BYTES = 100 * 1024 * 1024 * 1024;

export function effectiveMaxSessionS(task: Pick<Task, 'maxSessionS'>): number {
  return task.maxSessionS > 0 ? task.maxSessionS : DEFAULT_MAX_SESSION_S;
}

export function effectiveMaxSessionBytes(task: Pick<Task, 'maxSessionBytes'>): number {
  return task.maxSessionBytes > 0 ? task.maxSessionBytes : DEFAULT_MAX_SESSION_BYTES;
}

/** 只有 `capped` 之后重开的场次算"承接上一场" */
export function originAfter(endReason: EndReason | null): SessionOrigin {
  return endReason === 'capped' ? 'cap' : 'new';
}
