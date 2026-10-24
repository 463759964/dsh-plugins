/**
 * upstream.mjs —— WorkBuddy 网关客户端
 *
 * 把「本机 WorkBuddy 账号」的模型能力包成一层干净的 API：拉模型清单、发起对话。
 * 令牌由 workbuddy-token.mjs 的 TokenVault 按需供给，401 时自动续期并重放一次。
 */
import crypto from 'node:crypto';

export const DEFAULT_GATEWAY = 'https://copilot.tencent.com';
const MODELS_PATH = '/v2/enterprises/personal/models';
const CHAT_PATH = '/v2/chat/completions';

/** 纯文本生成类模型不算聊天模型，DSH 侧也不该出现在模型选择器里。 */
const NON_CHAT_TAGS = new Set(['text-to-image', 'text-to-video', 'image-edit']);

const uuid = () => crypto.randomUUID();

/** 网关要求的固定请求头（与 WorkBuddy 客户端一致，缺了会被判为非法来源）。 */
function gatewayHeaders(token, { conversationId } = {}) {
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const parentSpanId = crypto.randomBytes(8).toString('hex');
  const cid = conversationId || uuid();
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Request-ID': uuid(),
    'X-Conversation-ID': cid,
    'X-Conversation-Request-ID': uuid(),
    'X-Conversation-Message-ID': uuid(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'Accept-Encoding': 'identity',
    traceparent: `00-${traceId}-${parentSpanId}-01`,
    b3: `${traceId}-${parentSpanId}-1-${spanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,
    Authorization: `Bearer ${token}`,
  };
  return h;
}

/** 把上游模型对象压成 DSH / OpenAI 两侧都吃得下的形状。 */
export function normalizeModel(raw) {
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
  const reasoning = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning : {};
  return {
    id: raw.id,
    name: raw.name || raw.id,
    contextWindow: raw.maxInputTokens ?? raw.maxAllowedSize ?? null,
    maxTokens: raw.maxOutputTokens ?? null,
    supportsImages: raw.supportsImages === true,
    supportsToolCall: raw.supportsToolCall === true,
    supportsReasoning: raw.supportsReasoning === true || !!reasoning.effort || !!reasoning.defaultEffort,
    onlyReasoning: raw.onlyReasoning === true,
    canDisableThinking: reasoning.canDisableThinking === true,
    defaultEffort: reasoning.defaultEffort || reasoning.effort || null,
    supportedEfforts: Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [],
    credits: typeof raw.credits === 'string' ? raw.credits : null,
    // badge:限时免费:#FF0000 这类标签原样带出，方便 UI 直接展示
    badges: tags.filter((t) => t.startsWith('badge:')),
    tags,
  };
}

export function isChatModel(raw) {
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
  if (tags.some((t) => NON_CHAT_TAGS.has(t))) return false;
  // 没有输出上限的模型基本都不是聊天模型（例如生图模型）
  return Number.isFinite(raw.maxOutputTokens) && raw.maxOutputTokens > 0;
}

export class UpstreamClient {
  constructor({ vault, gateway, fetchImpl } = {}) {
    this.vault = vault;
    this.gateway = (gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.modelsCache = null;
    this.modelsCacheAt = 0;
    this.modelsTtlMs = 5 * 60 * 1000;
  }

  /** 拉一次模型清单；返回 normalized 后的聊天模型数组。 */
  async listModels({ force = false } = {}) {
    if (!force && this.modelsCache && Date.now() - this.modelsCacheAt < this.modelsTtlMs) {
      return this.modelsCache;
    }
    const token = await this.vault.getAccessToken();
    const res = await this.fetchImpl(`${this.gateway}${MODELS_PATH}`, {
      method: 'GET',
      headers: gatewayHeaders(token),
    });
    if (!res.ok) {
      throw new Error(`拉取模型清单失败：HTTP ${res.status}`);
    }
    const body = await res.json();
    const raw = Array.isArray(body?.data?.models) ? body.data.models : [];
    const models = raw.filter(isChatModel).map(normalizeModel);
    if (models.length === 0) {
      // 上游结构变了也别把插件变成哑巴：退回原始列表，至少让人工能看出问题
      const fallback = raw.map(normalizeModel);
      if (fallback.length === 0) throw new Error('模型清单为空，WorkBuddy 账号可能没有可用模型。');
      this.modelsCache = fallback;
      this.modelsCacheAt = Date.now();
      return fallback;
    }
    this.modelsCache = models;
    this.modelsCacheAt = Date.now();
    return models;
  }

  /**
   * 转发一次对话请求，返回原始 Response（SSE 或非流式 JSON 都原样透出）。
   * 401 时刷新令牌后重放一次；只有一次重放机会，避免死循环。
   */
  async chat(payload, { signal, conversationId } = {}) {
    const token = await this.vault.getAccessToken();
    let res = await this.send(payload, token, signal, conversationId);
    if (res.status === 401) {
      // 令牌刚过期：让 vault 强制续期后重试
      this.vault.invalidate();
      try {
        const fresh = await this.vault.getAccessToken();
        if (fresh && fresh !== token) {
          res = await this.send(payload, fresh, signal, conversationId);
        }
      } catch {
        /* 续期失败就把第一次的结果交出去，让上层看到真实状态 */
      }
    }
    return res;
  }

  send(payload, token, signal, conversationId) {
    const init = {
      method: 'POST',
      headers: gatewayHeaders(token, { conversationId }),
      body: JSON.stringify(payload),
      redirect: 'manual',
    };
    if (signal) init.signal = signal;
    return this.fetchImpl(`${this.gateway}${CHAT_PATH}`, init);
  }
}

/**
 * 把 OpenAI 风格请求体翻成 WorkBuddy 网关认得的请求体。
 * 只透传网关认得的参数，别的丢掉——网关对陌生字段会直接拒绝。
 */
const PASSTHROUGH_KEYS = [
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'stream',
  'stream_options',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'user',
  'reasoning_effort',
  'thinking',
  'repetition_penalty',
  'metadata',
];

export function toUpstreamPayload(body) {
  const out = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  // 部分客户端用 maxTokens，网关只认 max_tokens
  if (out.max_tokens === undefined && Number.isFinite(body.maxTokens)) {
    out.max_tokens = body.maxTokens;
  }
  // pi-ai 的 reasoningEffort 落到 OpenAI 的 reasoning_effort
  if (out.reasoning_effort === undefined && typeof body.reasoningEffort === 'string') {
    out.reasoning_effort = body.reasoningEffort;
  }
  if (out.stream === undefined) out.stream = false;
  return out;
}
