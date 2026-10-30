/**
 * 目录名净化：录制目录形如 `<主播>/20261025-104804_cap_sb767463/`。
 * 纯函数，无 IO、无平台 API —— core 的每个函数都必须是这个性质。
 */
// 控制字符正是要替换的目标，这不是误用
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'LPT1', 'LPT2', 'LPT3']);

/** 保留可读性，只替换真正会炸文件系统的字符；长度按字节上限截断 */
export function sanitizeDirName(raw: string, maxBytes = 120): string {
  let name = raw.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  // 结尾的点与空格在 Windows 上会被静默吞掉，直接去掉
  name = name.replace(/[. ]+$/g, '');
  if (name.length === 0) name = 'unnamed';
  if (RESERVED.has(name.toUpperCase())) name = `_${name}`;

  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= maxBytes) return name;

  let out = '';
  for (const ch of name) {
    if (encoder.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out.replace(/[. ]+$/g, '') || 'unnamed';
}

/** 本地时间戳：字典序即时间序（旧版踩过 UTC 坑，这里显式取本地时区） */
export function localStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
