import { describe, expect, it } from 'vitest';
import { localStamp, sanitizeDirName } from './index.ts';

describe('sanitizeDirName', () => {
  it('替换文件系统非法字符但保留可读性', () => {
    expect(sanitizeDirName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
  });

  it('去掉结尾的点与空格（Windows 会静默吞掉）', () => {
    expect(sanitizeDirName('主播名... ')).toBe('主播名');
  });

  it('空名兜底', () => {
    expect(sanitizeDirName('   ')).toBe('unnamed');
  });

  it('保留名加前缀', () => {
    expect(sanitizeDirName('CON')).toBe('_CON');
  });

  it('按 UTF-8 字节截断，不切坏多字节字符', () => {
    const out = sanitizeDirName('潮'.repeat(100), 30);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(30);
    expect(out).not.toContain('\ufffd');
  });
});

describe('localStamp', () => {
  it('形如 20261025-104804，字典序即时间序', () => {
    expect(localStamp(new Date(2026, 9, 25, 10, 48, 4))).toBe('20261025-104804');
  });
});
