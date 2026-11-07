/**
 * 监控时段与轮询节奏（纯函数）。
 *
 * 两件事在这里定，引擎只负责执行：
 *
 * 1. **时段**（任务级，可为空 = 全天）：窗口外**一次请求都不发**。
 *    直播多在深夜，跨午夜是常态而不是边界情况 —— `19:00-02:00` 必须能写。
 *
 * 2. **节奏**：窗口内多快问一次，由「这主播历史上这一小时开过几次播」决定。
 *    24 小时不间断 30 秒一次是每天 2880 次，抖音的匿名 webcast 接口已经为此
 *    报过一次风控（2026-11-01 真机）。而主播一天只播两三小时，剩下二十小时
 *    问的全是"没开播" —— 把冷时段的间隔拉长，是降暴露最直接的手段。
 *
 * 判定优先级（从高到低）：窗外 > 连续失败 > 历史冷热 > 连续未开播拉长。
 * 全部用**墙钟**：时段是钟表概念，"现在几点"只能看时钟。
 */
import type { MonitorWindow, PollPlan, PollReason } from '@tidewatch/store';

/** 历史里本小时开播过 ≥ 这个次数 = 热时段，按基准间隔问 */
export const AFFINITY_HOT = 2;
/** 本小时开播过 1 次 = 温时段，至少 60s 问一次 */
export const POLL_WARM_MIN_MS = 60_000;
/** 本小时从没开播过 = 冷时段，180s 问一次（新手任务不受此限，见 `#level`） */
export const POLL_COLD_MS = 180_000;
/** 任何理由的间隔上限：再冷也不超过 10 分钟，避免错过整场 */
export const POLL_CAP_MS = 600_000;
/** 连续未开播多少轮翻一倍间隔 */
export const IDLE_STRETCH_ROUNDS = 10;
/** 历史样本少于这个数时不做冷热判断（新任务照常 30s，别一上来就 3 分钟） */
export const AFFINITY_MIN_SAMPLES = 3;
/** 没权限看（主播设了可见范围）：半小时后再试，别一直撞门 */
export const RESTRICTED_RETRY_S = 1_800;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** "HH:MM" / "H:MM" → 当日分钟数；非法返回 null */
export function parseHm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 窗口的合法形态：最多 3 段、时间可解析、start≠end、起止+星期不重复 */
export function sanitizeWindows(input: unknown): MonitorWindow[] {
  if (!Array.isArray(input)) return [];
  const out: MonitorWindow[] = [];
  const seen = new Set<string>();
  // 先去重再截断：前两条重复时，第 4 条独立的段不该被"最多 3 段"挤掉
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const start = typeof o['start'] === 'string' ? parseHm(o['start']) : null;
    const end = typeof o['end'] === 'string' ? parseHm(o['end']) : null;
    if (start === null || end === null || start === end) continue;
    const days = Array.isArray(o['days'])
      ? [...new Set(o['days'].filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    // 两段完全相同没有意义（判定结果恒等价），留着只会让界面看起来"删了又回来"
    const key = `${String(start)}-${String(end)}-${days.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: fmtHm(start), end: fmtHm(end), ...(days.length > 0 ? { days } : {}) });
    if (out.length >= 3) break;
  }
  return out;
}

function allowsDay(w: MonitorWindow, day: Date): boolean {
  const days = w.days;
  return days === undefined || days.length === 0 || days.includes(day.getDay());
}

function minutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 此刻是否落在任一时段内；空时段表 = 全天（恒 true） */
export function inWindows(windows: readonly MonitorWindow[], now: Date): boolean {
  if (windows.length === 0) return true;
  const cur = minutesOf(now);
  for (const w of windows) {
    const s = parseHm(w.start);
    const e = parseHm(w.end);
    if (s === null || e === null) continue;
    if (s < e) {
      if (allowsDay(w, now) && cur >= s && cur < e) return true;
      continue;
    }
    // 跨午夜：今天 start 之后算今天，今天 end 之前算昨天的延续
    if (cur >= s && allowsDay(w, now)) return true;
    if (cur < e) {
      const yesterday = new Date(now.getTime() - DAY_MS);
      if (allowsDay(w, yesterday)) return true;
    }
  }
  return false;
}

/** 下一个窗口开启时刻（严格晚于 now）；全天或窗口表为空 → null */
export function nextOpenAt(windows: readonly MonitorWindow[], now: Date): Date | null {
  if (windows.length === 0) return null;
  const nowMs = now.getTime();
  let best: number | null = null;
  for (let d = 0; d < 8; d += 1) {
    const day = new Date(nowMs + d * DAY_MS);
    day.setHours(0, 0, 0, 0);
    for (const w of windows) {
      if (!allowsDay(w, day)) continue;
      const s = parseHm(w.start);
      if (s === null) continue;
      const at = new Date(day.getTime() + s * MINUTE_MS);
      if (at.getTime() <= nowMs) continue;
      if (best === null || at.getTime() < best) best = at.getTime();
    }
  }
  return best === null ? null : new Date(best);
}

/**
 * 历史开播热度：24 个桶，每桶 = 该本地小时开始过几场。
 *
 * 只统计 `days` 天以内、最近 `maxSamples` 场 —— 主播档期会变，三个月前的
 * 时间表不该继续影响今天的判断。
 */
export function hourAffinity(
  starts: readonly string[],
  now: Date,
  opts: { days?: number; maxSamples?: number } = {},
): number[] {
  const days = opts.days ?? 60;
  const maxSamples = opts.maxSamples ?? 60;
  const floor = now.getTime() - days * DAY_MS;
  const buckets = new Array<number>(24).fill(0);
  let taken = 0;
  for (const iso of starts) {
    if (taken >= maxSamples) break;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t < floor) continue;
    const d = new Date(t);
    buckets[d.getHours()] = (buckets[d.getHours()] ?? 0) + 1;
    taken += 1;
  }
  return buckets;
}

export function sampleCount(affinity: readonly number[]): number {
  return affinity.reduce((n, v) => n + v, 0);
}

/** 该小时的冷热档位；样本太少一律按"热"处理（= 用基准间隔，别一上来就冷） */
export function affinityLevel(affinity: readonly number[], hour: number): 'hot' | 'warm' | 'cold' {
  if (sampleCount(affinity) < AFFINITY_MIN_SAMPLES) return 'hot';
  const n = affinity[hour] ?? 0;
  if (n >= AFFINITY_HOT) return 'hot';
  return n === 1 ? 'warm' : 'cold';
}

export interface PollInput {
  now: Date;
  windows: readonly MonitorWindow[];
  affinity: readonly number[];
  /** 连续"未开播"轮数（开播即清零） */
  idleRounds: number;
  /** 连续解析失败轮数（成功即清零） */
  errorStreak: number;
  /** 基准间隔 = 设置里的轮询间隔 */
  baseMs: number;
}

export function planPoll(input: PollInput): PollPlan {
  const base = Math.max(5_000, input.baseMs);

  if (!inWindows(input.windows, input.now)) {
    const resume = nextOpenAt(input.windows, input.now);
    const until = resume === null ? DAY_MS : Math.max(1_000, resume.getTime() - input.now.getTime());
    return {
      delayMs: Math.min(until, DAY_MS),
      reason: 'window_closed',
      resumeAt: resume === null ? null : resume.toISOString(),
    };
  }

  let delay: number;
  let reason: PollReason;

  if (input.errorStreak >= 2) {
    // 连续失败：2 次起翻倍，封顶 10 分钟。风控期间继续猛问只会被拉黑更久。
    const exp = Math.min(input.errorStreak - 1, 6);
    delay = base * 2 ** exp;
    reason = 'error_backoff';
  } else {
    const level = affinityLevel(input.affinity, input.now.getHours());
    if (level === 'hot') {
      delay = base;
      reason = 'hot';
    } else if (level === 'warm') {
      delay = Math.max(base, POLL_WARM_MIN_MS);
      reason = 'warm';
    } else {
      delay = Math.max(base, POLL_COLD_MS);
      reason = 'cold';
    }
    if (input.idleRounds >= IDLE_STRETCH_ROUNDS) {
      const stretch = 2 ** Math.floor(input.idleRounds / IDLE_STRETCH_ROUNDS);
      const stretched = Math.min(delay * stretch, POLL_CAP_MS);
      if (stretched > delay) {
        delay = stretched;
        reason = 'idle_stretch';
      }
    }
  }

  return { delayMs: Math.min(delay, POLL_CAP_MS), reason, resumeAt: null };
}

/** "19:00–02:00 · 12:00–13:30"；空 = "不限（全天）" */
export function describeWindows(windows: readonly MonitorWindow[]): string {
  if (windows.length === 0) return '不限（全天）';
  return windows.map((w) => `${w.start}–${w.end}`).join(' · ');
}

/** 轮询间隔的人话（任务卡/事件用） */
export function describeReason(reason: PollReason, delayMs: number): string {
  const s = Math.round(delayMs / 1000);
  switch (reason) {
    case 'window_closed':
      return '不在监控时段';
    case 'error_backoff':
      return `解析失败，${String(s)} 秒后重试`;
    case 'cold':
      return `该时段平时不开播，${String(s)} 秒后再看`;
    case 'warm':
      return `该时段偶尔开播，${String(s)} 秒后再看`;
    case 'idle_stretch':
      return `久未开播，放慢到 ${String(s)} 秒一次`;
    case 'hot':
    default:
      return `该时段常开播，${String(s)} 秒后再看`;
  }
}
