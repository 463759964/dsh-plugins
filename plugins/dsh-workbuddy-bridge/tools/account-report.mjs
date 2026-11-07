#!/usr/bin/env node
/**
 * account-report.mjs —— 按「账号」查积分，不是按本机账本
 *
 *   node tools/account-report.mjs              全部账号：余额 + 今日发放/消耗 + 近 7 天
 *   node tools/account-report.mjs --json       给脚本用
 *   node tools/account-report.mjs --days 14    近 N 天（最多 30）
 *   node tools/account-report.mjs --account 173   只看某个账号
 *
 * 和 tools/credits.mjs 的区别：
 *   credits.mjs        本地账本 + 当前账号余额（只记经过桥接的调用）
 *   account-report.mjs 上游账号接口（余额/发放/签到全部服务端口径，跨账号循环）
 *
 * 数据来源（全部带 Bearer，逐账号切换）：
 *   POST /billing/meter/get-user-resource-summary        余额与积分组
 *   POST /billing/meter/get-user-resource-free-packages  赠送/签到/成长奖励流水
 *   POST /billing/meter/get-user-resource-paid-packages  购买包
 *
 * 上游接口不提供「按日消耗流水」明细（只有 CycleUsedCapacity 累计），
 * 所以「今日消耗」用今日发放 + 余额变化反推；桥接在跑时优先用桥接的实时统计。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const BRIDGE = path.resolve(import.meta.dirname, '..');
const GATEWAY = 'https://copilot.tencent.com';
const USAGE_FILE = path.join(os.homedir(), '.dsh', 'workbuddy-usage.json');

import { pathToFileURL } from 'node:url';

const { TokenVault } = await import(pathToFileURL(path.join(BRIDGE, 'lib', 'workbuddy-token.mjs')).href);

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const o = { json: false, days: 7, account: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null);
    if (a === '--json') o.json = true;
    else if (a === '--days') o.days = Math.min(Math.max(Number(next()) || 7, 1), 30);
    else if (a === '--account') o.account = next();
  }
  return o;
}

/* -------------------------------------------------------------- 上游调用 */

function headers(token) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    Authorization: `Bearer ${token}`,
  };
}

async function post(token, p, body = {}) {
  const r = await fetch(`${GATEWAY}${p}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.code !== 0) {
    throw new Error(`${p} -> HTTP ${r.status} code ${j?.code} ${j?.msg || ''}`);
  }
  return j.data;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------ 时区/格式化 */

const TZ_OFFSET = 8 * 3600 * 1000; // Asia/Shanghai
const cst = (ms) => new Date(ms + TZ_OFFSET).toISOString().replace('T', ' ').slice(0, 19);
const cstDay = (ms) => cst(ms).slice(0, 10);
const todayKey = () => cstDay(Date.now());

const fmt = (n) => {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

/* ---------------------------------------------------------------- 取数 */

/** 取一个账号的全量账目。 */
async function collectAccount(acc, days) {
  const token = await acc.getToken();
  const summary = await post(token, '/billing/meter/get-user-resource-summary');
  const codes = (summary?.Packages || []).map((p) => p.PackageCode).filter(Boolean);
  const paging = { PackageCodes: codes, PageNumber: 1, PageSize: 200 };

  let freeAccounts = [];
  let paidAccounts = [];
  if (codes.length) {
    freeAccounts = (await post(token, '/billing/meter/get-user-resource-free-packages', paging).catch(() => ({})))?.Accounts || [];
    paidAccounts = (await post(token, '/billing/meter/get-user-resource-paid-packages', paging).catch(() => ({})))?.Accounts || [];
  }

  const grants = [...freeAccounts, ...paidAccounts].map((a) => {
    const attrs = a.AccountAttributes || a.Attributes || [];
    const pick = (k) => attrs.find((x) => x.Key === k)?.Value || '';
    const createdMs = num(a.CreateTime);
    return {
      at: cst(createdMs),
      day: cstDay(createdMs),
      package: a.PackageName || '',
      source: pick('grantSource'),
      reason: pick('grantReason'),
      size: num(a.CycleCapacitySizePrecise) || num(a.CycleCapacitySize),
      used: num(a.CycleCapacityUsedPrecise) || num(a.CycleCapacityUsed),
      remain: num(a.CycleCapacityRemainPrecise) || num(a.CycleCapacityRemain),
    };
  });

  const today = todayKey();
  const grantsToday = grants.filter((g) => g.day === today);
  const addedToday = grantsToday.reduce((s, g) => s + g.size, 0);

  const groups = (summary?.CreditGroups || []).map((g) => ({
    kind: g.Kind || '',
    name: g.Name || '',
    total: num(g.CycleTotalCapacity),
    used: num(g.CycleUsedCapacity),
    remain: num(g.CycleRemainCapacity),
    count: num(g.TotalCount),
  }));

  const byDay = new Map();
  for (const g of grants) {
    const e = byDay.get(g.day) || { day: g.day, added: 0, items: 0 };
    e.added += g.size;
    e.items += 1;
    byDay.set(g.day, e);
  }
  const recentGrants = [...byDay.values()]
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, days);

  return {
    account: { uid: acc.uid, name: acc.name, uin: acc.uin || '' },
    balance: {
      remain: num(summary?.TotalCredits),
      plan: summary?.SubscriptionPackageName || '',
      isPaid: !!summary?.IsPaidUser,
      total: groups.reduce((s, g) => s + g.total, 0),
      used: groups.reduce((s, g) => s + g.used, 0),
    },
    groups,
    today: { date: today, added: addedToday, grants: grantsToday.sort((a, b) => b.at.localeCompare(a.at)) },
    recentGrants,
    grantCount: grants.length,
  };
}

/** 桥接在跑就给今日实时消耗，拿不到返回 null。 */
async function bridgeToday(uid) {
  try {
    const { readSecretState } = await import(pathToFileURL(path.join(BRIDGE, 'lib', 'local-secret.mjs')).href);
    const secret = readSecretState();
    if (!secret?.apiKey) return null;
    const port = Number(process.env.WORKBUDDY_BRIDGE_PORT) || 8792;
    const qs = new URLSearchParams({ days: '1' });
    if (uid) qs.set('account', uid);
    const res = await fetch(`http://127.0.0.1:${port}/v1/usage?${qs}`, {
      headers: { Authorization: `Bearer ${secret.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { credit: num(j?.today?.credit), requests: num(j?.today?.requests), tokens: num(j?.today?.tokens) };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 渲染 */

function render(r) {
  const L = [];
  const b = r.balance;
  L.push(`━━━ ${r.account.name}  ${r.account.uin ? `uin ${r.account.uin}  ` : ''}${r.account.uid}`);
  L.push(`  当前余额   ${fmt(b.remain)} 积分   套餐 ${b.plan || '-'}${b.isPaid ? ' · 付费' : ' · 未付费'}`);
  L.push(`  今日 ${r.today.date}`);
  L.push(`    新增     +${fmt(r.today.added)} 积分   （${r.today.grants.length} 笔发放）`);
  if (r.today.consumed) {
    L.push(`    消耗     -${fmt(r.today.consumed.credit)} 积分   （${r.today.consumed.requests} 次请求 · ${r.today.consumed.tokens} tokens）`);
    L.push(`    净变化   ${r.today.added - r.today.consumed.credit >= 0 ? '+' : ''}${fmt(r.today.added - r.today.consumed.credit)} 积分`);
  } else {
    L.push(`    消耗     （桥接未运行，上游不提供按日消耗，只有累计已用 ${fmt(b.used)}）`);
  }
  if (r.today.grants.length) {
    L.push('    今日发放明细');
    for (const g of r.today.grants) L.push(`      ${g.at}  +${fmt(g.size).padStart(6)}  ${g.reason || g.package}  [${g.source}]`);
  }
  if (r.groups.length) {
    L.push('  积分组');
    for (const g of r.groups) {
      L.push(`    ${(g.name || g.kind).padEnd(14)} 总量 ${String(fmt(g.total)).padStart(7)}  已用 ${String(fmt(g.used)).padStart(9)}  剩 ${fmt(g.remain)}`);
    }
  }
  if (r.recentGrants.length) {
    L.push('  发放走势（按天）');
    const max = Math.max(...r.recentGrants.map((g) => g.added), 1);
    for (const g of r.recentGrants.slice().reverse()) {
      const bar = '█'.repeat(Math.max(1, Math.round((g.added / max) * 24)));
      L.push(`    ${g.day}  +${String(fmt(g.added)).padStart(7)}  ${String(g.items).padStart(2)} 笔  ${bar}`);
    }
  }
  L.push(`  累计发放 ${r.grantCount} 笔`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ 主 */

const opts = parseArgs(process.argv.slice(2));
const vault = new TokenVault({});
const list = vault.listPublic();
const targets = opts.account ? list.filter((a) => a.uid === opts.account || a.name === opts.account) : list;

if (!targets.length) {
  process.stderr.write(
    `没有匹配「${opts.account}」的账号。本机可解出 ${list.length} 个：\n` +
      list.map((a) => `  ${a.name}  ${a.uid}`).join('\n') +
      '\n要查别的账号，先在 WorkBuddy 客户端登录它，完全退出后重开一次。\n',
  );
  process.exit(2);
}

const results = [];
for (const a of targets) {
  try {
    // TokenVault 每次取号都要指定 uid，避免串号
    const v = opts.account ? new TokenVault({ uid: a.uid }) : new TokenVault({ uid: a.uid });
    const holder = {
      uid: a.uid,
      name: a.name,
      uin: '',
      getToken: () => v.getAccessToken(),
    };
    const r = await collectAccount(holder, opts.days);
    const live = await bridgeToday(a.uid);
    if (live) r.today.consumed = live;
    results.push(r);
  } catch (e) {
    results.push({ account: { uid: a.uid, name: a.name }, error: String(e.message || e) });
  }
}

if (opts.json) {
  process.stdout.write(`${JSON.stringify({ object: 'account-report', generatedAt: cst(Date.now()), accounts: results }, null, 2)}\n`);
} else {
  const out = results
    .map((r) => (r.error ? `━━━ ${r.account.name}  ${r.account.uid}\n  查询失败：${r.error}` : render(r)))
    .join('\n\n');
  process.stdout.write(`${out}\n`);
}
