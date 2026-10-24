/**
 * index.js —— DSH 插件宿主入口
 *
 * 挂载后在本机起一个只监听 127.0.0.1 的 OpenAI 兼容端点，把 WorkBuddy 账号里的
 * 模型桥给 DSH 的 llm-pi-ai 用。整个插件不依赖 DSH 的任何其它服务，因此不需要
 * ctx.inject —— 起得越早越好，模型选择器随时可以来问。
 */
import { startBridge } from './serve.mjs';
import { readSecretState } from './local-secret.mjs';

export const name = 'workbuddy-bridge';

/**
 * @param ctx - DSH 的 cordis 上下文。
 * @param config - 来自 cordis.patch.yml / 设置页的覆盖项。
 */
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const logger = makeLogger(ctx);
  const key = resolveApiKey(cfg);
  const { server, vault } = startBridge({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || 8792,
    apiKey: key.apiKey,
    gateway: cfg.gateway || '',
    uid: cfg.uid || '',
    logger,
  });
  if (!key.apiKey) {
    logger.warn('没有配置本地密钥，桥接将以「不校验」方式运行。跑一次 node tools/install.mjs 生成密钥。');
  }

  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    await server.close().catch(() => {});
  };

  server
    .listenOrAdopt()
    .then(({ port, adopted }) => {
      const accounts = vault.listPublic().map((a) => `${a.name}${a.isActive ? '（在用）' : ''}`);
      const how = adopted ? '接管了已在跑的实例' : '新起了一个实例';
      logger.info(
        `workbuddy 桥接已就绪：http://${server.host}:${port}/v1 · ${how} · 账号 ${accounts.join('、')}`,
      );
    })
    .catch((err) => {
      logger.warn(`workbuddy 桥接没能起来：${err && err.message ? err.message : String(err)}`);
    });

  // 插件被卸载 / profile 重载时收干净，别把端口留在那
  try {
    ctx.on?.('dispose', stop);
  } catch {
    /* 宿主不支持 dispose 事件就算了 */
  }
}

/**
 * 桥接该用哪把钥匙。
 *
 * 顺序是 配置 → 本机密钥文件。刻意不在这里「随手生成一个」：DSH 侧写死的密钥
 * 来自安装器，桥自己另起炉灶只会让两边对不上，请求全被 401 挡回来。真一个都
 * 没有时宁可不校验（只监听回环），也不要把会话弄成打不开。
 */
function resolveApiKey(cfg) {
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
    return { apiKey: cfg.apiKey, source: 'config' };
  }
  const state = readSecretState(cfg.dshHome);
  if (state) return { apiKey: state.apiKey, source: 'file' };
  return { apiKey: '', source: 'none' };
}

function makeLogger(ctx) {
  const candidate = ctx?.logger ?? ctx?.root?.logger;
  if (candidate && typeof candidate.info === 'function') {
    const wrap = (level) => (msg) => {
      try {
        candidate[level]?.(`[workbuddy-bridge] ${msg}`);
      } catch {
        /* 日志不可用不影响主流程 */
      }
    };
    return { info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
  }
  const tag = (level) => (msg) => {
    const line = `[workbuddy-bridge] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return { info: tag('info'), warn: tag('warn'), error: tag('error') };
}
