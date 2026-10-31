/**
 * 任务的三种展示形态（添加卡 / 单行 / 设置弹窗）都在这里。
 * 总览只放最近几条，任务页放全量 —— 两份界面共用同一套组件，
 * 免得密度、措辞、按钮行为各改一遍后两边不一致。
 */
import { useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  END_REASON_LABEL,
  fmtDuration,
  fmtTime,
  STATE_LABEL,
  type Task,
} from './api.ts';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Select, Toggle } from './components.tsx';
import { useNow } from './hooks.ts';

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral';

export function stateTone(state: string): Tone {
  if (state === 'recording') return 'ok';
  if (state === 'reconnecting' || state === 'resolving' || state === 'finalizing') return 'info';
  if (state === 'waiting' || state === 'snoozed' || state === 'idle') return 'neutral';
  return 'error';
}

/** 分档只用于排序与分组：录制中的永远排最前，出错的需要人管 */
export type Tier = 'recording' | 'attention' | 'monitoring' | 'paused';

export const TIER_ORDER: readonly Tier[] = ['recording', 'attention', 'monitoring', 'paused'];

export const TIER_LABEL: Record<Tier, string> = {
  recording: '正在录制',
  attention: '需要处理',
  monitoring: '监控中',
  paused: '已暂停',
};

export function taskTier(task: Task): Tier {
  const state = task.runtime.state;
  if (state === 'recording' || state === 'reconnecting' || state === 'finalizing') return 'recording';
  if (state === 'error' || state === 'needs_auth' || state === 'needs_dep' || state === 'unsupported') {
    return 'attention';
  }
  if (!task.monitorEnabled || state === 'idle') return 'paused';
  return 'monitoring';
}

/** 录制中优先，其次按最近活动倒序 —— 总览的 6 条与任务页的分组都用这个 */
export function sortTasks(tasks: readonly Task[]): Task[] {
  const rank = (t: Task): number => TIER_ORDER.indexOf(taskTier(t));
  return [...tasks].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function AddTaskCard({ onSettled }: { onSettled: (taskId: string | null) => void }): ReactNode {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let created: string | null = null;
    try {
      // 插件探测是外网请求，给个上限：卡住时要说"等超时了"，不能一直转圈
      const res = await api.post<{ task: Task }>('/api/tasks', { url: url.trim(), monitor: true }, 60_000);
      created = res.task.id;
      setUrl('');
      setNotice('已加入监控，列表里已经能看到它。');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // 不是失败：任务早就在了（可能上一次"看起来失败"其实已入库）
        const detail = err.detail;
        created =
          typeof detail === 'object' && detail !== null && 'taskId' in detail
            ? String((detail as { taskId: unknown }).taskId)
            : null;
        setUrl('');
        setNotice('这个地址已经在任务里了，已为你标出来。');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      // 成功失败都要刷新：上一次可能"客户端失败、服务端已建成"
      onSettled(created);
    }
  };

  return (
    <Card title="添加直播间">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://live.douyin.com/… / https://live.bilibili.com/… / .m3u8 直链"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && url.trim().length > 0) void add();
          }}
        />
        <Button onClick={() => void add()} disabled={busy || url.trim().length === 0} className="shrink-0 sm:w-28">
          {busy ? '解析中…' : '添加'}
        </Button>
      </div>
      {error !== null && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {notice !== null && <p className="mt-2 text-xs text-sky-300">{notice}</p>}
    </Card>
  );
}

export function TaskRow({
  task,
  onChanged,
  onEdit,
  onOpenSession,
}: {
  task: Task;
  onChanged: () => void;
  onEdit: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
}): ReactNode {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runtime = task.runtime;
  const recording = runtime.state === 'recording' || runtime.state === 'reconnecting';
  const elapsed = recording ? (now - new Date(runtime.updatedAt).getTime()) / 1000 : 0;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone={stateTone(runtime.state)}>{STATE_LABEL[runtime.state] ?? runtime.state}</Badge>
            <span className="truncate text-sm font-medium">{task.streamerName ?? '未命名直播间'}</span>
            {task.recordRequested && !recording && <Badge tone="info">已请求录制</Badge>}
            {/* state=snoozed 的徽标已经写着"本场已跳过"，别重复两遍 */}
            {task.skipCurrentLive && runtime.state !== 'snoozed' && <Badge>本场已跳过</Badge>}
            {/* state=idle 的徽标已经写着"未监控"，别重复两遍 */}
            {!task.monitorEnabled && runtime.state !== 'idle' && <Badge tone="warn">未监控</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{task.title ?? task.url}</p>
          {runtime.detail !== null && <p className="mt-0.5 truncate text-xs text-neutral-400">{runtime.detail}</p>}
          <p className="mt-0.5 truncate text-[11px] text-neutral-600">
            {task.latestSession !== null ? (
              <>
                <button
                  className="hover:text-sky-300"
                  onClick={() => onOpenSession(task.latestSession?.id ?? '')}
                  title="打开最近一场"
                >
                  上一场 {fmtTime(task.latestSession.startedAt)} ·{' '}
                  {END_REASON_LABEL[task.latestSession.endReason ?? ''] ?? '进行中'}
                </button>
                {' · '}
              </>
            ) : (
              '还没有录制记录 · '
            )}
            画质 {task.quality ?? '默认'} · 分段 {fmtDuration(task.segmentTimeS)}
            {recording && elapsed > 0 && ` · 已录 ${fmtDuration(elapsed)}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs text-neutral-400">
            监控
            <Toggle
              checked={task.monitorEnabled}
              label="监控开关"
              disabled={busy}
              onChange={(next) => void act(() => api.post(`/api/tasks/${task.id}/monitor`, { enabled: next }))}
            />
          </span>
          <Button
            variant={recording ? 'danger' : 'subtle'}
            className="px-2 py-1 text-xs"
            disabled={busy}
            onClick={() => void act(() => api.post(`/api/tasks/${task.id}/record`, { recording: !recording }))}
          >
            {recording ? '停止录制' : '开始录制'}
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={busy}
            onClick={() => void act(() => api.post(`/api/tasks/${task.id}/check`))}
          >
            检查
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onEdit(task)}>
            设置
          </Button>
        </div>
      </div>
      {error !== null && (
        <div className="mt-1">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </li>
  );
}

export function TaskList({
  tasks,
  onChanged,
  onEdit,
  onOpenSession,
}: {
  tasks: readonly Task[];
  onChanged: () => void;
  onEdit: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
}): ReactNode {
  return (
    <ul className="divide-y divide-neutral-800">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onChanged={onChanged}
          onEdit={onEdit}
          onOpenSession={onOpenSession}
        />
      ))}
    </ul>
  );
}

export function TaskEditor({
  task,
  onClose,
  onSaved,
  onDeleted,
}: {
  task: Task;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}): ReactNode {
  const [quality, setQuality] = useState(task.quality ?? '');
  const [segmentTimeS, setSegmentTimeS] = useState(task.segmentTimeS);
  const [postprocess, setPostprocess] = useState(task.postprocess);
  const [maxSessionS, setMaxSessionS] = useState(task.maxSessionS);
  const [maxSessionBytes, setMaxSessionBytes] = useState(Math.round(task.maxSessionBytes / 1024 ** 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除任务「${task.streamerName ?? task.url}」？这会同时移除它的录制历史索引（磁盘上的视频文件保留）。`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/tasks/${task.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`任务设置 · ${task.streamerName ?? ''}`} onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="画质（由插件解释）"
          hint={task.qualityOptions.length > 0 ? `可选：${task.qualityOptions.join(' / ')}` : '该房间还没解析出可选档位'}
        >
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <p className="text-[11px] text-neutral-500">
          地址：<span className="break-all text-neutral-400">{task.url}</span>
        </p>
        {error !== null && <ErrorText>{error}</ErrorText>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            删除任务
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              保存
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
