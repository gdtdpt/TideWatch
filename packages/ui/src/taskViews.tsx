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
  fmtTime,
  STATE_LABEL,
  type MonitorWindow,
  type Task,
} from './api.ts';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Select, Toggle } from './components.tsx';
import { useNow } from './hooks.ts';
import { PlatformMark } from './platformMarks.tsx';

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral';

/** 卡片里的"已录"用紧凑格式（30:32 / 1:05:12），比"30 分 32 秒"省一半宽度 */
function fmtElapsed(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 新增时段的默认值：**接在最后一段结束之后两小时**。
 *
 * 不能每次都填死 `19:00 → 02:00`：已有时段时再点「添加」，新行和旧行一模一样，
 * 界面上看起来"没变化"，用户会以为只有一段 —— 实际两段，删除时删掉自己改的那行，
 * 剩下那条默认值，现象就是"删了以后变成 19:00→02:00，而且怎么删都还在"。
 */
function nextWindow(prev: MonitorWindow | undefined): MonitorWindow {
  if (prev === undefined) return { start: '19:00', end: '02:00' };
  const [h, m] = prev.end.split(':').map(Number);
  const start = ((h ?? 0) * 60 + (m ?? 0)) % 1440;
  const end = (start + 120) % 1440;
  return { start: `${pad2(Math.floor(start / 60))}:${pad2(start % 60)}`, end: `${pad2(Math.floor(end / 60))}:${pad2(end % 60)}` };
}

/** 同一组起止 + 星期只保留一份；起止相同的半填状态直接丢弃 */
function dedupeWindows(list: readonly MonitorWindow[]): MonitorWindow[] {
  const seen = new Set<string>();
  const out: MonitorWindow[] = [];
  for (const w of list) {
    if (w.start === w.end) continue;
    const key = `${w.start}-${w.end}-${(w.days ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** 比较用：不受对象 key 顺序影响 */
const windowsKey = (list: readonly MonitorWindow[]): string =>
  list.map((w) => `${w.start}-${w.end}-${(w.days ?? []).join(',')}`).join('|');

/**
 * 画质标记：**优先显示实际拿到的档位**，拿不到才退回请求值。
 *
 * 为什么不是直接显示 `task.quality`：那是"我要的"。平台会静默降级（请求原画、
 * 只给高清，且不报错），只显示请求值等于把"糊了"这件事藏起来。
 */
export function qualityMark(task: Task, detail: string | null): { text: string; tone: string; title: string } | null {
  const a = task.qualityActual;
  if (a !== null && a.label !== null) {
    // detail 里已经写了同样的档位（插件常给 "720p60 · 5.1 Mbps"），没降级就别重复一遍。
    // 降级必须保留：detail 的档位说明不了"这是被降下来的"，`↓` 才是那句话。
    if (!a.degraded && (detail ?? '').includes(a.label)) return null;
    const extra = [a.codec?.toUpperCase(), a.format].filter((x): x is string => typeof x === 'string' && x.length > 0);
    const suffix = extra.length > 0 ? `（${extra.join(' · ')}）` : '';
    const title = a.degraded
      ? `请求 ${a.requested ?? '—'}，平台实际只给了 ${a.label}${suffix}。常见原因：未登录、房间没有该档位、会员画质。`
      : `实际画质 ${a.label}${suffix}`;
    return {
      text: a.degraded ? `${a.label} ↓` : a.label,
      tone: a.degraded ? 'text-amber-400' : 'text-neutral-500',
      title,
    };
  }
  if (task.quality !== null && task.quality.length > 0 && !(detail ?? '').includes(task.quality)) {
    return {
      text: task.quality,
      tone: 'text-neutral-600',
      title: '任务设置里的请求档位；还没解析出实际画质',
    };
  }
  return null;
}

export function stateTone(state: string): Tone {
  if (state === 'recording') return 'ok';
  if (state === 'reconnecting' || state === 'resolving' || state === 'finalizing') return 'info';
  // 不在时段 / 已暂停不是错误：它们都是"按预期没在动"，涂红会让人以为出了事
  if (state === 'waiting' || state === 'snoozed' || state === 'idle' || state === 'paused') return 'neutral';
  // 平台拒绝进房也不是我们的故障，但需要人知道，用警告色
  if (state === 'blocked') return 'warn';
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
  if (state === 'error' || state === 'needs_auth' || state === 'needs_dep' || state === 'unsupported' || state === 'blocked') {
    return 'attention';
  }
  if (!task.monitorEnabled || state === 'idle' || state === 'paused') return 'paused';
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
  highlight = false,
}: {
  task: Task;
  onChanged: () => void;
  onEdit: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  highlight?: boolean;
}): ReactNode {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runtime = task.runtime;
  const recording = runtime.state === 'recording' || runtime.state === 'reconnecting';

  /**
   * 卡片上的时长是**本场累计**，不是当前分段。
   *
   * 基准取"进行中会话的起点"：`runtime.updatedAt` 会在建连接、段轮转、重连时被重写，
   * 用它算等于每小时切段、每次断流都归零（标着"本场已录"却显示 00:12）。
   * 刚开录的那一两秒列表可能还停在上一场，此时退回投影时间兜底，等轮询刷到就纠正。
   */
  const latest = task.latestSession;
  const liveStartMs =
    recording && latest !== null && latest.endedAt === null ? new Date(latest.startedAt).getTime() : null;
  const elapsed = recording ? (now - (liveStartMs ?? new Date(runtime.updatedAt).getTime())) / 1000 : 0;

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

  /**
   * 卡片只留"要不要管它"必须看到的：状态、是谁、在播什么、一条落点信息。
   * 画质/分段这类可改的配置留在设置弹窗里 —— 任务多时一屏能看十来个。
   */
  const marks: string[] = [];
  if (!task.monitorEnabled && runtime.state !== 'idle') marks.push('未监控');
  if (task.recordRequested && !recording) marks.push('下轮将录');
  // 画质单独渲染：降级要用琥珀色标出来，和普通标记拼在一个字符串里做不到
  const quality = qualityMark(task, runtime.detail);

  return (
    <li
      className={`rounded-xl border p-2 transition ${
        highlight ? 'border-sky-500 ring-1 ring-sky-500/60' : 'border-neutral-800 bg-neutral-900/40'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* 平台标识放在状态徽章前面：先认出"哪来的"，再看"什么状态" */}
          <PlatformMark platform={task.platform} />
          <Badge tone={stateTone(runtime.state)}>{STATE_LABEL[runtime.state] ?? runtime.state}</Badge>
          <span className="truncate text-sm font-medium" title={task.streamerName ?? task.url}>
            {task.streamerName ?? '未命名直播间'}
          </span>
          {recording && elapsed > 0 && (
            <span
              className="shrink-0 text-[10px] tabular-nums text-emerald-400"
              title="本场已录（跨分段累计，切段和重连都不归零）"
            >
              {fmtElapsed(elapsed)}
            </span>
          )}
        </div>
        <Toggle
          size="sm"
          checked={task.monitorEnabled}
          label="监控开关"
          disabled={busy}
          onChange={(next) => void act(() => api.post(`/api/tasks/${task.id}/monitor`, { enabled: next }))}
        />
      </div>

      <p className="mt-1 truncate text-xs text-neutral-500" title={task.title ?? task.url}>
        {task.title ?? task.url}
      </p>

      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px]">
        <span className={`truncate ${runtime.detail !== null ? 'text-neutral-400' : 'text-neutral-600'}`}>
          {runtime.detail !== null ? (
            runtime.detail
          ) : latest !== null ? (
            <button className="hover:text-sky-300" onClick={() => onOpenSession(latest.id)} title="打开最近一场">
              上一场 {fmtTime(latest.startedAt)} · {END_REASON_LABEL[latest.endReason ?? ''] ?? '进行中'}
            </button>
          ) : (
            '还没录过'
          )}
        </span>
        {quality !== null && (
          <span className={`shrink-0 whitespace-nowrap ${quality.tone}`} title={quality.title}>
            · {quality.text}
          </span>
        )}
        {marks.length > 0 && <span className="shrink-0 text-neutral-600">· {marks.join(' · ')}</span>}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          variant={recording ? 'danger' : 'subtle'}
          className="px-2 py-0.5 text-xs"
          disabled={busy}
          onClick={() => void act(() => api.post(`/api/tasks/${task.id}/record`, { recording: !recording }))}
        >
          {recording ? '停止录制' : '开始录制'}
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          disabled={busy}
          onClick={() => void act(() => api.post(`/api/tasks/${task.id}/check`))}
        >
          检查
        </Button>
        <Button variant="ghost" className="ml-auto px-2 py-0.5 text-xs" onClick={() => onEdit(task)}>
          设置
        </Button>
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
  highlightId = null,
}: {
  tasks: readonly Task[];
  onChanged: () => void;
  onEdit: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  highlightId?: string | null;
}): ReactNode {
  return (
    // 列宽由 index.css 的 .task-grid 决定（1 / 2 / 3 列，1100px 起三列）
    <ul className="task-grid">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onChanged={onChanged}
          onEdit={onEdit}
          onOpenSession={onOpenSession}
          highlight={task.id === highlightId}
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
  const [windows, setWindows] = useState<MonitorWindow[]>(task.monitorWindows);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    /**
     * 只提交**改动过**的字段。
     *
     * 以前整张表单一把梭：只要有一个输入框不合法（把分段时长清空了就是 0），
     * 后端整体 400，同一弹窗里删掉的时段也跟着回滚 —— 用户看到的是"删了保存，
     * 重开又回来"，而红字在最底部，很容易以为删除按钮坏了。
     */
    const next: Record<string, unknown> = {};
    if (quality !== (task.quality ?? '')) next['quality'] = quality;
    if (segmentTimeS !== task.segmentTimeS) next['segmentTimeS'] = segmentTimeS;
    if (postprocess !== task.postprocess) next['postprocess'] = postprocess;
    if (maxSessionS !== task.maxSessionS) next['maxSessionS'] = maxSessionS;
    const nextBytes = maxSessionBytes * 1024 ** 2;
    if (nextBytes !== task.maxSessionBytes) next['maxSessionBytes'] = nextBytes;
    const windowsNext = dedupeWindows(windows);
    if (windowsKey(windowsNext) !== windowsKey(task.monitorWindows)) next['monitorWindows'] = windowsNext;
    try {
      if (Object.keys(next).length > 0) await api.patch(`/api/tasks/${task.id}`, next);
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
        {task.qualityActual !== null && (
          <p className={`-mt-1 text-[11px] ${task.qualityActual.degraded ? 'text-amber-400' : 'text-neutral-500'}`}>
            上次实际：
            {task.qualityActual.label ?? '未知档位'}
            {task.qualityActual.codec !== null ? ` · ${task.qualityActual.codec.toUpperCase()}` : ''}
            {task.qualityActual.format !== null ? ` · ${task.qualityActual.format}` : ''}
            {task.qualityActual.degraded ? `（低于请求的 ${task.qualityActual.requested ?? '默认'}）` : ''}
          </p>
        )}
        <Field
          as="div"
          label="监控时段"
          hint={
            windows.length === 0
              ? '全天监控（按设置里的轮询间隔）。填上时段后，窗外一次请求都不发。'
              : '按服务所在机器的本地时间；跨午夜直接写（19:00 → 02:00）。窗外一次请求都不发。'
          }
        >
          <div className="space-y-2">
            {/*
              「全天」做成原生勾选框而不是"把行删光"的隐含状态：
              删光等于全天这件事只有我们俩知道，用户看到的是"删了还在"。
              勾选框包在自己的 label 里（不嵌套按钮），各家浏览器都不会吞点击。
            */}
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-sky-500"
                checked={windows.length === 0}
                onChange={(e) => setWindows(e.target.checked ? [] : [nextWindow(undefined)])}
              />
              全天监控（不限时段）
            </label>
            {windows.map((w, i) => (
              <div key={`w${String(i)}`} className="flex min-w-0 items-center gap-1.5">
                {/* 宽度放在外层：Input 自带 w-full，直接给它 w-24 会被 w-full 盖掉 */}
                <div className="w-24 shrink-0">
                  <Input
                    type="time"
                    aria-label={`第 ${String(i + 1)} 段开始时间`}
                    value={w.start}
                    onChange={(e) =>
                      setWindows(windows.map((x, j) => (j === i ? { ...x, start: e.target.value.slice(0, 5) } : x)))
                    }
                  />
                </div>
                {/* 跨午夜优先用箭头颜色提示：窄屏放不下"· 跨午夜"时文字会被截成省略号 */}
                <span
                  className={`shrink-0 text-xs ${w.end < w.start ? 'text-amber-400' : 'text-neutral-500'}`}
                  title={w.end < w.start ? '跨午夜：当晚开始，次日凌晨结束' : undefined}
                >
                  →
                </span>
                <div className="w-24 shrink-0">
                  <Input
                    type="time"
                    aria-label={`第 ${String(i + 1)} 段结束时间`}
                    value={w.end}
                    onChange={(e) =>
                      setWindows(windows.map((x, j) => (j === i ? { ...x, end: e.target.value.slice(0, 5) } : x)))
                    }
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-600">
                  {`第 ${String(i + 1)} 段`}
                  {w.end < w.start ? <span className="hidden sm:inline"> · 跨午夜</span> : null}
                </span>
                <Button
                  variant="ghost"
                  className="shrink-0 px-2.5 py-1 text-xs"
                  title={`删除第 ${String(i + 1)} 段`}
                  onClick={() => setWindows(windows.filter((_x, j) => j !== i))}
                >
                  删除
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              {windows.length < 3 && (
                <Button
                  variant="subtle"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => setWindows([...windows, nextWindow(windows[windows.length - 1])])}
                >
                  + 添加时段
                </Button>
              )}
              {windows.length > 0 && (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  title="删掉所有时段，恢复全天监控"
                  onClick={() => setWindows([])}
                >
                  清空所有时段
                </Button>
              )}
            </div>
          </div>
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
