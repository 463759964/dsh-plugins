/**
 * probe-usage.mjs —— 探测「积分消耗」到底从哪儿能读到。
 *
 * 两条路都试一遍，看哪条能给出「今日累计消耗」：
 *   A. 对话 SSE 流里带不带本次调用的消耗（桥接就坐在数据必经之路上，能自己累加）
 *   B. 上游有没有现成的用量/额度接口
 *
 * 用法：node tools/probe-usage.mjs [模型 id]
 */

import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const MODEL = process.argv[2] || 'glm-5.3-flash';
const say = (s) => process.stdout.write(s + '\n');

const vault = new TokenVault({});
const token = await vault.getAccessToken();

/* ---------------------------------------------- A. SSE 里有没有消耗字段 */

say(`【A】对话 SSE —— 模型 ${MODEL}\n`);

const cid = crypto.randomUUID();
const traceId = crypto.randomBytes(16).toString('hex');
const spanId = crypto.randomBytes(8).toString('hex');
say('（发一次真实对话，最多等 60 秒）');
const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
  method: 'POST',
  signal: AbortSignal.timeout(60000),
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-Conversation-ID': cid,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'Accept-Encoding': 'identity',
    traceparent: `00-${traceId}-${spanId}-01`,
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Be extremely concise.' },
      { role: 'user', content: '说两个字：你好' },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 200,
  }),
});

say(`HTTP ${res.status}`);
const raw = await res.text();
say(`SSE 总长度 ${raw.length}\n`);

// 逐条打印 SSE data，重点看最后那个带 usage 的包
const chunks = [];
for (const line of raw.split('\n')) {
  const t = line.trim();
  if (!t.startsWith('data:')) continue;
  const p = t.slice(5).trim();
  if (p === '[DONE]') continue;
  try {
    chunks.push(JSON.parse(p));
  } catch {
    /* 忽略半包 */
  }
}

const withUsage = chunks.filter((c) => c.usage !== undefined);
say(`共 ${chunks.length} 个 data 包，其中带 usage 的 ${withUsage.length} 个\n`);

if (withUsage.length > 0) {
  say('最后一个 usage 包原文：');
  say(JSON.stringify(withUsage[withUsage.length - 1], null, 1));
} else {
  say('没找到 usage 包。最后一个包的键：');
  const last = chunks[chunks.length - 1] || {};
  say(JSON.stringify(Object.keys(last)));
  say(JSON.stringify(last).slice(0, 600));
}

// 顺带看看流里有没有别的疑似消耗字段
const blob = JSON.stringify(chunks);
for (const key of ['credit', 'credits', 'point', 'points', 'cost', 'balance', 'quota', 'usage', 'consume']) {
  const m = blob.match(new RegExp(`"${key}"\\s*:\\s*("[^"]*"|[-0-9.]+)`, 'g'));
  if (m) say(`  命中字段 ${key}: ${[...new Set(m)].slice(0, 4).join(' , ')}`);
}

/* ------------------------------------------- B. 用量 / 额度接口 */

say('\n【B】用量接口\n');

const gwHeaders = () => {
  const t2 = crypto.randomBytes(16).toString('hex');
  const s2 = crypto.randomBytes(8).toString('hex');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    traceparent: `00-${t2}-${s2}-01`,
    Authorization: `Bearer ${token}`,
  };
};

const candidates = [
  ['POST', '/v2/billing/meter/get-enterprise-user-usage'],
  ['POST', '/billing/meter/get-user-resource-summary'],
  ['GET', '/v2/user/cloudagent/quota'],
  ['GET', '/v2/accounts'],
  ['GET', '/v2/enterprises/personal/models'],
];

for (const [method, p] of candidates) {
  try {
    const r = await fetch(`https://copilot.tencent.com${p}`, {
      method,
      headers: gwHeaders(),
      body: method === 'POST' ? '{}' : undefined,
    });
    const text = await r.text();
    const brief = text.length > 260 ? `${text.slice(0, 260)}…` : text;
    say(`  ${method} ${p}`);
    say(`    HTTP ${r.status} · ${brief.replace(/\s+/g, ' ')}`);
  } catch (e) {
    say(`  ${method} ${p} — ${e.message}`);
  }
}
