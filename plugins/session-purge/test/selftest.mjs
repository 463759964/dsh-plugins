/**
 * 离线自测：不开 DSH，直接把 Host 半侧挂到一个假 ctx 上跑真实文件操作。
 * 覆盖 overview / delete / 孤儿清理 / 运行中拒绝 / 路径编码往返。
 *
 *   node test/selftest.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-purge-test-'))
const sessionsRoot = join(sandbox, 'sessions')
const storagesRoot = join(sandbox, 'storages')
const cacheDir = join(storagesRoot, 'session_projcache', 'sessions')
const projectDir = join(sessionsRoot, '--C-Users-x-project--')

mkdirSync(projectDir, { recursive: true })
mkdirSync(cacheDir, { recursive: true })

/** 造一个"完整"会话：日志目录 + 投影缓存。 */
function makeSession(id, bytes) {
  const dir = join(projectDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
  writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({ version: 7, id }))
  return dir
}

const live = makeSession('session-aaaaaaaa-1111-2222-3333-444444444444', 4000)
const doomed = makeSession('session-bbbbbbbb-1111-2222-3333-444444444444', 5000)
const running = makeSession('session-cccccccc-1111-2222-3333-444444444444', 1000)
const orphanDir = makeSession('session-dddddddd-1111-2222-3333-444444444444', 700)
// 孤儿缓存：盘上有缓存、没有任何会话
writeFileSync(join(cacheDir, 'session-eeeeeeee-1111-2222-3333-444444444444.json'), '{}')

const known = new Set([live.split(/[\\/]/).pop(), doomed.split(/[\\/]/).pop(), running.split(/[\\/]/).pop()])

/** 绑定在 doomed 会话上的两条提醒，以及一条属于别人的（必须存活）。 */
const schedules = new Map([
  ['task-1', { id: 'task-1', sessionId: 'session-bbbbbbbb-1111-2222-3333-444444444444' }],
  ['task-2', { id: 'task-2', sessionId: 'session-bbbbbbbb-1111-2222-3333-444444444444' }],
  ['task-other', { id: 'task-other', sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444' }],
])

let handler
const detached = []
const fakeCtx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    fn()
  },
  webServer: {
    register(route) {
      assert.equal(route.path, '/session-purge/api')
      handler = route.handler
      return () => {}
    },
  },
  get(name) {
    if (name === 'sessionPersistence') {
      return { list: async () => [...known].map((id) => ({ header: { id } })) }
    }
    if (name === 'agents') {
      return {
        list: () => [{ id: 'session-cccccccc-1111-2222-3333-444444444444', status: 'running' }],
        get: (id) => (id === 'session-cccccccc-1111-2222-3333-444444444444' ? { status: 'running', cancel() {} } : undefined),
      }
    }
    if (name === 'workspaceRegistry') {
      return {
        unarchiveSession: async (id) => detached.push(`unarchive:${id}`),
        unpinSession: async (id) => detached.push(`unpin:${id}`),
        list: () => [{ detachSession: async (id) => detached.push(`detach:${id}`) }],
      }
    }
    if (name === 'schedule') {
      // 真实契约：catalog() 列出全部任务（含 sessionId），delete({sessionId,id}) 删一条。
      return {
        catalog: async () => [...schedules.values()],
        delete: async ({ sessionId, id }) => {
          const task = schedules.get(id)
          if (task === undefined || task.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
          schedules.delete(id)
          return { id, deleted: true }
        },
      }
    }
    return undefined
  },
}

plugin.apply(fakeCtx, { root: sessionsRoot, storagesRoot })
assert.equal(typeof handler, 'function', 'apply 必须注册路由 handler')

/** 最小 req/res 桩：够 handler 用。 */
function call(op, payload) {
  return new Promise((done, fail) => {
    const body = Buffer.from(JSON.stringify({ op, ...payload }))
    const req = {
      method: 'POST',
      headers: { host: '127.0.0.1:51456', origin: 'http://127.0.0.1:51456' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, listener) {
        if (event === 'data') listener(body)
        if (event === 'end') listener()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        done({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    Promise.resolve(handler(req, res)).catch(fail)
  })
}

/* ------------------------------------------------------------------ overview */

const before = await call('overview')
assert.equal(before.status, 200)
assert.equal(before.body.ok, true)
assert.equal(before.body.totals.onDisk, 4, `盘上应有 4 个会话目录，实得 ${before.body.totals.onDisk}`)
assert.equal(before.body.orphanDirs.length, 1, '应有 1 个孤儿目录')
assert.equal(before.body.orphanDirs[0].id, 'session-dddddddd-1111-2222-3333-444444444444')
// dddd 既没登记目录也没登记缓存 → 目录与缓存各算 1 个孤儿；eeee 只有缓存。
assert.equal(before.body.orphanCaches.length, 2, `应有 2 个孤儿缓存，实得 ${before.body.orphanCaches.length}`)
assert.ok(before.body.totals.bytes >= 10_700, `字节合计应 ≥10700，实得 ${before.body.totals.bytes}`)

/* -------------------------------------------------------- 运行中的会话必须被拒 */

const refused = await call('delete', { ids: ['session-cccccccc-1111-2222-3333-444444444444'] })
assert.equal(refused.status, 200)
assert.equal(refused.body.results[0].ok, false)
assert.equal(refused.body.results[0].reason, 'open')
assert.ok(existsSync(running), '被拒绝的会话目录必须原样保留')

/* ------------------------------------------------------------------ 真删一个 */

const deleted = await call('delete', { ids: ['session-bbbbbbbb-1111-2222-3333-444444444444'] })
assert.equal(deleted.body.results[0].ok, true)
assert.ok(!existsSync(doomed), '日志目录必须消失')
assert.ok(!existsSync(join(cacheDir, 'session-bbbbbbbb-1111-2222-3333-444444444444.json')), '投影缓存必须消失')
assert.ok(deleted.body.freed >= 5000, `freed 应 ≥5000，实得 ${deleted.body.freed}`)
assert.ok(
  detached.includes('detach:session-bbbbbbbb-1111-2222-3333-444444444444') &&
    detached.includes('unarchive:session-bbbbbbbb-1111-2222-3333-444444444444') &&
    detached.includes('unpin:session-bbbbbbbb-1111-2222-3333-444444444444'),
  '必须清掉 detach/归档/置顶三处记账',
)

// 绑在这个会话上的提醒必须一起删掉，否则留下指不到会话的悬空任务。
assert.equal(deleted.body.schedules, 2, `应清掉 2 条提醒，实得 ${deleted.body.schedules}`)
assert.ok(!schedules.has('task-1') && !schedules.has('task-2'), '该会话的提醒必须消失')
assert.ok(schedules.has('task-other'), '别的会话的提醒必须原样保留')

/* --------------------------------------------------------------- 幂等 & 非法 id */

const again = await call('delete', { ids: ['session-bbbbbbbb-1111-2222-3333-444444444444'] })
assert.equal(again.body.results[0].ok, true, '重复删除应幂等成功')
assert.equal(again.body.results[0].alreadyGone, true)

const evil = await call('delete', { ids: ['../../etc/passwd', '.', '..', 'a/b'] })
assert.ok(evil.body.results.every((row) => row.ok === false && row.reason === 'invalid-id'), '穿越路径必须被拒')

/* ------------------------------------------------------------------ 孤儿清理 */

const orphans = await call('delete', { ids: [], includeOrphans: true })
assert.equal(orphans.status, 200)
assert.ok(!existsSync(orphanDir), '孤儿目录应被清掉')
assert.ok(
  !existsSync(join(cacheDir, 'session-eeeeeeee-1111-2222-3333-444444444444.json')),
  '孤儿缓存应被清掉',
)
assert.ok(existsSync(live), '未被选中的正常会话不受影响')

const after = await call('overview')
assert.equal(after.body.totals.onDisk, 2, '剩下 live + running')
assert.equal(after.body.orphanDirs.length, 0)
assert.equal(after.body.orphanCaches.length, 0)

/* ---------------------------------------------------------- 参数与协议层闸门 */

const empty = await call('delete', { ids: [] })
assert.equal(empty.status, 400, '空 ids 且不清理孤儿 → 400')

const unknown = await call('nope')
assert.equal(unknown.status, 400)

/* ------------------------------------------------------------ 同源校验必须挡住跨站 */

/** 用自定义 header 发一次请求，返回状态码。 */
function callWith(headers, op = 'overview', payload = {}) {
  return new Promise((done, fail) => {
    const body = Buffer.from(JSON.stringify({ op, ...payload }))
    const req = {
      method: 'POST',
      headers,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, listener) {
        if (event === 'data') listener(body)
        if (event === 'end') listener()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        done({ status: this.statusCode, body: JSON.parse(text) })
      },
    }
    Promise.resolve(handler(req, res)).catch(fail)
  })
}

// 恶意网页从浏览器发起的跨源 POST：Origin 不同，必须 403，且绝不能真删。
const hostile = await callWith(
  { host: '127.0.0.1:51456', origin: 'http://evil.example.com' },
  'delete',
  { ids: ['session-aaaaaaaa-1111-2222-3333-444444444444'] },
)
assert.equal(hostile.status, 403, '跨源 POST 必须被拒')
assert.ok(existsSync(live), '被拒绝的跨源请求绝不能删掉会话')

// 无 Origin、Host 是回环：桌面端 file:// 形态，放行。
const desktopLike = await callWith({ host: '127.0.0.1:51456' })
assert.equal(desktopLike.status, 200, '回环 Host 且无 Origin 应放行')

// 无 Origin、Host 不是回环：拒绝。
const foreignHost = await callWith({ host: 'evil.example.com' })
assert.equal(foreignHost.status, 403, '非回环 Host 且无 Origin 必须拒绝')

// 同源 Origin：放行。
const sameOriginCall = await callWith({ host: '127.0.0.1:51456', origin: 'http://127.0.0.1:51456' })
assert.equal(sameOriginCall.status, 200, '同源应放行')

console.log('\x1b[32m✓ selftest 全部通过\x1b[0m')
rmSync(sandbox, { recursive: true, force: true })
