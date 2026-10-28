# dsh-workbuddy-bridge

把**本机 WorkBuddy 账号里的模型**，接进 **DeepSeek Harness（DSH）**当聊天模型用。

DSH 侧就是一个普通的 OpenAI 兼容端点。插件在 DSH 进程内起一个**只监听 127.0.0.1** 的小服务，
把 DSH 的 `openai-completions` 请求翻成 WorkBuddy 网关请求；令牌从本机 WorkBuddy 客户端的
加密登录态里现取现用，**不落盘、不进配置、过期自动续期**。

```
DSH (llm-pi-ai) ──► 127.0.0.1:8792/v1/chat/completions ──► copilot.tencent.com/v2/chat/completions
                          （本机桥接，令牌在内存里）
```

桥接与 DSH 之间还有一把**本机随机密钥**：DSH 的 `llm-pi-ai` 在发请求前会断言 provider
必须有密钥，缺了就直接抛 `No API key for provider: workbuddy`，请求根本发不出去。所以安装
器会生成一把随机密钥，同时写进三处——交出去的始终是这把本机钥匙，**真正的 WorkBuddy 令牌
从不离开桥接进程**。

## 它能给你什么

- 账号里**全部 33 个模型**（GLM / Kimi / DeepSeek / MiniMax / 混元 / Step / MiMo …）直接出现在 DSH 的模型选择器里
- 走的是你自己的 WorkBuddy 额度，**不需要另外申请任何 API Key**
- 流式、非流式、工具调用、视觉输入、推理内容都透传
- **思考等级可调**：上游声明了 `supportedEfforts` 的 10 个模型，DSH 里会出现「Reasoning effort」下拉框
- 令牌过期自动续；客户端换了登录态，桥接跟着走

## 装

```bash
node install.mjs                            # 装到 desktop profile
node install.mjs --profile web              # 装到别的 profile
node install.mjs --port 8793                # 8792 被占了就换一个
node install.mjs --set-default glm-5.3-flash  # 顺手把默认模型换掉
node install.mjs --rotate-key               # 换一把新的本机密钥
node install.mjs --dsh-home D:\x\.dsh      # 装到别的主目录

node uninstall.mjs                          # 卸载
```

> 顶层 `install.mjs` / `uninstall.mjs` 只是转发入口，实际逻辑在 `tools/install.mjs`。
> 直接跑 `node tools/install.mjs [...]` 效果完全一样。

安装器会做这些事，每步之前都留一份 `.bak-<时间戳>` 备份：

1. `profiles/<name>/package.json` —— 加 `file:` 依赖 + 加进 `dsh.profile.bundles`
2. `profiles/<name>/cordis.patch.yml` —— 把 `workbuddy` provider 合进 `llm-pi-ai.providers`，
   带上 `apiKeyEnv` 与 `headers.Authorization`；再给 `workbuddy-bridge` 条目写同一把钥匙
3. `~/.dsh/.credentials.yaml` —— 往 `refs` 里写 `WORKBUDDY_API_KEY`（DSH 走 credentials
   服务取密钥时用的那条路）
4. `~/.dsh/.workbuddy-bridge.json` —— 密钥本体，桥接起来时读它
5. `profiles/<name>/node_modules/` —— 软链过去（Windows 上建不了 junction 就退化为拷贝）

密钥三条路径都铺了，DSH 走哪条都能通。整个过程是幂等的，重跑就是「刷新模型清单」。

**装完要完全退出 DSH 再打开**，新 bundle、新密钥都要重启才生效。

### 换台机器装

能装。代码里没有任何写死本机路径的东西：WorkBuddy 客户端的位置靠注册表和环境变量找，
profile 走 `~/.dsh`，账号从**那台机器上登录的** WorkBuddy 取。Windows / macOS / Linux
三类路径都覆盖了。

那台机器上先得有：

- **WorkBuddy 客户端装了并且登录过**（令牌是从它的加密登录态里解出来的，没登录就没得解）
- **DeepSeek Harness 装了并至少启动过一次**（要存在 `~/.dsh/profiles/desktop`）
- **Node 18 以上**

然后：

```bash
git clone https://github.com/463759964/dsh-plugins.git
cd dsh-plugins/plugins/dsh-workbuddy-bridge
node install.mjs                # 或者双击 install.cmd
```

装完一样要完全退出 DSH 再打开。安装器会自己检查前置条件，缺哪样会说清楚。

换机器后有几处不一样，别当成坏了：

| | 说明 |
| --- | --- |
| 本机密钥 | 每台机器各生成一把，互不影响，旧的不用动 |
| 积分账本 | **本地文件，不跟账号走**。新机器从零开始记；余额倒是跟账号走的，随时能查 |
| 模型清单 | 装的时候抓的快照。账号里上新模型了，重跑一次 `node tools/install.mjs` |
| 账号 | 可以是同一个，也可以是另一个。账本按 uid 分桶，两台机器各记各的账 |
| 思考等级 | 跟着模型清单一起写进配置，重跑安装器即可同步 |

## 用

### 日常用法

装完、重启 DSH 之后就没什么要管的了——插件在 DSH 进程内把桥接服务拉起来，
默认模型已经指向 `workbuddy`，直接开聊就是。

想知道账号里现在有什么模型：

```bash
node tools/list-models.mjs
```

想换默认模型（不用重启 DSH，改的是配置，下次新建会话生效）：

```bash
node install.mjs --set-default deepseek-v4.1-flash
node install.mjs --set-default glm-5.3          # 换 GLM
node install.mjs --set-default kimi-k2.7        # 换 Kimi
```

在 DSH 界面里切：设置 → 模型 → provider「WorkBuddy 账号」，下面挂着全部 33 个模型。

### 在 DSH 界面里看（推荐）

装好后，DSH 聊天输入框上方会出现一条小徽章：**「今日 28.2 积分 · 余 4199.8」**，
悬停展开详情（今日消耗、请求数、tokens、按模型拆分、余额与套餐）。
每 30 秒自动刷新；桥接没在跑时徽章自动消失，不留占位。

> 如果装了面板后看不到：徽章只在「桥接活着」时出现。先跑 `node tools/doctor.mjs`
> 确认桥接正常，再确认浏览器里能打开 `http://127.0.0.1:8792/v1/usage`（返回 JSON）。

### 命令行

```bash
node tools/credits.mjs                  # 今日消耗 + 按模型拆分 + 余额
node tools/credits.mjs --watch 10       # 每 10 秒刷新一次，挂着看
node tools/credits.mjs --days 14        # 近 14 天走势
node tools/credits.mjs --account 张三    # 看某个账号的账
node tools/credits.mjs --no-balance     # 不联网，只看本地账本
node tools/credits.mjs --json           # 输出 JSON，方便脚本接
```

也可以双击 `show-credits.cmd`（持续刷新，关窗即退出）。

长这样：

```
WorkBuddy 积分消耗 · your-name · 8f3a1c…（账号 uid 已脱敏）

今日 2026-10-24
  已消耗      10.05 积分   请求     84 次   tokens 17,802,496
  按模型
    deepseek-v4.1-flash       10.04      82 次
    kimi-k2.7                  0.01       1 次
    glm-5.3                       0       1 次

近 1 天
  2026-10-24       10.05     84 次  ████████████████████████  ← 今天

累计 10.05 积分 · 84 次请求（2026-10-24，1 天有记录）
余额 4208.86 积分 · 已用 827.14/5036 · 体验版
```

**数据从哪来。** 桥接就坐在「DSH ↔ WorkBuddy 网关」的必经之路上，转发时顺手把上游
返回的 `usage.credit` 记下来——这是上游按本次调用**实算**出来的消耗，跟着账号走。
账本落在 `~/.dsh/workbuddy-usage.json`，按「账号 uid → 日期 → 模型」分桶，只留 30 天。

有三个细节值得知道：

- 上游**只在收尾的那一帧**给 `usage`（中途帧是 `null`），所以桥接攒到流末统一记一次，
  不会把一次调用按帧数记成十几遍
- **限免模型的 `credit` 是 0**，但请求数和 token 照记——不然统计里就凭空少了一堆调用
- 余额走的是另一个接口，给的是「还剩多少 / 本周期容量」，和「今日流水」正好互补。
  它要联网，所以只有加 `--balance`（默认开）才查，`--no-balance` 就纯看本地账本

**「跟随账号」是怎么做到的。** credit 本身就是上游按账号算的，账本按 uid 分桶，
切了 WorkBuddy 账号各记各的账，不会混成一笔糊涂账。多账号用 `--account` 切着看。
桥接没在跑时 CLI 会退回去直接读账本——历史照样能看，只是余额查不了。

想直接问桥接也行（`/v1/usage` 端点）：

```bash
curl -s -H "Authorization: Bearer 本机那把钥匙" \
  "http://127.0.0.1:8792/v1/usage?balance=1&days=14"
```

> 账本存在本机，**换机器不跟着走**；上游余额才是真正跟账号走的那个。
> 多进程（DSH 内的插件 + 自己手动起的桥）写同一份账本时，落盘走的是增量合并，
> 谁先谁后都不丢账。

### 思考等级

DSH 只在模型「声明了推理能力」时才显示「Reasoning effort」下拉框，而手写进配置的模型
默认不带这个声明。安装器按上游 `supportedEfforts` 把等级写进 `reasoningEfforts`，
所以**上游给了等级清单的模型，DSH 里就能选**：

| 模型 | 可选等级 |
| --- | --- |
| `glm-5.3`、`glm-5.3-flash` | low / high / max |
| `deepseek-v4.1-flash`、`kimi-k2.8-preview` | 关闭 / low / high / max |
| `space-bunny`、`minimax-m3.1-flash` | low / medium / high / xhigh / max |
| `step-5-preview` | low / medium / high |
| `hy3-x` | low / high |
| `hy4-preview`、`hy4-preview-x` | high |

其余模型上游没给等级清单（多数是固定思考行为的），就不声明——硬编一个等级上去是编数据。
想确认当前配置里哪些模型能调，跑 `node tools/check-reasoning.mjs`。

`off`（关闭思考）只有上游标了 `canDisableThinking` 的模型才有。选中时不发推理参数，
让上游按自己的默认走；不支持关闭的模型不给这个选项。

### 不想让 DSH 托管服务

比如想常驻、想单独调试，可以自己起：

```bash
node lib/serve.mjs --port 8792      # 或双击 start-bridge.cmd
```

然后在 DSH 设置 → 模型 → 添加自定义 provider：

| 项 | 值 |
| --- | --- |
| Provider ID | `workbuddy` |
| 协议 | `openai-completions` |
| Base URL | `http://127.0.0.1:8792/v1` |
| API Key | **必须填本机那把真钥匙**，见下 |

密钥在这三个地方一致，取哪个都行：

```bash
node tools/verify-config.mjs        # 顺带打印三处是否对齐
```

或者直接从密钥文件里读：

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE + '/.dsh/.workbuddy-bridge.json','utf8')).apiKey)"
```

> 手填**不能**随便写。桥接是按常量时间比对 `Authorization: Bearer` 的，
> 填错就是一片 401。这也正是「DSH 托管」更省事的原因——那条路由安装器自己对齐。

模型清单可以点「ask the endpoint」让 DSH 自己来问 `/v1/models`。

## 体检

```bash
node tools/doctor.mjs           # 密钥一致性 → 令牌 → 端口 → 401 校验 → 模型 → 流式 → 非流式
node tools/verify-config.mjs    # 只查配置，不连上游
node tools/probe-live.mjs       # 只测「正在跑的那个桥」的鉴权：无密钥/错密钥/伪造 Host 该不该 401
node tools/check-reasoning.mjs  # 哪些模型能调思考等级，声明会不会被 DSH 拒
node tools/verify-with-host.mjs # 拿宿主自己的 schema 和请求构造器跑一遍
node tools/list-models.mjs      # 只看账号里有什么模型
node tools/credits.mjs          # 看今天花了多少积分
node tools/test-usage.mjs       # 账本单元测试（多进程落盘 / 老格式迁移 / 分桶）
```

`verify-with-host.mjs` 是这几项里最硬的一个：它不照着文档自己验自己，而是直接
`import` 宿主解包后的 `@deepseek-ai/dsh-llm-pi-ai`，用它的 schemastery schema 校验
配置（被拒的话整个 provider 会从选择器里消失），再调 pi-ai 的 `openai-completions`
对假上游发请求，确认 `reasoning_effort` 真的进了请求体。

`doctor` 发现 8792 上已经是本桥在跑时会**接管**它，这时「错误密钥被拒」那项会自动跳过
（外部实例自己决定要不要校验，测不了）。想确认 DSH 里那个桥的鉴权真的生效，
跑 `probe-live.mjs`——它用原始 socket 绕过 fetch 对 Host 头的限制，四种情况各打一发。

装完还是报 `No API key for provider: workbuddy`，先跑 `verify-config.mjs`：它会逐条告诉你
三处密钥哪一处没对上。

## 配置

`cordis.patch.yml` 里 `workbuddy-bridge` 条目可覆盖：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 别改成 0.0.0.0 |
| `port` | `8792` | 端口上已是本桥在跑就直接接管它，否则顺延；DSH 侧配置是固定的，最好别让它撞 |
| `apiKey` | 安装器生成 | 不匹配的 `Authorization: Bearer` 会被 401 挡回；留空则不校验 |
| `uid` | 空 | 多账号时指定用哪个（uid 或昵称），留空用当前登录的那个 |
| `promptShield` | `true` | system 提示净化，见下面「整轮 502」那条。排查净化本身时才需要关 |

## 排障

| 现象 | 原因与处置 |
| --- | --- |
| 整轮 502：`Illegal API invocation from an unapproved channel` | 上游网关按 **system 提示的措辞**判定「这是不是别的 agent 产品在调我们的模型」，命中就整轮拒。和模型、令牌、请求头都无关：同样令牌发小 payload 正常，同一段话放进 user 角色也正常。桥默认会把已知的渠道特征段落（目前是 DSH 那句「Tokens prefixed with @ …」）**等价改写**后转发，实测 31k 的 system 整段可通过。仍旧报错说明 DSH 又加了新的特征段：`node tools/bisect-system.mjs` 会二分定位到具体段落，按 `lib/prompt-shield.mjs` 的 `RULES` 格式加一条即可。 |
| 选某个模型就报 `model [xxx] service info not found` | 这个模型在 WorkBuddy 侧已下线或未接入，但它的名字还挂在账号的模型清单里。换一个模型即可；重跑 `node tools/install.mjs` 会用最新清单覆盖 profile。 |
| `No API key for provider: workbuddy` | DSH 没拿到密钥。跑 `node tools/verify-config.mjs` 逐条看三处密钥哪处没对上，然后 `node tools/install.mjs` 重装修好，**重启 DSH**。 |
| 请求全部 401 | 桥接手里的密钥和 DSH 发出的不是同一把。通常是改过密钥但没重启——重启 DSH；或者在设置页手填过别的密钥，见下条。 |
| 设置页手填了密钥之后全 401 | 别手填。密钥已经由安装器写好了，手填的值会和桥接对不上。要恢复就跑 `node tools/install.mjs --rotate-key` 再重启。 |
| 设置 → 模型里看不到模型 | DSH 会回写 profile 文件把它冲掉。重跑 `node tools/install.mjs` + 重启。 |
| 没有「思考等级」下拉框 | 分两种：整个模型都没调选项 → 上游没给这个模型的等级清单，正常；装过一次还是没有 → 跑 `node tools/check-reasoning.mjs` 看声明在不在，然后重启 DSH。 |
| 选了等级但行为没变 | 跑 `node tools/verify-with-host.mjs` 确认 `reasoning_effort` 进了请求体；再跑 `node tools/probe-reasoning.mjs <模型> <等级>` 确认上游接受这个值。 |
| 端口被占 | 换端口：`node tools/install.mjs --port 8793`。如果 8792 上已经是本桥在跑，插件会直接接管它，不用管。 |
| 积分一直是 0，但明明在用 | 多半是用了限免模型——上游给的 `credit` 就是 0，请求数和 token 照记。跑 `node tools/probe-credit-value.mjs <模型>` 看这个模型到底给不给值。 |
| 请求数比实际调用次数多 | 不应该：桥接是攒到流末统一记一次的。真出现了，跑 `node tools/probe-usage-frames.mjs` 看上游是不是改成逐帧给 `usage` 了。 |
| credits 说「桥接没在跑」 | 正常降级：桥不跑时 CLI 退回去读本地账本，历史照看，只是余额查不了。想连余额一起看就把桥起来（`node lib/serve.mjs`）或者重启 DSH。 |
| 看的是别人的账号 | 账本按 uid 分桶。`node tools/credits.mjs` 看的是当前登录的账号，切 `--account <名字或 uid>` 看别的。 |

## 它是怎么拿到令牌的

WorkBuddy 客户端把登录态以 `{"$wbEncrypted":1,...}` 信封（AES-256-GCM）存在
`<用户数据>/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`。桥接服务：

1. 借客户端自带的 Electron 运行时（`ELECTRON_RUN_AS_NODE=1`）调原生绑定
   `electron_browser_workbuddy_storage.loggerGet()`，拿到本机 `atRestSecretKey`；
2. `sha256` 得到 32 字节 AES 密钥（只经管道，**不落盘**）；
3. 解开信封取出明文 access / refresh 令牌，**只留在内存里**；
4. 剩余有效期不足 5 分钟时用 refresh 令牌续期（客户端 < 5.6 的明文登录态直接读）。

**安全边界**：

- 令牌从不写进任何文件、日志或配置；HTTP 服务只绑定回环地址；对外通信只到 `copilot.tencent.com`。
- 桥接还要求 `Host` 头必须是回环地址，挡的是拿伪造 Host 把这台机器上的桥勾出去（DNS rebinding 那一类）。
- 密钥比对走常量时间，不让计时侧信道泄露内容。
- 把 `host` 改成 `0.0.0.0` 等于把你的账号额度暴露在局域网里——别这么干。

## 已知边界

- WorkBuddy 网关只接受流式请求，所以「非流式」是桥接在内部把流攒成一整包再交出去的。
- 模型清单是安装时抓的快照。账号里上新模型了，重跑一次 `node tools/install.mjs` 即可。
- 写进 provider 配置的字段克制在 `id / name / contextWindow / maxTokens / input /
  reasoningEfforts` 这几个 DSH 认得的键上。上游的积分倍率、限免标签、模型描述这些
  **没有**写进去——碰 DSH 还不认的字段会让整段配置加载失败，代价是全部 33 个模型一起消失。
- 上游没给 `supportedEfforts` 的模型不声明思考等级（见上文）。这不是漏配，是上游
  本来就没给等级清单。

## 目录

```
dsh-workbuddy-bridge/
├── client.js            浏览器侧：输入框上方的积分徽章
├── cordis.patch.yml     bundle patch：把桥接服务插进层栈
├── package.json         dsh.bundle.patch + dsh.client.platform
├── install.mjs          顶层安装入口（转发到 tools/install.mjs）
├── uninstall.mjs        顶层卸载入口（转发到 tools/install.mjs --remove）
├── install.cmd          双击安装（Windows）
├── start-bridge.cmd     双击单独起服务（Windows）
├── show-credits.cmd     双击看积分（Windows）
├── lib/
│   ├── index.js             DSH 插件宿主入口（cordis：export name + apply）
│   ├── serve.mjs            启动器，可单独跑
│   ├── server.mjs           OpenAI 兼容 HTTP 服务（含密钥与 Host 校验）
│   ├── upstream.mjs         WorkBuddy 网关客户端（模型清单 + 对话 + 401 续期）
│   ├── workbuddy-token.mjs  本机登录态解密 + 令牌续期
│   ├── local-secret.mjs     本机桥接密钥的生成 / 读取 / 常量时间比对
│   ├── usage-tracker.mjs    积分消耗账本（按账号/日期/模型分桶，增量落盘）
│   └── billing.mjs          账号额度查询（剩余积分与周期容量）
└── tools/
    ├── install.mjs              安装 / 卸载 / 改默认模型 / 换密钥（实际逻辑）
    ├── doctor.mjs               一条命令体检
    ├── verify-config.mjs        只查配置，不连上游
    ├── verify-with-host.mjs     用宿主真实 schema + 请求构造器校验（最硬的一道）
    ├── check-reasoning.mjs      思考等级声明的合法性与覆盖面
    ├── list-models.mjs          打印账号模型
    ├── credits.mjs              看今天花了多少积分（CLI）
    ├── test-usage.mjs           账本单元测试
    ├── test-junction-safety.mjs 验证卸载不会顺着软链删掉源工程
    ├── probe-live.mjs           实测运行中桥接的鉴权行为（原始 socket）
    ├── probe-reasoning.mjs      实测上游网关接不接受某个思考等级
    ├── probe-usage.mjs          探测积分消耗数据的来源（对话 SSE / 用量接口）
    ├── probe-usage-frames.mjs   确认每帧 usage 是累积还是只在收尾帧给
    ├── probe-credit-value.mjs   验证 usage.credit 是不是真实非零值
    ├── probe-billing.mjs        看额度接口返回什么
    └── probe.mjs                最小验证脚本（调试用）
```

## License

MIT
