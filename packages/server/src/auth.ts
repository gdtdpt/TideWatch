import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'tw_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 免鉴权端点（health / login / static） */
    public?: boolean;
  }
}

/**
 * 首次启动生成 32 字节 token，写 data/auth-token.txt（0600）并打印到终端。
 * 局域网暴露意味着「能访问 IP 就能删你的录制」，所以这不是可选项。
 */
export function loadOrCreateToken(dataRoot: string): { token: string; created: boolean } {
  const file = join(dataRoot, 'auth-token.txt');
  if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), created: false };
  mkdirSync(dataRoot, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface AuthDeps {
  dataRoot: string;
  /** 优雅退出入口（与信号、CLI stop 同一条管道） */
  requestShutdown(reason: string): void;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { token, created } = loadOrCreateToken(deps.dataRoot);
  if (created) app.log.warn({ file: join(deps.dataRoot, 'auth-token.txt') }, '已生成新的访问 token');
  else app.log.info({ file: join(deps.dataRoot, 'auth-token.txt') }, '已加载访问 token');

  const sessions = new Map<string, number>();

  const issue = (): string => {
    const sid = randomBytes(24).toString('base64url');
    sessions.set(sid, Date.now() + SESSION_TTL_MS);
    return sid;
  };

  const setCookie = (reply: FastifyReply, sid: string): void => {
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
      // 局域网多为 http，secure 只能在反代/隧道场景开启
      secure: process.env.TIDEWATCH_SECURE_COOKIE === '1',
    });
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return; // 静态资源与 SPA 壳
    if (req.routeOptions.config?.public === true) return;

    if (!SAFE_METHODS.has(req.method) && req.headers['x-tidewatch-client'] !== '1') {
      return reply.code(403).send({ error: 'csrf', message: '缺少 X-TideWatch-Client 请求头' });
    }

    const sid = req.cookies[SESSION_COOKIE];
    const expiresAt = sid === undefined ? undefined : sessions.get(sid);
    if (sid === undefined || expiresAt === undefined || expiresAt < Date.now()) {
      if (sid !== undefined) sessions.delete(sid);
      return reply.code(401).send({ error: 'unauthorized', message: '需要先登录' });
    }
    // 滚动续期：使用即刷新
    sessions.set(sid, Date.now() + SESSION_TTL_MS);
  });

  app.post<{ Body: { token?: string } }>(
    '/api/auth/login',
    { config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const provided = req.body?.token ?? '';
      if (typeof provided !== 'string' || !safeEqual(provided, token)) {
        return reply.code(401).send({ error: 'bad-token', message: 'token 不正确' });
      }
      const sid = issue();
      setCookie(reply, sid);
      return { ok: true, expiresInSec: SESSION_TTL_MS / 1000 };
    },
  );

  app.get('/api/auth/session', async () => ({ ok: true }));

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/shutdown', async (_req, reply) => {
    reply.code(202).send({ ok: true, message: '正在优雅收尾' });
    deps.requestShutdown('api');
  });
}
