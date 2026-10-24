// dsh-session-purge —— 浏览器半侧
//
// 侧边栏批量彻底删除会话：
//   · sidebar.footer.action      一个入口按钮（打开管理面板）
//   · shell.overlay              管理面板 + 单条删除确认框
//   · sidebar.workspaces.session.menu.item   单条「彻底删除」菜单项
//
// 只依赖 shell 静态表里的 react；不 require 任何插件包，因此换机器装也能跑。
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useSyncExternalStore, useCallback } = React

    /* ------------------------------------------------------------------ 小工具 */

    /** 极简可订阅值容器：够用且不依赖 client-store。 */
    function createValue(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useValue(source) {
      return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    }

    const panelState = createValue({ open: false })
    const confirmState = createValue(null)

    async function api(op, payload) {
      const response = await fetch('/session-purge/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ op, ...(payload ?? {}) }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
      }
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`
    }

    function formatTime(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /* -------------------------------------------------------------------- 样式 */

    const COLORS = {
      panel: 'var(--dsw-alias-bg-overlay, #ffffff)',
      field: 'var(--dsw-alias-bg-base, #ffffff)',
      text: 'var(--dsw-alias-label-primary, #1b1b1f)',
      sub: 'var(--dsw-alias-label-secondary, #6b6b76)',
      line: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-system-error, #d93a3a)',
    }

    const styles = {
      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        background: 'rgba(0,0,0,0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
      },
      panel: {
        width: 'min(760px, 100%)',
        maxHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: COLORS.panel,
        color: COLORS.text,
        border: `1px solid ${COLORS.line}`,
        borderRadius: 14,
        boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
        overflow: 'hidden',
        font: '13px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      header: {
        padding: '16px 18px 12px',
        borderBottom: `1px solid ${COLORS.line}`,
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      hint: { margin: '6px 0 0', color: COLORS.sub, fontSize: 12 },
      toolbar: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '10px 18px',
        borderBottom: `1px solid ${COLORS.line}`,
        flexWrap: 'wrap',
      },
      search: {
        flex: '1 1 180px',
        minWidth: 120,
        padding: '6px 10px',
        fontSize: 12,
        color: COLORS.text,
        background: COLORS.field,
        border: `1px solid ${COLORS.line}`,
        borderRadius: 8,
        outline: 'none',
      },
      list: {
        overflowY: 'auto',
        padding: '6px 8px',
        flex: '1 1 auto',
        minHeight: 120,
      },
      row: {
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '7px 10px',
        borderRadius: 8,
        cursor: 'pointer',
      },
      rowTitle: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      meta: { color: COLORS.sub, fontSize: 11, marginTop: 2 },
      footer: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '12px 18px',
        borderTop: `1px solid ${COLORS.line}`,
        flexWrap: 'wrap',
      },
      button: {
        padding: '6px 14px',
        fontSize: 12,
        borderRadius: 8,
        border: `1px solid ${COLORS.line}`,
        background: COLORS.field,
        color: COLORS.text,
        cursor: 'pointer',
      },
      primary: {
        padding: '6px 16px',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 8,
        border: '1px solid transparent',
        background: COLORS.accent,
        color: '#fff',
        cursor: 'pointer',
      },
      danger: {
        padding: '6px 16px',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 8,
        border: '1px solid transparent',
        background: COLORS.danger,
        color: '#fff',
        cursor: 'pointer',
      },
      tag: {
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid ${COLORS.line}`,
        color: COLORS.sub,
        whiteSpace: 'nowrap',
      },
      notice: {
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 12,
        margin: '8px 10px 0',
        background: COLORS.hover,
      },
    }

    function Button({ children, onClick, disabled, variant, title }) {
      const style = variant === 'primary' ? styles.primary : variant === 'danger' ? styles.danger : styles.button
      return h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          disabled,
          style: { ...style, ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}) },
        },
        children,
      )
    }

    /* ---------------------------------------------------------------- 管理面板 */

    function SessionPurgePanel({ sessions }) {
      const [overview, setOverview] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [query, setQuery] = useState('')
      const [includeOrphans, setIncludeOrphans] = useState(true)
      const [armed, setArmed] = useState(false)

      const loadOverview = useCallback(async () => {
        setLoading(true)
        try {
          const data = await api('overview')
          setOverview(data)
          setError(null)
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void loadOverview()
      }, [loadOverview])

      const sizeById = useMemo(() => {
        const map = new Map()
        for (const row of overview?.sessions ?? []) map.set(row.id, row.bytes)
        return map
      }, [overview])

      const rows = useMemo(() => {
        const list = sessions.ids
          .map((id) => sessions.byId[id])
          .filter((row) => row !== undefined)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        const needle = query.trim().toLowerCase()
        if (needle === '') return list
        return list.filter((row) => {
          const title = (row.title ?? row.displayTitle ?? '').toLowerCase()
          const cwd = (row.cwd ?? '').toLowerCase()
          return title.includes(needle) || cwd.includes(needle) || row.id.toLowerCase().includes(needle)
        })
      }, [sessions, query])

      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setArmed(false)
      }

      const selectedBytes = useMemo(() => {
        let total = 0
        for (const id of selected) total += sizeById.get(id) ?? 0
        return total
      }, [selected, sizeById])

      const orphanDirs = overview?.orphanDirs?.length ?? 0
      const orphanCaches = overview?.orphanCaches?.length ?? 0
      const orphanBytes = overview?.totals?.orphanBytes ?? 0

      const runDelete = async () => {
        if (busy) return
        if (selected.size === 0 && !(includeOrphans && (orphanDirs > 0 || orphanCaches > 0))) return
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const data = await api('delete', {
            ids: [...selected],
            includeOrphans: includeOrphans && (orphanDirs > 0 || orphanCaches > 0),
          })
          const failed = (data.results ?? []).filter((item) => !item.ok)
          setResult({
            removed: (data.results ?? []).filter((item) => item.ok).length,
            failed: failed.length,
            freed: data.freed ?? 0,
            schedules: data.schedules ?? 0,
            reasons: [...new Set(failed.map((item) => item.reason ?? 'unknown'))],
          })
          setSelected(new Set())
          setArmed(false)
          await SessionPurgePanel.refreshSessions()
          await loadOverview()
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason))
        } finally {
          setBusy(false)
        }
      }

      const totalSelectedLabel =
        selected.size === 0 ? '未选择会话' : `已选 ${String(selected.size)} 个会话 · ${formatBytes(selectedBytes)}`

      const canDelete = selected.size > 0 || (includeOrphans && (orphanDirs > 0 || orphanCaches > 0))

      return h(
        'div',
        { style: styles.backdrop, onMouseDown: (event) => event.target === event.currentTarget && panelState.set({ open: false }) },
        h(
          'div',
          { style: styles.panel, role: 'dialog', 'aria-label': '批量彻底删除会话' },
          h(
            'div',
            { style: styles.header },
            h('h2', { style: styles.title }, '批量彻底删除会话'),
            h(
              'p',
              { style: styles.hint },
              '永久删除会话日志、投影缓存与侧边栏记账 —— 不进回收站，不可撤销。正在运行的会话会被拒绝。',
            ),
            overview
              ? h(
                  'p',
                  { style: { ...styles.hint, marginTop: 4 } },
                  `磁盘共 ${String(overview.totals.count)} 个会话 / ${formatBytes(overview.totals.bytes)}`,
                  ` · 孤儿目录 ${String(orphanDirs)} 个`,
                  ` · 孤儿缓存 ${String(orphanCaches)} 个`,
                  `（${formatBytes(orphanBytes)}）`,
                )
              : null,
          ),
          h(
            'div',
            { style: styles.toolbar },
            h('input', {
              style: styles.search,
              value: query,
              placeholder: '搜索标题 / 目录 / 会话 ID',
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              Button,
              {
                onClick: () => {
                  setSelected((previous) => {
                    const next = new Set(previous)
                    const everyChosen = rows.length > 0 && rows.every((row) => next.has(row.id))
                    for (const row of rows) {
                      if (everyChosen) next.delete(row.id)
                      else next.add(row.id)
                    }
                    return next
                  })
                  setArmed(false)
                },
              },
              rows.length > 0 && rows.every((row) => selected.has(row.id)) ? '取消全选' : '全选当前列表',
            ),
            h(
              Button,
              {
                onClick: () => {
                  setSelected(new Set())
                  setArmed(false)
                },
                disabled: selected.size === 0,
              },
              '清空选择',
            ),
            h(
              Button,
              { onClick: () => void loadOverview(), disabled: loading || busy },
              loading ? '刷新中…' : '重新扫描',
            ),
          ),
          error ? h('div', { style: { ...styles.notice, color: COLORS.danger } }, error) : null,
          result
            ? h(
                'div',
                { style: styles.notice },
                `已删除 ${String(result.removed)} 项，释放 ${formatBytes(result.freed)}。`,
                result.schedules > 0 ? ` 连带清掉 ${String(result.schedules)} 条绑定提醒。` : '',
                result.failed > 0
                  ? ` ${String(result.failed)} 项未删除（${result.reasons.join(' / ') || '原因未知'}）——正在运行或被占用的会话请稍后再试。`
                  : '',
              )
            : null,
          h(
            'div',
            { style: styles.list },
            !loading && rows.length === 0
              ? h('div', { style: { ...styles.notice, color: COLORS.sub } }, '没有匹配的会话。')
              : null,
            rows.map((row) => {
              const checked = selected.has(row.id)
              const bytes = sizeById.get(row.id)
              const subtitle = [baseName(row.cwd ?? ''), row.origin === 'subagent' ? '子会话' : '', formatTime(row.updatedAt)]
                .filter((part) => part !== '')
                .join(' · ')
              return h(
                'label',
                {
                  key: row.id,
                  style: { ...styles.row, background: checked ? COLORS.hover : 'transparent' },
                  onMouseEnter: (event) => {
                    if (!checked) event.currentTarget.style.background = COLORS.hover
                  },
                  onMouseLeave: (event) => {
                    if (!checked) event.currentTarget.style.background = 'transparent'
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked,
                  onChange: () => toggle(row.id),
                  style: { marginTop: 3, accentColor: COLORS.accent, flex: 'none' },
                }),
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0 } },
                  h(
                    'div',
                    { style: styles.rowTitle, title: row.title ?? row.displayTitle ?? row.id },
                    row.title ?? row.displayTitle ?? row.id,
                  ),
                  h(
                    'div',
                    { style: styles.meta },
                    subtitle,
                    bytes === undefined ? '' : ` · ${formatBytes(bytes)}`,
                  ),
                ),
                row.running ? h('span', { style: { ...styles.tag, color: COLORS.danger } }, '运行中') : null,
                row.blank ? h('span', { style: styles.tag }, '空白') : null,
              )
            }),
          ),
          h(
            'div',
            { style: styles.footer },
            h(
              'label',
              {
                style: {
                  marginRight: 'auto',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  color: COLORS.sub,
                  fontSize: 12,
                  cursor: 'pointer',
                },
              },
              h('input', {
                type: 'checkbox',
                checked: includeOrphans,
                onChange: (event) => setIncludeOrphans(event.target.checked),
                style: { accentColor: COLORS.accent },
              }),
              `一并清理孤儿残留（${String(orphanDirs + orphanCaches)} 项，${formatBytes(orphanBytes)}）`,
            ),
            h('span', { style: { color: COLORS.sub, fontSize: 12, marginRight: 4 } }, totalSelectedLabel),
            h(Button, { onClick: () => panelState.set({ open: false }), disabled: busy }, '关闭'),
            armed
              ? h(
                  Button,
                  { variant: 'danger', onClick: () => void runDelete(), disabled: busy },
                  busy ? '删除中…' : `确认删除 ${String(selected.size)} 个会话？`,
                )
              : h(
                  Button,
                  {
                    variant: 'danger',
                    disabled: !canDelete || busy || loading,
                    onClick: () => setArmed(true),
                  },
                  busy ? '删除中…' : '彻底删除',
                ),
          ),
        ),
      )
    }

    /** 面板需要一个不依赖 hook 的 refresh 通道，由 apply() 注入。 */
    SessionPurgePanel.refreshSessions = async () => {}

    /* -------------------------------------------------------------- 单条删除确认 */

    function PurgeConfirm() {
      const request = useValue(confirmState)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      useEffect(() => {
        setBusy(false)
        setError(null)
      }, [request])
      if (request === null) return null

      const close = () => confirmState.set(null)
      const confirm = async () => {
        setBusy(true)
        setError(null)
        try {
          const data = await api('delete', { ids: [request.sessionId] })
          const failed = (data.results ?? []).filter((item) => !item.ok)
          if (failed.length > 0) {
            const reason = failed[0].reason
            setError(
              reason === 'open'
                ? '这个会话仍在运行，先停掉它再删除。'
                : `未能删除：${reason ?? 'unknown'}${failed[0].detail ? `（${failed[0].detail}）` : ''}`,
            )
            setBusy(false)
            return
          }
          await SessionPurgePanel.refreshSessions()
          close()
        } catch (reason) {
          setError(String(reason && reason.message ? reason.message : reason))
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: styles.backdrop, onMouseDown: (event) => event.target === event.currentTarget && !busy && close() },
        h(
          'div',
          { style: { ...styles.panel, width: 'min(440px, 100%)' }, role: 'dialog', 'aria-label': '彻底删除会话' },
          h(
            'div',
            { style: styles.header },
            h('h2', { style: styles.title }, '彻底删除这个会话？'),
            h(
              'p',
              { style: styles.hint },
              `「${request.title === '' ? request.sessionId : request.title}」的日志、投影缓存与记账会被永久移除，不可撤销。`,
            ),
          ),
          error
            ? h('div', { style: { ...styles.notice, color: COLORS.danger } }, error)
            : null,
          h(
            'div',
            { style: styles.footer },
            h(Button, { onClick: close, disabled: busy }, '取消'),
            h(
              Button,
              { variant: 'danger', onClick: () => void confirm(), disabled: busy },
              busy ? '删除中…' : '确认彻底删除',
            ),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- 侧栏入口 */

    function TrashIcon({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4 4.5l.6 8.1c0 .5.4.9.9.9h5c.5 0 .9-.4.9-.9L12 4.5' }),
        h('path', { d: 'M6.6 7v4' }),
        h('path', { d: 'M9.4 7v4' }),
      )
    }

    function PurgeFooterButton({ wide }) {
      return h(
        'button',
        {
          type: 'button',
          title: '批量彻底删除会话',
          'aria-label': '批量彻底删除会话',
          onClick: () => panelState.set({ open: true }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: wide ? '6px 10px' : '0',
            width: wide ? 'auto' : 32,
            height: 32,
            justifyContent: 'center',
            fontSize: 12,
            color: COLORS.sub,
            background: 'transparent',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = COLORS.hover
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent'
          },
        },
        h(TrashIcon, { size: 15 }),
        wide ? h('span', null, '清理会话') : null,
      )
    }

    function PurgeMenuItem({ sessionId, displayTitle }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            confirmState.set({ sessionId, title: typeof displayTitle === 'string' ? displayTitle : '' })
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            fontSize: 12,
            textAlign: 'left',
            color: COLORS.danger,
            background: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            font: 'inherit',
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = COLORS.hover
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent'
          },
        },
        h(TrashIcon, { size: 14 }),
        h('span', null, '彻底删除'),
      )
    }

    /* ------------------------------------------------------------------ 插件装配 */

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      const sessions = ctx.get('sessions')
      SessionPurgePanel.refreshSessions = async () => {
        try {
          await sessions.refresh()
        } catch {
          /* 刷新失败时下一次列表投影仍会纠正 */
        }
      }

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'session-purge.open' }, PurgeFooterButton),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'session-purge.panel' }, function PurgePanelHost() {
          const open = useValue(panelState).open
          const snapshot = useValue(sessions.list)
          if (!open) return null
          return h(SessionPurgePanel, { sessions: snapshot })
        }),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'session-purge.confirm' }, PurgeConfirm),
      )

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-purge.delete', order: 900 },
          PurgeMenuItem,
        ),
      )
    }

    return { apply, inject, name: 'session-purge' }
  },
})
