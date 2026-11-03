/**
 * api.mjs —— 积分数据拉取（照搬 credits-account.mjs 的接口与字段映射，去掉 CLI 外壳）
 */
import crypto from 'node:crypto';

const TZ = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const fmtMs = (ms) => {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dms = (s) => (s ? new Date(String(s).replace(/-/g, '/')).getTime() : 0);

/** 用 refreshToken 换新 accessToken，并回写凭证文件 */
export async function refresh(creds, file) {
  if (!creds?.accessToken || !creds?.refreshToken) return null;
  const r = await fetch('https://www.workbuddy.cn/v2/plugin/auth/token/refresh', {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.accessToken}`, 'X-Refresh-Token': creds.refreshToken,
    },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null);
  const at = d?.accessToken || d?.access_token;
  if (!at) return null;
  creds.accessToken = at;
  if (d.refreshToken || d.refresh_token) creds.refreshToken = d.refreshToken || d.refresh_token;
  creds.expiresAt = d.expiresAt || d.expires_at || Date.now() + (d.expiresIn || d.expires_in || 2592000) * 1000;
  if (file) { try { (await import('node:fs')).writeFileSync(file, JSON.stringify(creds, null, 1), { mode: 0o600 }); } catch { /* ignore */ } }
  return at;
}

function headers(token) {
  return {
    Accept: 'application/json', 'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest', 'X-Request-ID': crypto.randomUUID(),
    'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true', 'X-Product': 'SaaS', Authorization: `Bearer ${token}`,
  };
}

/**
 * 拉取单个账号的完整快照
 * @param {{id:string,label:string,token:string}} acct
 */
export async function fetchAccount(acct) {
  const H = headers(acct.token);
  const call = async (p, body) => {
    const r = await fetch('https://copilot.tencent.com' + p, {
      method: 'POST', headers: H, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30000),
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

  /* 1. 今日逐笔扣费（分页） */
  const rows = [];
  for (let pageNum = 1; pageNum <= 40; pageNum++) {
    const j = await call('/billing/meter/get-user-request-usage', {
      startTime: `${dayStr} 00:00:00`, endTime: nowStr, timezone: TZ, pageNum, pageSize: 500,
    });
    const d = j?.data;
    if (!d?.data?.length) break;
    rows.push(...d.data);
    if (rows.length >= (d.total ?? rows.length)) break;
  }
  const usedCredit = r2(rows.reduce((s, r) => s + Number(r.credit || 0), 0));
  const group = (fn) => {
    const m = {};
    for (const r of rows) {
      const k = fn(r);
      (m[k] = m[k] || { credit: 0, count: 0 }).credit += Number(r.credit || 0);
      m[k].count += 1;
    }
    return Object.entries(m).map(([key, v]) => ({ key, credit: r2(v.credit), count: v.count }))
      .sort((a, b) => b.credit - a.credit);
  };

  /* 2. 实时余额 / 账期
     注意：摘要接口必须显式传 {}，若传 undefined 会被序列化成空 body，上游返回的 data 里
     Packages/CreditGroups 会缺失。这里统一用 {} 兜底。 */
  const summary = (await call('/billing/meter/get-user-resource-summary', {}))?.data || {};
  const codes = (summary.Packages || []).map((p) => p.PackageCode);
  const basePage = { PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3] };
  const todayPage = { ...basePage, SlicePeriodStartTime: `${dayStr} 00:00:00`, SlicePeriodEndTime: `${dayStr} 23:59:59` };

  const freeToday = (await call('/billing/meter/get-user-resource-free-packages', todayPage))?.data?.Accounts || [];
  const paidToday = (await call('/billing/meter/get-user-resource-paid-packages', { ...todayPage, NeedRenewInfo: true }))?.data?.Accounts || [];
  const addedItems = [...freeToday, ...paidToday]
    .filter((a) => { const t = fmtMs(a.CreateTime); return t >= `${dayStr} 00:00:00` && t <= `${dayStr} 23:59:59`; })
    .map((a) => ({
      package: a.PackageName,
      credit: Number(a.CycleCapacitySize || 0),
      at: fmtMs(a.CreateTime),
      reason: (a.AccountAttributes || []).find((x) => x.Key === 'grantReason')?.Value || '',
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const added = r2(addedItems.reduce((s, a) => s + a.credit, 0));

  /* 3. 积分包与到期 */
  const allFree = (await call('/billing/meter/get-user-resource-free-packages', basePage))?.data?.Accounts || [];
  const allPaid = (await call('/billing/meter/get-user-resource-paid-packages', { ...basePage, NeedRenewInfo: true }))?.data?.Accounts || [];
  const remainOf = (a) => Number(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0);
  const endOf = (a) => Number(a.DeductionEndTime || 0) || dms(a.CycleEndTime);
  const forever = (a) => endOf(a) > new Date('2030-01-01').getTime();

  const packs = [...allFree, ...allPaid]
    .filter((a) => remainOf(a) > 0)
    .map((a) => ({
      name: a.PackageName, remain: r2(remainOf(a)), size: r2(Number(a.CycleCapacitySize || 0)),
      end_ms: endOf(a), end: endOf(a) ? fmtMs(endOf(a)) : '—', forever: forever(a),
      created: a.CreateTime ? fmtMs(a.CreateTime) : '—',
    }))
    .sort((a, b) => a.end_ms - b.end_ms);

  const byDayMap = {};
  for (const p of packs) {
    const key = p.forever ? '长期有效' : (p.end || '—').slice(0, 10);
    (byDayMap[key] = byDayMap[key] || { credit: 0, count: 0, names: new Set() });
    byDayMap[key].credit += p.remain;
    byDayMap[key].count += 1;
    byDayMap[key].names.add(p.name);
  }
  const byDay = Object.entries(byDayMap)
    .map(([date, v]) => ({ date, credit: r2(v.credit), count: v.count, names: [...v.names] }))
    .sort((a, b) => (a.date === '长期有效' ? 1 : b.date === '长期有效' ? -1 : a.date.localeCompare(b.date)));
  const within = (days) => r2(byDay.filter((e) => e.date !== '长期有效'
    && (new Date(e.date + 'T23:59:59') - now) / 864e5 <= days).reduce((s, e) => s + e.credit, 0));

  const cycleUsed = r2((summary.CreditGroups || []).reduce((s, g) => s + Number(g.CycleUsedCapacity || 0), 0));
  const cycleTotal = r2((summary.Packages || []).reduce((s, p) => s + Number(p.CycleTotalCapacity || 0), 0));

  return {
    id: acct.id,
    label: acct.label,
    date: dayStr,
    at: nowStr,
    account: {
      plan: summary.SubscriptionPackageName || '—',
      is_paid: !!summary.IsPaidUser,
      balance: r2(Number(summary.TotalCredits || 0)),
      cycle_total: cycleTotal,
      cycle_used: cycleUsed,
      cycle_start: freeToday.find((a) => a.CycleStartTime)?.CycleStartTime || null,
      groups: (summary.CreditGroups || []).filter((g) => Number(g.CycleTotalCapacity) > 0)
        .map((g) => ({ name: g.Name, total: r2(Number(g.CycleTotalCapacity)), used: r2(Number(g.CycleUsedCapacity)), remain: r2(Number(g.CycleRemainCapacity)) })),
    },
    used: {
      credit: usedCredit,
      requests: rows.length,
      by_model: group((r) => r.model || '未知'),
      by_client: group((r) => r.client || '未知'),
      by_hour: group((r) => String(r.requestTime || '').slice(11, 13)).sort((a, b) => a.key.localeCompare(b.key)),
    },
    added: { credit: added, items: addedItems },
    net: r2(added - usedCredit),
    expiry: { within_7d: within(7), within_30d: within(30), by_day: byDay, packages: packs },
  };
}
