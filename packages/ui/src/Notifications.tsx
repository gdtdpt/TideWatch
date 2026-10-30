import type { ReactNode } from 'react';
import { api, fmtTime, type NotificationRow } from './api.ts';
import { Badge, Button, Empty } from './components.tsx';
import { useAsync } from './hooks.ts';

export function Notifications({
  tick,
  onClose,
  onNavigate,
}: {
  tick: number;
  onClose: () => void;
  onNavigate: (path: string) => void;
}): ReactNode {
  const list = useAsync<{ notifications: NotificationRow[]; unread: number }>(
    () => api.get('/api/notifications'),
    [tick],
  );

  const markAll = async (): Promise<void> => {
    await api.post('/api/notifications/read', { ids: [] });
    list.reload();
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose}>
      <aside
        className="ml-auto flex h-full w-full max-w-sm flex-col border-l border-neutral-800 bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 p-4">
          <h2 className="text-sm font-semibold">通知</h2>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => void markAll()}>
              全部已读
            </Button>
            <Button variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-3">
          {list.data === null && <Empty>加载中…</Empty>}
          {list.data !== null && list.data.notifications.length === 0 && <Empty>还没有通知。</Empty>}
          <ul className="space-y-2">
            {(list.data?.notifications ?? []).map((n) => (
              <li
                key={n.id}
                className={`rounded-xl border p-3 ${
                  n.readAt === null ? 'border-sky-500/30 bg-sky-500/5' : 'border-neutral-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {n.title}
                    <Badge tone={n.level === 'error' ? 'error' : n.level === 'warn' ? 'warn' : 'info'}>{n.level}</Badge>
                  </span>
                  <span className="text-[11px] text-neutral-500">{fmtTime(n.ts)}</span>
                </div>
                <p className="mt-1 text-xs text-neutral-400">{n.body}</p>
                {n.sessionId !== null && (
                  <button
                    className="mt-1 text-xs text-sky-300 hover:underline"
                    onClick={() => {
                      onNavigate(`session/${n.sessionId ?? ''}`);
                      onClose();
                    }}
                  >
                    查看这场
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
