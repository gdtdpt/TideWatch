/**
 * M4 控制面契约（app.inject，不起端口）。
 *
 * 三条"改坏了会静默出事"的地方必须有用例：
 * ① 控制面三个标志互不覆盖（复选框 / 这一场 / 立即检查）；
 * ② 会话视图的派生字段（段数、时长、有无产物）与库一致；
 * ③ WS 升级必须认证 —— 没有它，局域网里任何人 `wscat` 就能看你的录制流水。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

process.env['LOG_LEVEL'] = 'silent';

import { createHostAdapter } from '@tidewatch/host-adapter';
import { buildApp } from './app.ts';
import { loadOrCreateToken, SESSION_COOKIE } from './auth.ts';
import { TidewatchService } from './service.ts';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Ctx {
  app: FastifyInstance;
  service: TidewatchService;
  dataRoot: string;
  sid: string;
  get<T = Record<string, unknown>>(url: string): Promise<{ statusCode: number; body: T }>;
  send<T = Record<string, unknown>>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ statusCode: number; body: T }>;
}

async function makeApp(): Promise<Ctx> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tidewatch-api-'));
  dirs.push(dataRoot);
  const resourceRoot = process.cwd();
  const host = createHostAdapter({
    dataRoot,
    resourceRoot,
    defaultDownloads: join(dataRoot, 'downloads'),
    port: 8686,
  });
  const service = new TidewatchService({
    dataRoot,
    resourceRoot,
    host,
    version: 'test',
    port: 8686,
    engine: false,
    logger: { info: () => undefined, warn: () => undefined },
  });
  const app = await buildApp({ dataRoot, service, engine: false, version: 'test' });
  apps.push(app);

  const { token } = loadOrCreateToken(dataRoot);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
  const sid = /tw_session=([^;]+)/.exec(String(login.headers['set-cookie']))?.[1] ?? '';
  const cookie = `${SESSION_COOKIE}=${sid}`;

  return {
    app,
    service,
    dataRoot,
    sid,
    get: async <T>(url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      return { statusCode: res.statusCode, body: res.json<T>() };
    },
    send: async <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
      const res = await app.inject({
        method,
        url,
        headers: { cookie, 'x-tidewatch-client': '1' },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      return { statusCode: res.statusCode, body: res.json<T>() };
    },
  };
}

describe('任务控制面', () => {
  it('重复地址：409 带回已有任务 id（界面据此定位，而不是只报"已存在"）', async () => {
    const c = await makeApp();
    const url = 'https://live.bilibili.com/6192987';
    const task = c.service.store.addTask({ url, platform: 'bilibili', monitorEnabled: true });

    const res = await c.send<{ error: string; message: string; taskId: string }>('POST', '/api/tasks', { url });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('duplicate');
    expect(res.body.taskId).toBe(task.id);
    // 去重发生在探测之前：不该因为重复而多发一次插件调用（也没有真的联网）
    expect(c.service.store.listTasks()).toHaveLength(1);
  });

  it('三个标志互不覆盖：复选框=自动 / 按钮=这一场 / 徽标=状态', async () => {
    const c = await makeApp();
    const task = c.service.store.addTask({ url: 'https://live.douyin.com/1', platform: 'douyin', monitorEnabled: true });

    const list = await c.get<{ tasks: { id: string; runtime: { state: string }; latestSession: unknown }[] }>('/api/tasks');
    expect(list.statusCode).toBe(200);
    expect(list.body.tasks[0]?.runtime.state).toBe('idle');
    expect(list.body.tasks[0]?.latestSession).toBeNull();

    // 关掉自动档不影响"这一场"
    const off = await c.send<{ task: { monitorEnabled: boolean } }>('POST', `/api/tasks/${task.id}/monitor`, {
      enabled: false,
    });
    expect(off.body.task.monitorEnabled).toBe(false);

    const rec = await c.send<{ task: { recordRequested: boolean; checkNow: boolean } }>(
      'POST',
      `/api/tasks/${task.id}/record`,
      { recording: true },
    );
    expect(rec.body.task.recordRequested).toBe(true);
    expect(rec.body.task.checkNow).toBe(true);
    // 自动档仍然是关的：两个标志是正交的
    expect(c.service.store.getTask(task.id)?.monitorEnabled).toBe(false);

    // 手动停止 → 不再挂"这一场"
    const stop = await c.send<{ task: { recordRequested: boolean } }>('POST', `/api/tasks/${task.id}/record`, {
      recording: false,
    });
    expect(stop.statusCode).toBe(200);
    expect(c.service.store.getTask(task.id)?.recordRequested).toBe(false);

    const check = await c.send('POST', `/api/tasks/${task.id}/check`);
    expect(check.statusCode).toBe(200);
    expect(c.service.store.getTask(task.id)?.checkNow).toBe(true);
  });

  it('非法参数一律 400，且不落库', async () => {
    const c = await makeApp();
    const task = c.service.store.addTask({ url: 'https://live.douyin.com/2', platform: 'douyin', monitorEnabled: true });

    expect((await c.send('PATCH', `/api/tasks/${task.id}`, { segmentTimeS: 5 })).statusCode).toBe(400);
    expect((await c.send('PATCH', `/api/tasks/${task.id}`, { postprocess: 'weird' })).statusCode).toBe(400);
    expect((await c.send('PATCH', `/api/tasks/${task.id}`, { maxSessionS: 60 })).statusCode).toBe(400);
    expect((await c.send('PATCH', `/api/tasks/${task.id}`, { maxSessionBytes: 10 })).statusCode).toBe(400);

    const ok = await c.send<{ task: { segmentTimeS: number } }>('PATCH', `/api/tasks/${task.id}`, {
      segmentTimeS: 600,
      postprocess: 'per_segment',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.task.segmentTimeS).toBe(600);
    expect(c.service.store.getTask(task.id)?.postprocess).toBe('per_segment');
  });

  it('删除任务会级联删除会话索引（磁盘文件保留）—— 已知行为，UI 必须提前告知', async () => {
    const c = await makeApp();
    const task = c.service.store.addTask({ url: 'https://live.douyin.com/3', platform: 'douyin' });
    const sessionId = c.service.store.createSession({
      taskId: task.id,
      startedAt: new Date().toISOString(),
      outputDir: '/out/x',
      origin: 'new',
    });

    expect((await c.send('DELETE', `/api/tasks/${task.id}`)).statusCode).toBe(200);
    expect(c.service.store.getTask(task.id)).toBeUndefined();
    // schema 里 sessions.task_id 是 ON DELETE CASCADE：任务一删，历史索引跟着走
    expect(c.service.store.getSession(sessionId)).toBeUndefined();
    expect((await c.get(`/api/sessions/${sessionId}`)).statusCode).toBe(404);
  });
});

describe('会话与事件', () => {
  it('会话视图带段数/时长/有无产物，详情带分段与产物', async () => {
    const c = await makeApp();
    const task = c.service.store.addTask({ url: 'https://live.douyin.com/4', platform: 'douyin', streamerName: '主播A' });
    const startedAt = new Date().toISOString();
    const sessionId = c.service.store.createSession({
      taskId: task.id,
      startedAt,
      outputDir: '/out/主播A/1',
      origin: 'new',
    });
    c.service.store.endSession(sessionId, 'offline', startedAt);
    for (const partNo of [1, 2]) {
      c.service.store.insertSegment({
        sessionId,
        path: `/out/主播A/1/s_part00${String(partNo)}.ts`,
        partNo,
        startedAt,
        durationS: 60,
        sizeBytes: 1024,
        integrity: 'ok',
      });
    }
    c.service.store.upsertArtifact({
      sessionId,
      path: '/out/主播A/1/主播A.mp4',
      kind: 'merged',
      durationS: 120,
      sizeBytes: 2048,
      createdAt: startedAt,
    });
    c.service.store.insertEvent({ kind: 'recording.gap', payload: { after_part: 1 }, sessionId });

    const list = await c.get<{ sessions: { segmentCount: number; durationS: number; hasArtifact: boolean }[] }>(
      '/api/sessions',
    );
    expect(list.body.sessions[0]).toMatchObject({ segmentCount: 2, durationS: 120, hasArtifact: true });

    const detail = await c.get<{ segments: unknown[]; artifacts: unknown[] }>(`/api/sessions/${sessionId}`);
    expect(detail.body.segments).toHaveLength(2);
    expect(detail.body.artifacts).toHaveLength(1);

    const events = await c.get<{ events: { kind: string }[] }>(`/api/sessions/${sessionId}/events`);
    expect(events.body.events.map((e) => e.kind)).toContain('recording.gap');

    expect((await c.get('/api/sessions/nope')).statusCode).toBe(404);
  });

  it('后处理用 202 + 事件反馈，不是同步 HTTP', async () => {
    const c = await makeApp();
    const task = c.service.store.addTask({ url: 'https://live.douyin.com/5', platform: 'douyin' });
    const sessionId = c.service.store.createSession({
      taskId: task.id,
      startedAt: new Date().toISOString(),
      outputDir: '/out/empty',
      origin: 'new',
    });
    const res = await c.send<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/merge`, {});
    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
  });

  it('事件支持 since 游标补齐（WS 断线的兜底路径）', async () => {
    const c = await makeApp();
    c.service.store.insertEvent({ kind: 'a', payload: {} });
    const first = c.service.store.insertEvent({ kind: 'b', payload: {} });
    c.service.store.insertEvent({ kind: 'c', payload: {} });

    const res = await c.get<{ events: { id: number; kind: string }[] }>(`/api/events?since=${String(first)}`);
    expect(res.body.events.map((e) => e.kind)).toEqual(['c']);
  });
});

describe('设置', () => {
  it('GET 带路径与运行时信息（缺件不下载，只给引导）', async () => {
    const c = await makeApp();
    const res = await c.get<{ settings: Record<string, unknown>; paths: Record<string, string>; runtime: Record<string, unknown> }>(
      '/api/settings',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.settings['pollIntervalS']).toBe(30);
    expect(res.body.paths['dataRoot']).toBe(c.dataRoot);
    expect(res.body.runtime['ffmpeg']).toBeTruthy();
    expect(res.body.runtime['cookieBackend']).toBeTruthy();
  });

  it('范围校验 + 立刻生效的提示语区分「重启生效」与「已生效」', async () => {
    const c = await makeApp();
    expect((await c.send('PUT', '/api/settings', { pollIntervalS: 2 })).statusCode).toBe(400);
    expect((await c.send('PUT', '/api/settings', { notify: 'x' })).statusCode).toBe(400);
    expect((await c.send('PUT', '/api/settings', { faststart: 'maybe' })).statusCode).toBe(400);

    const poll = await c.send<{ settings: { pollIntervalS: number }; note: string }>('PUT', '/api/settings', {
      pollIntervalS: 60,
    });
    expect(poll.body.settings.pollIntervalS).toBe(60);
    expect(poll.body.note).toContain('重启');

    const fast = await c.send<{ settings: { faststart: string }; note: string }>('PUT', '/api/settings', {
      faststart: 'on',
    });
    expect(fast.body.settings.faststart).toBe('on');
    expect(fast.body.note).toBe('已生效');

    const out = await c.send<{ note: string }>('PUT', '/api/settings', { outputDir: '/tmp/elsewhere' });
    expect(out.body.note).toContain('录制目录');
  });
});

describe('通知', () => {
  it('列表带未读数，已读后归零', async () => {
    const c = await makeApp();
    const id1 = c.service.store.insertNotification({ kind: 'merge_failed', level: 'error', title: '合并失败', body: 'x' });
    c.service.store.insertNotification({ kind: 'recording_ended', level: 'info', title: '录制结束', body: 'y' });

    const list = await c.get<{ unread: number; notifications: unknown[] }>('/api/notifications');
    expect(list.body.unread).toBe(2);
    expect(list.body.notifications).toHaveLength(2);

    const read = await c.send<{ unread: number }>('POST', '/api/notifications/read', { ids: [id1] });
    expect(read.body.unread).toBe(1);
  });

  it('标已读后向所有在线客户端广播未读数（否则别的标签页角标不动）', async () => {
    const c = await makeApp();
    c.service.store.insertNotification({ kind: 'merge_failed', level: 'error', title: '合并失败', body: 'x' });
    // 「标记已读」是阅读动作，不进 events 表，所以不能靠事件增量推送；
    // 少了这条广播，手机点了已读、桌面端角标会一直停在旧数字。
    await c.app.listen({ port: 0, host: '127.0.0.1' });
    const address = c.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const frame = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`, {
        headers: { cookie: `${SESSION_COOKIE}=${c.sid}` },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('3s 内没收到 notifications_read'));
      }, 3_000);
      ws.on('message', (data: Buffer) => {
        const text = data.toString('utf8');
        // hello 先到，标已读的通知消息在它之后
        if (!text.includes('notifications_read')) return;
        clearTimeout(timer);
        ws.close();
        resolve(text);
      });
      ws.on('open', () => {
        void c.send('POST', '/api/notifications/read', { ids: [] });
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(JSON.parse(frame)).toMatchObject({ type: 'notifications_read', unread: 0 });
  });
});

describe('诊断与回放', () => {
  it('诊断包落 exports/ 并返回绝对路径（无壳形态没有保存对话框）', async () => {
    const c = await makeApp();
    const res = await c.send<{ path: string }>('POST', '/api/diagnostics/export');
    expect(res.statusCode).toBe(200);
    expect(res.body.path.startsWith(join(c.dataRoot, 'exports'))).toBe(true);
    expect(existsSync(res.body.path)).toBe(true);

    const md = await c.app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { cookie: `${SESSION_COOKIE}=${c.sid}` },
    });
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain('TideWatch');
  });

  it('/api/videos 只放行录制目录内（防目录穿越）', async () => {
    const c = await makeApp();
    expect((await c.get('/api/videos')).statusCode).toBe(400);
    const escape = await c.get('/api/videos?path=/etc/passwd');
    expect(escape.statusCode).toBe(403);
  });
});

describe('WS 事件流鉴权', () => {
  it('没有 session cookie 的升级被拒绝（不能靠 query token 绕过）', async () => {
    const c = await makeApp();
    await c.app.listen({ port: 0, host: '127.0.0.1' });
    const address = c.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const result = await new Promise<{ opened: boolean; status?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ opened: false });
      }, 3_000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve({ opened: true });
      });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        resolve({ opened: false, ...(res.statusCode === undefined ? {} : { status: res.statusCode }) });
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve({ opened: false });
      });
    });

    expect(result.opened).toBe(false);
    expect(result.status).toBe(401);
  });

  it('带 cookie 的升级成功，并先收到 hello 游标', async () => {
    const c = await makeApp();
    await c.app.listen({ port: 0, host: '127.0.0.1' });
    const address = c.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`, {
        headers: { cookie: `${SESSION_COOKIE}=${c.sid}` },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('3s 内没收到 hello'));
      }, 3_000);
      ws.on('message', (data: Buffer) => {
        clearTimeout(timer);
        const text = data.toString('utf8');
        ws.close();
        resolve(text);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(JSON.parse(hello)).toMatchObject({ type: 'hello' });
  });
});
