# credits-live · WorkBuddy 积分实时看板

在 `credits-dashboard`（定时生成静态快照）基础上的**实时版**：一个常驻 Node 服务，页面打开即拉最新数据，支持多账号、自动刷新、凭证自动续期。

- 零 npm 依赖，只用 Node 内置模块；Node 18+（需要全局 `fetch`）
- 数据来源仍是账号服务端的 billing 接口（`copilot.tencent.com/billing/meter/*`），是逐笔扣费的权威记录
- 支持**多账号**：并行拉取，页面按账号分 tab，顶部汇总合计

---

## 与 credits-dashboard 的区别

| | credits-dashboard | credits-live（本目录） |
|---|---|---|
| 形态 | 跑一次脚本 → 生成 `data.json` → 静态托管 | 常驻服务，页面实时拉数 |
| 数据新鲜度 | 取决于上次跑 build 的时间 | 打开页面即最新，默认 15 秒自动刷新 |
| 多账号 | 支持，静态展示 | 支持，并行拉取 + tab 切换 |
| 部署 | 任意静态托管 | 需要 Node 运行时 |

两个工具可以共存，互不影响。

---

## 目录

```
tools/credits-live/
├─ server.mjs            HTTP 服务：页面、/api/data、/api/health
├─ api.mjs               拉取单个账号的完整快照（余额/消耗/新增/到期）
├─ index.html            看板前端（自动刷新、tab 切换、趋势图）
├─ config.example.json   账号配置模板
├─ history.json          每日余额快照，供趋势图使用
└─ .gitignore            挡住 tokens/ 与 config.json
```

`tokens/` 与 `config.json` 是**本地私有文件，不入库**，需自己创建。

---

## 快速开始

```bash
cd tools/credits-live

# 1. 放入账号凭证
mkdir -p tokens
cp /path/to/your-token.json tokens/main.json
chmod 600 tokens/main.json

# 2. 配置账号
cp config.example.json config.json   # 然后按需改 label / 账号数量

# 3. 启动
node server.mjs                      # 默认 http://localhost:8088
PORT=9000 node server.mjs            # 自定义端口
```

浏览器打开 `http://localhost:8088` 即可。

---

## 账号配置

`config.json`：

```json
{
  "accounts": [
    { "id": "main", "label": "主号", "tokenFile": "tokens/main.json" },
    { "id": "alt",  "label": "小号", "tokenFile": "tokens/alt.json" }
  ]
}
```

- `id` 必须唯一；`label` 是页面上显示的标签
- 配置文件路径可用环境变量 `CREDITS_CONFIG` 覆盖

**凭证文件格式**（`tokens/*.json`）：

```json
{
  "name": "main",
  "uid": "<uid>",
  "accessToken": "<eyJ...>",
  "refreshToken": "<eyJ...>",
  "expiresAt": 1796220270220,
  "refreshExpiresAt": 1798812269220
}
```

`expiresAt` 填 `0` 表示有效期未知，服务会立刻用 refreshToken 续一次。

也可以走环境变量，适合部署到云平台（不要写进仓库）：

```bash
WB_TOKENS="主号:<accessToken>|<refreshToken>,小号:<accessToken>|<refreshToken>" node server.mjs
```

---

## HTTP 接口

| 路径 | 说明 |
|---|---|
| `GET /` | 看板页面 |
| `GET /api/data` | 实时数据 JSON（服务端缓存 20 秒） |
| `GET /api/data?force=1` | 跳过缓存强制刷新 |
| `GET /api/health` | 健康检查：账号数、缓存时间 |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8088 | 监听端口（绑定 `0.0.0.0`） |
| `CACHE_MS` | 20000 | 服务端缓存时长 |
| `CREDITS_CONFIG` | `./config.json` | 配置文件路径 |
| `WB_TOKENS` | — | 内联账号，格式见上 |

---

## 页面功能

- 顶部状态条：绿点正常 / 黄点拉取中 / 红点失败并显示原因
- 刷新间隔可选：10 秒 / 15 秒 / 30 秒 / 1 分钟 / 手动，默认 15 秒
- 「立即刷新」强制绕过服务端缓存
- 切回浏览器标签页时自动刷新
- 趋势图读取 `history.json`，每天首拉自动追加一条，积累 2 天以上后显示

---

## 安全

- `tokens/*.json` 是**可直接登录账号的明文凭证**，已在 `.gitignore` 中，绝不入库
- 返回给前端的数据已剔除 UIN
- 凭证会随使用自动续期（access 约 30 天、refresh 约 60 天），过期需重新导出
- 看板默认展示真实余额，公开分享前先评估

---

## 部署

服务只需一个 Node 进程和开放端口：

```bash
# 例如 pm2
pm2 start server.mjs --name credits-live

# 或 systemd / docker，确保以环境变量注入凭证，不要把 token 打进镜像
```

注意：部署平台需要 Node 运行时，纯静态托管（GitHub Pages 等）跑不了本目录，那种场景请用 `credits-dashboard`。

## 许可

与仓库一致，MIT。
