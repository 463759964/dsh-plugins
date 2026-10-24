/**
 * billing.mjs —— 账号额度查询
 *
 * 上游 `/billing/meter/get-user-resource-summary` 给的是「还剩多少」，
 * 和 usage-tracker 记的「今天花了多少」正好互补：一个看余额，一个看流水。
 *
 * 这个接口要联网，且每次调用都要拿令牌，所以缓存一小会儿，别让 CLI 每次都打它。
 */
import crypto from 'node:crypto';

const SUMMARY_PATH = '/billing/meter/get-user-resource-summary';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 上游把数字都存成了字符串，这里统一转成 number。 */
function normalizeGroup(g) {
  return {
    kind: g.Kind || g.kind || '',
    name: g.Name || g.name || '',
    total: num(g.CycleTotalCapacity),
    remain: num(g.CycleRemainCapacity),
    used: num(g.CycleUsedCapacity),
    frozen: num(g.CycleFrozenCapacity),
    unit: g.CapacityUnit || 'credits',
  };
}

export class BillingClient {
  constructor({ vault, gateway, fetchImpl, ttlMs = 60 * 1000 } = {}) {
    this.vault = vault;
    this.gateway = (gateway || 'https://copilot.tencent.com').replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.ttlMs = ttlMs;
    this.cache = null;
    this.cacheAt = 0;
  }

  /**
   * 查一次余额。
   * @param {boolean} force 忽略缓存
   * @returns {Promise<{totalCredits: number, planName: string, isPaidUser: boolean,
   *   groups: Array, packages: Array, fetchedAt: number}>}
   */
  async summary({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cacheAt < this.ttlMs) {
      return this.cache;
    }

    const token = await this.vault.getAccessToken();
    const res = await this.fetchImpl(`${this.gateway}${SUMMARY_PATH}`, {
      method: 'POST',
      headers: {
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
      },
      body: '{}',
    });

    if (!res.ok) {
      throw new Error(`查额度失败：HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body?.code !== 0) {
      throw new Error(`查额度失败：${body?.msg || `code ${body?.code}`}`);
    }

    const d = body.data || {};
    const out = {
      totalCredits: num(d.TotalCredits),
      planName: d.SubscriptionPackageName || '',
      isPaidUser: !!d.IsPaidUser,
      groups: Array.isArray(d.CreditGroups) ? d.CreditGroups.map(normalizeGroup) : [],
      packages: Array.isArray(d.Packages) ? d.Packages.map(normalizeGroup) : [],
      fetchedAt: Date.now(),
    };
    this.cache = out;
    this.cacheAt = out.fetchedAt;
    return out;
  }

  /** 总容量 = 各组 CycleTotalCapacity 之和；与 TotalCredits（剩余）配对展示。 */
  totalCapacity(summary) {
    return (summary?.groups || []).reduce((acc, g) => acc + g.total, 0);
  }
}
