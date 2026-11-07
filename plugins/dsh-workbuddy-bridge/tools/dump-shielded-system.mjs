/**
 * dump-shielded-system.mjs —— 把最新 DSH 会话的 system 提示按 prompt-shield 规则净化后落盘，
 * 供 bisect-system.mjs 在「现役规则之后」的文本上继续二分。
 *
 * 用法：node tools/dump-shielded-system.mjs [session.jsonl.zstd]
 * 输出：logs/shielded-system-<时间戳>.txt 的路径
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { shieldText } from '../lib/prompt-shield.mjs';

function readZstdJsonl(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let text = '';
  for (let k = 0; k < starts.length; k += 1) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      text += zlib.zstdDecompressSync(seg).toString('utf8');
    } catch {
      /* 半帧跳过 */
    }
  }
  return text;
}

function newestSessionFile() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  let best = null;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) {
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return best ? best.path : null;
}

const explicit = process.argv[2];
const file = explicit ? path.resolve(explicit) : newestSessionFile();
if (!file) {
  console.error('没找到会话文件。');
  process.exit(1);
}
console.log('会话：', file);

const raw = file.endsWith('.zstd') ? readZstdJsonl(file) : fs.readFileSync(file, 'utf8');
const events = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const sys = events.filter((e) => e.type === 'system/message').pop();
if (!sys) {
  console.error('这个会话里没有 system/message 事件。');
  process.exit(1);
}
const content = sys.data?.message?.content;
const text = Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : String(content || '');

const { text: shielded, hits } = shieldText(text);
console.log('原长度：', text.length, '→ 净化后：', shielded.length, '；命中规则：', hits.join(', ') || '(无)');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `shielded-system-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
fs.writeFileSync(out, shielded);
console.log('已落盘：', out);
