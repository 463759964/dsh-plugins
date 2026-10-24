/**
 * install.mjs —— 顶层安装入口（转发到 tools/install.mjs）。
 *
 * 仓库约定每个插件都能 `node install.mjs` 直接装，实际逻辑在 tools/ 下，
 * 这里只做转发，免得两份实现漂移。
 *
 *   node install.mjs [--profile desktop] [--port 8792] [--set-default <model>]
 *                    [--dsh-home <dir>] [--rotate-key] [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'tools', 'install.mjs');

const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: here,
});

process.exit(r.status ?? 1);
