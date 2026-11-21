import { describe, expect, it } from 'vitest';
import type { Segment } from '@tidewatch/store';
import { START_MAX_SHARE, STABLE_SHARE, adviseQuality, layoutLabel, type AdviceSession } from './qualityAdvice.ts';

function seg(input: {
  partNo: number;
  durationS: number;
  width?: number;
  height?: number;
  profile?: string;
  codec?: string;
  layoutHash?: string | null;
  sessionId?: string;
}): Segment {
  const width = input.width ?? 1280;
  const height = input.height ?? 720;
  const profile = input.profile ?? 'Main';
  return {
    id: `s${String(input.partNo)}`,
    sessionId: input.sessionId ?? 'sess-1',
    path: `/tmp/part${String(input.partNo)}.ts`,
    partNo: input.partNo,
    startedAt: '2026-11-20T20:00:00.000Z',
    durationS: input.durationS,
    sizeBytes: 0,
    videoCodec: input.codec ?? 'h264',
    videoProfile: profile,
    width,
    height,
    pixFmt: 'yuv420p',
    audioCodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    layoutHash: input.layoutHash === undefined ? `h264-${String(width)}x${String(height)}-yuv420p+aac-48000-2` : input.layoutHash,
    integrity: 'ok',
    errorClass: null,
  };
}

function session(id: string, startedAt: string, segments: Segment[]): AdviceSession {
  return { id, startedAt, segments };
}

describe('layoutLabel', () => {
  it('拼出宽×高与 profile', () => {
    expect(layoutLabel({ width: 1280, height: 720, videoProfile: 'Main' })).toBe('1280×720 Main');
  });

  it('缺尺寸时退化到 profile，再退化到 hash，最后给「未知」', () => {
    expect(layoutLabel({ width: null, height: null, videoProfile: 'High' })).toBe('High');
    expect(layoutLabel({ width: null, height: null, videoProfile: null, layoutHash: 'abc' })).toBe('abc');
    expect(layoutLabel({ width: null, height: null, videoProfile: null })).toBe('未知');
  });
});

describe('adviseQuality', () => {
  it('按时长加权，不被段数带偏', () => {
    // 3 段短 1080p 共 900s，1 段长 720p 共 3600s → 推荐 720p，不是段数多的 1080p
    const result = adviseQuality({
      sessions: [
        session('s1', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 300, width: 1920, height: 1080, profile: 'High' }),
          seg({ partNo: 2, durationS: 300, width: 1920, height: 1080, profile: 'High' }),
          seg({ partNo: 3, durationS: 300, width: 1920, height: 1080, profile: 'High' }),
          seg({ partNo: 4, durationS: 3600 }),
        ]),
      ],
      requestedQuality: null,
      actualQuality: null,
    });

    expect(result.recommendation?.height).toBe(720);
    expect(result.recommendation?.label).toBe('1280×720 Main');
    expect(result.recommendation?.share).toBeCloseTo(3600 / 4500, 5);
    expect(result.recommendation?.stable).toBe(true);
    expect(result.segments).toBe(4);
    expect(result.totalDurationS).toBe(4500);
  });

  it('只出现在开头的低占比档位标成「开播初期瞬时档位」并写明理由', () => {
    const result = adviseQuality({
      sessions: [
        session('s1', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 600, width: 1920, height: 1080, profile: 'High' }),
          seg({ partNo: 2, durationS: 2400 }),
          seg({ partNo: 3, durationS: 2400 }),
        ]),
      ],
      requestedQuality: '超清',
      actualQuality: { qn: 250, label: '超清' },
    });

    const hd = result.groups.find((g) => g.height === 1080);
    expect(hd?.onlyAtStart).toBe(true);
    expect(hd?.share).toBeLessThan(START_MAX_SHARE);
    expect(result.groups[0]?.height).toBe(720);
    expect(result.groups[0]?.onlyAtStart).toBe(false);
    expect(result.notes.some((n) => n.includes('只出现在每场开头'))).toBe(true);
  });

  it('开头档位占比过高就不算瞬时（整场只有一段 1080p 时不能说它是开播初期）', () => {
    const result = adviseQuality({
      sessions: [
        session('s1', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 3600, width: 1920, height: 1080, profile: 'High' }),
        ]),
      ],
      requestedQuality: null,
      actualQuality: null,
    });
    expect(result.groups[0]?.onlyAtStart).toBe(false);
    expect(result.recommendation?.height).toBe(1080);
  });

  it('没有哪一档占到七成时给出 unstable 与说明', () => {
    const result = adviseQuality({
      sessions: [
        session('s1', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 3600, width: 1920, height: 1080, profile: 'High' }),
          seg({ partNo: 2, durationS: 2400 }),
        ]),
      ],
      requestedQuality: null,
      actualQuality: null,
    });
    expect(result.recommendation?.stable).toBe(false);
    expect(result.recommendation?.share).toBeLessThan(STABLE_SHARE);
    expect(result.notes.some((n) => n.includes('本身就不稳定'))).toBe(true);
  });

  it('aligned 看最近一场的最后一段', () => {
    const old = session('s-old', '2026-11-10T20:00:00.000Z', [
      seg({ partNo: 1, durationS: 600, width: 1920, height: 1080, profile: 'High', sessionId: 's-old' }),
      seg({ partNo: 2, durationS: 3000, sessionId: 's-old' }),
    ]);
    const latest = session('s-new', '2026-11-20T20:00:00.000Z', [
      seg({ partNo: 1, durationS: 600, width: 1920, height: 1080, profile: 'High', sessionId: 's-new' }),
      seg({ partNo: 2, durationS: 3000, sessionId: 's-new' }),
    ]);

    const aligned = adviseQuality({ sessions: [old, latest], requestedQuality: '超清', actualQuality: null });
    expect(aligned.currentHeight).toBe(720);
    expect(aligned.recommendation?.height).toBe(720);
    expect(aligned.aligned).toBe(true);
    expect(aligned.notes.some((n) => n.includes('与历史稳定档位一致'))).toBe(true);

    // 最近一场最后落在 1080p → 与推荐(720)不一致
    const drifted = adviseQuality({
      sessions: [
        old,
        session('s-new', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 3000, sessionId: 's-new' }),
          seg({ partNo: 2, durationS: 600, width: 1920, height: 1080, profile: 'High', sessionId: 's-new' }),
        ]),
      ],
      requestedQuality: '原画',
      actualQuality: null,
    });
    expect(drifted.currentHeight).toBe(1080);
    expect(drifted.aligned).toBe(false);
    expect(drifted.notes.some((n) => n.includes('与稳定档位不同'))).toBe(true);
  });

  it('未固定画质时点名「跟随房间最高档」这个漂移根源', () => {
    const result = adviseQuality({
      sessions: [session('s1', '2026-11-20T20:00:00.000Z', [seg({ partNo: 1, durationS: 60 })])],
      requestedQuality: '',
      actualQuality: { qn: 10000, label: '原画' },
    });
    expect(result.notes.some((n) => n.includes('房间此刻能给的最高档'))).toBe(true);
    expect(result.notes.some((n) => n.includes('原画（qn=10000）'))).toBe(true);
  });

  it('0 秒段与空输入都不参与统计', () => {
    const empty = adviseQuality({ sessions: [], requestedQuality: null, actualQuality: null });
    expect(empty.recommendation).toBeNull();
    expect(empty.notes[0]).toContain('先录一场');

    const zero = adviseQuality({
      sessions: [
        session('s1', '2026-11-20T20:00:00.000Z', [
          seg({ partNo: 1, durationS: 0 }),
          seg({ partNo: 2, durationS: 0 }),
        ]),
      ],
      requestedQuality: null,
      actualQuality: null,
    });
    expect(zero.segments).toBe(0);
    expect(zero.recommendation).toBeNull();
  });

  it('不同会话的同一 layout 会合并成一组，并记下覆盖了几场', () => {
    const result = adviseQuality({
      sessions: [
        session('a', '2026-11-10T20:00:00.000Z', [seg({ partNo: 1, durationS: 600, sessionId: 'a' })]),
        session('b', '2026-11-20T20:00:00.000Z', [seg({ partNo: 1, durationS: 600, sessionId: 'b' })]),
      ],
      requestedQuality: null,
      actualQuality: null,
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessionCount).toBe(2);
    expect(result.groups[0]?.segmentCount).toBe(2);
    expect(result.sessions).toBe(2);
  });
});
