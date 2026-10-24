/**
 * probe.mjs —— 打通前的最小验证：取令牌 → 拉模型 → 打一轮对话
 * 用法：node tools/probe.mjs [modelId]
 */
import crypto from 'node:crypto';
import { TokenVault, findWorkBuddyExe, findLoginInfo } from '../lib/workbuddy-token.mjs';

const GATEWAY = 'https://copilot.tencent.com';

function uuid() {
  return crypto.randomUUID();
}

const vault = new TokenVault({});

console.log('· 客户端：', findWorkBuddyExe());
console.log('· 登录态：', findLoginInfo());

const accounts = vault.load();
for (const a of accounts) {
  const d = a.expiresAt ? ((a.expiresAt - Date.now()) / 86400000).toFixed(1) : '?';
  console.log(`  - ${a.name} (${a.uid}): access 剩 ${d} 天, refresh ${a.refreshToken ? '有' : '无'}`);
}

// 1) 模型列表
const token = await vault.getAccessToken();
const uuid1 = uuid();
const mres = await fetch(`${GATEWAY}/v2/enterprises/personal/models`, {
  headers: {
    Accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-Request-ID': uuid1,
    'X-Conversation-ID': uuid1,
    Authorization: `Bearer ${token}`,
  },
});
console.log('\n[models] HTTP', mres.status);
const mbody = await mres.text();
console.log('[models] body 前 600 字：', mbody.slice(0, 600));

let models = [];
try {
  models = JSON.parse(mbody).data?.models || [];
} catch {
  /* ignore */
}
console.log('[models] endpoint:', JSON.parse(mbody).data?.endpoint);
if (models.length) {
  console.log(`[models] 共 ${models.length} 个：`);
  for (const m of models) {
    console.log(
      '   -',
      m.id,
      '|',
      m.name,
      '| in',
      m.maxInputTokens,
      '| out',
      m.maxOutputTokens,
      '| img',
      m.supportsImages,
      '| reason',
      m.supportsReasoning,
      '| credits',
      m.credits,
    );
  }
}

// 2) 对话
const target = process.argv[2] || (models[0] && models[0].id);
if (!target) {
  console.log('\n没有可用模型，跳过对话验证。');
  process.exit(0);
}
console.log(`\n[chat] 目标模型：${target}`);

const cid = uuid();
const cres = await fetch(`${GATEWAY}/v2/chat/completions`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-Request-ID': uuid(),
    'X-Conversation-ID': cid,
    'X-Conversation-Request-ID': uuid(),
    'X-Conversation-Message-ID': uuid(),
    'Accept-Encoding': 'identity',
    Authorization: `Bearer ${await vault.getAccessToken()}`,
  },
  body: JSON.stringify({
    model: target,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      { role: 'user', content: '用一句话说明你是谁。' },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1,
  }),
});

console.log('[chat] HTTP', cres.status, cres.headers.get('content-type'));
if (!cres.ok) {
  console.log('[chat] body:', (await cres.text()).slice(0, 800));
  process.exit(1);
}

// SSE
const reader = cres.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
let usage = null;
let done = false;
while (!done) {
  const { value, done: d } = await reader.read();
  if (d) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      break;
    }
    try {
      const j = JSON.parse(payload);
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        process.stdout.write(delta.content);
      }
      if (j.usage) usage = j.usage;
    } catch (e) {
      console.log('\n[chat] 解析失败：', payload.slice(0, 200));
    }
  }
}
console.log('\n\n[chat] 完整回复：', text);
console.log('[chat] usage：', JSON.stringify(usage));
