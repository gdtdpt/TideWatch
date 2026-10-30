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
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): ReactNode {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    />
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
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-300">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
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

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? 'bg-sky-500' : 'bg-neutral-700'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </label>
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
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle !== undefined && <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
