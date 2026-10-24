/**
 * probe-credit-value.mjs —— 确认 SSE 的 usage.credit 到底给不给数。
 *
 * 上一轮在 glm-5.3-flash 上拿到 credit=0，得搞清楚是「这个模型不扣积分」
 * 还是「这个字段就没用」。换几个不同倍率的模型各跑一次。
 *
 * 用法：node tools/probe-credit-value.mjs [模型...]
 */

import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const MODELS = process.argv.slice(2);
const TARGETS = MODELS.length > 0 ? MODELS : ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k2.7', 'glm-5.3-flash'];
const say = (s) => process.stdout.write(s + '\n');

const vault = new TokenVault({});
const token = await vault.getAccessToken();

async function askOnce(model, prompt) {
  const cid = crypto.randomUUID();
  const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
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
      traceparent: `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: prompt },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const raw = await res.text();
  let last = null;
  let text = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      if (j.usage) last = j.usage;
      const c = j.choices?.[0]?.delta?.content;
      if (c) text += c;
    } catch {
      /* 忽略半包 */
    }
  }
  return { usage: last, text: text.slice(0, 40) };
}

say('逐个模型发一次真实请求，看 usage.credit 给不给数\n');

for (const model of TARGETS) {
  const r = await askOnce(model, '用一句话解释什么是积分');
  if (r.error) {
    say(`  ${model.padEnd(22)} ${r.error}`);
    continue;
  }
  const u = r.usage || {};
  say(`  ${model.padEnd(22)} credit=${JSON.stringify(u.credit)}  tokens=${u.total_tokens}  回复「${r.text}」`);
}
