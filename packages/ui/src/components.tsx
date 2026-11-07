import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sky-500 text-white hover:bg-sky-400 disabled:bg-sky-500/40',
  ghost: 'border border-neutral-700 text-neutral-200 hover:bg-neutral-800/70',
  danger: 'border border-red-500/40 text-red-300 hover:bg-red-500/10',
  subtle: 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): ReactNode {
  return (
    <button
      // 默认 button：项目里没有 <form>，但按钮一旦落在表单里，默认 type=submit 会连带提交
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    >
      {/*
        纯文字按钮把文字包进 pointer-events:none 的 span：
        WebKit 里 mousedown 落在文字上、mouseup 落在按钮 padding 上时 click 不触发
        （bugs.webkit.org 99712 一系），表现为"点了没反应"。包一层后整块都是按钮自己。
        多子元素按钮不动，避免破坏 gap 布局。
      */}
      {typeof children === 'string' ? <span className="pointer-events-none">{children}</span> : children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium text-neutral-300">{title}</h2>
          <div className="flex min-w-0 items-center gap-2">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'error' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-neutral-800 text-neutral-300',
  ok: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
  info: 'bg-sky-500/15 text-sky-300',
};

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  /** 悬停说明：文案放得下就放正文，放不下（画质、码率）用 title 补一句 */
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** sm 用于任务卡这类高密度场景，省下 6px 高度和 8px 宽度 */
  size?: 'sm' | 'md';
}): ReactNode {
  const sm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 rounded-full transition disabled:opacity-50 ${sm ? 'h-5 w-9' : 'h-6 w-11'} ${checked ? 'bg-sky-500' : 'bg-neutral-700'}`}
    >
      <span
        className={`absolute rounded-full bg-white transition-all ${sm ? 'top-0.5 h-4 w-4' : 'top-0.5 h-5 w-5'} ${
          checked ? (sm ? 'left-[18px]' : 'left-[22px]') : 'left-0.5'
        }`}
      />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  as = 'label',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /**
   * 里面放**按钮**时传 `div`。
   *
   * `<label>` 的激活行为会把内部点击转发给它的第一个表单控件：Safari 里点 label 内的
   * 按钮常常"点了没反应"（点击被当成"聚焦时间输入框"），Chrome 容忍这种嵌套。
   * 监控时段那块每行都带删除按钮，所以不能包在 label 里。
   */
  as?: 'label' | 'div';
}): ReactNode {
  const body = (
    <>
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </>
  );
  return as === 'div' ? (
    <div className="block">{body}</div>
  ) : (
    <label className="block">{body}</label>
  );
}

const INPUT =
  'w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-sky-500';

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`${INPUT} ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  const { className = '', ...rest } = props;
  return <select {...rest} className={`${INPUT} ${className}`} />;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6">
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-t-2xl border border-neutral-800 bg-neutral-900 p-5 sm:rounded-2xl">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="py-6 text-center text-sm text-neutral-500">{children}</p>;
}

export function ErrorText({ children }: { children: ReactNode }): ReactNode {
  return <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{children}</p>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle !== undefined && <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>}
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>
    </header>
  );
}
