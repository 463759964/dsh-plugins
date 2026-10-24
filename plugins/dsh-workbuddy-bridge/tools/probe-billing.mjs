/**
 * probe-billing.mjs —— 看清楚上游的额度/用量接口返回什么。
 *
 * 用法：node tools/probe-billing.mjs
 */

import crypto from 'node:crypto';
import { TokenVault } from '../lib/workbuddy-token.mjs';

const say = (s) => process.stdout.write(s + '\n');
const vault = new TokenVault({});
const token = await vault.getAccessToken();

const headers = () => ({
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
});

const get = async (method, path, body) => {
  const r = await fetch(`https://copilot.tencent.com${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

say('=== /billing/meter/get-user-resource-summary ===\n');
const summary = await get('POST', '/billing/meter/get-user-resource-summary', {});
say(JSON.stringify(summary.json, null, 1).slice(0, 4000));

say('\n\n=== /v2/accounts（账号身份）===\n');
const acc = await get('GET', '/v2/accounts');
if (acc.json?.data?.accounts) {
  for (const a of acc.json.data.accounts) {
    say(`uid=${a.uid} 昵称=${a.nickname} 类型=${a.type} 最近登录=${a.lastLogin}`);
  }
}
