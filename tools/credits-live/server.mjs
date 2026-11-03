/**
 * server.mjs —— 积分看板「实时版」服务端（零依赖，Node 18+）
 *
 *   node server.mjs                 默认端口 8088
 *   PORT=9000 node server.mjs       自定义端口
 *
 *   GET /                  看板页面（每 15 秒自动刷新）
 *   GET /api/data          实时数据（服务端 20 秒缓存，?force=1 跳过）
 *   GET /api/health        健康检查
 *
 * 账号来源：config.json 的 accounts[]，或环境变量 WB_TOKENS="名字:accessToken|refreshToken"
 * 凭证快过期时自动用 refreshToken 续期并回写文件。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAccount, refresh } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const CACHE_MS = Number(process.env.CACHE_MS || 20000);
const PAGE = path.join(HERE, 'index.html');

function loadAccounts() {
  const list = [];
  const cfgPath = process.env.CREDITS_CONFIG || path.join(HERE, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const a of cfg.accounts || []) {
        if (a.tokenFile) {
          const p = path.resolve(HERE, a.tokenFile);
          const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
          list.push({ id: a.id || creds.name || p, label: a.label || creds.name || a.id, creds, file: p });
        } else if (a.token) {
          list.push({ id: a.id, label: a.label || a.id, creds: { accessToken: a.token, refreshToken: a.refreshToken, expiresAt: a.expiresAt } });
        }
      }
    } catch (e) { console.error('config.json 解析失败：', e.message); }
  }
  if (!list.length && process.env.WB_TOKENS) {
    for (const pair of process.env.WB_TOKENS.split(',')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const label = pair.slice(0, i).trim();
      const [at, rt] = pair.slice(i + 1).trim().split('|');
      list.push({ id: label, label, creds: { accessToken: at, refreshToken: rt || '', expiresAt: 0 } });
    }
  }
  return list;
}

/** 令牌即将过期（或未知有效期）就先续一次 */
async function tokenOf(acct) {
  const c = acct.creds;
  const exp = Number(c.expiresAt || 0);
  const stale = !c.accessToken || exp === 0 || exp - Date.now() < 5 * 60 * 1000;
  if (stale && c.refreshToken) {
    const fresh = await refresh(c, acct.file).catch(() => null);
    if (fresh) console.log(`[token] ${acct.label} 已自动续期`);
    else if (!c.accessToken) throw new Error('令牌缺失且续期失败');
  }
  return c.accessToken;
}

let cache = { at: 0, payload: null };
let inflight = null;

async function build(force) {
  if (!force && cache.payload && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.payload, cached: true, cacheAgeMs: Date.now() - cache.at };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const accts = loadAccounts();
    if (!accts.length) throw new Error('未配置账号：请提供 config.json 或环境变量 WB_TOKENS');
    const settled = await Promise.allSettled(accts.map(async (a) => {
      const token = await tokenOf(a);
      return fetchAccount({ id: a.id, label: a.label, token });
    }));
    const accounts = [], errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') accounts.push(r.value);
      else errors.push({ label: accts[i].label, error: String(r.reason?.message || r.reason) });
    });
    if (!accounts.length) throw new Error(errors.map((e) => `${e.label}: ${e.error}`).join('; '));

    const sum = (f) => Math.round(accounts.reduce((t, a) => t + Number(f(a) || 0), 0) * 100) / 100;
    const totals = {
      balance: sum((a) => a.account.balance),
      used: sum((a) => a.used.credit),
      added: sum((a) => a.added.credit),
      requests: accounts.reduce((t, a) => t + a.used.requests, 0),
      within_7d: sum((a) => a.expiry.within_7d),
      within_30d: sum((a) => a.expiry.within_30d),
    };
    totals.net = Math.round((totals.added - totals.used) * 100) / 100;
    const payload = { date: accounts[0].date, at: accounts[0].at, accounts, errors, totals, builtAt: Date.now() };
    cache = { at: Date.now(), payload };
    return payload;
  })().finally(() => { inflight = null; });
  return inflight;
}

/* 每天第一次成功拉取时，往 history.json 记一条，供趋势图使用 */
function snapshotHistory(payload) {
  try {
    const f = path.join(HERE, 'history.json');
    let hist = [];
    if (fs.existsSync(f)) hist = JSON.parse(fs.readFileSync(f, 'utf8')) || [];
    const snap = {
      date: payload.date, at: payload.at, balance: payload.totals.balance,
      used: payload.totals.used, added: payload.totals.added, net: payload.totals.net,
      byAccount: payload.accounts.map((a) => ({ id: a.id, label: a.label, balance: a.account.balance })),
    };
    const i = hist.findIndex((h) => h.date === snap.date);
    if (i >= 0) hist[i] = snap; else hist.push(snap);
    hist.sort((a, b) => a.date.localeCompare(b.date));
    fs.writeFileSync(f, JSON.stringify(hist.slice(-180), null, 1));
  } catch { /* 历史写失败不影响页面 */ }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8'); }
    catch { send(500, '找不到 index.html'); }
    return;
  }

  if (url.pathname === '/api/data') {
    try {
      const p = await build(url.searchParams.get('force') === '1');
      if (!p.cached) snapshotHistory(p);
      send(200, JSON.stringify(p));
    } catch (e) { send(500, JSON.stringify({ error: String(e.message || e) })); }
    return;
  }

  if (url.pathname === '/api/health') {
    send(200, JSON.stringify({ ok: true, accounts: loadAccounts().length, cacheAt: cache.at }));
    return;
  }

  send(404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  const n = loadAccounts().length;
  console.log(`积分看板（实时）已启动 → http://localhost:${PORT}`);
  console.log(`已载入 ${n} 个账号${n ? '' : '（请配置 config.json 或 WB_TOKENS）'}`);
});
