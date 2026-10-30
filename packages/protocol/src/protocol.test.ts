import { describe, expect, it } from 'vitest';
import { decodeResponse, LineSplitter } from './index.ts';

describe('LineSplitter', () => {
  it('一行被劈成两个 chunk 也能拼回', () => {
    const s = new LineSplitter();
    expect(s.push('{"id":"a"')).toEqual([]);
    expect(s.push(',"ok":true,"data":{}}\n')).toEqual(['{"id":"a","ok":true,"data":{}}']);
  });

  it('一次多个 chunk 连续切行', () => {
    const s = new LineSplitter();
    expect(s.push('1\n2\n3')).toEqual(['1', '2']);
    expect(s.flush()).toEqual(['3']);
  });

  it('CRLF 与非空判定', () => {
    const s = new LineSplitter();
    expect(s.push('\n\r\n{"a":1}\r\n')).toEqual(['{"a":1}']);
  });
});

describe('decodeResponse', () => {
  it('成功响应', () => {
    expect(decodeResponse('{"id":"x","ok":true,"data":{"title":"t"}}')).toEqual({
      id: 'x',
      ok: true,
      data: { title: 't' },
    });
  });

  it('错误响应保留错误码', () => {
    const r = decodeResponse('{"id":"x","ok":false,"error":{"code":"AUTH_REQUIRED","message":"login","retryable":false}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AUTH_REQUIRED');
  });

  it('形状非法直接抛', () => {
    expect(() => decodeResponse('{"ok":true}')).toThrow(/id/);
    expect(() => decodeResponse('[1,2]')).toThrow();
  });
});
