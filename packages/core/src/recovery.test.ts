/**
 * M2 恢复扫描回归锁（docs/03 §11）：
 * 「未收尾的场次标 interrupted」「磁盘上多出来的 TS 先 probe 再决定救还是归档」
 * 「登记的段不见了要留证」。三条都幂等。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { joinPath, ORPHAN_DIR } from './layout.ts';
import { runRecovery } from './recovery.ts';
import { fingerprintOf, makeHarness, type Harness } from './test-support.ts';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function setup(): { h: Harness; taskId: string; sessionId: string; dir: string; startedAt: string } {
  const h = makeHarness();
  harnesses.push(h);
  const task = h.store.addTask({ url: 'https://live.douyin.com/1', platform: 'douyin', monitorEnabled: true });
  const dir = '/out/主播A/20261029-101010_new_abcd1234';
  const startedAt = new Date(2026, 9, 29, 10, 10, 10).toISOString();
  const sessionId = h.store.createSession({ taskId: task.id, startedAt, outputDir: dir, origin: 'new' });
  return { h, taskId: task.id, sessionId, dir, startedAt };
}

describe('恢复扫描', () => {
  it('未收尾的会话标 interrupted，事件留证', async () => {
    const { h, sessionId } = setup();
    const summary = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });

    const session = h.store.getSession(sessionId);
    expect(session?.endedAt).not.toBeNull();
    expect(session?.endReason).toBe('interrupted');
    expect(summary.interrupted).toBe(1);
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('recovery.session_interrupted');
  });

  it('崩溃瞬间正在写的段：能 probe 出来就就地登记为 recovered（不丢内容）', async () => {
    const { h, sessionId, dir } = setup();
    const path = joinPath(dir, 'abcd1234_part001.ts');
    h.fs.put(path, 8192);
    h.probe.fallback = () => fingerprintOf(1920, 1080, 42);

    const summary = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });
    expect(summary.recovered).toBe(1);

    const segments = h.store.listSegments(sessionId);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ path, partNo: 1, durationS: 42, integrity: 'recovered', sizeBytes: 8192 });
    expect(segments[0]?.width).toBe(1920);
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('recovery.segment_recovered');
  });

  it('解析不出来的文件进 orphan/，保留不删', async () => {
    const { h, dir } = setup();
    const path = joinPath(dir, 'garbage_part001.ts');
    h.fs.put(path, 100);
    h.probe.fallback = () => null;

    const summary = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });
    expect(summary.orphaned).toBe(1);
    expect(h.fs.files.has(path)).toBe(false);
    expect(h.fs.files.has(joinPath(dir, ORPHAN_DIR, 'garbage_part001.ts'))).toBe(true);
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('recovery.orphan_found');
  });

  it('已登记但文件不见 → segment_missing；cleaned 的段不报警', async () => {
    const { h, sessionId, dir, startedAt } = setup();
    h.store.insertSegment({
      sessionId,
      path: joinPath(dir, 'abcd1234_part001.ts'),
      partNo: 1,
      startedAt,
      durationS: 60,
      sizeBytes: 1024,
      integrity: 'ok',
    });
    h.store.insertSegment({
      sessionId,
      path: joinPath(dir, 'abcd1234_part002.ts'),
      partNo: 2,
      startedAt,
      durationS: 60,
      sizeBytes: 1024,
      integrity: 'cleaned',
    });

    const summary = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });
    expect(summary.missing).toBe(1);
    const missing = h.store.listEvents({ limit: 50 }).filter((e) => e.kind === 'recovery.segment_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.payload['part_no']).toBe(1);
  });

  it('幂等：连跑两次不会重复标 interrupted、也不会重复登记同一段', async () => {
    const { h, dir } = setup();
    h.fs.put(joinPath(dir, 'abcd1234_part001.ts'), 1024);

    const first = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });
    const second = await runRecovery({ store: h.store, fs: h.fs, probe: h.probe });

    expect(first.interrupted).toBe(1);
    expect(second.interrupted).toBe(0);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(h.store.listSessions()[0]?.endReason).toBe('interrupted');
  });
});
