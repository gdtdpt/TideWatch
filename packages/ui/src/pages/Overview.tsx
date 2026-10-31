import { useState, type ReactNode } from 'react';
import {
  api,
  END_REASON_LABEL,
  fmtBytes,
  fmtDuration,
  fmtTime,
  type Health,
  type Session,
  type Task,
} from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader } from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { AddTaskCard, TaskEditor, TaskList, sortTasks } from '../taskViews.tsx';

/** 总览只放"一眼要看到的东西"：状态、入口、最近几条。全量在「任务」页。 */
const PREVIEW_COUNT = 6;
const RECENT_COUNT = 6;

export function Overview({ tick, navigate }: { tick: number; navigate: (path: string) => void }): ReactNode {
  const health = useAsync<Health>(() => api.get('/api/health'), [tick]);
  const tasks = useAsync<{ tasks: Task[] }>(() => api.get('/api/tasks'), [tick]);
  const sessions = useAsync<{ sessions: (Session & { streamerName: string | null })[] }>(
    () => api.get('/api/sessions?limit=20'),
    [tick],
  );
  const [highlight, setHighlight] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  const all = tasks.data?.tasks ?? [];
  const sorted = sortTasks(all);
  const preview = sorted.slice(0, PREVIEW_COUNT);
  // 刚添加/重复的那条如果排在 6 条之外，临时提到最前面 —— 否则提示"已为你标出来"却看不见
  if (highlight !== null && !preview.some((t) => t.id === highlight)) {
    const hit = all.find((t) => t.id === highlight);
    if (hit !== undefined) preview.unshift(hit);
  }
  const liveCount = all.filter((t) => t.runtime.state === 'recording' || t.runtime.state === 'reconnecting').length;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todays = (sessions.data?.sessions ?? []).filter((s) => new Date(s.startedAt).getTime() >= today.getTime());

  return (
    <div className="space-y-4">
      <PageHeader
        title="总览"
        subtitle={`${String(all.length)} 个任务 · ${String(liveCount)} 个在录 · 今天 ${String(todays.length)} 场`}
        actions={
          <Button variant="ghost" onClick={() => navigate('tasks')}>
            全部任务
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="服务" value={health.data?.version ?? '—'} hint={health.data?.platform ?? ''} />
        <Stat
          label="引擎"
          value={health.data?.engine === true ? '运行中' : '未运行'}
          hint={health.data?.lease.note ?? '租约正常'}
          tone={health.data?.engine === true ? 'ok' : 'warn'}
        />
        <Stat label="磁盘可用" value={fmtBytes(health.data?.freeBytes ?? null)} hint={health.data?.paths.outputRoot ?? ''} />
        <Stat
          label="今日录制"
          value={fmtDuration(todays.reduce((n, s) => n + (s.durationS ?? 0), 0))}
          hint={`${String(todays.length)} 场`}
        />
      </div>

      <AddTaskCard
        onSettled={(taskId) => {
          if (taskId !== null) setHighlight(taskId);
          tasks.reload();
        }}
      />

      <Card
        title="最近任务"
        actions={
          <button className="text-xs text-sky-300 hover:underline" onClick={() => navigate('tasks')}>
            全部 {all.length} 个 →
          </button>
        }
      >
        {tasks.data === null && tasks.loading && <Empty>正在加载任务…</Empty>}
        {tasks.data !== null && all.length === 0 && (
          <Empty>还没有任务。填一个直播间地址，开播后会自动录制。</Empty>
        )}
        {preview.length > 0 && (
          <TaskList
            tasks={preview}
            onChanged={() => tasks.reload()}
            onEdit={setEditing}
            onOpenSession={(id) => {
              if (id.length > 0) navigate(`session/${id}`);
            }}
          />
        )}
        {all.length > preview.length && (
          <p className="mt-2 text-center text-[11px] text-neutral-500">
            这里只显示 {preview.length} 个，其余 {all.length - preview.length} 个在「任务」页
          </p>
        )}
      </Card>

      {sessions.data !== null && sessions.data.sessions.length > 0 && (
        <Card title="最近录制">
          <ul className="divide-y divide-neutral-800 text-sm">
            {sessions.data.sessions.slice(0, RECENT_COUNT).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <button className="min-w-0 text-left hover:text-sky-300" onClick={() => navigate(`session/${s.id}`)}>
                  <span className="truncate">{s.streamerName ?? s.taskId.slice(0, 8)}</span>
                  <span className="ml-2 text-xs text-neutral-500">{fmtTime(s.startedAt)}</span>
                </button>
                <Badge tone={s.endReason === 'capped' ? 'info' : s.endReason === null ? 'ok' : 'neutral'}>
                  {s.endReason === null ? '录制中' : (END_REASON_LABEL[s.endReason] ?? s.endReason)}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editing !== null && (
        <TaskEditor
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            tasks.reload();
          }}
          onDeleted={() => {
            setEditing(null);
            tasks.reload();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'ok' | 'warn' | 'neutral';
}): ReactNode {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : ''}`}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-neutral-600">{hint}</p>
    </div>
  );
}
