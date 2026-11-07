/**
 * 系统面：健康、插件、Cookie（只回掩码）、诊断包、数据保留、回放（Range）。
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describeRetention, SCHEMA_VERSION } from '@tidewatch/store';
import type { TidewatchService } from '../service.ts';

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

interface CookieMeta {
  platform: string;
  hint: string;
  updatedAt: string;
  encrypted: boolean;
}

const MASK = (value: string): string => `${value.slice(0, 6)}…（${String(value.length)} 字符）`;

export function registerSystemRoutes(
  app: FastifyInstance,
  service: TidewatchService,
  /** 标记已读是"阅读"不是"事件"，不会进 events 表；靠这条回调让其他已连接的客户端同步角标 */
  hooks: { onNotificationsRead?: (unread: number) => void } = {},
): void {
  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    name: 'tidewatch',
    version: service.opts.version,
    platform: service.opts.host.platform,
    schemaVersion: SCHEMA_VERSION,
    uptimeSec: Math.round(process.uptime()),
    engine: service.engine.running,
    lease: { acquired: service.status.leaseAcquired, note: service.status.leaseNote },
    paths: { dataRoot: service.opts.dataRoot, outputRoot: service.outputRoot },
    freeBytes: await service.fs.freeBytes(service.outputRoot),
    // 生效的 ffmpeg/ffprobe：缺件、版本漂移、来源（env/vendor/path）都要能被看见，
    // 否则"为什么分组全是 unknown""为什么同一份流归到别的错误码"没法解释
    binaries: await service.binaries(),
  }));

  app.get('/api/plugins', async () => ({
    catalog: service.manager.registry.catalog,
    plugins: service.manager.details(),
    warnings: service.manager.registry.warnings(),
  }));

  app.post('/api/plugins/refresh', async () => {
    const result = await service.refreshPlugins();
    return { ...result };
  });

  app.get('/api/cookies', async () => {
    const list = service.store.getMeta<CookieMeta[]>('meta.cookies', []);
    const out: CookieMeta[] = [];
    for (const item of list) {
      const value = await service.opts.host.credentials.get(`cookie:${item.platform}`);
      out.push({
        ...item,
        hint: value === undefined ? '（已丢失）' : MASK(value),
      });
    }
    return { backend: service.opts.host.credentials.describeBackend(), cookies: out };
  });

  app.put<{ Params: { platform: string }; Body: Body }>('/api/cookies/:platform', async (req, reply) => {
    const platform = req.params.platform;
    if (!/^[a-z0-9._-]+$/.test(platform)) {
      return reply.code(400).send({ error: 'bad-platform', message: '平台名只允许 [a-z0-9._-]' });
    }
    const value = str(req.body?.['value'])?.trim() ?? '';
    if (value.length === 0) return reply.code(400).send({ error: 'bad-cookie', message: 'Cookie 不能为空' });
    const stored = await service.opts.host.credentials.set(`cookie:${platform}`, value);
    const list = service.store.getMeta<CookieMeta[]>('meta.cookies', []).filter((c) => c.platform !== platform);
    list.push({
      platform,
      hint: MASK(value),
      updatedAt: new Date().toISOString(),
      encrypted: stored.encrypted,
    });
    service.store.setMeta('meta.cookies', list);
    // 红线：值永不进日志 / 事件 / 审计
    return { ok: true, platform, encrypted: stored.encrypted };
  });

  app.delete<{ Params: { platform: string } }>('/api/cookies/:platform', async (req) => {
    await service.opts.host.credentials.delete(`cookie:${req.params.platform}`);
    const list = service.store.getMeta<CookieMeta[]>('meta.cookies', []).filter(
      (c) => c.platform !== req.params.platform,
    );
    service.store.setMeta('meta.cookies', list);
    return { ok: true };
  });

  app.get('/api/diagnostics', async (_req, reply) => {
    const markdown = await buildDiagnostics(service);
    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="tidewatch-diagnose-${stamp()}.md"`)
      .send(markdown);
  });

  app.post('/api/diagnostics/export', async () => {
    const dir = join(service.opts.dataRoot, 'exports');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `tidewatch-diagnose-${stamp()}.md`);
    await writeFile(file, await buildDiagnostics(service), 'utf8');
    return { path: file };
  });

  /** 数据保留现状：事件条数分档、库大小、归档文件数 */
  app.get('/api/retention', async () => service.retentionInfo);

  /** 立即归档（过期事件先写 gzip 再删）；仪表盘的"立即归档"按钮用它 */
  app.post('/api/retention/run', async () => {
    const result = await service.runRetention();
    return {
      ...result,
      summary: describeRetention(result),
      ...(result.error === null ? {} : { message: `归档有失败：${result.error}` }),
    };
  });

  app.get<{ Querystring: { path?: string } }>('/api/videos', async (req, reply) => {
    const requested = req.query.path;
    if (requested === undefined || requested.length === 0) {
      return reply.code(400).send({ error: 'bad-path', message: '缺少 path' });
    }
    const abs = resolve(requested);
    const root = resolve(service.outputRoot);
    // 只允许回放录制目录内的文件（防目录穿越）
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      return reply.code(403).send({ error: 'forbidden', message: '只能播放录制目录内的文件' });
    }
    if (!existsSync(abs)) return reply.code(404).send({ error: 'not-found', message: '文件不存在' });

    const info = await stat(abs);
    const range = req.headers.range;
    if (range !== undefined) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m !== null) {
        const start = m[1] === '' ? 0 : Number(m[1]);
        const end = m[2] === '' ? info.size - 1 : Math.min(Number(m[2]), info.size - 1);
        if (start >= info.size || start > end) {
          return reply.code(416).header('content-range', `bytes */${info.size}`).send();
        }
        return reply
          .code(206)
          .headers({
            'content-range': `bytes ${start}-${end}/${info.size}`,
            'accept-ranges': 'bytes',
            'content-length': String(end - start + 1),
            'content-type': 'video/mp4',
          })
          .send(createReadStream(abs, { start, end }));
      }
    }
    return reply
      .headers({
        'content-length': String(info.size),
        'accept-ranges': 'bytes',
        'content-type': 'video/mp4',
      })
      .send(createReadStream(abs));
  });

  app.get('/api/notifications', async () => ({
    notifications: service.store.listNotifications({ limit: 100 }),
    unread: service.store.unreadNotificationCount(),
  }));

  app.post<{ Body: Body }>('/api/notifications/read', async (req) => {
    const ids = Array.isArray(req.body?.['ids'])
      ? (req.body['ids'] as unknown[]).filter((x): x is number => typeof x === 'number')
      : [];
    service.store.markNotificationsRead(ids);
    const unread = service.store.unreadNotificationCount();
    hooks.onNotificationsRead?.(unread);
    return { ok: true, unread };
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function buildDiagnostics(service: TidewatchService): Promise<string> {
  const stats = service.store.stats();
  const events = service.store.listEvents({ limit: 20 });
  const audit = service.store.listAudit(20);
  const health = {
    version: service.opts.version,
    platform: service.opts.host.platform,
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    dataRoot: service.opts.dataRoot,
    outputRoot: service.outputRoot,
    ffmpeg: service.status.ffmpeg,
    ffprobe: service.status.ffprobe,
    python: service.status.python,
    cookieBackend: service.status.cookieBackend,
    lease: service.status.leaseAcquired,
    leaseNote: service.status.leaseNote,
    recovery: service.status.recovery,
    freeBytes: await service.fs.freeBytes(service.outputRoot),
  };

  return [
    '# TideWatch 诊断包',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '## 实际生效环境',
    '```json',
    JSON.stringify(health, null, 2),
    '```',
    '',
    '## 库统计',
    '```json',
    JSON.stringify(stats, null, 2),
    '```',
    '',
    '## 最近事件',
    '```json',
    JSON.stringify(events, null, 2),
    '```',
    '',
    '## 最近审计',
    '```json',
    JSON.stringify(audit, null, 2),
    '```',
    '',
    '> Cookie 明文不在此文件中（红线：永不进日志/诊断包/事件）。',
    '',
  ].join('\n');
}
