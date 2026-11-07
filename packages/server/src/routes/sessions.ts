/**
 * 会话与分段：录制页的数据源。
 * 后处理是**异步 202 + 事件流反馈**，不是同步 HTTP（合并可能跑几分钟）。
 */
import type { FastifyInstance } from 'fastify';
import type { TidewatchService } from '../service.ts';

type Body = Record<string, unknown>;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export function registerSessionRoutes(app: FastifyInstance, service: TidewatchService): void {
  app.get<{ Querystring: { task?: string; limit?: string; offset?: string } }>(
    '/api/sessions',
    async (req) => {
      const sessions = service.store.listSessions({
        ...(req.query.task === undefined ? {} : { taskId: req.query.task }),
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      return {
        sessions: sessions.map((s) => {
          const task = service.store.getTask(s.taskId);
          return {
            ...s,
            platform: task?.platform ?? null,
            streamerName: task?.streamerName ?? null,
            segmentCount: service.store.listSegments(s.id).length,
            durationS: service.store.sumSegmentDuration(s.id),
            hasArtifact: service.store.listArtifacts(s.id).length > 0,
          };
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = service.store.getSession(req.params.id);
    if (session === undefined) return reply.code(404).send({ error: 'not-found', message: '会话不存在' });
    return {
      session,
      task: service.store.getTask(session.taskId) ?? null,
      segments: service.store.listSegments(session.id),
      artifacts: service.store.listArtifacts(session.id),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/sessions/:id/events',
    async (req, reply) => {
      const session = service.store.getSession(req.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'not-found', message: '会话不存在' });
      // 直接按 session_id 查（idx_events_session）。老写法是"捞最新 1000 条再过滤"，
      // 库里事件一多，越老的会话时间线越容易空 —— 与归档无关，是查询本身的问题。
      const before = Number(req.query.before ?? 0);
      const events = service.store.listSessionEvents(session.id, {
        limit: Number(req.query.limit ?? 200),
        ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      });
      return { events };
    },
  );

  app.post<{ Params: { id: string }; Body: Body }>('/api/sessions/:id/merge', async (req, reply) => {
    const session = service.store.getSession(req.params.id);
    if (session === undefined) return reply.code(404).send({ error: 'not-found', message: '会话不存在' });
    if (service.post.isBusy(session.id)) {
      return reply.code(409).send({ error: 'busy', message: '该会话已有后处理在跑' });
    }
    const faststart = bool(req.body?.['faststart']);
    const cleanup = bool(req.body?.['cleanupSources']) ?? false;
    void service.post
      .processSession(session.id, {
        ...(faststart === undefined ? {} : { faststart }),
        cleanupSources: cleanup,
      })
      .catch((err: unknown) => {
        app.log.warn({ err, sessionId: session.id }, '手动后处理失败');
      });
    return reply.code(202).send({ ok: true, message: '已受理，进度看 merge.* 事件' });
  });

  app.get<{ Querystring: { since?: string; limit?: string } }>('/api/events', async (req) => {
    const since = Number(req.query.since ?? 0);
    return {
      events: service.store.listEvents({
        ...(Number.isFinite(since) && since > 0 ? { since } : {}),
        limit: Number(req.query.limit ?? 200),
      }),
    };
  });
}
