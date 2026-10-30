/**
 * 全局设置：每个键"谁在什么时机读它"必须写清楚（docs/02 §6）。
 * 这里只做范围校验与落库；引擎侧 poll_interval 是重启生效，其余按任务/收尾时读取。
 */
import type { FastifyInstance } from 'fastify';
import type { AppSettings } from '@tidewatch/store';
import { generateVapidKeys } from '@tidewatch/notify';
import type { TidewatchService } from '../service.ts';

type Body = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function registerSettingsRoutes(app: FastifyInstance, service: TidewatchService): void {
  app.get('/api/settings', async () => ({
    settings: service.store.getSettings(),
    paths: {
      dataRoot: service.opts.dataRoot,
      outputRoot: service.outputRoot,
      resourceRoot: service.opts.resourceRoot,
    },
    runtime: {
      ffmpeg: service.status.ffmpeg,
      ffprobe: service.status.ffprobe,
      python: service.status.python,
      cookieBackend: service.status.cookieBackend,
      leaseAcquired: service.status.leaseAcquired,
      leaseNote: service.status.leaseNote,
    },
  }));

  app.put<{ Body: Body }>('/api/settings', async (req, reply) => {
    const body = req.body ?? {};
    const next: Partial<AppSettings> = {};

    if (body['pollIntervalS'] !== undefined) {
      const v = num(body['pollIntervalS']);
      if (v === undefined || v < 5 || v > 3600) {
        return reply.code(400).send({ error: 'bad-poll-interval', message: '轮询间隔需在 5..3600 秒' });
      }
      next.pollIntervalS = v;
    }
    if (body['segmentTimeS'] !== undefined) {
      const v = num(body['segmentTimeS']);
      if (v === undefined || v < 30 || v > 43_200) {
        return reply.code(400).send({ error: 'bad-segment-time', message: '分段时长需在 30..43200 秒' });
      }
      next.segmentTimeS = v;
    }
    if (body['defaultQuality'] !== undefined) {
      const v = str(body['defaultQuality']);
      if (v === undefined) return reply.code(400).send({ error: 'bad-quality', message: '默认画质必须是字符串' });
      next.defaultQuality = v;
    }
    if (body['defaultPostprocess'] !== undefined) {
      const v = str(body['defaultPostprocess']);
      if (v === undefined || !['merge', 'per_segment', 'manual'].includes(v)) {
        return reply.code(400).send({ error: 'bad-postprocess', message: '后处理策略非法' });
      }
      next.defaultPostprocess = v as AppSettings['defaultPostprocess'];
    }
    if (body['faststart'] !== undefined) {
      const v = str(body['faststart']);
      if (v === undefined || !['auto', 'on', 'off'].includes(v)) {
        return reply.code(400).send({ error: 'bad-faststart', message: 'faststart 只能是 auto/on/off' });
      }
      next.faststart = v as AppSettings['faststart'];
    }
    if (body['faststartThresholdMb'] !== undefined) {
      const v = num(body['faststartThresholdMb']);
      if (v === undefined || v < 1 || v > 102_400) {
        return reply.code(400).send({ error: 'bad-faststart-threshold', message: '阈值需在 1..102400 MB' });
      }
      next.faststartThresholdMb = v;
    }
    if (body['cleanupIntermediate'] !== undefined) {
      next.cleanupIntermediate = body['cleanupIntermediate'] === true;
    }
    if (body['notify'] !== undefined) {
      const v = obj(body['notify']);
      if (v === undefined) return reply.code(400).send({ error: 'bad-notify', message: 'notify 必须是对象' });
      next.notify = v;
    }
    if (body['outputDir'] !== undefined) {
      const v = str(body['outputDir']);
      if (v === undefined) return reply.code(400).send({ error: 'bad-output-dir', message: 'outputDir 必须是字符串' });
      next.outputDir = v;
    }

    const merged = { ...service.store.getSettings(), ...next };
    const saved = service.applySettings(merged);
    return {
      settings: saved,
      note:
        next.pollIntervalS !== undefined
          ? '轮询间隔重启后生效；其余设置已生效'
          : next.outputDir !== undefined
            ? '录制目录重启后生效'
            : '已生效',
    };
  });

  app.post<{ Body: Body }>('/api/settings/notify/test', async (req) => {
    const channel = str(req.body?.['channel']);
    return { results: await service.sendTestNotification(channel) };
  });

  /** 生成 VAPID 密钥并直接写进通知配置（Web Push 需要 secure context） */
  app.post('/api/settings/webpush/vapid', async () => {
    const keys = generateVapidKeys();
    const settings = service.store.getSettings();
    const notify = { ...settings.notify };
    const current = obj(notify['webpush']) ?? {};
    notify['webpush'] = {
      ...current,
      enabled: current['enabled'] === true,
      subject: str(current['subject']) ?? 'mailto:admin@localhost',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subscriptions: Array.isArray(current['subscriptions']) ? current['subscriptions'] : [],
    };
    const saved = service.applySettings({ ...settings, notify });
    return { publicKey: keys.publicKey, settings: saved };
  });
}
