/**
 * 事件分级 + 保留期。
 *
 * 这两件事一旦错，后果是"用户的证据被提前删掉"或"库照样每天涨一万条"，
 * 而且都不会当场报错 —— 所以规则本身要能被单测钉住。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventClassOf, retentionCutoffs } from './events.ts';
import { Store } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-events-'));
  dirs.push(dir);
  return new Store(join(dir, 'tidewatch.db'));
}

describe('事件分级', () => {
  it('过程事件与结果事件分开；没登记的 kind 一律按结果事件长期保留', () => {
    expect(eventClassOf('task.state_changed')).toBe('process');
    expect(eventClassOf('recording.stderr')).toBe('process');
    expect(eventClassOf('plugin.resolve_err')).toBe('process');

    expect(eventClassOf('session.started')).toBe('result');
    expect(eventClassOf('merge.completed')).toBe('result');
    expect(eventClassOf('recovery.done')).toBe('result');
    // 未知 kind：宁可多留几天，也不要因为漏登记就静默删掉证据
    expect(eventClassOf('some.future_kind')).toBe('result');
  });

  it('insertEvent 自己写 class，不靠查询时猜', () => {
    const store = tempStore();
    try {
      store.insertEvent({ kind: 'task.state_changed', payload: { state: 'waiting' } });
      store.insertEvent({ kind: 'session.ended', payload: { reason: 'offline' } });
      const byKind = new Map(store.listEvents({ limit: 10 }).map((e) => [e.kind, e.class]));
      expect(byKind.get('task.state_changed')).toBe('process');
      expect(byKind.get('session.ended')).toBe('result');
    } finally {
      store.close();
    }
  });

  it('保留界线按各自天数算，且是可直接比较的 ISO 串', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    const cut = retentionCutoffs({ processDays: 7, resultDays: 90 }, now);
    expect(cut.processBefore).toBe('2026-10-28T12:00:00.000Z');
    expect(cut.resultBefore).toBe('2026-08-06T12:00:00.000Z');
    // 字典序 = 时间序（ts 全是定长 UTC ISO），SQL 的 ts < ? 才能走索引
    expect('2026-10-01T00:00:00.000Z' < cut.processBefore).toBe(true);
    expect('2026-09-01T00:00:00.000Z' < cut.resultBefore).toBe(false);
  });
});

describe('会话时间线查询', () => {
  it('按 session_id 直接查：不会被后写的上千条别的事件挤掉', () => {
    const store = tempStore();
    try {
      for (let i = 0; i < 3; i += 1) {
        store.insertEvent({ kind: 'recording.gap', sessionId: 's-old', payload: { after_part: i + 1 } });
      }
      for (let i = 0; i < 1200; i += 1) {
        store.insertEvent({ kind: 'task.state_changed', taskId: 't1', payload: { state: 'waiting' } });
      }
      const events = store.listSessionEvents('s-old');
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.payload['after_part'])).toEqual([1, 2, 3]);
      // 翻页：before 用最早那条的 id，往前没有更早的了
      expect(store.listSessionEvents('s-old', { before: events[0]?.id ?? 0 })).toHaveLength(0);
      expect(store.listSessionEvents('s-old', { limit: 2 })).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
