/**
 * `session.manifest.json`：会话的自描述载体（docs/03 §7）。
 *
 * 库只是索引，manifest 与 TS 同目录 —— 库丢了也能凭它离线重建时间轴。
 * 解析刻意宽容：manifest 是历史资产，字段缺失不能让整场录制打不开。
 */
import type { EndReason, Integrity, SessionOrigin } from '@tidewatch/store';

export interface ManifestSegment {
  part_no: number;
  file: string;
  started_at: string;
  duration_s: number;
  size_bytes: number;
  video: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    pix_fmt: string | null;
  } | null;
  audio: { codec: string | null; sample_rate: number | null; channels: number | null } | null;
  layout_hash: string | null;
  integrity: Integrity;
}

export type GapCause = 'reconnect' | 'stall' | 'resolve_failed';

export interface ManifestGap {
  after_part: number;
  duration_s: number;
  cause: GapCause;
}

export interface SessionManifest {
  protocol: 1;
  session_id: string;
  task_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason?: EndReason | null;
  origin?: SessionOrigin;
  segments: ManifestSegment[];
  gaps: ManifestGap[];
  events_ref: string;
}

export function emptyManifest(input: {
  sessionId: string;
  taskId: string;
  startedAt: string;
  origin: SessionOrigin;
}): SessionManifest {
  return {
    protocol: 1,
    session_id: input.sessionId,
    task_id: input.taskId,
    started_at: input.startedAt,
    ended_at: null,
    end_reason: null,
    origin: input.origin,
    segments: [],
    gaps: [],
    events_ref: '见 SQLite events 表',
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export function parseManifest(raw: unknown): SessionManifest | null {
  if (!isObject(raw)) return null;
  const sessionId = raw['session_id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const segmentsRaw = Array.isArray(raw['segments']) ? raw['segments'] : [];
  const segments: ManifestSegment[] = [];
  for (const s of segmentsRaw) {
    if (!isObject(s)) continue;
    const file = s['file'];
    const partNo = num(s['part_no']);
    if (typeof file !== 'string' || !Number.isFinite(partNo)) continue;
    const video = isObject(s['video'])
      ? {
          codec: typeof s['video']['codec'] === 'string' ? s['video']['codec'] : null,
          profile: typeof s['video']['profile'] === 'string' ? s['video']['profile'] : null,
          width: s['video']['width'] === null ? null : num(s['video']['width']),
          height: s['video']['height'] === null ? null : num(s['video']['height']),
          pix_fmt: typeof s['video']['pix_fmt'] === 'string' ? s['video']['pix_fmt'] : null,
        }
      : null;
    const audio = isObject(s['audio'])
      ? {
          codec: typeof s['audio']['codec'] === 'string' ? s['audio']['codec'] : null,
          sample_rate: s['audio']['sample_rate'] === null ? null : num(s['audio']['sample_rate']),
          channels: s['audio']['channels'] === null ? null : num(s['audio']['channels']),
        }
      : null;
    segments.push({
      part_no: partNo,
      file,
      started_at: typeof s['started_at'] === 'string' ? s['started_at'] : '',
      duration_s: num(s['duration_s']),
      size_bytes: num(s['size_bytes']),
      video,
      audio,
      layout_hash: typeof s['layout_hash'] === 'string' ? s['layout_hash'] : null,
      integrity: (typeof s['integrity'] === 'string' ? s['integrity'] : 'ok') as Integrity,
    });
  }
  const gaps: ManifestGap[] = [];
  for (const g of Array.isArray(raw['gaps']) ? raw['gaps'] : []) {
    if (!isObject(g)) continue;
    gaps.push({
      after_part: num(g['after_part']),
      duration_s: num(g['duration_s']),
      cause: (g['cause'] === 'stall' || g['cause'] === 'resolve_failed' ? g['cause'] : 'reconnect') as GapCause,
    });
  }
  return {
    protocol: 1,
    session_id: sessionId,
    task_id: typeof raw['task_id'] === 'string' ? raw['task_id'] : '',
    started_at: typeof raw['started_at'] === 'string' ? raw['started_at'] : '',
    ended_at: typeof raw['ended_at'] === 'string' ? raw['ended_at'] : null,
    end_reason: typeof raw['end_reason'] === 'string' ? (raw['end_reason'] as EndReason) : null,
    origin: raw['origin'] === 'cap' ? 'cap' : 'new',
    segments,
    gaps,
    events_ref: '见 SQLite events 表',
  };
}
