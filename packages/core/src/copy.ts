/**
 * 通知文案（纯函数）：事件 + 上下文 → {kind, level, title, body}。
 * 散在 service 里会和去重/落库搅在一起；写在 UI 里则 CLI 与浏览器各说各话。
 */
export type NotificationLevel = 'info' | 'warn' | 'error';

export interface Draft {
  kind: string;
  level: NotificationLevel;
  title: string;
  body: string;
}

const fmtDuration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
};

const fmtSize = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

export function recordingStarted(input: { streamer: string | null }): Draft {
  return {
    kind: 'recording_started',
    level: 'info',
    title: '开始录制',
    body: `${input.streamer ?? '直播间'} 已开播，正在录制。`,
  };
}

export function recordingEnded(input: {
  streamer: string | null;
  durationS: number;
  reconnects: number;
  gapS: number;
  reason: string;
}): Draft {
  const degraded = input.reconnects > 0 || input.gapS > 1 || input.reason === 'error' || input.reason === 'degraded';
  const parts = [`${input.streamer ?? '直播间'} 录制结束，时长 ${fmtDuration(input.durationS)}`];
  if (input.reconnects > 0) parts.push(`中断 ${input.reconnects} 次`);
  if (input.gapS > 1) parts.push(`缺口约 ${Math.round(input.gapS)} 秒`);
  return {
    kind: 'recording_ended',
    level: degraded ? 'warn' : 'info',
    title: '录制结束',
    body: `${parts.join('，')}。`,
  };
}

export function sessionCapped(input: { streamer: string | null; capS: number }): Draft {
  return {
    kind: 'session_capped',
    level: 'info',
    title: '到达单场上限',
    body: `${input.streamer ?? '直播间'} 已录满 ${fmtDuration(input.capS)}，新的一场会自动接着录。`,
  };
}

export function mergeCompleted(input: { file: string; durationS: number; sizeBytes: number }): Draft {
  return {
    kind: 'merge_completed',
    level: 'info',
    title: '合并完成',
    body: `${input.file}（${fmtDuration(input.durationS)}，${fmtSize(input.sizeBytes)}）`,
  };
}

export function mergeFailed(input: { reason: string }): Draft {
  return {
    kind: 'merge_failed',
    level: 'error',
    title: '合并失败',
    body: `${input.reason}。源分段已保留，可在录制页重试。`,
  };
}

export function mergeSkipped(input: {
  reason: 'no_usable_segment' | 'insufficient_disk';
  neededBytes?: number;
  freeBytes?: number;
}): Draft {
  const body =
    input.reason === 'insufficient_disk'
      ? `磁盘空间不足，跳过后处理（需要约 ${fmtSize(input.neededBytes ?? 0)}，可用 ${fmtSize(input.freeBytes ?? 0)}）。源分段已保留。`
      : '没有可用分段，跳过后处理。';
  return { kind: 'merge_skipped', level: 'warn', title: '跳过后处理', body };
}

export function needsAuth(input: { streamer: string | null }): Draft {
  return {
    kind: 'needs_auth',
    level: 'warn',
    title: '需要登录',
    body: `${input.streamer ?? '平台'} 解析需要 Cookie，请到设置页补齐后会自动重试。`,
  };
}

export function needsDependency(input: { streamer: string | null; runtime: string }): Draft {
  return {
    kind: 'needs_dependency',
    level: 'warn',
    title: '缺少运行环境',
    body: `${input.streamer ?? '平台'} 解析需要 ${input.runtime}，请到设置页「运行环境」按提示放置。`,
  };
}

export function platformUnsupported(input: { url: string; platforms: string }): Draft {
  return {
    kind: 'platform_unsupported',
    level: 'warn',
    title: '平台未支持',
    body: `${input.url} 当前没有可用插件（已支持：${input.platforms}）。`,
  };
}
