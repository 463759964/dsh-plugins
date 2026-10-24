#!/usr/bin/env node
/**
 * test-junction-safety.mjs —— 验证卸载/重装不会顺着 junction 删掉源工程
 *
 *   node tools/test-junction-safety.mjs
 *
 * 起因：profile 里的包目录被换成了 junction（这样改代码即时生效），而 junction
 * 在 lstat 下看起来跟普通目录一样，`isSymbolicLink()` 认不出它。安装器重跑时要先
 * 删掉这个目录，万一用了 `rmSync({recursive:true})` 又跟进了链接，源工程就没了。
 *
 * 这里造一个真的 junction，跑一遍 install.mjs 里那段删除逻辑，确认：
 * 链接摘掉了，源目录里的文件一个不少。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

let failed = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failed += 1;
};

/* ---- 复刻 install.mjs 里的 removePackageDir（保持同步） ---- */
function removePackageDir(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }
  try {
    if (fs.readlinkSync(p)) {
      fs.rmdirSync(p);
      return;
    }
  } catch {
    /* 读不出目标 = 真目录，交给下面的递归删 */
  }
  fs.rmSync(p, { recursive: true, force: true });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-junction-'));
const src = path.join(tmp, 'src');
const link = path.join(tmp, 'link');
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, 'a.txt'), '重要内容');
fs.writeFileSync(path.join(src, 'b.txt'), '也很重要');
fs.mkdirSync(path.join(src, 'lib'));
fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'export function apply() {}');

console.log('\njunction 安全测试');
try {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, src], { stdio: 'ignore' });
} catch {
  console.log('  （这台机器建不了 junction，跳过）');
  process.exit(0);
}

ok(fs.existsSync(link), 'junction 建好了');
ok(fs.readdirSync(src).length === 3, `源目录里有 3 项：${fs.readdirSync(src).join(', ')}`);

removePackageDir(link);

ok(!fs.existsSync(link), '链接被摘掉了');
ok(fs.existsSync(src), '源目录还在');
ok(fs.existsSync(path.join(src, 'a.txt')), '源文件 a.txt 还在');
ok(fs.existsSync(path.join(src, 'lib', 'index.js')), '源子目录里的文件也还在');
ok(fs.readdirSync(src).length === 3, '源文件一个没少');

console.log(`\n${failed === 0 ? '通过：卸载不会误删源工程' : `失败 ${failed} 项`}`);
process.exit(failed > 0 ? 1 : 0);
