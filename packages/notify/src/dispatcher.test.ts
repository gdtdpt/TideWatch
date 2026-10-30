/**
 * 通知派生层（M4）回归锁。
 *
 * 三条纪律：info 只进铃铛、warn/error 才外发、同 (kind, task) 10 分钟去重。
 * 去重在这里而不是在渠道里，是因为 `plugin.auth_required` 每轮轮询都会重发 ——
 * 不去重的话，一次断网能刷出上百条推送，用户会把通知关掉。
 */
import { describe, expect, it } from 'vitest';
import { NotificationDispatcher } from './dispatcher.ts';
import { DEDUPE_WINDOW_MS, dedupeKey, type Channel, type Notification } from './types.ts';

function channel(id: string, ok = true): Channel & { sent: Notification[] } {
  const sent: Notification[] = [];
  return {
    id,
    sent,
    async send(n) {
      sent.push(n);
      return ok ? { ok: true } : { ok: false, reason: 'boom' };
    },
  };
}

const draft = (over: Partial<Notification> = {}): Notification => ({
  kind: 'merge_failed',
  level: 'error',
  title: '合并失败',
  body: 'x',
  taskId: 't1',
  ...over,
});

describe('通知派发', () => {
  it('info 只落库，不外发', async () => {
    const a = channel('ntfy');
    let recorded = 0;
    const d = new NotificationDispatcher({ channels: [a], record: () => void (recorded += 1) });
    const result = await d.dispatch(draft({ level: 'info', kind: 'recording_started' }));
    expect(recorded).toBe(1);
    expect(a.sent).toHaveLength(0);
    expect(result.external).toHaveLength(0);
  });

  it('warn/error 扇出所有渠道，一条失败不影响另一条', async () => {
    const bad = channel('bark', false);
    const good = channel('telegram');
    const d = new NotificationDispatcher({ channels: [bad, good], record: () => undefined });
    const result = await d.dispatch(draft());
    expect(bad.sent).toHaveLength(1);
    expect(good.sent).toHaveLength(1);
    expect(result.external).toEqual([
      { id: 'bark', ok: false, reason: 'boom' },
      { id: 'telegram', ok: true },
    ]);
  });

  it('渠道抛异常也只是记一笔，不阻断后续渠道', async () => {
    const throws: Channel = {
      id: 'smtp',
      send: async () => {
        throw new Error('连接被拒');
      },
    };
    const good = channel('ntfy');
    const d = new NotificationDispatcher({ channels: [throws, good], record: () => undefined });
    const result = await d.dispatch(draft());
    expect(result.external[0]).toEqual({ id: 'smtp', ok: false, reason: '连接被拒' });
    expect(good.sent).toHaveLength(1);
  });

  it('同一 (kind, task) 10 分钟内只外发一次，但每次都落库', async () => {
    const a = channel('ntfy');
    let recorded = 0;
    let now = 1_000;
    const d = new NotificationDispatcher({
      channels: [a],
      record: () => void (recorded += 1),
      now: () => now,
    });

    await d.dispatch(draft());
    now += 60_000;
    const second = await d.dispatch(draft());
    expect(second.deduped).toBe(true);
    expect(a.sent).toHaveLength(1);
    expect(recorded).toBe(2);

    // 过了窗口重新放行
    now += DEDUPE_WINDOW_MS;
    const third = await d.dispatch(draft());
    expect(third.deduped).toBe(false);
    expect(a.sent).toHaveLength(2);
  });

  it('去重键是 (kind, task)：不同任务/不同类别互不影响', async () => {
    expect(dedupeKey(draft())).toBe('merge_failed:t1');
    expect(dedupeKey(draft({ taskId: null }))).toBe('merge_failed:-');

    const a = channel('ntfy');
    const d = new NotificationDispatcher({ channels: [a], record: () => undefined });
    await d.dispatch(draft());
    await d.dispatch(draft({ taskId: 't2' }));
    await d.dispatch(draft({ kind: 'needs_auth' as Notification['kind'] }));
    expect(a.sent).toHaveLength(3);
  });

  it('落库失败不影响外发（通知丢了比渠道丢了严重得多）', async () => {
    const a = channel('ntfy');
    const d = new NotificationDispatcher({
      channels: [a],
      record: () => {
        throw new Error('db locked');
      },
    });
    const result = await d.dispatch(draft());
    expect(result.recorded).toBe(false);
    expect(a.sent).toHaveLength(1);
  });
});
