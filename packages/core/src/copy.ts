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

/**
 * 跨会话合并（用户手动把几场拼成一个视频）：完成与失败各一条。
 *
 * 缺口单独提一句 —— 拼接把时间空洞"抹平"了，文件看起来是连续的，
 * 用户不提前知道就会以为录像正常（老猫鱼那场就是中途被关播造成的）。
 */
export function sessionsMerged(input: {
  sessions: number;
  files: number;
  durationS: number;
  gapS: number;
}): Draft {
  const files =
    input.files > 1 ? `，流参数不同按组产出 ${String(input.files)} 个文件` : '';
  const gaps = input.gapS > 1 ? `，中间有约 ${fmtDuration(input.gapS)}的空档` : '';
  return {
    kind: 'sessions_merged',
    level: 'info',
    title: '合并完成',
    body: `${String(input.sessions)} 场已拼成 ${fmtDuration(input.durationS)}的视频${files}${gaps}。`,
  };
}

export function sessionsMergeFailed(input: { reason: string }): Draft {
  return {
    kind: 'sessions_merge_failed',
    level: 'error',
    title: '合并失败',
    body: `${input.reason}。源分段都保留了，可以在合并页重试。`,
  };
}

export function sessionsMergeSkipped(input: { reason: 'no_usable_segment' | 'insufficient_disk' }): Draft {
  return {
    kind: 'sessions_merge_skipped',
    level: 'warn',
    title: '跳过合并',
    body:
      input.reason === 'insufficient_disk'
        ? '磁盘空间不足，没有开始合并。源分段都保留了。'
        : '选中的会话没有可用分段，跳过合并。',
  };
}

export function needsAuth(input: { streamer: string | null }): Draft {
  return {
    kind: 'needs_auth',
    level: 'warn',
    title: '需要登录',
    body: `${input.streamer ?? '平台'} 解析需要 Cookie，请到设置页补齐后会自动重试。`,
  };
}

/**
 * 主播设了观看范围 / 付费直播 —— 平台明确拒绝进房。
 *
 * 与「需要登录」分开：登录能解开的只有"粉丝团可见"，"指定观众"谁都进不去，
 * 这时让用户去配 Cookie 是把人往错方向引。
 */
export function viewRestricted(input: { streamer: string | null }): Draft {
  return {
    kind: 'view_restricted',
    level: 'warn',
    title: '无法进房',
    body: `${input.streamer ?? '该直播间'} 限制了观看范围（粉丝团可见 / 指定观众 / 付费直播），匿名访问被拒。半小时后自动再试；这一场可能录不到。`,
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

/**
 * 画质降级：请求的档位拿不到，平台给了更低的一档（且**不会报错**）。
 *
 * 只在"从没降级 → 降级"这一刻发一次（引擎侧去重）。录到低画质是不可逆的损失，
 * 用户越早知道越能补救（登录 / 改档位 / 换平台），所以值得一条提醒。
 */
export function qualityDegraded(input: {
  streamer: string | null;
  requested: string | null;
  label: string | null;
  codec: string | null;
}): Draft {
  const asked = input.requested ?? '默认档位';
  const got = input.label ?? '较低档位';
  const codec = input.codec === null ? '' : `（${input.codec.toUpperCase()}）`;
  return {
    kind: 'quality_degraded',
    level: 'warn',
    title: '画质被降级',
    body: `${input.streamer ?? '直播间'} 请求 ${asked}，平台实际只给了 ${got}${codec}。常见原因是未登录、房间本来没有该档位，或会员画质。已在任务卡上标出实际画质。`,
  };
}

/**
 * `avc-1920x1080-yuv420p+aac-48000-2` → `1920×1080 AVC`
 *
 * layoutHash 是给程序比的（`ffmpeg.ts` 的 `layoutHash`），人读起来太吵；
 * 通知里只要"分辨率 + 编码"这两个能解释"为什么合并不了"。
 */
export function describeLayout(layout: string | null): string | null {
  if (layout === null || layout.length === 0) return null;
  const [video = ''] = layout.split('+');
  const [codec = '', size = ''] = video.split('-');
  const dims = size.replace(/x/i, '×');
  const out = [dims, codec.toUpperCase()].filter((s) => s.length > 0).join(' ');
  return out.length > 0 ? out : layout;
}

/**
 * 段与段之间流参数变了（分辨率 / 编码 / 像素格式任一不同）。
 *
 * 这件事本身不影响录制，但会让"合并成一个文件"变复杂（不同 layout 的 TS 直接
 * concat 会在拼接点崩）。2026-11-01 老猫鱼那场就是三段里第一段流序与后两段不同，
 * 排查花了不少时间 —— 提前说一句，比事后翻 ffmpeg 日志省事。
 */
export function layoutChanged(input: {
  streamer: string | null;
  part: number;
  from: string | null;
  to: string | null;
}): Draft {
  return {
    kind: 'layout_changed',
    level: 'warn',
    title: '流参数发生变化',
    body: `${input.streamer ?? '直播间'} 第 ${String(input.part)} 段的流参数与之前不同（${describeLayout(input.from) ?? '未知'} → ${describeLayout(input.to) ?? '未知'}）。录制不受影响，但合并时可能按参数分组产出多个文件。`,
  };
}
