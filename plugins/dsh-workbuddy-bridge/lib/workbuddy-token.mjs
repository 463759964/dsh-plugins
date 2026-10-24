/**
 * workbuddy-token.mjs
 *
 * 从本机 WorkBuddy 客户端的登录态里取出明文 access / refresh 令牌，并在过期前自动续期。
 *
 * 全程本机：
 *   1) 客户端把登录态以 {"$wbEncrypted":1,...} 信封（AES-256-GCM）存在 <用户数据>/auth/workbuddy-desktop.info；
 *   2) 借客户端自带的 Electron 运行时（ELECTRON_RUN_AS_NODE=1）调原生绑定
 *      electron_browser_workbuddy_storage.loggerGet() 拿到本机 atRestSecretKey；
 *   3) sha256 后得到 32 字节 AES 密钥（只经管道，不落盘），解开信封得到明文令牌；
 *   4) 客户端 < 5.6 时登录态本来就是明文，直接读取。
 *
 * 令牌只停留在内存里，不写日志、不进配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ACCOUNT_HOST = 'https://www.workbuddy.cn';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
/** 剩余有效期低于这个阈值就提前续期，避免请求打到一半过期。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/* ------------------------------ 定位客户端与登录态 ------------------------------ */

function exeCandidates() {
  const list = [];
  if (process.env.WORKBUDDY_EXE) list.push(process.env.WORKBUDDY_EXE);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    list.push(
      path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      path.join(local, 'Programs', 'workbuddy', 'WorkBuddy.exe'),
      'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
      'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
    );
  } else if (process.platform === 'darwin') {
    list.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
  } else {
    list.push('/usr/bin/workbuddy', '/opt/WorkBuddy/workbuddy');
  }
  return list;
}

/** 装到非默认目录时，从 Windows 卸载表项里读回安装位置。 */
function exeFromRegistry() {
  if (process.platform !== 'win32') return null;
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$p = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    "| Where-Object { $_.DisplayName -match 'WorkBuddy' }",
    "| Select-Object -First 1 -ExpandProperty DisplayIcon;",
    "if ($p) { Write-Output ($p -replace ',\\d+$','') }",
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  const p = (r.stdout || '').trim().split(/\r?\n/).pop();
  return p && fs.existsSync(p) ? p : null;
}

export function findWorkBuddyExe(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const p of exeCandidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 继续找下一个候选 */
    }
  }
  return exeFromRegistry();
}

export function findLoginInfo(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const tail = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'];
  const roots = [];
  if (process.platform === 'win32') {
    // LOCALAPPDATA 可能被改到别的盘，AppData\Local 的两个常见位置都试一遍
    for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, os.homedir()]) {
      if (base) roots.push(base);
    }
    const home = os.homedir();
    roots.push(path.join(home, 'AppData', 'Local'));
    roots.push(path.join(home, 'AppData', 'Roaming'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support'));
  } else {
    roots.push(path.join(os.homedir(), '.config'));
  }
  for (const r of roots) {
    const p = path.join(r, ...tail);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/* ---------------------------------- 取 AES 密钥 ---------------------------------- */

const KEY_SNIPPET = `
try {
  const binding = process._linkedBinding('electron_browser_workbuddy_storage');
  const payload = JSON.parse(binding.loggerGet());
  if (payload && payload.version === 1 && typeof payload.atRestSecretKey === 'string') {
    const key = require('crypto').createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    process.stdout.write('WB_BRIDGE_KEY ' + key.toString('base64') + '\\n');
    process.exit(0);
  }
  process.stderr.write('payload schema mismatch'); process.exit(4);
} catch (e) { process.stderr.write(String((e && e.message) || e).slice(0, 300)); process.exit(3); }
`;

function deriveAtRestKey(exe) {
  const tmp = path.join(os.tmpdir(), `wb-bridge-key-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, KEY_SNIPPET, 'utf8');
  try {
    const r = spawnSync(exe, [tmp], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = (r.stdout || '').match(/WB_BRIDGE_KEY ([A-Za-z0-9+/=]+)/);
    if (!m) {
      const why = ((r.stderr || '') + ` (exit=${r.status})`).trim().slice(0, 300);
      throw new Error(why || '客户端没有返回密钥');
    }
    return Buffer.from(m[1], 'base64');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉也无所谓 */
    }
  }
}

/* ----------------------------------- 解信封 ----------------------------------- */

const lp = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(4);
  l.writeUInt32BE(b.length);
  return Buffer.concat([l, b]);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function openEnvelope(v, key) {
  const env = JSON.parse(Buffer.from(v.envelope, 'base64').toString('utf8'));
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(env.suite || 1),
    lp(env.keyId || ''),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), {
    authTagLength: 16,
  });
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}

function plain(v, key) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string') {
    try {
      return openEnvelope(v, key);
    } catch {
      return null;
    }
  }
  return null;
}

/* ----------------------------------- 采集账号 ----------------------------------- */

/**
 * 读出本机所有已登录的 WorkBuddy 账号。
 * @returns {Array<{name:string, uid:string, accessToken:string, refreshToken:string, expiresAt:number|null, refreshExpiresAt:number|null}>}
 */
export function readLocalAccounts({ exePath, infoPath } = {}) {
  const info = findLoginInfo(infoPath);
  if (!info) {
    throw new Error(
      '没找到 WorkBuddy 登录态文件 workbuddy-desktop.info。请确认客户端已登录，并完全退出后重新打开一次。',
    );
  }

  let key = null;
  const exe = findWorkBuddyExe(exePath);
  if (exe) {
    try {
      key = deriveAtRestKey(exe);
    } catch {
      // 5.6 之前是明文，下面按明文读
    }
  }

  const found = new Map();
  const harvest = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const acc = entry.account || entry;
    const auth = entry.auth || entry;
    const at = plain(auth.accessToken ?? auth.access_token ?? auth.token, key);
    const rt = plain(auth.refreshToken ?? auth.refresh_token, key);
    if (!at || !acc || !acc.uid) return;
    const nb = plain(acc.nickname, key);
    const name = typeof nb === 'string' && nb.trim() ? nb.trim() : String(acc.uid).slice(0, 8);
    const exp = auth.expiresAt || 0;
    const prev = found.get(acc.uid);
    if (!prev || exp > prev.expiresAt) {
      found.set(acc.uid, {
        name,
        uid: acc.uid,
        accessToken: at,
        refreshToken: rt || '',
        expiresAt: auth.expiresAt || null,
        refreshExpiresAt: auth.refreshExpiresAt || null,
      });
    }
  };

  const readOne = (file) => {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      harvest(o);
      for (const a of o.accounts || []) harvest(a);
      for (const a of o.allAccounts || []) harvest(a);
    } catch {
      /* 单个文件读不动就跳过 */
    }
  };

  readOne(info);
  // 切号会留下历史快照，非当前账号可能只在这些快照里
  const dir = path.dirname(info);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n === path.basename(info)) continue;
      if (n.startsWith('workbuddy-desktop.') && n.includes('.info')) readOne(path.join(dir, n));
    }
  } catch {
    /* 目录扫不动就算了 */
  }

  const out = [...found.values()];
  if (out.length === 0) {
    throw new Error('登录态里没有解出任何令牌：客户端可能未登录，或者取密钥失败。');
  }
  return out;
}

/* ----------------------------------- 令牌续期 ----------------------------------- */

async function refreshOne(account, fetchImpl) {
  if (!account.refreshToken) return false;
  const res = await fetchImpl(`${ACCOUNT_HOST}${REFRESH_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.accessToken}`,
      'X-Refresh-Token': account.refreshToken,
    },
  });
  if (!res.ok) return false;
  const d = await res.json().catch(() => null);
  if (!d) return false;
  const at = d.accessToken || d.access_token;
  const rt = d.refreshToken || d.refresh_token;
  if (!at) return false;
  account.accessToken = at;
  if (rt) account.refreshToken = rt;
  const inMs = (d.expiresIn ?? d.expires_in ?? 2592000) * 1000;
  account.expiresAt = d.expiresAt ?? d.expires_at ?? Date.now() + inMs;
  if (d.refreshExpiresAt ?? d.refresh_expires_at) {
    account.refreshExpiresAt = d.refreshExpiresAt ?? d.refresh_expires_at;
  }
  return true;
}

/**
 * 令牌管家：按需取号、按需续期，令牌只留在内存里。
 */
export class TokenVault {
  constructor(opts = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.accounts = null;
    this.activeUid = opts.uid || null;
    this.refreshing = null;
  }

  /** 载入本机账号（只做一次，之后复用内存里的副本）。 */
  load() {
    if (!this.accounts) {
      this.accounts = readLocalAccounts({
        exePath: this.opts.exePath,
        infoPath: this.opts.infoPath,
      });
      if (this.activeUid) {
        const hit = this.accounts.find((a) => a.uid === this.activeUid);
        if (!hit) this.activeUid = null;
      }
    }
    return this.accounts;
  }

  current() {
    const list = this.load();
    if (this.activeUid) return list.find((a) => a.uid === this.activeUid) || list[0];
    return list[0];
  }

  listPublic() {
    return this.load().map((a) => ({
      name: a.name,
      uid: a.uid,
      isActive: a.uid === (this.activeUid || this.load()[0]?.uid),
      accessExpiresAt: a.expiresAt,
      refreshExpiresAt: a.refreshExpiresAt,
    }));
  }

  select(uid) {
    const list = this.load();
    const hit = list.find((a) => a.uid === uid || a.name === uid);
    if (!hit) return false;
    this.activeUid = hit.uid;
    return true;
  }

  /** 上游判定令牌失效后调用：丢弃本地副本，下次取号会重新读登录态（客户端自己会续）。 */
  invalidate() {
    const active = this.activeUid;
    this.accounts = null;
    this.load();
    if (active) this.activeUid = active;
  }

  /** 取一个有效期足够的 accessToken；同一时刻只允许一个续期在跑。 */
  async getAccessToken() {
    const acc = this.current();
    if (!acc) throw new Error('本机没有可用的 WorkBuddy 登录账号。');
    const exp = acc.expiresAt || 0;
    if (exp && exp - Date.now() > REFRESH_MARGIN_MS) return acc.accessToken;

    if (!this.refreshing) {
      this.refreshing = refreshOne(acc, this.fetchImpl)
        .then((ok) => {
          if (!ok) {
            // 本地副本过期但续期失败时，重新读一次登录态——客户端自己会续，我们跟着拿新的
            this.accounts = null;
            this.load();
          }
          return ok;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
    return this.current()?.accessToken || acc.accessToken;
  }
}
