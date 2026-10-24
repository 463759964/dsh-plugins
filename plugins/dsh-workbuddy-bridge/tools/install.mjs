/**
 * install.mjs —— 把插件装进某个 DSH profile
 *
 *   node tools/install.mjs [--profile desktop] [--port 8792] [--api-key xxx]
 *
 * 它做四件事，每件事之前都会先备份：
 *   1) profile/package.json  ——  加 file: 依赖 + 加进 dsh.profile.bundles
 *   2) profile/cordis.patch.yml —— 把 workbuddy provider 合进 llm-pi-ai 的 providers
 *   3) profile/node_modules  ——  软链（Windows 上退化为拷贝）过去，让宿主能 require 到
 *   4) 改前改后各留一份 .bak，随时能回滚
 *
 * 改 cordis.patch.yml 走的是文本级合并：这个文件里通常满是注释，用 YAML 序列化
 * 重写一遍会把用户的批注冲掉，所以只动该动的那几行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { TokenVault } from '../lib/workbuddy-token.mjs';
import { UpstreamClient } from '../lib/upstream.mjs';
import { ensureSecret, secretPath } from '../lib/local-secret.mjs';

/** DSH 凭据库里的引用名。Models 页的推导规则是 <PROVIDER>_API_KEY。 */
const CRED_REF = 'WORKBUDDY_API_KEY';

/**
 * pi-ai 认得的思考等级，顺序即强度递增。DSH 只接受这几个 key，
 * 上游 WorkBuddy 回的 `supportedEfforts` 是它的子集。
 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback;
};

const PROFILE_NAME = read('--profile', 'desktop');
const PORT = Number(read('--port', '8792'));
const API_KEY = read('--api-key', '');
const SET_DEFAULT = read('--set-default', '');
const REMOVE = argv.includes('--remove');
const ROTATE_KEY = argv.includes('--rotate-key');
const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE_NAME);

const say = (s = '') => console.log(s);
let failures = 0;
const check = (label, ok, detail = '') => {
  say(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
};

say(`dsh-workbuddy-bridge 安装到 profile「${PROFILE_NAME}」\n`);

/* ------------------ 0. 前置：目录、登录态、模型清单、端口 ------------------ */

if (!fs.existsSync(PROFILE_DIR)) {
  check('profile 目录', false, `${PROFILE_DIR} 不存在`);
  say('\n先确认 DSH 至少启动过一次，或者用 --profile <名字> 指定对的 profile。');
  process.exit(1);
}
check('profile 目录', true, PROFILE_DIR);

/* ------------------ 卸载 ------------------ */

if (REMOVE) {
  const pkgP = path.join(PROFILE_DIR, 'package.json');
  const patchP = path.join(PROFILE_DIR, 'cordis.patch.yml');
  const linkP = path.join(PROFILE_DIR, 'node_modules', 'dsh-workbuddy-bridge');

  if (fs.existsSync(pkgP)) {
    const p = JSON.parse(fs.readFileSync(pkgP, 'utf8'));
    if (p.dependencies) delete p.dependencies['dsh-workbuddy-bridge'];
    if (p.dsh?.profile?.bundles) {
      p.dsh.profile.bundles = p.dsh.profile.bundles.filter((b) => b !== 'dsh-workbuddy-bridge');
    }
    backup(pkgP);
    fs.writeFileSync(pkgP, JSON.stringify(p, null, 2) + '\n', 'utf8');
    check('package.json 清干净', true);
  }
  if (fs.existsSync(patchP)) {
    const out = removeProvider(fs.readFileSync(patchP, 'utf8'));
    if (out.removed) {
      backup(patchP);
      fs.writeFileSync(patchP, out.text, 'utf8');
      check('cordis.patch.yml 清干净', true);
    } else {
      check('cordis.patch.yml 清干净', false, '没找到 workbuddy provider，可能本来就没装');
    }
  }
  try {
    removePackageDir(linkP);
    check('node_modules 清干净', true);
  } catch {
    check('node_modules 清干净', false, '没有可删的（可能本来就没装）');
  }
  // 本机密钥是自己的东西，卸载时一并收走，免得留个孤儿状态文件
  const secretFile = secretPath(DSH_HOME);
  if (fs.existsSync(secretFile)) {
    backup(secretFile);
    fs.rmSync(secretFile, { force: true });
    check('本机密钥已清除', true);
  }
  const credFile = path.join(DSH_HOME, '.credentials.yaml');
  if (fs.existsSync(credFile)) {
    const r = removeCredentialRef(fs.readFileSync(credFile, 'utf8'), CRED_REF);
    if (r.removed) {
      backup(credFile);
      fs.writeFileSync(credFile, r.text, 'utf8');
      check('DSH 凭据已清除', true, CRED_REF);
    }
  }

  say('\n卸载完了，重启 DSH 生效。');
  process.exit(0);
}

let models = [];
try {
  const vault = new TokenVault({});
  const upstream = new UpstreamClient({ vault });
  models = await upstream.listModels();
  const who = vault.listPublic().map((a) => a.name).join('、');
  check('WorkBuddy 登录态', true, `${who} · ${models.length} 个可用模型`);
} catch (e) {
  check('WorkBuddy 登录态', false, e.message);
  say('\n先在 WorkBuddy 客户端里登录，再回来跑安装。');
  process.exit(1);
}

// 端口上要是已经是本桥在跑，那不是障碍，直接接管它
const running = await probeBridge(PORT);
if (running) {
  check(`端口 ${PORT}`, true, '已有桥接在跑，直接接管它');
} else {
  const portFree = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(PORT, '127.0.0.1');
  });
  if (!portFree) {
    check(`端口 ${PORT} 空闲`, false, '被别的进程占着');
    say(`\n换个端口再装，例如：node tools/install.mjs --port 8793`);
    process.exit(1);
  }
  check(`端口 ${PORT} 空闲`, true);
}

/* ------------------ 0.5 本机密钥 ------------------ */

// DSH 的 llm-pi-ai 在发请求前会断言 provider 必须有密钥，缺了就直接
// `No API key for provider: workbuddy`。所以这把钥匙必须给——给的是本机
// 随机串，真正的 WorkBuddy 令牌始终不出桥。
const SECRET = API_KEY || ensureSecret({ dshHome: DSH_HOME, rotate: ROTATE_KEY });
check(
  '本机桥接密钥',
  true,
  API_KEY
    ? '用 --api-key 指定的'
    : `${SECRET.created ? '新生成' : '复用已有的'} · ${SECRET.file}`,
);

/* ------------------ 1. package.json ------------------ */

const pkgPath = path.join(PROFILE_DIR, 'package.json');
const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
let pkg;
try {
  pkg = JSON.parse(pkgRaw);
} catch (e) {
  check('读取 package.json', false, e.message);
  process.exit(1);
}

const depSpec = `file:${PACKAGE_ROOT.replace(/\\/g, '/')}`;
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-workbuddy-bridge'] = depSpec;

pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes('dsh-workbuddy-bridge')) bundles.push('dsh-workbuddy-bridge');
pkg.dsh.profile.bundles = bundles;

backup(pkgPath);
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
check('package.json', true, `依赖 ${depSpec} · bundles 共 ${bundles.length} 个`);

/* ------------------ 2. cordis.patch.yml ------------------ */

const patchPath = path.join(PROFILE_DIR, 'cordis.patch.yml');
if (!fs.existsSync(patchPath)) {
  check('cordis.patch.yml', false, '文件不存在');
  process.exit(1);
}
const patchRaw = fs.readFileSync(patchPath, 'utf8');
const merged = mergeProvider(patchRaw, {
  providerId: 'workbuddy',
  displayName: 'WorkBuddy 账号',
  baseURL: `http://127.0.0.1:${PORT}/v1`,
  apiKey: SECRET.apiKey,
  apiKeyEnv: CRED_REF,
  models,
});
// 已有一份就先摘掉再写，保证重复跑安装不会留下两个 workbuddy 键
const refreshNote = merged.refreshed ? '刷新 workbuddy provider' : merged.note;
if (!merged) {
  check('合并 llm-pi-ai', false, '没能在文件里定位到 llm-pi-ai 条目');
  process.exit(1);
}
let patchText = merged.text;

if (SET_DEFAULT) {
  const known = models.find((m) => m.id === SET_DEFAULT);
  if (!known) {
    say(`\n--set-default 给的 ${SET_DEFAULT} 不在账号的模型清单里。可用：${models.map((m) => m.id).join(' ')}`);
    process.exit(1);
  }
  const r = upsertConfigKeys(
    patchText,
    'agent-default-model',
    [
      ['provider', 'workbuddy'],
      ['model', yamlStr(SET_DEFAULT)],
    ],
    '@deepseek-ai/dsh-agent-default-model',
  );
  patchText = r.text;
  say(`✓ 默认模型 — ${SET_DEFAULT}（${r.note}）`);
}

// 插件自己的条目也要带上同一把钥匙：桥接读它就知道该验谁
const self = upsertConfigKeys(
  patchText,
  'workbuddy-bridge',
  [
    ['host', '127.0.0.1'],
    ['port', String(PORT)],
    ['apiKey', yamlStr(SECRET.apiKey)],
  ],
  'dsh-workbuddy-bridge',
);
patchText = self.text;

backup(patchPath);
fs.writeFileSync(patchPath, patchText, 'utf8');
check('cordis.patch.yml', true, refreshNote);

/* ------------------ 2.5 DSH 凭据库 ------------------ */

// 备用路径：有些版本从 credentials 服务取密钥而不是读 headers。
// 两条都铺上，DSH 走哪条都能通。
const credPath = path.join(DSH_HOME, '.credentials.yaml');
if (fs.existsSync(credPath)) {
  const raw = fs.readFileSync(credPath, 'utf8');
  const seeded = upsertCredentialRef(raw, CRED_REF, SECRET.apiKey);
  if (seeded.changed) {
    backup(credPath);
    fs.writeFileSync(credPath, seeded.text, 'utf8');
  }
  check('DSH 凭据库', true, `${CRED_REF}（${seeded.note}）`);
} else {
  check('DSH 凭据库', false, '没找到 .credentials.yaml，跳过（headers 路径仍可用）');
}

/* ------------------ 3. node_modules ------------------ */

const linkDir = path.join(PROFILE_DIR, 'node_modules', 'dsh-workbuddy-bridge');
fs.mkdirSync(path.dirname(linkDir), { recursive: true });
let linkNote = '';
try {
  if (fs.existsSync(linkDir)) removePackageDir(linkDir);
} catch {
  /* 删不掉下面会直接失败，交给下一步处理 */
}
try {
  fs.symlinkSync(PACKAGE_ROOT, linkDir, 'junction');
  linkNote = '已软链（改动即时生效）';
} catch {
  fs.cpSync(PACKAGE_ROOT, linkDir, { recursive: true, filter: skipNoise });
  linkNote = '软链建不起来，改为拷贝（改代码后需重跑安装）';
}
check('node_modules 就位', fs.existsSync(path.join(linkDir, 'lib', 'index.js')), linkNote);

/* ------------------ 4. 收尾 ------------------ */

say('');
if (failures === 0) {
  say('装好了。接下来说人话版：');
  say(`  1. 完全退出 DSH，再重新打开（新 bundle 要重启才挂载）。`);
  say(`  2. 设置 → 模型里就能看到 provider「WorkBuddy 账号」，下面挂着 ${models.length} 个模型。`);
  say(`     密钥已经塞进去了，不需要再手动填 API Key。`);
  say(`  3. 想换成别的端口：node tools/install.mjs --port <端口>`);
  say(`  4. 想体检：node tools/doctor.mjs --port ${PORT}`);
  say(`  5. 想换一把钥匙：node tools/install.mjs --rotate-key（换完要重启 DSH）`);
  say(`  6. 改坏了：把 .bak 文件改名回去即可，备份就在 ${PROFILE_DIR}`);
} else {
  say(`${failures} 步没走通，看上面的 ✗。`);
}
process.exit(failures === 0 ? 0 : 1);

/* ================================ 工具 ================================ */

function skipNoise(src) {
  const base = path.basename(src);
  return base !== 'node_modules' && base !== '.git';
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

/**
 * 删掉 profile 里的包目录。
 *
 * 要紧的是：这个位置可能是 Windows 的 junction（目录重解析点），而 junction 在
 * lstat 下看起来就是个普通目录，`isSymbolicLink()` 认不出它——直接
 * `rmSync({recursive:true})` 有可能顺着链接把源工程的内容一起删掉。
 * 所以先试 readlink：读得出目标就说明是链接，用 rmdir 只摘掉链接本身，
 * 目标目录里一个文件都不动。
 */
function removePackageDir(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }
  try {
    if (fs.readlinkSync(p)) {
      fs.rmdirSync(p);
      return;
    }
  } catch {
    /* 读不出目标 = 真目录，交给下面的递归删 */
  }
  fs.rmSync(p, { recursive: true, force: true });
}

function yamlStr(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * 把 workbuddy provider 合进 llm-pi-ai 条目。
 * 返回 {text, note}，定位不到就返回 null。
 */
/**
 * 先摘掉已有的 workbuddy 块，再写新的。
 * 这样装第二次就是「刷新模型清单」，不会留下两个同名键把 YAML 搞崩。
 */
function mergeProvider(text, opts) {
  const cleaned = removeProvider(text);
  const r = mergeProviderInto(cleaned.text, opts);
  return { ...r, refreshed: cleaned.removed };
}

function mergeProviderInto(text, { providerId, displayName, baseURL, apiKey, apiKeyEnv, models }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entryStart = lines.findIndex((l) => /^-\s+id:\s*llm-pi-ai\s*$/.test(l));

  const block = providerLines({ providerId, displayName, baseURL, apiKey, apiKeyEnv, models });

  if (entryStart === -1) {
    // 这个文件里还没有 llm-pi-ai 条目，直接在末尾补一条
    const entry = [
      '- id: llm-pi-ai',
      `  name: ${yamlStr('@deepseek-ai/dsh-llm-pi-ai')}`,
      '  config:',
      '    providers:',
      ...block,
      '',
    ];
    return { text: joinLines([...lines, ...entry], eol), note: '新建 llm-pi-ai 条目' };
  }

  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^-\s+id:/.test(lines[i])) {
      entryEnd = i;
      break;
    }
  }

  const configIdx = lines.findIndex((l, i) => i > entryStart && i < entryEnd && /^\s{2}config:\s*$/.test(l));
  if (configIdx === -1) {
    const entry = ['  config:', '    providers:', ...block];
    return splice(lines, entryEnd, entryEnd, entry, '在 llm-pi-ai 下补了 config.providers', eol);
  }

  const provIdx = lines.findIndex((l, i) => i > configIdx && i < entryEnd && /^\s{4}providers:\s*(.*)$/.test(l));
  if (provIdx === -1) {
    // config 里还没有 providers，插到 config 块的末尾
    let configEnd = entryEnd;
    for (let i = configIdx + 1; i < entryEnd; i += 1) {
      if (/^\s{2}\S/.test(lines[i])) {
        configEnd = i;
        break;
      }
    }
    const insert = ['    providers:', ...block];
    return splice(lines, configEnd, configEnd, insert, '在 config 下补了 providers', eol);
  }

  const provLine = lines[provIdx];
  const isEmptyMap = /^\s{4}providers:\s*\{\s*\}\s*$/.test(provLine);
  const isEmptyKey = /^\s{4}providers:\s*$/.test(provLine);
  const nextLine = lines[provIdx + 1] || '';
  const hasChildren = !isEmptyMap && /^\s{6}\S/.test(nextLine);

  if (isEmptyMap || isEmptyKey) {
    if (isEmptyMap || !hasChildren) {
      return splice(lines, provIdx, provIdx + 1, ['    providers:', ...block], '写入 workbuddy provider', eol);
    }
    return splice(lines, provIdx + 1, provIdx + 1, block, '把 workbuddy provider 插到最前', eol);
  }
  // 行内还有别的内容，不猜了，插在它后面另起炉灶
  return splice(lines, provIdx + 1, provIdx + 1, block, '把 workbuddy provider 插到最前', eol);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** 探一下某个端口上是不是本桥的 /health。 */
async function probeBridge(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j && j.service === 'dsh-workbuddy-bridge' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在 .credentials.yaml 的 refs 段里补一个引用。
 *
 * 同样是文本级合并：这个文件里还存着 DSH 自己的账号凭据，用 YAML 重写一遍
 * 风险太大，只动该动的那一行。
 */
function upsertCredentialRef(text, ref, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));

  if (refsIdx === -1) {
    return {
      text: joinLines([...lines, 'refs:', `  ${ref}: ${yamlStr(value)}`], eol),
      note: '补了 refs 段',
      changed: true,
    };
  }

  let refsEnd = lines.length;
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) {
      refsEnd = i;
      break;
    }
  }

  const line = `  ${ref}: ${yamlStr(value)}`;
  const re = new RegExp(`^\\s{2}${escapeRe(ref)}:`);
  for (let i = refsIdx + 1; i < refsEnd; i += 1) {
    if (!re.test(lines[i])) continue;
    if (lines[i] === line) return { text, note: '已经是这个值', changed: false };
    const next = [...lines];
    next[i] = line;
    return { text: joinLines(next, eol), note: '更新了', changed: true };
  }

  const next = [...lines.slice(0, refsEnd), line, ...lines.slice(refsEnd)];
  return { text: joinLines(next, eol), note: '写入了', changed: true };
}

/** 从 .credentials.yaml 的 refs 段里摘掉一个引用。 */
function removeCredentialRef(text, ref) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s{2}${escapeRe(ref)}:`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return { text, removed: false };
  const next = [...lines.slice(0, start), ...lines.slice(start + 1)];
  return { text: joinLines(next, eol), removed: true };
}

/**
 * 在某个 patch 条目的 config 里改（或补）几个键。
 * 找不到条目就新建一条；找不到键就追加到 config 块末尾。
 */
function upsertConfigKeys(text, entryId, pairs, nameFallback) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entryRe = new RegExp(`^-\\s+id:\\s*${escapeRe(entryId)}\\s*$`);
  const entryStart = lines.findIndex((l) => entryRe.test(l));

  if (entryStart === -1) {
    const entry = [`- id: ${entryId}`];
    if (nameFallback) entry.push(`  name: ${yamlStr(nameFallback)}`);
    entry.push('  config:');
    for (const [k, v] of pairs) entry.push(`    ${k}: ${v}`);
    entry.push('');
    return { text: joinLines([...lines, ...entry], eol), note: `新建 ${entryId} 条目` };
  }

  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^-\s+id:/.test(lines[i])) {
      entryEnd = i;
      break;
    }
  }

  let configIdx = -1;
  for (let i = entryStart + 1; i < entryEnd; i += 1) {
    if (/^\s{2}config:\s*$/.test(lines[i])) {
      configIdx = i;
      break;
    }
  }
  let configEnd = entryEnd;
  if (configIdx !== -1) {
    for (let i = configIdx + 1; i < entryEnd; i += 1) {
      if (/^\s{2}\S/.test(lines[i])) {
        configEnd = i;
        break;
      }
    }
  }

  const before = configIdx === -1 ? [...lines.slice(0, entryEnd), '  config:'] : lines.slice(0, configIdx + 1);
  const after = lines.slice(configEnd);
  const middle = configIdx === -1 ? [] : lines.slice(configIdx + 1, configEnd);

  const out = [];
  const handled = new Set();
  for (const line of middle) {
    const m = line.match(/^\s{4}([A-Za-z0-9_-]+):/);
    const key = m ? m[1] : null;
    const hit = key ? pairs.find(([k]) => k === key) : null;
    if (hit) {
      out.push(`    ${key}: ${hit[1]}`);
      handled.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of pairs) if (!handled.has(k)) out.push(`    ${k}: ${v}`);

  return {
    text: joinLines([...before, ...out, ...after], eol),
    note: `改了 ${handled.size} 项，补了 ${pairs.length - handled.size} 项`,
  };
}

/** 把 workbuddy provider 整块摘掉；摘完 providers 空了就写回 {}。 */
function removeProvider(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{6}workbuddy:\s*$/.test(l));
  if (start === -1) return { text, removed: false };

  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') break;
    if (/^\s{0,5}\S/.test(l)) break;
    if (/^\s{6}\S/.test(l)) break;
    end += 1;
  }

  const next = [...lines.slice(0, start), ...lines.slice(end)];
  let provIdx = -1;
  for (let i = start - 1; i >= 0; i -= 1) {
    if (/^\s{4}providers:/.test(lines[i])) {
      provIdx = i;
      break;
    }
  }
  if (provIdx !== -1) {
    const after = next[provIdx + 1] || '';
    if (after.trim() === '' || /^\s{0,4}\S/.test(after)) next[provIdx] = '    providers: {}';
  }
  return { text: joinLines(next, eol), removed: true };
}

function providerLines({ providerId, displayName, baseURL, apiKey, apiKeyEnv, models }) {
  const out = [
    `      ${providerId}:`,
    `        displayName: ${yamlStr(displayName)}`,
    `        api: openai-completions`,
    `        baseURL: ${yamlStr(baseURL)}`,
  ];
  // 密钥给两条路：
  //   headers  —— 直接把 Authorization 塞进 pi-ai 的请求头，它验的就是这个；
  //   apiKeyEnv —— 告诉 DSH 去凭据库取同名的钥匙，走 credentials 服务那条路。
  // 这个 provider 配置里没有 apiKey 字段（schema 只收 apiKeyEnv），写进去会被拒。
  if (apiKeyEnv) out.push(`        apiKeyEnv: ${apiKeyEnv}`);
  if (apiKey) {
    out.push('        headers:');
    out.push(`          Authorization: ${yamlStr(`Bearer ${apiKey}`)}`);
  }
  out.push('        models:');
  for (const m of models) {
    out.push(`          - id: ${yamlStr(m.id)}`);
    out.push(`            name: ${yamlStr(m.name)}`);
    if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
      out.push(`            contextWindow: ${m.contextWindow}`);
    }
    if (Number.isFinite(m.maxTokens) && m.maxTokens > 0) {
      out.push(`            maxTokens: ${m.maxTokens}`);
    }
    if (m.supportsImages) {
      out.push('            input: [text, image]');
    }
    out.push(...reasoningLines(m));
  }
  return out;
}

/**
 * 把一个模型的推理能力写成 DSH 的 `reasoningEfforts` 块。
 *
 * 为什么必须写：DSH 只有在模型描述符的 `reasoning` 为真时才把「思考等级」选项
 * 交给 UI（`if (!model.reasoning) return {}`），而手工声明的模型不写这个字段时
 * `reasoning` 恒为 false —— 于是下拉框根本不出现。
 *
 * 两条硬规则（写错会让 DSH 拒绝整段 provider 配置）：
 *   - 空 dict 会被拒，所以一个等级都拿不出来就整块不写；
 *   - 除 `off` 外的等级必须给 wire 值；`off` 可以留空，表示「发请求时不带推理参数」。
 *
 * 未声明的等级由 DSH 自动 pin 成 `null`（不支持），所以这里只写上游真支持的。
 */
function reasoningLines(m) {
  const efforts = (Array.isArray(m.supportedEfforts) ? m.supportedEfforts : [])
    .map((e) => String(e))
    .filter((e) => PI_THINKING_LEVELS.includes(e) && e !== 'off');
  // 上游没给等级清单的模型（多数是固定思考行为的）就不声明，让它保持「不可调」
  if (efforts.length === 0) return [];

  const out = ['            reasoningEfforts:'];
  // 只有允许关闭思考的模型才给 off：留空值 = pi-ai 发不带推理参数的请求，即真正关掉思考。
  // 不支持关闭的模型不写 off，它会被 pin 成不支持，也就不会出现在选项里。
  if (m.canDisableThinking) out.push('              off:');
  for (const level of efforts) out.push(`              ${level}: ${level}`);
  return out;
}

function splice(lines, start, end, insert, note, eol) {
  const next = [...lines.slice(0, start), ...insert, ...lines.slice(end)];
  return { text: joinLines(next, eol), note };
}

function joinLines(lines, eol) {
  return lines.join(eol);
}
