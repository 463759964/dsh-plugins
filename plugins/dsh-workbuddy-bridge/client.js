/**
 * client.js —— DSH 界面里的积分显示
 *
 * 跑在宿主的渲染进程（浏览器）里，通过 `window.__ModuleLoader__` 注册。
 * 往输入框上方的 dock 注入一个数字：今日已消耗的积分数。
 *
 * 数据来自本机桥接的 GET /v1/usage（只读统计，免密钥——浏览器拿不到
 * ~/.dsh 下的密钥文件，桥接那条路由也不返回敏感信息）。
 * 桥接没在跑时不渲染，不留占位。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-bridge',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;

    const USAGE_URL = 'http://127.0.0.1:8792/v1/usage?balance=1';
    const POLL_MS = 30 * 1000;

    const style = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '4px',
      padding: '2px 8px',
      borderRadius: '999px',
      fontSize: '12px',
      lineHeight: '20px',
      fontVariantNumeric: 'tabular-nums',
      cursor: 'default',
      userSelect: 'none',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '0.5px solid var(--dsw-alias-border-l4)',
    };

    const dimStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
    };

    /**
     * 最多两位小数，末尾的 0 去掉：28.21 / 28.2 / 10 / 0。
     * toFixed 保证了一定有小数点，所以先砍末尾连续的 0 再砍小数点，
     * 整数部分的 0（比如 5000）不会被误伤。
     */
    function fmt(n) {
      if (!Number.isFinite(n)) return '0';
      return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }

    function UsageNumber() {
      const [snap, setSnap] = useState(null);

      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await fetch(USAGE_URL, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const j = await res.json();
            if (!alive) return;
            const balance = j.balance && !j.balance.error ? j.balance : null;
            setSnap({
              credit: Number(j?.today?.credit) || 0,
              requests: Number(j?.today?.requests) || 0,
              remain: balance ? balance.totalCredits : null,
              models: Array.isArray(j?.today?.byModel) ? j.today.byModel : [],
            });
          } catch {
            // 桥接没在跑，或者暂时取不到——都当作没数据
            if (alive) setSnap(null);
          }
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      // 没拿到数据就不占位
      if (!snap) return null;

      const top = snap.models.slice(0, 3).map((m) => `${m.model} ${fmt(m.credit)}（${m.requests}次）`);
      const title = [
        `今日已消耗 ${fmt(snap.credit)} 积分，共 ${snap.requests} 次请求`,
        ...top,
        snap.remain !== null ? `余额 ${fmt(snap.remain)} 积分` : null,
      ].filter(Boolean).join('\n');

      return h('span', { style, title },
        h('span', { style: dimStyle }, '今日 '),
        h('span', null, fmt(snap.credit)),
        h('span', { style: dimStyle }, ' 积分'),
        snap.remain !== null
          ? h('span', { style: dimStyle }, ` · 余 ${fmt(snap.remain)}`)
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'workbuddy-credits',
          order: 5,
        }, UsageNumber));
      },
    };
  },
});
