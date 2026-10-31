#!/usr/bin/env node
/**
 * 控制面冒烟：不需要浏览器，验证「服务在跑 / 鉴权生效 / CSRF 生效 / 二进制就绪」。
 *
 *   node tools/smoke.mjs                       # 默认 8686 + ./data
 *   node tools/smoke.mjs --port 8690 --data /tmp/tw-live3
 *   node tools/smoke.mjs --shutdown            # 跑完顺手优雅停掉 daemon
 *
 * 退出码 0 = 全过；1 = 有失败项。真实录制链路由 docs/manual-test.md 的人工步骤覆盖。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const port = Number(argOf('port', '8686'));
const dataRoot = argOf('data', './data');
const base = `http://127.0.0.1:${String(port)}`;

let token;
try {
  token = readFileSync(join(dataRoot, 'auth-token.txt'), 'utf8').trim();
} catch {
  console.error(`读不到 ${join(dataRoot, 'auth-token.txt')} —— 确认 --data 是正在运行的 daemon 的数据根`);
  process.exit(1);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail ?? '' });
  } catch (err) {
    results.push({ ok: false, name, detail: err instanceof Error ? err.message : String(err) });
  }
}

const req = (path, init = {}) => fetch(`${base}${path}`, init);

let cookie = '';

await check('health 可公开访问', async () => {
  const res = await req('/api/health');
  const body = await res.json();
  if (!res.ok || body.ok !== true) throw new Error(`HTTP ${String(res.status)}`);
  const lease = body.lease?.acquired === true ? '租约持有' : '租约未持有（引擎不会跑）';
  return `schema v${String(body.schemaVersion)} · ${lease}`;
});

await check('ffmpeg / ffprobe 就绪', async () => {
  const body = await (await req('/api/health')).json();
  const b = body.binaries ?? {};
  const bad = ['ffmpeg', 'ffprobe'].filter((k) => b[k]?.ok !== true);
  if (bad.length > 0) {
    throw new Error(`缺 ${bad.join(' / ')} —— 跑 pnpm fetch:ffmpeg，或用 TIDEWATCH_FFMPEG 指绝对路径`);
  }
  return ['ffmpeg', 'ffprobe']
    .map((k) => `${k} ${String(b[k].version ?? '?')}(${String(b[k].source)})`)
    .join(' · ');
});

await check('未登录访问接口返回 401', async () => {
  const res = await req('/api/tasks');
  if (res.status !== 401) throw new Error(`期望 401，实际 ${String(res.status)}`);
  return '401';
});

await check('token 登录拿到会话 cookie', async () => {
  const res = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}（token 是否来自这个数据根？）`);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('tw_session=')) ?? '';
  cookie = raw.split(';')[0] ?? '';
  if (cookie.length === 0) throw new Error('响应里没有 tw_session');
  return 'tw_session 已下发';
});

await check('带 cookie 读任务列表', async () => {
  const res = await req('/api/tasks', { headers: { cookie } });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const body = await res.json();
  return `${String(body.tasks.length)} 个任务`;
});

await check('写操作缺 CSRF 头返回 403', async () => {
  const res = await req('/api/tasks', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://live.bilibili.com/5050' }),
  });
  if (res.status !== 403) throw new Error(`期望 403，实际 ${String(res.status)}`);
  return '403';
});

await check('WS 事件流需要会话（无 cookie 被拒）', async () => {
  const ok = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
    const done = (v) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    ws.onopen = () => done('open');
    ws.onclose = () => done('closed');
    ws.onerror = () => done('closed');
    setTimeout(() => done('timeout'), 4000);
  });
  if (ok === 'open') throw new Error('无 cookie 也升级成功了——鉴权有漏');
  return '升级被拒';
});

for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail === '' ? '' : ` — ${r.detail}`}`);
const failed = results.filter((r) => !r.ok).length;

if (argv.includes('--shutdown')) {
  const res = await req('/api/shutdown', { method: 'POST', headers: { cookie, 'x-tidewatch-client': '1' } });
  console.log(res.status === 202 ? '✓ 已请求优雅停止（202）' : `✗ 停止失败 HTTP ${String(res.status)}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${String(failed)} 项失败`);
process.exit(failed === 0 ? 0 : 1);
