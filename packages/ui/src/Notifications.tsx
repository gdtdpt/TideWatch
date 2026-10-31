import { useEffect, useState, type ReactNode } from 'react';
import { api, fmtTime, type NotificationRow } from './api.ts';
import { Badge, Button, Empty, ErrorText } from './components.tsx';
import { useAsync } from './hooks.ts';

type Payload = { notifications: NotificationRow[]; unread: number };

export function Notifications({
  tick,
  onClose,
  onNavigate,
  onUnreadChange,
}: {
  tick: number;
  onClose: () => void;
  onNavigate: (path: string) => void;
  /** 把最新未读数回写给顶栏角标：标记已读不产生 WS 事件，否则角标不会变 */
  onUnreadChange: (unread: number) => void;
}): ReactNode {
  const list = useAsync<Payload>(() => api.get('/api/notifications'), [tick]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 面板拿到什么数，角标就显示什么数 —— 打开面板、WS 刷新、标记已读都走这一条路
  useEffect(() => {
    if (list.data !== null) onUnreadChange(list.data.unread);
  }, [list.data, onUnreadChange]);

  const markRead = async (ids: number[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ unread: number }>('/api/notifications/read', { ids });
      onUnreadChange(r.unread);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose}>
      <aside
        className="ml-auto flex h-full w-full max-w-sm flex-col border-l border-neutral-800 bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b border-neutral-800 p-4">
          <h2 className="shrink-0 text-sm font-semibold">通知</h2>
          <div className="flex gap-1">
            <Button variant="ghost" disabled={busy} onClick={() => void markRead([])}>
              全部已读
            </Button>
            <Button variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </header>
        {error !== null && (
          <div className="border-b border-neutral-800 px-4 py-2">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        <div className="flex-1 overflow-auto p-3">
          {list.data === null && <Empty>加载中…</Empty>}
          {list.data !== null && list.data.notifications.length === 0 && <Empty>还没有通知。</Empty>}
          <ul className="space-y-2">
            {(list.data?.notifications ?? []).map((n) => {
              const unread = n.readAt === null;
              return (
                <li
                  key={n.id}
                  className={`rounded-xl border p-3 ${
                    unread ? 'border-sky-500/30 bg-sky-500/5' : 'border-neutral-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <span className="truncate">{n.title}</span>
                      <Badge tone={n.level === 'error' ? 'error' : n.level === 'warn' ? 'warn' : 'info'}>
                        {n.level}
                      </Badge>
                    </span>
                    <span className="shrink-0 text-[11px] text-neutral-500">{fmtTime(n.ts)}</span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-400">{n.body}</p>
                  {(n.sessionId !== null || unread) && (
                    <div className="mt-1 flex items-center gap-3">
                      {n.sessionId !== null && (
                        <button
                          className="text-xs text-sky-300 hover:underline"
                          onClick={() => {
                            void markRead([n.id]);
                            onNavigate(`session/${n.sessionId ?? ''}`);
                            onClose();
                          }}
                        >
                          查看这场
                        </button>
                      )}
                      {/* 没有会话可跳的通知（例如探测失败）也要能单条清掉，
                          否则只能等「全部已读」把别的未读一起抹掉 */}
                      {unread && (
                        <button
                          className="text-xs text-neutral-500 hover:text-neutral-300"
                          disabled={busy}
                          onClick={() => void markRead([n.id])}
                        >
                          标为已读
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}
