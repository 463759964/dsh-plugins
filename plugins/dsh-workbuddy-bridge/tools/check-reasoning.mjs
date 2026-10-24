/**
 * check-reasoning.mjs —— 检查 DSH provider 配置里的思考等级声明。
 *
 * 回答两个问题：
 *   1. 哪些模型声明了 `reasoningEfforts`，DSH 会给它们显示「思考等级」下拉框？
 *   2. 这些声明会不会被 DSH 的 schema 拒掉（空 dict、缺 wire 值、只有 off）？
 *
 * 判定规则抄自宿主 `@deepseek-ai/dsh-llm-pi-ai` 的 `resolveModelReasoning()`：
 *   - 空 dict                    → 拒绝整段 provider 配置
 *   - 除 off 外的等级缺 wire 值  → 拒绝
 *   - 只声明了 off               → 拒绝（等于没有思考等级可挑）
 *   - 合法的 value 是字符串或 null，且只有 off 允许 null
 *
 * 用法：node tools/check-reasoning.mjs [--profile desktop]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');
const PROFILE = read('--profile', 'desktop');
const patchPath = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');

/** 宿主认得的思考等级；上游 WorkBuddy 的 supportedEfforts 是它的子集。 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const say = (s) => process.stdout.write(s + '\n');

let yaml;
try {
  const require = createRequire(path.join(DSH_HOME, 'profiles', PROFILE, 'noop.cjs'));
  yaml = require('js-yaml');
} catch {
  say('✗ 读不了 js-yaml（profile 的 node_modules 里应该有）');
  process.exit(1);
}

if (!fs.existsSync(patchPath)) {
  say(`✗ 找不到 ${patchPath}`);
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(patchPath, 'utf8'));
const entry = (Array.isArray(doc) ? doc : []).find((x) => x && x.id === 'llm-pi-ai');
if (!entry) {
  say('✗ 配置里没有 llm-pi-ai 条目');
  process.exit(1);
}

const provider = entry?.config?.providers?.workbuddy;
if (!provider) {
  say('✗ llm-pi-ai 里没有 workbuddy provider —— 先跑 node tools/install.mjs');
  process.exit(1);
}

const models = Array.isArray(provider.models) ? provider.models : [];
say(`provider「${provider.displayName}」共 ${models.length} 个模型\n`);

const declared = models.filter((m) => m && m.reasoningEfforts !== undefined);
const problems = [];

say(`声明了思考等级：${declared.length} 个\n`);
for (const m of declared) {
  const e = m.reasoningEfforts;

  if (e === false) {
    say(`  ${m.id.padEnd(22)} false（显式声明为不可调）`);
    continue;
  }
  if (e === null || typeof e !== 'object') {
    problems.push(`${m.id}: reasoningEfforts 既不是 false 也不是对象`);
    continue;
  }

  const keys = Object.keys(e);
  const levels = [];
  for (const [level, wire] of Object.entries(e)) {
    if (!PI_THINKING_LEVELS.includes(level)) {
      problems.push(`${m.id}: 等级 "${level}" 不在 DSH 认得的集合里`);
    } else if (wire === null || wire === undefined) {
      if (level !== 'off') problems.push(`${m.id}: 等级 "${level}" 缺 wire 值（只有 off 可以留空）`);
    } else if (typeof wire !== 'string' || wire.length === 0) {
      problems.push(`${m.id}: 等级 "${level}" 的 wire 值必须是非空字符串`);
    }
    levels.push(level);
  }
  if (keys.length === 0) problems.push(`${m.id}: reasoningEfforts 是空 dict，DSH 会拒绝整段配置`);
  if (!levels.some((l) => l !== 'off')) {
    problems.push(`${m.id}: 除 off 外没有可挑的等级`);
  }

  const picker = PI_THINKING_LEVELS.filter((level) => {
    const wire = e[level];
    if (wire === null || wire === undefined) return level === 'off' && 'off' in e;
    return true;
  });
  say(`  ${m.id.padEnd(22)} 可选：${picker.join(', ')}${'off' in e ? '（含关闭思考）' : ''}`);
}

say('');
if (problems.length === 0) {
  say(`全部合法。重启 DSH 后，这 ${declared.length} 个模型会带「思考等级」下拉框。`);
} else {
  say(`${problems.length} 处有问题：`);
  for (const p of problems) say(`  ✗ ${p}`);
}

process.exit(problems.length === 0 ? 0 : 1);
