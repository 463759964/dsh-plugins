/**
 * dsh-session-purge —— Host 半侧
 *
 * 为浏览器半侧提供一条 Package 私有 HTTP 桥接：`POST /session-purge/api`。
 *
 *   overview  盘上每个会话的占用、孤儿目录、孤儿投影缓存
 *   delete    彻底删除指定会话：
 *              1) 先停掉该会话仍在跑的 agent（cancel + 等空闲）
 *              2) 清 workspace 记账 / 归档 / 置顶
 *              3) 删磁盘日志目录  <root>/<projectDir>/<encode(id)>
 *              4) 删投影缓存      <storages>/session_projcache/sessions/<id>.json
 *   orphans   只清孤儿（盘上有、登记里没有的目录与缓存）
 *
 * 为什么走 webServer 具名路由而不是 typert @Remote：
 * 本包刻意保持零外部依赖（profile 下解析不到 harness 内部包），具名路由是
 * 最小且稳定的接缝；跨源请求由 Origin/Host 校验挡住（只有同源/回环才放行）。
 */
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'session-purge'

/** 只硬依赖 HTTP 载体；会话持久化 / 工作区 / agent 注册表都按可选服务取。 */
export const inject = ['webServer']

/** 请求体上限：一次删除几千个 id 也远用不到。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 会话 id 必须是单个安全路径段（真正的转义仍由 encodeSegment 负责）。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** 解析 DSH 主目录：显式环境变量优先，Windows 上 HOME 常空，回退 homedir()。 */
function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * 与 dsh-session-persistence-jsonl 完全一致的路径编码：安全码元保持字面，
 * 其余（含 ~ ）转 `~XXXX`。会话 id 要按同一规则落盘，删除时才能对上目录。
 * @param raw - 原始字符串。
 * @returns 单段安全目录名。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * encodeSegment 的逆运算（仅用于把目录名还原成 id 做归属比对）。
 * @param segment - 单段目录名。
 * @returns 还原后的字符串。
 */
function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 会话根下的所有项目目录（`--C-...--` / `_no-cwd`）。 */
function projectDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** 目录字节数；单个文件出错只跳过该文件，绝不中断统计。 */
function sizeOf(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else {
        try {
          total += statSync(path).size
        } catch {
          /* 单个文件 stat 失败不影响整体 */
        }
      }
    }
  }
  return total
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 同源校验。
 *
 * 必须按 Origin 判定，不能因为来源 socket 是回环就放行 —— 浏览器里的任意页面
 * 都能向 127.0.0.1 发请求，若只信 socket 地址，一个恶意网页就能批量删掉用户的
 * 全部会话。这里只在该页与 Host 同源时才放行：
 *   · 带 Origin：Origin 的 host 必须等于请求的 Host；
 *   · 无 Origin：桌面端 Electron 从 file:// / app:// 载入，浏览器在跨源 POST 时
 *     也可能省略 Origin，因此要求 Host 本身是本机回环地址。
 * @param req - 传入的 HTTP 请求。
 * @returns 是否允许执行。
 */
function sameOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host === '') return false
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)

  const origin = req.headers.origin
  if (origin !== undefined && origin !== '' && origin !== 'null') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  // 无 Origin / "null"：仅接受 Host 为回环（桌面端 file:// 载入的页面即此形态）。
  return hostLocal
}

export function apply(ctx, config = {}) {
  const home = resolveHome()
  const sessionRoot = resolve(
    typeof config.root === 'string' && config.root !== '' ? config.root : join(home, 'sessions'),
  )
  const storagesRoot = resolve(
    typeof config.storagesRoot === 'string' && config.storagesRoot !== ''
      ? config.storagesRoot
      : join(home, 'storages'),
  )
  const cacheDir = join(storagesRoot, 'session_projcache', 'sessions')
  const TOOL = 'session-purge'

  /** 写操作串行化：并发删除同一 id 会互相踩 rmSync。 */
  let queue = Promise.resolve()
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 所有已知会话 id（持久化层是唯一权威；运行中未落盘的也算）。 */
  async function knownIds() {
    const ids = new Set()
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      for (const snapshot of await persistence.list()) ids.add(snapshot.header.id)
    }
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.list === 'function') {
      for (const agent of agents.list()) ids.add(agent.id)
    }
    return ids
  }

  /** 某个 id 在磁盘上真实存在的会话目录（可能因为 cwd 变更出现在多个项目下）。 */
  function sessionDirsOf(id) {
    let encoded
    try {
      encoded = encodeSegment(id)
    } catch {
      return []
    }
    const found = []
    for (const project of projectDirs(sessionRoot)) {
      const candidate = join(project, encoded)
      if (isDirectory(candidate)) found.push(candidate)
    }
    return found
  }

  function cachePathOf(id) {
    return join(cacheDir, `${id}.json`)
  }

  /** 停掉该会话仍在跑的回合；返回是否仍然留在内存里。 */
  async function stopAgent(id) {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.get !== 'function') return { live: false }
    let agent = agents.get(id)
    if (agent === undefined) return { live: false }
    if (agent.status === 'running') {
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* 取消失败仍然继续等空闲 */
      }
    }
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      if (agents.get(id) === undefined) return { live: false }
      agent = agents.get(id)
      if (agent !== undefined && agent.status !== 'running') {
        await sleep(250)
        break
      }
      await sleep(100)
    }
    return { live: agents.get(id) !== undefined }
  }

  /**
   * 删掉绑在这个会话上的定时任务。
   *
   * 提醒是按 sessionId 存进 `storages/schedule` 的独立记录：会话日志删掉后它
   * 不会自己消失，而是变成一条指不到会话的悬空任务 —— 列表里还在、到点还会
   * 唤醒一个不存在的会话。所以彻底删除必须连带清掉。
   * @param id - 被删除的会话。
   * @returns 清掉的提醒数量。
   */
  async function dropSchedules(id) {
    const schedule = ctx.get('schedule')
    if (schedule === undefined) return 0
    if (typeof schedule.catalog !== 'function' || typeof schedule.delete !== 'function') return 0
    let removed = 0
    let tasks
    try {
      tasks = await schedule.catalog()
    } catch {
      return 0
    }
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (task === null || typeof task !== 'object' || task.sessionId !== id) continue
      try {
        const outcome = await schedule.delete({ sessionId: id, id: task.id })
        if (outcome?.deleted === true) removed += 1
      } catch {
        /* 单条失败不阻断删除 */
      }
    }
    return removed
  }

  /** 清掉工作区记账、归档、置顶；任何一步失败都不阻断删除。 */
  async function detachWorkspace(id) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    const guarded = async (task) => {
      try {
        await task()
      } catch {
        /* 记账清理是尽力而为 */
      }
    }
    await guarded(() => registry.unarchiveSession(id))
    await guarded(() => registry.unpinSession(id))
    if (typeof registry.list !== 'function') return
    for (const entity of registry.list()) {
      await guarded(() => entity.detachSession(id))
    }
  }

  /** 删一个会话的磁盘痕迹；返回释放字节与删掉的路径。 */
  async function purgeOne(id) {
    if (!SAFE_ID.test(id)) return { id, ok: false, reason: 'invalid-id' }
    const stopped = await stopAgent(id)
    if (stopped.live) return { id, ok: false, reason: 'open' }

    const dirs = sessionDirsOf(id)
    const cache = cachePathOf(id)
    let bytes = 0
    for (const dir of dirs) bytes += sizeOf(dir)
    try {
      if (existsSync(cache)) bytes += statSync(cache).size
    } catch {
      /* 大小统计失败不影响删除 */
    }

    await detachWorkspace(id)
    const schedules = await dropSchedules(id)

    const removed = []
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 })
        removed.push(dir)
      } catch (error) {
        return { id, ok: false, reason: 'busy', detail: String(error && error.message ? error.message : error) }
      }
      // 项目目录空了就顺手收掉；不空（还有别的会话）是常态，不是失败。
      try {
        rmdirSync(join(dir, '..'))
      } catch {
        /* 目录非空或已不存在 */
      }
    }
    try {
      if (existsSync(cache)) rmSync(cache, { force: true })
    } catch (error) {
      return { id, ok: false, reason: 'busy', detail: String(error && error.message ? error.message : error) }
    }
    if (removed.length === 0 && !existsSync(cache)) {
      // 已经从盘上消失：记账层也已经清干净，按成功计（幂等）。
      return { id, ok: true, bytes: 0, removed, schedules, alreadyGone: true }
    }
    return { id, ok: true, bytes, removed, schedules }
  }

  async function overview() {
    const known = await knownIds()
    const sessions = []
    const knownDirs = new Set()
    for (const project of projectDirs(sessionRoot)) {
      let entries
      try {
        entries = readdirSync(project, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(project, entry.name)
        const id = decodeSegment(entry.name)
        knownDirs.add(dir)
        sessions.push({
          id,
          dir,
          bytes: sizeOf(dir),
          known: known.has(id),
        })
      }
    }

    const cacheOrphans = []
    let cacheEntries = []
    try {
      cacheEntries = readdirSync(cacheDir, { withFileTypes: true })
    } catch {
      cacheEntries = []
    }
    for (const entry of cacheEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (!known.has(id)) {
        const path = join(cacheDir, entry.name)
        let bytes = 0
        try {
          bytes = statSync(path).size
        } catch {
          /* ignore */
        }
        cacheOrphans.push({ id, path, bytes })
      }
    }

    // 同一 id 出现在多个项目目录时，前端只需要一个占用合计。
    const byId = new Map()
    for (const row of sessions) {
      const previous = byId.get(row.id)
      if (previous === undefined) byId.set(row.id, { ...row })
      else {
        previous.bytes += row.bytes
        previous.dir = `${previous.dir}\n${row.dir}`
        previous.known = previous.known || row.known
      }
    }

    const orphanDirs = sessions.filter((row) => !row.known)
    return {
      root: sessionRoot,
      storagesRoot,
      sessions: [...byId.values()],
      orphanDirs,
      orphanCaches: cacheOrphans,
      totals: {
        count: known.size,
        onDisk: byId.size,
        bytes: [...byId.values()].reduce((sum, row) => sum + row.bytes, 0),
        orphanBytes:
          orphanDirs.reduce((sum, row) => sum + row.bytes, 0) +
          cacheOrphans.reduce((sum, row) => sum + row.bytes, 0),
      },
    }
  }

  async function deleteSessions(ids, includeOrphans) {
    const results = []
    let freed = 0
    let schedules = 0
    for (const id of ids) {
      const outcome = await purgeOne(id)
      if (outcome.ok) freed += outcome.bytes ?? 0
      schedules += outcome.schedules ?? 0
      results.push(outcome)
    }

    if (includeOrphans) {
      const snapshot = await overview()
      for (const row of snapshot.orphanDirs) {
        try {
          rmSync(row.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 })
          try {
            rmdirSync(join(row.dir, '..'))
          } catch {
            /* 项目目录里还有别的会话 */
          }
          freed += row.bytes
          results.push({ id: row.id, ok: true, bytes: row.bytes, orphan: true })
        } catch (error) {
          results.push({ id: row.id, ok: false, reason: 'busy', orphan: true, detail: String(error) })
        }
      }
      for (const row of snapshot.orphanCaches) {
        try {
          rmSync(row.path, { force: true })
          freed += row.bytes
          results.push({ id: row.id, ok: true, bytes: row.bytes, orphan: true })
        } catch (error) {
          results.push({ id: row.id, ok: false, reason: 'busy', orphan: true, detail: String(error) })
        }
      }
    }

    return { ok: true, results, freed, schedules }
  }

  const handler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }

    let request
    try {
      const text = await readBody(req)
      request = text === '' ? {} : JSON.parse(text)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `bad request: ${String(error && error.message ? error.message : error)}` })
      return
    }

    const op = typeof request.op === 'string' ? request.op : ''
    try {
      if (op === 'overview') {
        sendJson(res, 200, { ok: true, ...(await overview()) })
        return
      }
      if (op === 'delete') {
        const ids = Array.isArray(request.ids) ? request.ids.filter((id) => typeof id === 'string') : []
        if (ids.length === 0 && request.includeOrphans !== true) {
          sendJson(res, 400, { ok: false, error: 'no session ids' })
          return
        }
        if (ids.length > 5000) {
          sendJson(res, 400, { ok: false, error: 'too many ids in one request' })
          return
        }
        const outcome = await serialize(() => deleteSessions(ids, request.includeOrphans === true))
        ctx.logger?.info?.(`${TOOL}: deleted ${ids.length} session(s) + orphans=${String(request.includeOrphans === true)}`)
        sendJson(res, 200, outcome)
        return
      }
      sendJson(res, 400, { ok: false, error: `unknown op "${op}"` })
    } catch (error) {
      ctx.logger?.warn?.(`${TOOL}: ${op} failed: ${String(error && error.stack ? error.stack : error)}`)
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/session-purge/api', handler }),
    `${TOOL}: http bridge`,
  )

  ctx.logger?.info?.(`${TOOL}: ready (sessions=${sessionRoot}, storages=${storagesRoot})`)
}
