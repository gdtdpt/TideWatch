/**
 * 通知文案的纯函数回归。
 *
 * 这两条专门钉"画质"相关的措辞：用户看到的只有这一句话，
 * 说清楚"请求什么、实际给了什么"才算有用。
 */
import { describe, expect, it } from 'vitest';
import { describeLayout, layoutChanged, qualityDegraded } from './copy.ts';

describe('copy：画质与流参数', () => {
  it('describeLayout 把 layoutHash 压成"分辨率 + 编码"，认不出的原样返回', () => {
    expect(describeLayout('avc-1920x1080-yuv420p+aac-48000-2')).toBe('1920×1080 AVC');
    expect(describeLayout('hevc-1280x720-yuv420p+aac-44100-2')).toBe('1280×720 HEVC');
    // 缺字段 / 形状不同：不要抛，也不要编一个值出来
    expect(describeLayout(null)).toBeNull();
    expect(describeLayout('')).toBeNull();
    expect(describeLayout('weird')).toBe('WEIRD');
  });

  it('降级通知同时给出请求值、实际值与编码，并指明去哪看', () => {
    const d = qualityDegraded({ streamer: '测试主播', requested: '原画', label: '高清', codec: 'hevc' });
    expect(d.kind).toBe('quality_degraded');
    expect(d.level).toBe('warn');
    expect(d.body).toContain('请求 原画');
    expect(d.body).toContain('高清（HEVC）');
    // 缺字段时用兜底措辞，不能出现 "null"
    const bare = qualityDegraded({ streamer: null, requested: null, label: null, codec: null });
    expect(bare.body).not.toContain('null');
    expect(bare.body).toContain('默认档位');
  });

  it('流参数变化通知里是两段人话，不是两个 hash', () => {
    const d = layoutChanged({
      streamer: '测试主播',
      part: 2,
      from: 'avc-1920x1080-yuv420p+aac-48000-2',
      to: 'avc-1280x720-yuv420p+aac-48000-2',
    });
    expect(d.kind).toBe('layout_changed');
    expect(d.body).toContain('第 2 段');
    expect(d.body).toContain('1920×1080 AVC');
    expect(d.body).toContain('1280×720 AVC');
    expect(d.body).not.toContain('yuv420p');
  });
});
