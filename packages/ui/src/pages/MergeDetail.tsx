import { useState, type ReactNode } from 'react';
import {
  api,
  fmtBytes,
  fmtDuration,
  fmtTime,
  MERGE_STATUS_LABEL,
  type MergeJob,
  type MergeSource,
} from '../api.ts';
import { Badge, Button, Card, Empty, ErrorText, PageHeader } from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { PlatformMark } from '../platformMarks.tsx';

interface Detail {
  merge: MergeJob;
  sources: MergeSource[];
}

const statusTone = (s: MergeJob['status']): 'ok' | 'warn' | 'error' | 'info' | 'neutral' => {
  if (s === 'completed') return 'ok';
  if (s === 'failed') return 'error';
  if (s === 'skipped') return 'warn';
  if (s === 'running') return 'info';
  return 'neutral';
};

/**
 * 合并任务页：进度 + 产物 + 缺口。
 *
 * 缺口是这一页存在的核心理由 —— 拼接把"中途没录到的两小时"变成了文件里
 * 一个看不见的跳变，不标出来，用户会以为录像完整。
 */
export function MergeDetail({
  id,
  tick,
  navigate,
  back,
}: {
  id: string;
  tick: number;
  navigate: (path: string) => void;
  back: () => void;
}): ReactNode {
  const detail = useAsync<Detail>(() => api.get(`/api/merges/${id}`), [tick, id]);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detail.error !== null) return <ErrorText>{detail.error}</ErrorText>;
  if (detail.data === null) return <Empty>{detail.loading ? '加载中…' : '合并任务不存在'}</Empty>;

  const { merge, sources } = detail.data;
  const running = merge.status === 'queued' || merge.status === 'running';
  const totalS = merge.outputs.reduce((n, o) => n + o.durationS, 0);
  const totalBytes = merge.outputs.reduce((n, o) => n + o.sizeBytes, 0);
  const labelOf = (sessionId: string): string => {
    const idx = sources.findIndex((s) => s.id === sessionId);
    const src = sources[idx];
    if (src === undefined) return '未知场次';
    const who = src.streamerName ?? '录制会话';
    return `第 ${String(idx + 1)} 场（${who} ${fmtTime(src.startedAt)}）`;
  };

  const retry = async (): Promise<void> => {
    setRetrying(true);
    setError(null);
    try {
      const res = await api.post<{ job: { id: string } }>('/api/merges', { sessionIds: merge.sessionIds });
      navigate(`merge/${res.job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="跨会话合并"
        subtitle={`${String(merge.sessionIds.length)} 场 · 创建于 ${fmtTime(merge.createdAt)}`}
        actions={
          <>
            <Button variant="ghost" onClick={back}>
              ← 返回
            </Button>
            {!running && (merge.status === 'failed' || merge.status === 'skipped') && (
              <Button variant="subtle" onClick={() => void retry()} disabled={retrying}>
                {retrying ? '提交中…' : '重试'}
              </Button>
            )}
          </>
        }
      />

      {error !== null && <ErrorText>{error}</ErrorText>}

      <Card>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={statusTone(merge.status)}>{MERGE_STATUS_LABEL[merge.status]}</Badge>
          {merge.outputs.length > 0 && <Badge tone="neutral">{fmtDuration(totalS)}</Badge>}
          {merge.outputs.length > 0 && <Badge tone="neutral">{fmtBytes(totalBytes)}</Badge>}
          {merge.planned > 1 && <Badge tone="info">{String(merge.planned)} 组产物</Badge>}
          {merge.gaps.length > 0 && (
            <Badge tone="warn" title="合并后的文件里，这些时间段是缺失的">
              缺口 {fmtDuration(merge.gaps.reduce((n, g) => n + g.durationS, 0))}
            </Badge>
          )}
        </div>

        {running && (
          <div className="mt-3 space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{ width: `${String(Math.max(2, Math.round(merge.progress * 100)))}%` }}
              />
            </div>
            <p className="text-[11px] text-neutral-500">
              {merge.status === 'queued'
                ? '排队中，前一个合并结束后开始'
                : `已完成 ${String(merge.done)}/${String(merge.planned || 1)} 组 · ${String(Math.round(merge.progress * 100))}%`}
              。可以关掉页面，进度存在服务端。
            </p>
          </div>
        )}

        {merge.message !== null && (
          <p className={`mt-2 text-xs ${merge.status === 'failed' ? 'text-rose-300' : 'text-neutral-400'}`}>
            {merge.message}
          </p>
        )}

        {merge.status === 'skipped' && (
          <p className="mt-2 text-xs text-neutral-500">
            源分段都还在，处理好磁盘/分段后可以点「重试」。
          </p>
        )}
      </Card>

      {merge.gaps.length > 0 && (
        <Card title="缺口">
          <ul className="space-y-1 text-xs text-neutral-400">
            {merge.gaps.map((g) => (
              <li key={`${g.afterSessionId}-${g.beforeSessionId}`} className="flex flex-wrap gap-x-2">
                <span className="text-amber-300">{fmtDuration(g.durationS)}</span>
                <span className="min-w-0">
                  {labelOf(g.afterSessionId)} 结束后 → {labelOf(g.beforeSessionId)} 开始前，这段时间没有录到
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="产物">
        {merge.outputs.length === 0 ? (
          <Empty>{running ? '合并中，完成后这里会出现视频' : '还没有产物'}</Empty>
        ) : (
          <div className="space-y-4">
            {merge.outputs.map((o) => (
              <div key={o.path}>
                <video
                  controls
                  preload="none"
                  className="w-full rounded-lg border border-neutral-800 bg-black"
                  src={`/api/videos?path=${encodeURIComponent(o.path)}`}
                />
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
                  <span className="min-w-0 truncate">{o.path.split('/').pop()}</span>
                  <span>· {fmtDuration(o.durationS)}</span>
                  <span>· {fmtBytes(o.sizeBytes)}</span>
                  <span>· {String(o.segmentCount)} 段</span>
                  {merge.outputs.length > 1 && <Badge tone="info">第 {String(o.group)} 组</Badge>}
                </p>
              </div>
            ))}
            {merge.outputs.length > 1 && (
              <p className="text-[11px] text-neutral-500">
                流参数（分辨率/编码）不同的部分分开输出，直接拼接会在拼接点出错。
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="源会话">
        <ul className="divide-y divide-neutral-800">
          {sources.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => navigate(`session/${s.id}`)}
                disabled={s.missing}
                /* 窄屏上下两行：把"时间 · 时长 · 段数"挤在同一行会把姓名压成两个字 */
                className="flex w-full flex-col gap-0.5 py-2 text-left hover:bg-neutral-800/40 disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PlatformMark platform={s.platform} />
                  <span className="truncate text-sm">{s.streamerName ?? '录制会话'}</span>
                  {s.missing && <Badge tone="error">已删除</Badge>}
                </span>
                <span className="text-xs text-neutral-500 sm:shrink-0">
                  {fmtTime(s.startedAt)} → {fmtTime(s.endedAt)} · {fmtDuration(s.durationS)} · {String(s.segmentCount)} 段
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
