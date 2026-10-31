import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api.ts';
import { Login } from './Login.tsx';
import { Notifications } from './Notifications.tsx';
import { useLive, useRoute } from './hooks.ts';
import { Overview } from './pages/Overview.tsx';
import { Recordings } from './pages/Recordings.tsx';
import { SessionDetail } from './pages/SessionDetail.tsx';
import { Settings } from './pages/Settings.tsx';
import { Tasks } from './pages/Tasks.tsx';

type Auth = 'checking' | 'in' | 'out';

const NAV = [
  { path: '', label: '总览' },
  { path: 'tasks', label: '任务' },
  { path: 'recordings', label: '录制' },
  { path: 'settings', label: '设置' },
];

export function App(): ReactNode {
  const [auth, setAuth] = useState<Auth>('checking');
  const [route, navigate] = useRoute();
  const [tick, setTick] = useState(0);
  const [bell, setBell] = useState(false);
  const [unread, setUnread] = useState(0);

  const live = useLive(() => setTick((t) => t + 1), auth === 'in');
  const connected = live.connected;
  /** 传输层只影响诊断，不影响功能：两种通道都只是"变脏"信号 */
  const transportLabel = live.transport === 'sse' ? 'SSE' : live.transport === 'ws' ? 'WS' : '—';

  // 角标数字的唯一来源。标记已读是用户主动操作、不产生 WS 事件，
  // 所以通知面板会把接口返回的最新未读数回写进来（否则角标要等下一个事件才变）。
  const refreshUnread = useCallback((): void => {
    api
      .get<{ unread: number }>('/api/notifications')
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api
      .get('/api/auth/session')
      .then(() => setAuth('in'))
      .catch(() => setAuth('out'));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (auth !== 'in') return;
    refreshUnread();
  }, [auth, tick, refreshUnread]);

  if (auth === 'checking') {
    return <p className="p-8 text-center text-sm text-neutral-500">正在检查会话…</p>;
  }
  if (auth === 'out') {
    return (
      <Login
        onDone={() => {
          setAuth('in');
          setTick((t) => t + 1);
        }}
      />
    );
  }

  const nav = (path: string): void => navigate(path);

  return (
    <div className="min-h-screen lg:flex">
      {/* sticky + h-screen + self-start：菜单钉在视口里，右侧内容再长也不会把它
          顶出屏幕。self-start 不能省 —— flex 默认 stretch 会把侧栏拉到与内容等高，
          那样 sticky 就没有可粘的余量，等于没设。 */}
      <aside className="hidden w-56 shrink-0 border-r border-neutral-800 p-4 lg:sticky lg:top-0 lg:flex lg:h-screen lg:self-start lg:flex-col lg:overflow-y-auto">
        <div className="mb-6">
          <p className="text-lg font-semibold tracking-tight">TideWatch</p>
          <p className="text-[11px] text-neutral-500">潮录 · 直播自动录制</p>
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => {
            const active =
              item.path === ''
                ? route.page === 'overview'
                : route.page === item.path || (item.path === 'recordings' && route.page === 'session');
            return (
              <button
                key={item.path}
                onClick={() => nav(item.path)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                  active ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-800/50'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto space-y-2 pt-6 text-xs text-neutral-500">
          <p className="flex items-center gap-2" title={`事件通道：${transportLabel}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
            {connected ? '实时连接' : '已断开，正在重连'}
            {connected && <span className="text-[10px] text-neutral-600">{transportLabel}</span>}
          </p>
          <button
            className="hover:text-neutral-300"
            onClick={() => {
              void api.post('/api/auth/logout').finally(() => {
                setUnread(0);
                setAuth('out');
              });
            }}
          >
            退出登录
          </button>
        </div>
      </aside>

      {/* min-w-0 必须有：flex 子项默认 min-width:auto，等于内容最小宽度。
          会话详情里事件日志的 JSON 是一整段不可断行的长串，会把这一列撑到
          max-w-6xl（1152px），lg 下整页就出现横向滚动条。 */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3 lg:px-6">
          <div className="min-w-0 lg:hidden">
            <p className="text-base font-semibold">TideWatch</p>
            <p className="text-[11px] text-neutral-500">{connected ? '实时连接' : '重连中…'}</p>
          </div>
          <div className="hidden text-xs text-neutral-500 lg:block">浏览器即客户端 · 局域网随时可看</div>
          <button
            className="relative shrink-0 rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800/60"
            onClick={() => setBell(true)}
          >
            通知
            {unread > 0 && (
              <span className="ml-1 rounded-md bg-sky-500 px-1.5 text-[11px] font-medium text-white">{unread}</span>
            )}
          </button>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 pb-24 lg:p-6 lg:pb-6">
          {route.page === 'overview' && <Overview tick={tick} navigate={nav} />}
          {route.page === 'tasks' && <Tasks tick={tick} navigate={nav} />}
          {route.page === 'recordings' && <Recordings tick={tick} navigate={nav} />}
          {route.page === 'session' && (
            <SessionDetail id={route.id} tick={tick} back={() => nav('recordings')} />
          )}
          {route.page === 'settings' && <Settings tick={tick} />}
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-neutral-800 bg-neutral-950/95 backdrop-blur lg:hidden">
          {NAV.map((item) => {
            const active =
              item.path === ''
                ? route.page === 'overview'
                : route.page === item.path || (item.path === 'recordings' && route.page === 'session');
            return (
              <button
                key={item.path}
                onClick={() => nav(item.path)}
                className={`flex-1 py-3 text-sm ${active ? 'text-sky-300' : 'text-neutral-500'}`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      {bell && (
        <Notifications
          tick={tick}
          onClose={() => setBell(false)}
          onNavigate={nav}
          onUnreadChange={setUnread}
        />
      )}
    </div>
  );
}
