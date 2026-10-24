# dsh-session-purge

给 DeepSeek Harness 侧边栏加一个**批量彻底删除会话**的入口 —— 不是归档（隐藏），是真的从磁盘抹掉。

<p align="center">
  <img alt="plugin" src="https://img.shields.io/badge/DSH-plugin-4d6bfe">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

> 本插件属于 [dsh-plugins](../../README.md) 合集。

## 它到底删了什么

一个会话在本地散落在几处，归档只动最后一处，这个插件把前四处全清：

| 位置 | 内容 | 原生归档 | 本插件 |
|---|---|---|---|
| `$DSH_HOME/sessions/<项目目录>/<会话id>/` | `session.v4.jsonl.zstd` 事件日志 | 保留 | **删除** |
| `$DSH_HOME/storages/session_projcache/sessions/<id>.json` | 标题、token 用量、todos、inbox、subagent 目录等投影缓存 | 保留 | **删除** |
| `$DSH_HOME/storages/workspace.json` | 侧边栏的分组 / 归档 / 置顶记账 | 只写归档集合 | **清记账** |
| `$DSH_HOME/storages/schedule/` | 绑在这个会话上的定时提醒（按 `sessionId` 存） | 保留 → 变成悬空任务 | **删除** |

所以删完之后：重启不会复活，搜索不会命中，切别的机器同步不到，磁盘空间真的回来。
不进回收站，**不可撤销**。

### 不删什么（有意为之）

| 位置 | 为什么不删 |
|---|---|
| `$DSH_HOME/attachments/v1/objects/` | 内容寻址的图片对象池，多个会话共用同一份字节；删了会连带毁掉别的会话里还显示的图。已实测确认删除会话后附件原样保留。 |
| `$DSH_HOME/.credentials.yaml` | 账号凭证，与单个会话无关 |
| `$DSH_HOME/profiles/` | 插件与 profile 配置 |
| `$DSH_HOME/redteam/`、`dsh-market/` 等 | 其他插件自己的数据 |
| 系统临时目录的 `dsh-spill-*` | 工具输出溢出的临时文件，进程退出后由 DSH 自己清理，不属于会话数据 |
| 会话工作目录里的文件 | 你在项目里产出的东西当然不删 |

## 能力

- **侧边栏底部「清理会话」按钮** → 管理面板：全选 / 按标题·目录·ID 搜索 / 逐条勾选 / 显示每个会话真实占用字节数
- **单个会话的「…」菜单 → 彻底删除**（带二次确认，显示标题与代价）
- **孤儿清理**：盘上有目录但登记里已经没有的残留（上次删除失败、手工删过一半、换过 cwd 的会话），一键扫出来一起清
- **安全闸门**：正在跑回合的会话拒绝删除（先 cancel、等空闲，超时则跳过并报原因）；写操作串行化，并发点两下不会互踩；同源校验挡住跨站请求
- **幂等**：已删过的 id 再删返回成功，不报错

## 安装

前提：Node ≥ 20，已经能用 DSH（profile 目录存在）。

```bash
# 1. 拿包（换成你的实际路径 / 解压后的目录）
cd dsh-session-purge

# 2. 装进 desktop profile
node install.mjs

# 或者装进别的 profile / 别的主目录
node install.mjs --profile web
node install.mjs --home D:\other\.dsh
```

装之前想先看看它要动什么：

```bash
node install.mjs --dry-run
```

**重启 DSH**（桌面端退出后重开）。侧边栏底部出现「🗑 清理会话」，会话菜单里出现「彻底删除」。

### 装到另一台机器

这个包零 npm 依赖 —— 主体是 `lib/index.js`（Host 侧，只用 Node 内置模块）和 `client.js`（浏览器侧，只用 shell 自带的 `react`）。所以换个机器只要把整个目录拷过去再跑一次 `install.mjs`：

```bash
# 在源机器上打成 tgz（可选，只是方便传）
npm pack                       # 产出 dsh-session-purge-1.0.0.tgz

# 目标机器
tar -xzf dsh-session-purge-1.0.0.tgz && cd package
node install.mjs --profile desktop
```

路径全部来自 `dshHomePath()`，跟随目标机器的 `$DSH_HOME` / `~/.dsh`，**不需要改任何配置**。
Windows / macOS / Linux 都是同一份代码。

> 想走 `pnpm` 正规依赖管理的话也可以：
> `dsh plugin --profile web add /path/to/dsh-session-purge`
> 它读 `package.json` 里的 `dsh.bundle.patch`，自动应用 `cordis.patch.yml`。

## 卸载

```bash
node uninstall.mjs                 # desktop
node uninstall.mjs --profile web
```

只删自己：包目录 + `cordis.patch.yml` 里那一行 insert。会话数据不动。

## 用法

打开面板 → 勾选 → 「彻底删除」→ 再点一次「确认删除 N 个会话？」（两步防误触）。

- **全选当前列表**：只选当前搜索结果，先搜再全选就是批量筛选删除
- **一并清理孤儿残留**：默认开。统计的是盘上有目录但登记里没有的会话，以及丢失会话的投影缓存
- **运行中** 标签的会话删不掉 —— 先停掉它的回合

删除后侧边栏会立刻刷新（面板调 `sessions.refresh()`，Host 列表重新读持久层）。

## 结构

```
dsh-session-purge/
├── lib/index.js         Host 侧：POST /session-purge/api（overview / delete）
├── client.js            浏览器侧：侧栏按钮、管理面板、菜单项、确认框
├── cordis.patch.yml     一行 insert，root 走 dshHomePath
├── package.json         dsh.bundle.patch + dsh.client.platform=web
├── install.mjs          复制到 profile + 幂等登记 patch 行
└── uninstall.mjs        反向操作，只删自己
```

Host 侧刻意不 import 任何 `@deepseek-ai/*` 包（profile 下解析不到），只走 `ctx.webServer` 具名路由这一个稳定接缝。所有 harness 服务都用 `ctx.get()` 软取，缺哪个就不做那一步 —— 少装配的环境也能跑。

## 许可

MIT。
