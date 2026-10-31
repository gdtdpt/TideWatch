/**
 * API 客户端：所有变更请求都带 `X-TideWatch-Client: 1`（CSRF 红线）。
 * 401 统一冒泡给 App，切换回登录页 —— 不在每个调用点各写一遍。
 */

export class ApiError extends Error {
  readonly status: number;
  /** 服务端返回体：429 的 retryAfter、409 的 taskId 都在这里，别丢了 */
  readonly detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(method === 'GET' || method === 'HEAD' ? {} : { 'X-TideWatch-Client': '1' }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
  } catch (err) {
    // 调用方给了超时却等到超时 = 服务在忙（例如插件探测卡住），要说清楚，
    // 而不是把浏览器那句 "Failed to fetch" 直接甩给用户。
    if (timeoutMs !== undefined && err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, `等待超时（${String(Math.round(timeoutMs / 1000))} 秒没有响应）——任务可能已创建，已刷新列表`);
    }
    throw new ApiError(0, `请求没发出去或连接中断：${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, '需要登录');
  }
  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `HTTP ${String(res.status)}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    request<T>('POST', path, body, timeoutMs),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};

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

export interface Runtime {
  taskId: string;
  state: RuntimeState;
  detail: string | null;
  updatedAt: string;
}

export interface Task {
  id: string;
  kind: 'live' | 'vod';
  url: string;
  platform: string;
  streamerName: string | null;
  title: string | null;
  monitorEnabled: boolean;
  recordRequested: boolean;
  skipCurrentLive: boolean;
  checkNow: boolean;
  quality: string | null;
  qualityOptions: string[];
  segmentTimeS: number;
  postprocess: 'merge' | 'per_segment' | 'manual';
  maxSessionS: number;
  maxSessionBytes: number;
  createdAt: string;
  updatedAt: string;
  runtime: Runtime;
  latestSession: Session | null;
}

export interface Session {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  state: string;
  outputDir: string;
  origin: 'new' | 'cap';
  streamerName?: string | null;
  segmentCount?: number;
  durationS?: number;
  hasArtifact?: boolean;
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
  integrity: string;
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

export interface NotificationRow {
  id: number;
  ts: string;
  kind: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  taskId: string | null;
  sessionId: string | null;
  readAt: string | null;
}

/** 二进制来源：环境变量覆盖 / 随包 vendor / 系统 PATH 回退 */
export type BinarySource = 'env' | 'vendor' | 'path';

export interface BinaryStatus {
  command: string;
  source: BinarySource;
  ok: boolean;
  version: string | null;
}

export interface Health {
  ok: boolean;
  version: string;
  platform: string;
  schemaVersion: number;
  uptimeSec: number;
  engine: boolean;
  lease: { acquired: boolean; note: string | null };
  paths: { dataRoot: string; outputRoot: string };
  freeBytes: number | null;
  binaries: { ffmpeg: BinaryStatus; ffprobe: BinaryStatus };
}

export interface Settings {
  pollIntervalS: number;
  segmentTimeS: number;
  defaultQuality: string;
  defaultPostprocess: 'merge' | 'per_segment' | 'manual';
  faststart: 'auto' | 'on' | 'off';
  faststartThresholdMb: number;
  cleanupIntermediate: boolean;
  notify: Record<string, unknown>;
  outputDir: string;
}

export interface PluginInfo {
  name: string;
  version: string;
  protocol: number;
  dir: string;
  sourceDir: string;
  platforms: string[];
  urlPatterns: string[];
  missingRuntimes: string[];
  shadowed: { version: string; dir: string; sourceDir: string }[];
  error: string | null;
}

export interface CookieInfo {
  platform: string;
  hint: string;
  updatedAt: string;
  encrypted: boolean;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${String(h)} 小时 ${String(m)} 分`;
  if (m > 0) return `${String(m)} 分 ${String(s % 60)} 秒`;
  return `${String(s)} 秒`;
}

export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function fmtTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const END_REASON_LABEL: Record<string, string> = {
  offline: '下播结束',
  manual: '手动停止',
  error: '异常结束',
  disk: '磁盘错误',
  degraded: '连续失败降级',
  capped: '到达单场上限',
  interrupted: '进程中断（已恢复）',
  shutdown: '服务退出',
};

export const STATE_LABEL: Record<string, string> = {
  idle: '未监控',
  resolving: '解析中',
  waiting: '等待开播',
  recording: '录制中',
  snoozed: '本场已跳过',
  reconnecting: '重连中',
  finalizing: '收尾中',
  error: '出错',
  needs_auth: '需要登录',
  needs_dep: '缺少运行环境',
  unsupported: '平台未支持',
};

export const INTEGRITY_LABEL: Record<string, string> = {
  ok: '完好',
  partial: '尾部截断',
  truncated: '被中断',
  recovered: '崩溃抢救',
  cleaned: '源已清理',
  orphan: '孤儿文件',
};
