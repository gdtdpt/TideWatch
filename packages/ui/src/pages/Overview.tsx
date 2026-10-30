import { useState, type ReactNode } from 'react';
import {
  api,
  END_REASON_LABEL,
  fmtBytes,
  fmtDuration,
  fmtTime,
  STATE_LABEL,
  type Health,
  type Session,
  type Task,
} from '../api.ts';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Modal, PageHeader, Select, Toggle } from '../components.tsx';
import { useAsync, useNow } from '../hooks.ts';

const stateTone = (state: string): 'ok' | 'warn' | 'error' | 'info' | 'neutral' => {
  if (state === 'recording') return 'ok';
  if (state === 'reconnecting' || state === 'resolving' || state === 'finalizing') return 'info';
  if (state === 'waiting' || state === 'snoozed' || state === 'idle') return 'neutral';
  return 'error';
};

export function Overview({ tick, navigate }: { tick: number; navigate: (path: string) => void }): ReactNode {
  const health = useAsync<Health>(() => api.get('/api/health'), [tick]);
  const tasks = useAsync<{ tasks: Task[] }>(() => api.get('/api/tasks'), [tick]);
  const sessions = useAsync<{ sessions: (Session & { streamerName: string | null })[] }>(
    () => api.get('/api/sessions?limit=20'),
    [tick],
  );
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const now = useNow();

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/tasks', { url: url.trim(), monitor: true });
      setUrl('');
      tasks.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      tasks.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todays = (sessions.data?.sessions ?? []).filter((s) => new Date(s.startedAt).getTime() >= today.getTime());

  return (
    <div className="space-y-4">
      <PageHeader
        title="总览"
        subtitle={`${String(tasks.data?.tasks.length ?? 0)} 个任务 · 今天 ${String(todays.length)} 场`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

      <Card title="添加直播间">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://live.douyin.com/… / https://live.bilibili.com/… / .m3u8 直链"
          />
          <Button onClick={() => void add()} disabled={busy || url.trim().length === 0} className="sm:w-28">
            {busy ? '解析中…' : '添加'}
          </Button>
        </div>
        {error !== null && <div className="mt-2"><ErrorText>{error}</ErrorText></div>}
      </Card>

      {tasks.data === null && tasks.loading && <Empty>正在加载任务…</Empty>}
      {tasks.data !== null && tasks.data.tasks.length === 0 && (
        <Empty>还没有任务。填一个直播间地址，开播后会自动录制。</Empty>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {(tasks.data?.tasks ?? []).map((task) => {
          const runtime = task.runtime;
          const recording = runtime.state === 'recording' || runtime.state === 'reconnecting';
          const elapsed = recording ? (now - new Date(runtime.updatedAt).getTime()) / 1000 : 0;
          return (
            <Card key={task.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-medium">{task.streamerName ?? '未命名直播间'}</h3>
                    <Badge tone={stateTone(runtime.state)}>{STATE_LABEL[runtime.state] ?? runtime.state}</Badge>
                    {task.recordRequested && <Badge tone="info">已请求录制</Badge>}
                    {task.skipCurrentLive && <Badge>本场已跳过</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">{task.title ?? task.url}</p>
                  {runtime.detail !== null && <p className="mt-1 truncate text-xs text-neutral-400">{runtime.detail}</p>}
                  {recording && elapsed > 0 && (
                    <p className="mt-1 text-xs text-emerald-300">已录 {fmtDuration(elapsed)}（当前连接）</p>
                  )}
                  <p className="mt-2 text-[11px] text-neutral-500">
                    {task.latestSession !== null
                      ? `上一场 ${fmtTime(task.latestSession.startedAt)} · ${END_REASON_LABEL[task.latestSession.endReason ?? ''] ?? '进行中'}`
                      : '还没有录制记录'}
                    {' · '}画质 {task.quality ?? '默认'}
                    {' · '}分段 {fmtDuration(task.segmentTimeS)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="flex items-center gap-1 text-xs text-neutral-400">
                    监控
                    <Toggle
                      checked={task.monitorEnabled}
                      label="监控开关"
                      onChange={(next) => void act(() => api.post(`/api/tasks/${task.id}/monitor`, { enabled: next }))}
                    />
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {recording ? (
                  <Button variant="danger" onClick={() => void act(() => api.post(`/api/tasks/${task.id}/record`, { recording: false }))}>
                    停止录制
                  </Button>
                ) : (
                  <Button variant="subtle" onClick={() => void act(() => api.post(`/api/tasks/${task.id}/record`, { recording: true }))}>
                    开始录制
                  </Button>
                )}
                <Button variant="ghost" onClick={() => void act(() => api.post(`/api/tasks/${task.id}/check`))}>
                  立即检查
                </Button>
                <Button variant="ghost" onClick={() => setEditing(task)}>
                  设置
                </Button>
                <Button variant="ghost" onClick={() => navigate(`session/${task.latestSession?.id ?? ''}`)} disabled={task.latestSession === null}>
                  最近一场
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!window.confirm(`删除任务「${task.streamerName ?? task.url}」？这会同时移除它的录制历史索引（磁盘上的视频文件保留）。`)) return;
                    void act(() => api.del(`/api/tasks/${task.id}`));
                  }}
                >
                  删除
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {sessions.data !== null && sessions.data.sessions.length > 0 && (
        <Card title="最近录制">
          <ul className="divide-y divide-neutral-800 text-sm">
            {sessions.data.sessions.slice(0, 6).map((s) => (
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

function TaskEditor({
  task,
  onClose,
  onSaved,
}: {
  task: Task;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [quality, setQuality] = useState(task.quality ?? '');
  const [segmentTimeS, setSegmentTimeS] = useState(task.segmentTimeS);
  const [postprocess, setPostprocess] = useState(task.postprocess);
  const [maxSessionS, setMaxSessionS] = useState(task.maxSessionS);
  const [maxSessionBytes, setMaxSessionBytes] = useState(Math.round(task.maxSessionBytes / 1024 ** 2));
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.patch(`/api/tasks/${task.id}`, {
        quality,
        segmentTimeS,
        postprocess,
        maxSessionS,
        maxSessionBytes: maxSessionBytes * 1024 ** 2,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal title={`任务设置 · ${task.streamerName ?? ''}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="画质（由插件解释）" hint={task.qualityOptions.length > 0 ? `可选：${task.qualityOptions.join(' / ')}` : '该房间还没解析出可选档位'}>
          <Input value={quality} onChange={(e) => setQuality(e.target.value)} placeholder="原画 / OD / 留空用平台默认" />
        </Field>
        <Field label="分段时长（秒）" hint="下一次开录生效；30..43200">
          <Input
            type="number"
            value={segmentTimeS}
            onChange={(e) => setSegmentTimeS(Number(e.target.value))}
            min={30}
            max={43200}
          />
        </Field>
        <Field label="后处理" hint="会话收尾时读取，因此录到一半改成 manual 也有效">
          <Select value={postprocess} onChange={(e) => setPostprocess(e.target.value as Task['postprocess'])}>
            <option value="merge">合并为一个 MP4</option>
            <option value="per_segment">每段独立 MP4</option>
            <option value="manual">只落 TS，手动触发</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="单场时长上限（秒）" hint="0 = 默认 6 小时；600..21600">
            <Input type="number" value={maxSessionS} onChange={(e) => setMaxSessionS(Number(e.target.value))} min={0} />
          </Field>
          <Field label="单场体积上限（MiB）" hint="0 = 默认 20 GiB">
            <Input
              type="number"
              value={maxSessionBytes}
              onChange={(e) => setMaxSessionBytes(Number(e.target.value))}
              min={0}
            />
          </Field>
        </div>
        {error !== null && <ErrorText>{error}</ErrorText>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()}>保存</Button>
        </div>
      </div>
    </Modal>
  );
}
