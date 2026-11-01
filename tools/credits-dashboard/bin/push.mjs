/**
 * push.mjs —— 把当日积分快照推送到 QQ（Qmsg 酱），支持多账号
 *
 *   node push.mjs          推送
 *   node push.mjs --dry    只打印不推送
 *
 * 注意：Qmsg 会拦截 URL、IPv4 和长连续数字串，因此正文里
 * 不放分享链接、不放 UIN，日期也写成「11月17日」这种形式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG = process.env.CREDITS_CONFIG ? path.resolve(process.env.CREDITS_CONFIG) : path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const OUT = cfg.outDir ? path.resolve(ROOT, cfg.outDir) : path.join(ROOT, 'dashboard');
const data = JSON.parse(fs.readFileSync(path.join(OUT, 'data.json'), 'utf8'));

const histPath = path.join(OUT, 'history.json');
let hist = [];
if (fs.existsSync(histPath)) { try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch { /* ignore */ } }
const prev = [...hist].reverse().find((h) => h.date !== data.date) || null;

const md = (s) => `${Number(String(s).slice(5, 7))}月${Number(String(s).slice(8, 10))}日`;
const n2 = (v) => Number(v || 0).toFixed(2);
const sign = (v) => (v >= 0 ? '+' : '−') + n2(Math.abs(v));

const t = data.totals;
const lines = [];
lines.push(`【WorkBuddy 积分日报】${md(data.date)}`);
lines.push(`合计余额 ${n2(t.balance)}${prev ? `（较上次 ${sign(t.balance - prev.balance)}）` : ''}`);

for (const r of data.accounts) {
  lines.push(`· ${r.label}：余 ${n2(r.account.balance)}｜耗 −${n2(r.used.credit)}｜新 ${sign(r.added.credit)}`);
}
lines.push(`今日共耗 −${n2(t.used)}（${t.requests} 笔）｜新增 ${sign(t.added)}｜净 ${sign(t.net)}`);

const firsts = data.accounts.map((r) => ({ r, f: r.expiry.first })).filter((x) => x.f);
if (firsts.length) {
  const x = firsts.sort((a, b) => a.f.date.localeCompare(b.f.date))[0];
  lines.push(`最早到期 ${md(x.f.date)}，作废 ${n2(x.f.credit)}（${x.r.label}）`);
}
lines.push(`7 天内到期 ${n2(t.within_7d)}｜30 天内到期 ${n2(t.within_30d)}`);

const msg = lines.join('\n');
console.log('--- 推送内容 ---\n' + msg + '\n----------------');

if (process.argv.includes('--dry')) process.exit(0);

const key = process.env.QMSG_KEY || cfg.qmsgKey;
if (!key) { console.error('缺少 Qmsg Key：填 config.json 的 qmsgKey 或设 QMSG_KEY 环境变量。'); process.exit(1); }

const body = new URLSearchParams();
body.set('msg', msg);

const r = await fetch(`${cfg.qmsgEndpoint}/${key}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
  signal: AbortSignal.timeout(20000),
}).catch((e) => { console.error('推送请求失败：', e.message); process.exit(1); });

const j = await r.json().catch(() => null);
if (!r.ok || !j?.success) {
  console.error(`推送失败 HTTP ${r.status}：${j?.message || '(无响应体)'}（code ${j?.code ?? '—'}）`);
  process.exit(1);
}
console.log(`推送成功，消息 ID ${j.data}`);
