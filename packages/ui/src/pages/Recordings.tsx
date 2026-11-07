import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  END_REASON_LABEL,
  fmtDuration,
  fmtTime,
  MERGE_STATUS_LABEL,
  type MergeJob,
  type Session,
  type Task,
} from '../api.ts';
import { Badge, Button, Card, Empty, ErrorText, PageHeader, Select } from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { PlatformMark } from '../platformMarks.tsx';

type SessionRow = Session & {
  /** 新版服务端直接带出来；旧进程没有这个字段，用任务列表兜底 */
  platform?: string | null;
  streamerName: string | null;
  durationS?: number;
  segmentCount?: number;
  hasArtifact?: boolean;
};

/**
 * 录制页同时是「合并工作台」：勾几场 → 按时间拼成一个视频。
 *
 * 勾选的先后不代表顺序 —— 合并永远按开始时间排，所以界面上不提供"上移/下移"，
 * 只把这条规则写在选择条里，省得用户以为拖动能改顺序。
 */
export function Recordings({
  tick,
  navigate,
  preselect,
}: {
  tick: number;
  navigate: (path: string) => void;
  preselect?: string | undefined;
}): ReactNode {
  const [taskId, setTaskId] = useState('');
  const tasks = useAsync<{ tasks: Task[] }>(() => api.get('/api/tasks'), [tick]);
  const sessions = useAsync<{ sessions: SessionRow[] }>(
    () => api.get(`/api/sessions?limit=100${taskId.length > 0 ? `&task=${encodeURIComponent(taskId)}` : ''}`),
    [tick, taskId],
  );
  const merges = useAsync<{ merges: MergeJob[] }>(() => api.get('/api/merges?limit=5'), [tick]);
  // 服务端没带 platform（未重启的旧进程）时按任务查，避免整列显示"未知平台"
  const platformByTask = new Map((tasks.data?.tasks ?? []).map((t) => [t.id, t.platform]));

  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从会话详情点「加入合并」过来：自动勾上那一场，且只勾一次
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || preselect === undefined || preselect.length === 0) return;
    preselected.current = true;
    setSelected((prev) => (prev.includes(preselect) ? prev : [...prev, preselect]));
  }, [preselect]);

  const toggle = (id: string): void => {
    setError(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async (): Promise<void> => {
    if (selected.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ job: { id: string } }>('/api/merges', { sessionIds: selected });
      setSelected([]);
      navigate(`merge/${res.job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = sessions.data?.sessions ?? [];
  const selectedSet = new Set(selected);

  return (
    <div className="space-y-4">
      <PageHeader
        title="录制"
        subtitle="每一场是一个会话；点进去看分段、缺口与产物。勾选多场可拼成一个视频。"
        actions={
          <Select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="w-48">
            <option value="">全部任务</option>
            {(tasks.data?.tasks ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.streamerName ?? t.url}
              </option>
            ))}
          </Select>
        }
      />

      {error !== null && <ErrorText>{error}</ErrorText>}

      <Card>
        {sessions.data === null && sessions.loading && <Empty>加载中…</Empty>}
        {sessions.data !== null && rows.length === 0 && <Empty>还没有录制会话。</Empty>}
        {sessions.data !== null && rows.length > 0 && (
          <ul className="divide-y divide-neutral-800">
            {rows.map((s) => {
              const open = s.endReason === null;
              const picked = selectedSet.has(s.id);
              return (
                <li key={s.id} className={`flex items-center gap-3 py-3 ${picked ? 'bg-sky-500/5' : ''}`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-sky-500 disabled:opacity-30"
                    checked={picked}
                    disabled={open}
                    title={open ? '还在录制，结束后才能合并' : '加入合并'}
                    onChange={() => toggle(s.id)}
                    aria-label={`选择会话 ${s.id}`}
                  />
                  <button
                    onClick={() => navigate(`session/${s.id}`)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left hover:bg-neutral-800/40"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <PlatformMark platform={s.platform ?? platformByTask.get(s.taskId) ?? null} />
                        <span className="truncate text-sm font-medium">{s.streamerName ?? s.taskId.slice(0, 8)}</span>
                        {s.origin === 'cap' && <Badge tone="info">承接上一场</Badge>}
                        {s.hasArtifact && <Badge tone="ok">已合并</Badge>}
                        {open && <Badge tone="ok">录制中</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        {fmtTime(s.startedAt)} → {s.endedAt === null ? '进行中' : fmtTime(s.endedAt)} ·{' '}
                        {fmtDuration(s.durationS ?? 0)} ·{' '}
                        {/* 进行中的场次在第一段封口前就是 0 段，写"0 段"像是没在录 */}
                        {open && (s.segmentCount ?? 0) === 0
                          ? '首段录制中'
                          : `${String(s.segmentCount ?? 0)} 段`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-neutral-400">
                      {s.endReason === null ? '—' : (END_REASON_LABEL[s.endReason] ?? s.endReason)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {(merges.data?.merges.length ?? 0) > 0 && (
        <Card title="最近合并">
          <ul className="divide-y divide-neutral-800">
            {(merges.data?.merges ?? []).map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => navigate(`merge/${m.id}`)}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left text-xs hover:bg-neutral-800/40"
                >
                  <span className="min-w-0 truncate text-neutral-300">
                    {String(m.sessionIds.length)} 场 · {fmtDuration(m.outputs.reduce((n, o) => n + o.durationS, 0))}
                    {m.status === 'running' && ` · ${String(Math.round(m.progress * 100))}%`}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={m.status === 'completed' ? 'ok' : m.status === 'failed' ? 'error' : m.status === 'skipped' ? 'warn' : 'info'}>
                      {MERGE_STATUS_LABEL[m.status]}
                    </Badge>
                    <span className="text-neutral-500">{fmtTime(m.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {selected.length > 0 && (
        <div className="sticky bottom-16 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 p-3 shadow-lg backdrop-blur lg:bottom-4">
          <span className="text-sm">
            已选 <span className="font-medium text-sky-300">{String(selected.length)}</span> 场
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">
            按开始时间顺序拼接；流参数不同的部分会分开输出
          </span>
          <Button variant="ghost" onClick={() => setSelected([])} disabled={busy}>
            清空
          </Button>
          <Button onClick={() => void submit()} disabled={busy || selected.length < 2}>
            {busy ? '提交中…' : `合并 ${String(selected.length)} 场`}
          </Button>
        </div>
      )}
    </div>
  );
}
