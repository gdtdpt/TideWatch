/**
 * 后处理规划（纯函数，docs/03 §8）：
 * 先用 ffprobe 校验与分组，再决定"直拼还是整组重封装"。
 *
 * 关键教训写进类型里：`normalize` 是**组级**决策 —— 早期"只重封装脏段"
 * 必然造出混源组，concat 在边界按流序号匹配时稳定失败。
 */
import type { Integrity, Postprocess, Segment } from '@tidewatch/store';
import { localFileStamp, outputBaseName } from './layout.ts';

export interface MergeSegment {
  id: string;
  path: string;
  partNo: number;
  durationS: number;
  sizeBytes: number;
  layoutHash: string | null;
  integrity: Integrity;
  height: number | null;
}

export interface PlannedOutput {
  path: string;
  tmpPath: string;
  parts: MergeSegment[];
  /** 整组重封装后再拼接 */
  normalize: boolean;
  faststart: boolean;
}

export type MergeSkipReason = 'no_usable_segment' | 'insufficient_disk';

export interface MergeSkip {
  reason: MergeSkipReason;
  neededBytes?: number;
  freeBytes?: number;
}

export interface MergePlan {
  outputs: PlannedOutput[];
  skipped: MergeSkip | null;
  estimatedBytes: number;
}

export interface MergePlanInput {
  sessionId: string;
  streamerName: string | null;
  startedAt: Date;
  outputDir: string;
  strategy: Postprocess;
  faststart: boolean;
  segments: readonly MergeSegment[];
  /** null/undefined = 查不出来，一律放行（"查不出来"不等于"没空间"） */
  freeBytes?: number | null;
}

/** 产物预算 = 源大小 × 1.05 + 64MB */
export function estimateNeededBytes(totalBytes: number): number {
  return Math.ceil(totalBytes * 1.05) + 64 * 1024 * 1024;
}

export function toMergeSegment(s: Segment): MergeSegment {
  return {
    id: s.id,
    path: s.path,
    partNo: s.partNo,
    durationS: s.durationS,
    sizeBytes: s.sizeBytes,
    layoutHash: s.layoutHash,
    integrity: s.integrity,
    height: s.height,
  };
}

function groupConsecutive(segments: readonly MergeSegment[]): MergeSegment[][] {
  const groups: MergeSegment[][] = [];
  let current: MergeSegment[] = [];
  let key: string | null = null;
  for (const seg of segments) {
    const k = seg.layoutHash ?? 'unknown';
    if (current.length === 0 || k === key) {
      current.push(seg);
      key = k;
      continue;
    }
    groups.push(current);
    current = [seg];
    key = k;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function groupSuffix(group: MergeSegment[], index: number, multi: boolean): string {
  if (!multi) return '';
  const height = group.find((s) => s.height !== null)?.height;
  return height === null || height === undefined ? `_g${index + 1}` : `_${height}p`;
}

export function planMerge(input: MergePlanInput): MergePlan {
  const usable = [...input.segments].filter((s) => s.durationS > 0).sort((a, b) => a.partNo - b.partNo);
  if (usable.length === 0) {
    return { outputs: [], skipped: { reason: 'no_usable_segment' }, estimatedBytes: 0 };
  }

  const totalBytes = usable.reduce((sum, s) => sum + Math.max(s.sizeBytes, 0), 0);
  const needed = estimateNeededBytes(totalBytes);
  if (input.freeBytes !== null && input.freeBytes !== undefined && input.freeBytes < needed) {
    return {
      outputs: [],
      skipped: { reason: 'insufficient_disk', neededBytes: needed, freeBytes: input.freeBytes },
      estimatedBytes: needed,
    };
  }

  const base = outputBaseName(input.streamerName, input.startedAt);
  const dir = input.outputDir.replace(/[\\/]+$/, '');
  const outputs: PlannedOutput[] = [];

  if (input.strategy === 'per_segment') {
    for (const seg of usable) {
      const name = `${base}_part${String(seg.partNo).padStart(3, '0')}.mp4`;
      outputs.push({
        path: `${dir}/${name}`,
        tmpPath: `${dir}/.tmp-${name}`,
        parts: [seg],
        // 单文件也要过一遍容器转换；流顺序由 ffmpeg 决定，无需整组同质化
        normalize: false,
        faststart: input.faststart,
      });
    }
    return { outputs, skipped: null, estimatedBytes: needed };
  }

  const groups = groupConsecutive(usable);
  const multi = groups.length > 1;
  groups.forEach((group, index) => {
    const name = `${base}${groupSuffix(group, index, multi)}.mp4`;
    outputs.push({
      path: `${dir}/${name}`,
      tmpPath: `${dir}/.tmp-${name}`,
      parts: group,
      // 组内有任一段非 ok → 整组重封装（一处脏，全组同质化）
      normalize: group.some((s) => s.integrity !== 'ok'),
      faststart: input.faststart,
    });
  });

  return { outputs, skipped: null, estimatedBytes: needed };
}

/** 输出校验：时长 ≈ Σ段时长（±2% 且 ≥1s） */
export function durationAcceptable(actualS: number, expectedS: number): boolean {
  if (actualS <= 0) return false;
  const tolerance = Math.max(expectedS * 0.02, 1);
  return Math.abs(actualS - expectedS) <= tolerance;
}

export function concatListContent(parts: readonly MergeSegment[]): string {
  // concat demuxer 的单引号转义：' -> '\''
  const quote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;
  return `${parts.map((p) => `file ${quote(p.path)}`).join('\n')}\n`;
}

/** `auto` = 源总量小于阈值才开 faststart（faststart 需整文件重写） */
export function resolveFaststart(setting: 'auto' | 'on' | 'off', totalBytes: number, thresholdMb: number): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return totalBytes < thresholdMb * 1024 * 1024;
}

export function defaultOutputName(streamerName: string | null, startedAt: Date): string {
  return `${outputBaseName(streamerName, startedAt)}_${localFileStamp(startedAt)}`;
}
