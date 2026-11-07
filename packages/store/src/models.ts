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
  | 'unsupported'
  /** 不在监控时段：一次请求都不发，等到点自动恢复 */
  | 'paused'
  /** 平台拒绝进房（主播设了观看范围 / 付费直播），半小时后再试 */
  | 'blocked';

/**
 * 「实际拿到的画质」——与 `Task.quality`（**请求**的档位）是两件事。
 *
 * 平台会静默降级：B站未登录时老接口请求原画（qn=10000）只回高清（150），
 * `code` 仍是 0、不报错，用户只会觉得"录出来怎么这么糊"（2026-10-07 实测）。
 * 所以"我要的"和"实际给的"必须分别可见。
 */
export interface QualityActual {
  /** 平台档位码（B站 qn；没有这个概念的平台为 null） */
  qn: number | null;
  /** 给人看的档位名（原画 / 1080p60 …）：UI 直接显示它 */
  label: string | null;
  codec: string | null;
  format: string | null;
  /** 请求档位的可读形式（用于"请求 X，实际 Y"的说明） */
  requested: string | null;
  /** 实际档位低于请求 → 降级 */
  degraded: boolean;
}

/**
 * 任务级监控时段。**空数组 = 全天**（老任务维持原行为，不会因为升级就静默停摆）。
 *
 * 为什么任务级而不是全局：每个主播的档期不同，一个全局窗口必然有人被削掉。
 * 为什么允许跨午夜：直播 19:00 开到 02:00 是常态，`start > end` 就是跨午夜。
 */
export interface MonitorWindow {
  /** "HH:MM" 本地时间（含） */
  start: string;
  /** "HH:MM" 本地时间（不含）；小于 start 表示跨午夜 */
  end: string;
  /** 0=周日 … 6=周六；省略或空 = 每天 */
  days?: number[];
}

export type PollReason = 'window_closed' | 'hot' | 'warm' | 'cold' | 'idle_stretch' | 'error_backoff';

/** 下一次轮询该等多久、为什么 */
export interface PollPlan {
  delayMs: number;
  reason: PollReason;
  /** 仅 `window_closed`：下一个时段开启时刻（ISO） */
  resumeAt: string | null;
}

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
  /** 最近一次 resolve 实际选中的档位（没解析过为 null） */
  qualityActual: QualityActual | null;
  segmentTimeS: number;
  postprocess: Postprocess;
  saveFormat: string;
  maxSessionS: number;
  maxSessionBytes: number;
  /** 监控时段；空数组 = 全天 */
  monitorWindows: MonitorWindow[];
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

/**
 * 跨会话合并（把同一场直播被切成的好几场拼回一个视频）。
 *
 * 与「单场后处理」是两件事：产物不属于任何一个会话，所以单独一张表，
 * 而不是往 `artifacts` 里塞 —— 那边的主键是 (session_id, path)。
 */
export type MergeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

/** 按流参数分组后的一组产物：不同 layout 的 TS 直拼会在拼接点崩 */
export interface MergeOutput {
  path: string;
  /** 第几组（从 1 开始）；只有一组时也是 1 */
  group: number;
  /** 这组覆盖了哪些源会话（按时间序） */
  sessionIds: string[];
  segmentCount: number;
  durationS: number;
  sizeBytes: number;
  /** 该组的流参数（`avc-1920x1080-yuv420p+aac-48000-2`），用于解释为什么分组 */
  layout: string | null;
}

/**
 * 缺口：合并后的文件在这里是"跳过去"的，画面上看不出来，必须显式标出。
 * `afterSessionId === beforeSessionId` 表示同一场内部断流造成的空档。
 */
export interface MergeGap {
  afterSessionId: string;
  afterPartNo: number;
  beforeSessionId: string;
  durationS: number;
}

export interface MergeJob {
  id: string;
  /** 用户选中的会话，已按开始时间升序 */
  sessionIds: string[];
  status: MergeStatus;
  outputs: MergeOutput[];
  gaps: MergeGap[];
  /** 计划产出组数 / 已完成组数 */
  planned: number;
  done: number;
  /** 0–1；按 ffmpeg 输出时长估算，供进度条用 */
  progress: number;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** 保留期分档：过程事件（心跳/噪声）与结果事件（证据）分开算寿命 */
export type EventClass = 'process' | 'result';

export interface EventRow {
  id: number;
  ts: string;
  taskId: string | null;
  sessionId: string | null;
  kind: string;
  /** 保留期分档：过程事件 7 天、结果事件 90 天（见 events.ts） */
  class: EventClass;
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
