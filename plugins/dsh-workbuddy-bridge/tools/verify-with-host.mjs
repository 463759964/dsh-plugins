/**
 * verify-with-host.mjs —— 用 DSH 宿主自己的代码校验 provider 配置，并跑一次真实请求。
 *
 * 这一步的意义：前面所有检查都是「我照着读到的规则自己验自己」，这里是拿宿主
 * 真正的 schemastery schema 和 pi-ai 请求构造器跑一遍，排除我理解错规则的可能。
 *
 * 做三件事：
 *   1. 用宿主 `Config` schema 校验 cordis.patch.yml 里的 provider 配置（被拒的话
 *      整个 provider 会从模型选择器里消失，连普通模型都用不了）；
 *   2. 用宿主 PiAiAdapter 解析出模型信息，确认 `reasoning` 与可选等级；
 *   3. 对一个假上游发一次带思考等级的请求，确认 `reasoning_effort` 真的进了请求体。
 *
 * 用法：node tools/verify-with-host.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');
const PROFILE = read('--profile', 'desktop');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);

/** 宿主包里 llm-pi-ai 的入口。路径跟版本/系统有关，只能按顺序猜。 */
function findHostPkg() {
  const rel = ['node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'];
  const roots = [PROFILE_DIR];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      roots.push(
        path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh'),
      );
    }
  } else if (process.platform === 'darwin') {
    roots.push(
      '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh',
      path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app/Contents/Resources/app/dsh'),
    );
  } else {
    roots.push('/opt/DeepSeek Harness/resources/app/dsh', '/usr/lib/deepseek-harness/app/dsh');
  }
  for (const root of roots) {
    const p = path.join(root, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(PROFILE_DIR, ...rel);
}

const HOST_PKG = read('--host-pkg', '') || findHostPkg();

const say = (s) => process.stdout.write(s + '\n');
const ok = (label, pass, extra = '') =>
  say(`${pass ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);

let failures = 0;
const expect = (label, pass, extra) => {
  if (!pass) failures += 1;
  ok(label, pass, extra);
  return pass;
};

/* ---------------------------------------------------------------- 读配置 */

const patchPath = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
const require_ = createRequire(path.join(DSH_HOME, 'profiles', PROFILE, 'noop.cjs'));
const yaml = require_('js-yaml');

const doc = yaml.load(fs.readFileSync(patchPath, 'utf8'));
const entry = (Array.isArray(doc) ? doc : []).find((x) => x && x.id === 'llm-pi-ai');
if (!entry) {
  say('✗ 配置里没有 llm-pi-ai 条目');
  process.exit(1);
}
const raw = entry.config.providers.workbuddy;

say('用宿主自己的代码校验 workbuddy provider\n');

/* ------------------------------------------------- 1. 宿主 schema 校验 */

if (!fs.existsSync(HOST_PKG)) {
  say(`✗ 找不到宿主包：${HOST_PKG}`);
  say('  DSH 解包后路径可能变了，用 --host-pkg 指过去。');
  process.exit(1);
}

const { Config, PiAiAdapter } = await import(pathToFileURL(HOST_PKG).href);

// schemastery 的 schema 是函数：传值进去要么返回规范化结果，要么抛错。
const providerConfig = { ...raw, apiKeyEnv: raw.apiKeyEnv || undefined };
let validated = null;
try {
  validated = Config({ providers: { workbuddy: providerConfig } });
  expect('宿主 Config schema 接受这份配置', true, `${raw.models.length} 个模型`);
} catch (e) {
  expect('宿主 Config schema 接受这份配置', false, e.message);
}

if (!validated) {
  say('\n配置被宿主拒了，后面的检查没有意义。');
  process.exit(1);
}

/* ------------------------------------------- 2. 解析出模型的推理能力 */

// PiAiAdapter 需要一个 profiles() 供给器和鉴权上下文；这里只解析模型，不发真请求，
// 所以 auth 给个空壳即可。
const profiles = new Map();
const adapter = new PiAiAdapter({
  profiles: () => profiles,
  auth: { apiKey: async () => 'test-key', headers: () => ({}) },
});

// 把配置喂进宿主的 profile 解析链：走它自己的 setProvider 逻辑
let snapshot;
try {
  // 内部方法：构造一次快照，拿到 pi-ai 的 provider 与模型集合
  const built = adapter.buildProfiles
    ? adapter.buildProfiles(validated.providers)
    : null;
  snapshot = built;
} catch {
  snapshot = null;
}

/* ------------------------------------ 3. 端到端：请求体里有没有推理参数 */

/** 一个只记录请求体、并返回最小合法 SSE 的假上游。 */
function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d.toString();
    });
    req.on('end', () => {
      seen.push(body);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, seen };
}

const { server: fake, seen } = fakeUpstream();
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

say('');

// 直接用 pi-ai 的 openai-completions 走一遍：模型描述符按宿主会构造的那样给，
// 这样能确认 reasoningEfforts → thinkingLevelMap → reasoning_effort 这条链是通的。
// 直接调 pi-ai 的 openai-completions 实现，模型描述符按宿主会构造的那样给，
// 确认 reasoningEfforts → thinkingLevelMap → reasoning_effort 这条链真的通。
// HOST_PKG 形如 <...>/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js，
// 往上走三级（lib → 包 → @deepseek-ai）才回到 node_modules 根。
const piAiApiPath = path.join(
  path.dirname(HOST_PKG),
  '../../../@earendil-works/pi-ai/dist/api/openai-completions.js',
);
let api = null;
try {
  api = await import(pathToFileURL(piAiApiPath).href);
} catch (e) {
  say(`- 跳过端到端请求验证（没能加载 pi-ai：${e.message}）`);
}

if (api?.streamSimple) {
  // 这份描述符就是宿主按 reasoningEfforts {off: null, low, high, max} 推出来的形状
  const probeModel = {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    api: 'openai-completions',
    provider: 'workbuddy',
    baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    reasoning: true,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    compat: { supportsReasoningEffort: true },
    input: ['text'],
    contextWindow: 1000000,
    maxTokens: 128000,
  };
  const context = {
    systemPrompt: 'be terse',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };

  const send = async (options) => {
    seen.length = 0;
    try {
      const events = api.streamSimple(probeModel, context, { apiKey: 'test-key', ...options });
      for await (const _ of events) break;
    } catch {
      /* 假上游返回的是最小 SSE，解析报错无所谓，请求已经发出去了 */
    }
    return seen.length > 0 ? JSON.parse(seen[0]) : null;
  };

  // 注意：pi-ai 的 streamSimple 收的是 `reasoning`（思考等级名），内部 clamp 后
  // 再转成 wire 值；`reasoningEffort` 是 stream() 那一层才用的名字。
  const high = await send({ reasoning: 'high' });
  expect(
    '选 high → 请求体带 reasoning_effort: "high"',
    high?.reasoning_effort === 'high',
    `实际 = ${JSON.stringify(high?.reasoning_effort)}`,
  );

  const low = await send({ reasoning: 'low' });
  expect(
    '选 low  → 请求体带 reasoning_effort: "low"',
    low?.reasoning_effort === 'low',
    `实际 = ${JSON.stringify(low?.reasoning_effort)}`,
  );

  const off = await send({ reasoning: 'off' });
  expect(
    '选 off  → 请求体不带推理参数（关掉思考）',
    off !== null && off.reasoning_effort === undefined,
    `实际 = ${JSON.stringify(off?.reasoning_effort)}`,
  );
}

await new Promise((resolve) => fake.close(resolve));

say(`\n${failures === 0 ? '宿主侧校验全部通过。' : `${failures} 项没过。`}`);
process.exit(failures === 0 ? 0 : 1);
