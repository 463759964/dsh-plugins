/**
 * list-models.mjs —— 直接打印账号里有什么模型，不用先起服务
 *
 *   node tools/list-models.mjs [--json]
 */
import { TokenVault } from '../lib/workbuddy-token.mjs';
import { UpstreamClient } from '../lib/upstream.mjs';

const asJson = process.argv.includes('--json');

const vault = new TokenVault({});
const upstream = new UpstreamClient({ vault });
const models = await upstream.listModels();

if (asJson) {
  console.log(JSON.stringify(models, null, 2));
} else {
  console.log(`WorkBuddy 账号可用模型（${models.length} 个）\n`);
  const w = Math.max(...models.map((m) => m.id.length));
  for (const m of models) {
    const flags = [
      m.supportsImages ? 'vision' : null,
      m.supportsReasoning ? 'reasoning' : null,
      m.credits ? m.credits : null,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${m.id.padEnd(w)}  ${String(m.contextWindow ?? '?').padStart(8)} in / ${String(m.maxTokens ?? '?').padStart(7)} out   ${flags}`,
    );
  }
}
