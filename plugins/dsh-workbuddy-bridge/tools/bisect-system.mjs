/**
 * bisect-system.mjs —— 定位 DSH 系统提示里哪一段被 WorkBuddy 网关判成「未授权渠道」
 *
 * 背景：网关会把「看起来像别的 agent 产品在调我们的模型」的 system 提示整轮拒掉，
 * 返回 502 / "Illegal API invocation from an unapproved channel"。这个错误不告诉你
 * 是哪一段话触发的，所以这里用「切片重打」的方式二分定位：把命中的那一段交给
 * lib/prompt-shield.mjs 加规则改写。
 *
 * 用法：
 *   node tools/bisect-system.mjs                     # 用当前目录下最新的 DSH 会话
 *   node tools/bisect-system.mjs <session.jsonl>     # 用指定文件（已解压的明文 jsonl）
 *   node tools/bisect-system.mjs --full              # 只验证整段 system 是否通过
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const GATEWAY = 'https://copilot.tencent.com';
const MODEL = 'deepseek-v4.1-flash';
const vault = new TokenVault({});

/* ------------------------- 取一段 system 提示 ------------------------- */

/** DSH 的会话日志是 zstd 分帧压缩的 jsonl，逐帧解开再拼起来。 */
function readZstdJsonl(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let text = '';
  for (let k = 0; k < starts.length; k += 1) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      text += zlib.zstdDecompressSync(seg).toString('utf8');
    } catch {
      /* 半帧跳过 */
    }
  }
  return text;
}

function newestSessionFile() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  let best = null;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) {
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return best ? best.path : null;
}

function systemFromSession(file) {
  const raw = file.endsWith('.zstd') ? readZstdJsonl(file) : fs.readFileSync(file, 'utf8');
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const sys = events.filter((e) => e.type === 'system/message').pop();
  if (!sys) throw new Error('这个会话里没有 system/message 事件。');
  const content = sys.data?.message?.content;
  const text = Array.isArray(content)
    ? content.map((c) => c.text || '').join('\n')
    : String(content || '');
  if (!text) throw new Error('system/message 里没有可读文本。');
  return text;
}

/* ------------------------------ 打一发 ------------------------------ */

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

async function pass(system) {
  const token = await vault.getAccessToken();
  const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      max_tokens: 16,
    }),
  });
  if (res.ok) {
    await res.text();
    return true;
  }
  await res.text().catch(() => '');
  return false;
}

/* ------------------------------- 主流程 ------------------------------- */

const argv = process.argv.slice(2);
const full = argv.includes('--full');
const explicit = argv.find((a) => !a.startsWith('--')) || null;
const file = explicit ? path.resolve(explicit) : newestSessionFile();
if (!file) {
  console.error('没找到 DSH 会话文件，直接传一个路径进来。');
  process.exit(1);
}
console.log('会话：', file);

const system = systemFromSession(file);
console.log('system 长度：', system.length);
const base = await pass(system);
console.log('整段 system：', base ? '通过' : '被拒');
if (base || full) process.exit(base ? 0 : 1);

// 前缀二分：找最短的、会被拒的前缀
let lo = 0;
let hi = system.length;
while (hi - lo > 200) {
  const mid = Math.floor((lo + hi) / 2);
  const ok = await pass(system.slice(0, mid));
  if (ok) lo = mid;
  else hi = mid;
  process.stdout.write(`前缀 ${mid} → ${ok ? '通过' : '拒绝'}\n`);
}

// 在临界点附近用滑动窗口定位一段可复现的最小触发区
for (const width of [2000, 600, 160]) {
  const from = Math.max(0, hi - width * 2);
  for (let start = from; start < hi + width; start += Math.floor(width / 4)) {
    const seg = system.slice(start, start + width);
    if (seg.length < width / 2) break;
    if (!(await pass(seg))) {
      console.log(`\n最小触发窗口 ≈ [${start}, ${start + seg.length})，宽度 ${width}：`);
      console.log('----');
      console.log(seg);
      console.log('----');
      console.log('\n把这一段按 lib/prompt-shield.mjs 里的 RULES 格式加一条等价改写即可。');
      process.exit(0);
    }
  }
}

console.log('\n没能在临界位置复现局部触发，可能是内容与长度共同作用的判定。');
console.log('建议先用 lib/prompt-shield.mjs 的现有规则做等价改写，再整段重试。');
