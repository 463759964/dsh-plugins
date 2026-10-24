# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件合集 · A collection of DSH plugins.

每个插件都是独立、零依赖、可单独安装的。装上即用，卸载不留痕。

<p>
  <img alt="plugins" src="https://img.shields.io/badge/plugins-2-4d6bfe">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## 插件列表

| 插件 | 一句话 | 类型 |
|---|---|---|
| [workbuddy-bridge](plugins/dsh-workbuddy-bridge) | 把**本机 WorkBuddy 账号里的模型**接进 DSH 当聊天模型，并在输入框上方显示今日积分消耗 | Host + Client |
| [session-purge](plugins/session-purge) | 侧边栏批量**彻底删除**会话（日志 + 缓存 + 记账 + 提醒），不进回收站 | Host + Client |

---

## 通用安装方式

所有插件都遵循同一套约定：**零 npm 依赖**，Host 侧只用 Node 内置模块，Client 侧只用 shell 自带的 `react`。所以不需要编译、不需要装依赖、不需要联网。

### 方式一：脚本安装（推荐）

```bash
cd plugins/<插件名>
node install.mjs                    # 装进 desktop profile
node install.mjs --profile web      # 装进别的 profile
node install.mjs --home D:\x\.dsh   # 装进别的主目录
node install.mjs --dry-run          # 先看要动什么，不写文件
```

装完**重启 DSH**（桌面端退出重开）。卸载：`node uninstall.mjs`。

### 方式二：pnpm 正规依赖

```bash
dsh plugin --profile desktop add file:C:/path/to/dsh-plugins/plugins/<插件名>
```

插件在 `package.json` 的 `dsh.bundle.patch` 里声明了 `cordis.patch.yml`，loader 会自动应用。这条路径的好处是走 pnpm 的依赖管理，DSH 每次启动 install 都不会把插件当多余依赖清掉。

> **注意**：desktop profile 由 pnpm 严格托管。只把插件目录复制进 `node_modules/` 而不登记依赖，DSH 下次启动执行 install 时会把它删掉。务必用上面两种方式之一。

### 换机器

```bash
git clone https://github.com/463759964/dsh-plugins.git
cd dsh-plugins/plugins/session-purge && node install.mjs
# 或者
cd dsh-plugins/plugins/dsh-workbuddy-bridge && node install.mjs
```

路径全部走 `dshHomePath()`，跟随目标机器的 `$DSH_HOME` / `~/.dsh`，**不需要改任何配置**。Windows / macOS / Linux 同一份代码。

> `dsh-workbuddy-bridge` 额外要求那台机器上装了**且登录过** WorkBuddy 客户端 ——
> 令牌是从它的加密登录态里解出来的，没登录就没得解。详见它的 README。

---

## 仓库结构

```
dsh-plugins/
├── README.md
├── plugins/
│   ├── session-purge/
│   │   ├── lib/index.js          Host 侧：HTTP 桥 + 文件操作
│   │   ├── client.js            浏览器侧：UI
│   │   ├── cordis.patch.yml     一行 insert
│   │   ├── package.json         dsh.bundle.patch + dsh.client.platform
│   │   ├── install.mjs          安装
│   │   ├── uninstall.mjs        卸载
│   │   └── test/                离线自测（不依赖 DSH）
│   └── dsh-workbuddy-bridge/
│       ├── lib/                 Host 侧：OpenAI 兼容桥 + 令牌解密 + 积分账本
│       ├── client.js            浏览器侧：输入框上方的积分徽章
│       ├── cordis.patch.yml     bundle patch：把桥接服务插进层栈
│       ├── package.json         dsh.bundle.patch + dsh.client.platform
│       ├── install.mjs          安装（转发到 tools/install.mjs）
│       ├── uninstall.mjs        卸载
│       └── tools/               体检、积分 CLI、离线自测
└── ...
```

每个插件自带测试，用纯 Node 跑，不需要启动 DSH：

```bash
cd plugins/session-purge
node test/selftest.mjs        # Host 侧：文件操作全链路
node test/client-bundle.mjs   # Client 侧：bundle 契约 + slot 注册面

cd ../dsh-workbuddy-bridge
node tools/test-usage.mjs            # 积分账本（多进程落盘 / 老格式迁移 / 分桶）
node tools/test-junction-safety.mjs  # 卸载不会顺着软链删掉源工程
```

---

## 写新插件

想往这里加插件，照 `plugins/session-purge` 的结构来就行。几条硬约束：

1. **不 import `@deepseek-ai/*`**。profile 下的 `node_modules` 解析不到 harness 内部包，import 了必炸。宿主服务一律用 `ctx.get('name')` 软取，取不到就跳过那一步。
2. **Host ↔ Client 走 `ctx.webServer` 具名路由**，不用 typert `@Remote`（需要生成的 codec，跨版本脆弱）。
3. **同源校验按 Origin 判**，不能因为 socket 是回环就放行 —— 浏览器里任意网页都能访问 `127.0.0.1`。
4. **`dsh.client.inject` 只能写 shell 静态表里存在的模块**（当前是 `dsh-client-store`、`dsh-client-ui-dockkit`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`）。写了不存在的模块，整个 bundle 会被组合阶段拒绝且**没有明显报错**。
5. **`dsh.client.platform` 必须是 `"web"`**，且 `exports["./client"]` 要指向构建好的 bundle。

---

## 许可

MIT
