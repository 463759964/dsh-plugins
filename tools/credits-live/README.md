# WorkBuddy 积分看板 · 实时

多账号 WorkBuddy 积分实时看板。单文件 Node 服务 + 静态页面，**零外部依赖**（仅用 Node 18+ 内置模块）。

## 功能

- 多账号实时余额、今日消耗（逐笔扣费聚合，按模型/笔数）
- 积分包到期分布（7 天红 / 30 天黄 / 其余绿，长期有效单独统计）
- 账号详情页签：概览、按模型消耗、积分包明细
- 页面自动轮询刷新（15s / 30s / 1min / 手动），服务端 60s 缓存
- 凭证自动续期：access token 过期前 5 分钟自动用 refresh token 续期

## 目录结构

```
credit-dashboard/
├── server.mjs            # 服务端：静态页面 + /api/data 取数接口
├── public/index.html     # 看板前端（无构建，纯静态）
├── config.json           # 账号凭证（敏感，勿提交/外传）
├── config.example.json   # 配置模板
├── package.json
└── README.md
```

## 快速开始

```bash
# 1. 准备配置
cp config.example.json config.json
# 编辑 config.json，填入各账号的 accessToken / refreshToken / expiresAt

# 2. 启动
node server.mjs
# 或
npm start

# 3. 访问
# http://localhost:3000
```

## 配置说明（config.json）

```json
{
  "accounts": [
    {
      "label": "账号名",        // 展示用名称
      "accessToken": "eyJ...",  // Bearer token
      "refreshToken": "eyJ...", // 用于自动续期
      "expiresAt": 1796801130495 // access token 过期时间（ms），可不填
    }
  ]
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| 绑定地址 | `0.0.0.0` | 固定，便于容器/反代部署 |

## API

- `GET /` — 看板页面
- `GET /api/data` — 三账号实时数据 JSON（服务端缓存 60s）
- `GET /api/data?force=1` — 强制刷新（绕过缓存）
- `GET /healthz` — 健康检查

## 部署

任意支持 Node 18+ 的环境均可：

- **自有服务器 / VPS**：`nohup node server.mjs &` 或用 systemd / pm2 守护
- **Docker**：`docker run -v ./config.json:/app/config.json -p 3000:3000 -e PORT=3000 node:20 node /app/server.mjs`
- **反向代理**：直接反代到 `$PORT`，无需特殊配置

## 安全提示

- `config.json` 含账号凭证，**不要提交到仓库或分享给他人**（已写入 `.gitignore`）
- 服务暴露的 `/api/data` 不含凭证本身，只返回积分数据，但仍建议加访问控制（如反代层 Basic Auth 或内网部署）
