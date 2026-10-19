import { describe, expect, test } from 'bun:test';
import { findTimeMentions } from '../src/core/temporal-grammar.ts';
import { parseQueryTimeRange } from '../src/core/search/time-range.ts';

// Reference: Saturday 2026-10-17. Week of 2026-10-12 (Mon) .. 2026-10-18 (Sun).
const REF = '2026-10-17';

function one(text: string): [string, string] {
  const ms = findTimeMentions(text, REF);
  expect(ms.length, `expected exactly one mention for ${text}, got ${ms.length}: ${JSON.stringify(ms)}`).toBe(1);
  return [ms[0].start, ms[0].end];
}
function range(text: string): string {
  const [s, e] = one(text);
  return s === e ? s : `${s}..${e}`;
}

describe('CJK day words', () => {
  test('今天/今日/今晚/刚刚 → ref day', () => {
    for (const q of ['今天的方案', '今日安排', '今晚跑基线', '刚刚完成的事', '今天早上吃了什么']) expect(range(q)).toBe('2026-10-17');
  });
  test('昨天/昨日/昨晚/昨天晚上 → -1', () => {
    for (const q of ['昨天的日志', '昨日会议', '昨晚的部署', '昨天晚上聊的']) expect(range(q)).toBe('2026-10-16');
  });
  test('前天 → -2, 明天 → +1, 后天 → +2', () => {
    expect(range('前天 daed 节点')).toBe('2026-10-15');
    expect(range('明天的安排')).toBe('2026-10-18');
    expect(range('后天考试')).toBe('2026-10-19');
  });
});

describe('CJK weeks', () => {
  test('上周/这周/下周/上上周 → whole Mon-Sun weeks', () => {
    expect(range('上周的升级')).toBe('2026-10-05..2026-10-11');
    expect(range('这周的任务')).toBe('2026-10-12..2026-10-18');
    expect(range('下周发布')).toBe('2026-10-19..2026-10-25');
    expect(range('上上周的事')).toBe('2026-09-28..2026-10-04');
  });
  test('上周五/这周三/下周一 → specific days', () => {
    expect(range('上周五的验收')).toBe('2026-10-09');
    expect(range('这周三开会')).toBe('2026-10-14');
    expect(range('下周一发布')).toBe('2026-10-19');
    expect(range('上上个星期五')).toBe('2026-10-02');
    expect(range('上个星期三')).toBe('2026-10-07');
  });
  test('裸 周五/星期五/礼拜天 → most recent past occurrence', () => {
    expect(range('周五的评审')).toBe('2026-10-16');
    expect(range('星期六做了什么')).toBe('2026-10-17');
    expect(range('星期天休息')).toBe('2026-10-11');
    expect(range('礼拜五下班前')).toBe('2026-10-16');
  });
  test('上周五 wins over 周五 (longest match)', () => {
    const ms = findTimeMentions('上周五的验收', REF);
    expect(ms.length).toBe(1);
    expect(ms[0].cue).toBe('上周五');
  });
  test('上周末/这周末/周末', () => {
    expect(range('上周末的游戏')).toBe('2026-10-10..2026-10-11');
    expect(range('这周末休')).toBe('2026-10-17..2026-10-18');
    expect(range('下周末出游')).toBe('2026-10-24..2026-10-25');
    expect(range('周末计划')).toBe('2026-10-17..2026-10-18');
  });
});

describe('CJK months and years', () => {
  test('上个月/本月/下个月/上上个月', () => {
    expect(range('上个月总结')).toBe('2026-09-01..2026-09-30');
    expect(range('这个月目标')).toBe('2026-10-01..2026-10-31');
    expect(range('本月总结')).toBe('2026-10-01..2026-10-31');
    expect(range('下个月计划')).toBe('2026-11-01..2026-11-30');
    expect(range('上上个月的账')).toBe('2026-08-01..2026-08-31');
  });
  test('前年/去年/今年/明年', () => {
    expect(range('前年的事')).toBe('2024-01-01..2024-12-31');
    expect(range('去年的总结')).toBe('2025-01-01..2025-12-31');
    expect(range('今年的目标')).toBe('2026-01-01..2026-12-31');
    expect(range('明年的规划')).toBe('2027-01-01..2027-12-31');
  });
});

describe('CJK rolling windows and ago', () => {
  test('最近N天/近30天/过去一周/这三个月', () => {
    expect(range('最近7天的日志')).toBe('2026-10-10..2026-10-17');
    expect(range('近30天的提交')).toBe('2026-09-17..2026-10-17');
    expect(range('过去一周的变更')).toBe('2026-10-10..2026-10-17');
    expect(range('这三个月的复盘')).toBe('2026-07-19..2026-10-17');
    expect(range('最近三天的报错')).toBe('2026-10-14..2026-10-17');
  });
  test('裸最近 abstains', () => {
    expect(findTimeMentions('最近的投资', REF).length).toBe(0);
  });
  test('3天前/两周前/五天前/两年前', () => {
    expect(range('3天前的问题')).toBe('2026-10-13..2026-10-15');
    expect(range('两周前的部署')).toBe('2026-09-30..2026-10-06');
    expect(range('五天前说的')).toBe('2026-10-11..2026-10-13');
    expect(range('两年前的记录')).toBe('2024-01-01..2024-12-31');
  });
  test('前天 is not N天前 (no digit)', () => {
    expect(range('前天的事')).toBe('2026-10-15');
  });
});

describe('CJK absolute dates', () => {
  test('2026年10月17日 / 10月17号 / 十月十七日', () => {
    expect(range('2026年10月17日的事')).toBe('2026-10-17');
    expect(range('10月17号的评审')).toBe('2026-10-17');
    expect(range('十月十七日验收')).toBe('2026-10-17');
  });
  test('2026年10月 / 2026年 / ISO 2026-10-17', () => {
    expect(range('2026年10月总结')).toBe('2026-10-01..2026-10-31');
    expect(range('2025年的年报')).toBe('2025-01-01..2025-12-31');
    expect(range('2026-10-17 .80 WOL 叫不醒的根因')).toBe('2026-10-17');
  });
  test('10月17号 past-direction: picks ref year; 12月17号 picks past year', () => {
    expect(range('12月17号的庆典')).toBe('2025-12-17');
  });
});

describe('CJK non-matches (precision)', () => {
  test('no false cues', () => {
    for (const q of ['周期任务', '两周年纪念', '三周年的项目', '随机森林', '十年树木计划', '五光十色的设计']) {
      expect(findTimeMentions(q, REF).length, `expected no mention for ${q}`).toBe(0);
    }
  });
});

describe('parseQueryTimeRange with CJK', () => {
  test('applies single-cue range', () => {
    const r = parseQueryTimeRange('上周 Local Studio 升级到什么版本了', REF);
    expect(r.reason).toBe('applied');
    expect(r.range!.start).toBe('2026-10-05');
    expect(r.range!.end).toBe('2026-10-11');
  });
  test('joined 上个月和这个月 → one span', () => {
    const r = parseQueryTimeRange('上个月和这个月的日报汇总', REF);
    expect(r.reason).toBe('applied');
    expect(r.range!.start).toBe('2026-09-01');
    expect(r.range!.end).toBe('2026-10-31');
  });
  test('multi-role abstains', () => {
    expect(parseQueryTimeRange('上周部署了什么，上个月呢', REF).reason).toBe('multi_role');
  });
  test('no cue abstains', () => {
    expect(parseQueryTimeRange('kev-proxy 的配置', REF).reason).toBe('no_cue');
  });
});
