/**
 * 跨会话合并的 HTTP 面：受理 → 202，进度看任务行（`GET /api/merges/:id`）。
 *
 * 为什么不是同步接口：一场两小时的直播拼接要跑几分钟，HTTP 超时比失败更难解释。
 * 前端靠 SSE 的"变脏"信号轮询这个 GET，与录制进度的机制一致。
 */
import type { FastifyInstance } from 'fastify';
import type { TidewatchService } from '../service.ts';

type Body = Record<string, unknown>;

const MAX_SESSIONS = 24;

export function registerMergeRoutes(app: FastifyInstance, service: TidewatchService): void {
  app.post<{ Body: Body }>('/api/merges', async (req, reply) => {
    const raw = req.body?.['sessionIds'];
    if (!Array.isArray(raw)) {
      return reply.code(400).send({ error: 'bad-request', message: '需要 sessionIds 数组' });
    }
    // 去重但保留顺序：重复选中同一场是用户手滑，不该报错，也不该拼两遍
    const ids: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0) {
        return reply.code(400).send({ error: 'bad-request', message: 'sessionIds 里只能是非空字符串' });
      }
      if (!ids.includes(item)) ids.push(item);
    }
    if (ids.length < 2) {
      return reply.code(400).send({ error: 'not-enough-sessions', message: '至少选两场才能合并' });
    }
    if (ids.length > MAX_SESSIONS) {
      return reply.code(400).send({ error: 'too-many-sessions', message: `一次最多合并 ${String(MAX_SESSIONS)} 场` });
    }

    const sessions = [];
    const missing: string[] = [];
    for (const id of ids) {
      const session = service.store.getSession(id);
      if (session === undefined) missing.push(id);
      else sessions.push(session);
    }
    if (missing.length > 0) {
      return reply.code(404).send({ error: 'not-found', message: `会话不存在：${missing.join(', ')}` });
    }

    const open = sessions.filter((s) => s.endedAt === null);
    if (open.length > 0) {
      return reply
        .code(409)
        .send({ error: 'session-open', message: '有会话还在录制，先停止再合并', sessionIds: open.map((s) => s.id) });
    }

    const busy = sessions.filter((s) => service.post.isBusy(s.id) || service.merger.isBusy(s.id));
    if (busy.length > 0) {
      return reply
        .code(409)
        .send({ error: 'busy', message: '有会话正在被其他任务使用，稍后再试', sessionIds: busy.map((s) => s.id) });
    }

    // 合并顺序 = 开始时间，与用户在列表里勾选的先后无关
    sessions.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const job = service.store.createMergeJob(sessions.map((s) => s.id));
    void service.merger.run(job.id).catch((err: unknown) => {
      app.log.warn({ err, jobId: job.id }, '跨会话合并异常');
    });
    return reply.code(202).send({ job });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/merges', async (req) => ({
    merges: service.store.listMergeJobs(Number(req.query.limit ?? 20)),
  }));

  app.get<{ Params: { id: string } }>('/api/merges/:id', async (req, reply) => {
    const job = service.store.getMergeJob(req.params.id);
    if (job === undefined) return reply.code(404).send({ error: 'not-found', message: '合并任务不存在' });
    return {
      merge: job,
      // 源会话摘要：界面要能点回去，也要能在失败时告诉用户是哪一场有问题
      sources: job.sessionIds.map((id) => {
        const session = service.store.getSession(id);
        if (session === undefined) {
          return { id, missing: true, startedAt: null, endedAt: null, streamerName: null, platform: null, segmentCount: 0, durationS: 0 };
        }
        const task = service.store.getTask(session.taskId);
        return {
          id,
          missing: false,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          streamerName: task?.streamerName ?? null,
          platform: task?.platform ?? null,
          segmentCount: service.store.listSegments(id).length,
          durationS: service.store.sumSegmentDuration(id),
        };
      }),
    };
  });
}
