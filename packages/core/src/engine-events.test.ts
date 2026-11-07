/**
 * 写入侧的"少写"规则：库每天涨一万条不是因为录得多，而是因为每轮都把
 * "主播未开播"再记一遍。这里钉住三条：
 * - 投影没变 → 不记状态事件；
 * - 同一个错误连续多轮 → 只记第一条；
 * - 错误流再吵 → 每场最多 100 条原文 + 一条汇总。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, type EngineDeps, type ResolveOutcome } from './engine.ts';
import { makeHarness, waitFor, type Harness } from './test-support.ts';
import type { Task } from '@tidewatch/store';

const harnesses: Harness[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const h of harnesses.splice(0)) h.cleanup();
});

function setup(overrides: Partial<EngineDeps> = {}): { h: Harness; engine: Engine; task: Task } {
  const h = makeHarness();
  harnesses.push(h);
  const task = h.store.addTask({ url: 'https://live.douyin.com/123', platform: 'douyin', monitorEnabled: true });
  const engine = new Engine({
    store: h.store,
    fs: h.fs,
    capture: h.capture,
    probe: h.probe,
    resolver: h.resolver,
    outputRoot: '/out',
    tickMs: 20,
    stopGraceMs: 200,
    ...overrides,
  });
  engines.push(engine);
  return { h, engine, task };
}

const fail = (code: 'NOT_LIVE' | 'INTERNAL', message: string): ResolveOutcome => ({
  ok: false,
  error: { code, message, retryable: true },
});

/** 点一次「立即检查」= 不等轮询间隔就跑下一轮（比等 5 秒真实间隔稳定得多） */
async function pollAgain(h: Harness, task: Task): Promise<void> {
  const before = h.resolver.calls;
  h.store.patchTask(task.id, { checkNow: true });
  await waitFor(() => h.resolver.calls > before, '再来一轮');
}

const kindsOf = (h: Harness): string[] => h.store.listEvents({ limit: 500 }).map((e) => e.kind);

describe('事件写放大治理', () => {
  it('未开播连续三轮只记一条状态事件（不再是每轮两条）', async () => {
    const { h, engine, task } = setup();
    h.store.putSettings({ pollIntervalS: 5 });
    h.resolver.queue = [fail('NOT_LIVE', 'Exception: 直播已结束')];

    engine.start();
    await waitFor(() => h.store.getRuntime(task.id)?.state === 'waiting', '等待开播');
    await pollAgain(h, task);
    await pollAgain(h, task);

    expect(h.resolver.calls).toBeGreaterThanOrEqual(3);
    const stateEvents = h.store.listEvents({ limit: 500 }).filter((e) => e.kind === 'task.state_changed');
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0]?.payload['state']).toBe('waiting');
    // 中间态 resolving 既不写投影也不落事件
    expect(stateEvents[0]?.payload['detail']).toBe('主播未开播');
    expect(kindsOf(h)).not.toContain('plugin.not_live');
  });

  it('同一个解析错误连续多轮只记第一条', async () => {
    const { h, engine, task } = setup();
    h.store.putSettings({ pollIntervalS: 5 });
    h.resolver.queue = [fail('INTERNAL', 'boom')];

    engine.start();
    await waitFor(() => h.store.getRuntime(task.id)?.state === 'error', '进入 error');
    await pollAgain(h, task);
    await pollAgain(h, task);

    const errs = h.store.listEvents({ limit: 500 }).filter((e) => e.kind === 'plugin.resolve_err');
    expect(errs).toHaveLength(1);
    expect(errs[0]?.payload['code']).toBe('INTERNAL');
  });

  it('错误流刷屏时每场最多 100 条原文 + 一条汇总', async () => {
    const { h, engine, task } = setup();
    const lines = Array.from({ length: 150 }, (_, i) => `warning: odd thing ${String(i)}`);
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }], stderr: lines }];

    engine.start();
    await waitFor(() => h.store.getRuntime(task.id)?.state === 'recording', '开始录制');
    await waitFor(() => kindsOf(h).includes('recording.stderr_capped'), '写入汇总行');

    const kinds = kindsOf(h);
    expect(kinds.filter((k) => k === 'recording.stderr')).toHaveLength(100);
    expect(kinds.filter((k) => k === 'recording.stderr_capped')).toHaveLength(1);
    const capped = h.store.listEvents({ limit: 500 }).find((e) => e.kind === 'recording.stderr_capped');
    expect(capped?.payload['kept']).toBe(100);
  });
});
