# credits-dashboard · WorkBuddy 积分看板

查 **WorkBuddy 账号侧积分**（余额 / 今日消耗 / 今日新增 / 积分包到期），落成一份可直接托管的静态看板，可选每天推送到 QQ。

- 数据全部来自**账号服务端**的 billing 接口（`copilot.tencent.com/billing/meter/*`），是逐笔扣费的权威记录，不是从本机会话日志猜的。
- 支持**多账号**：看板按账号分 tab，趋势图每个账号一条线，日报每个账号一行。
- 零 npm 依赖，只用 Node 内置模块；Node 18+（需要全局 `fetch`）。

> 这是附带在本仓库里的独立工具，**不是 DSH 插件**，不需要 `install.mjs`、不注入宿主。

---

## 目录

```
tools/credits-dashboard/
├─ bin/
│  ├─ credits-account.mjs   查单个账号的积分（人读文本 / --json）
│  ├─ dump-token.mjs        把本机登录态导出成凭证文件，供别的机器或别的账号查
│  ├─ list-accounts.mjs     看本机登录态里有几个账号
│  ├─ build.mjs             遍历 config.accounts → 写 dashboard/data.json、history.json
│  ├─ push.mjs              把当日快照推送到 QQ（Qmsg 酱）
│  ├─ daily.mjs             build + push 一条龙，给定时任务用
│  └─ _lib.mjs              定位 dsh-workbuddy-bridge/lib（令牌库）
├─ dashboard/               发布目录，纯静态
│  ├─ index.html
│  ├─ data.json             当前快照（由 build.mjs 生成）
│  └─ history.json          每日一条，画趋势
├─ config.example.json      配置模板
└─ .gitignore               挡住 config.json 与 tokens/
```

`config.json` 与 `tokens/` 是**本地私有文件，必须自己去建、绝不会入库**。

---

## 快速开始

```bash
cd tools/credits-dashboard
cp config.example.json config.json      # 然后按下面改
```

### 1. 令牌库位置

脚本复用 `plugins/dsh-workbuddy-bridge/lib/workbuddy-token.mjs` 读取本机登录态。clone 下来的仓库天然满足；如果放在别处，设环境变量：

```bash
export WORKBUDDY_LIB=/path/to/dsh-workbuddy-bridge/lib
```

### 2. 账号怎么配

`accounts[]` 每项二选一：

| 写法 | 适用 | 说明 |
|---|---|---|
| `{"id":"main","label":"主号","uid":"<uid>"}` | 查**本机当前登录**的账号 | `node bin/dump-token.mjs --list` 能看到 uid |
| `{"id":"a2","label":"小号","tokenFile":"tokens/a2.json"}` | 查**任意**账号 | 先 `node bin/dump-token.mjs --out tokens/a2.json` 导出凭证 |

**多账号建议全部用 `tokenFile`**：本机登录态只保留最后登录的那一个号，切号会把别的号覆盖掉；凭证文件则不受影响。

凭证有效期：access 约 30 天、refresh 约 60 天，过期重新导一次即可。

### 3. 刷数据

```bash
node bin/build.mjs                 # 刷新全部账号
node bin/build.mjs --only main     # 只刷一个
node bin/build.mjs --no-hist       # 不写 history.json
node bin/credits-account.mjs       # 单账号，人读格式（排查用）
```

### 4. 看板

`dashboard/` 是纯静态目录，`index.html` 用 `fetch('./data.json')` 取数，所以**不能直接双击打开**（file:// 会被 CORS 挡），起个静态服务或丢到任意静态托管：

```bash
python -m http.server 8080 --directory dashboard
```

### 5. 推送 / 每日

```bash
node bin/push.mjs --dry            # 只打印文案，不发送
node bin/push.mjs                  # 真发
node bin/daily.mjs                 # build + push，定时任务调这个
```

Qmsg 酱会拦截 **URL、IPv4、长连续数字串**，所以日报正文不放分享链接、不放 UIN，日期写成「11月17日」。

---

## 定时任务

Windows 任务计划程序 / cron 每天跑一次即可：

```bash
node bin/daily.mjs
# 之后再把 dashboard/ 重新发布到你的静态托管（脚本不管发布这一步）
```

注意：如果托管平台按账号区分应用归属，**发布时登录的账号必须和应用所属账号一致**，否则会报无权覆盖。

---

## 安全

- `config.json` 含 Qmsg key，`tokens/*.json` 含可直接登录账号的 accessToken —— 两个都已在 `.gitignore` 里。
- 生成给看板的数据会主动剔除 UIN（`build.mjs` 里 `delete r.account?.uin`），因为看板是公开的。
- 看板默认展示真实余额，要公开分享就先想清楚这一点。

## 许可

与仓库一致，MIT。
