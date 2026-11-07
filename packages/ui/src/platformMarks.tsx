/**
 * 平台标识：品牌色块 + 字形，16px 方块。
 *
 * 只覆盖插件 `platform` 字段的三个取值（bilibili / douyin / direct）。
 * 未知值给灰底问号，不猜 —— 猜错的 logo 比没有更误导。
 *
 * 不用位图：字形是内联 SVG，跟文字同色同缩放，不必为深浅色各准备一套资源。
 */
import type { ReactNode } from 'react';

export const PLATFORM_LABEL: Record<string, string> = {
  bilibili: 'B站',
  douyin: '抖音',
  direct: '直链',
};

interface MarkStyle {
  bg: string;
  fg: string;
  /** 抖音块本身是黑的，在深色卡片里需要一圈细边才看得出边界 */
  ring?: string;
}

const STYLES: Record<string, MarkStyle> = {
  bilibili: { bg: '#FB7299', fg: '#ffffff' },
  // 抖音的方块本身是黑的，在深色卡片上只剩一条边可见 —— 边必须够亮
  douyin: { bg: '#161823', fg: '#25F4EE', ring: 'rgba(255,255,255,0.45)' },
  direct: { bg: '#4b5563', fg: '#ffffff' },
};

const UNKNOWN: MarkStyle = { bg: '#3f3f46', fg: '#d4d4d8' };

const GLYPHS: Record<string, ReactNode> = {
  // 小电视
  bilibili: (
    <>
      <path d="M4 2.5 6 5M12 2.5 10 5" />
      <rect x="1.6" y="5" width="12.8" height="9.4" rx="2.2" />
      <path d="M5.6 8.4v2.4M10.4 8.4v2.4" />
    </>
  ),
  // 音符
  douyin: (
    <>
      <path d="M9.6 2v8.2a2.6 2.6 0 1 1-2.6-2.6" />
      <path d="M9.6 4.2c.7 1.2 1.9 1.9 3.2 2" />
    </>
  ),
  // 链接
  direct: (
    <>
      <path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1" />
      <path d="M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
    </>
  ),
};

const UNKNOWN_GLYPH = (
  <>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M6.5 6.3a1.6 1.6 0 0 1 3.1.5c0 1-1.6 1.2-1.6 2.2" />
    <path d="M8 11.4v.1" />
  </>
);

export function PlatformMark({
  platform,
  size = 16,
  className = '',
}: {
  platform: string | null | undefined;
  size?: number;
  className?: string;
}): ReactNode {
  const key = (platform ?? '').toLowerCase();
  const label = PLATFORM_LABEL[key] ?? '未知平台';
  const style = STYLES[key] ?? UNKNOWN;
  const glyph = GLYPHS[key] ?? UNKNOWN_GLYPH;
  const inner = Math.round(size * 0.62);

  return (
    <span
      role="img"
      aria-label={`平台：${label}`}
      title={`平台：${label}`}
      className={`inline-flex shrink-0 items-center justify-center rounded-[4px] ${className}`}
      style={{
        width: size,
        height: size,
        background: style.bg,
        color: style.fg,
        border: `1px solid ${style.ring ?? 'transparent'}`,
      }}
    >
      <svg
        width={inner}
        height={inner}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {glyph}
      </svg>
    </span>
  );
}
