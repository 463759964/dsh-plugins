/**
 * strip-provider.mjs —— 把 workbuddy provider 块从 patch 文件里摘掉（不写回原文件）
 *
 *   node tools/strip-provider.mjs <file> <outFile>
 *
 * 安装器内部已经自带这个能力，这里单独拎出来是为了排查问题时能手动还原配置。
 */
import fs from 'node:fs';

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('用法：node tools/strip-provider.mjs <file> <outFile>');
  process.exit(1);
}

const text = fs.readFileSync(inFile, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const start = lines.findIndex((l) => /^\s{6}workbuddy:\s*$/.test(l));
if (start === -1) {
  console.error('文件里没有 workbuddy 块');
  process.exit(1);
}

let end = start + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === '') break;
  if (/^\s{0,5}\S/.test(l)) break;
  if (/^\s{6}\S/.test(l)) break;
  end += 1;
}

const next = [...lines.slice(0, start), ...lines.slice(end)];
let provIdx = -1;
for (let i = start - 1; i >= 0; i -= 1) {
  if (/^\s{4}providers:/.test(lines[i])) {
    provIdx = i;
    break;
  }
}
if (provIdx !== -1) {
  const after = next[provIdx + 1] || '';
  if (after.trim() === '' || /^\s{0,4}\S/.test(after)) next[provIdx] = '    providers: {}';
}

fs.writeFileSync(outFile, next.join(eol), 'utf8');
console.log(`已写出 ${outFile}（${next.join(eol).length} 字节）`);
