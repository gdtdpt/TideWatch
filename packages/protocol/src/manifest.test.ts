/**
 * 清单校验与注册表（M3）回归锁：白名单是安全边界，遮蔽是优先级语义。
 *
 * 两类事故值得钉死：
 * ① 用户可写目录里的 plugin.json 写个 `exec: "/bin/sh"` 就能执行任意命令；
 * ② 同名插件遮蔽不报，症状是"我明明换了插件，行为没变"。
 */
import { describe, expect, it } from 'vitest';
import { normalizePath, parseManifest, planLaunch, type PluginManifest } from './manifest.ts';
import { buildRegistry, type PluginEntry } from './registry.ts';

const ctx = { pluginDir: '/data/plugins/streamget', resourceRoot: '/app', pythonPath: '/usr/bin/python3', nodePath: null };

function manifestOf(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'streamget',
    version: '0.2.0',
    protocol: 2,
    exec: '{python}',
    args: ['{plugin_dir}/main.py'],
    env: { PYTHONPATH: '{plugin_dir}/site-packages' },
    modes: ['oneshot', 'serve'],
    urlPatterns: ['live.douyin.com', 'live.bilibili.com'],
    platforms: ['douyin', 'bilibili'],
    requires: { runtime: { kind: 'python', version: '>=3.10' }, optional: [] },
    ...over,
  };
}

describe('plugin.json 解析', () => {
  it('必填项缺失或协议过高都要拒绝（协议不兼容会以"插件没反应"出现）', () => {
    expect(parseManifest({ version: '1', protocol: 2, exec: 'x' })).toEqual({ error: '缺少 name' });
    expect(parseManifest({ name: 'a', protocol: 2 })).toEqual({ error: '缺少 exec' });
    const tooNew = parseManifest({ name: 'a', protocol: 99, exec: '{python}' });
    expect('error' in tooNew && tooNew.error).toContain('协议 99');
  });

  it('snake_case 字段映射到内部驼峰，缺省值补齐', () => {
    const parsed = parseManifest({
      name: 'p',
      version: '1.2.3',
      protocol: 2,
      exec: '{python}',
      url_patterns: ['x.com'],
      platforms: ['x'],
      env: { A: 'b', bad: 1 },
    });
    expect('manifest' in parsed).toBe(true);
    if (!('manifest' in parsed)) return;
    expect(parsed.manifest.urlPatterns).toEqual(['x.com']);
    expect(parsed.manifest.platforms).toEqual(['x']);
    expect(parsed.manifest.args).toEqual([]);
    // 非字符串的 env 值直接丢掉，不做类型强转
    expect(parsed.manifest.env).toEqual({ A: 'b' });
  });
});

describe('启动计划白名单', () => {
  it('{python} 展开成宿主找到的解释器，cwd 固定为插件目录', () => {
    const result = planLaunch(manifestOf(), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.command).toBe('/usr/bin/python3');
    expect(result.plan.args).toEqual(['/data/plugins/streamget/main.py']);
    expect(result.plan.env['PYTHONPATH']).toBe('/data/plugins/streamget/site-packages');
    expect(result.plan.cwd).toBe('/data/plugins/streamget');
  });

  it('缺 Python 运行时报错，而不是静默失败', () => {
    const result = planLaunch(manifestOf(), { ...ctx, pythonPath: null });
    expect(result).toEqual({ ok: false, error: '插件需要 Python 运行时，但未找到 python' });
  });

  it('exec 不接受绝对路径与路径穿越', () => {
    for (const exec of ['/bin/sh', 'C:\\Windows\\cmd.exe', '{plugin_dir}/../../../bin/sh', '{resource}/../../bin/sh']) {
      const result = planLaunch(manifestOf({ exec }), ctx);
      expect(result.ok, exec).toBe(false);
    }
  });

  it('args / env 里的路径同样不许越界', () => {
    expect(planLaunch(manifestOf({ args: ['/etc/passwd'] }), ctx).ok).toBe(false);
    expect(planLaunch(manifestOf({ args: ['{plugin_dir}/../../evil.py'] }), ctx).ok).toBe(false);
    expect(planLaunch(manifestOf({ env: { PYTHONPATH: '/tmp' } }), ctx).ok).toBe(false);
    expect(planLaunch(manifestOf({ args: ['{unknown}/x.py'] }), ctx).ok).toBe(false);
  });

  it('普通字符串参数照旧放行（`main.py` 这种相对参数很常见）', () => {
    const result = planLaunch(manifestOf({ args: ['main.py', '--stdio'] }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.args).toEqual(['main.py', '--stdio']);
  });

  it('路径归一化保留盘符，不把 D:\\ 变成 \\', () => {
    expect(normalizePath('D:\\plugins\\a\\..\\b')).toBe('D:/plugins/b');
    expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
  });
});

describe('注册表', () => {
  const entryOf = (dir: string, sourceDir: string, over: Partial<PluginManifest> = {}): PluginEntry => ({
    manifest: manifestOf(over),
    dir,
    sourceDir,
    shadowed: [],
    missingRuntimes: [],
  });

  it('同名插件：先来的（高优先级层）胜出，被遮蔽的那份留证 + warning', () => {
    const registry = buildRegistry([
      entryOf('/data/plugins/streamget', '/data/plugins'),
      entryOf('/app/plugins/streamget', '/app/plugins', { version: '0.1.0' }),
    ]);
    expect(registry.list()).toHaveLength(1);
    const winner = registry.get('streamget');
    expect(winner?.dir).toBe('/data/plugins/streamget');
    expect(winner?.shadowed).toEqual([
      { version: '0.1.0', dir: '/app/plugins/streamget', sourceDir: '/app/plugins' },
    ]);
    expect(registry.warnings().join(' ')).toContain('被');
  });

  it('URL 命中按 url_patterns 子串，且不区分大小写', () => {
    const registry = buildRegistry([entryOf('/p', '/p')]);
    expect(registry.matchUrl('https://LIVE.DOUYIN.COM/123')[0]?.[0].dir).toBe('/p');
    expect(registry.matchUrl('https://example.com/x')).toHaveLength(0);
  });

  it('已知平台优先于词法匹配（房间页 URL 里常常没有平台域名）', () => {
    const registry = buildRegistry([entryOf('/p', '/p')]);
    expect(registry.findFor('https://weird-cdn.example/x', 'bilibili')?.dir).toBe('/p');
    expect(registry.findFor('https://weird-cdn.example/x', 'nope')).toBeUndefined();
  });
});
