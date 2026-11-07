/**
 * push-to-github.mjs —— 用 Git Data API 把本地插件目录同步到 GitHub 仓库
 * （本机到 github.com 的 git 协议被代理挡住，api.github.com 可通，所以走 REST）
 *
 * 只推内容有变化的文件：先递归取远端 tree，按 git blob sha 与本地逐文件比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.GH_TOKEN;
const OWNER = '463759964';
const REPO = 'dsh-plugins';
const BRANCH = 'main';
const LOCAL_ROOT = 'C:/Users/46375/WorkBuddy/dsh-workbuddy-bridge';
const REPO_PREFIX = 'plugins/dsh-workbuddy-bridge';
const SKIP_DIRS = new Set(['logs', 'node_modules', '.git']);
const MESSAGE = process.env.COMMIT_MSG || 'fix(bridge): developer 角色改名 system，修复渠道判定 502';

const api = async (p, init = {}) => {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-workbuddy-bridge-push',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(p, out);
    } else if (name !== '.DS_Store') {
      out.push(p);
    }
  }
  return out;
}

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const parentCommit = ref.object.sha;
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${parentCommit}`);
const baseTree = commit.tree.sha;

const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/${baseTree}?recursive=1`);
const remoteSha = new Map();
for (const node of tree.tree) {
  if (node.type === 'blob' && node.path.startsWith(`${REPO_PREFIX}/`)) {
    remoteSha.set(node.path.slice(REPO_PREFIX.length + 1), node.sha);
  }
}

const localFiles = walk(LOCAL_ROOT);
const FULL = process.argv.includes('--full') || process.env.FULL === '1';
const changed = [];
for (const file of localFiles) {
  const rel = path.relative(LOCAL_ROOT, file).split(path.sep).join('/');
  const buf = fs.readFileSync(file);
  const sha = blobSha(buf);
  if (FULL || remoteSha.get(rel) !== sha) changed.push({ rel, buf, sha });
  remoteSha.delete(rel);
}

console.log(`本地文件 ${localFiles.length} 个；需要更新 ${changed.length} 个；远端多出 ${remoteSha.size} 个${FULL ? '（全量模式：全部重传）' : ''}`);
for (const c of changed) console.log(FULL && remoteSha.size === 0 && localFiles.length === changed.length ? '  -' : '  改:', c.rel);
for (const r of remoteSha.keys()) console.log('  删除（本地已无）:', r);

if (!changed.length && !remoteSha.size) {
  console.log('没有内容变化，无需提交。');
  process.exit(0);
}

const entries = [];
for (const c of changed) {
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: c.buf.toString('base64'), encoding: 'base64' }),
  });
  entries.push({ path: `${REPO_PREFIX}/${c.rel}`, mode: '100644', type: 'blob', sha: blob.sha });
}
// 远端有、本地没有的文件：树里给 sha=null 即删除，做到「完全覆盖」
for (const rel of remoteSha.keys()) {
  entries.push({ path: `${REPO_PREFIX}/${rel}`, mode: '100644', type: 'blob', sha: null });
}

const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: baseTree, tree: entries }),
});

const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message: MESSAGE, tree: newTree.sha, parents: [parentCommit] }),
});

await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: newCommit.sha, force: false }),
});

console.log('已提交：', newCommit.sha);
console.log('链接：', `https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
