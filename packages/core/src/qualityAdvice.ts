/**
 * 档位建议：从历史录制反推「这个直播间稳定在哪个画质」。
 *
 * 起因是「前后码率不一致、合并出两个文件」。查下来的真相不是码率 —— 录制是
 * `-c copy` 流拷贝，码率不可控；真正变的是**流参数**（分辨率/profile），也就是
 * `layoutHash`。而变化的来源往往是平台：B 站在开播初期给原画，转码就绪后只给超清。
 *
 * 所以这里做的是**统计**，不是预测：按时长加权看历史上哪个 layout 占绝大多数，
 * 占得多的那个就是这个直播间的稳定档位。把画质钉在它上面，前后就不会再分裂。
 *
 * 刻意与引擎行为解耦（纯函数、只读）：建议只是建议，改不改由用户决定。
 */
import type { Segment } from '@tidewatch/store';

/** 占时长 ≥ 这个比例才算「稳定档位」；低于它说明这房间本来就在跳 */
export const STABLE_SHARE = 0.7;

/**
 * 只出现在开头的档位视为「瞬时」的上限。
 *
 * 开播初期平台给的高档（原画）通常只持续几十分钟，长期看占比很低。这个阈值
 * 用来在解释里点名它，避免用户以为"历史上也给过 1080p"就死盯高档位。
 */
export const START_MAX_SHARE = 0.25;

/** `partNo <= 这个值` 视为「每场开头」（分段默认 1 小时一段） */
const START_PART_NO = 1;

export interface AdviceSession {
  id: string;
  startedAt: string;
  segments: readonly Segment[];
}

export interface QualityAdviceInput {
  sessions: readonly AdviceSession[];
  /** 任务当前设置的画质；null/空 = 跟随平台最高档（这正是漂移的根源） */
  requestedQuality: string | null;
  /** 最近一次解析到的实际档位（只用来在说明里对照）；老数据可能只有 label 没有 qn */
  actualQuality: { qn: number | null; label: string | null } | null;
}

export interface QualityAdviceGroup {
  layoutHash: string | null;
  /** 人读标签，如 `1280×720 Main` */
  label: string;
  height: number | null;
  profile: string | null;
  durationS: number;
  /** 0..1，按时长占比（不是按段数：段长受分段策略影响，不能代表画质占比） */
  share: number;
  segmentCount: number;
  sessionCount: number;
  /** 只出现在每场开头且占比不高 → 开播初期的瞬时档位 */
  onlyAtStart: boolean;
}

export interface QualityAdvice {
  sessions: number;
  segments: number;
  totalDurationS: number;
  /** 按时长降序 */
  groups: QualityAdviceGroup[];
  recommendation: {
    layoutHash: string | null;
    label: string;
    height: number | null;
    share: number;
    stable: boolean;
  } | null;
  /** 最近一场最后一段的 height = 现在实际产出的是什么画质 */
  currentHeight: number | null;
  /** 当前设置是否已经落在推荐档位上（无法判断时为 false） */
  aligned: boolean;
  /** 给人看的结论，按重要性排序 */
  notes: string[];
}

/** `1280×720 Main`；缺字段时逐级退化，绝不返回空串 */
export function layoutLabel(seg: {
  width: number | null;
  height: number | null;
  videoProfile: string | null;
  layoutHash?: string | null;
}): string {
  const size = seg.width !== null && seg.height !== null ? `${String(seg.width)}×${String(seg.height)}` : null;
  const parts = [size, seg.videoProfile].filter((x): x is string => x !== null && x.length > 0);
  if (parts.length > 0) return parts.join(' ');
  return seg.layoutHash ?? '未知';
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

interface Bucket {
  layoutHash: string | null;
  label: string;
  height: number | null;
  profile: string | null;
  durationS: number;
  segmentCount: number;
  sessions: Set<string>;
  allEarly: boolean;
}

export function adviseQuality(input: QualityAdviceInput): QualityAdvice {
  const buckets = new Map<string, Bucket>();
  let totalDurationS = 0;
  let segmentCount = 0;
  const sessionsWithData = new Set<string>();

  for (const session of input.sessions) {
    for (const seg of session.segments) {
      // 0 秒段（刚开始写/写失败）不参与统计：它没有画质可言
      if (!(seg.durationS > 0)) continue;
      const key = seg.layoutHash ?? 'unknown';
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          layoutHash: seg.layoutHash,
          label: layoutLabel(seg),
          height: seg.height,
          profile: seg.videoProfile,
          durationS: 0,
          segmentCount: 0,
          sessions: new Set<string>(),
          allEarly: true,
        };
        buckets.set(key, bucket);
      } else if (bucket.height === null && seg.height !== null) {
        // 同一个 hash 理论上参数一致；真出现分歧时取先看到的非空值，不来回改
        bucket.height = seg.height;
        bucket.label = layoutLabel(seg);
      }
      bucket.durationS += seg.durationS;
      bucket.segmentCount += 1;
      bucket.sessions.add(session.id);
      if (seg.partNo > START_PART_NO) bucket.allEarly = false;
      totalDurationS += seg.durationS;
      segmentCount += 1;
      sessionsWithData.add(session.id);
    }
  }

  if (totalDurationS <= 0) {
    return {
      sessions: 0,
      segments: 0,
      totalDurationS: 0,
      groups: [],
      recommendation: null,
      currentHeight: null,
      aligned: false,
      notes: ['还没有可统计的分段，先录一场再说'],
    };
  }

  const groups: QualityAdviceGroup[] = [...buckets.values()]
    .map((b) => {
      const share = b.durationS / totalDurationS;
      return {
        layoutHash: b.layoutHash,
        label: b.label,
        height: b.height,
        profile: b.profile,
        durationS: b.durationS,
        segmentCount: b.segmentCount,
        sessionCount: b.sessions.size,
        onlyAtStart: b.allEarly && share < START_MAX_SHARE,
        share,
      };
    })
    .sort((a, b) => b.durationS - a.durationS);

  const top = groups[0];
  const recommendation =
    top === undefined
      ? null
      : {
          layoutHash: top.layoutHash,
          label: top.label,
          height: top.height,
          share: top.share,
          stable: top.share >= STABLE_SHARE,
        };

  // 「现在实际是什么画质」看最近一场的最后一段：那一场最后的产出才是用户拿到的
  const ordered = [...input.sessions].sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt));
  const newest = ordered[ordered.length - 1];
  const lastSeg =
    newest === undefined
      ? undefined
      : [...newest.segments].sort((a, b) => a.partNo - b.partNo).filter((s) => s.durationS > 0).at(-1);
  const currentHeight = lastSeg?.height ?? null;

  const aligned =
    currentHeight !== null && recommendation !== null && recommendation.height !== null
      ? currentHeight === recommendation.height
      : false;

  const notes: string[] = [];
  if (recommendation !== null) {
    notes.push(
      `近 ${String(sessionsWithData.size)} 场里 ${pct(recommendation.share)} 的时长是 ${recommendation.label}`,
    );
  }
  for (const g of groups) {
    if (!g.onlyAtStart) continue;
    notes.push(
      `${g.label} 只出现在每场开头，共 ${pct(g.share)}，判断为开播初期平台临时给的档位`,
    );
  }
  if (recommendation !== null && !recommendation.stable) {
    notes.push('没有哪一档占到七成，这个直播间本身就不稳定，任何固定档位都可能被拆场');
  }
  const requested = input.requestedQuality;
  if (requested === null || requested.length === 0) {
    notes.push('任务未固定画质，会跟随「房间此刻能给的最高档」，遇到开播初期的高档就会前后不一致');
  } else if (aligned) {
    notes.push(`已固定在 ${requested}，与历史稳定档位一致`);
  } else if (currentHeight !== null && recommendation !== null && recommendation.height !== null) {
    notes.push(`当前设置在 ${requested}，最近一场实际产出 ${String(currentHeight)}p，与稳定档位不同`);
  }
  if (input.actualQuality !== null && input.actualQuality.label !== null) {
    const qn = input.actualQuality.qn;
    notes.push(
      qn === null
        ? `平台最近一次给的是 ${input.actualQuality.label}`
        : `平台最近一次给的是 ${input.actualQuality.label}（qn=${String(qn)}）`,
    );
  }

  return {
    sessions: sessionsWithData.size,
    segments: segmentCount,
    totalDurationS: Math.round(totalDurationS * 1000) / 1000,
    groups,
    recommendation,
    currentHeight,
    aligned,
    notes,
  };
}
