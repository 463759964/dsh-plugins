/**
 * daily.mjs —— 每日一次：刷新积分快照 → 推送 QQ
 *
 *   node daily.mjs          刷新 + 推送
 *   node daily.mjs --dry    只刷新并打印，不推送
 *
 * 线上看板的更新（重新发布）由自动化里的 workbuddy_sites_deploy 完成，
 * 本脚本只负责数据。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (f, args = []) => execFileSync(process.execPath, [path.join(HERE, f), ...args], { stdio: 'inherit', cwd: HERE });

run('build.mjs');
run('push.mjs', process.argv.slice(2));
