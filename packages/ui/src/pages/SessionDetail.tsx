import { useState, type ReactNode } from 'react';
import {
  api,
  END_REASON_LABEL,
  fmtBytes,
  fmtDuration,
  fmtTime,
  INTEGRITY_LABEL,
  type Artifact,
  type Segment,
  type Session,
  type Task,
} from '../api.ts';
import { Badge, Button, Card, Empty, ErrorText, PageHeader } from '../components.tsx';
import { useAsync } from '../hooks.ts';

interface Detail {
  session: Session;
  task: Task | null;
  segments: Segment[];
  artifacts: Artifact[];
}

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface TimelineGap {
  key: string;
  afterPart: number;
  durationS: number;
  causeLabel: string;
  left: number;
  width: number;
}

interface TimelineMarker {
  key: string;
  label: string;
  ts: string;
  left: number;
}

const GAP_CAUSE_LABEL: Record<string, string> = {
  reconnect: '断流重连',
  stall: '卡死',
  resolve_failed: '解析失败',
};

const MARKER_LABEL: Record<string, string> = {
  'recording.stalled': '卡死硬杀',
  'recording.give_up': '放弃重连',
  'recording.resolve_failed': '解析失败',
  'recording.error_class': 'stderr 分类',
};

const integrityTone = (v: string): 'ok' | 'warn' | 'error' | 'info' | 'neutral' => {
  if (v === 'ok') return 'ok';
  if (v === 'recovered') return 'info';
  if (v === 'partial' || v === 'truncated') return 'warn';
  if (v === 'orphan') return 'error';
  return 'neutral';
};

export function SessionDetail({ id, tick, back }: { id: string; tick: number; back: () => void }): ReactNode {
  const detail = useAsync<Detail>(() => api.get(`/api/sessions/${id}`), [tick, id]);
  const events = useAsync<{ events: EventRow[] }>(() => api.get(`/api/sessions/${id}/events`), [tick, id]);
  const [mergeState, setMergeState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (detail.error !== null) return <ErrorText>{detail.error}</ErrorText>;
  if (detail.data === null) return <Empty>{detail.loading ? '加载中…' : '会话不存在'}</Empty>;

  const { session, task, segments, artifacts } = detail.data;
  const total = segments.reduce((n, s) => n + s.durationS, 0);
  const startMs = segments.length > 0 ? Math.min(...segments.map((s) => new Date(s.startedAt).getTime())) : 0;
  const endMs =
    segments.length > 0 ? Math.max(...segments.map((s) => new Date(s.startedAt).getTime() + s.durationS * 1000)) : 0;
  const span = Math.max(1, endMs - startMs);

  // 缺口与中断标注全部来自事件表：时间轴展示的是"事实流水"，不是前端反推
  const allEvents = events.data?.events ?? [];
  const gaps: TimelineGap[] = [];
  for (const e of allEvents) {
    if (e.kind !== 'recording.gap') continue;
    const afterPart = Number(e.payload['after_part']);
    const durationS = Number(e.payload['gap_s']);
    if (!Number.isFinite(afterPart) || !Number.isFinite(durationS) || durationS <= 0) continue;
    const seg = segments.find((s) => s.partNo === afterPart);
    if (seg === undefined) continue;
    const gapStart = new Date(seg.startedAt).getTime() + seg.durationS * 1000;
    gaps.push({
      key: `gap-${String(e.id)}`,
      afterPart,
      durationS,
      causeLabel: GAP_CAUSE_LABEL[String(e.payload['cause'])] ?? String(e.payload['cause'] ?? '中断'),
      left: ((gapStart - startMs) / span) * 100,
      width: Math.max((durationS * 1000 * 100) / span, 0.6),
    });
  }
  const gapTotalS = gaps.reduce((n, g) => n + g.durationS, 0);

  const markers: TimelineMarker[] = [];
  for (const e of allEvents) {
    const label = MARKER_LABEL[e.kind];
    if (label === undefined) continue;
    const at = new Date(e.ts).getTime();
    if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
    markers.push({ key: `m-${String(e.id)}`, label, ts: e.ts, left: ((at - startMs) / span) * 100 });
  }

  const merge = async (): Promise<void> => {
    setError(null);
    setMergeState('已提交，等待事件…');
    try {
      await api.post(`/api/sessions/${session.id}/merge`, {});
    } catch (err) {
      setMergeState(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={task?.streamerName ?? '录制会话'}
        subtitle={`${fmtTime(session.startedAt)} → ${session.endedAt === null ? '进行中' : fmtTime(session.endedAt)}`}
        actions={
          <>
            <Button variant="ghost" onClick={back}>
              ← 返回
            </Button>
            <Button variant="subtle" onClick={() => void merge()} disabled={segments.length === 0}>
              重新合并
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2 text-sm">
        <Badge tone={session.endReason === null ? 'ok' : 'neutral'}>
          {session.endReason === null ? '录制中' : (END_REASON_LABEL[session.endReason] ?? session.endReason)}
        </Badge>
        {session.origin === 'cap' && <Badge tone="info">承接上一场</Badge>}
        <Badge tone="neutral">总时长 {fmtDuration(total)}</Badge>
        <Badge tone="neutral">{String(segments.length)} 段</Badge>
        <Badge tone="neutral">{fmtBytes(segments.reduce((n, s) => n + s.sizeBytes, 0))}</Badge>
      </div>

      {error !== null && <ErrorText>{error}</ErrorText>}
      {mergeState !== null && <p className="text-xs text-sky-300">{mergeState}</p>}

      <Card title="产物">
        {artifacts.length === 0 ? (
          <Empty>还没有合并产物。会话结束后会自动合并；也可以在右上角手动触发。</Empty>
        ) : (
          <div className="space-y-3">
            {artifacts.map((a) => (
              <div key={a.path}>
                <video
                  controls
                  preload="none"
                  className="w-full rounded-lg border border-neutral-800 bg-black"
                  src={`/api/videos?path=${encodeURIComponent(a.path)}`}
                />
                <p className="mt-1 truncate text-xs text-neutral-500">
                  {a.path.split('/').pop()} · {fmtDuration(a.durationS)} · {fmtBytes(a.sizeBytes)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="时间轴"
        actions={<span className="text-[11px] text-neutral-500">斜纹 = 缺口 · 红线 = 中途中断</span>}
      >
        {segments.length === 0 ? (
          <Empty>没有分段</Empty>
        ) : (
          <div className="space-y-2">
            <div className="relative h-12 w-full overflow-hidden rounded-lg bg-neutral-800/60">
              {segments.map((s) => {
                const segStart = new Date(s.startedAt).getTime();
                const left = ((segStart - startMs) / span) * 100;
                const width = Math.max((s.durationS * 1000 * 100) / span, 0.4);
                const color =
                  s.integrity === 'ok'
                    ? 'bg-emerald-500/70'
                    : s.integrity === 'recovered'
                      ? 'bg-sky-500/70'
                      : s.integrity === 'cleaned'
                        ? 'bg-neutral-600/70'
                        : 'bg-amber-500/70';
                return (
                  <div
                    key={s.id}
                    className={`${color} absolute inset-y-1 rounded-sm`}
                    style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
                    title={`#${String(s.partNo)} ${fmtDuration(s.durationS)} · ${INTEGRITY_LABEL[s.integrity] ?? s.integrity}`}
                  />
                );
              })}

              {gaps.map((g) => (
                <div
                  key={g.key}
                  className="absolute inset-y-1 rounded-sm border border-rose-400/40"
                  style={{
                    left: `${String(g.left)}%`,
                    width: `${String(g.width)}%`,
                    backgroundImage:
                      'repeating-linear-gradient(45deg, rgba(244,63,94,0.65) 0 4px, rgba(244,63,94,0.08) 4px 8px)',
                  }}
                  title={`缺口 ${g.durationS.toFixed(1)}s · ${g.causeLabel}（第 ${String(g.afterPart)} 段之后）`}
                />
              ))}

              {markers.map((m) => (
                <div
                  key={m.key}
                  className="absolute inset-y-0 w-px bg-rose-400"
                  style={{ left: `${String(m.left)}%` }}
                  title={`${fmtTime(m.ts)} ${m.label}`}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/70" />
                完整
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-amber-500/70" />
                残缺/截断
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/70" />
                崩溃抢救
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(45deg, rgba(244,63,94,0.65) 0 2px, transparent 2px 4px)',
                  }}
                />
                缺口{gapTotalS > 0 ? `（共 ${gapTotalS.toFixed(1)}s）` : ''}
              </span>
              <span className="ml-auto">
                {fmtTime(segments[0]?.startedAt ?? null)} → {fmtTime(segments[segments.length - 1]?.startedAt ?? null)}
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card title="分段">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1.5 pr-2">#</th>
                <th className="py-1.5 pr-2">开始</th>
                <th className="py-1.5 pr-2">时长</th>
                <th className="py-1.5 pr-2">大小</th>
                <th className="py-1.5 pr-2">画面</th>
                <th className="py-1.5">完整性</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {segments.map((s) => (
                <tr key={s.id}>
                  <td className="py-1.5 pr-2 text-neutral-400">{String(s.partNo)}</td>
                  <td className="py-1.5 pr-2 text-neutral-400">{fmtTime(s.startedAt)}</td>
                  <td className="py-1.5 pr-2">{fmtDuration(s.durationS)}</td>
                  <td className="py-1.5 pr-2">{fmtBytes(s.sizeBytes)}</td>
                  <td className="py-1.5 pr-2 text-neutral-400">
                    {s.width !== null && s.height !== null ? `${String(s.width)}×${String(s.height)}` : '—'}
                    {s.videoCodec !== null ? ` ${s.videoCodec}` : ''}
                  </td>
                  <td className="py-1.5">
                    <Badge tone={integrityTone(s.integrity)}>{INTEGRITY_LABEL[s.integrity] ?? s.integrity}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="事件">
        {events.data === null ? (
          <Empty>加载中…</Empty>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-auto text-[11px]">
            {events.data.events.map((e) => (
              <li key={e.id} className="flex gap-2 text-neutral-400">
                <span className="shrink-0 text-neutral-600">{fmtTime(e.ts)}</span>
                <span className="shrink-0 text-sky-300">{e.kind}</span>
                <span className="truncate text-neutral-500">{JSON.stringify(e.payload)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
