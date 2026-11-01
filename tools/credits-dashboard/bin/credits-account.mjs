/**
 * credits-account.mjs —— 直接查「账号侧」积分：今日消耗 / 今日新增 / 余额 / 到期
 *
 *   node credits-account.mjs                        查本机当前登录账号
 *   node credits-account.mjs --uid <uid|名称>        本机登录态里有多个账号时选一个
 *   node credits-account.mjs --token <accessToken>  查任意账号（另一台机器的凭证）
 *   node credits-account.mjs --token-file <path>    同上，从文件读，避免留在命令历史里
 *   WB_TOKEN=<accessToken> node credits-account.mjs 同上，走环境变量
 *   加 --json 输出结构化数据
 *
 * 全部数据来自账号服务端（copilot.tencent.com billing），不读本机会话日志：
 *   POST /billing/meter/get-user-request-usage   逐笔扣费明细（账号权威记录，含 client/model）
 *   POST /billing/meter/get-user-resource-summary 实时余额、账期累计已用
 *   POST /billing/meter/get-user-resource-free-packages 积分包与到期时间
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { libUrl } from './_lib.mjs';

const LIB = libUrl();
const ARGV = process.argv.slice(2);
const argOf = (name) => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : null; };
const JSON_OUT = ARGV.includes('--json');
const TZ = 'Asia/Shanghai';

const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round(n * 100) / 100;
const now = new Date();
const dayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const nowStr = `${dayStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const fmtMs = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

/* ---------- 令牌：外部优先，其次本机登录态 ---------- */
const tokenFile = argOf('--token-file');
let creds = null;
let fileToken = '';
if (tokenFile) {
  const raw = fs.readFileSync(tokenFile, 'utf8').trim();
  if (raw.startsWith('{')) { creds = JSON.parse(raw); fileToken = creds.accessToken || ''; }
  else fileToken = raw;
}
let token = argOf('--token') || process.env.WB_TOKEN || fileToken;
let tokenSource = token ? (creds ? `外部凭证 · ${creds.name || creds.uid || '未知账号'}` : '外部令牌') : '';
let localAccount = null;

/** 外部凭证快过期时用 refresh token 续期，并回写文件 */
async function refreshCreds() {
  if (!creds?.refreshToken || !creds?.accessToken) return false;
  const r = await fetch('https://www.workbuddy.cn/v2/plugin/auth/token/refresh', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${creds.accessToken}`, 'X-Refresh-Token': creds.refreshToken },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r?.ok) return false;
  const d = await r.json().catch(() => null);
  const at = d?.accessToken || d?.access_token;
  if (!at) return false;
  creds.accessToken = at;
  if (d.refreshToken || d.refresh_token) creds.refreshToken = d.refreshToken || d.refresh_token;
  creds.expiresAt = d.expiresAt || d.expires_at || Date.now() + (d.expiresIn || d.expires_in || 2592000) * 1000;
  if (d.refreshExpiresAt || d.refresh_expires_at) creds.refreshExpiresAt = d.refreshExpiresAt || d.refresh_expires_at;
  try { fs.writeFileSync(tokenFile, JSON.stringify(creds, null, 1), { mode: 0o600 }); } catch { /* 只读文件就算了 */ }
  return at;
}

if (creds && creds.expiresAt && creds.expiresAt - Date.now() < 5 * 60 * 1000) {
  const fresh = await refreshCreds();
  if (fresh) token = fresh;
}

if (!token) {
  const { TokenVault } = await import(LIB + 'workbuddy-token.mjs');
  const vault = new TokenVault({});
  const wantUid = argOf('--uid');
  if (wantUid && !vault.select(wantUid)) {
    const names = vault.load().map((a) => `${a.name}(${a.uid})`).join('、');
    console.error(`本机登录态里找不到账号「${wantUid}」。可用：${names || '（无）'}`);
    process.exit(2);
  }
  localAccount = vault.current();
  token = await vault.getAccessToken();
  tokenSource = `本机登录态 · ${localAccount?.name ?? '—'}`;
}
const H = {
  Accept: 'application/json', 'Content-Type': 'application/json',
  'x-requested-with': 'XMLHttpRequest', 'X-Request-ID': crypto.randomUUID(),
  'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Version': '0.0.0',
  'X-Private-Data': 'true', 'X-Product': 'SaaS', Authorization: `Bearer ${token}`,
};
const call = async (p, body) => {
  const r = await fetch('https://copilot.tencent.com' + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!j) { console.error(`请求失败 ${p} → HTTP ${r.status}`); return null; }
  if (j.code && j.code !== 0 && /token|unauthor|forbidden|登录|鉴权/i.test(String(j.msg || ''))) {
    console.error(`令牌不可用（${j.code} ${j.msg}）。外部令牌约 30 天过期，请重新获取。`);
    process.exit(3);
  }
  return j;
};

/* ---------- 1. 今日逐笔扣费（账号服务端） ---------- */
const rows = [];
let total = 0;
for (let pageNum = 1; pageNum <= 40; pageNum++) {
  const j = await call('/billing/meter/get-user-request-usage', { startTime: `${dayStr} 00:00:00`, endTime: nowStr, timezone: TZ, pageNum, pageSize: 500 });
  const d = j?.data;
  if (!d?.data?.length) break;
  total = d.total ?? total;
  rows.push(...d.data);
  if (rows.length >= total) break;
}
const usedCredit = r2(rows.reduce((s, r) => s + Number(r.credit || 0), 0));

const group = (fn) => {
  const m = {};
  for (const r of rows) {
    const k = fn(r);
    (m[k] = m[k] || { credit: 0, count: 0 }).credit += Number(r.credit || 0);
    m[k].count += 1;
  }
  return Object.entries(m)
    .map(([k, v]) => ({ key: k, credit: r2(v.credit), count: v.count }))
    .sort((a, b) => b.credit - a.credit);
};
const byClient = group((r) => r.client || '未知');
const byModel = group((r) => r.model || '未知');
const byHour = group((r) => String(r.requestTime || '').slice(11, 13)).sort((a, b) => a.key.localeCompare(b.key));
const byPurpose = group((r) => r.agentPurpose || '未知');
const cycleStartStr = '2026-10-19 17:14:37';
const cycleDetailCredit = null;

/* ---------- 2. 账号余额 / 账期累计 ---------- */
const summary = (await call('/billing/meter/get-user-resource-summary', {}))?.data || {};
const codes = (summary.Packages || []).map((p) => p.PackageCode);
const page = { PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3], SlicePeriodStartTime: `${dayStr} 00:00:00`, SlicePeriodEndTime: `${dayStr} 23:59:59` };
const free = (await call('/billing/meter/get-user-resource-free-packages', page))?.data?.Accounts || [];
const paid = (await call('/billing/meter/get-user-resource-paid-packages', { ...page, NeedRenewInfo: true }))?.data?.Accounts || [];

const addedItems = [...free, ...paid]
  .filter((a) => {
    const t = fmtMs(a.CreateTime);
    return t >= `${dayStr} 00:00:00` && t <= `${dayStr} 23:59:59`;
  })
  .map((a) => ({
    package: a.PackageName,
    credit: Number(a.CycleCapacitySize || 0),
    at: fmtMs(a.CreateTime),
    reason: (a.AccountAttributes || []).find((x) => x.Key === 'grantReason')?.Value || '',
  }))
  .sort((a, b) => a.at.localeCompare(b.at));
const added = r2(addedItems.reduce((s, a) => s + a.credit, 0));

/* ---------- 2b. 积分到期 ---------- */
const allPage = { PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3] };
const allFree = (await call('/billing/meter/get-user-resource-free-packages', allPage))?.data?.Accounts || [];
const allPaid = (await call('/billing/meter/get-user-resource-paid-packages', { ...allPage, NeedRenewInfo: true }))?.data?.Accounts || [];
const remainOf = (a) => Number(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0);
const endOf = (a) => Number(a.DeductionEndTime || 0) || (a.CycleEndTime ? new Date(a.CycleEndTime.replace(/-/g, '/')).getTime() : 0);
const forever = (a) => endOf(a) > new Date('2030-01-01').getTime();

const packs = [...allFree, ...allPaid]
  .filter((a) => remainOf(a) > 0)
  .map((a) => ({
    name: a.PackageName,
    remain: r2(remainOf(a)),
    size: r2(Number(a.CycleCapacitySize || 0)),
    end_ms: endOf(a),
    end: endOf(a) ? fmtMs(endOf(a)) : '—',
    forever: forever(a),
    created: a.CreateTime ? fmtMs(a.CreateTime) : '—',
  }))
  .sort((a, b) => a.end_ms - b.end_ms);

const expiryByDay = {};
for (const p of packs) {
  const key = p.forever ? '长期有效' : p.end.slice(0, 10);
  (expiryByDay[key] = expiryByDay[key] || { credit: 0, count: 0, names: new Set() });
  expiryByDay[key].credit += p.remain;
  expiryByDay[key].count += 1;
  expiryByDay[key].names.add(p.name);
}
const expiryList = Object.entries(expiryByDay)
  .map(([k, v]) => ({ date: k, credit: r2(v.credit), count: v.count, packages: [...v.names] }))
  .sort((a, b) => (a.date === '长期有效' ? 1 : b.date === '长期有效' ? -1 : a.date.localeCompare(b.date)));

const daysLeft = (d) => Math.max(0, Math.ceil((new Date(d + 'T23:59:59') - now) / 86400000));
const soon7 = r2(expiryList.filter((e) => e.date !== '长期有效' && (new Date(e.date + 'T23:59:59') - now) / 86400000 <= 7).reduce((s, e) => s + e.credit, 0));
const soon30 = r2(expiryList.filter((e) => e.date !== '长期有效' && (new Date(e.date + 'T23:59:59') - now) / 86400000 <= 30).reduce((s, e) => s + e.credit, 0));
const firstExpiry = expiryList.find((e) => e.date !== '长期有效') || null;

const cycleUsed = (summary.CreditGroups || []).reduce((s, g) => s + Number(g.CycleUsedCapacity || 0), 0);
const cycleTotal = (summary.Packages || []).reduce((s, p) => s + Number(p.CycleTotalCapacity || 0), 0);

const report = {
  date: dayStr,
  at: nowStr,
  account: {
    uin: free[0]?.Uin || null,
    source: tokenSource,
    plan: summary.SubscriptionPackageName,
    is_paid: summary.IsPaidUser,
    balance: r2(Number(summary.TotalCredits || 0)),
    cycle_total: r2(cycleTotal),
    cycle_used: r2(cycleUsed),
    cycle_start: free.find((a) => a.CycleStartTime)?.CycleStartTime || null,
    groups: (summary.CreditGroups || []).filter((g) => Number(g.CycleTotalCapacity) > 0)
      .map((g) => ({ name: g.Name, total: r2(Number(g.CycleTotalCapacity)), used: r2(Number(g.CycleUsedCapacity)), remain: r2(Number(g.CycleRemainCapacity)) })),
  },
  used: { credit: usedCredit, requests: rows.length, server_total: total, by_client: byClient, by_model: byModel, by_hour: byHour, by_purpose: byPurpose },
  added: { credit: added, items: addedItems },
  net: r2(added - usedCredit),
  expiry: {
    first: firstExpiry,
    within_7d: soon7,
    within_30d: soon30,
    by_day: expiryList,
    packages: packs,
  },
  opening_balance: r2(Number(summary.TotalCredits || 0) + usedCredit - added),
  cycle_check: { start: cycleStartStr, detail_credit: cycleDetailCredit, cycle_used: r2(cycleUsed) },
};

if (JSON_OUT) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

const L = [];
L.push(`WorkBuddy 账号积分 · ${report.date}（账号服务端数据，截至 ${report.at.slice(11, 16)}）`);
L.push(`账号 UIN ${report.account.uin} · ${report.account.plan}${report.account.is_paid ? '（付费）' : '（免费）'} · 来源：${report.account.source}`);
L.push('');
L.push(`  今日消耗   -${report.used.credit.toFixed(2)}   （${report.used.requests} 笔请求，账号侧逐笔扣费记录）`);
for (const c of byClient) L.push(`      ${String(c.key).padEnd(14)} -${c.credit.toFixed(2).padStart(8)}  ${String(c.count).padStart(4)} 笔`);
L.push(`    按模型：`);
for (const m of byModel) L.push(`      ${String(m.key).padEnd(22)} -${m.credit.toFixed(2).padStart(7)}  ${String(m.count).padStart(4)} 笔`);
L.push(`  今日新增   +${report.added.credit.toFixed(2)}`);
for (const a of report.added.items) L.push(`      ${a.at.slice(11, 16)}  +${a.credit.toFixed(2).padStart(7)}  ${a.reason || a.package}`);
L.push(`  今日净变化 ${report.net >= 0 ? '+' : ''}${report.net.toFixed(2)}`);
L.push('');
L.push(`  当前余额   ${report.account.balance.toFixed(2)} 积分`);
for (const g of report.account.groups) L.push(`      ${g.name.padEnd(8)} 剩 ${g.remain.toFixed(2).padStart(9)} / ${g.total.toFixed(2)}  已用 ${g.used.toFixed(2)}`);
L.push(`  账期累计   已用 ${report.account.cycle_used.toFixed(2)} / ${report.account.cycle_total.toFixed(2)}（自 ${report.account.cycle_start || '—'} 起）`);
L.push('');
L.push(`  积分到期（共 ${packs.length} 个包 / 剩 ${r2(packs.reduce((s, p) => s + p.remain, 0)).toFixed(2)}）`);
for (const e of expiryList) {
  const left = e.date === '长期有效' ? '长期  ' : `${String(daysLeft(e.date)).padStart(3)} 天后`;
  L.push(`      ${e.date.padEnd(11)} ${left}  剩 ${e.credit.toFixed(2).padStart(9)}  ${String(e.count).padStart(2)} 包  ${e.packages.join('、')}`);
}
if (firstExpiry) L.push(`      → 最早到期 ${firstExpiry.date}（${daysLeft(firstExpiry.date)} 天后），届时作废 ${firstExpiry.credit.toFixed(2)}`);
L.push(`      → 7 天内到期 ${report.expiry.within_7d.toFixed(2)}｜30 天内到期 ${report.expiry.within_30d.toFixed(2)}`);
L.push('');
L.push(`  对账：今日 0 点余额约 ${report.opening_balance.toFixed(2)}  →  现在 ${report.account.balance.toFixed(2)}（+新增 ${report.added.credit.toFixed(2)} −消耗 ${report.used.credit.toFixed(2)}）`);
L.push(`  （余额为实时值，每轮对话都会继续扣减；上方数字是 ${report.at.slice(11, 16)} 的快照）`);
console.log(L.join('\n'));
