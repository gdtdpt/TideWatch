/**
 * HTTP 装配：鉴权 → 审计 → REST → WS 事件流 → 静态 SPA。
 *
 * 事件推送不侵入引擎：WS 用 events 表的自增 id 做游标增量读取（500ms 一拍），
 * 断线客户端可按 `?since=` 补齐 —— 与 REST 同一条查询，只有一份真相。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createHostAdapter, type HostAdapter } from '@tidewatch/host-adapter';
import type { NotificationRow } from '@tidewatch/store';
import { registerAuth } from './auth.ts';
import { registerMergeRoutes } from './routes/merges.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { TidewatchService } from './service.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** src/ 与 dist/ 同深度，两种运行方式都能定位到 packages/ui/dist */
const UI_DIST = join(here, '../../ui/dist');

/** 一条 SSE 响应流：写入/收尾由路由自己管，服务端只负责按帧推 */
interface StreamSink {
  write(chunk: string): void;
  end(): void;
}

/**
 * 统一载荷编码成 SSE 帧。
 * `event` 帧带 `id:` —— 浏览器重连时自动回传 `Last-Event-ID`，
 * 服务端据此只补发缺的那段，前端一行重连逻辑都不用写。
 */
function sseFrame(message: unknown): string {
  const m = message as { type?: string; event?: { id?: number } };
  if (m.type === 'event' && typeof m.event?.id === 'number') {
    return `id: ${String(m.event.id)}\nevent: event\ndata: ${JSON.stringify(m.event)}\n\n`;
  }
  return `event: ${m.type ?? 'message'}\ndata: ${JSON.stringify(message)}\n\n`;
}

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export interface BuildOptions {
  dataRoot: string;
  version?: string;
  host?: HostAdapter;
  requestShutdown?: (reason: string) => void;
  /** 测试注入：复用已有 service（也用于只读宿主） */
  service?: TidewatchService;
  /** false = 不启动引擎（契约测试） */
  engine?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const host =
    opts.host ??
    createHostAdapter({
      dataRoot: opts.dataRoot,
      resourceRoot: join(here, '../../..'),
      defaultDownloads: join(opts.dataRoot, 'downloads'),
      port: 8686,
    });

  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 1024 * 1024,
  });

  /** WS 订阅者（回退通道） */
  const clients = new Set<WebSocket>();
  /** SSE 订阅者（主通道）：一条已编码好的 SSE 帧写进去即可 */
  const streams = new Set<StreamSink>();
  const service =
    opts.service ??
    new TidewatchService({
      dataRoot: opts.dataRoot,
      resourceRoot: join(here, '../../..'),
      host,
      version: opts.version ?? '0.0.0',
      port: 8686,
      ...(opts.engine === false ? { engine: false } : {}),
      onNotify: (row: NotificationRow) => {
        broadcast({ type: 'notify', notification: row });
      },
      logger: {
        info: (msg, meta) => app.log.info({ meta }, msg),
        warn: (msg, meta) => app.log.warn({ meta }, msg),
      },
    });

  await app.register(fastifyCookie);
  // 全局不设限（长连接会被误伤），只在登录等端点按 route config 限流
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket);

  // 审计：只记变更类请求（GET 是阅读，不是"人做了什么"）
  app.addHook('onResponse', async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/notifications/read')) return;
    try {
      service.store.insertAudit({
        action: `${method} ${req.url.split('?')[0] ?? ''}`,
        target: req.url.split('?')[0] ?? null,
        result: reply.statusCode < 400 ? 'ok' : `http-${String(reply.statusCode)}`,
        durationMs: Math.round(reply.elapsedTime),
      });
    } catch {
      /* 审计写失败不能影响请求结果 */
    }
  });

  registerAuth(app, {
    dataRoot: opts.dataRoot,
    requestShutdown: opts.requestShutdown ?? (() => {}),
  });

  registerTaskRoutes(app, service);
  registerSessionRoutes(app, service);
  registerMergeRoutes(app, service);
  registerSettingsRoutes(app, service);
  registerSystemRoutes(app, service, {
    // 在别的标签页/手机上点了已读，角标要跟着变；这条消息不进 events 表，
    // 只用来触发各客户端重拉未读数
    onNotificationsRead: (unread) => broadcast({ type: 'notifications_read', unread }),
  });

  // ── 实时事件流 ──────────────────────────────────────────────────────────
  // 主通道 SSE，回退 WS。两者的载荷是同一条消息：都只是"数据变脏"的提示，
  // 真正的数据永远从 REST 取 —— 所以传输层可互换而不影响任何页面。
  let lastEventId = service.store.listEvents({ limit: 1 })[0]?.id ?? 0;
  const pump = setInterval(() => {
    if (clients.size === 0 && streams.size === 0) return;
    try {
      const events = service.store.listEvents({ since: lastEventId, limit: 200 });
      for (const event of events) {
        lastEventId = Math.max(lastEventId, event.id);
        broadcast({ type: 'event', event });
      }
    } catch (err) {
      app.log.warn({ err }, '事件增量读取失败');
    }
  }, 500);
  pump.unref();

  function broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(text);
        } catch {
          clients.delete(client);
        }
      }
    }
    const frame = sseFrame(message);
    for (const stream of streams) {
      try {
        stream.write(frame);
      } catch {
        streams.delete(stream);
      }
    }
  }

  /**
   * SSE（主通道）：普通 HTTP 响应流。反代/隧道不必支持 Upgrade，断线由浏览器
   * `EventSource` 自己重连（带 `Last-Event-ID`），这里只按游标补发缺的那段。
   */
  app.get<{ Querystring: { since?: string } }>('/api/events/stream', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx 默认缓冲响应，事件会被闷住不发；这个头让它直通
      'x-accel-buffering': 'no',
    });
    res.write(': tidewatch events\n\n');

    const sink: StreamSink = {
      write: (chunk) => res.write(chunk),
      end: () => res.end(),
    };
    // 先登记再回放：登记前泵推过的旧事件由回放补齐；重叠只会多几次"变脏"，
    // 客户端已按 120ms 合并，不会连打接口。
    streams.add(sink);

    const since = Math.max(
      Number(firstHeader(req.headers['last-event-id']) ?? 0) || 0,
      Number(req.query.since ?? 0) || 0,
    );
    const cursor = lastEventId;
    res.write(`event: hello\ndata: ${JSON.stringify({ since, cursor })}\n\n`);
    if (since > 0 && since < cursor) {
      for (const event of service.store.listEvents({ since, limit: 500 })) {
        if (event.id > cursor) break;
        res.write(sseFrame({ type: 'event', event }));
      }
    }

    const drop = (): void => {
      streams.delete(sink);
    };
    req.raw.on('close', drop);
    req.raw.on('error', drop);
    return reply;
  });

  app.get('/api/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', since: lastEventId }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  /**
   * 心跳：没有事件时连接是"哑"的，反代/负载均衡的空闲超时（nginx 默认 60s）
   * 会把它悄悄掐掉，前端表现为间歇性"正在重连"。25s 一拍既保住连接，
   * 又让中间的每段代理都有流量可循。
   */
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.readyState !== 1) {
        clients.delete(client);
        continue;
      }
      try {
        client.send(JSON.stringify({ type: 'ping', at: Date.now() }));
      } catch {
        clients.delete(client);
      }
    }
    // SSE 用注释行保活：不产生 message 事件，客户端不会被它吵醒
    for (const stream of streams) {
      try {
        stream.write(': ping\n\n');
      } catch {
        streams.delete(stream);
      }
    }
  }, 25_000);
  heartbeat.unref();

  if (existsSync(UI_DIST)) {
    await app.register(fastifyStatic, { root: UI_DIST, wildcard: true });
  } else {
    app.log.warn({ uiDist: UI_DIST }, '未找到 UI 构建产物，先跑 pnpm --filter @tidewatch/ui build');
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && existsSync(join(UI_DIST, 'index.html'))) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not-found', message: `无此端点：${req.method} ${req.url}` });
  });

  app.setErrorHandler((err, req, reply) => {
    app.log.error({ err, url: req.url }, '请求处理失败');
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode !== undefined && e.statusCode >= 400 ? e.statusCode : 500;
    return reply.code(status).send({
      error: status === 500 ? 'internal' : 'bad-request',
      message: e.message ?? '未知错误',
    });
  });

  app.addHook('onClose', async () => {
    clearInterval(pump);
    clearInterval(heartbeat);
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    // SSE 是长连接：不主动 end，app.close() 会一直等它们
    for (const stream of streams) {
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    }
    streams.clear();
    await service.stop();
  });

  await service.init();
  return app;
}
