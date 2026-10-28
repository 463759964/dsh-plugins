/**
 * serve.mjs —— 桥接服务的启动器
 *
 * 既被 DSH 插件宿主（lib/index.js）调用，也可以单独跑：
 *   node lib/serve.mjs --port 8792
 * 单独跑时按 Ctrl+C 退出。
 */
import { BridgeServer } from './server.mjs';
import { TokenVault } from './workbuddy-token.mjs';
import { readSecretState } from './local-secret.mjs';

export function startBridge(opts = {}) {
  const vault = new TokenVault({
    uid: opts.uid,
    exePath: opts.exePath,
    infoPath: opts.infoPath,
    fetchImpl: opts.fetchImpl,
  });
  const server = new BridgeServer({
    vault,
    gateway: opts.gateway,
    host: opts.host,
    port: opts.port,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
    promptShield: opts.promptShield,
  });
  return { vault, server };
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const argv = process.argv.slice(2);
  const read = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const apiKey = read('--api-key', '') || readSecretState()?.apiKey || '';
  const { server, vault } = startBridge({
    host: read('--host', '127.0.0.1'),
    port: Number(read('--port', '8792')),
    apiKey,
    gateway: read('--gateway', ''),
    uid: read('--uid', ''),
  });
  const { port, adopted } = await server.listenOrAdopt();
  if (adopted) {
    console.log(`端口 ${port} 上已经有桥接在跑，直接接管它。`);
  }
  const accounts = vault.listPublic();
  console.log(`dsh-workbuddy-bridge 已启动：${server.baseUrl}`);
  console.log(`  模型清单： ${server.baseUrl}/v1/models`);
  console.log(`  对话端点： ${server.baseUrl}/v1/chat/completions`);
  for (const a of accounts) {
    console.log(`  账号：${a.name}${a.isActive ? '（在用）' : ''} ${a.uid}`);
  }
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  void port;
}
