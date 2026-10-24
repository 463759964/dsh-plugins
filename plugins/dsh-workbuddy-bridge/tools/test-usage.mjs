#!/usr/bin/env node
/**
 * test-usage.mjs —— 账本的单元测试
 *
 *   node tools/test-usage.mjs
 *
 * 重点盯两件容易出错的事：
 *   1. 多进程落盘：桥接经常不止一个进程，各自只攒着自己的账，落盘时不能互相盖掉
 *   2. 老账本迁移：v1 格式没有账号维度，得等知道当前 uid 了再认领，不能瞎猜
 *
 * 测试用的是临时目录，不碰 ~/.dsh 里那份真账本。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageTracker, UNKNOWN_UID, dayKey, extractUsage } from '../lib/usage-tracker.mjs';

let passed = 0;
let failed = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

const eq = (actual, expected, label) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-'));
  return path.join(dir, name);
}

function group(title, fn) {
  console.log(`\n${title}`);
  fn();
}

/* ------------------------------------------------------------ 基础记账 */

group('基础记账', () => {
  const t = new UsageTracker({ file: tmpFile('a.json') });
  t.record({ model: 'glm-5.3', credit: 0.03, tokens: 100, uid: 'u1', accountName: '甲' });
  t.record({ model: 'glm-5.3', credit: 0.03, tokens: 200, uid: 'u1' });
  t.record({ model: 'kimi-k2.7', credit: 0.05, tokens: 50, uid: 'u1' });

  const d = t.day({ uid: 'u1' });
  eq(d.date, dayKey(), '日期取今天');
  eq(d.credit, 0.11, '积分累加（0.03+0.03+0.05）');
  eq(d.requests, 3, '请求数累加到 3，而不是按帧数重复计');
  eq(d.tokens, 350, 'token 累加');

  const byModel = Object.entries(d.models).sort((a, b) => b[1].credit - a[1].credit);
  // glm-5.3 两次共 0.06，比 kimi 的 0.05 多
  eq(byModel.map(([m]) => m), ['glm-5.3', 'kimi-k2.7'], '按模型分桶，按消耗降序');
  eq(d.models['glm-5.3'].credit, 0.06, 'glm-5.3 累计 0.06');
  eq(d.models['glm-5.3'].requests, 2, 'glm-5.3 记到 2 次');
  eq(d.models['kimi-k2.7'].credit, 0.05, 'kimi-k2.7 记到 0.05');
});

group('多账号分桶', () => {
  const t = new UsageTracker({ file: tmpFile('b.json') });
  t.record({ model: 'm', credit: 1, tokens: 10, uid: 'u1', accountName: '甲' });
  t.record({ model: 'm', credit: 2, tokens: 20, uid: 'u2', accountName: '乙' });
  t.record({ model: 'm', credit: 0, tokens: 5, uid: 'u1' });

  eq(t.day({ uid: 'u1' }).credit, 1, '甲只算自己的');
  eq(t.day({ uid: 'u2' }).credit, 2, '乙只算自己的');
  eq(t.day({ uid: 'u1' }).requests, 2, '甲两次');
  eq(t.day({ uid: 'u2' }).requests, 1, '乙一次');

  const list = t.accounts();
  eq(list.map((a) => a.uid).sort(), ['u1', 'u2'], '两个账号都在列表里');
  eq(list.find((a) => a.uid === 'u1').name, '甲', '账号名记下来了');
  eq(t.findAccount('乙')?.uid, 'u2', '按名字能找到账号');
  eq(t.findAccount('u2')?.name, '乙', '按 uid 也能找到');
});

group('限免模型（credit=0）', () => {
  const t = new UsageTracker({ file: tmpFile('c.json') });
  t.record({ model: 'deepseek-v4.1-flash', credit: 0, tokens: 1234, uid: 'u1' });
  const d = t.day({ uid: 'u1' });
  eq(d.credit, 0, '限免模型积分为 0');
  eq(d.requests, 1, '请求数照记，不能因为积分是 0 就不算');
  eq(d.tokens, 1234, 'token 照记');
});

/* --------------------------------------------------- 多进程落盘（重点） */

group('多进程落盘不互相覆盖', () => {
  const file = tmpFile('shared.json');

  // 模拟两个桥接进程：各自只知道自己转发的那些请求
  const a = new UsageTracker({ file });
  const b = new UsageTracker({ file });

  a.record({ model: 'm1', credit: 1, tokens: 10, uid: 'u1', accountName: '甲' });
  b.record({ model: 'm2', credit: 2, tokens: 20, uid: 'u1', accountName: '甲' });

  a.flush();
  b.flush();

  const after = new UsageTracker({ file });
  const d = after.day({ uid: 'u1' });
  eq(d.credit, 3, '两边各记的都在，没被后写的盖掉');
  eq(d.requests, 2, '请求数是 2 不是 1');
  eq(d.tokens, 30, 'token 也是两边之和');
  eq(Object.keys(d.models).sort(), ['m1', 'm2'], '模型分桶也没丢');

  // 再来一轮：先 flush 的那个进程继续记账，也不能把对方冲掉
  a.record({ model: 'm1', credit: 5, tokens: 50, uid: 'u1' });
  a.flush();
  eq(new UsageTracker({ file }).day({ uid: 'u1' }).credit, 8, '交错落盘后累计正确');
});

group('落盘后能读到别的进程记的账', () => {
  const file = tmpFile('shared2.json');
  const a = new UsageTracker({ file });
  const b = new UsageTracker({ file });

  a.record({ model: 'm1', credit: 1, tokens: 10, uid: 'u1' });
  a.flush();

  // b 此刻磁盘上已经有 a 的账，但 b 内存里没有
  eq(b.day({ uid: 'u1' }).credit, 0, 'flush 之前看不到别人的账');
  b.record({ model: 'm2', credit: 2, tokens: 20, uid: 'u1' });
  b.flush();
  eq(b.day({ uid: 'u1' }).credit, 3, 'flush 之后内存里就是全量了（1+2）');
});

/* ------------------------------------------------------------ 老账本迁移 */

group('v1 老账本迁移', () => {
  const file = tmpFile('legacy.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      days: {
        [dayKey()]: {
          credit: 7,
          requests: 3,
          tokens: 300,
          models: { 'old-model': { credit: 7, requests: 3, tokens: 300 } },
        },
      },
    }),
  );

  const t = new UsageTracker({ file });
  eq(t.day({ uid: 'u1' }).credit, 0, '还没记账时，老数据不认领给任何人');

  t.record({ model: 'm', credit: 1, tokens: 10, uid: 'u1', accountName: '甲' });
  eq(t.day({ uid: 'u1' }).credit, 8, '第一次记账后，老数据并到当前账号（7+1）');
  eq(t.day({ uid: 'u1' }).requests, 4, '老数据的 3 次也接上了');

  t.flush();
  const reread = new UsageTracker({ file });
  eq(reread.day({ uid: 'u1' }).credit, 8, '落盘后老数据还在');
});

/* -------------------------------------------------------------- 裁剪与容错 */

group('只留 30 天', () => {
  const file = tmpFile('prune.json');
  const t = new UsageTracker({ file });
  const old = new Date();
  old.setDate(old.getDate() - 40);
  t.record({ model: 'm', credit: 1, tokens: 1, uid: 'u1', at: old });
  t.flush();
  eq(Object.keys(new UsageTracker({ file }).data.accounts.u1.days).length, 0, '40 天前的数据被裁掉');
});

group('坏文件不炸', () => {
  const file = tmpFile('broken.json');
  fs.writeFileSync(file, '{ 这不是 json');
  const t = new UsageTracker({ file });
  eq(t.day({ uid: 'u1' }).credit, 0, '读坏了就当空账本，不抛异常');

  // 每次都换一个新目录，免得上一次跑留下的文件把计数带偏
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-nested-'));
  const missing = new UsageTracker({ file: path.join(fresh, '深层', '目录', 'x.json') });
  missing.record({ model: 'm', credit: 1, tokens: 1, uid: 'u1' });
  missing.flush();
  eq(missing.day({ uid: 'u1' }).credit, 1, '多层目录不存在时会自己建');
});

group('uid 缺失时归到 unknown', () => {
  const t = new UsageTracker({ file: tmpFile('anon.json') });
  t.record({ model: 'm', credit: 1, tokens: 1 });
  eq(t.day({ uid: UNKNOWN_UID }).credit, 1, '记到 unknown 桶');
});

/* ------------------------------------------------------------ 帧解析 */

group('从 SSE 帧里取消耗', () => {
  eq(extractUsage({ usage: { credit: 0.03, total_tokens: 69 } }), { credit: 0.03, tokens: 69 }, '正常帧');
  eq(extractUsage({ usage: null }), null, '中间帧 usage 是 null');
  eq(extractUsage({}), null, '没有 usage 字段');
  eq(extractUsage({ usage: {} }), null, 'usage 是空对象');
  eq(extractUsage({ usage: { credit: 0.03 } }), { credit: 0.03, tokens: 0 }, '只有 credit');
  eq(extractUsage({ usage: { totalTokens: 12 } }), { credit: 0, tokens: 12 }, '驼峰写法也认');
});

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
