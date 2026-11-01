/**
 * build.mjs —— 拉取【每个账号】的积分快照，写出 outDir/data.json 与 history.json
 *
 *   node build.mjs            刷新全部账号
 *   node build.mjs --no-hist  不写 history.json
 *   node build.mjs --only <id> 只刷某一个账号
 *
 * 账号在 config.json 的 accounts 里配置，二选一：
 *   { "id":"monkey", "label":"monkey", "uid":"<本机登录态里的 uid>" }
 *   { "id":"acct2",  "label":"小号",   "tokenFile":"<dump-token.mjs 导出的 json>" }
 *
 * 数据来源是账号服务端（credits-account.mjs --json），不是本机日志推测值。
 * 脚本与密钥放在 credits-tools/，不进发布目录，避免随静态站点一起上传。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');                     // 工具根目录：config.json / tokens/ / dashboard/
const CONFIG = process.env.CREDITS_CONFIG ? path.resolve(process.env.CREDITS_CONFIG) : path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
/** config.json 里的相对路径一律按工具根目录解析，换机器只需改 config.json */
const resolveFrom = (p) => (p ? path.resolve(ROOT, p) : null);
const OUT = resolveFrom(cfg.outDir) || path.join(ROOT, 'dashboard');
const SCRIPT = process.env.CREDITS_SCRIPT
  ? path.resolve(process.env.CREDITS_SCRIPT)
  : (resolveFrom(cfg.creditsScript) || path.join(HERE, 'credits-account.mjs'));
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

function fetchOne(acct) {
  const args = ['--json'];
  if (acct.tokenFile) args.push('--token-file', resolveFrom(acct.tokenFile));
  else if (acct.uid) args.push('--uid', acct.uid);

  let raw;
  try {
    raw = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      cwd: path.dirname(SCRIPT),
      windowsHide: true,
    });
  } catch (e) {
    const why = String(e.stderr || e.message || '').trim().split('\n').slice(0, 4).join(' ');
    console.error(`  × ${acct.label}：${why || '脚本执行失败'}`);
    return null;
  }
  const s = raw.indexOf('{');
  if (s < 0) { console.error(`  × ${acct.label}：脚本未返回 JSON`); return null; }
  const r = JSON.parse(raw.slice(s));
  delete r.account?.uin;              // UIN 不外发，看板是公开的
  r.id = acct.id;
  r.label = acct.label || r.account?.source || acct.id;
  return r;
}

const targets = (cfg.accounts || []).filter((a) => !only || a.id === only);
if (!targets.length) { console.error('config.json 里没有可刷新的账号。'); process.exit(1); }

const reports = [];
for (const a of targets) {
  process.stdout.write(`→ 拉取 ${a.label} … `);
  const r = fetchOne(a);
  if (r) { reports.push(r); console.log(`余额 ${r.account.balance}`); }
}
if (!reports.length) { console.error('所有账号都拉取失败，保留上一次的 data.json。'); process.exit(1); }

const sum = (f) => reports.reduce((s, r) => s + Number(f(r) || 0), 0);
const r2 = (v) => Math.round(v * 100) / 100;

const data = {
  date: reports[0].date,
  at: reports[0].at,
  accounts: reports,
  totals: {
    balance: r2(sum((r) => r.account.balance)),
    used: r2(sum((r) => r.used.credit)),
    added: r2(sum((r) => r.added.credit)),
    net: r2(sum((r) => r.net)),
    requests: reports.reduce((s, r) => s + Number(r.used.requests || 0), 0),
    within_7d: r2(sum((r) => r.expiry.within_7d)),
    within_30d: r2(sum((r) => r.expiry.within_30d)),
  },
};

fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data, null, 1));

if (!process.argv.includes('--no-hist')) {
  const histPath = path.join(OUT, 'history.json');
  let hist = [];
  if (fs.existsSync(histPath)) {
    try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch { hist = []; }
  }
  const snap = {
    date: data.date,
    at: data.at,
    balance: data.totals.balance,
    used: data.totals.used,
    added: data.totals.added,
    net: data.totals.net,
    byAccount: reports.map((r) => ({ id: r.id, label: r.label, balance: r.account.balance })),
  };
  const i = hist.findIndex((h) => h.date === snap.date);
  if (i >= 0) hist[i] = snap; else hist.push(snap);
  hist.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(hist.slice(-180), null, 1));
}

console.log(`data.json 已更新：${data.date} ${data.at}｜${reports.length} 个账号｜合计余额 ${data.totals.balance}`);
