/**
 * probe-live.mjs —— 探测「DSH 进程内正在跑的那个桥」的鉴权行为。
 *
 * doctor.mjs 接管外部实例时无法判断它是否校验密钥，这个脚本补上那一刀：
 * 直接对 8792 发四种请求，看它认不认。
 *
 *   node tools/probe-live.mjs [--port 8792]
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readSecretState, secretPath } from '../lib/local-secret.mjs';

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(read('--port', '8792'));
const DSH_HOME = read('--dsh-home', '') || path.join(os.homedir(), '.dsh');

const state = readSecretState(DSH_HOME);
if (!state?.apiKey) {
  process.stdout.write(
    `读不到本机密钥：${secretPath(DSH_HOME)}\n先跑一次 install.mjs。\n`,
  );
  process.exit(1);
}
const KEY = state.apiKey;

/** 用原始 socket 发一个请求，返回状态行。fetch 不允许覆盖 Host，只能这么干。 */
function raw({ host = `127.0.0.1:${PORT}`, auth = '' } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      const lines = [`GET /v1/models HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
      if (auth) lines.push(`Authorization: Bearer ${auth}`);
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
    });
    s.on('end', () => resolve(buf.split('\r\n')[0]));
    s.on('error', (e) => resolve('ERR ' + e.message));
    setTimeout(() => {
      s.destroy();
      resolve('TIMEOUT');
    }, 5000);
  });
}

const say = (s) => process.stdout.write(s + '\n');
say(`探测 127.0.0.1:${PORT}（DSH 进程内的桥）\n`);

const cases = [
  ['正确密钥 + 回环 Host', { auth: KEY }, 200],
  ['无密钥 + 回环 Host', {}, 401],
  ['错误密钥 + 回环 Host', { auth: 'definitely-not-the-key' }, 401],
  ['正确密钥 + 伪造 Host', { auth: KEY, host: 'evil.example.com' }, 401],
];

let bad = 0;
for (const [label, opts, want] of cases) {
  const status = await raw(opts);
  const code = Number((status.match(/ (\d{3}) /) || [])[1] || 0);
  const ok = code === want;
  if (!ok) bad += 1;
  say(`${ok ? '✓' : '✗'} ${label.padEnd(24)} -> ${status.trim()}${ok ? '' : `（期望 ${want}）`}`);
}

say(`\n${bad === 0 ? '鉴权行为符合预期。' : `${bad} 项不符，说明 DSH 里跑的还是旧版桥（重启 DSH 即可）`}`);
process.exit(bad === 0 ? 0 : 1);
