import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  fmtBytes,
  type BinaryStatus,
  type CookieInfo,
  type Health,
  type PluginInfo,
  type Settings as SettingsShape,
} from '../api.ts';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, PageHeader, Select, Toggle } from '../components.tsx';
import { useAsync } from '../hooks.ts';

type Dict = Record<string, unknown>;

interface SettingsResponse {
  settings: SettingsShape;
  paths: { dataRoot: string; outputRoot: string; resourceRoot: string };
  runtime: {
    ffmpeg: { command: string; source: string };
    ffprobe: { command: string; source: string };
    python: string;
    cookieBackend: string;
    leaseAcquired: boolean;
    leaseNote: string | null;
  };
}

const channel = (notify: Dict, name: string): Dict => {
  const v = notify[name];
  return typeof v === 'object' && v !== null ? (v as Dict) : {};
};

const sval = (d: Dict, key: string, fallback = ''): string => (typeof d[key] === 'string' ? (d[key] as string) : fallback);
const nval = (d: Dict, key: string, fallback = 0): number => (typeof d[key] === 'number' ? (d[key] as number) : fallback);
const bval = (d: Dict, key: string): boolean => d[key] === true;

export function Settings({ tick }: { tick: number }): ReactNode {
  const loaded = useAsync<SettingsResponse>(() => api.get('/api/settings'), [tick]);
  const plugins = useAsync<{ plugins: PluginInfo[]; warnings: string[] }>(() => api.get('/api/plugins'), [tick]);
  const cookies = useAsync<{ backend: string; cookies: CookieInfo[] }>(() => api.get('/api/cookies'), [tick]);
  const health = useAsync<Health>(() => api.get('/api/health'), [tick]);

  const [form, setForm] = useState<SettingsShape | null>(null);
  const [notify, setNotify] = useState<Dict>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  useEffect(() => {
    if (loaded.data === null) return;
    setForm(loaded.data.settings);
    setNotify(loaded.data.settings.notify);
  }, [loaded.data]);

  const save = async (): Promise<void> => {
    if (form === null) return;
    setError(null);
    setMessage(null);
    try {
      const res = await api.put<{ settings: SettingsShape; note: string }>('/api/settings', {
        pollIntervalS: form.pollIntervalS,
        segmentTimeS: form.segmentTimeS,
        defaultPostprocess: form.defaultPostprocess,
        faststart: form.faststart,
        faststartThresholdMb: form.faststartThresholdMb,
        cleanupIntermediate: form.cleanupIntermediate,
        notify,
      });
      setForm(res.settings);
      setMessage(res.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const test = async (id: string): Promise<void> => {
    setTested(`正在测试 ${id}…`);
    try {
      const res = await api.post<{ results: { id: string; ok: boolean; reason?: string }[] }>(
        '/api/settings/notify/test',
        { channel: id },
      );
      const r = res.results[0];
      setTested(r === undefined ? '没有启用的渠道' : r.ok ? `${id} 发送成功` : `${id} 失败：${r.reason ?? ''}`);
    } catch (err) {
      setTested(err instanceof Error ? err.message : String(err));
    }
  };

  const setChannel = (name: string, patch: Dict): void => {
    setNotify((prev) => ({ ...prev, [name]: { ...channel(prev, name), ...patch } }));
  };

  const genVapid = async (): Promise<void> => {
    try {
      const res = await api.post<{ publicKey: string; settings: SettingsShape }>('/api/settings/webpush/vapid');
      setNotify(res.settings.notify);
      setMessage('已生成 VAPID 密钥；Web Push 只在 HTTPS/反代下可用');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (form === null) return <Empty>{loaded.error ?? '加载设置…'}</Empty>;

  const ntfy = channel(notify, 'ntfy');
  const bark = channel(notify, 'bark');
  const telegram = channel(notify, 'telegram');
  const smtp = channel(notify, 'smtp');
  const webpush = channel(notify, 'webpush');

  return (
    <div className="space-y-4">
      <PageHeader
        title="设置"
        subtitle="改完点保存；轮询间隔与录制目录重启后生效"
        actions={<Button onClick={() => void save()}>保存</Button>}
      />

      {message !== null && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</p>}
      {error !== null && <ErrorText>{error}</ErrorText>}

      <Card title="录制默认值">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="轮询间隔（秒）" hint="5..3600，重启生效">
            <Input
              type="number"
              value={form.pollIntervalS}
              onChange={(e) => setForm({ ...form, pollIntervalS: Number(e.target.value) })}
            />
          </Field>
          <Field label="分段时长（秒）" hint="30..43200，防止断电全损">
            <Input
              type="number"
              value={form.segmentTimeS}
              onChange={(e) => setForm({ ...form, segmentTimeS: Number(e.target.value) })}
            />
          </Field>
          <Field label="默认后处理">
            <Select
              value={form.defaultPostprocess}
              onChange={(e) => setForm({ ...form, defaultPostprocess: e.target.value as SettingsShape['defaultPostprocess'] })}
            >
              <option value="merge">合并为 MP4</option>
              <option value="per_segment">每段独立 MP4</option>
              <option value="manual">手动</option>
            </Select>
          </Field>
          <Field label="faststart">
            <Select
              value={form.faststart}
              onChange={(e) => setForm({ ...form, faststart: e.target.value as SettingsShape['faststart'] })}
            >
              <option value="auto">auto（小于阈值才开）</option>
              <option value="on">总是开启</option>
              <option value="off">关闭</option>
            </Select>
          </Field>
          <Field label="faststart 阈值（MB）" hint="auto 模式下源总量小于它才重写 moov">
            <Input
              type="number"
              value={form.faststartThresholdMb}
              onChange={(e) => setForm({ ...form, faststartThresholdMb: Number(e.target.value) })}
            />
          </Field>
          <Field label="合并后清理中间文件" hint="只删 .fixed.ts / concat 清单；源 TS 永不自动删除">
            <div className="flex h-9 items-center">
              <Toggle
                label="清理中间文件"
                checked={form.cleanupIntermediate}
                onChange={(v) => setForm({ ...form, cleanupIntermediate: v })}
              />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="通知渠道" actions={<span className="text-[11px] text-neutral-500">只有警告/错误会外发</span>}>
        <div className="space-y-4">
          <Channel
            title="ntfy"
            enabled={bval(ntfy, 'enabled')}
            onToggle={(v) => setChannel('ntfy', { enabled: v })}
            onTest={() => void test('ntfy')}
          >
            <Field label="服务器">
              <Input value={sval(ntfy, 'server', 'https://ntfy.sh')} onChange={(e) => setChannel('ntfy', { server: e.target.value })} />
            </Field>
            <Field label="Topic">
              <Input value={sval(ntfy, 'topic')} onChange={(e) => setChannel('ntfy', { topic: e.target.value })} />
            </Field>
            <Field label="Token（可选）">
              <Input value={sval(ntfy, 'token')} onChange={(e) => setChannel('ntfy', { token: e.target.value })} />
            </Field>
          </Channel>

          <Channel
            title="Bark"
            enabled={bval(bark, 'enabled')}
            onToggle={(v) => setChannel('bark', { enabled: v })}
            onTest={() => void test('bark')}
          >
            <Field label="服务器">
              <Input value={sval(bark, 'server', 'https://api.day.app')} onChange={(e) => setChannel('bark', { server: e.target.value })} />
            </Field>
            <Field label="Device Key">
              <Input value={sval(bark, 'key')} onChange={(e) => setChannel('bark', { key: e.target.value })} />
            </Field>
          </Channel>

          <Channel
            title="Telegram"
            enabled={bval(telegram, 'enabled')}
            onToggle={(v) => setChannel('telegram', { enabled: v })}
            onTest={() => void test('telegram')}
          >
            <Field label="Bot Token">
              <Input value={sval(telegram, 'botToken')} onChange={(e) => setChannel('telegram', { botToken: e.target.value })} />
            </Field>
            <Field label="Chat ID">
              <Input value={sval(telegram, 'chatId')} onChange={(e) => setChannel('telegram', { chatId: e.target.value })} />
            </Field>
          </Channel>

          <Channel
            title="邮件（SMTP）"
            enabled={bval(smtp, 'enabled')}
            onToggle={(v) => setChannel('smtp', { enabled: v })}
            onTest={() => void test('smtp')}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host">
                <Input value={sval(smtp, 'host')} onChange={(e) => setChannel('smtp', { host: e.target.value })} />
              </Field>
              <Field label="端口">
                <Input type="number" value={nval(smtp, 'port', 587)} onChange={(e) => setChannel('smtp', { port: Number(e.target.value) })} />
              </Field>
              <Field label="用户名">
                <Input value={sval(smtp, 'user')} onChange={(e) => setChannel('smtp', { user: e.target.value })} />
              </Field>
              <Field label="密码">
                <Input type="password" value={sval(smtp, 'pass')} onChange={(e) => setChannel('smtp', { pass: e.target.value })} />
              </Field>
              <Field label="发件人">
                <Input value={sval(smtp, 'from')} onChange={(e) => setChannel('smtp', { from: e.target.value })} />
              </Field>
              <Field label="收件人">
                <Input value={sval(smtp, 'to')} onChange={(e) => setChannel('smtp', { to: e.target.value })} />
              </Field>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
              <Toggle label="SSL 直连" checked={bval(smtp, 'secure')} onChange={(v) => setChannel('smtp', { secure: v })} />
              465 端口用 SSL 直连；587 用 STARTTLS
            </div>
          </Channel>

          <Channel
            title="Web Push"
            enabled={bval(webpush, 'enabled')}
            onToggle={(v) => setChannel('webpush', { enabled: v })}
            onTest={() => void test('webpush')}
          >
            <p className="text-xs text-neutral-500">
              需要 HTTPS 或 Tailscale Serve。先在浏览器端订阅，再把订阅写进配置；当前已配置{' '}
              {Array.isArray(webpush['subscriptions']) ? (webpush['subscriptions'] as unknown[]).length : 0} 个订阅。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => void genVapid()}>
                生成 VAPID 密钥
              </Button>
              {sval(webpush, 'publicKey').length > 0 && (
                <Badge tone="ok">公钥 {sval(webpush, 'publicKey').slice(0, 12)}…</Badge>
              )}
            </div>
          </Channel>
        </div>
        {tested !== null && <p className="mt-3 text-xs text-sky-300">{tested}</p>}
      </Card>

      <Card
        title="插件"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              void api.post('/api/plugins/refresh').then(() => plugins.reload());
            }}
          >
            重新扫描
          </Button>
        }
      >
        {plugins.data === null && <Empty>加载中…</Empty>}
        {plugins.data !== null && plugins.data.plugins.length === 0 && <Empty>没有插件。把插件目录放进数据根 plugins/ 后重新扫描。</Empty>}
        {plugins.data !== null && plugins.data.plugins.length > 0 && (
          <ul className="space-y-2 text-sm">
            {plugins.data.plugins.map((p) => (
              <li key={p.dir} className="rounded-lg border border-neutral-800 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Badge>v{p.version}</Badge>
                  <Badge tone="info">协议 {p.protocol}</Badge>
                  {p.platforms.map((x) => (
                    <Badge key={x}>{x}</Badge>
                  ))}
                  {p.error !== null && <Badge tone="error">不可启动</Badge>}
                </div>
                <p className="mt-1 truncate text-[11px] text-neutral-500">{p.dir}</p>
                {p.error !== null && <p className="mt-1 text-[11px] text-red-300">{p.error}</p>}
                {p.shadowed.length > 0 && (
                  <p className="mt-1 text-[11px] text-amber-300">被遮蔽：{p.shadowed.map((s) => s.dir).join('、')}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {plugins.data !== null && plugins.data.warnings.length > 0 && (
          <ul className="mt-2 space-y-1 text-[11px] text-amber-300">
            {plugins.data.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        )}
      </Card>

      <CookieCard
        backend={cookies.data?.backend ?? ''}
        cookies={cookies.data?.cookies ?? []}
        onChanged={() => cookies.reload()}
      />

      <Card title="运行环境">
        {/* 必须显式 grid-cols-1：不写列模板时单列是 auto 轨道，宽度取内容的
            max-content，长路径会把整页撑出横向滚动条；grid-cols-1 是 minmax(0,1fr) */}
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <Row k="数据根" v={loaded.data?.paths.dataRoot ?? '—'} />
          <Row k="录制目录" v={loaded.data?.paths.outputRoot ?? '—'} />
          <BinaryRow name="ffmpeg" bin={health.data?.binaries.ffmpeg} />
          <BinaryRow name="ffprobe" bin={health.data?.binaries.ffprobe} />
          <Row k="python" v={loaded.data?.runtime.python ?? '—'} />
          <Row k="Cookie 存储" v={loaded.data?.runtime.cookieBackend ?? '—'} />
          <Row k="磁盘可用" v={fmtBytes(health.data?.freeBytes ?? null)} />
          <Row k="引擎租约" v={loaded.data?.runtime.leaseAcquired === true ? '持有' : '未持有'} />
        </dl>
        {health.data?.binaries.ffprobe.ok === false && (
          <p className="mt-2 text-xs text-amber-300">
            缺 ffprobe 不影响录制，但分段指纹取不到 —— 收尾分组会退化成 unknown。
          </p>
        )}
        {loaded.data?.runtime.leaseNote !== null && loaded.data?.runtime.leaseNote !== undefined && (
          <p className="mt-2 text-xs text-amber-300">{loaded.data.runtime.leaseNote}</p>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              void api.post('/api/diagnostics/export').then((r) => setMessage(`诊断包已写入 ${JSON.stringify(r)}`));
            }}
          >
            导出诊断包
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): ReactNode {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-24 shrink-0 text-neutral-500">{k}</dt>
      <dd className="min-w-0 flex-1 truncate text-neutral-300" title={v}>
        {v}
      </dd>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  env: '环境变量',
  vendor: '随包 vendor',
  path: '系统 PATH',
};

/**
 * ffmpeg/ffprobe 一行：版本 + 来源 + 路径。
 * 来源必须显示 —— 走系统 PATH 意味着版本不受控，而版本会改变 stderr 措辞，
 * 错误分类靠关键词表，同一份流可能因此归到不同错误码。
 */
function BinaryRow({ name, bin }: { name: string; bin: BinaryStatus | undefined }): ReactNode {
  return (
    <div className="flex min-w-0 gap-2 sm:col-span-2">
      <dt className="w-24 shrink-0 text-neutral-500">{name}</dt>
      <dd className="min-w-0 flex-1">
        {bin === undefined ? (
          <span className="text-neutral-500">探测中…</span>
        ) : !bin.ok ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="error">缺失</Badge>
            <span className="text-[11px] text-amber-300">
              跑 tools/fetch-ffmpeg.sh 装到 vendor/，或用 TIDEWATCH_FFMPEG 指定绝对路径
            </span>
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-neutral-300">{bin.version ?? '版本未知'}</span>
            <Badge tone={bin.source === 'vendor' ? 'ok' : 'warn'}>
              {SOURCE_LABEL[bin.source] ?? bin.source}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500" title={bin.command}>
              {bin.command}
            </span>
          </span>
        )}
      </dd>
    </div>
  );
}

function Channel({
  title,
  enabled,
  onToggle,
  onTest,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onTest: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-xl border border-neutral-800 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {enabled && <Badge tone="ok">启用</Badge>}
        </span>
        <span className="flex items-center gap-2">
          <Button variant="ghost" onClick={onTest}>
            发送测试
          </Button>
          <Toggle label={`${title} 开关`} checked={enabled} onChange={onToggle} />
        </span>
      </div>
      {enabled && <div className="mt-3 grid gap-3">{children}</div>}
    </div>
  );
}

function CookieCard({
  backend,
  cookies,
  onChanged,
}: {
  backend: string;
  cookies: CookieInfo[];
  onChanged: () => void;
}): ReactNode {
  const [platform, setPlatform] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.put(`/api/cookies/${platform.trim().toLowerCase()}`, { value: value.trim() });
      setValue('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card title="平台 Cookie" actions={<span className="text-[11px] text-neutral-500">{backend}</span>}>
      <p className="text-xs text-neutral-500">
        Cookie 只出服务端、不回显明文；接口只返回掩码。若存储后端降级为明文文件，会如实标出。
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {cookies.length === 0 && <li className="text-neutral-500">还没有配置</li>}
        {cookies.map((c) => (
          <li key={c.platform} className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="font-medium">{c.platform}</span>
              <span className="ml-2 text-xs text-neutral-500">{c.hint}</span>
              {!c.encrypted && <Badge tone="warn">未加密</Badge>}
            </span>
            <Button
              variant="danger"
              onClick={() => {
                void api.del(`/api/cookies/${c.platform}`).then(onChanged);
              }}
            >
              删除
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          placeholder="平台 key（如 douyin）"
          className="sm:w-40 sm:shrink-0"
        />
        {/* 输入框 w-full 会把同行按钮挤到只剩一个字宽（"保/存"竖排），
            这里给输入框 min-w-0 占地、给按钮 shrink-0 钉住 */}
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="粘贴 Cookie 字符串" className="sm:min-w-0 sm:flex-1" />
        <Button
          className="shrink-0"
          onClick={() => void save()}
          disabled={platform.trim().length === 0 || value.trim().length === 0}
        >
          保存
        </Button>
      </div>
      {error !== null && <div className="mt-2"><ErrorText>{error}</ErrorText></div>}
    </Card>
  );
}
