#!/usr/bin/env node
/**
 * credits.mjs —— 看今天花了多少积分
 *
 *   node tools/credits.mjs                 今日消耗（默认顺带查余额）
 *   node tools/credits.mjs --watch 10      每 10 秒刷新一次
 *   node tools/credits.mjs --json          给脚本用
 *   node tools/credits.mjs --account 张三   看某个账号的账
 *   node tools/credits.mjs --days 14       近 14 天走势
 *   node tools/credits.mjs --no-balance    不联网，只看本地账本
 *
 * 数据从哪来：
 *   优先问运行中的桥接（GET /v1/usage），这样能顺带拿到上游余额。
 *   桥接没在跑就退回去直接读本地账本 ~/.dsh/workbuddy-usage.json —— 账本是桥接
 *   转发时顺手写下的，所以桥不跑也能看历史，只是余额查不了。
 *
 * 「跟随账号」是怎么做到的：桥接转发时把每一次消耗的 credit 按「账号 uid → 日期
 *   → 模型」落账，credit 本身就是上游按账号实算的，切了账号各记各的账，不会混。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { UsageTracker, UNKNOWN_UID } from '../lib/usage-tracker.mjs';
import { readSecretState } from '../lib/local-secret.mjs';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const DEFAULT_PORT = 8792;
const USAGE_FILE = path.join(os.homedir(), '.dsh', 'workbuddy-usage.json');

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    json: false,
    balance: true,
    watch: 0,
    days: 7,
    account: null,
    port: Number(process.env.WORKBUDDY_BRIDGE_PORT) || DEFAULT_PORT,
    help: false,
  };
  const read = (i, fallback) => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback);

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-balance') opts.balance = false;
    else if (a === '--balance') opts.balance = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--watch') {
      const v = read(i, null);
      const n = v === null ? 10 : Number(v);
      opts.watch = Number.isFinite(n) && n > 0 ? n : 10;
      if (v !== null) i += 1;
    } else if (a === '--days') {
      const n = Number(read(i, null));
      if (Number.isFinite(n) && n > 0) opts.days = Math.min(Math.floor(n), 30);
      i += 1;
    } else if (a === '--account') {
      opts.account = read(i, null);
      i += 1;
    } else if (a === '--port') {
      const n = Number(read(i, null));
      if (Number.isFinite(n) && n > 0) opts.port = Math.floor(n);
      i += 1;
    }
  }
  return opts;
}

function help() {
  process.stdout.write(`看今天在 WorkBuddy 上花了多少积分

  node tools/credits.mjs [选项]

选项
  --account <uid|名字>  看指定账号的账（默认看当前登录的那个）
  --days <n>            近 n 天走势，默认 7，最多 30
  --watch [秒]          持续刷新，默认每 10 秒（Ctrl+C 退出）
  --json                输出 JSON，方便脚本接
  --no-balance          不联网查余额，只看本地账本
  --port <n>            桥接端口，默认 ${DEFAULT_PORT}
  -h, --help            看这份说明

数据来源
  桥接在跑：问它要 /v1/usage，顺带拿上游余额
  桥接没跑：直接读本地账本 ${USAGE_FILE}
`);
}

/* -------------------------------------------------------------- 取数 */

/** 桥接在跑就问它要；拿不到（没起、端口错、密钥不对）就返回 null。 */
async function fetchFromBridge(opts) {
  const secret = readSecretState();
  if (!secret?.apiKey) return null;

  const qs = new URLSearchParams();
  if (opts.balance) qs.set('balance', '1');
  if (opts.account) qs.set('account', opts.account);
  qs.set('days', String(opts.days));

  const url = `http://127.0.0.1:${opts.port}/v1/usage?${qs}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret.apiKey}`, Host: `127.0.0.1:${opts.port}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { ...j, _from: 'bridge' };
  } catch {
    return null;
  }
}

/** 桥接没起时，自己从本机登录态认一下当前是哪个账号。 */
function localActiveAccount() {
  try {
    const list = new TokenVault().listPublic();
    const a = list.find((x) => x.isActive) || list[0];
    return a?.uid ? { uid: String(a.uid), name: a.name || '' } : null;
  } catch {
    return null;
  }
}

/** 桥接不在时自己读账本，尽力还原同样的结构。 */
function readLocalLedger(opts) {
  const tracker = new UsageTracker({ file: USAGE_FILE });
  const active = localActiveAccount();
  const picked = opts.account ? tracker.findAccount(opts.account) : null;
  // 显式指定 > 本机当前登录 > 账本里唯一有记录的那个
  const uid = picked ? picked.uid : active?.uid || tracker.defaultUid();
  const accounts = tracker.accounts();
  const today = tracker.day({ uid });
  const recent = tracker.recent(opts.days, uid);
  const total = tracker.total(uid);

  const out = {
    object: 'usage',
    account: {
      uid,
      name: picked?.name || active?.name || accounts.find((a) => a.uid === uid)?.name || '',
      isActive: !!active && active.uid === uid,
    },
    accounts: accounts.map((a) => ({
      uid: a.uid,
      name: a.name,
      credit: a.credit,
      requests: a.requests,
      days: a.days,
    })),
    today: {
      date: today.date,
      credit: today.credit,
      requests: today.requests,
      tokens: today.tokens,
      byModel: Object.entries(today.models || {})
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.credit - a.credit),
    },
    recent,
    total,
    _from: 'ledger',
    _ledgerExists: fs.existsSync(USAGE_FILE),
  };
  if (opts.balance) {
    out.balance = { error: '桥接没在跑，余额要联网查，起来桥接再看。' };
  }
  return out;
}

async function collect(opts) {
  // 桥接在跑就问它要（能顺带拿余额），否则退回去读本地账本
  const live = await fetchFromBridge(opts);
  return live || readLocalLedger(opts);
}

/* -------------------------------------------------------------- 渲染 */

const nf = new Intl.NumberFormat('zh-CN');

/** 积分显示：去掉多余的尾随 0，但别把 0 显示成空。 */
function fmtCredit(n) {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

const padR = (s, n) => String(s).padEnd(n, ' ');
const padL = (s, n) => String(s).padStart(n, ' ');

function render(r, opts) {
  const L = [];
  const acc = r.account || {};
  const who = [acc.name, acc.uid].filter(Boolean).join(' · ') || '未知账号';
  // 只有确实记到过消耗、却没认出归属，才值得提示
  const hasAny = (r.accounts || []).some((a) => (a.credit || 0) > 0 || (a.requests || 0) > 0);
  const isUnknown = acc.uid === UNKNOWN_UID && hasAny;

  L.push(`WorkBuddy 积分消耗 · ${who}`);
  if (isUnknown) {
    L.push('  （这批消耗没能认出账号归属，通常是因为记账时取不到登录态。）');
  }
  if (r._from === 'ledger') {
    if (!r._ledgerExists) {
      L.push('  （还没有任何记账记录。桥接会在每次转发时记一笔，用起来就有了。）');
    } else {
      L.push('  （桥接没在跑，这是本地账本里的历史数据。）');
    }
  } else if (!hasAny) {
    L.push('  （今天还没记到消耗。）');
  }
  L.push('');

  // 今日
  const t = r.today || {};
  L.push(`今日 ${t.date || '-'}`);
  L.push(
    `  已消耗 ${padL(fmtCredit(t.credit), 10)} 积分` +
      `   请求 ${padL(nf.format(t.requests || 0), 6)} 次` +
      `   tokens ${padL(nf.format(t.tokens || 0), 10)}`,
  );

  const byModel = Array.isArray(t.byModel) ? t.byModel : [];
  if (byModel.length) {
    L.push('  按模型');
    const w = Math.max(8, ...byModel.map((m) => m.model.length));
    for (const m of byModel) {
      L.push(`    ${padR(m.model, w)}  ${padL(fmtCredit(m.credit), 10)}   ${padL(nf.format(m.requests), 5)} 次`);
    }
  }
  L.push('');

  // 走势
  const recent = Array.isArray(r.recent) ? r.recent : [];
  if (recent.length) {
    L.push(`近 ${recent.length} 天`);
    const max = Math.max(...recent.map((d) => d.credit || 0), 0.0001);
    for (const d of recent) {
      const bar = '█'.repeat(Math.max(0, Math.round(((d.credit || 0) / max) * 24)));
      const mark = d.date === t.date ? '  ← 今天' : '';
      L.push(
        `  ${d.date}  ${padL(fmtCredit(d.credit), 10)}  ${padL(nf.format(d.requests || 0), 5)} 次  ${padR(bar, 24)}${mark}`,
      );
    }
    L.push('');
  }

  // 累计
  const total = r.total || {};
  if (total.days) {
    const span = total.from === total.to ? total.from : `${total.from} ~ ${total.to}`;
    L.push(
      `累计 ${fmtCredit(total.credit)} 积分 · ${nf.format(total.requests || 0)} 次请求` +
        `（${span}，${total.days} 天有记录）`,
    );
  }

  // 余额
  if (r.balance) {
    if (r.balance.error) {
      L.push(`余额 查不到：${r.balance.error}`);
    } else {
      const b = r.balance;
      const used = Number.isFinite(b.totalCapacity) && b.totalCapacity > 0
        ? ` · 已用 ${fmtCredit(b.totalCapacity - b.totalCredits)}/${fmtCredit(b.totalCapacity)}`
        : '';
      L.push(
        `余额 ${fmtCredit(b.totalCredits)} 积分${used}` +
          `${b.planName ? ` · ${b.planName}` : ''}${b.isPaidUser ? ' · 付费' : ''}`,
      );
    }
  }

  // 别的账号
  const others = (r.accounts || []).filter((a) => a.uid !== acc.uid && (a.credit > 0 || a.requests > 0));
  if (others.length) {
    L.push('');
    L.push(`其他账号（--account 切换）`);
    for (const a of others) {
      L.push(`  ${padR(a.name || a.uid, 20)} ${padL(fmtCredit(a.credit), 10)} 积分 · ${a.requests} 次`);
    }
  }

  if (opts.watch) {
    L.push('');
    L.push(`每 ${opts.watch} 秒刷新一次 · ${new Date().toLocaleTimeString('zh-CN')} · Ctrl+C 退出`);
  }

  return L.join('\n');
}

/* ------------------------------------------------------------------ 主流程 */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  help();
  process.exit(0);
}

async function once() {
  return collect(opts);
}

if (opts.json) {
  const r = await once();
  // 内部字段不对外
  const { _from, _ledgerExists, ...rest } = r;
  process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
  process.exit(0);
}

/** 指定的账号没对上时，说清楚回落到了谁，别让人以为看的就是它。 */
function accountMismatch(r) {
  if (!opts.account) return null;
  const q = String(opts.account).toLowerCase();
  const a = r.account || {};
  const hit =
    String(a.uid || '').toLowerCase().includes(q) || String(a.name || '').toLowerCase().includes(q);
  if (hit) return null;
  const avail = (r.accounts || []).map((x) => x.name || x.uid).join('、') || '账本里还没有别的账号';
  return `没找到账号「${opts.account}」，现在显示的是当前账号。账本里有：${avail}`;
}

async function draw() {
  const r = await once();
  if (opts.watch) {
    // 清屏并把光标挪回左上角，避免内容变短时留下残影
    process.stdout.write('\u001b[2J\u001b[H');
  }
  const warn = accountMismatch(r);
  if (warn) process.stdout.write(`${warn}\n\n`);
  process.stdout.write(`${render(r, opts)}\n`);
}

await draw();

if (opts.watch) {
  const timer = setInterval(() => {
    draw().catch((e) => {
      process.stdout.write(`\n刷新失败：${e.message}\n`);
    });
  }, opts.watch * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
