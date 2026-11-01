/**
 * dump-token.mjs —— 在一台机器上导出某个 WorkBuddy 账号的登录凭证，供另一台机器查积分
 *
 *   node dump-token.mjs                 导出本机当前账号 → account-token.json
 *   node dump-token.mjs --list          只列账号，不导出
 *   node dump-token.mjs --uid <uid|名称>  多账号时指定一个
 *   node dump-token.mjs --out D:\x.json  指定输出路径
 *
 * 得到的 JSON 交给另一台机器：
 *   node credits-account.mjs --token-file D:\x.json
 *
 * 注意：文件里是可直接登录该账号的凭证（access 约 30 天、refresh 约 60 天），
 * 只在自己可信的机器之间传，用完删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { libUrl } from './_lib.mjs';

const LIB = libUrl();
const { TokenVault } = await import(LIB + 'workbuddy-token.mjs');

const ARGV = process.argv.slice(2);
const argOf = (n) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : null; };

const vault = new TokenVault({});
const all = vault.load();
if (!all.length) { console.error('本机没有可用的 WorkBuddy 登录账号。'); process.exit(1); }

const wantUid = argOf('--uid');
if (wantUid) vault.select(wantUid);
const acc = vault.current();

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—');

if (ARGV.includes('--list')) {
  for (const a of all) {
    console.log(`${a.uid === acc.uid ? '*' : ' '} ${a.name}  uid=${a.uid}  access到期=${fmt(a.expiresAt)}`);
  }
  process.exit(0);
}

await vault.getAccessToken(); // 必要时先续期
const out = {
  name: acc.name,
  uid: acc.uid,
  accessToken: acc.accessToken,
  refreshToken: acc.refreshToken,
  expiresAt: acc.expiresAt,
  refreshExpiresAt: acc.refreshExpiresAt,
  exportedAt: new Date().toISOString(),
};

const dest = path.resolve(argOf('--out') || 'account-token.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1), { mode: 0o600 });
console.log(`已导出账号「${acc.name}」(uid=${acc.uid})`);
console.log(`  access 到期：${fmt(out.expiresAt)}`);
console.log(`  refresh 到期：${fmt(out.refreshExpiresAt)}`);
console.log(`  文件：${dest}`);
console.log('把这个文件带到要查询的机器，跑：node credits-account.mjs --token-file <文件>');
