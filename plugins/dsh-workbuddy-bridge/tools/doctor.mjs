/**
 * doctor.mjs —— 一条命令体检
 *
 *   node tools/doctor.mjs [--port 8792] [--model glm-5.3-flash] [--skip-chat]
 *
 * 依次检查：
 *   1) 本机 WorkBuddy 登录态能不能解开令牌
 *   2) 桥接服务能不能起来
 *   3) /v1/models 能不能列出模型
 *   4) /v1/chat/completions 流式与非流式能不能拿到回复
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBridge } from '../lib/serve.mjs';
import { readSecretState, secretPath } from '../lib/local-secret.mjs';

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const skipChat = argv.includes('--skip-chat');
const PROFILE = read('--profile', 'desktop');
const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');
const CRED_REF = 'WORKBUDDY_API_KEY';

const log = [];
const say = (line) => {
  console.log(line);
  log.push(line);
};

let failures = 0;
const check = (label, ok, detail = '') => {
  say(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
};

say('dsh-workbuddy-bridge 体检\n');

/* 0. 密钥：DSH 没拿到它就会直接报 No API key，先看这把钥匙本身对不对得上 */
const KEY = read('--api-key', '') || readSecretState(DSH_HOME)?.apiKey || '';
const patchFile = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
const credFile = path.join(DSH_HOME, '.credentials.yaml');

const inProvider = extractProviderKey(patchFile);
const inCred = extractCredKey(credFile);

check('本机密钥存在', !!KEY, KEY ? secretPath(DSH_HOME) : `${secretPath(DSH_HOME)} 不存在，跑一次 install.mjs`);
if (KEY) {
  const inSelf = extractSelfKey(patchFile);
  check(
    'llm-pi-ai provider 里的密钥一致',
    inProvider.found && inProvider.key === KEY,
    inProvider.found ? (inProvider.key === KEY ? 'headers.Authorization 对得上' : '跟密钥文件不一致，重跑 install.mjs') : 'cordis.patch.yml 里没有 workbuddy provider（或没写 headers），重跑 install.mjs',
  );
  check(
    'DSH 凭据库里的密钥一致',
    inCred.found && inCred.key === KEY,
    inCred.found ? (inCred.key === KEY ? `${CRED_REF} 对得上` : '跟密钥文件不一致，重跑 install.mjs') : `凭据库里没有 ${CRED_REF}（headers 路径仍可用）`,
  );
  check(
    '插件自身配置里的密钥一致',
    inSelf.found && inSelf.key === KEY,
    inSelf.found ? (inSelf.key === KEY ? '对得上' : '跟密钥文件不一致，重跑 install.mjs') : '没找到 workbuddy-bridge 条目，重跑 install.mjs',
  );
}

/* 1. 令牌 */
let bridge;
try {
  bridge = startBridge({
    host: read('--host', '127.0.0.1'),
    port: Number(read('--port', '8792')),
    apiKey: KEY,
    uid: read('--uid', ''),
  });
  const accounts = bridge.vault.listPublic();
  check(
    '本机 WorkBuddy 登录态',
    accounts.length > 0,
    accounts.map((a) => `${a.name}${a.isActive ? '（在用）' : ''}`).join('、') || '没解出账号',
  );
} catch (e) {
  check('本机 WorkBuddy 登录态', false, e.message);
  say('\n先修好上面这条，后面的检查没法做。');
  process.exit(1);
}

/* 2. 起服务 */
let port;
let adopted = false;
try {
  const r = await bridge.server.listenOrAdopt();
  port = r.port;
  adopted = r.adopted;
  check('桥接服务端口', true, `127.0.0.1:${port}${adopted ? '（接管了已在跑的实例）' : ''}`);
} catch (e) {
  check('桥接服务端口', false, e.message);
  process.exit(1);
}

const base = bridge.server.baseUrl;

/* 2.5 密钥校验：桥该认对的、拒错的 */
if (KEY) {
  if (adopted) {
    // 接管来的实例是别人起的，它读没读新密钥我们说了不算，验了只会误报
    say('- 错误密钥被拒 — 跳过（接管的是外部实例，它自己决定要不要校验）');
  } else {
    try {
      const res = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer definitely-not-the-key' } });
      check('错误密钥被拒', res.status === 401, res.status === 401 ? '返回 401' : `居然放行了（HTTP ${res.status}）`);
    } catch (e) {
      check('错误密钥被拒', false, e.message);
    }
  }
}

/* 3. 模型清单 */
let models = [];
try {
  const res = await fetch(`${base}/v1/models`, { headers: authHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  models = body.data || [];
  check('/v1/models', models.length > 0, `${models.length} 个模型`);
  for (const m of models.slice(0, 12)) say(`    · ${m.id} — ${m.name}（上下文 ${m.context_window ?? '?'} / 输出 ${m.max_tokens ?? '?'}）`);
  if (models.length > 12) say(`    · …… 还有 ${models.length - 12} 个`);
} catch (e) {
  check('/v1/models', false, e.message);
}

/* 4. 对话 */
if (!skipChat) {
  const model = read('--model', '') || (models.find((m) => m.id === 'glm-5.3-flash') || models[0])?.id;
  if (!model) {
    check('对话', false, '没有可用模型');
  } else {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      { role: 'user', content: '只回复四个字：桥接正常' },
    ];
    // 流式
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      });
      const ct = res.headers.get('content-type') || '';
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 200)}`);
      let text = '';
      let usage = null;
      let done = false;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') {
          done = true;
          continue;
        }
        try {
          const j = JSON.parse(p);
          if (j.choices?.[0]?.delta?.content) text += j.choices[0].delta.content;
          if (j.usage) usage = j.usage;
        } catch {
          /* 忽略坏帧 */
        }
      }
      check('流式对话', !!text && done && ct.includes('event-stream'), `${model} → “${text.trim()}”${usage ? ` · ${usage.total_tokens} tokens` : ''}`);
    } catch (e) {
      check('流式对话', false, e.message);
    }

    // 非流式
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model, messages, stream: false }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      const content = body.choices?.[0]?.message?.content || '';
      check('非流式对话', !!content, `${model} → “${content.trim()}”`);
    } catch (e) {
      check('非流式对话', false, e.message);
    }
  }
}

await bridge.server.close();

say(`\n${failures === 0 ? '全部通过。' : `${failures} 项没过。`}`);
process.exit(failures === 0 ? 0 : 1);

/* ================================ 工具 ================================ */

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (KEY) h.Authorization = `Bearer ${KEY}`;
  return h;
}

function readIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/** 从 llm-pi-ai 的 workbuddy provider 里抠出 headers.Authorization 的密钥。 */
function extractProviderKey(file) {
  const lines = readIfExists(file).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{6}workbuddy:\s*$/.test(l));
  if (start === -1) return { found: false, key: '' };
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^\s{0,5}\S/.test(lines[i])) break;
    if (i > start && /^\s{6}\S/.test(lines[i])) break;
    const m = lines[i].match(/^\s+Authorization:\s*(?:'([^']*)'|"([^"]*)"|(Bearer\s+\S+))/);
    if (m) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      return { found: true, key: raw.replace(/^Bearer\s+/, '') };
    }
  }
  return { found: false, key: '' };
}

/** 从插件自身条目里抠出 apiKey。 */
function extractSelfKey(file) {
  const lines = readIfExists(file).split(/\r?\n/);
  const start = lines.findIndex((l) => /^-\s+id:\s*workbuddy-bridge\s*$/.test(l));
  if (start === -1) return { found: false, key: '' };
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s+id:/.test(lines[i])) break;
    const m = lines[i].match(/^\s+apiKey:\s*(?:'([^']*)'|"([^"]*)"|(\S+))/);
    if (m) return { found: true, key: (m[1] ?? m[2] ?? m[3] ?? '').replace(/^['"]|['"]$/g, '') };
  }
  return { found: false, key: '' };
}

/** 从 DSH 凭据库的 refs 段里抠出 WORKBUDDY_API_KEY。 */
function extractCredKey(file) {
  const lines = readIfExists(file).split(/\r?\n/);
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (refsIdx === -1) return { found: false, key: '' };
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(/^\s{2}WORKBUDDY_API_KEY:\s*(?:'([^']*)'|"([^"]*)"|(\S+))/);
    if (m) return { found: true, key: (m[1] ?? m[2] ?? m[3] ?? '').replace(/^['"]|['"]$/g, '') };
  }
  return { found: false, key: '' };
}
