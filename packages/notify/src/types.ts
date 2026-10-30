/**
 * 通知：服务端账本 + 渠道扇出。
 * 无桌面壳 → 没有系统通知，渠道是 M4 的硬需求，不是锦上添花。
 */
export type NotificationLevel = 'info' | 'warn' | 'error';

export type NotificationKind =
  | 'recording_started'
  | 'recording_ended'
  | 'merge_completed'
  | 'merge_failed'
  | 'merge_skipped'
  | 'needs_auth'
  | 'needs_dependency'
  | 'platform_unsupported'
  | 'session_capped';

export interface Notification {
  kind: string;
  level: NotificationLevel;
  title: string;
  body: string;
  taskId?: string | null;
  sessionId?: string | null;
  createdAt?: string;
}

export interface Channel {
  readonly id: string;
  /** 渠道自身失败只记账，不影响其他渠道 */
  send(n: Notification): Promise<{ ok: boolean; reason?: string }>;
}

export interface ChannelResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/** 去重键：同一 (kind, task) 在 10 分钟内只推一次 */
export function dedupeKey(n: Notification): string {
  return `${n.kind}:${n.taskId ?? '-'}`;
}

export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
