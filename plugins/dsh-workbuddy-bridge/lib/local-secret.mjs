/**
 * local-secret.mjs —— 本机桥接密钥
 *
 * DSH 的 llm-pi-ai 在发请求前会断言「这个 provider 必须有密钥」，没密钥就直接
 * 抛 `No API key for provider: <id>`，请求根本发不出来。所以桥接即使只监听回环，
 * 也必须给 DSH 一个密钥——这正是参考实现里「用 shim 的进程内 secret 作为 apiKey」
 * 的做法：交出去的是本机随机串，真正的 WorkBuddy 令牌始终只在桥内。
 *
 * 密钥存在 $DSH_HOME/.workbuddy-bridge.json。安装器写一次，桥接起来时读同一个文件，
 * 所以「插件内起的桥」和「手动单独跑的桥」用的是同一把钥匙，谁先起来都一样。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const FILE_NAME = '.workbuddy-bridge.json';

/** 密钥状态文件的路径。 */
export function secretPath(dshHome) {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, FILE_NAME);
}

/** 读现有状态；文件坏了或没有就返回 null，绝不抛。 */
export function readSecretState(dshHome) {
  const file = secretPath(dshHome);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 拿到一个可用的密钥：有就复用，没有就生成一份并原子写盘。
 *
 * @param {object}  [opts]
 * @param {string}  [opts.dshHome] - DSH 家目录，默认 ~/.dsh
 * @param {boolean} [opts.rotate]  - 强制换一把新的（换了必须重启 DSH）
 * @returns {{apiKey: string, created: boolean, file: string}}
 */
export function ensureSecret(opts = {}) {
  const file = secretPath(opts.dshHome);
  const existing = readSecretState(opts.dshHome);
  if (existing && !opts.rotate) {
    return { apiKey: existing.apiKey, created: false, file };
  }

  const apiKey = crypto.randomBytes(32).toString('base64url');
  const payload = JSON.stringify({ apiKey, createdAt: new Date().toISOString() }, null, 2) + '\n';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写：先落临时文件再改名，避免 DSH 读到写了一半的 JSON
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标文件被别的进程握着时 rename 会失败，直接覆盖一次
    fs.writeFileSync(file, payload, { mode: 0o600 });
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉不影响 */
    }
  }
  return { apiKey, created: true, file };
}

/** 常量时间比对。长度不同也走一遍比较，别把长度当捷径泄露出去。 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
