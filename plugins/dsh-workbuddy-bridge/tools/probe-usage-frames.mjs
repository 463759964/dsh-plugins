/**
 * probe-usage-frames.mjs —— 上游 SSE 每一帧的 usage 都是什么？
 *
 * 记账策略全看这个：如果每帧的 usage 是「到目前为止的累计值」，那取最后一帧就行；
 * 如果是「本帧增量」，那得逐帧累加。搞错了会把消耗记成十几倍。
 *
 * 用法：node tools/probe-usage-frames.mjs [模型]
 */

import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const MODEL = process.argv[2] || 'glm-5.3';
const say = (s) => process.stdout.write(s + '\n');

const vault = new TokenVault({});
const token = await vault.getAccessToken();

const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
  method: 'POST',
  signal: AbortSignal.timeout(90000),
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-Conversation-ID': crypto.randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'Accept-Encoding': 'identity',
    traceparent: `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`,
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: '用三句话介绍你自己' },
    ],
    stream: true,
    stream_options: { include_usage: true },
  }),
});

const raw = await res.text();
say(`模型 ${MODEL} · HTTP ${res.status}\n`);
say('帧序  finish  total_tokens  completion  credit');
say('----  ------  ------------  ----------  ------');

let i = 0;
for (const line of raw.split('\n')) {
  const t = line.trim();
  if (!t.startsWith('data:')) continue;
  const p = t.slice(5).trim();
  if (p === '[DONE]') continue;
  let j;
  try {
    j = JSON.parse(p);
  } catch {
    continue;
  }
  i += 1;
  const u = j.usage || {};
  say(
    `${String(i).padStart(4)}  ${String(j.choices?.[0]?.finish_reason || '-').padEnd(6)}  ` +
      `${String(u.total_tokens ?? '-').padStart(12)}  ${String(u.completion_tokens ?? '-').padStart(10)}  ` +
      `${String(u.credit ?? '-').padStart(6)}`,
  );
}

say(`\n共 ${i} 帧`);
