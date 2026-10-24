#!/usr/bin/env node
/**
 * dsh-session-purge 安装器 —— 把插件装进某个 DSH profile，并登记一行 patch。
 *
 * 用法（在任意机器上）：
 *   node install.mjs                 # 装进 desktop profile
 *   node install.mjs --profile web   # 装进 web profile
 *   node install.mjs --home D:\x\.dsh
 *   node install.mjs --dry-run
 *
 * 做的事只有两件，都可重复执行：
 *   1) 把本目录（lib/、client.js、package.json、cordis.patch.yml）复制到
 *      <DSH_HOME>/profiles/<profile>/node_modules/dsh-session-purge
 *   2) 在该 profile 的 cordis.patch.yml 末尾确保存在 id=session-purge 的 insert 行
 *
 * 不碰 cordis.yml、不碰 package-lock、不改任何其它插件行。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-session-purge'
const ROW_ID = 'session-purge'
const HERE = dirname(fileURLToPath(import.meta.url))

/** 只在真正需要落盘的运行时才接受拷贝的文件/目录。 */
const SHIP = ['lib', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

function parseArgs(argv) {
  const options = { profile: 'desktop', home: undefined, dryRun: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') options.profile = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'node install.mjs [--profile desktop|web|<name>] [--home <DSH_HOME>] [--dry-run] [--force]\n',
      )
      process.exit(0)
    }
  }
  return options
}

function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 在 patch 文本里查 id=session-purge 的 insert 行（只看行首缩进后的 `- id:`）。 */
function hasRow(patchText) {
  return new RegExp(`^\\s*-\\s*id:\\s*['"]?${ROW_ID}['"]?\\s*$`, 'm').test(patchText)
}

/**
 * 把插件行并入现有 patch 文本。
 *
 * 空模板（shipped profile 的 `[]`）必须整体替换，否则追加会得到 `[]` 后面再挂
 * 一个列表项 —— 不是合法 YAML。已有条目的文件则安全追加。
 * @param existing - 现有 patch 文本（可能为空）。
 * @returns 合并后的文本。
 */
function mergePatch(existing) {
  const block =
    '# dsh-session-purge —— 侧边栏批量彻底删除会话。\n' +
    '# 路径默认跟随 $DSH_HOME（或 ~/.dsh），换机器无需改配置。\n' +
    '- insert:\n' +
    `    - id: ${ROW_ID}\n` +
    `      name: '${PACKAGE}'\n`

  // 去掉注释与空白后只剩 `[]`（或什么都没有） = 空模板。
  const meaningful = existing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('')
  if (meaningful === '' || meaningful === '[]') return block

  const before = existing.endsWith('\n') || existing === '' ? existing : `${existing}\n`
  return `${before}\n${block}`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const home = resolveHome(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const target = join(profileDir, 'node_modules', PACKAGE)
  const patchPath = join(profileDir, 'cordis.patch.yml')

  if (!existsSync(profileDir)) {
    process.stderr.write(
      `找不到 profile 目录：${profileDir}\n` +
        `先启动一次该 profile（或把 --profile / --home 换成实际值）再装。\n`,
    )
    process.exit(1)
  }

  process.stdout.write(`profile : ${profileDir}\n`)
  process.stdout.write(`target  : ${target}\n`)

  if (options.dryRun) {
    process.stdout.write(`patch   : ${patchPath}（${existsSync(patchPath) ? '已存在' : '将新建'}${hasRow(safeRead(patchPath)) ? '，已有插件行' : '，将追加插件行'}）\n`)
    process.stdout.write('dry-run：没有写入任何文件。\n')
    return
  }

  // 1) 复制包体。先删旧目录，避免上次残留的半旧文件混进新版本。
  if (existsSync(target) && !options.force) {
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(target, { recursive: true })
  for (const entry of SHIP) {
    const source = join(HERE, entry)
    if (!existsSync(source)) continue
    cpSync(source, join(target, entry), { recursive: true })
  }
  process.stdout.write(`✓ 已复制插件文件\n`)

  // 2) 登记 patch 行（幂等）。
  const existing = safeRead(patchPath)
  if (hasRow(existing)) {
    process.stdout.write('✓ cordis.patch.yml 已有插件行，未改动\n')
  } else {
    writeFileSync(patchPath, mergePatch(existing), 'utf8')
    process.stdout.write(`✓ 已写入插件行到 ${patchPath}\n`)
  }

  process.stdout.write(
    '\n完成。重启 DSH（桌面端直接退出重开）后，侧边栏底部会出现「清理会话」按钮，\n' +
      '每个会话的「…」菜单里也会多一项「彻底删除」。\n' +
      '卸载：node uninstall.mjs --profile ' +
      options.profile +
      '\n',
  )
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

main()
