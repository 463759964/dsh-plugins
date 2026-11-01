/**
 * _lib.mjs —— 定位 dsh-workbuddy-bridge 的 lib 目录
 *
 * 本工具复用该插件的令牌库（workbuddy-token.mjs）与计费接口，所以运行时需要能找到它。
 * 查找顺序：
 *   1. 环境变量 WORKBUDDY_LIB（可直接给目录或 file:// URL）
 *   2. 本仓库内 plugins/dsh-workbuddy-bridge/lib   ← clone 下来即用
 *   3. 与本仓库并列的开发目录 ../dsh-workbuddy-bridge/lib
 *   4. $WORKBUDDY_HOME/dsh-workbuddy-bridge/lib 或 ~/WorkBuddy/dsh-workbuddy-bridge/lib
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function candidates() {
  const list = [];
  if (process.env.WORKBUDDY_LIB) list.push(process.env.WORKBUDDY_LIB);
  list.push(path.resolve(HERE, '../../plugins/dsh-workbuddy-bridge/lib'));
  list.push(path.resolve(HERE, '../../../dsh-workbuddy-bridge/lib'));
  const homes = [process.env.WORKBUDDY_HOME, path.join(process.env.USERPROFILE || process.env.HOME || '', 'WorkBuddy')].filter(Boolean);
  for (const h of homes) list.push(path.join(h, 'dsh-workbuddy-bridge', 'lib'));
  return list;
}

/** 返回带结尾斜杠的 file:// URL，便于直接拼接文件名 */
export function libUrl() {
  for (const c of candidates()) {
    if (c.startsWith('file:')) return c.replace(/\/?$/, '/');
    if (fs.existsSync(path.join(c, 'workbuddy-token.mjs'))) return pathToFileURL(c.replace(/\/?$/, '/')).href;
  }
  throw new Error('找不到 dsh-workbuddy-bridge/lib，请设置环境变量 WORKBUDDY_LIB 指向该目录');
}
