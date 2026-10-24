/**
 * verify-config.mjs —— 只校验配置，不连上游
 *
 *   node tools/verify-config.mjs [--profile desktop]
 *
 * 检查三处密钥（provider 的 headers、DSH 凭据库、插件自身条目）与密钥文件是一致
 * 的，顺带确认 cordis.patch.yml 与 .credentials.yaml 都还是合法 YAML、provider
 * 没有因为重复安装变成两份。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { readSecretState, secretPath } from '../lib/local-secret.mjs';

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROFILE = read('--profile', 'desktop');
const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');

let yaml = null;
try {
  const req = createRequire(path.join(DSH_HOME, 'profiles', PROFILE, 'noop.js'));
  yaml = req('js-yaml');
} catch {
  try {
    const req = createRequire(import.meta.url);
    yaml = req('js-yaml');
  } catch {
    yaml = null;
  }
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const CRED_REF = 'WORKBUDDY_API_KEY';
const patchFile = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
const credFile = path.join(DSH_HOME, '.credentials.yaml');

const state = readSecretState(DSH_HOME);
check('本机密钥文件', !!state, state ? secretPath(DSH_HOME) : `${secretPath(DSH_HOME)} 不存在`);
if (!state) process.exit(1);

const patchText = fs.readFileSync(patchFile, 'utf8');
const dup = (patchText.match(/^ {6}workbuddy:$/gm) || []).length;
check('provider 没有重复', dup === 1, `出现 ${dup} 次`);

if (!yaml) {
  console.log('\njs-yaml 不可用，跳过结构解析（文本级检查已完成）。');
  process.exit(failures === 0 ? 0 : 1);
}

const patch = yaml.load(patchText);
const provider = patch.find((e) => e.id === 'llm-pi-ai')?.config?.providers?.workbuddy;
check('llm-pi-ai 里有 workbuddy provider', !!provider);
if (provider) {
  check('api 协议', provider.api === 'openai-completions', provider.api);
  check('baseURL', typeof provider.baseURL === 'string' && provider.baseURL.startsWith('http://127.0.0.1:'), provider.baseURL ? '回环地址' : '缺失');
  check('apiKeyEnv', provider.apiKeyEnv === CRED_REF, provider.apiKeyEnv || '缺失');
  const bearer = (provider.headers?.Authorization || '').replace(/^Bearer\s+/, '');
  check('headers.Authorization 与密钥一致', bearer === state.apiKey, bearer ? '对得上' : '缺失或不一致');
  check('模型清单', Array.isArray(provider.models) && provider.models.length > 0, `${provider.models?.length ?? 0} 个`);
}

const self = patch.find((e) => e.id === 'workbuddy-bridge');
check('插件自身条目', !!self);
if (self) check('插件 apiKey 与密钥一致', self.config?.apiKey === state.apiKey, self.config?.apiKey ? '对得上' : '缺失或不一致');

const cred = yaml.load(fs.readFileSync(credFile, 'utf8'));
check(`${CRED_REF} 与密钥一致`, cred?.refs?.[CRED_REF] === state.apiKey, cred?.refs?.[CRED_REF] ? '对得上' : '缺失或不一致');

console.log(`\n${failures === 0 ? '配置检查全部通过。' : `${failures} 项没过。`}`);
process.exit(failures === 0 ? 0 : 1);
