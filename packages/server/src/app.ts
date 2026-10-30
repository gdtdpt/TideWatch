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
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { TidewatchService } from './service.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** src/ 与 dist/ 同深度，两种运行方式都能定位到 packages/ui/dist */
const UI_DIST = join(here, '../../ui/dist');

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

  const clients = new Set<WebSocket>();
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
  registerSettingsRoutes(app, service);
  registerSystemRoutes(app, service);

  // ── WS 事件流 ───────────────────────────────────────────────────────────
  let lastEventId = service.store.listEvents({ limit: 1 })[0]?.id ?? 0;
  const pump = setInterval(() => {
    if (clients.size === 0) return;
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
  }

  app.get('/api/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', since: lastEventId }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

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
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await service.stop();
  });

  await service.init();
  return app;
}
