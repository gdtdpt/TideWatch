/**
 * stderr 分类与退避决策（docs/03 §3）。
 *
 * 纯函数：输入一行文本 / 一次退出，输出"该重连、该收尾还是该报磁盘"。
 * 把它从引擎里拆出来，是为了"断网被误判成下播"这类事故能被单测钉住。
 */
import type { PluginErrorCode } from '@tidewatch/protocol';

export type ErrorClass =
  | 'url_expired'
  | 'network'
  | 'cdn_reset'
  | 'stream_eof'
  | 'disk'
  | 'param_change'
  | 'unknown';

const RULES: readonly { re: RegExp; cls: ErrorClass }[] = [
  { re: /no space left|enospc|disk full/i, cls: 'disk' },
  { re: /server returned (403|404)|http error (403|404)|403 forbidden|404 not found/i, cls: 'url_expired' },
  { re: /connection timed out|operation timed out|connection timeout/i, cls: 'network' },
  { re: /connection reset by peer|broken pipe|connection closed by peer/i, cls: 'cdn_reset' },
  { re: /stream ends prematurely|end of file|unexpected eof|input\/output error/i, cls: 'stream_eof' },
  { re: /frame changed from size|parameter change|non-monotonous|invalid timestamps/i, cls: 'param_change' },
];

/** 未识别的行返回 null（由引擎原文落 events，不猜分类） */
export function classifyLine(line: string): ErrorClass | null {
  for (const rule of RULES) {
    if (rule.re.test(line)) return rule.cls;
  }
  return null;
}

const PRIORITY: readonly ErrorClass[] = [
  'disk',
  'url_expired',
  'network',
  'cdn_reset',
  'stream_eof',
  'param_change',
  'unknown',
];

/** 主根因：一次连接内可能命中多条特征，按"处置优先级"取一条 */
export function primaryClass(classes: Iterable<ErrorClass>): ErrorClass | null {
  const set = new Set(classes);
  for (const cls of PRIORITY) if (set.has(cls)) return cls;
  return null;
}

export type ExitAction = 'graceful' | 'reconnect' | 'disk';

export interface ExitDecision {
  action: ExitAction;
  errorClass: ErrorClass | null;
}

/**
 * 进程退出决策：
 * - 磁盘写满 → 停（不重试，重试只会继续写坏）；
 * - 退出码 0 → 视为流正常结束（可能下播），交给 resolve 判定；
 * - 非 0 → 重连，分类只决定退避与终止条件。
 */
export function decideExit(input: { code: number | null; signal: string | null; classes: Iterable<ErrorClass> }): ExitDecision {
  const primary = primaryClass(input.classes);
  if (primary === 'disk') return { action: 'disk', errorClass: 'disk' };
  if (input.code === 0 && input.signal === null) return { action: 'graceful', errorClass: primary };
  return { action: 'reconnect', errorClass: primary ?? 'unknown' };
}

/** 退避曲线 2 → 5 → 10 → 30s，封顶为任务轮询间隔 */
export function reconnectDelayMs(attempt: number, pollIntervalS: number): number {
  const ladder = [2_000, 5_000, 10_000, 30_000];
  const idx = Math.min(Math.max(attempt - 1, 0), ladder.length - 1);
  const base = ladder[idx] ?? 30_000;
  return Math.min(base, Math.max(1, pollIntervalS) * 1000);
}

export const FAIL_STREAK_LIMIT = 5;
/** 在播但拿不到流地址：前 6 轮用 5s 短退避，之后回落到轮询间隔 */
export const URL_LESS_FAST_ROUNDS = 6;
export const URL_LESS_FAST_DELAY_MS = 5_000;

export type ResolveFaultKind = 'needs_auth' | 'needs_dep' | 'unsupported' | 'not_live' | 'restricted' | 'other';

export interface ResolveFault {
  kind: ResolveFaultKind;
  /** 是否需要"人去办一件事"（换状态 + 专用事件 + 退避一轮） */
  needsAction: boolean;
  state: 'needs_auth' | 'needs_dep' | 'unsupported' | 'waiting' | 'blocked' | 'error';
  eventKind: string;
}

export function resolveFault(code: PluginErrorCode | 'TIMEOUT'): ResolveFault {
  switch (code) {
    case 'AUTH_REQUIRED':
      return { kind: 'needs_auth', needsAction: true, state: 'needs_auth', eventKind: 'plugin.auth_required' };
    case 'DEPENDENCY_MISSING':
      return { kind: 'needs_dep', needsAction: true, state: 'needs_dep', eventKind: 'plugin.dependency_missing' };
    case 'PLATFORM_UNSUPPORTED':
      return {
        kind: 'unsupported',
        needsAction: true,
        state: 'unsupported',
        eventKind: 'plugin.unsupported_platform',
      };
    // 主播没开播：这是**正常状态**，不是故障。抖音下播时抛异常而不是返回空数据，
    // 兜底成 error 会让下播期间每 30 秒记一条"出错"（2026-11-04 实测 61 条）。
    case 'NOT_LIVE':
      return { kind: 'not_live', needsAction: false, state: 'waiting', eventKind: 'plugin.not_live' };
    // 平台拒绝进房（观看范围 / 付费直播）：除非用户去登录、加粉丝团，否则看不到。
    // 状态与 error 分开，UI 才能说清"为什么录不了"，退避也走半小时一档。
    case 'RESTRICTED':
      return { kind: 'restricted', needsAction: true, state: 'blocked', eventKind: 'plugin.restricted' };
    default:
      return { kind: 'other', needsAction: false, state: 'error', eventKind: 'plugin.resolve_err' };
  }
}

/**
 * `retryable=false` 只表示"别拿同样的参数立刻再问一次"，
 * **不表示这一场到此为止**（docs/09 §6.1 的教训）。
 */
export function shouldEndSessionOnFault(code: PluginErrorCode | 'TIMEOUT'): boolean {
  return code === 'AUTH_REQUIRED' || code === 'DEPENDENCY_MISSING' || code === 'PLATFORM_UNSUPPORTED';
}
