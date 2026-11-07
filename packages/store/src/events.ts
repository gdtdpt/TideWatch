/**
 * 事件分级与保留策略。
 *
 * `events` 这张表同时装着两种东西：
 * - **结果事件**（session.* / merge.* / recovery.* / plugin.auth_required…）：一天几十条，
 *   是"这场为什么没录成"的唯一证据，用户几个月后还会翻。
 * - **过程事件**（状态投影、逐行 stderr、逐轮解析失败）：是引擎的心跳。没人按条读它，
 *   但一次轮询就能写两条 —— 库里 95% 的行是它，查询量和库体积也是它决定的。
 *
 * 所以写入时就把类别定下来（存 `class` 列，不在查询时猜），保留期才能分开算：
 * 过程事件 7 天、结果事件 90 天。**未知 kind 一律按结果事件保留** —— 宁可多留，
 * 也不要因为漏登记一个 kind 就静默删掉用户的证据。
 */

import type { EventClass } from './models.ts';

export type { EventClass };

/** 只对"当时发生了什么"有用、过期即噪声的 kind。加新 kind 时没登记 → 按结果事件长期保留。 */
export const PROCESS_EVENT_KINDS = [
  'task.state_changed',
  'task.check_now',
  'task.monitor_window',
  'recording.stderr',
  /** stderr 限流后的汇总行，跟被压掉的那些同寿命 */
  'recording.stderr_capped',
  'recording.segment_started',
  'recording.error_class',
  'plugin.not_live',
  'plugin.resolve_err',
] as const;

const PROCESS_SET: ReadonlySet<string> = new Set<string>(PROCESS_EVENT_KINDS);

export function eventClassOf(kind: string): EventClass {
  return PROCESS_SET.has(kind) ? 'process' : 'result';
}

export interface RetentionPolicy {
  /** 过程事件保留天数 */
  readonly processDays: number;
  /** 结果事件保留天数 */
  readonly resultDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { processDays: 7, resultDays: 90 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 两类事件的删除界线。用 ISO 字符串比较而不是时间戳：`ts` 存的就是
 * `toISOString()`（UTC、定长），字典序等于时间序，可以直接走索引。
 */
export function retentionCutoffs(
  policy: RetentionPolicy,
  now: Date,
): { processBefore: string; resultBefore: string } {
  return {
    processBefore: new Date(now.getTime() - policy.processDays * DAY_MS).toISOString(),
    resultBefore: new Date(now.getTime() - policy.resultDays * DAY_MS).toISOString(),
  };
}
