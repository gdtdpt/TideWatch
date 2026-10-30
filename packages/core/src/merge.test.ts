/**
 * 合并规划（M2）的回归锁：分组、同质化、磁盘预检三条都在这里定生死。
 *
 * 最关键的一条是"整组同质化"：早期只把脏段单独重封装，结果一组里混着
 * 两种流顺序，concat 在边界按流序号匹配时稳定失败 —— 所以 `normalize` 是
 * **组级**属性，测试必须按组断言。
 */
import { describe, expect, it } from 'vitest';
import {
  concatListContent,
  durationAcceptable,
  estimateNeededBytes,
  planMerge,
  type MergeSegment,
} from './merge.ts';

function seg(partNo: number, over: Partial<MergeSegment> = {}): MergeSegment {
  return {
    id: `s${String(partNo)}`,
    path: `/out/s_part${String(partNo).padStart(3, '0')}.ts`,
    partNo,
    durationS: 60,
    sizeBytes: 1024 * 1024,
    layoutHash: 'h264-1920x1080-yuv420p+aac-44100-2',
    integrity: 'ok',
    height: 1080,
    ...over,
  };
}

const base = {
  sessionId: 'sess1',
  streamerName: '主播A',
  startedAt: new Date(2026, 9, 29, 10, 10, 10),
  outputDir: '/out/主播A/20261029-101010_new_abcd1234',
  strategy: 'merge' as const,
  faststart: false,
  freeBytes: null,
};

describe('合并规划', () => {
  it('没有可用段 → skipped=no_usable_segment', () => {
    const plan = planMerge({ ...base, segments: [seg(1, { durationS: 0 })] });
    expect(plan.outputs).toHaveLength(0);
    expect(plan.skipped?.reason).toBe('no_usable_segment');
  });

  it('磁盘预检：预算 = 源 × 1.05 + 64MB，不够就整场跳过', () => {
    const total = 3 * 1024 * 1024;
    expect(estimateNeededBytes(total)).toBe(Math.ceil(total * 1.05) + 64 * 1024 * 1024);

    const plan = planMerge({ ...base, segments: [seg(1), seg(2)], freeBytes: 1024 });
    expect(plan.skipped?.reason).toBe('insufficient_disk');
    expect(plan.skipped?.neededBytes).toBeGreaterThan(0);
    expect(plan.skipped?.freeBytes).toBe(1024);
    expect(plan.outputs).toHaveLength(0);
  });

  it('查不出可用空间不等于没空间：freeBytes=null 一律放行', () => {
    const plan = planMerge({ ...base, segments: [seg(1)], freeBytes: null });
    expect(plan.skipped).toBeNull();
    expect(plan.outputs).toHaveLength(1);
  });

  it('同构连续段合成一个产物，命名用「主播_本地时间」', () => {
    const plan = planMerge({ ...base, segments: [seg(1), seg(2), seg(3)] });
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]?.path).toBe('/out/主播A/20261029-101010_new_abcd1234/主播A_20261029_101010.mp4');
    expect(plan.outputs[0]?.tmpPath).toBe('/out/主播A/20261029-101010_new_abcd1234/.tmp-主播A_20261029_101010.mp4');
    expect(plan.outputs[0]?.parts.map((p) => p.partNo)).toEqual([1, 2, 3]);
    expect(plan.outputs[0]?.normalize).toBe(false);
  });

  it('参数变化切组：按分辨率后缀区分，避免同名覆盖', () => {
    const plan = planMerge({
      ...base,
      segments: [
        seg(1),
        seg(2),
        seg(3, { layoutHash: 'h264-2560x1440-yuv420p+aac-44100-2', height: 1440 }),
      ],
    });
    expect(plan.outputs).toHaveLength(2);
    expect(plan.outputs[0]?.path.endsWith('_1080p.mp4')).toBe(true);
    expect(plan.outputs[1]?.path.endsWith('_1440p.mp4')).toBe(true);
    expect(plan.outputs[1]?.parts.map((p) => p.partNo)).toEqual([3]);
  });

  it('组内一段脏 → 整组重封装（不是只修那一段）', () => {
    const plan = planMerge({
      ...base,
      segments: [seg(1), seg(2, { integrity: 'partial' }), seg(3)],
    });
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]?.normalize).toBe(true);
    expect(plan.outputs[0]?.parts).toHaveLength(3);
  });

  it('per_segment：每段一个产物，编号补零', () => {
    const plan = planMerge({ ...base, strategy: 'per_segment', segments: [seg(3), seg(1)] });
    expect(plan.outputs.map((o) => o.path.split('/').pop())).toEqual([
      '主播A_20261029_101010_part001.mp4',
      '主播A_20261029_101010_part003.mp4',
    ]);
    expect(plan.outputs.every((o) => o.parts.length === 1)).toBe(true);
  });

  it('concat 清单按传入顺序，每行一个 file 指令', () => {
    const text = concatListContent([seg(1), seg(2)]);
    expect(text.split('\n').filter((l) => l.length > 0)).toEqual([
      "file '/out/s_part001.ts'",
      "file '/out/s_part002.ts'",
    ]);
  });

  it('时长校验：±2% 且至少 1s', () => {
    expect(durationAcceptable(119.5, 120)).toBe(true);
    expect(durationAcceptable(117, 120)).toBe(false);
  });
});
