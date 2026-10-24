/**
 * uninstall.mjs —— 顶层卸载入口（转发到 tools/install.mjs --remove）。
 *
 * 卸载会：摘掉 profile 里 workbuddy-bridge 这个 insert、清掉 llm-pi-ai 的
 * workbuddy provider 与凭据库里的记录、删掉 node_modules 里的包链接。
 * 桥接密钥文件与积分账本保留（账本是你自己的用量记录，不该跟着卸载没）。
 *
 *   node uninstall.mjs [--profile desktop] [--dsh-home <dir>]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'tools', 'install.mjs');

const forwarded = process.argv.slice(2);
if (!forwarded.includes('--remove')) forwarded.push('--remove');

const r = spawnSync(process.execPath, [target, ...forwarded], {
  stdio: 'inherit',
  cwd: here,
});

process.exit(r.status ?? 1);
