#!/usr/bin/env node
/**
 * dsh-session-purge 卸载器 —— 移除插件目录与它在 cordis.patch.yml 里的那一行。
 *
 * 用法：
 *   node uninstall.mjs                 # desktop profile
 *   node uninstall.mjs --profile web
 *   node uninstall.mjs --home D:\x\.dsh --dry-run
 *
 * 只删自己：id=session-purge 的 insert 行 + 对应的 3 行注释 + 包目录。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-session-purge'
const ROW_ID = 'session-purge'
const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const options = { profile: 'desktop', home: undefined, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') options.profile = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true
  }
  return options
}

function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * 删掉 `- insert:` 里仅剩 session-purge 的那一行；`- insert:` 自己若因此空了也删掉。
 * 用一个按行的小状态机，避免误删别的行。
 */
function stripRow(text) {
  const lines = text.split('\n')
  const out = []
  let removed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!new RegExp(`^\\s*-\\s*id:\\s*['"]?${ROW_ID}['"]?\\s*$`).test(line)) {
      out.push(line)
      continue
    }
    removed = true
    // 跳过紧随其后的 name: 行与它的续行（本行块通常只有 id + name）。
    while (index + 1 < lines.length && /^\s+name:\s/.test(lines[index + 1])) index += 1
  }
  if (!removed) return { text, removed: false }

  // 清理注释尾巴与空掉的 insert 列表。
  const cleaned = []
  for (let index = 0; index < out.length; index += 1) {
    const line = out[index]
    if (/^#\s*dsh-session-purge/.test(line) || /^#\s*路径默认跟随/.test(line)) continue
    if (/^\s*- insert:\s*$/.test(line)) {
      const next = out[index + 1]
      if (next === undefined || next.trim() === '' || /^\S/.test(next)) continue
    }
    cleaned.push(line)
  }
  return { text: cleaned.join('\n').replace(/\n{3,}/g, '\n\n'), removed: true }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const home = resolveHome(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const target = join(profileDir, 'node_modules', PACKAGE)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const stripped = stripRow(patchText)

  process.stdout.write(`package : ${target} ${existsSync(target) ? '(存在)' : '(不存在)'}\n`)
  process.stdout.write(`patch   : ${patchPath} ${stripped.removed ? '(将移除插件行)' : '(无插件行)'}\n`)

  if (options.dryRun) {
    process.stdout.write('dry-run：没有改动任何文件。\n')
    return
  }

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
    process.stdout.write('✓ 已删除插件目录\n')
  }
  if (stripped.removed) {
    writeFileSync(patchPath, stripped.text, 'utf8')
    process.stdout.write('✓ 已从 cordis.patch.yml 移除插件行\n')
  }
  process.stdout.write('完成。重启 DSH 后侧边栏入口消失。\n')
}

main()
