/**
 * 监控时段与轮询节奏的规则测试。
 *
 * 这些断言对应真机上踩过的事：
 * - 抖音 30s × 24h = 2880 次/天，2026-11-01 抓到过一次 `it triggered risk control`；
 * - 直播跨午夜是常态（老猫鱼 20:30 开播、凌晨收），`19:00-02:00` 必须被当成一段；
 * - 新加的任务不能因为"历史里这小时没开播"就被降频 —— 它本来就是空的。
 */
import { describe, expect, it } from 'vitest';
import {
  affinityLevel,
  describeWindows,
  fmtHm,
  hourAffinity,
  inWindows,
  nextOpenAt,
  parseHm,
  planPoll,
  sanitizeWindows,
  POLL_CAP_MS,
  POLL_COLD_MS,
  POLL_WARM_MIN_MS,
} from './schedule.ts';

const BASE = 30_000;
const at = (h: number, m = 0, dayOffset = 0): Date => {
  const d = new Date(2026, 10, 3, h, m, 0, 0); // 2026-11-03 是周二
  d.setDate(d.getDate() + dayOffset);
  return d;
};
const empty = new Array<number>(24).fill(0);

describe('时段解析', () => {
  it('HH:MM 解析与回写', () => {
    expect(parseHm('19:00')).toBe(1140);
    expect(parseHm('2:05')).toBe(125);
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('19:60')).toBeNull();
    expect(parseHm('abc')).toBeNull();
    expect(fmtHm(1140)).toBe('19:00');
    expect(fmtHm(125)).toBe('02:05');
  });

  it('脏数据被丢掉：时间非法、起止相同、非对象', () => {
    const got = sanitizeWindows([
      { start: '19:00', end: '02:00' },
      { start: '25:00', end: '26:00' },
      { start: '08:00', end: '08:00' },
      'nope',
      null,
    ]);
    expect(got).toEqual([{ start: '19:00', end: '02:00' }]);
  });

  it('最多保留 3 段，重复的星期去重', () => {
    const got = sanitizeWindows([
      { start: '01:00', end: '02:00', days: [1, 1, 2, 9] },
      { start: '03:00', end: '04:00' },
      { start: '05:00', end: '06:00' },
      { start: '07:00', end: '08:00' },
    ]);
    expect(got).toHaveLength(3);
    expect(got[0]?.days).toEqual([1, 2]);
  });

  it('完全相同的一段只留一份', () => {
    // 界面上两行一模一样时，用户会以为只有一行：改掉一行、删掉一行，剩下那条默认值，
    // 现象就是"删了以后变成 19:00→02:00，而且怎么删都还在"
    const got = sanitizeWindows([
      { start: '19:00', end: '02:00' },
      { start: '19:00', end: '02:00' },
    ]);
    expect(got).toEqual([{ start: '19:00', end: '02:00' }]);
  });

  it('重复段不占名额：前两条重复时，后面的独立段仍能进来', () => {
    const got = sanitizeWindows([
      { start: '19:00', end: '02:00' },
      { start: '19:00', end: '02:00' },
      { start: '04:00', end: '06:00' },
      { start: '07:00', end: '09:00' },
    ]);
    expect(got.map((w) => w.start)).toEqual(['19:00', '04:00', '07:00']);
  });

  it('起止相同但星期不同不算重复', () => {
    const got = sanitizeWindows([
      { start: '19:00', end: '23:00', days: [1] },
      { start: '19:00', end: '23:00', days: [5] },
    ]);
    expect(got).toHaveLength(2);
  });
});

describe('窗口判定', () => {
  it('空时段表 = 全天', () => {
    expect(inWindows([], at(3))).toBe(true);
  });

  it('普通窗口：含起点不含终点', () => {
    const w = [{ start: '19:00', end: '23:00' }];
    expect(inWindows(w, at(18, 59))).toBe(false);
    expect(inWindows(w, at(19, 0))).toBe(true);
    expect(inWindows(w, at(22, 59))).toBe(true);
    expect(inWindows(w, at(23, 0))).toBe(false);
  });

  it('跨午夜：19:00-02:00 从当晚延续到次日凌晨', () => {
    const w = [{ start: '19:00', end: '02:00' }];
    expect(inWindows(w, at(20, 0))).toBe(true);
    expect(inWindows(w, at(23, 59))).toBe(true);
    expect(inWindows(w, at(0, 30))).toBe(true);
    expect(inWindows(w, at(1, 59))).toBe(true);
    expect(inWindows(w, at(2, 0))).toBe(false);
    expect(inWindows(w, at(12, 0))).toBe(false);
  });

  it('多段可以并存', () => {
    const w = [
      { start: '12:00', end: '13:30' },
      { start: '19:00', end: '02:00' },
    ];
    expect(inWindows(w, at(12, 45))).toBe(true);
    expect(inWindows(w, at(15, 0))).toBe(false);
    expect(inWindows(w, at(23, 0))).toBe(true);
  });

  it('星期限定：跨午夜那半段算在"前一天"', () => {
    // 只在周一开 19:00-02:00 → 周二凌晨 1 点仍算在内
    const w = [{ start: '19:00', end: '02:00', days: [1] }];
    expect(inWindows(w, at(20, 0, 0))).toBe(false); // 周二晚 20 点
    const monday = at(20, 0, -1); // 周一晚
    expect(inWindows(w, monday)).toBe(true);
    expect(inWindows(w, at(1, 0, 0))).toBe(true); // 周二凌晨
    expect(inWindows(w, at(1, 0, 1))).toBe(false); // 周三凌晨
  });

  it('下一个开启时刻：当天还没到就今天，已过就明天', () => {
    const w = [{ start: '19:00', end: '23:00' }];
    expect(nextOpenAt(w, at(8, 0))?.getHours()).toBe(19);
    expect(nextOpenAt(w, at(8, 0))?.getDate()).toBe(3);
    const late = nextOpenAt(w, at(23, 30));
    expect(late?.getDate()).toBe(4);
    expect(late?.getHours()).toBe(19);
  });

  it('下一个开启时刻：跨午夜窗口在 02:30 指的"下一次"是当晚 19:00', () => {
    const w = [{ start: '19:00', end: '02:00' }];
    const next = nextOpenAt(w, at(2, 30));
    expect(next?.getDate()).toBe(3);
    expect(next?.getHours()).toBe(19);
  });
});

describe('历史开播热度', () => {
  it('按本地小时分桶，只数 60 天内的', () => {
    const starts = [
      at(20, 5, -1).toISOString(),
      at(20, 40, -2).toISOString(),
      at(21, 0, -3).toISOString(),
      // 超出 60 天：不该被算进去
      new Date(2026, 6, 1, 20, 0).toISOString(),
    ];
    const got = hourAffinity(starts, at(12));
    expect(got[20]).toBe(2);
    expect(got[21]).toBe(1);
    expect(got[19]).toBe(0);
  });

  it('样本不足时一律按"热"处理（新任务保持基准间隔）', () => {
    const few = [...empty];
    few[20] = 1;
    expect(affinityLevel(few, 3)).toBe('hot');

    const enough = [...empty];
    enough[20] = 1;
    enough[21] = 1;
    enough[22] = 1;
    expect(affinityLevel(enough, 20)).toBe('warm');
    expect(affinityLevel(enough, 3)).toBe('cold');
  });

  it('本小时开过 2 次 = 热', () => {
    const a = [...empty];
    a[20] = 2;
    a[21] = 1;
    expect(affinityLevel(a, 20)).toBe('hot');
  });
});

describe('轮询节奏', () => {
  it('窗外：完全不请求，等到下一个时段开启', () => {
    const plan = planPoll({
      now: at(8, 0),
      windows: [{ start: '19:00', end: '02:00' }],
      affinity: empty,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('window_closed');
    expect(plan.delayMs).toBe(11 * 3600 * 1000);
    // resumeAt 是 ISO（UTC），断言用本地小时换算回来，避免绑死机器时区
    expect(plan.resumeAt).not.toBeNull();
    expect(new Date(plan.resumeAt ?? '').getHours()).toBe(19);
  });

  it('窗外等待也不超过一天（防止窗口表异常导致睡死）', () => {
    const plan = planPoll({
      now: at(8, 0),
      windows: [{ start: '19:00', end: '02:00' }],
      affinity: empty,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.delayMs).toBeLessThanOrEqual(86_400_000);
  });

  it('热时段用基准间隔', () => {
    const a = [...empty];
    a[20] = 3;
    a[8] = 1;
    a[9] = 1;
    const plan = planPoll({
      now: at(20, 10),
      windows: [],
      affinity: a,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('hot');
    expect(plan.delayMs).toBe(BASE);
  });

  it('温时段至少 60 秒', () => {
    const a = [...empty];
    a[20] = 1;
    a[8] = 1;
    a[9] = 1;
    const plan = planPoll({
      now: at(20, 10),
      windows: [],
      affinity: a,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('warm');
    expect(plan.delayMs).toBe(POLL_WARM_MIN_MS);
  });

  it('冷时段 180 秒（不播的时间不该按 30 秒问）', () => {
    const a = [...empty];
    a[20] = 1;
    a[21] = 1;
    a[22] = 1;
    const plan = planPoll({
      now: at(3, 0),
      windows: [],
      affinity: a,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('cold');
    expect(plan.delayMs).toBe(POLL_COLD_MS);
  });

  it('连续未开播每 10 轮翻倍，封顶 10 分钟', () => {
    const a = [...empty];
    a[20] = 1;
    a[21] = 1;
    a[22] = 1;
    const coldBase = planPoll({
      now: at(3, 0),
      windows: [],
      affinity: a,
      idleRounds: 9,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(coldBase.reason).toBe('cold');

    const stretched = planPoll({
      now: at(3, 0),
      windows: [],
      affinity: a,
      idleRounds: 10,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(stretched.reason).toBe('idle_stretch');
    expect(stretched.delayMs).toBe(POLL_COLD_MS * 2);

    const capped = planPoll({
      now: at(3, 0),
      windows: [],
      affinity: a,
      idleRounds: 100,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(capped.delayMs).toBe(POLL_CAP_MS);
  });

  it('热时段也会被"久未开播"拉长（主播今天没播的情况）', () => {
    const a = [...empty];
    a[20] = 5;
    a[21] = 1;
    a[22] = 1;
    const plan = planPoll({
      now: at(20, 0),
      windows: [],
      affinity: a,
      idleRounds: 20,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('idle_stretch');
    expect(plan.delayMs).toBe(BASE * 4);
  });

  it('连续失败指数退避，封顶 10 分钟', () => {
    const one = planPoll({
      now: at(20, 0),
      windows: [],
      affinity: empty,
      idleRounds: 0,
      errorStreak: 1,
      baseMs: BASE,
    });
    expect(one.reason).toBe('hot'); // 只失败一次仍按正常节奏

    const three = planPoll({
      now: at(20, 0),
      windows: [],
      affinity: empty,
      idleRounds: 0,
      errorStreak: 3,
      baseMs: BASE,
    });
    expect(three.reason).toBe('error_backoff');
    expect(three.delayMs).toBe(BASE * 4);

    const many = planPoll({
      now: at(20, 0),
      windows: [],
      affinity: empty,
      idleRounds: 0,
      errorStreak: 20,
      baseMs: BASE,
    });
    expect(many.delayMs).toBe(POLL_CAP_MS);
  });

  it('窗内的优先级高于冷热：窗口外即使热也不请求', () => {
    const a = [...empty];
    a[8] = 5;
    a[20] = 1;
    a[21] = 1;
    const plan = planPoll({
      now: at(8, 0),
      windows: [{ start: '19:00', end: '02:00' }],
      affinity: a,
      idleRounds: 0,
      errorStreak: 0,
      baseMs: BASE,
    });
    expect(plan.reason).toBe('window_closed');
  });
});

describe('文案', () => {
  it('时段描述', () => {
    expect(describeWindows([])).toBe('不限（全天）');
    expect(describeWindows([{ start: '19:00', end: '02:00' }, { start: '12:00', end: '13:30' }])).toBe(
      '19:00–02:00 · 12:00–13:30',
    );
  });
});
