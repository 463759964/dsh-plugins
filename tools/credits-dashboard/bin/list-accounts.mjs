import { libUrl } from './_lib.mjs';

const { TokenVault } = await import(libUrl() + 'workbuddy-token.mjs');
const v = new TokenVault({});
const all = v.load();
console.log('本机登录态中账号数:', all.length);
for (const a of all) {
  console.log(' -', JSON.stringify({ name: a.name, uid: a.uid, hasAccess: !!a.accessToken, accessExp: a.expiresAt ? new Date(a.expiresAt).toLocaleString('zh-CN') : null }));
}
console.log('public:', JSON.stringify(v.listPublic(), null, 1));
