import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    loader()
      .then((value) => {
        if (!alive.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** WS 事件流：断线自动重连；`onEvent` 只用来触发刷新，不直接改数据 */
export function useLive(onEvent: () => void, enabled = true): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return undefined;
    let socket: WebSocket | null = null;
    let timer: number | null = null;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (ev: MessageEvent) => {
        // 心跳只用来保活，不触发重拉数据
        try {
          if ((JSON.parse(String(ev.data)) as { type?: string }).type === 'ping') return;
        } catch {
          /* 非 JSON 也按数据变更处理 */
        }
        handler.current();
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
    // `enabled` 必须进依赖：App 首帧是 auth='checking'（enabled=false），
    // 空依赖会让这个 effect 永远不重跑 —— 登录成功后 WS 永不连接，
    // 界面一直停在「已断开，正在重连」，而 REST 全是好的，很难察觉。
  }, [enabled]);

  return connected;
}

export type Route =
  | { page: 'overview' }
  | { page: 'recordings' }
  | { page: 'session'; id: string }
  | { page: 'settings' };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [head, id] = clean.split('/');
  if (head === 'recordings') return { page: 'recordings' };
  if (head === 'settings') return { page: 'settings' };
  if (head === 'session' && id !== undefined && id.length > 0) return { page: 'session', id };
  return { page: 'overview' };
}

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((path: string) => {
    window.location.hash = path;
  }, []);
  return [route, navigate];
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
