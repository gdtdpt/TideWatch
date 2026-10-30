import { useState, type ReactNode } from 'react';
import { api, END_REASON_LABEL, fmtDuration, fmtTime, type Session, type Task } from '../api.ts';
import { Badge, Card, Empty, PageHeader, Select } from '../components.tsx';
import { useAsync } from '../hooks.ts';

type SessionRow = Session & { streamerName: string | null; durationS?: number; segmentCount?: number; hasArtifact?: boolean };

export function Recordings({ tick, navigate }: { tick: number; navigate: (path: string) => void }): ReactNode {
  const [taskId, setTaskId] = useState('');
  const tasks = useAsync<{ tasks: Task[] }>(() => api.get('/api/tasks'), [tick]);
  const sessions = useAsync<{ sessions: SessionRow[] }>(
    () => api.get(`/api/sessions?limit=100${taskId.length > 0 ? `&task=${encodeURIComponent(taskId)}` : ''}`),
    [tick, taskId],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="录制"
        subtitle="每一场是一个会话；点进去看分段、缺口与产物"
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

      <Card>
        {sessions.data === null && sessions.loading && <Empty>加载中…</Empty>}
        {sessions.data !== null && sessions.data.sessions.length === 0 && <Empty>还没有录制会话。</Empty>}
        {sessions.data !== null && sessions.data.sessions.length > 0 && (
          <ul className="divide-y divide-neutral-800">
            {sessions.data.sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => navigate(`session/${s.id}`)}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-neutral-800/40"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.streamerName ?? s.taskId.slice(0, 8)}</span>
                      {s.origin === 'cap' && <Badge tone="info">承接上一场</Badge>}
                      {s.hasArtifact && <Badge tone="ok">已合并</Badge>}
                      {s.endReason === null && <Badge tone="ok">录制中</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-neutral-500">
                      {fmtTime(s.startedAt)} → {s.endedAt === null ? '进行中' : fmtTime(s.endedAt)} ·{' '}
                      {fmtDuration(s.durationS ?? 0)} · {String(s.segmentCount ?? 0)} 段
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-neutral-400">
                    {s.endReason === null ? '—' : (END_REASON_LABEL[s.endReason] ?? s.endReason)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
