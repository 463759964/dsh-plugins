/**
 * probe-reasoning.mjs —— 实测上游网关认不认各个思考等级。
 *
 * 桥接把 `reasoning_effort` 原样透传给 WorkBuddy 网关，但上游接不接受某个值
 * （尤其是 OpenAI 标准里没有的 `max`）得发一次真请求才知道。
 *
 * 用法：node tools/probe-reasoning.mjs [模型 id] [等级...]
 *   node tools/probe-reasoning.mjs deepseek-v4.1-flash low high max
 */

import { TokenVault } from '../lib/workbuddy-token.mjs';
import { UpstreamClient, toUpstreamPayload } from '../lib/upstream.mjs';

const argv = process.argv.slice(2);
const MODEL = argv[0] || 'deepseek-v4.1-flash';
const LEVELS = argv.length > 1 ? argv.slice(1) : ['low', 'high', 'max'];

const say = (s) => process.stdout.write(s + '\n');

const vault = new TokenVault({});
const client = new UpstreamClient({ vault });

say(`模型 ${MODEL}，逐个试思考等级\n`);

let bad = 0;
for (const level of LEVELS) {
  const payload = toUpstreamPayload({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Be extremely concise.' },
      { role: 'user', content: '1+1=?' },
    ],
    stream: true,
    max_tokens: 200,
    reasoning_effort: level,
  });

  say(`  reasoning_effort = ${JSON.stringify(level)} → 发出 ${JSON.stringify(payload.reasoning_effort)}`);

  try {
    const res = await client.chat(payload);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      say(`    ✗ HTTP ${res.status}：${text}`);
      bad += 1;
      continue;
    }
    // 只看前几行就够了：能正常出流就说明这个等级被接受了
    const reader = res.body.getReader();
    let chunk = '';
    let reason = '';
    try {
      while (chunk.length < 4000) {
        const { done, value } = await reader.read();
        if (done) break;
        chunk += Buffer.from(value).toString('utf8');
        if (chunk.includes('[DONE]')) break;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 上游已经结束，取消失败无所谓 */
      }
    }
    // 上游若回 reasoning_content，说明思考确实发生了
    if (/"reasoning_content"/.test(chunk)) reason = '（有 reasoning_content，思考了）';
    else if (/"reasoning"/.test(chunk)) reason = '（有 reasoning 字段）';
    say(`    ✓ HTTP 200，有内容流出 ${reason}`);
  } catch (e) {
    say(`    ✗ ${e.message}`);
    bad += 1;
  }
}

say(`\n${bad === 0 ? '全部等级都被上游接受。' : `${bad} 个等级被上游拒了。`}`);
process.exit(bad === 0 ? 0 : 1);
