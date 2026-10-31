import { useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { Button, ErrorText, Field, Input } from './components.tsx';

export function Login({ onDone }: { onDone: () => void }): ReactNode {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { token: token.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">TideWatch</h1>
        <p className="mt-1 text-sm text-neutral-400">潮录 · 多平台直播自动录制</p>
      </header>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <h2 className="text-sm font-medium text-neutral-300">粘贴访问 token</h2>
        <p className="mt-1 text-xs text-neutral-500">
          首次启动时终端会打印；也可在服务器上执行 <code className="text-neutral-300">tidewatch token</code>，
          或读取数据根下的 <code className="text-neutral-300">auth-token.txt</code>。
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Token">
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="32 字节 hex"
              autoFocus
              autoComplete="off"
            />
          </Field>
          {error !== null && <ErrorText>{error}</ErrorText>}
          <Button type="submit" disabled={busy || token.trim().length === 0} className="w-full">
            {busy ? '登录中…' : '登录'}
          </Button>
        </form>
      </section>

      <p className="text-center text-[11px] text-neutral-600">
        这是你自己的服务：局域网内能打开它的人都能看到你的录制，请勿当成团队平台。
      </p>
    </main>
  );
}
