/**
 * server.mjs —— 只监听 127.0.0.1 的 OpenAI 兼容网关
 *
 * DSH 的 llm-pi-ai 把这里当成一个普通的 OpenAI 兼容端点：
 *   GET  /v1/models            模型清单（来自你的 WorkBuddy 账号）
 *   POST /v1/chat/completions  对话，流式与非流式都支持
 *   GET  /v1/usage             积分消耗（今日 / 近几天 / 余额）
 *   GET  /health               体检
 *   GET  /v1/accounts          当前用哪个 WorkBuddy 账号
 * 上游是 WorkBuddy 网关，令牌在进程内按需取用，从不出现在配置里。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { UpstreamClient, toUpstreamPayload } from './upstream.mjs';
import { safeEqual } from './local-secret.mjs';
import { UsageTracker, extractUsage, dayKey } from './usage-tracker.mjs';
import { BillingClient } from './billing.mjs';
import { explainUpstreamError } from './prompt-shield.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function sendJson(res, status, payload, extraHeaders = null) {
  const body = JSON.stringify(payload);
  const headers = { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

function openaiError(message, type = 'invalid_request_error', code = null, status = 400) {
  return { error: { message, type, param: null, code } };
}

/** SSE 帧解析：按行攒缓冲，逐帧吐出 {event, data}。 */
function createSseParser() {
  let buffer = '';
  return {
    push(chunk, onFrame) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('data:')) {
          onFrame({ event: 'message', data: trimmed.slice(5).trim() });
        }
      }
    },
    flush(onFrame) {
      const trimmed = buffer.trim();
      buffer = '';
      if (trimmed.startsWith('data:')) onFrame({ event: 'message', data: trimmed.slice(5).trim() });
    },
  };
}

class BridgeServer {
  constructor({ vault, gateway, host, port, apiKey, fetchImpl, logger, promptShield } = {}) {
    // 宿主（插件入口）传进来的是 { info, warn, error } 对象，单独跑时可能是个函数。
    // 这里统一成 (level, msg) 的函数形状，免得某个日志分支一跑就 TypeError。
    this.logger = normalizeLogger(logger);
    this.upstream = new UpstreamClient({ vault, gateway, fetchImpl, promptShield });
    // system 提示被改写时留一条痕：排查「模型行为变了」时能对上是哪条规则干的
    this.upstream.onShield = (hits) => this.logger('info', 'system 提示已做等价改写：' + hits.join('、'));
    this.vault = vault;
    this.host = host || '127.0.0.1';
    this.port = Number(port) || 8792;
    this.apiKey = apiKey || '';
    this.server = null;
    this.listeningPort = null;
    this.usage = new UsageTracker();
    this.billing = new BillingClient({ vault, gateway, fetchImpl });
  }

  get baseUrl() {
    return `http://${this.host}:${this.listeningPort || this.port}`;
  }

  /**
   * 端口上已经有本桥在跑就直接接管，不另起一个。
   *
   * 这么干是因为 DSH 侧写死了一个端口：插件内起的桥发现端口被自己人占着时，
   * 与其顺延到别的端口把自己变成一座孤岛，不如认下来那个已经在服务的实例。
   * 它们读的是同一个密钥文件，所以接管过去照样能验签。
   */
  async listenOrAdopt(maxTries = 20) {
    const existing = await this.probeExisting();
    if (existing) {
      this.adopted = true;
      this.listeningPort = this.port;
      return { port: this.port, adopted: true };
    }
    return { port: await this.listen(maxTries), adopted: false };
  }

  /** 探一下端口上的服务是不是本桥。不是就返回 null。 */
  async probeExisting(timeoutMs = 800) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: controller.signal });
      if (!res.ok) return null;
      const j = await res.json().catch(() => null);
      return j && j.service === 'dsh-workbuddy-bridge' ? j : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 起服务。端口被占就顺延，最多试 20 个。 */
  async listen(maxTries = 20) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger('error', '请求处理异常：' + (err && err.message ? err.message : String(err)));
        if (!res.headersSent) sendJson(res, 500, openaiError('桥接服务内部错误。', 'internal_error', 'internal_error', 500));
        else res.end();
      });
    });
    for (let i = 0; i < maxTries; i += 1) {
      const port = this.port + i;
      const ok = await new Promise((resolve) => {
        const onError = (err) => {
          if (err && err.code === 'EADDRINUSE') resolve(false);
          else resolve(false);
        };
        this.server.once('error', onError);
        this.server.listen(port, this.host, () => {
          this.server.removeListener('error', onError);
          this.listeningPort = port;
          resolve(true);
        });
      });
      if (ok) return this.listeningPort;
    }
    throw new Error(`端口 ${this.port} 起的连续 ${maxTries} 个端口都被占用。`);
  }

  async close() {
    // 走之前把还在攒着的账落盘，不然最后几秒的消耗就跟着进程一起没了
    try {
      this.usage.flush();
    } catch {
      /* 落盘失败也不能挡着关闭 */
    }
    // 接管来的实例不是自己起的，别把它关掉
    if (this.adopted) return;
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }

  /* ------------------------------- 路由 ------------------------------- */

  async handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return this.health(res);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    // 只读积分统计：放行给 DSH 界面里的面板。面板跑在宿主渲染进程（浏览器）里，
    // 拿不到 ~/.dsh 下的本机密钥，所以这条路由免密钥——但它泄露的最多是
    // 「今天消耗了多少积分」这种低敏感信息，且 Host 回环校验照常生效，
    // 别机的网页勾不进来。要密钥的路由（模型、对话）不受影响。
    if (req.method === 'GET' && path === '/v1/usage') {
      if (!this.checkHost(req)) {
        return sendJson(res, 401, openaiError('只接受回环访问。', 'invalid_request_error', 'invalid_host', 401));
      }
      const q = url.searchParams;
      const rawDays = Number(q.get('days'));
      return this.usageReport(res, {
        withBalance: q.get('balance') === '1',
        account: q.get('account'),
        days: Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 30) : 7,
      });
    }

    if (!this.checkAuth(req)) {
      return sendJson(res, 401, openaiError('本地桥接密钥不对。', 'invalid_request_error', 'invalid_api_key', 401));
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return this.listModels(res);
    }
    if (req.method === 'GET' && path === '/v1/accounts') {
      return sendJson(res, 200, { object: 'list', data: this.vault.listPublic() });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      return this.chat(req, res);
    }
    return sendJson(res, 404, openaiError(`没有这个路由：${req.method} ${path}`, 'invalid_request_error', 'unknown_route', 404));
  }

  /** 回环校验：Host 头必须是本机回环地址，挡 DNS rebinding 那一类勾连。 */
  checkHost(req) {
    const host = (req.headers.host || '').toLowerCase();
    return host === '' || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  }

  checkAuth(req) {
    if (!this.apiKey) return true;

    if (!this.checkHost(req)) {
      return false;
    }

    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return safeEqual(bearer, this.apiKey) || safeEqual(req.headers['x-api-key'], this.apiKey);
  }

  async health(res) {
    let accounts = [];
    let models = 0;
    let accountError = null;
    try {
      accounts = this.vault.listPublic();
    } catch (e) {
      accountError = e.message;
    }
    try {
      models = (await this.upstream.listModels()).length;
    } catch {
      models = -1;
    }
    sendJson(res, 200, {
      ok: !accountError && models !== -1,
      service: 'dsh-workbuddy-bridge',
      baseUrl: this.baseUrl,
      accounts,
      modelCount: models,
      error: accountError,
      // 排查「这个实例到底是不是打了净化的那份代码」用
      promptShield: this.upstream.promptShield,
    });
  }

  async listModels(res) {
    try {
      const models = await this.upstream.listModels();
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          object: 'model',
          created,
          owned_by: 'workbuddy',
          name: m.name,
          context_window: m.contextWindow,
          max_tokens: m.maxTokens,
          supports_images: m.supportsImages,
          supports_reasoning: m.supportsReasoning,
        })),
      });
    } catch (e) {
      sendJson(res, 502, openaiError(e.message || '取不到模型清单。', 'upstream_error', 'models_unavailable', 502));
    }
  }

  /**
   * 积分消耗报告。
   *
   * 默认只给本地账本（不联网，快）；带 ?balance=1 才去上游查余额，
   * 因为那是一次真实网络请求，不该在每个轮询里都发生。
   */
  /** 当前生效的账号（桥转发请求时用的就是它）。 */
  activeAccount() {
    try {
      const list = this.vault.listPublic();
      const a = list.find((x) => x.isActive) || list[0];
      if (a?.uid) return { uid: String(a.uid), name: a.name || '' };
    } catch {
      /* 拿不到就按 unknown 记 */
    }
    return { uid: null, name: '' };
  }

  /**
   * 积分消耗报告。
   *
   * 默认只给本地账本（不联网，快）；带 ?balance=1 才去上游查余额，
   * 因为那是一次真实网络请求，不该在每个轮询里都发生。
   */
  async usageReport(res, { withBalance = false, account = null, days = 7 } = {}) {
    const active = this.activeAccount();
    // 显式指定账号时按 uid / 名字模糊匹配；没指定就用当前登录的那个
    const picked = account ? this.usage.findAccount(account) : null;
    const uid = picked ? picked.uid : active.uid || this.usage.defaultUid();
    // 查询路径不该有副作用，所以走只读的 accounts()，别用会建桶的 bucket()
    const name = picked
      ? picked.name
      : active.name || this.usage.accounts().find((a) => a.uid === uid)?.name || '';

    const today = this.usage.day({ uid });
    const out = {
      object: 'usage',
      account: { uid, name, isActive: active.uid === uid },
      accounts: this.usage.accounts().map((a) => ({
        uid: a.uid,
        name: a.name,
        credit: a.credit,
        requests: a.requests,
        days: a.days,
      })),
      today: {
        date: today.date,
        credit: today.credit,
        requests: today.requests,
        tokens: today.tokens,
        byModel: Object.entries(today.models || {})
          .map(([model, v]) => ({ model, ...v }))
          .sort((a, b) => b.credit - a.credit),
      },
      recent: this.usage.recent(days, uid),
      total: this.usage.total(uid),
    };

    if (withBalance && active.uid === uid) {
      try {
        const s = await this.billing.summary();
        out.balance = {
          totalCredits: s.totalCredits,
          totalCapacity: this.billing.totalCapacity(s),
          planName: s.planName,
          isPaidUser: s.isPaidUser,
          groups: s.groups,
          fetchedAt: s.fetchedAt,
        };
      } catch (e) {
        out.balance = { error: e.message };
      }
    } else if (withBalance) {
      // 余额是「当前登录账号」的，看历史账号时给它是误导
      out.balance = { error: `余额只对当前登录的账号有效（当前：${active.name || active.uid || '未知'}）。` };
    }
    // 面板在宿主渲染进程里 fetch，跨源，得带 CORS 头才收得到
    sendJson(res, 200, out, { 'Access-Control-Allow-Origin': '*' });
  }

  /** 从一帧 SSE 里抠出消耗并记账。上游只在收尾帧给 usage。 */
  tallyFrame(j, model) {
    const u = extractUsage(j);
    if (!u) return;
    // credit 和 token 都是 0 的帧多半是中间帧，记下来只会把请求数灌水
    if (u.credit === 0 && u.tokens === 0) return;
    const { uid, name } = this.activeAccount();
    this.usage.record({ model, credit: u.credit, tokens: u.tokens, uid: uid || undefined, accountName: name });
  }

  /* ------------------------------- 对话 ------------------------------- */

  async chat(req, res) {
    const raw = await readBody(req, 8 * 1024 * 1024);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, openaiError('请求体不是合法 JSON。', 'invalid_request_error', 'invalid_body', 400));
    }
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, openaiError('请求体必须是 JSON 对象。', 'invalid_request_error', 'invalid_body', 400));
    }
    if (!body.model) {
      return sendJson(res, 400, openaiError('缺少 model 字段。', 'invalid_request_error', 'missing_model', 400));
    }

    const payload = toUpstreamPayload(body);
    const wantsStream = payload.stream === true;
    const conversationId = crypto.randomUUID();

    // WorkBuddy 网关只认流式。要非流式就在桥内把流攒成一整包再交出去。
    payload.stream = true;
    if (!wantsStream && payload.stream_options === undefined) {
      payload.stream_options = { include_usage: true };
    }

    let upstream;
    try {
      upstream = await this.upstream.chat(payload, {
        signal: req.signal || null,
        conversationId,
      });
    } catch (e) {
      return sendJson(res, 502, openaiError(`连不上 WorkBuddy 网关：${e.message}`, 'upstream_error', 'upstream_unreachable', 502));
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let message = `WorkBuddy 网关返回 HTTP ${upstream.status}`;
      let code = 'upstream_error';
      try {
        const j = JSON.parse(text);
        if (j?.error?.message || j?.msg) {
          message = j.error?.message || j.msg;
          if (j.error?.code) code = j.error.code;
        }
      } catch {
        if (text) message += `：${text.slice(0, 300)}`;
      }
      const status = upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502;
      return sendJson(res, status, openaiError(explainUpstreamError(message), 'upstream_error', code, status));
    }

    if (wantsStream) {
      return this.streamOut(upstream, res, body.model, contentType);
    }
    return this.collectOut(upstream, res, body.model, contentType);
  }

  /** 流式：把上游 SSE 归一化后原样吐给 DSH。 */
  async streamOut(upstream, res, model, contentType) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!contentType.includes('event-stream') && !contentType.includes('text/')) {
      // 上游没给 SSE：把整包 JSON 拆成一帧吐出去
      const text = await upstream.text().catch(() => '');
      try {
        const j = JSON.parse(text);
        res.write(`data: ${JSON.stringify(rechunk(j, { id, created, model }))}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify(rechunk({ choices: [{ delta: { content: text } }] }, { id, created, model }))}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const parser = createSseParser();
    let finished = false;
    let sawFinish = false;
    let lastUsage = null;
    const reader = upstream.body?.getReader();
    if (!reader) {
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }), (frame) => {
          if (frame.data === '[DONE]') return;
          let j;
          try {
            j = JSON.parse(frame.data);
          } catch {
            return;
          }
          if (j.error) {
            res.write(`data: ${JSON.stringify({ error: j.error })}\n\n`);
            return;
          }
          const choice = j.choices?.[0];
          if (choice?.finish_reason) sawFinish = true;
          // 记账：上游只在收尾帧给 usage（中间帧是 null），攒到流末统一记一次，
          // 免得哪天上游改成逐帧给值时把一次调用记成十几遍
          if (j.usage && typeof j.usage === 'object') lastUsage = j.usage;
          res.write(`data: ${JSON.stringify(rechunk(j, { id, created, model }))}\n\n`);
        });
      }
      parser.flush((frame) => {
        if (frame.data === '[DONE]') return;
        try {
          const j = JSON.parse(frame.data);
          if (j.choices?.[0]?.finish_reason) sawFinish = true;
          if (j.usage && typeof j.usage === 'object') lastUsage = j.usage;
          res.write(`data: ${JSON.stringify(rechunk(j, { id, created, model }))}\n\n`);
        } catch {
          /* 残帧丢掉 */
        }
      });
      if (lastUsage) this.tallyFrame({ usage: lastUsage }, model);
      // 上游没给结束原因时补一帧，免得 DSH 认为流被截断
      if (!sawFinish) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
      }
      finished = true;
      res.write('data: [DONE]\n\n');
    } catch (e) {
      if (!finished) {
        this.logger('warn', '上游流中断：' + (e && e.message ? e.message : String(e)));
      }
    } finally {
      res.end();
    }
  }

  /** 非流式：攒完整段再一次性回一个标准 ChatCompletion。 */
  async collectOut(upstream, res, model, contentType) {
    if (contentType.includes('event-stream')) {
      // 极少数情况下上游无视 stream:false 仍然流式返回，这里攒起来
      const reader = upstream.body?.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      let content = '';
      let reasoning = '';
      let finishReason = 'stop';
      let usage = null;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }), (frame) => {
            if (frame.data === '[DONE]') return;
            try {
              const j = JSON.parse(frame.data);
              const d = j.choices?.[0]?.delta;
              if (d?.content) content += d.content;
              if (d?.reasoning_content) reasoning += d.reasoning_content;
              if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
              if (j.usage) usage = j.usage;
            } catch {
              /* 坏帧跳过 */
            }
          });
        }
      }
      if (usage) this.tallyFrame({ usage }, model);
      return sendJson(res, 200, buildCompletion({ model, content, reasoning, finishReason, usage }));
    }

    const text = await upstream.text().catch(() => '');
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return sendJson(res, 502, openaiError('上游返回了非 JSON 内容。', 'upstream_error', 'invalid_upstream', 502));
    }
    const choice = j.choices?.[0] || {};
    const message = choice.message || {};
    if (j.usage) this.tallyFrame(j, model);
    sendJson(res, 200, {
      ...j,
      id: j.id || `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: j.created || Math.floor(Date.now() / 1000),
      model: j.model || model,
      choices: [
        {
          index: 0,
          message: {
            role: message.role || 'assistant',
            content: message.content ?? '',
            ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
            ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
          },
          finish_reason: choice.finish_reason || 'stop',
        },
      ],
      ...(j.usage ? { usage: j.usage } : {}),
    });
  }
}

/** 把「函数」和「{info,warn,error} 对象」两种 logger 统一成 (level, msg) 形式。 */
function normalizeLogger(input) {
  if (typeof input === 'function') return input;
  if (input && typeof input === 'object') {
    return (level, msg) => {
      const fn = typeof input[level] === 'function' ? input[level] : input.info;
      try {
        fn?.call(input, msg);
      } catch {
        /* 日志坏了不能挡住请求 */
      }
    };
  }
  return () => {};
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 把上游的一帧改成标准 OpenAI chunk（保留 reasoning_content / tool_calls 等附加字段）。 */
function rechunk(j, { id, created, model }) {
  const src = j.choices?.[0] || {};
  const delta = { ...(src.delta || {}) };
  if (src.finish_reason) {
    return {
      id: j.id || id,
      object: 'chat.completion.chunk',
      created: j.created || created,
      model: j.model || model,
      choices: [{ index: src.index ?? 0, delta: Object.keys(delta).length ? delta : {}, finish_reason: src.finish_reason }],
      ...(j.usage ? { usage: j.usage } : {}),
    };
  }
  return {
    id: j.id || id,
    object: 'chat.completion.chunk',
    created: j.created || created,
    model: j.model || model,
    choices: [{ index: src.index ?? 0, delta }],
    ...(j.usage ? { usage: j.usage } : {}),
  };
}

function buildCompletion({ model, content, reasoning, finishReason, usage }) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finishReason || 'stop',
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export { BridgeServer };
