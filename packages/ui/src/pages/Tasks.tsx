import { useMemo, useState, type ReactNode } from 'react';
import { api, type Task } from '../api.ts';
import { Empty, Input, PageHeader } from '../components.tsx';import { useAsync } from '../hooks.ts';
import {
  AddTaskCard,
  TaskEditor,
  TaskList,
  TIER_LABEL,
  TIER_ORDER,
  sortTasks,
  taskTier,
  type Tier,
} from '../taskViews.tsx';

type Filter = 'all' | Tier;

const FILTERS: readonly Filter[] = ['all', ...TIER_ORDER];

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  recording: '录制中',
  attention: '需处理',
  monitoring: '监控中',
  paused: '已暂停',
};

/** 搜主播名、房间标题、地址、平台 key —— 房间多了以后靠记 id 是找不动的 */
function matches(task: Task, q: string): boolean {
  if (q.length === 0) return true;
  return [task.streamerName, task.title, task.url, task.platform]
    .filter((v): v is string => v !== null)
    .some((v) => v.toLowerCase().includes(q));
}

export function Tasks({ tick, navigate }: { tick: number; navigate: (path: string) => void }): ReactNode {
  const tasks = useAsync<{ tasks: Task[] }>(() => api.get('/api/tasks'), [tick]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<Task | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  const all = tasks.data?.tasks ?? [];
  const query = q.trim().toLowerCase();

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: all.length, recording: 0, attention: 0, monitoring: 0, paused: 0 };
    for (const t of all) base[taskTier(t)] += 1;
    return base;
  }, [all]);

  const shown = useMemo(
    () => sortTasks(all.filter((t) => matches(t, query) && (filter === 'all' || taskTier(t) === filter))),
    [all, query, filter],
  );

  const groups = useMemo(
    () =>
      TIER_ORDER.map((tier) => ({ tier, rows: shown.filter((t) => taskTier(t) === tier) })).filter(
        (g) => g.rows.length > 0,
      ),
    [shown],
  );

  const reload = (): void => tasks.reload();

  return (
    <div className="space-y-4">
      <PageHeader
        title="任务"
        subtitle={
          all.length === 0
            ? '还没有任务'
            : `${String(all.length)} 个任务 · ${String(counts.recording)} 个在录 · ${String(counts.attention)} 个需处理`
        }
      />

      <AddTaskCard
        onSettled={(taskId) => {
          // 新加/重复的这条可能被搜索或筛选挡住，先复位再刷新
          if (taskId !== null) {
            setQ('');
            setFilter('all');
            setHighlight(taskId);
          }
          reload();
        }}
      />

      <div className="sticky top-0 z-20 space-y-2 rounded-2xl border border-neutral-800 bg-neutral-950/95 p-3 backdrop-blur">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索主播名、标题或地址"
          aria-label="搜索任务"
        />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((key) => {
            const active = key === filter;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-lg px-2.5 py-1 text-xs ${
                  active
                    ? 'bg-sky-500 text-white'
                    : 'border border-neutral-800 text-neutral-400 hover:bg-neutral-800/60'
                }`}
              >
                {FILTER_LABEL[key]}
                <span className={`ml-1 ${active ? 'text-white/70' : 'text-neutral-600'}`}>{counts[key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {tasks.data === null && tasks.loading && <Empty>正在加载任务…</Empty>}
      {tasks.data !== null && all.length === 0 && (
        <Empty>还没有任务。在上面填一个直播间地址，开播后会自动录制。</Empty>
      )}
      {tasks.data !== null && all.length > 0 && shown.length === 0 && (
        <Empty>
          没有匹配的任务。
          <button
            className="ml-1 text-sky-300 hover:underline"
            onClick={() => {
              setQ('');
              setFilter('all');
            }}
          >
            清空筛选
          </button>
        </Empty>
      )}

      {groups.map((group) => (
        <section key={group.tier} className="space-y-2">
          <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-neutral-400">
            {TIER_LABEL[group.tier]}
            <span className="text-neutral-600">{group.rows.length}</span>
          </h2>
          <TaskList
            tasks={group.rows}
            highlightId={highlight}
            onChanged={reload}
            onEdit={setEditing}
            onOpenSession={(id) => {
              if (id.length > 0) navigate(`session/${id}`);
            }}
          />
        </section>
      ))}

      {all.length > 0 && shown.length > 0 && shown.length < all.length && (
        <p className="text-center text-xs text-neutral-500">
          已筛出 {shown.length} / {all.length} 个任务
          <button
            className="ml-2 text-sky-300 hover:underline"
            onClick={() => {
              setQ('');
              setFilter('all');
            }}
          >
            显示全部
          </button>
        </p>
      )}

      {editing !== null && (
        <TaskEditor
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onDeleted={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
