/**
 * 离线加载 client bundle，确认 `window.__ModuleLoader__` 契约与导出面正确。
 * 用一个假的 require / react 桩跑 factory，不需要浏览器。
 *
 *   node test/client-bundle.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

/* 最小 react 桩：只要满足 factory 顶层解构与组件定义即可。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const loaded = []
let factory

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded.push(registration.id)
      factory = registration.factory
    },
  },
}

// bundle 里引用了 fetch/document 等浏览器全局，但只在运行时调用，加载阶段不触发。
const moduleExports = new Function('window', `${source}\nreturn window.__ModuleLoader__;`)(globalThis.window)

assert.deepEqual(loaded, ['dsh-session-purge'], `注册 id 应为包名，实得 ${JSON.stringify(loaded)}`)
assert.equal(typeof factory, 'function', 'factory 必须是函数')

const required = []
const exports = factory((specifier) => {
  required.push(specifier)
  if (specifier === 'react') return reactStub
  throw new Error(`bundle 只应 require "react"，却请求了 "${specifier}"`)
})

assert.deepEqual(required, ['react'], '不得依赖 shell 静态表之外的任何模块')
assert.equal(typeof exports.apply, 'function', '必须导出 apply')
assert.equal(exports.name, 'session-purge', '必须导出插件名')
assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots') && exports.inject.includes('sessions'))

/* -------------------------------------------------- apply() 的 slot 注册面检查 */

const registrations = []
const ctx = {
  get: (name) => (name === 'sessions' ? { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} }, refresh: async () => {} } : undefined),
  slots: {
    inject(name, fn) {
      fn()
      return () => {}
    },
    register(options, component) {
      registrations.push({ name: options.name, id: options.id, component })
      return () => {}
    },
  },
}
exports.apply(ctx)

const names = registrations.map((row) => `${row.name}#${row.id ?? ''}`)
assert.deepEqual(
  names,
  [
    'sidebar.footer.action#session-purge.open',
    'shell.overlay#session-purge.panel',
    'shell.overlay#session-purge.confirm',
    'sidebar.workspaces.session.menu.item#session-purge.delete',
  ],
  `slot 注册面不符：${JSON.stringify(names)}`,
)
assert.ok(
  registrations.every((row) => typeof row.component === 'function'),
  '每个 slot 都必须挂组件',
)

console.log('\x1b[32m✓ client bundle 契约通过\x1b[0m')
