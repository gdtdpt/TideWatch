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

export type LiveTransport = 'sse' | 'ws' | 'none';

export interface LiveState {
  connected: boolean;
  transport: LiveTransport;
}

/**
 * 实时通道：**优先 SSE，不可用才退回 WS**。
 *
 * 两者承载的载荷相同 —— 都只表示"数据变脏了"，页面收到信号后重拉 REST。
 * 传输层因此是纯管道，换掉不影响任何页面逻辑。
 *
 * 退回 WS 的条件只有两个：浏览器没有 `EventSource`；或它进入 CLOSED
 * （不再自动重连，常见于 401/502、反代把流改成了普通响应）。
 * CONNECTING 状态不退回 —— 那是浏览器自己在按退避重连，比手写稳。
 */
export function useLive(onEvent: () => void, enabled = true): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, transport: 'none' });
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return undefined;
    let closed = false;
    let source: EventSource | null = null;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let flush: number | null = null;
    /** 重连成功后 WS 定时器要停掉，否则会在 SSE 之外多开一条 */
    const stopRetry = (): void => {
      if (retry !== null) {
        window.clearTimeout(retry);
        retry = null;
      }
    };

    const mark = (connected: boolean, transport: LiveTransport): void => {
      setState((prev) =>
        prev.connected === connected && prev.transport === transport ? prev : { connected, transport },
      );
    };

    // 一次录制会连着吐很多事件（分段、进度、通知）。逐条触发重拉会把接口
    // 打爆 —— 合并成 120ms 内最多一轮；SSE 重连时的补发也靠它挡住。
    const dirty = (): void => {
      if (closed || flush !== null) return;
      flush = window.setTimeout(() => {
        flush = null;
        if (!closed) handler.current();
      }, 120);
    };

    const openWs = (): void => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      socket.onopen = () => mark(true, 'ws');
      socket.onmessage = (ev: MessageEvent) => {
        // 心跳只用来保活，不触发重拉数据
        try {
          if ((JSON.parse(String(ev.data)) as { type?: string }).type === 'ping') return;
        } catch {
          /* 非 JSON 也按数据变更处理 */
        }
        dirty();
      };
      socket.onclose = () => {
        mark(false, 'ws');
        if (!closed) retry = window.setTimeout(openWs, 2000);
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          /* ignore */
        }
      };
    };

    const openSse = (): void => {
      const stream = new EventSource('/api/events/stream');
      source = stream;
      stream.onopen = () => {
        if (closed || source !== stream) return;
        stopRetry();
        mark(true, 'sse');
      };
      // 命名事件必须显式挂监听：onmessage 只收没有 event 名的帧
      for (const name of ['event', 'notify', 'notifications_read'] as const) {
        stream.addEventListener(name, dirty);
      }
      stream.onerror = () => {
        if (closed || source !== stream) return;
        if (stream.readyState === EventSource.CLOSED) {
          // 浏览器已放弃重连：换成 WS
          stream.close();
          source = null;
          openWs();
          return;
        }
        mark(false, 'sse');
      };
    };

    // 应急开关：某些反代会闷住流式响应，地址加 ?transport=ws 可强制走 WS
    const forced = new URLSearchParams(window.location.search).get('transport');
    if (forced !== 'ws' && typeof EventSource !== 'undefined') openSse();
    else openWs();

    return () => {
      closed = true;
      stopRetry();
      if (flush !== null) window.clearTimeout(flush);
      try {
        source?.close();
      } catch {
        /* ignore */
      }
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
    // `enabled` 必须进依赖：App 首帧是 auth='checking'（enabled=false），
    // 空依赖会让这个 effect 永远不重跑 —— 登录成功后一条连接都不建，
    // 界面一直停在「已断开，正在重连」，而 REST 全是好的，很难察觉。
  }, [enabled]);

  return state;
}

export type Route =
  | { page: 'overview' }
  | { page: 'tasks' }
  | { page: 'recordings' }
  | { page: 'session'; id: string }
  | { page: 'settings' };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const [head, id] = clean.split('/');
  if (head === 'tasks') return { page: 'tasks' };
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
