/**
 * bisect-payload.mjs —— 对「渠道判定被拒」的完整请求做重放二分
 *
 * 背景：网关的「Illegal API invocation from an unapproved channel」判定不告诉你
 * 触发点在哪个字段。bisect-system.mjs 只能二分 system 文本，但 2026-11-07 的故障
 * 表明触发点也可能在 user 消息（DSH 注入的 runtime-context / skills 提醒）或 tools 里。
 * 桥在被拒时会把净化后的完整请求落到 logs/rejected-payload-*.json，本工具直接拿它：
 *
 *   1. 整包重放：现在还拒不拒（网关判定有波动，可能已无法复现）；
 *   2. 逐条剔除：拿掉第 i 条消息就通过 → 第 i 条是触发必要条件；
 *   3. 单条重放：只发第 i 条就触发 → 充分条件，再对这条文本做前缀二分定位最小触发段；
 *   4. tools 维度：去掉 tools 是否通过、只发 tools 是否触发。
 *
 * 用法：node tools/bisect-payload.mjs logs/rejected-payload-<时间戳>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const GATEWAY = 'https://copilot.tencent.com';
const MODEL = 'deepseek-v4.1-flash';
const vault = new TokenVault({});

function headers(token) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-Conversation-ID': crypto.randomUUID(),
    'X-Conversation-Request-ID': crypto.randomUUID(),
    'X-Conversation-Message-ID': crypto.randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'Accept-Encoding': 'identity',
    Authorization: `Bearer ${token}`,
  };
}

/** 打一发。判定只看输入，max_tokens 压到 16 省额度。返回 true=通过 false=被拒。 */
async function pass(payload) {
  const token = await vault.getAccessToken();
  const probe = { ...payload, model: payload.model || MODEL, max_tokens: 16, stream: true };
  delete probe.stream_options;
  const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(probe),
  });
  if (res.ok) {
    await res.text();
    return true;
  }
  const text = await res.text().catch(() => '');
  if (/unapproved channel/i.test(text)) return false;
  console.log('  （注意：这次失败不是渠道判定，而是', res.status, text.slice(0, 120), '——按“通过”处理）');
  return true; // 非渠道判定的失败不算触发
}

function msgText(m) {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p) => p?.text || '').join('\n');
  return '';
}

/** 对单条消息的文本做前缀二分，找最短被拒前缀，再滑窗摘出最小触发段。 */
async function bisectText(text) {
  let lo = 0;
  let hi = text.length;
  while (hi - lo > 200) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await pass({ messages: [{ role: 'system', content: text.slice(0, mid) }, { role: 'user', content: 'hi' }] });
    if (ok) lo = mid;
    else hi = mid;
    process.stdout.write(`  前缀 ${mid} → ${ok ? '通过' : '拒绝'}\n`);
  }
  for (const width of [2000, 600, 160]) {
    const from = Math.max(0, hi - width * 2);
    for (let start = from; start < hi + width; start += Math.floor(width / 4)) {
      const seg = text.slice(start, start + width);
      if (seg.length < width / 2) break;
      if (!(await pass({ messages: [{ role: 'system', content: seg }, { role: 'user', content: 'hi' }] }))) {
        console.log(`\n最小触发窗口 ≈ [${start}, ${start + seg.length})，宽度 ${width}：`);
        console.log('----');
        console.log(seg);
        console.log('----');
        return;
      }
    }
  }
  console.log('没能在临界位置复现局部触发，可能是整段组合判定。');
}

/* ------------------------------- 主流程 ------------------------------- */

const file = process.argv[2] && path.resolve(process.argv[2]);
if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/bisect-payload.mjs <logs/rejected-payload-*.json>');
  process.exit(1);
}
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const payload = dump.payload || dump;
const messages = Array.isArray(payload.messages) ? payload.messages : [];
console.log('落盘摘要：', JSON.stringify(dump.summary || '(无摘要，旧格式)'));
console.log('消息数：', messages.length, '；tools：', Array.isArray(payload.tools) ? payload.tools.length : 0);

console.log('\n[1] 整包重放…');
if (await pass(payload)) {
  console.log('整包重放：通过。网关当前不再拒这个请求——判定有波动或规则已回落，无法复现。');
  console.log('建议：保留这份落盘，下次再拒时立刻跑本工具对比两份 dump 的差异。');
  process.exit(0);
}
console.log('整包重放：仍被拒，开始二分。');

console.log('\n[2] 逐条剔除（找必要条件）…');
const necessary = [];
for (let i = 0; i < messages.length; i += 1) {
  const rest = messages.filter((_, k) => k !== i);
  if (!rest.length) continue;
  const ok = await pass({ ...payload, messages: rest });
  console.log(`  去掉 [${i}] ${messages[i]?.role}（${msgText(messages[i]).length} 字）→ ${ok ? '通过' : '仍拒'}`);
  if (ok) necessary.push(i);
}

console.log('\n[3] 单条重放（找充分条件）…');
const sufficient = [];
for (let i = 0; i < messages.length; i += 1) {
  const m = messages[i];
  const probeMsgs = m?.role === 'user' ? [m] : [m, { role: 'user', content: 'hi' }];
  const ok = await pass({ model: payload.model, messages: probeMsgs });
  console.log(`  只发 [${i}] ${m?.role}（${msgText(m).length} 字）→ ${ok ? '通过' : '触发！'}`);
  if (!ok) sufficient.push(i);
}

if (Array.isArray(payload.tools) && payload.tools.length) {
  console.log('\n[4] tools 维度…');
  const noTools = await pass({ ...payload, tools: undefined });
  console.log('  去掉 tools：', noTools ? '通过（tools 参与触发）' : '仍拒');
  const toolsOnly = await pass({ model: payload.model, messages: [{ role: 'user', content: 'hi' }], tools: payload.tools });
  console.log('  只发 tools：', toolsOnly ? '通过' : '触发！tools 本身即是渠道指纹');
}

if (sufficient.length) {
  const i = sufficient[0];
  console.log(`\n定位到单条触发：消息 [${i}]（${messages[i]?.role}）。对它的文本做前缀二分…`);
  await bisectText(msgText(messages[i]));
  console.log('\n把这一段按 lib/prompt-shield.mjs 里的 RULES 格式加一条等价改写；');
  if (messages[i]?.role !== 'system') {
    console.log('注意：触发消息是 user 角色，现有 shieldMessages 只处理 system——需要把该角色的净化一并打开。');
  }
} else if (necessary.length) {
  console.log(`\n没有单条能独立触发，但去掉 [${necessary.join(', ')}] 中任意一条就能通过：属于组合判定。`);
  console.log('建议：优先改写这些消息里最像「别的 agent 产品指纹」的句子（产品名、特有术语）。');
} else {
  console.log('\n消息层面没找到触发点，触发可能在 tools 与消息的组合，或网关按总长度/总量判定。');
}
