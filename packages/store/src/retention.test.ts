/**
 * 保留期执行器：**先归档、再删除**。
 *
 * 关键不变量（都是为了"证据不能丢"）：
 * - 结果事件到期前不动；
 * - 归档写不出去就整批不删；
 * - 归档文件能逐行读回来，行数与删掉的一致。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventClassOf } from './events.ts';
import { archiveStats, readArchive, runRetention } from './retention.ts';
import { Store } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date('2026-11-04T12:00:00.000Z');

function setup(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-retention-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'tidewatch.db'));
  return { store, dir };
}

/** 直接写库造"老事件"（insertEvent 用的是当下时间，造不出 30 天前） */
function insertAt(store: Store, ts: string, kind: string, sessionId: string | null = null): void {
  store.db
    .prepare('INSERT INTO events (ts, task_id, session_id, kind, class, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ts, null, sessionId, kind, eventClassOf(kind), '{}');
}

describe('事件归档与删除', () => {
  it('只删过期的过程事件；结果事件按自己的天数留着', async () => {
    const { store, dir } = setup();
    try {
      insertAt(store, '2026-10-01T00:00:00.000Z', 'task.state_changed'); // 34 天前 → 过程，删
      insertAt(store, '2026-11-03T00:00:00.000Z', 'task.state_changed'); // 1 天前 → 过程，留
      insertAt(store, '2026-07-27T00:00:00.000Z', 'session.ended'); // 100 天前 → 结果，删
      insertAt(store, '2026-09-01T00:00:00.000Z', 'session.started'); // 64 天前 → 结果，留

      const r = await runRetention({
        store,
        archiveDir: join(dir, 'events'),
        now: () => NOW,
        policy: { processDays: 7, resultDays: 90 },
      });

      expect(r.error).toBeNull();
      expect(r.deleted).toEqual({ process: 1, result: 1 });
      expect(r.totalAfter).toBe(2);
      // 两个分档各自一份归档
      expect(r.files).toHaveLength(2);

      // 归档可读回，且正好是被删的那两类
      const rows = [];
      for (const file of r.files) {
        for await (const e of readArchive(file)) rows.push(e);
      }
      expect(rows.map((e) => e.kind).sort()).toEqual(['session.ended', 'task.state_changed']);

      const left = store.listEvents({ limit: 10 }).map((e) => e.kind).sort();
      expect(left).toEqual(['session.started', 'task.state_changed']);
    } finally {
      store.close();
    }
  });

  it('没有过期事件时什么都不做（不建空归档）', async () => {
    const { store, dir } = setup();
    try {
      insertAt(store, '2026-11-03T00:00:00.000Z', 'task.state_changed');
      const r = await runRetention({ store, archiveDir: join(dir, 'events'), now: () => NOW });
      expect(r.deleted).toEqual({ process: 0, result: 0 });
      expect(r.files).toHaveLength(0);
      expect(archiveStats(join(dir, 'events')).files).toBe(0);
    } finally {
      store.close();
    }
  });

  it('归档写不出去就一行都不删', async () => {
    const { store, dir } = setup();
    try {
      // 用一个普通文件占住路径，mkdir 必然失败
      writeFileSync(join(dir, 'blocker'), 'x');
      insertAt(store, '2026-10-01T00:00:00.000Z', 'task.state_changed');

      const r = await runRetention({ store, archiveDir: join(dir, 'blocker', 'events'), now: () => NOW });
      expect(r.error).not.toBeNull();
      expect(r.deleted).toEqual({ process: 0, result: 0 });
      expect(r.totalAfter).toBe(1);
    } finally {
      store.close();
    }
  });

  it('归档文件按类分卷、带时间戳，放在 events/ 下', async () => {
    const { store, dir } = setup();
    try {
      insertAt(store, '2026-10-01T00:00:00.000Z', 'task.state_changed');
      insertAt(store, '2026-07-27T00:00:00.000Z', 'session.ended');
      const r = await runRetention({ store, archiveDir: join(dir, 'events'), now: () => NOW });
      const names = readdirSync(join(dir, 'events')).sort();
      expect(names).toEqual(r.files.map((f) => f.split('/').pop()).sort());
      expect(names.some((n) => n.includes('process'))).toBe(true);
      expect(names.some((n) => n.includes('result'))).toBe(true);
      expect(names.every((n) => n.endsWith('.ndjson.gz'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
