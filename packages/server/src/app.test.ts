import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// 测试里不需要 pino 的请求流水
process.env['LOG_LEVEL'] = 'silent';
import { buildApp } from './app.ts';
import { loadOrCreateToken, SESSION_COOKIE } from './auth.ts';

const dirs: string[] = [];

function tmpDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-server-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('API 契约（app.inject，不起端口）', () => {
  it('health 免鉴权', async () => {
    const app = await buildApp({ dataRoot: tmpDataRoot() });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: 'tidewatch' });
    await app.close();
  });

  it('未登录访问受保护端点 → 401；错误 token → 401；正确 token → 200 且拿到 cookie', async () => {
    const dataRoot = tmpDataRoot();
    const app = await buildApp({ dataRoot });
    const { token } = loadOrCreateToken(dataRoot);

    const anon = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(anon.statusCode).toBe(401);

    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    expect(ok.statusCode).toBe(200);
    const raw = ok.headers['set-cookie'];
    const setCookie = Array.isArray(raw) ? raw.join(';') : String(raw);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');

    const sid = /tw_session=([^;]+)/.exec(setCookie)?.[1];
    expect(sid).toBeTruthy();

    const withCookie = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${sid ?? ''}` },
    });
    expect(withCookie.statusCode).toBe(200);
    await app.close();
  });

  it('非安全方法缺 X-TideWatch-Client → 403（CSRF）', async () => {
    const dataRoot = tmpDataRoot();
    const app = await buildApp({ dataRoot });
    const { token } = loadOrCreateToken(dataRoot);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    const setCookie = String(login.headers['set-cookie']);
    const sid = /tw_session=([^;]+)/.exec(setCookie)?.[1] ?? '';

    const noHeader = await app.inject({
      method: 'POST',
      url: '/api/shutdown',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(noHeader.statusCode).toBe(403);

    const withHeader = await app.inject({
      method: 'POST',
      url: '/api/shutdown',
      headers: { cookie: `${SESSION_COOKIE}=${sid}`, 'x-tidewatch-client': '1' },
    });
    expect(withHeader.statusCode).toBe(202);
    await app.close();
  });

  it('未知 /api 路径：未登录先 401（fail-closed，不泄露端点是否存在）；登录后才回 JSON 404', async () => {
    const dataRoot = tmpDataRoot();
    const app = await buildApp({ dataRoot, version: 'test' });

    const anon = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(anon.statusCode).toBe(401);

    const { token } = loadOrCreateToken(dataRoot);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    const sid = /tw_session=([^;]+)/.exec(String(login.headers['set-cookie']))?.[1] ?? '';

    const authed = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(authed.statusCode).toBe(404);
    expect(authed.json()).toMatchObject({ error: 'not-found' });
    await app.close();
  });
});
