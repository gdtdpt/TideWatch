/**
 * 任务控制面：CRUD + 三件独立的事（监控 / 这一场 / 立即检查）。
 * 复选框 = 要不要自动；按钮 = 这一刻要不要录；徽标 = 在播/在录的状态。
 */
import type { FastifyInstance } from 'fastify';
import type { Task } from '@tidewatch/store';
import {
  MAX_MAX_SESSION_BYTES,
  MAX_MAX_SESSION_S,
  MIN_MAX_SESSION_BYTES,
  MIN_MAX_SESSION_S,
} from '@tidewatch/store';
import type { TidewatchService } from '../service.ts';

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export function taskView(service: TidewatchService, task: Task): Record<string, unknown> {
  const runtime = service.store.getRuntime(task.id);
  const latest = service.store.listSessions({ taskId: task.id, limit: 1 })[0] ?? null;
  return {
    ...task,
    runtime: runtime ?? { taskId: task.id, state: 'idle', detail: null, updatedAt: task.updatedAt },
    latestSession: latest,
  };
}

export function registerTaskRoutes(app: FastifyInstance, service: TidewatchService): void {
  app.get('/api/tasks', async () => ({
    tasks: service.store.listTasks().map((t) => taskView(service, t)),
  }));

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    return { task: taskView(service, task) };
  });

  app.post<{ Body: Body }>('/api/tasks', async (req, reply) => {
    const url = str(req.body?.['url'])?.trim() ?? '';
    if (!/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: 'bad-url', message: '请填写 http(s) 地址' });
    }
    const existing = service.store.getTaskByUrl(url);
    if (existing !== undefined) {
      // 带上 id：界面据此"定位到已有任务"，而不是把用户堵在一句"已存在"上
      return reply
        .code(409)
        .send({ error: 'duplicate', message: '这个地址已经在任务里了', taskId: existing.id });
    }
    const probedAt = Date.now();
    const probe = await service.resolver.probeUrl(url);
    const probeMs = Date.now() - probedAt;
    if (probeMs > 3_000) req.log.warn({ url, probeMs }, '插件探测偏慢（添加任务的人工等待）');
    if (!probe.ok) {
      return reply.code(400).send({ error: 'unsupported', message: probe.message ?? '不支持的地址' });
    }
    const monitorEnabled = bool(req.body?.['monitor']) ?? true;
    const quality = str(req.body?.['quality']);
    const task = service.store.addTask({
      url,
      platform: probe.platform ?? '',
      monitorEnabled,
      ...(quality === undefined ? {} : { quality }),
    });
    if (monitorEnabled) service.engine.wake(task.id);
    return reply.code(201).send({ task: taskView(service, task) });
  });

  app.patch<{ Params: { id: string }; Body: Body }>('/api/tasks/:id', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    const body = req.body ?? {};

    if (body['quality'] !== undefined && body['quality'] !== null && typeof body['quality'] !== 'string') {
      return reply.code(400).send({ error: 'bad-quality', message: 'quality 必须是字符串' });
    }
    const segmentTimeS = num(body['segmentTimeS']);
    if (segmentTimeS !== undefined && (segmentTimeS < 30 || segmentTimeS > 43_200)) {
      return reply.code(400).send({ error: 'bad-segment-time', message: '分段时长需在 30..43200 秒' });
    }
    const postprocess = str(body['postprocess']);
    if (postprocess !== undefined && !['merge', 'per_segment', 'manual'].includes(postprocess)) {
      return reply.code(400).send({ error: 'bad-postprocess', message: '后处理策略非法' });
    }
    const maxSessionS = num(body['maxSessionS']);
    if (maxSessionS !== undefined && maxSessionS !== 0 && (maxSessionS < MIN_MAX_SESSION_S || maxSessionS > MAX_MAX_SESSION_S)) {
      return reply.code(400).send({ error: 'bad-max-session', message: '单场上限需在 600..21600 秒（0 = 按默认 6 小时）' });
    }
    const maxSessionBytes = num(body['maxSessionBytes']);
    if (
      maxSessionBytes !== undefined &&
      maxSessionBytes !== 0 &&
      (maxSessionBytes < MIN_MAX_SESSION_BYTES || maxSessionBytes > MAX_MAX_SESSION_BYTES)
    ) {
      return reply.code(400).send({ error: 'bad-max-bytes', message: '单场体积上限需在 1MiB..100GiB（0 = 按默认）' });
    }

    const updated = service.store.patchTask(task.id, {
      ...(str(body['quality']) !== undefined ? { quality: str(body['quality']) ?? null } : {}),
      ...(segmentTimeS === undefined ? {} : { segmentTimeS }),
      ...(postprocess === undefined ? {} : { postprocess: postprocess as Task['postprocess'] }),
      ...(maxSessionS === undefined ? {} : { maxSessionS }),
      ...(maxSessionBytes === undefined ? {} : { maxSessionBytes }),
    });
    return { task: taskView(service, updated) };
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    await service.engine.requestStop(task.id);
    service.store.deleteTask(task.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: Body }>('/api/tasks/:id/monitor', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    const enabled = bool(req.body?.['enabled']) ?? true;
    const updated = service.store.setMonitor(task.id, enabled);
    if (enabled) service.engine.wake(task.id);
    return { task: taskView(service, updated) };
  });

  app.post<{ Params: { id: string }; Body: Body }>('/api/tasks/:id/record', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    const recording = bool(req.body?.['recording']) ?? true;
    if (recording) {
      const updated = service.store.patchTask(task.id, {
        recordRequested: true,
        skipCurrentLive: false,
        checkNow: true,
      });
      return { task: taskView(service, updated) };
    }
    await service.engine.requestStop(task.id);
    const updated = service.store.getTask(task.id) ?? task;
    return { task: taskView(service, updated) };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/check', async (req, reply) => {
    const task = service.store.getTask(req.params.id);
    if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
    service.engine.wake(task.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { segments?: string; limit?: string } }>(
    '/api/tasks/:id/sessions',
    async (req, reply) => {
      const task = service.store.getTask(req.params.id);
      if (task === undefined) return reply.code(404).send({ error: 'not-found', message: '任务不存在' });
      const sessions = service.store.listSessions({
        taskId: task.id,
        limit: Number(req.query.limit ?? 50),
      });
      if (req.query.segments !== '1') return { sessions };
      return {
        sessions: sessions.map((s) => ({ ...s, segments: service.store.listSegments(s.id) })),
      };
    },
  );

  // 上限常量暴露给 UI（不重复写死 600/21600）
  app.get('/api/limits', async () => ({
    maxSessionS: { min: MIN_MAX_SESSION_S, max: MAX_MAX_SESSION_S, def: 21_600 },
    maxSessionBytes: { min: MIN_MAX_SESSION_BYTES, max: MAX_MAX_SESSION_BYTES, def: 20 * 1024 ** 3 },
  }));
}
