#!/usr/bin/env node
/**
 * WorkBuddy 积分看板 · 实时
 *   GET /          看板页面
 *   GET /api/data  实时拉取账号积分数据（服务端缓存 60s，凭证自动续期）
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const PAGE = readFileSync(join(HERE, 'public', 'index.html'), 'utf8');

const pad = (n) => String(n).padStart(2, '0');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const fmtMs = (ms) => {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dms = (s) => (s ? new Date(String(s).replace(/-/g, '/')).getTime() : 0);

/* ---------- 凭证（内存态，可续期） ---------- */
const creds = new Map(
  (CONFIG.accounts || []).map((a) => [
    a.label,
    { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt || 0 },
  ])
);

async function refreshToken(label) {
  const c = creds.get(label);
  if (!c?.refreshToken) return;
  try {
    const r = await fetch('https://www.workbuddy.cn/v2/plugin/auth/token/refresh', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.accessToken}`,
        'X-Refresh-Token': c.refreshToken,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return;
    const d = await r.json().catch(() => null);
    const at = d?.accessToken || d?.access_token;
    if (at) {
      c.accessToken = at;
      if (d.refreshToken || d.refresh_token) c.refreshToken = d.refreshToken || d.refresh_token;
      c.expiresAt = d.expiresAt || d.expires_at || Date.now() + 2592000 * 1000;
      console.log(`[token] ${label} 已续期`);
    }
  } catch {}
}

/* ---------- 取单个账号 ---------- */
async function fetchAccount(label) {
  const c = creds.get(label);
  if (!c) throw new Error('未配置该账号');
  const H = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': crypto.randomUUID(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    Authorization: `Bearer ${c.accessToken}`,
  };
  const call = async (p, body) => {
    const r = await fetch('https://copilot.tencent.com' + p, {
      method: 'POST',
      headers: H,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`接口无响应 HTTP ${r.status}`);
    if (j.code && j.code !== 0 && /token|unauthor|forbidden|鉴权|登录/i.test(String(j.msg || ''))) {
      throw new Error(`令牌不可用（${j.code} ${j.msg}）`);
    }
    return j;
  };

  const now = new Date();
  const dayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const nowStr = `${dayStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const rows = [];
  for (let pageNum = 1; pageNum <= 40; pageNum++) {
    const j = await call('/billing/meter/get-user-request-usage', {
      startTime: `${dayStr} 00:00:00`,
      endTime: nowStr,
      timezone: 'Asia/Shanghai',
      pageNum,
      pageSize: 500,
    });
    const d = j?.data;
    if (!d?.data?.length) break;
    rows.push(...d.data);
    if (rows.length >= (d.total ?? rows.length)) break;
  }
  const usedCredit = r2(rows.reduce((s, r) => s + Number(r.credit || 0), 0));
  const group = (fn) => {
    const mm = {};
    for (const r of rows) {
      const k = fn(r);
      (mm[k] = mm[k] || { credit: 0, count: 0 }).credit += Number(r.credit || 0);
      mm[k].count += 1;
    }
    return Object.entries(mm)
      .map(([key, v]) => ({ key, credit: r2(v.credit), count: v.count }))
      .sort((a, b) => b.credit - a.credit);
  };

  const summary = (await call('/billing/meter/get-user-resource-summary', {}))?.data || {};
  const codes = (summary.Packages || []).map((p) => p.PackageCode);
  const basePage = { PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3] };

  const allFree = (await call('/billing/meter/get-user-resource-free-packages', basePage))?.data?.Accounts || [];
  const allPaid = (await call('/billing/meter/get-user-resource-paid-packages', { ...basePage, NeedRenewInfo: true }))?.data?.Accounts || [];
  const remainOf = (a) => Number(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0);
  const endOf = (a) => Number(a.DeductionEndTime || 0) || dms(a.CycleEndTime);

  const packs = [...allFree, ...allPaid]
    .filter((a) => remainOf(a) > 0)
    .map((a) => ({
      remain: r2(remainOf(a)),
      end_ms: endOf(a),
      end: endOf(a) ? fmtMs(endOf(a)) : '—',
      forever: endOf(a) > new Date('2030-01-01').getTime(),
    }))
    .sort((a, b) => a.end_ms - b.end_ms);

  return {
    label,
    at: nowStr,
    balance: r2(Number(summary.TotalCredits || 0)),
    used: usedCredit,
    requests: rows.length,
    by_model: group((r) => r.model || '未知'),
    packs,
  };
}

/* ---------- 缓存 ---------- */
const CACHE_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

async function getData(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return { ...cache, cached: true };
  const results = await Promise.allSettled(
    (CONFIG.accounts || []).map(async (a) => {
      const c = creds.get(a.label);
      if (!c.accessToken || (c.expiresAt && c.expiresAt - Date.now() < 5 * 60 * 1000)) {
        await refreshToken(a.label);
      }
      if (!c.accessToken) throw new Error('无可用令牌');
      return fetchAccount(a.label);
    })
  );
  const accounts = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') accounts.push(r.value);
    else errors.push(`${CONFIG.accounts[i].label}: ${r.reason?.message || r.reason}`);
  });
  if (!accounts.length) throw new Error('全部账号拉取失败：' + errors.join('; '));

  const now = new Date();
  cache = {
    generatedAt: fmtMs(now.getTime()),
    serverTime: fmtMs(now.getTime()),
    accounts,
    errors,
  };
  cacheAt = Date.now();
  return cache;
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  try {
    if (url.pathname === '/api/data') {
      const force = url.searchParams.get('force') === '1';
      const data = await getData(force);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, HOST, () => console.log(`listening on ${HOST}:${PORT}`));
