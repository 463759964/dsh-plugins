/**
 * usage-tracker.mjs —— 积分消耗累加器（按账号分桶）
 *
 * 桥接坐在「DSH ↔ WorkBuddy 网关」的必经之路上，所以每次调用的消耗可以从
 * 上游 SSE 的 `usage.credit` 里直接读出来，按「账号 → 本地日期 → 模型」累加。
 *
 * 为什么自己累加而不是查上游：上游只有「周期用量」接口（CycleUsedCapacity），
 * 给不了「今天花了多少」。而 credit 是上游按本次调用实算出来的，跟着账号走，
 * 限免的模型会给 0 —— 这正是我们要的口径。
 *
 * 按账号分桶是刻意的：credit 本身就是上游按账号算的，多账号共存时混在一起
 * 就成了谁也说不清的一笔糊涂账。切账号看 `--account`，老数据归到各自的 uid 下。
 *
 * 数据落在 ~/.dsh/workbuddy-usage.json，每个账号只留最近 30 天。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_FILE = path.join(os.homedir(), '.dsh', 'workbuddy-usage.json');
const KEEP_DAYS = 30;
const VERSION = 2;
/** 拿不到 uid 时的兜底桶（上游没回身份、或账号信息损坏）。 */
export const UNKNOWN_UID = 'unknown';

/** 本地日期键（YYYY-MM-DD）。刻意用本地时区：用户说的「今日」是他墙上的今天。 */
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function emptyDay(date) {
  return { date, credit: 0, requests: 0, tokens: 0, models: {} };
}

/** 把一个「日期 → 汇总」的映射累加进另一个。 */
function mergeDays(target, src) {
  for (const [date, d] of Object.entries(src || {})) {
    if (!d || typeof d !== 'object') continue;
    const t = (target[date] ||= { credit: 0, requests: 0, tokens: 0, models: {} });
    t.credit = round4(t.credit + (d.credit || 0));
    t.requests += d.requests || 0;
    t.tokens += d.tokens || 0;
    for (const [mid, m] of Object.entries(d.models || {})) {
      if (!m || typeof m !== 'object') continue;
      const tm = (t.models[mid] ||= { credit: 0, requests: 0, tokens: 0 });
      tm.credit = round4(tm.credit + (m.credit || 0));
      tm.requests += m.requests || 0;
      tm.tokens += m.tokens || 0;
    }
  }
  return target;
}

/** 把一个「账号 → 汇总」的映射累加进另一个。 */
function mergeAccounts(target, src) {
  for (const [uid, a] of Object.entries(src || {})) {
    if (!a || typeof a !== 'object') continue;
    const t = (target[uid] ||= { name: '', days: {} });
    if (a.name) t.name = a.name;
    mergeDays(t.days, a.days);
  }
  return target;
}

export class UsageTracker {
  constructor({ file = DEFAULT_FILE } = {}) {
    this.file = file;
    this.dirty = false;
    this.flushTimer = null;
    /** 待落盘的增量（账号 → 日期 → 模型）。flush 时合到磁盘最新内容上。 */
    this.pending = {};
    /**
     * v1 老账本迁移过来的日子。老格式没有账号维度，等第一次 record 知道了
     * 当前 uid 再并进去，免得一上来就猜错归属。
     */
    this.pendingLegacy = null;
    // load() 会把 v1 老数据塞进 pendingLegacy，所以这几个字段得先就位
    this.data = this.load();
  }

  /* ------------------------------------------------------------ 持久化 */

  /**
   * 读盘。返回干净的 accounts 结构；碰上 v1 老格式就把 days 挑出来塞进 legacy，
   * 等知道当前账号是谁了再并进去。
   */
  readFile() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* 文件不存在或坏了，从空账本开始 */
    }
    if (!parsed || typeof parsed !== 'object') return { accounts: {}, legacy: null };

    // v2：按账号分桶
    if (parsed.accounts && typeof parsed.accounts === 'object') {
      const accounts = {};
      for (const [uid, a] of Object.entries(parsed.accounts)) {
        if (!a || typeof a !== 'object') continue;
        accounts[uid] = { name: a.name || '', days: a.days && typeof a.days === 'object' ? a.days : {} };
      }
      return { accounts, legacy: null };
    }

    // v1：只有 days，没有账号维度
    if (parsed.days && typeof parsed.days === 'object') {
      return { accounts: {}, legacy: parsed.days };
    }

    return { accounts: {}, legacy: null };
  }

  load() {
    const { accounts, legacy } = this.readFile();
    if (legacy) this.pendingLegacy = legacy;
    return { version: VERSION, accounts };
  }

  /**
   * 落盘：读最新 + 合上我的增量 + 原子写回。
   *
   * 为什么不是「直接写内存里的全量」：桥接经常不止一个进程（DSH 内的插件
   * 自己起一个，用户排查问题时又手动起一个），每个进程只攒着自己的那部分。
   * 谁最后写谁就把别人的整份账盖掉——所以这里只提交增量，顺序无所谓。
   */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const hasPending = Object.keys(this.pending).length > 0;
    if (!hasPending && !this.dirty) return;
    this.dirty = false;

    const onDisk = this.readFile();
    let legacy = onDisk.legacy;

    // 老格式没有账号维度：如果这一轮只服务了一个账号，就认到它头上
    if (legacy) {
      const uids = Object.keys(this.pending);
      if (uids.length === 1) {
        const pAcc = (this.pending[uids[0]] ||= { name: '', days: {} });
        mergeDays(pAcc.days, legacy);
        legacy = null;
      }
    }

    mergeAccounts(onDisk.accounts, this.pending);
    this.pending = {};
    // 查询看到的从此刻起是「磁盘全量」，别的进程记的账也在里面了
    this.data = { version: VERSION, accounts: onDisk.accounts };
    this.pendingLegacy = legacy;

    this.prune();
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 清理失败就算了 */
      }
    }
  }

  /** 延迟落盘：流式请求很密集，没必要每个字都写一次盘。 */
  scheduleFlush(delayMs = 3000) {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), delayMs);
    // 别因为这个定时器挡住进程退出
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /**
   * 裁掉 KEEP_DAYS 天之前的记录。
   *
   * 按日期划线而不是「只留最近 30 条」：后者在用户隔了两个月没用的时候，
   * 会把一条孤零零的旧记录一直留在账本里。YYYY-MM-DD 可以直接比字符串。
   */
  prune() {
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86400000));
    for (const acc of Object.values(this.data.accounts)) {
      for (const k of Object.keys(acc.days)) {
        if (k < cutoff) delete acc.days[k];
      }
    }
  }

  bucket(uid, name = '') {
    const key = String(uid || UNKNOWN_UID);
    const acc = (this.data.accounts[key] ||= { name: '', days: {} });
    // 名字会变（用户在 WorkBuddy 里改昵称），以最新一次看到的为准
    if (name && acc.name !== name) {
      acc.name = name;
      this.dirty = true;
    }
    return acc;
  }

  /* -------------------------------------------------------------- 记账 */

  /**
   * 记一次调用。
   * @param {object} entry
   * @param {string} entry.model    模型 id
   * @param {number} entry.credit   本次消耗的积分（限免模型会给 0）
   * @param {number} [entry.tokens] 本次总 token 数
   * @param {string} [entry.uid]    账号 uid；不传归到 unknown 桶
   * @param {string} [entry.accountName] 账号昵称
   */
  record({ model, credit = 0, tokens = 0, uid = UNKNOWN_UID, accountName = '', at = new Date() } = {}) {
    const key0 = String(uid || UNKNOWN_UID);
    const acc = this.bucket(key0, accountName);
    this.adoptLegacy(acc);

    const key = dayKey(at);
    const c = Number.isFinite(credit) ? credit : 0;
    const t = Number.isFinite(tokens) ? tokens : 0;
    const mid = String(model || 'unknown');

    // 内存里记一份，查询走它
    const day = (acc.days[key] ||= { credit: 0, requests: 0, tokens: 0, models: {} });
    day.credit = round4(day.credit + c);
    day.requests += 1;
    day.tokens += t;

    const m = (day.models[mid] ||= { credit: 0, requests: 0, tokens: 0 });
    m.credit = round4(m.credit + c);
    m.requests += 1;
    m.tokens += t;

    // 再攒一份增量，flush 时合到磁盘最新内容上
    const pAcc = (this.pending[key0] ||= { name: accountName || '', days: {} });
    if (accountName) pAcc.name = accountName;
    const pDay = (pAcc.days[key] ||= { credit: 0, requests: 0, tokens: 0, models: {} });
    pDay.credit = round4(pDay.credit + c);
    pDay.requests += 1;
    pDay.tokens += t;

    const pM = (pDay.models[mid] ||= { credit: 0, requests: 0, tokens: 0 });
    pM.credit = round4(pM.credit + c);
    pM.requests += 1;
    pM.tokens += t;

    this.scheduleFlush();
    return { date: key, credit: c, tokens: t };
  }

  /** 老账本没有账号维度，第一次知道当前 uid 时并进去。 */
  adoptLegacy(acc) {
    if (!this.pendingLegacy) return;
    const legacy = this.pendingLegacy;
    this.pendingLegacy = null;
    for (const [date, d] of Object.entries(legacy)) {
      if (!d || typeof d !== 'object') continue;
      const target = (acc.days[date] ||= { credit: 0, requests: 0, tokens: 0, models: {} });
      target.credit = round4(target.credit + (d.credit || 0));
      target.requests += d.requests || 0;
      target.tokens += d.tokens || 0;
      for (const [mid, m] of Object.entries(d.models || {})) {
        if (!m || typeof m !== 'object') continue;
        const t = (target.models[mid] ||= { credit: 0, requests: 0, tokens: 0 });
        t.credit = round4(t.credit + (m.credit || 0));
        t.requests += m.requests || 0;
        t.tokens += m.tokens || 0;
      }
    }
  }

  /* -------------------------------------------------------------- 查询 */

  /**
   * 某个账号某天的汇总。
   * @param {object}  [opts]
   * @param {string}  [opts.uid]  - 不传就用「最近有记录且唯一的那个」，再不行 unknown
   * @param {string}  [opts.date] - 不传给今天
   */
  day({ uid, date = dayKey() } = {}) {
    const key = String(uid || this.defaultUid());
    const d = this.data.accounts[key]?.days?.[date];
    if (!d) return emptyDay(date);
    return { date, ...d };
  }

  /** 最近 n 天，按日期升序。 */
  recent(n = 7, uid) {
    const key = String(uid || this.defaultUid());
    const days = this.data.accounts[key]?.days || {};
    return Object.keys(days)
      .sort()
      .slice(-n)
      .map((date) => ({ date, ...days[date] }));
  }

  /** 累计（有记录以来的第一天算起，最多 30 天）。 */
  total(uid) {
    const key = String(uid || this.defaultUid());
    const days = this.data.accounts[key]?.days || {};
    const keys = Object.keys(days).sort();
    let credit = 0;
    let requests = 0;
    let tokens = 0;
    for (const k of keys) {
      const d = days[k];
      credit += d.credit || 0;
      requests += d.requests || 0;
      tokens += d.tokens || 0;
    }
    return {
      from: keys[0] || null,
      to: keys[keys.length - 1] || null,
      days: keys.length,
      credit: round4(credit),
      requests,
      tokens,
    };
  }

  /** 所有有记录的账号。 */
  accounts() {
    return Object.entries(this.data.accounts)
      .map(([uid, a]) => ({
        uid,
        name: a.name || '',
        days: Object.keys(a.days).length,
        ...this.total(uid),
      }))
      .sort((a, b) => b.credit - a.credit);
  }

  /** 找到某个账号（按 uid 或名字，模糊匹配）。 */
  findAccount(query) {
    if (!query) return null;
    const q = String(query).toLowerCase();
    const list = this.accounts();
    return (
      list.find((a) => a.uid.toLowerCase() === q) ||
      list.find((a) => a.name.toLowerCase() === q) ||
      list.find((a) => a.name.toLowerCase().includes(q)) ||
      list.find((a) => a.uid.toLowerCase().startsWith(q)) ||
      null
    );
  }

  /** 不指定账号时用哪个：唯一有记录的那个；有老数据待归并时也认它。 */
  defaultUid() {
    const list = this.accounts();
    if (list.length === 1) return list[0].uid;
    if (list.length === 0) return UNKNOWN_UID;
    return list[0].uid;
  }
}

/**
 * 从上游 SSE 的一帧里抽出本次消耗。
 * 上游把 credit 放在 usage 里，且只在收尾的那一帧给；中途帧的 usage 是 null 或缺字段。
 * @returns {{credit: number, tokens: number}|null}
 */
export function extractUsage(frame) {
  const u = frame?.usage;
  if (!u || typeof u !== 'object') return null;
  const credit = Number(u.credit);
  const tokens = Number(u.total_tokens ?? u.totalTokens);
  if (!Number.isFinite(credit) && !Number.isFinite(tokens)) return null;
  return {
    credit: Number.isFinite(credit) ? credit : 0,
    tokens: Number.isFinite(tokens) ? tokens : 0,
  };
}
